import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildBanovceRealWorldTerrainAsync } from './gis-terrain';
import { fetchPrimaryOsmRoadAlignment } from './osm-road-source';
import { applyCoupledRoadTerrainCorridor } from './road-terrain-corridor';
import { resolveAuthoritativeSumoRoadAlignment } from './sumo-road-source';
import type { ElevationModel } from '../elevation';
import { buildEngineeredRoadMesh } from '../roads/road-mesh';
import { getRoadDesignPolicy } from '../roads/road-design-policy';
import { SpatialRoadIndex } from '../roads/spatial-road-index';
import type { DesignedRoad } from '../roads/vertical-alignment';

const SIZE = 1024;
const SQUARE_SIZE = 1;
const MAX_HEIGHT = 500;
const OSM_WAY_ID = 109459194;
const PAVEMENT_DEPTH_METRES = 0.30;
const VERTICES_PER_STATION = 7;
const ROLES = [
  'left-shoulder',
  'left-road-edge',
  'left-lane-centre',
  'crown',
  'right-lane-centre',
  'right-road-edge',
  'right-shoulder',
] as const;

function createTerrainSampler(
  elevations: Float32Array,
): (xMetres: number, yMetres: number) => number {
  return (xMetres: number, yMetres: number): number => {
    const column = xMetres / SQUARE_SIZE;
    const row = (SIZE - 1) - yMetres / SQUARE_SIZE;
    if (
      !Number.isFinite(column) || !Number.isFinite(row) ||
      column < 0 || column > SIZE - 1 || row < 0 || row > SIZE - 1
    ) {
      throw new RangeError(`Terrain sample outside grid: (${xMetres}, ${yMetres}).`);
    }

    const c0 = Math.min(SIZE - 2, Math.floor(column));
    const r0 = Math.min(SIZE - 2, Math.floor(row));
    const c1 = c0 + 1;
    const r1 = r0 + 1;
    const tx = column - c0;
    const ty = row - r0;
    const z00 = elevations[r0 * SIZE + c0];
    const z10 = elevations[r0 * SIZE + c1];
    const z01 = elevations[r1 * SIZE + c0];
    const z11 = elevations[r1 * SIZE + c1];
    const z0 = z00 + (z10 - z00) * tx;
    const z1 = z01 + (z11 - z01) * tx;
    return z0 + (z1 - z0) * ty;
  };
}

function auditFrame(
  label: string,
  worldOffset: number,
  positions: readonly number[],
  stations: readonly { station: number; surfaceZ: number; formationZ: number }[],
  profileAnchorElevation: number,
  sampleTerrain: (x: number, y: number) => number,
): void {
  const negatives: Array<Record<string, number | string>> = [];
  const roleCounts = Object.fromEntries(ROLES.map((role) => [role, 0])) as Record<string, number>;
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  let total = 0;
  let minimumVertex: Record<string, number | string> | undefined;
  let maximumVertex: Record<string, number | string> | undefined;
  const vertexCount = positions.length / 3;

  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const source = vertex * 3;
    const stationIndex = Math.floor(vertex / VERTICES_PER_STATION);
    const roleIndex = vertex % VERTICES_PER_STATION;
    const role = ROLES[roleIndex];
    const station = stations[stationIndex];
    const x = Number((positions[source] + worldOffset).toFixed(4));
    const y = Number((positions[source + 1] + worldOffset).toFixed(4));
    const z = Number(positions[source + 2].toFixed(4));
    const terrainZ = sampleTerrain(x, y);
    const clearance = z - terrainZ;
    const record = {
      frame: label,
      vertex,
      stationIndex,
      station: station.station,
      role,
      x,
      y,
      z,
      terrainZ,
      clearance,
      surfaceZAbsolute: station.surfaceZ + profileAnchorElevation,
      formationZAbsolute: station.formationZ + profileAnchorElevation,
    };

    if (clearance < minimum) {
      minimum = clearance;
      minimumVertex = record;
    }
    if (clearance > maximum) {
      maximum = clearance;
      maximumVertex = record;
    }
    total += clearance;

    if (clearance < 0) {
      roleCounts[role] += 1;
      negatives.push(record);
    }
  }

  console.log('GATE4_REAL_FRAME_SUMMARY', JSON.stringify({
    frame: label,
    worldOffset,
    vertexCount,
    minimumClearance: minimum,
    maximumClearance: maximum,
    meanClearance: total / vertexCount,
    negativeCount: negatives.length,
    roleCounts,
    minimumVertex,
    maximumVertex,
  }));
  for (const negative of negatives.slice(0, 60)) {
    console.log('GATE4_REAL_FRAME_NEGATIVE', JSON.stringify(negative));
  }
}

async function main(): Promise<void> {
  const sourceTerrain = await buildBanovceRealWorldTerrainAsync({
    size: SIZE,
    squareSize: SQUARE_SIZE,
    maxHeight: MAX_HEIGHT,
    withRoadCorridor: false,
    levelName: 'triworld_v4_gate4_real_clearance_audit',
  });
  if (!sourceTerrain.isRealDem) {
    throw new Error('Real DEM unavailable.');
  }

  const roadMetadata = await fetchPrimaryOsmRoadAlignment(sourceTerrain.transformer, {
    minimumLengthMetres: 80,
    minimumInsetMetres: 12,
  });
  if (roadMetadata.wayId !== OSM_WAY_ID) {
    throw new Error(`Expected OSM way ${OSM_WAY_ID}, selected ${roadMetadata.wayId}.`);
  }

  const sumoNetPath = path.resolve('artifacts/gate3-osm/banovce_authoritative.net.xml');
  const sumoRoad = resolveAuthoritativeSumoRoadAlignment(
    fs.readFileSync(sumoNetPath, 'utf-8'),
    sourceTerrain.transformer,
    OSM_WAY_ID,
    roadMetadata.laneWidthMetres,
    12,
    80,
  );
  const roadSourceId = `sumo-way-${OSM_WAY_ID}-positive-fragment-0`;
  const corridor = applyCoupledRoadTerrainCorridor(
    sourceTerrain.rawElevations,
    SIZE,
    SQUARE_SIZE,
    MAX_HEIGHT,
    {
      roadShapeCentered: sumoRoad.pointsCentered,
      roadSourceId,
      laneWidth: roadMetadata.laneWidthMetres,
      formationDepthMetres: PAVEMENT_DEPTH_METRES,
    },
  );

  const sampleTerrain = createTerrainSampler(corridor.workingElevations);
  const stations = corridor.v3Result.stations;
  const profileAnchorElevation = corridor.v3Result.grid.anchorElevation;
  const designPolicy = getRoadDesignPolicy(roadMetadata.highway);
  const halfWidth = roadMetadata.laneWidthMetres / 2;
  const designedRoad: DesignedRoad = {
    id: roadSourceId,
    osmWayId: OSM_WAY_ID,
    highwayClass: roadMetadata.highway,
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
        roadWidth: roadMetadata.laneWidthMetres,
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
  const elevation: ElevationModel = {
    source: 'Gate 4 real DEM frame audit',
    zoom: 0,
    anchorElevationMetres: 0,
    sampleAbsoluteLocal: (x, y) => sampleTerrain(x + SIZE / 2, y + SIZE / 2),
    sampleRelativeLocal: (x, y) => sampleTerrain(x + SIZE / 2, y + SIZE / 2),
  };
  const engineered = buildEngineeredRoadMesh(
    [designedRoad],
    new SpatialRoadIndex(SIZE / 2, [designedRoad]),
    elevation,
  );

  console.log('GATE4_REAL_GEOMETRY', JSON.stringify({
    stationCount: stations.length,
    vertexCount: engineered.mesh.positions.length / 3,
    triangleCount: engineered.mesh.indices.length / 3,
    corridorStats: corridor.stats,
    sumoEdges: sumoRoad.usedEdgeIds,
    sumoGeometryHash: sumoRoad.sha256,
  }));

  auditFrame(
    'transformer-half-extent-512.0',
    SIZE / 2,
    engineered.mesh.positions,
    stations,
    profileAnchorElevation,
    sampleTerrain,
  );
  auditFrame(
    'terrain-sample-centre-511.5',
    (SIZE - 1) / 2,
    engineered.mesh.positions,
    stations,
    profileAnchorElevation,
    sampleTerrain,
  );
}

main().catch((error: unknown) => {
  console.error('GATE4_REAL_CLEARANCE_AUDIT_FAILED', error);
  process.exit(1);
});
