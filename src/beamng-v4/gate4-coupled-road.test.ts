import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ElevationModel } from '../elevation';
import { buildEngineeredRoadMesh } from '../roads/road-mesh';
import { getRoadDesignPolicy } from '../roads/road-design-policy';
import { SpatialRoadIndex } from '../roads/spatial-road-index';
import type { DesignedRoad } from '../roads/vertical-alignment';
import { BANOVCE_ORIGIN_WGS84, GeodeticTransformer } from './geodetic-transformer';
import { applyCoupledRoadTerrainCorridor } from './road-terrain-corridor';
import {
  exportRoadMeshToDae,
  parseDaeVerticesAndAuditClearance,
  type RoadSurfaceMeshResult,
} from './road-mesh-exporter';
import { resolveAuthoritativeSumoRoadAlignment } from './sumo-road-source';

const SIZE = 1024;
const ROAD_WIDTH_METRES = 8;
const FORMATION_DEPTH_METRES = 0.30;
const VERTICES_PER_STATION = 7;
const CROSS_SECTION_ROLES = [
  'left-shoulder',
  'left-road-edge',
  'left-lane-centre',
  'crown',
  'right-lane-centre',
  'right-road-edge',
  'right-shoulder',
] as const;

function createTerrainSampler(elevations: Float32Array): (x: number, y: number) => number {
  return (x: number, y: number): number => {
    const column = x;
    const row = (SIZE - 1) - y;
    if (column < 0 || column > SIZE - 1 || row < 0 || row > SIZE - 1) {
      throw new RangeError(`Terrain sample outside test grid: (${x}, ${y}).`);
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

function adaptForDae(
  engineered: ReturnType<typeof buildEngineeredRoadMesh>,
  stationValues: readonly number[],
  sampleTerrain: (x: number, y: number) => number,
): RoadSurfaceMeshResult {
  const vertexCount = engineered.mesh.positions.length / 3;
  expect(vertexCount).toBe(stationValues.length * VERTICES_PER_STATION);

  const positions = new Float32Array(engineered.mesh.positions.length);
  const normals = new Float32Array(engineered.mesh.positions.length);
  const uvs = new Float32Array(vertexCount * 2);
  let minClearance = Number.POSITIVE_INFINITY;
  let maxClearance = Number.NEGATIVE_INFINITY;
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
    uvs[vertex * 2 + 1] = stationValues[stationIndex] / 5;

    const clearance = z - sampleTerrain(x, y);
    minClearance = Math.min(minClearance, clearance);
    maxClearance = Math.max(maxClearance, clearance);
    totalClearance += clearance;
    if (clearance < 0) negativeCount += 1;
  }

  for (let station = 1; station < stationValues.length; station++) {
    const previousCrown = ((station - 1) * VERTICES_PER_STATION + 3) * 3 + 2;
    const currentCrown = (station * VERTICES_PER_STATION + 3) * 3 + 2;
    maxAdjacentZJumpMetres = Math.max(
      maxAdjacentZJumpMetres,
      Math.abs(positions[currentCrown] - positions[previousCrown]),
    );
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
    widthMetres: ROAD_WIDTH_METRES,
    clearanceStats: {
      minMetres: minClearance,
      maxMetres: maxClearance,
      meanMetres: totalClearance / vertexCount,
      negativeCount,
      maxAdjacentZJumpMetres,
    },
  };
}

function inspectSerializedNegativeVertices(
  dae: string,
  sampleTerrain: (x: number, y: number) => number,
  stationValues: readonly number[],
): Array<Record<string, number | string>> {
  const match = dae.match(/<float_array id="RoadMesh-positions-array" count="(\d+)">([^<]+)<\/float_array>/);
  if (!match) throw new Error('Missing serialized DAE positions.');
  const values = match[2].trim().split(/\s+/).map(Number);
  const negatives: Array<Record<string, number | string>> = [];
  for (let vertex = 0; vertex < values.length / 3; vertex++) {
    const x = values[vertex * 3];
    const y = values[vertex * 3 + 1];
    const z = values[vertex * 3 + 2];
    const terrainZ = sampleTerrain(x, y);
    const clearance = z - terrainZ;
    if (clearance < 0) {
      const stationIndex = Math.floor(vertex / VERTICES_PER_STATION);
      const roleIndex = vertex % VERTICES_PER_STATION;
      negatives.push({
        vertex,
        stationIndex,
        station: stationValues[stationIndex],
        role: CROSS_SECTION_ROLES[roleIndex],
        x,
        y,
        z,
        terrainZ,
        clearance,
      });
    }
  }
  return negatives;
}

describe('Gate 4 coupled SUMO road and terrain', () => {
  it('keeps every serialized seven-point DAE vertex above the 0.30m subgrade', () => {
    const transformer = new GeodeticTransformer(BANOVCE_ORIGIN_WGS84, SIZE);
    const sumoXml = fs.readFileSync(
      path.resolve('artifacts/gate3-osm/banovce_authoritative.net.xml'),
      'utf-8',
    );
    const sumoRoad = resolveAuthoritativeSumoRoadAlignment(
      sumoXml,
      transformer,
      109459194,
      ROAD_WIDTH_METRES,
      12,
      80,
    );

    // Slightly sloped deterministic absolute terrain exercises both cut and fill
    // while keeping the test independent of external DEM and orthophoto services.
    const sourceTerrain = new Float32Array(SIZE * SIZE);
    for (let row = 0; row < SIZE; row++) {
      const y = SIZE - 1 - row;
      for (let column = 0; column < SIZE; column++) {
        sourceTerrain[row * SIZE + column] = 250 + column * 0.002 + y * 0.001;
      }
    }

    const corridor = applyCoupledRoadTerrainCorridor(
      sourceTerrain,
      SIZE,
      1,
      500,
      {
        roadShapeCentered: sumoRoad.pointsCentered,
        roadSourceId: 'sumo-way-109459194-positive-fragment-0',
        laneWidth: ROAD_WIDTH_METRES,
        formationDepthMetres: FORMATION_DEPTH_METRES,
      },
    );
    const sampleTerrain = createTerrainSampler(corridor.workingElevations);
    const stations = corridor.v3Result.stations;
    const profileAnchorElevation = corridor.v3Result.grid.anchorElevation;
    const designPolicy = getRoadDesignPolicy('tertiary');
    const halfWidth = ROAD_WIDTH_METRES / 2;
    const designedRoad: DesignedRoad = {
      id: 'sumo-way-109459194-positive-fragment-0',
      osmWayId: 109459194,
      highwayClass: 'tertiary',
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
          roadWidth: ROAD_WIDTH_METRES,
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
      source: 'deterministic Gate 4 coupled test terrain',
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
    const stationValues = stations.map((station) => station.station);
    const mesh = adaptForDae(engineered, stationValues, sampleTerrain);
    const dae = exportRoadMeshToDae(mesh, 'triworld_asphalt');
    const audit = parseDaeVerticesAndAuditClearance(dae, sampleTerrain);
    const negativeVertices = inspectSerializedNegativeVertices(dae, sampleTerrain, stationValues);

    console.log('GATE4_COUPLED_AUDIT', JSON.stringify({
      stationCount: stations.length,
      vertexCount: mesh.vertexCount,
      triangleCount: mesh.triangleCount,
      audit,
      negativeVertices,
    }));

    expect(stations.length).toBeGreaterThan(800);
    expect(mesh.vertexCount).toBe(stations.length * VERTICES_PER_STATION);
    expect(mesh.triangleCount).toBeGreaterThan(9_000);
    expect(audit.parsedVertexCount).toBe(mesh.vertexCount);
    expect(audit.negativeCount).toBe(0);
    expect(audit.minClearance).toBeGreaterThanOrEqual(0.17);
    expect(audit.maxClearance).toBeLessThanOrEqual(0.35);
    expect(mesh.clearanceStats.maxAdjacentZJumpMetres).toBeLessThanOrEqual(0.35);
  });
});
