import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { buildBanovceRealWorldTerrainAsync } from './gis-terrain';
import { generateLevelPackageFiles } from './level-generator';
import { fetchPrimaryOsmRoadAlignment } from './osm-road-source';
import { fetchRealBanovceOrthophoto } from './ortho-generator';
import { applyCoupledRoadTerrainCorridor } from './road-terrain-corridor';
import { generateDiagnosticMarkers } from './diagnostic-markers';
import {
  exportRoadMeshToDae,
  generateAsphaltTexturePng,
  parseDaeVerticesAndAuditClearance,
  type RoadSurfaceMeshResult,
} from './road-mesh-exporter';
import { buildBeamNgZipPackage } from './zip-builder';
import type { ElevationModel } from '../elevation';
import { buildEngineeredRoadMesh } from '../roads/road-mesh';
import { getRoadDesignPolicy } from '../roads/road-design-policy';
import { SpatialRoadIndex } from '../roads/spatial-road-index';
import type { DesignedRoad } from '../roads/vertical-alignment';

const SIZE = 1024;
const SQUARE_SIZE = 1.0;
const MAX_HEIGHT = 500.0;
const LEVEL_NAME = 'triworld_v4_gate4_nativev3_real1';
const TRACI_PORT = 8873;
const PAVEMENT_DEPTH_METRES = 0.30;
const VERTICES_PER_STATION = 7;
const CROWN_VERTEX_INDEX = 3;
const TEXTURE_REPEAT_METRES = 5.0;
const AUTHORITATIVE_SUMO_EDGE_IDS = new Set([
  '-109459194#0',
  '-109459194#1',
  '109459194#0',
  '109459194#1',
]);

function sha256(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

function hashFile(filePath: string): string {
  return sha256(fs.readFileSync(filePath));
}

function scanDecodedRange(
  values: Uint16Array,
  heightScale: number,
): { minimum: number; maximum: number } {
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const decoded = value * heightScale;
    minimum = Math.min(minimum, decoded);
    maximum = Math.max(maximum, decoded);
  }
  return { minimum, maximum };
}

function createStrictTerrainSampler(
  elevations: Float32Array,
  size: number,
  squareSize: number,
): (xMetres: number, yMetres: number) => number {
  return (xMetres: number, yMetres: number): number => {
    const column = xMetres / squareSize;
    const row = (size - 1) - yMetres / squareSize;
    if (
      !Number.isFinite(column) || !Number.isFinite(row) ||
      column < 0 || column > size - 1 || row < 0 || row > size - 1
    ) {
      throw new RangeError(`Terrain sample outside grid: (${xMetres}, ${yMetres}).`);
    }

    const c0 = Math.min(size - 2, Math.floor(column));
    const r0 = Math.min(size - 2, Math.floor(row));
    const c1 = c0 + 1;
    const r1 = r0 + 1;
    const tx = column - c0;
    const ty = row - r0;
    const z00 = elevations[r0 * size + c0];
    const z10 = elevations[r0 * size + c1];
    const z01 = elevations[r1 * size + c0];
    const z11 = elevations[r1 * size + c1];
    const z0 = z00 + (z10 - z00) * tx;
    const z1 = z01 + (z11 - z01) * tx;
    return z0 + (z1 - z0) * ty;
  };
}

function adaptEngineeredMeshForDae(
  engineered: ReturnType<typeof buildEngineeredRoadMesh>,
  sampleTerrainElevation: (x: number, y: number) => number,
  stationValues: readonly number[],
  widthMetres: number,
): RoadSurfaceMeshResult {
  const vertexCount = engineered.mesh.positions.length / 3;
  if (vertexCount !== stationValues.length * VERTICES_PER_STATION) {
    throw new Error(
      `Engineered mesh layout mismatch: expected ${stationValues.length * VERTICES_PER_STATION} ` +
      `vertices for ${stationValues.length} stations, received ${vertexCount}.`,
    );
  }

  const positions = new Float32Array(engineered.mesh.positions.length);
  const normals = new Float32Array(engineered.mesh.positions.length);
  const uvs = new Float32Array(vertexCount * 2);
  let minimumClearance = Number.POSITIVE_INFINITY;
  let maximumClearance = Number.NEGATIVE_INFINITY;
  let totalClearance = 0;
  let negativeCount = 0;
  let maxAdjacentZJumpMetres = 0;

  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const source = vertex * 3;
    const stationIndex = Math.floor(vertex / VERTICES_PER_STATION);
    const crossSectionIndex = vertex % VERTICES_PER_STATION;
    const x = engineered.mesh.positions[source] + SIZE / 2;
    const y = engineered.mesh.positions[source + 1] + SIZE / 2;
    const z = engineered.mesh.positions[source + 2];
    positions[source] = x;
    positions[source + 1] = y;
    positions[source + 2] = z;
    normals[source + 2] = 1;
    uvs[vertex * 2] = crossSectionIndex / (VERTICES_PER_STATION - 1);
    uvs[vertex * 2 + 1] = stationValues[stationIndex] / TEXTURE_REPEAT_METRES;

    const clearance = z - sampleTerrainElevation(x, y);
    minimumClearance = Math.min(minimumClearance, clearance);
    maximumClearance = Math.max(maximumClearance, clearance);
    totalClearance += clearance;
    if (clearance < 0) negativeCount++;
  }

  for (let station = 1; station < stationValues.length; station++) {
    const previousCrownVertex = (station - 1) * VERTICES_PER_STATION + CROWN_VERTEX_INDEX;
    const currentCrownVertex = station * VERTICES_PER_STATION + CROWN_VERTEX_INDEX;
    const previousZ = positions[previousCrownVertex * 3 + 2];
    const currentZ = positions[currentCrownVertex * 3 + 2];
    maxAdjacentZJumpMetres = Math.max(maxAdjacentZJumpMetres, Math.abs(currentZ - previousZ));
  }

  return {
    positions,
    normals,
    uvs,
    indices: new Uint32Array(engineered.mesh.indices),
    vertexCount,
    triangleCount: engineered.mesh.indices.length / 3,
    segmentCount: engineered.segments,
    lengthMetres: engineered.length,
    widthMetres,
    clearanceStats: {
      minMetres: Number(minimumClearance.toFixed(3)),
      maxMetres: Number(maximumClearance.toFixed(3)),
      meanMetres: Number((totalClearance / vertexCount).toFixed(3)),
      negativeCount,
      maxAdjacentZJumpMetres: Number(maxAdjacentZJumpMetres.toFixed(3)),
    },
  };
}

interface SumoLaneShape {
  laneId: string;
  edgeId: string;
  width: number;
  points: Array<{ x: number; y: number }>;
}

function readXmlAttribute(tag: string, attribute: string): string | undefined {
  return tag.match(new RegExp(`\\b${attribute}="([^"]+)"`))?.[1];
}

function parseSumoNetXmlLanes(netXmlPath: string): SumoLaneShape[] {
  const content = fs.readFileSync(netXmlPath, 'utf-8');
  const lanes: SumoLaneShape[] = [];

  const edgeRegex = /<edge\b([^>]*)>([\s\S]*?)<\/edge>/g;
  let edgeMatch: RegExpExecArray | null;

  while ((edgeMatch = edgeRegex.exec(content)) !== null) {
    const edgeId = readXmlAttribute(edgeMatch[1], 'id');
    if (!edgeId || edgeId.startsWith(':')) continue;

    const laneRegex = /<lane\b([^>]*?)\/>/g;
    let laneMatch: RegExpExecArray | null;
    while ((laneMatch = laneRegex.exec(edgeMatch[2])) !== null) {
      const laneId = readXmlAttribute(laneMatch[1], 'id');
      const shape = readXmlAttribute(laneMatch[1], 'shape');
      if (!laneId || !shape) continue;

      const width = Number(readXmlAttribute(laneMatch[1], 'width') ?? 3.0);
      const points = shape.trim().split(/\s+/).map((pair) => {
        const [xStr, yStr] = pair.split(',');
        return { x: Number(xStr), y: Number(yStr) };
      });
      lanes.push({ laneId, edgeId, width, points });
    }
  }

  return lanes;
}

async function main(): Promise<void> {
  console.log(`Building TriWorld V4 Gate 4 Native Pipeline V3 Level: ${LEVEL_NAME}...`);

  const sumoNetPath = path.resolve('artifacts/gate3-osm/banovce_authoritative.net.xml');
  const targetSumoLanes = parseSumoNetXmlLanes(sumoNetPath)
    .filter((lane) => AUTHORITATIVE_SUMO_EDGE_IDS.has(lane.edgeId));
  const usedLaneIds = targetSumoLanes.map((lane) => lane.laneId);
  const usedEdgeIds = Array.from(new Set(targetSumoLanes.map((lane) => lane.edgeId)));

  if (usedEdgeIds.length !== AUTHORITATIVE_SUMO_EDGE_IDS.size || targetSumoLanes.length !== 4) {
    throw new Error(
      `Authoritative SUMO mapping incomplete: expected four edges and four lanes for OSM way 109459194, ` +
      `received ${usedEdgeIds.length} edges and ${targetSumoLanes.length} lanes.`,
    );
  }

  console.log(
    `Authoritative SUMO network loaded: ${usedEdgeIds.join(', ')}; lanes ${usedLaneIds.join(', ')}.`,
  );

  const sourceTerrain = await buildBanovceRealWorldTerrainAsync({
    size: SIZE,
    squareSize: SQUARE_SIZE,
    maxHeight: MAX_HEIGHT,
    withRoadCorridor: false,
    levelName: LEVEL_NAME,
  });

  if (!sourceTerrain.isRealDem) {
    throw new Error('Gate 4 rejected: DEM download failed and analytic fallback was used.');
  }

  const road = await fetchPrimaryOsmRoadAlignment(sourceTerrain.transformer, {
    minimumLengthMetres: 80,
    minimumInsetMetres: 12,
  });

  if (road.wayId !== 109459194) {
    throw new Error(`Gate 4 rejected: expected OSM way 109459194, selected ${road.wayId}.`);
  }

  console.log(
    `OSM road selected: way ${road.wayId}, fragment ${road.fragmentIndex}, ` +
    `${road.name ?? road.highway}, ${road.pointCount} points, ${road.lengthMetres.toFixed(1)}m`,
  );

  const corridor = applyCoupledRoadTerrainCorridor(
    sourceTerrain.rawElevations,
    SIZE,
    SQUARE_SIZE,
    MAX_HEIGHT,
    {
      roadShapeCentered: road.pointsCentered,
      roadSourceId: `osm-way-${road.wayId}-fragment-${road.fragmentIndex}`,
      laneWidth: road.laneWidthMetres,
      formationDepthMetres: PAVEMENT_DEPTH_METRES,
    },
  );

  const profileAnchorElevation = corridor.v3Result.grid.anchorElevation;
  const heightScale = MAX_HEIGHT / 65535.0;
  const decodedRange = scanDecodedRange(corridor.heightMapU16, heightScale);
  const artifact = {
    ...sourceTerrain.artifact,
    heightMapU16: corridor.heightMapU16,
    minimumDecodedElevation: decodedRange.minimum,
    maximumDecodedElevation: decodedRange.maximum,
    materialNames: [`${LEVEL_NAME}_ground`],
  };

  const sampleTerrainElevation = createStrictTerrainSampler(
    corridor.workingElevations,
    SIZE,
    SQUARE_SIZE,
  );
  const baseMarkers = generateDiagnosticMarkers(sourceTerrain.transformer, sampleTerrainElevation);

  const stations = corridor.v3Result.stations;
  const designPolicy = getRoadDesignPolicy(road.highway);
  const halfWidth = road.laneWidthMetres / 2;
  const engineeredElevation: ElevationModel = {
    source: 'Gate 4 subgrade terrain',
    zoom: 0,
    anchorElevationMetres: 0,
    sampleAbsoluteLocal: (x, y) => sampleTerrainElevation(x + SIZE / 2, y + SIZE / 2),
    sampleRelativeLocal: (x, y) => sampleTerrainElevation(x + SIZE / 2, y + SIZE / 2),
  };
  const designedRoad: DesignedRoad = {
    id: `osm-way-${road.wayId}-fragment-${road.fragmentIndex}`,
    osmWayId: road.wayId,
    highwayClass: road.highway,
    bridge: false,
    tunnel: false,
    layer: 0,
    stations: stations.map((station, index) => {
      const previous = stations[Math.max(0, index - 1)];
      const next = stations[Math.min(stations.length - 1, index + 1)];
      const ds = next.station - previous.station;
      return {
        station: station.station,
        x: station.x,
        y: station.y,
        groundZ: station.groundZ + profileAnchorElevation,
        designZ: station.surfaceZ + profileAnchorElevation,
        grade: ds > 0 ? (next.surfaceZ - previous.surfaceZ) / ds : 0,
        tangentX: station.tangentX,
        tangentY: station.tangentY,
        normalX: station.normalX,
        normalY: station.normalY,
        leftX: station.x + station.normalX * halfWidth,
        leftY: station.y + station.normalY * halfWidth,
        rightX: station.x - station.normalX * halfWidth,
        rightY: station.y - station.normalY * halfWidth,
        roadWidth: road.laneWidthMetres,
        shoulderWidth: designPolicy.shoulderWidth,
        crossfall: designPolicy.crossfall,
      };
    }),
    designPolicy,
    maximumCut: corridor.stats.maximumCutMetres,
    maximumFill: corridor.stats.maximumFillMetres,
    totalCutVolumeEstimate: 0,
    totalFillVolumeEstimate: 0,
    verticalCurves: [],
  };
  const engineeredResult = buildEngineeredRoadMesh(
    [designedRoad],
    new SpatialRoadIndex(SIZE / 2, [designedRoad]),
    engineeredElevation,
  );
  const roadMesh = adaptEngineeredMeshForDae(
    engineeredResult,
    sampleTerrainElevation,
    stations.map((station) => station.station),
    road.laneWidthMetres,
  );
  const roadDae = exportRoadMeshToDae(roadMesh, 'triworld_asphalt');
  const asphaltPng = generateAsphaltTexturePng(256);

  const daeAudit = parseDaeVerticesAndAuditClearance(roadDae, sampleTerrainElevation);
  const crossfallDrop = Math.abs((road.laneWidthMetres / 2) * designPolicy.crossfall);
  const minimumAllowedClearance = PAVEMENT_DEPTH_METRES - crossfallDrop - 0.05;
  const maximumAllowedClearance = PAVEMENT_DEPTH_METRES + 0.05;

  console.log(`Road Mesh V3 generated: ${roadMesh.vertexCount} vertices, ${roadMesh.triangleCount} triangles, ${roadMesh.segmentCount} segments.`);
  console.log(`Pipeline V3 DAE subgrade audit: min=${daeAudit.minClearance}m, max=${daeAudit.maxClearance}m, mean=${daeAudit.meanClearance}m, negativeCount=${daeAudit.negativeCount}.`);
  console.log(`Max adjacent crown Z step: ${roadMesh.clearanceStats.maxAdjacentZJumpMetres}m.`);

  if (daeAudit.negativeCount > 0) {
    throw new Error(`Gate 4 rejected: ${daeAudit.negativeCount} negative-clearance vertices detected in DAE.`);
  }
  if (daeAudit.minClearance < minimumAllowedClearance) {
    throw new Error(
      `Gate 4 rejected: Min DAE clearance ${daeAudit.minClearance}m is below engineered ` +
      `subgrade limit ${minimumAllowedClearance.toFixed(3)}m.`,
    );
  }
  if (daeAudit.maxClearance > maximumAllowedClearance) {
    throw new Error(
      `Gate 4 rejected: Max DAE clearance ${daeAudit.maxClearance}m exceeds engineered ` +
      `subgrade limit ${maximumAllowedClearance.toFixed(3)}m.`,
    );
  }

  const debugMarkers: Array<Record<string, unknown>> = [...baseMarkers];
  const halfGrid = SIZE / 2;
  for (let i = 0; i < stations.length; i += 25) {
    const st = stations[i];
    debugMarkers.push({
      name: `station_marker_${Math.round(st.station)}m`,
      class: 'TSStatic',
      shapeName: 'core/art/shapes/octahedron.dae',
      position: [st.x + halfGrid, st.y + halfGrid, st.surfaceZ + profileAnchorElevation + 0.5],
      rotationMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      scale: [0.5, 0.5, 0.5],
    });
  }

  const { diffusePng, isRealSatellite } = await fetchRealBanovceOrthophoto({
    transformer: sourceTerrain.transformer,
    textureSize: SIZE,
  });
  if (!isRealSatellite) {
    throw new Error('Gate 4 rejected: Satellite orthophoto download failed.');
  }

  const levelFiles = generateLevelPackageFiles(artifact, {
    levelName: LEVEL_NAME,
    title: 'TriWorld V4 Native Gate 4 — Engineered Road and Subgrade',
    description: 'Native BeamNG level built with real DEM terrain, accepted orthophoto, authoritative OSM/SUMO provenance, a 0.30m subgrade, and a seven-point engineered asphalt road surface.',
    extraMarkers: debugMarkers,
    diffusePng,
    normalPng: undefined,
    roadDae,
    asphaltPng,
    asphaltMaterialName: 'triworld_asphalt',
  });

  const distDir = path.resolve('dist');
  fs.mkdirSync(distDir, { recursive: true });
  const zipPath = path.join(distDir, `${LEVEL_NAME}.zip`);
  const manifestPath = path.join(distDir, `${LEVEL_NAME}.manifest.json`);

  await buildBeamNgZipPackage(
    artifact,
    levelFiles,
    zipPath,
    manifestPath,
    LEVEL_NAME,
  );
  const zipHash = hashFile(zipPath);

  const targetModsPath = path.join(
    process.env.LOCALAPPDATA ?? 'C:\\Users\\tomisu\\AppData\\Local',
    'BeamNG',
    'BeamNG.drive',
    'current',
    'mods',
  );
  fs.mkdirSync(targetModsPath, { recursive: true });
  const installedZipPath = path.join(targetModsPath, `${LEVEL_NAME}.zip`);
  fs.copyFileSync(zipPath, installedZipPath);
  const installedZipHash = hashFile(installedZipPath);
  if (zipHash !== installedZipHash) {
    throw new Error('Gate 4 rejected: Source ZIP and installed ZIP SHA-256 mismatch.');
  }

  const reportJsonPath = path.join(distDir, `${LEVEL_NAME}_report.json`);
  const buildReport = {
    levelName: LEVEL_NAME,
    profileAnchorElevation,
    formationDepthMetres: PAVEMENT_DEPTH_METRES,
    sumoNetPath,
    sumoEdges: usedEdgeIds,
    sumoLanes: targetSumoLanes.map((lane) => ({
      laneId: lane.laneId,
      edgeId: lane.edgeId,
      width: lane.width,
      shapePointCount: lane.points.length,
    })),
    traciPort: TRACI_PORT,
    traciVerifiedByThisBuild: false,
    sumoGeometryUsedForRoadSurface: false,
    roadWayId: road.wayId,
    roadLengthMetres: road.lengthMetres,
    roadWidthMetres: road.laneWidthMetres,
    roadMeshStats: {
      verticesPerStation: VERTICES_PER_STATION,
      vertexCount: roadMesh.vertexCount,
      triangleCount: roadMesh.triangleCount,
      segmentCount: roadMesh.segmentCount,
      clearanceStats: roadMesh.clearanceStats,
    },
    daeRuntimeAudit: daeAudit,
    clearanceAcceptanceRange: {
      minimumMetres: Number(minimumAllowedClearance.toFixed(3)),
      maximumMetres: Number(maximumAllowedClearance.toFixed(3)),
    },
    zipPath,
    zipHash,
    installedZipPath,
    installedZipHash,
    acceptance: {
      negativeClearanceCountZero: daeAudit.negativeCount === 0,
      minSubgradeClearanceMet: daeAudit.minClearance >= minimumAllowedClearance,
      maxSubgradeClearanceMet: daeAudit.maxClearance <= maximumAllowedClearance,
      noZJumpAboveLimit: roadMesh.clearanceStats.maxAdjacentZJumpMetres <= 0.35,
      sevenVerticesPerStation: roadMesh.vertexCount === stations.length * VERTICES_PER_STATION,
      zipHashesMatch: zipHash === installedZipHash,
      realDemUsed: true,
      realOsmRoadUsed: true,
      authoritativeSumoNetLoaded: true,
    },
  };
  fs.writeFileSync(reportJsonPath, JSON.stringify(buildReport, null, 2));

  console.log('GATE 4 NATIVE PIPELINE V3 BUILD SUCCESSFUL');
  console.log(`Level: ${LEVEL_NAME}`);
  console.log(`Profile anchor elevation: ${profileAnchorElevation.toFixed(3)}m`);
  console.log(`SUMO Edges: ${usedEdgeIds.join(', ')}`);
  console.log(`SUMO Lanes: ${usedLaneIds.join(', ')}`);
  console.log(`Road Mesh: ${roadMesh.vertexCount} vertices, ${roadMesh.triangleCount} triangles, ${roadMesh.lengthMetres.toFixed(1)}m length`);
  console.log(`DAE subgrade audit: min=${daeAudit.minClearance}m, max=${daeAudit.maxClearance}m, mean=${daeAudit.meanClearance}m, negativeCount=${daeAudit.negativeCount}`);
  console.log(`ZIP: ${zipPath}`);
  console.log(`Installed Mod: ${installedZipPath}`);
  console.log(`ZIP SHA-256: ${zipHash}`);
}

main().catch((err) => {
  console.error('FATAL NATIVE PIPELINE V3 BUILD ERROR:', err);
  process.exit(1);
});
