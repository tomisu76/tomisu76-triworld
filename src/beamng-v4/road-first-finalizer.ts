import {
  buildMountainLoopRoadFirstTerrain,
  type NativeDecalRoad,
  type RoadFirstConfig,
  type RoadFirstStation,
  type RoadFirstTerrainResult,
} from './road-first-terrain';
import type { BeamNGTerrainArtifact } from './types';

const CELL_SIZE_METRES = 32;
const MAXIMUM_DAYLIGHT_SLOPE = 0.28;

interface IndexedSegment {
  a: RoadFirstStation;
  b: RoadFirstStation;
}

interface TerrainRepairResult {
  transitionMask: Uint8Array;
  maximumCutMetres: number;
  maximumFillMetres: number;
  modifiedTerrainSamples: number;
  minimumElevation: number;
  maximumElevation: number;
}

export function buildValidatedMountainLoopTerrain(
  config: RoadFirstConfig = {},
): RoadFirstTerrainResult {
  const result = buildMountainLoopRoadFirstTerrain(config);
  const maximumGrade = clamp(config.maximumGrade ?? 0.10, 0.03, 0.18);
  const shoulderWidth = clamp(config.shoulderWidth ?? 1.8, 0.5, 5);
  const minimumBlendWidth = clamp(config.minimumBlendWidth ?? 22, 8, 35);
  const maximumBlendWidth = clamp(
    config.maximumBlendWidth ?? 70,
    minimumBlendWidth,
    70,
  );

  enforceClosedGradeConstraint(result.roadStations, maximumGrade);
  configureRoadForNavigation(result.road);

  const baseline = new Float32Array(result.rawElevations);
  const repair = reconformTerrain(
    result.rawElevations,
    result.artifact.size,
    result.artifact.squareSize,
    result.roadStations,
    shoulderWidth,
    minimumBlendWidth,
    maximumBlendWidth,
  );

  smoothTransitionBand(
    result.rawElevations,
    result.artifact.size,
    repair.transitionMask,
    3,
  );

  const repairedStats = measureTerrainChanges(
    result.rawElevations,
    baseline,
    repair.transitionMask,
  );

  result.artifact = quantizeTerrain(
    result.artifact,
    result.rawElevations,
    result.artifact.maxHeight,
  );
  result.road.nodes = buildRoadNodes(result.roadStations, result.roadStations[0].width);
  result.scannedMinElevation = repairedStats.minimumElevation;
  result.scannedMaxElevation = repairedStats.maximumElevation;
  result.sampleElevation = (x: number, y: number) => sampleHeightBilinear(
    result.rawElevations,
    result.artifact.size,
    result.artifact.squareSize,
    x,
    y,
  );
  result.stats.maximumGrade = calculateMaximumGrade(result.roadStations);
  result.stats.maximumCutMetres = Math.max(result.stats.maximumCutMetres, repairedStats.maximumCutMetres);
  result.stats.maximumFillMetres = Math.max(result.stats.maximumFillMetres, repairedStats.maximumFillMetres);
  result.stats.modifiedTerrainSamples = Math.max(
    result.stats.modifiedTerrainSamples,
    repairedStats.modifiedTerrainSamples,
  );
  result.stats.minimumElevation = repairedStats.minimumElevation;
  result.stats.maximumElevation = repairedStats.maximumElevation;
  return result;
}

function configureRoadForNavigation(road: NativeDecalRoad): void {
  road.textureLength = 14;
  road.breakAngle = 1;
  road.renderPriority = 20;
  road.zBias = 0.001;
  road.decalBias = 0.004;
  road.distanceFade = [5000, 700];
  road.startEndFade = [0, 0];
  road.overObjects = false;
  road.drivability = 1;
  road.autoLanes = false;
  road.autoJunction = false;
  road.oneWay = false;

  Object.assign(road as NativeDecalRoad & Record<string, unknown>, {
    improvedSpline: true,
    useSubdivisions: true,
    lanesLeft: 1,
    lanesRight: 1,
    flipDirection: false,
    gatedRoad: false,
    hiddenInNavi: false,
    persistentId: '967948ce-cf80-47dc-9678-b98af4a8dce1',
  });
}

export function enforceClosedGradeConstraint(
  stationsWithClosure: RoadFirstStation[],
  maximumGrade: number,
): void {
  if (stationsWithClosure.length < 4) throw new Error('Closed road requires at least three stations plus closure');
  const stations = stationsWithClosure.slice(0, -1);
  const targetGrade = Math.max(0, maximumGrade - 0.0001);
  const numericalToleranceMetres = 1e-7;

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
): TerrainRepairResult {
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

  const transitionMask = new Uint8Array(size * size);
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
          if (candidate.distance < closestDistance - 1e-8
            || (Math.abs(candidate.distance - closestDistance) <= 1e-8
              && candidate.influence > strongestInfluence)) {
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
        transitionMask[terrainIndex] = Math.max(1, Math.min(255, Math.round(strongestInfluence * 255)));
        modifiedTerrainSamples += 1;
        maximumCutMetres = Math.max(maximumCutMetres, base - finalElevation);
        maximumFillMetres = Math.max(maximumFillMetres, finalElevation - base);
      }
      minimumElevation = Math.min(minimumElevation, finalElevation);
      maximumElevation = Math.max(maximumElevation, finalElevation);
    }
  }

  return {
    transitionMask,
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
  const side = Math.sign(signedLateral) || 1;
  const roadHalfWidth = mix(segment.a.width, segment.b.width, t) / 2;
  const innerRadius = roadHalfWidth + shoulderWidth;
  const centreElevation = mix(segment.a.z, segment.b.z, t);
  const bank = mix(segment.a.bank, segment.b.bank, t);
  const pavedTarget = centreElevation + signedLateral * bank;
  const pavedEdge = centreElevation + side * roadHalfWidth * bank;
  const shoulderDistance = Math.max(0, lateralDistance - roadHalfWidth);
  const target = lateralDistance <= roadHalfWidth
    ? pavedTarget
    : pavedEdge - shoulderDistance * 0.025;
  const verticalDifference = Math.abs(baseElevation - target);
  const slopeRequiredWidth = verticalDifference / MAXIMUM_DAYLIGHT_SLOPE;
  const blendWidth = clamp(
    Math.max(minimumBlendWidth, minimumBlendWidth * 0.55 + slopeRequiredWidth),
    minimumBlendWidth,
    maximumBlendWidth,
  );
  if (lateralDistance > innerRadius + blendWidth) return null;
  const influence = lateralDistance <= innerRadius
    ? 1
    : smootherstep(1 - (lateralDistance - innerRadius) / blendWidth);
  return { target, influence, distance: lateralDistance };
}

function smoothTransitionBand(
  elevations: Float32Array,
  size: number,
  transitionMask: Uint8Array,
  passes: number,
): void {
  const scratch = new Float32Array(elevations.length);
  for (let pass = 0; pass < passes; pass++) {
    scratch.set(elevations);
    for (let row = 1; row < size - 1; row++) {
      for (let column = 1; column < size - 1; column++) {
        const index = row * size + column;
        const mask = transitionMask[index];
        if (mask === 0 || mask >= 250) continue;
        const localAverage = (
          scratch[index] * 4
          + scratch[index - 1]
          + scratch[index + 1]
          + scratch[index - size]
          + scratch[index + size]
        ) / 8;
        const transitionWeight = 1 - Math.abs(mask / 255 - 0.5) * 2;
        elevations[index] = mix(scratch[index], localAverage, 0.32 + transitionWeight * 0.28);
      }
    }
  }
}

function measureTerrainChanges(
  elevations: Float32Array,
  baseline: Float32Array,
  transitionMask: Uint8Array,
): Omit<TerrainRepairResult, 'transitionMask'> {
  let maximumCutMetres = 0;
  let maximumFillMetres = 0;
  let modifiedTerrainSamples = 0;
  let minimumElevation = Number.POSITIVE_INFINITY;
  let maximumElevation = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < elevations.length; index++) {
    const elevation = elevations[index];
    minimumElevation = Math.min(minimumElevation, elevation);
    maximumElevation = Math.max(maximumElevation, elevation);
    if (transitionMask[index] > 0) {
      modifiedTerrainSamples += 1;
      maximumCutMetres = Math.max(maximumCutMetres, baseline[index] - elevation);
      maximumFillMetres = Math.max(maximumFillMetres, elevation - baseline[index]);
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

function smootherstep(value: number): number {
  const t = clamp(value, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
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
