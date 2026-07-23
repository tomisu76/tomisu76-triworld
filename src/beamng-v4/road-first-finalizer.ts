import {
  buildMountainLoopRoadFirstTerrain,
  type RoadFirstConfig,
  type RoadFirstStation,
  type RoadFirstTerrainResult,
} from './road-first-terrain';
import type { BeamNGTerrainArtifact } from './types';

const CELL_SIZE_METRES = 32;

interface IndexedSegment {
  a: RoadFirstStation;
  b: RoadFirstStation;
}

/**
 * Final acceptance pass for the road-first pipeline.
 *
 * The preliminary designer follows and smooths the DEM. This pass projects the
 * entire closed profile onto the exact per-segment grade constraints, including
 * the closing segment, and then re-conforms the native TerrainBlock collision
 * heightfield to that accepted profile.
 */
export function buildValidatedMountainLoopTerrain(
  config: RoadFirstConfig = {},
): RoadFirstTerrainResult {
  const result = buildMountainLoopRoadFirstTerrain(config);
  const maximumGrade = clamp(config.maximumGrade ?? 0.10, 0.03, 0.18);
  const shoulderWidth = clamp(config.shoulderWidth ?? 1.6, 0.5, 5);
  const minimumBlendWidth = clamp(config.minimumBlendWidth ?? 10, 4, 30);
  const maximumBlendWidth = clamp(
    config.maximumBlendWidth ?? 42,
    minimumBlendWidth,
    70,
  );

  enforceClosedGradeConstraint(result.roadStations, maximumGrade);
  const repairStats = reconformTerrain(
    result.rawElevations,
    result.artifact.size,
    result.artifact.squareSize,
    result.roadStations,
    shoulderWidth,
    minimumBlendWidth,
    maximumBlendWidth,
  );

  result.artifact = quantizeTerrain(
    result.artifact,
    result.rawElevations,
    result.artifact.maxHeight,
  );
  result.road.nodes = buildRoadNodes(result.roadStations, result.roadStations[0].width);
  result.scannedMinElevation = repairStats.minimumElevation;
  result.scannedMaxElevation = repairStats.maximumElevation;
  result.sampleElevation = (x: number, y: number) => sampleHeightBilinear(
    result.rawElevations,
    result.artifact.size,
    result.artifact.squareSize,
    x,
    y,
  );
  result.stats.maximumGrade = calculateMaximumGrade(result.roadStations);
  result.stats.maximumCutMetres = Math.max(result.stats.maximumCutMetres, repairStats.maximumCutMetres);
  result.stats.maximumFillMetres = Math.max(result.stats.maximumFillMetres, repairStats.maximumFillMetres);
  result.stats.modifiedTerrainSamples = Math.max(
    result.stats.modifiedTerrainSamples,
    repairStats.modifiedTerrainSamples,
  );
  result.stats.minimumElevation = repairStats.minimumElevation;
  result.stats.maximumElevation = repairStats.maximumElevation;
  return result;
}

export function enforceClosedGradeConstraint(
  stationsWithClosure: RoadFirstStation[],
  maximumGrade: number,
): void {
  if (stationsWithClosure.length < 4) throw new Error('Closed road requires at least three stations plus closure');
  const stations = stationsWithClosure.slice(0, -1);
  const targetGrade = Math.max(0, maximumGrade - 0.0001);
  const numericalToleranceMetres = 1e-7;

  // Alternating projections onto all cyclic Lipschitz constraints. A small
  // design reserve absorbs floating-point residuals; acceptance is decided by
  // the measured final grade rather than an arbitrary absolute residual.
  for (let pass = 0; pass < 20_000; pass++) {
    let maximumViolation = 0;
    for (let index = 0; index < stations.length; index++) {
      const nextIndex = (index + 1) % stations.length;
      const a = stations[index];
      const b = stations[nextIndex];
      const run = Math.max(0.01, Math.hypot(b.x - a.x, b.y - a.y));
      const limit = targetGrade * run;
      const delta = b.z - a.z;
      const violation = Math.abs(delta) - limit;
      if (violation <= numericalToleranceMetres) continue;
      const direction = Math.sign(delta) || 1;
      const correction = violation / 2;
      a.z += direction * correction;
      b.z -= direction * correction;
      maximumViolation = Math.max(maximumViolation, violation);
    }
    if (maximumViolation <= numericalToleranceMetres) break;
  }

  const first = stations[0];
  const closingDistance = stationsWithClosure[stationsWithClosure.length - 1].station;
  stationsWithClosure[stationsWithClosure.length - 1] = {
    ...first,
    station: closingDistance,
  };

  const measuredMaximumGrade = calculateMaximumGrade(stationsWithClosure);
  if (measuredMaximumGrade > maximumGrade + 1e-9) {
    throw new Error(
      `Closed profile exceeds grade ceiling: ${measuredMaximumGrade} > ${maximumGrade}`,
    );
  }
}

function reconformTerrain(
  elevations: Float32Array,
  size: number,
  squareSize: number,
  stations: readonly RoadFirstStation[],
  shoulderWidth: number,
  minimumBlendWidth: number,
  maximumBlendWidth: number,
): {
  maximumCutMetres: number;
  maximumFillMetres: number;
  modifiedTerrainSamples: number;
  minimumElevation: number;
  maximumElevation: number;
} {
  const segments: IndexedSegment[] = [];
  const cells = new Map<string, number[]>();
  const searchRadius = stations[0].width / 2 + shoulderWidth + maximumBlendWidth;

  for (let index = 0; index < stations.length - 1; index++) {
    const segmentIndex = segments.length;
    const segment = { a: stations[index], b: stations[index + 1] };
    segments.push(segment);
    const minimumCellX = cellCoordinate(Math.min(segment.a.x, segment.b.x) - searchRadius);
    const maximumCellX = cellCoordinate(Math.max(segment.a.x, segment.b.x) + searchRadius);
    const minimumCellY = cellCoordinate(Math.min(segment.a.y, segment.b.y) - searchRadius);
    const maximumCellY = cellCoordinate(Math.max(segment.a.y, segment.b.y) + searchRadius);
    for (let cellY = minimumCellY; cellY <= maximumCellY; cellY++) {
      for (let cellX = minimumCellX; cellX <= maximumCellX; cellX++) {
        const key = `${cellX}:${cellY}`;
        const bucket = cells.get(key);
        if (bucket) bucket.push(segmentIndex);
        else cells.set(key, [segmentIndex]);
      }
    }
  }

  let maximumCutMetres = 0;
  let maximumFillMetres = 0;
  let modifiedTerrainSamples = 0;
  let minimumElevation = Number.POSITIVE_INFINITY;
  let maximumElevation = Number.NEGATIVE_INFINITY;

  for (let row = 0; row < size; row++) {
    const y = (size - 1 - row) * squareSize;
    for (let column = 0; column < size; column++) {
      const x = column * squareSize;
      const terrainIndex = row * size + column;
      const base = elevations[terrainIndex];
      const bucket = cells.get(`${cellCoordinate(x)}:${cellCoordinate(y)}`);
      let strongestInfluence = 0;
      let strongestTarget = base;
      let closestDistance = Number.POSITIVE_INFINITY;

      if (bucket) {
        for (const segmentIndex of bucket) {
          const candidate = sampleSegment(
            segments[segmentIndex],
            x,
            y,
            base,
            shoulderWidth,
            minimumBlendWidth,
            maximumBlendWidth,
          );
          if (!candidate) continue;
          if (candidate.influence > strongestInfluence + 1e-10
            || (Math.abs(candidate.influence - strongestInfluence) <= 1e-10
              && candidate.distance < closestDistance)) {
            strongestInfluence = candidate.influence;
            strongestTarget = candidate.target;
            closestDistance = candidate.distance;
          }
        }
      }

      let finalElevation = base;
      if (strongestInfluence > 0) {
        finalElevation = mix(base, strongestTarget, strongestInfluence);
        elevations[terrainIndex] = finalElevation;
        modifiedTerrainSamples += 1;
        maximumCutMetres = Math.max(maximumCutMetres, base - finalElevation);
        maximumFillMetres = Math.max(maximumFillMetres, finalElevation - base);
      }
      minimumElevation = Math.min(minimumElevation, finalElevation);
      maximumElevation = Math.max(maximumElevation, finalElevation);
    }
  }

  return {
    maximumCutMetres,
    maximumFillMetres,
    modifiedTerrainSamples,
    minimumElevation,
    maximumElevation,
  };
}

function sampleSegment(
  segment: IndexedSegment,
  x: number,
  y: number,
  baseElevation: number,
  shoulderWidth: number,
  minimumBlendWidth: number,
  maximumBlendWidth: number,
): { target: number; influence: number; distance: number } | null {
  const dx = segment.b.x - segment.a.x;
  const dy = segment.b.y - segment.a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-9) return null;
  const t = clamp(((x - segment.a.x) * dx + (y - segment.a.y) * dy) / lengthSquared, 0, 1);
  const nearestX = segment.a.x + dx * t;
  const nearestY = segment.a.y + dy * t;
  const length = Math.sqrt(lengthSquared);
  const normalX = -dy / length;
  const normalY = dx / length;
  const signedLateral = (x - nearestX) * normalX + (y - nearestY) * normalY;
  const lateralDistance = Math.abs(signedLateral);
  const roadHalfWidth = mix(segment.a.width, segment.b.width, t) / 2;
  const innerRadius = roadHalfWidth + shoulderWidth;
  const centreElevation = mix(segment.a.z, segment.b.z, t);
  const bank = mix(segment.a.bank, segment.b.bank, t);
  const target = centreElevation + signedLateral * bank;
  const verticalDifference = Math.abs(baseElevation - target);
  const blendWidth = clamp(
    minimumBlendWidth + verticalDifference * 1.75,
    minimumBlendWidth,
    maximumBlendWidth,
  );
  if (lateralDistance > innerRadius + blendWidth) return null;
  const influence = lateralDistance <= innerRadius
    ? 1
    : smoothstep(1 - (lateralDistance - innerRadius) / blendWidth);
  return { target, influence, distance: lateralDistance };
}

function quantizeTerrain(
  original: BeamNGTerrainArtifact,
  elevations: Float32Array,
  maximumHeight: number,
): BeamNGTerrainArtifact {
  const heightScale = maximumHeight / 65535;
  const heightMapU16 = new Uint16Array(elevations.length);
  let minimumDecodedElevation = Number.POSITIVE_INFINITY;
  let maximumDecodedElevation = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < elevations.length; index++) {
    const quantized = clamp(Math.round(elevations[index] / heightScale), 0, 65535);
    heightMapU16[index] = quantized;
    const decoded = quantized * heightScale;
    minimumDecodedElevation = Math.min(minimumDecodedElevation, decoded);
    maximumDecodedElevation = Math.max(maximumDecodedElevation, decoded);
  }
  return {
    ...original,
    heightMapU16,
    heightScale,
    minimumDecodedElevation,
    maximumDecodedElevation,
  };
}

function buildRoadNodes(
  stations: readonly RoadFirstStation[],
  width: number,
): Array<[number, number, number, number]> {
  const stationDelta = stations.length > 1 ? stations[1].station - stations[0].station : 4;
  const stride = Math.max(1, Math.round(8 / Math.max(1, stationDelta)));
  const nodes: Array<[number, number, number, number]> = [];
  for (let index = 0; index < stations.length - 1; index += stride) {
    const station = stations[index];
    nodes.push([round6(station.x), round6(station.y), round6(station.z), round6(width)]);
  }
  const first = stations[0];
  nodes.push([round6(first.x), round6(first.y), round6(first.z), round6(width)]);
  return nodes;
}

function calculateMaximumGrade(stations: readonly RoadFirstStation[]): number {
  let maximum = 0;
  for (let index = 0; index < stations.length - 1; index++) {
    const a = stations[index];
    const b = stations[index + 1];
    const run = Math.max(0.01, Math.hypot(b.x - a.x, b.y - a.y));
    maximum = Math.max(maximum, Math.abs(b.z - a.z) / run);
  }
  return maximum;
}

function sampleHeightBilinear(
  elevations: Float32Array,
  size: number,
  squareSize: number,
  x: number,
  y: number,
): number {
  const column = clamp(x / squareSize, 0, size - 1);
  const row = clamp(size - 1 - y / squareSize, 0, size - 1);
  const c0 = Math.floor(column);
  const r0 = Math.floor(row);
  const c1 = Math.min(size - 1, c0 + 1);
  const r1 = Math.min(size - 1, r0 + 1);
  const tx = column - c0;
  const ty = row - r0;
  const north = mix(elevations[r0 * size + c0], elevations[r0 * size + c1], tx);
  const south = mix(elevations[r1 * size + c0], elevations[r1 * size + c1], tx);
  return mix(north, south, ty);
}

function cellCoordinate(value: number): number {
  return Math.floor(value / CELL_SIZE_METRES);
}

function smoothstep(value: number): number {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
