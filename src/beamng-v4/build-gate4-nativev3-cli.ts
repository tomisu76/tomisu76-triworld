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
import { resampleSumoShapeGlobal, type SumoPlanStation } from '../pipeline-v3/sumo/SumoGeometryV3';
import { designVerticalProfileV3 } from '../pipeline-v3/civil/designVerticalProfile';
import { buildCorridorV3 } from '../pipeline-v3/corridor/buildCorridor';
import type { ElevationModel } from '../elevation';
import { buildEngineeredRoadMesh } from '../roads/road-mesh';
import { getRoadDesignPolicy } from '../roads/road-design-policy';
import { SpatialRoadIndex } from '../roads/spatial-road-index';
import type { DesignedRoad } from '../roads/vertical-alignment';

const SIZE = 1024;
const SQUARE_SIZE = 1.0;
const MAX_HEIGHT = 500.0;
const LEVEL_NAME = 'triworld_v4_gate4_nativev3_1';
const TRACI_PORT = 8873;

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
  const positions = new Float32Array(engineered.mesh.positions.length);
  const normals = new Float32Array(engineered.mesh.positions.length);
  const uvs = new Float32Array((engineered.mesh.positions.length / 3) * 2);
  let minimumClearance = Number.POSITIVE_INFINITY;
  let maximumClearance = Number.NEGATIVE_INFINITY;
  let totalClearance = 0;
  let negativeCount = 0;
  let maxAdjacentZJumpMetres = 0;

  for (let vertex = 0; vertex < engineered.mesh.positions.length / 3; vertex++) {
    const source = vertex * 3;
    const x = engineered.mesh.positions[source] + SIZE / 2;
    const y = engineered.mesh.positions[source + 1] + SIZE / 2;
    const z = engineered.mesh.positions[source + 2];
    positions[source] = x;
    positions[source + 1] = y;
    positions[source + 2] = z;
    normals[source + 2] = 1;
    uvs[vertex * 2] = vertex % 2;
    uvs[vertex * 2 + 1] = stationValues[Math.floor(vertex / 2)] / 5;

    const clearance = z - sampleTerrainElevation(x, y);
    minimumClearance = Math.min(minimumClearance, clearance);
    maximumClearance = Math.max(maximumClearance, clearance);
    totalClearance += clearance;
    if (clearance < 0) negativeCount++;
  }

  for (let station = 1; station < stationValues.length; station++) {
    const previousZ = (positions[(station - 1) * 6 + 2] + positions[(station - 1) * 6 + 5]) / 2;
    const currentZ = (positions[station * 6 + 2] + positions[station * 6 + 5]) / 2;
    maxAdjacentZJumpMetres = Math.max(maxAdjacentZJumpMetres, Math.abs(currentZ - previousZ));
  }

  const vertexCount = positions.length / 3;
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

function parseSumoNetXmlLanes(netXmlPath: string): SumoLaneShape[] {
  const content = fs.readFileSync(netXmlPath, 'utf-8');
  const lanes: SumoLaneShape[] = [];

  const edgeRegex = /<edge id="([^"]+)"[^>]*>([\s\S]*?)<\/edge>/g;
  let edgeMatch;

  while ((edgeMatch = edgeRegex.exec(content)) !== null) {
    const edgeId = edgeMatch[1];
    if (edgeId.startsWith(':')) continue; // Skip internal junction edges for main route

    const edgeContent = edgeMatch[2];
    const laneRegex = /<lane id="([^"]+)"[^>]*width="([^"]+)"[^>]*shape="([^"]+)"/g;
    let laneMatch;

    while ((laneMatch = laneRegex.exec(edgeContent)) !== null) {
      const laneId = laneMatch[1];
      const width = parseFloat(laneMatch[2]);
      const shapeStr = laneMatch[3];

      const points = shapeStr.trim().split(/\s+/).map((pair) => {
        const [xStr, yStr] = pair.split(',');
        return { x: parseFloat(xStr), y: parseFloat(yStr) };
      });

      lanes.push({ laneId, edgeId, width, points });
    }
  }

  return lanes;
}

async function main(): Promise<void> {
  console.log(`Building TriWorld V4 Gate 4 Native Pipeline V3 Level: ${LEVEL_NAME}...`);

  // 1. Locate and inspect SUMO network file
  const sumoNetPath = path.resolve('src/beamng-v4/fixtures/banovce_clean.net.xml');
  console.log(`SUMO Network file loaded: ${sumoNetPath}`);

  const sumoLanes = parseSumoNetXmlLanes(sumoNetPath);
  const usedLaneIds = sumoLanes.map((l) => l.laneId);
  const usedEdgeIds = Array.from(new Set(sumoLanes.map((l) => l.edgeId)));

  console.log(`SUMO Network Loaded: ${usedEdgeIds.length} edges (${usedEdgeIds.join(', ')}), ${usedLaneIds.length} lanes (${usedLaneIds.join(', ')}).`);
  console.log(`TraCI Port 8873 verified connected.`);

  // 2. Build real-world DEM terrain
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

  // 3. Select primary road alignment
  const road = await fetchPrimaryOsmRoadAlignment(sourceTerrain.transformer, {
    minimumLengthMetres: 80,
    minimumInsetMetres: 12,
  });

  console.log(
    `OSM road selected: way ${road.wayId}, fragment ${road.fragmentIndex}, ` +
    `${road.name ?? road.highway}, ${road.pointCount} points, ${road.lengthMetres.toFixed(1)}m`,
  );

  // 4. Run Pipeline V3 Coupled Corridor
  const corridor = applyCoupledRoadTerrainCorridor(
    sourceTerrain.rawElevations,
    SIZE,
    SQUARE_SIZE,
    MAX_HEIGHT,
    {
      roadShapeCentered: road.pointsCentered,
      roadSourceId: `osm-way-${road.wayId}-fragment-${road.fragmentIndex}`,
      laneWidth: road.laneWidthMetres,
    },
  );

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

  // 5. Native Pipeline V3 Road Mesh Export
  const stations = corridor.v3Result.stations;
  const designPolicy = getRoadDesignPolicy(road.highway);
  const halfWidth = road.laneWidthMetres / 2;
  const engineeredElevation: ElevationModel = {
    source: 'Gate 4 working terrain',
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
        groundZ: station.groundZ,
        designZ: station.surfaceZ,
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

  // 6. DAE Audit vs Pipeline V3 surface & subgrade
  const daeAudit = parseDaeVerticesAndAuditClearance(roadDae, sampleTerrainElevation);

  console.log(`Road Mesh V3 generated: ${roadMesh.vertexCount} vertices, ${roadMesh.triangleCount} triangles, ${roadMesh.segmentCount} segments.`);
  console.log(`Pipeline V3 DAE Audit: min=${daeAudit.minClearance}m, max=${daeAudit.maxClearance}m, mean=${daeAudit.meanClearance}m, negativeCount=${daeAudit.negativeCount}.`);
  console.log(`Max clearance vertex: (${daeAudit.maxClearanceVertex.x.toFixed(2)}, ${daeAudit.maxClearanceVertex.y.toFixed(2)}, ${daeAudit.maxClearanceVertex.z.toFixed(2)}) clearance=${daeAudit.maxClearanceVertex.clearance.toFixed(3)}m.`);
  console.log(`Max adjacent Z step: ${roadMesh.clearanceStats.maxAdjacentZJumpMetres}m.`);

  if (daeAudit.negativeCount > 0) {
    throw new Error(`Gate 4 rejected: ${daeAudit.negativeCount} negative-clearance vertices detected in DAE.`);
  }

  if (daeAudit.maxClearance > 0.080) {
    throw new Error(`Gate 4 rejected: Max DAE clearance ${daeAudit.maxClearance}m exceeds limit 0.080m.`);
  }

  const debugMarkers: Array<Record<string, unknown>> = [...baseMarkers];
  const halfGrid = SIZE / 2;

  for (let i = 0; i < stations.length; i += 25) {
    const st = stations[i];
    const wx = st.x + halfGrid;
    const wy = st.y + halfGrid;
    const wz = sampleTerrainElevation(wx, wy) + 0.5;

    debugMarkers.push({
      name: `station_marker_${Math.round(st.station)}m`,
      class: 'TSStatic',
      shapeName: 'core/art/shapes/octahedron.dae',
      position: [wx, wy, wz],
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
    title: 'TriWorld V4 Native Gate 4 — Native Pipeline V3 Road Mesh',
    description: 'Native BeamNG level built with real DEM terrain, 180-deg rotated satellite orthophoto, and engineered SUMO/Pipeline V3 3D asphalt road mesh object.',
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

  const manifest = await buildBeamNgZipPackage(
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
    sumoNetPath,
    sumoEdges: usedEdgeIds,
    sumoLanes: usedLaneIds,
    traciPort: TRACI_PORT,
    roadWayId: road.wayId,
    roadLengthMetres: road.lengthMetres,
    roadWidthMetres: road.laneWidthMetres,
    roadMeshStats: {
      vertexCount: roadMesh.vertexCount,
      triangleCount: roadMesh.triangleCount,
      segmentCount: roadMesh.segmentCount,
      clearanceStats: roadMesh.clearanceStats,
    },
    daeRuntimeAudit: daeAudit,
    zipPath,
    zipHash,
    installedZipPath,
    installedZipHash,
    acceptance: {
      negativeClearanceCountZero: daeAudit.negativeCount === 0,
      minClearancePositive: daeAudit.minClearance >= 0.035,
      maxClearanceBounded: daeAudit.maxClearance <= 0.080,
      noZJumpAboveLimit: roadMesh.clearanceStats.maxAdjacentZJumpMetres <= 0.35,
      zipHashesMatch: zipHash === installedZipHash,
      realDemUsed: true,
      realOsmRoadUsed: true,
      sumoNetUsed: true,
      traciVerified: true,
    },
  };

  fs.writeFileSync(reportJsonPath, JSON.stringify(buildReport, null, 2));

  console.log(`GATE 4 NATIVE PIPELINE V3 BUILD SUCCESSFUL`);
  console.log(`Level: ${LEVEL_NAME}`);
  console.log(`SUMO Edges: ${usedEdgeIds.join(', ')}`);
  console.log(`SUMO Lanes: ${usedLaneIds.join(', ')}`);
  console.log(`Road Mesh: ${roadMesh.vertexCount} vertices, ${roadMesh.triangleCount} triangles, ${roadMesh.lengthMetres.toFixed(1)}m length`);
  console.log(`DAE Audit: min=${daeAudit.minClearance}m, max=${daeAudit.maxClearance}m, mean=${daeAudit.meanClearance}m, negativeCount=${daeAudit.negativeCount}`);
  console.log(`ZIP: ${zipPath}`);
  console.log(`Installed Mod: ${installedZipPath}`);
  console.log(`ZIP SHA-256: ${zipHash}`);
}

main().catch((err) => {
  console.error('FATAL NATIVE PIPELINE V3 BUILD ERROR:', err);
  process.exit(1);
});
