import type { BeamNGTerrainArtifact } from './types';
import {
  buildBanovceRealWorldTerrain,
  type GisTerrainConfig,
  type GisTerrainResult,
} from './gis-terrain';
import type { Wgs84Point } from './geodetic-transformer';

export const MOUNTAIN_LOOP_CENTER_WGS84: Wgs84Point = {
  longitude: 18.3582575,
  latitude: 48.7245523,
  altitude: 285,
};

export interface RoadFirstConfig extends Partial<GisTerrainConfig> {
  roadWidth?: number;
  shoulderWidth?: number;
  maximumGrade?: number;
  maximumBank?: number;
  designSpeedKmh?: number;
  stationSpacing?: number;
  minimumBlendWidth?: number;
  maximumBlendWidth?: number;
}

export interface RoadFirstStation {
  station: number;
  x: number;
  y: number;
  z: number;
  tangentX: number;
  tangentY: number;
  normalX: number;
  normalY: number;
  bank: number;
  width: number;
}

export interface NativeDecalRoad {
  class: 'DecalRoad';
  name: string;
  __parent: 'MissionGroup';
  material: string;
  textureLength: number;
  breakAngle: number;
  renderPriority: number;
  zBias: number;
  decalBias: number;
  distanceFade: [number, number];
  startEndFade: [number, number];
  overObjects: boolean;
  drivability: number;
  autoLanes: boolean;
  autoJunction: boolean;
  oneWay: boolean;
  nodes: Array<[number, number, number, number]>;
}

export interface RoadFirstStats {
  roadLengthMetres: number;
  stations: number;
  maximumGrade: number;
  maximumBank: number;
  maximumCutMetres: number;
  maximumFillMetres: number;
  modifiedTerrainSamples: number;
  minimumElevation: number;
  maximumElevation: number;
}

export interface RoadFirstTerrainResult extends GisTerrainResult {
  road: NativeDecalRoad;
  roadStations: RoadFirstStation[];
  stats: RoadFirstStats;
}

type Point2 = { x: number; y: number };
type Segment = {
  a: RoadFirstStation;
  b: RoadFirstStation;
  searchRadius: number;
};

const GRAVITY = 9.80665;
const INDEX_CELL_SIZE = 32;

/**
 * Builds a civil-style closed mountain circuit first, then reshapes the native
 * BeamNG TerrainBlock heightfield around that design. The resulting terrain is
 * the physical road surface; the DecalRoad is only the visible asphalt and AI
 * route layer projected onto the already-conformed collision terrain.
 */
export function buildMountainLoopRoadFirstTerrain(
  requested: RoadFirstConfig = {},
): RoadFirstTerrainResult {
  const size = requested.size ?? 1024;
  const squareSize = requested.squareSize ?? 1;
  const maxHeight = requested.maxHeight ?? 500;
  const centerWgs84 = requested.centerWgs84 ?? MOUNTAIN_LOOP_CENTER_WGS84;
  const base = buildBanovceRealWorldTerrain({
    size,
    squareSize,
    maxHeight,
    centerWgs84,
  });

  const design = normaliseDesign(requested);
  const plan = buildClosedMountainLoop(size * squareSize);
  const densePlan = resampleClosedPlan(plan, design.stationSpacing);
  const rawProfile = densePlan.map((point) => sampleHeightBilinear(
    base.rawElevations,
    size,
    squareSize,
    point.x,
    point.y,
  ));
  const designedProfile = designClosedVerticalProfile(
    rawProfile,
    design.stationSpacing,
    design.maximumGrade,
  );
  const stations = buildStations(
    densePlan,
    designedProfile,
    design.stationSpacing,
    design.roadWidth,
    design.maximumBank,
    design.designSpeedKmh,
  );

  const conformedElevations = new Float32Array(base.rawElevations);
  const terrainStats = conformTerrainToClosedRoad(
    conformedElevations,
    size,
    squareSize,
    stations,
    design.shoulderWidth,
    design.minimumBlendWidth,
    design.maximumBlendWidth,
  );
  const artifact = quantizeTerrain(base.artifact, conformedElevations, maxHeight);
  const road = buildDecalRoad(stations, design.roadWidth);
  const sampleElevation = (xMetres: number, yMetres: number): number => sampleHeightBilinear(
    conformedElevations,
    size,
    squareSize,
    xMetres,
    yMetres,
  );

  return {
    ...base,
    artifact,
    rawElevations: conformedElevations,
    scannedMinElevation: terrainStats.minimumElevation,
    scannedMaxElevation: terrainStats.maximumElevation,
    sampleElevation,
    road,
    roadStations: stations,
    stats: {
      roadLengthMetres: stations[stations.length - 1].station,
      stations: stations.length,
      maximumGrade: calculateMaximumClosedGrade(stations),
      maximumBank: stations.reduce((maximum, station) => Math.max(maximum, Math.abs(station.bank)), 0),
      ...terrainStats,
    },
  };
}

function normaliseDesign(requested: RoadFirstConfig): Required<Pick<
  RoadFirstConfig,
  | 'roadWidth'
  | 'shoulderWidth'
  | 'maximumGrade'
  | 'maximumBank'
  | 'designSpeedKmh'
  | 'stationSpacing'
  | 'minimumBlendWidth'
  | 'maximumBlendWidth'
>> {
  const minimumBlendWidth = clamp(requested.minimumBlendWidth ?? 10, 4, 30);
  return {
    roadWidth: clamp(requested.roadWidth ?? 7.2, 4, 14),
    shoulderWidth: clamp(requested.shoulderWidth ?? 1.6, 0.5, 5),
    maximumGrade: clamp(requested.maximumGrade ?? 0.10, 0.03, 0.18),
    maximumBank: clamp(requested.maximumBank ?? 0.045, 0, 0.08),
    designSpeedKmh: clamp(requested.designSpeedKmh ?? 55, 20, 100),
    stationSpacing: clamp(requested.stationSpacing ?? 4, 2, 8),
    minimumBlendWidth,
    maximumBlendWidth: clamp(requested.maximumBlendWidth ?? 42, minimumBlendWidth, 70),
  };
}

function buildClosedMountainLoop(worldSize: number): Point2[] {
  const centre = worldSize / 2;
  const radius = worldSize * 0.39;
  const controls: Point2[] = [
    { x: centre - radius * 0.92, y: centre - radius * 0.12 },
    { x: centre - radius * 0.78, y: centre + radius * 0.48 },
    { x: centre - radius * 0.38, y: centre + radius * 0.90 },
    { x: centre + radius * 0.10, y: centre + radius * 0.95 },
    { x: centre + radius * 0.68, y: centre + radius * 0.68 },
    { x: centre + radius * 0.94, y: centre + radius * 0.12 },
    { x: centre + radius * 0.78, y: centre - radius * 0.55 },
    { x: centre + radius * 0.30, y: centre - radius * 0.92 },
    { x: centre - radius * 0.28, y: centre - radius * 0.86 },
    { x: centre - radius * 0.78, y: centre - radius * 0.52 },
  ];

  const smooth: Point2[] = [];
  const subdivisions = 18;
  for (let index = 0; index < controls.length; index++) {
    const p0 = controls[(index - 1 + controls.length) % controls.length];
    const p1 = controls[index];
    const p2 = controls[(index + 1) % controls.length];
    const p3 = controls[(index + 2) % controls.length];
    for (let step = 0; step < subdivisions; step++) {
      smooth.push(catmullRom(p0, p1, p2, p3, step / subdivisions));
    }
  }
  smooth.push({ ...smooth[0] });
  return smooth;
}

function resampleClosedPlan(points: readonly Point2[], spacing: number): Point2[] {
  const clean = points.slice(0, -1);
  const cumulative = [0];
  for (let index = 0; index < clean.length; index++) {
    const next = clean[(index + 1) % clean.length];
    cumulative.push(cumulative[index] + distance(clean[index], next));
  }
  const totalLength = cumulative[cumulative.length - 1];
  const stationCount = Math.max(16, Math.round(totalLength / spacing));
  const result: Point2[] = [];
  for (let index = 0; index < stationCount; index++) {
    result.push(sampleClosedPolyline(clean, cumulative, index * totalLength / stationCount));
  }
  return result;
}

function designClosedVerticalProfile(
  raw: readonly number[],
  spacing: number,
  maximumGrade: number,
): number[] {
  let profile = [...raw];
  for (let pass = 0; pass < 8; pass++) {
    profile = profile.map((value, index) => {
      const previous = profile[(index - 1 + profile.length) % profile.length];
      const next = profile[(index + 1) % profile.length];
      return previous * 0.22 + value * 0.56 + next * 0.22;
    });
  }

  const maximumDelta = maximumGrade * spacing;
  for (let pass = 0; pass < 160; pass++) {
    let changed = false;
    for (let index = 0; index < profile.length; index++) {
      const nextIndex = (index + 1) % profile.length;
      const delta = profile[nextIndex] - profile[index];
      if (Math.abs(delta) <= maximumDelta + 1e-9) continue;
      const sign = Math.sign(delta);
      const correction = (Math.abs(delta) - maximumDelta) / 2;
      profile[index] += sign * correction;
      profile[nextIndex] -= sign * correction;
      changed = true;
    }
    if (!changed) break;
  }
  return profile;
}

function buildStations(
  plan: readonly Point2[],
  profile: readonly number[],
  nominalSpacing: number,
  width: number,
  maximumBank: number,
  designSpeedKmh: number,
): RoadFirstStation[] {
  const tangents = plan.map((point, index) => {
    const previous = plan[(index - 1 + plan.length) % plan.length];
    const next = plan[(index + 1) % plan.length];
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    const length = Math.hypot(dx, dy) || 1;
    return { x: dx / length, y: dy / length };
  });
  const banks = plan.map((_, index) => {
    const previous = tangents[(index - 1 + tangents.length) % tangents.length];
    const next = tangents[(index + 1) % tangents.length];
    const signedAngle = Math.atan2(
      previous.x * next.y - previous.y * next.x,
      clamp(previous.x * next.x + previous.y * next.y, -1, 1),
    );
    const curvature = signedAngle / Math.max(0.5, nominalSpacing * 2);
    const speed = designSpeedKmh / 3.6;
    return clamp(curvature * speed * speed / GRAVITY * 0.55, -maximumBank, maximumBank);
  });
  let smoothBanks = banks;
  for (let pass = 0; pass < 4; pass++) {
    smoothBanks = smoothBanks.map((value, index) => {
      const previous = smoothBanks[(index - 1 + smoothBanks.length) % smoothBanks.length];
      const next = smoothBanks[(index + 1) % smoothBanks.length];
      return clamp(previous * 0.2 + value * 0.6 + next * 0.2, -maximumBank, maximumBank);
    });
  }

  const stations: RoadFirstStation[] = [];
  let station = 0;
  for (let index = 0; index < plan.length; index++) {
    if (index > 0) station += distance(plan[index - 1], plan[index]);
    const tangent = tangents[index];
    stations.push({
      station,
      x: plan[index].x,
      y: plan[index].y,
      z: profile[index],
      tangentX: tangent.x,
      tangentY: tangent.y,
      normalX: -tangent.y,
      normalY: tangent.x,
      bank: smoothBanks[index],
      width,
    });
  }
  const closingLength = distance(plan[plan.length - 1], plan[0]);
  stations.push({ ...stations[0], station: station + closingLength });
  return stations;
}

function conformTerrainToClosedRoad(
  elevations: Float32Array,
  size: number,
  squareSize: number,
  stations: readonly RoadFirstStation[],
  shoulderWidth: number,
  minimumBlendWidth: number,
  maximumBlendWidth: number,
): Pick<
  RoadFirstStats,
  | 'maximumCutMetres'
  | 'maximumFillMetres'
  | 'modifiedTerrainSamples'
  | 'minimumElevation'
  | 'maximumElevation'
> {
  const segments: Segment[] = [];
  const cells = new Map<string, number[]>();
  const maximumSearchRadius = stations[0].width / 2 + shoulderWidth + maximumBlendWidth;
  for (let index = 0; index < stations.length - 1; index++) {
    const segmentIndex = segments.length;
    const segment = { a: stations[index], b: stations[index + 1], searchRadius: maximumSearchRadius };
    segments.push(segment);
    const minCellX = cellCoordinate(Math.min(segment.a.x, segment.b.x) - maximumSearchRadius);
    const maxCellX = cellCoordinate(Math.max(segment.a.x, segment.b.x) + maximumSearchRadius);
    const minCellY = cellCoordinate(Math.min(segment.a.y, segment.b.y) - maximumSearchRadius);
    const maxCellY = cellCoordinate(Math.max(segment.a.y, segment.b.y) + maximumSearchRadius);
    for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
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
      const baseElevation = elevations[terrainIndex];
      const bucket = cells.get(`${cellCoordinate(x)}:${cellCoordinate(y)}`);
      let finalElevation = baseElevation;
      let strongestInfluence = 0;
      let strongestTarget = baseElevation;
      let closestDistance = Number.POSITIVE_INFINITY;

      if (bucket) {
        for (const segmentIndex of bucket) {
          const candidate = sampleSegment(segments[segmentIndex], x, y, baseElevation, shoulderWidth, minimumBlendWidth, maximumBlendWidth);
          if (!candidate) continue;
          if (candidate.influence > strongestInfluence + 1e-9
            || (Math.abs(candidate.influence - strongestInfluence) < 1e-9 && candidate.distance < closestDistance)) {
            strongestInfluence = candidate.influence;
            strongestTarget = candidate.target;
            closestDistance = candidate.distance;
          }
        }
      }

      if (strongestInfluence > 0) {
        finalElevation = mix(baseElevation, strongestTarget, strongestInfluence);
        elevations[terrainIndex] = finalElevation;
        modifiedTerrainSamples += 1;
        maximumCutMetres = Math.max(maximumCutMetres, baseElevation - finalElevation);
        maximumFillMetres = Math.max(maximumFillMetres, finalElevation - baseElevation);
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
  segment: Segment,
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
  if (lengthSquared < 1e-8) return null;
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
  const centreZ = mix(segment.a.z, segment.b.z, t);
  const bank = mix(segment.a.bank, segment.b.bank, t);
  const target = centreZ + signedLateral * bank;
  const verticalDifference = Math.abs(baseElevation - target);
  const blendWidth = clamp(minimumBlendWidth + verticalDifference * 1.75, minimumBlendWidth, maximumBlendWidth);
  const outerRadius = innerRadius + blendWidth;
  if (lateralDistance > outerRadius) return null;
  const influence = lateralDistance <= innerRadius
    ? 1
    : smoothstep(1 - (lateralDistance - innerRadius) / blendWidth);
  return { target, influence, distance: lateralDistance };
}

function quantizeTerrain(
  original: BeamNGTerrainArtifact,
  elevations: Float32Array,
  maxHeight: number,
): BeamNGTerrainArtifact {
  const heightScale = maxHeight / 65535;
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
    maxHeight,
    minimumDecodedElevation,
    maximumDecodedElevation,
  };
}

function buildDecalRoad(stations: readonly RoadFirstStation[], width: number): NativeDecalRoad {
  const nodeStride = Math.max(1, Math.round(8 / Math.max(1, stations[1].station - stations[0].station)));
  const nodes: Array<[number, number, number, number]> = [];
  for (let index = 0; index < stations.length - 1; index += nodeStride) {
    const station = stations[index];
    nodes.push([round6(station.x), round6(station.y), round6(station.z), round6(width)]);
  }
  const first = stations[0];
  nodes.push([round6(first.x), round6(first.y), round6(first.z), round6(width)]);
  return {
    class: 'DecalRoad',
    name: 'triworld_mountain_loop',
    __parent: 'MissionGroup',
    material: 'triworld_v4_asphalt',
    textureLength: 8,
    breakAngle: 2,
    renderPriority: 10,
    zBias: 0,
    decalBias: 0.002,
    distanceFade: [2500, 250],
    startEndFade: [0, 0],
    overObjects: false,
    drivability: 1,
    autoLanes: true,
    autoJunction: false,
    oneWay: false,
    nodes,
  };
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

function calculateMaximumClosedGrade(stations: readonly RoadFirstStation[]): number {
  let maximum = 0;
  for (let index = 0; index < stations.length - 1; index++) {
    const run = Math.max(0.01, stations[index + 1].station - stations[index].station);
    maximum = Math.max(maximum, Math.abs(stations[index + 1].z - stations[index].z) / run);
  }
  return maximum;
}

function sampleClosedPolyline(points: readonly Point2[], cumulative: readonly number[], station: number): Point2 {
  const totalLength = cumulative[cumulative.length - 1];
  const target = ((station % totalLength) + totalLength) % totalLength;
  let segment = 0;
  while (segment < points.length - 1 && cumulative[segment + 1] < target) segment += 1;
  const nextIndex = (segment + 1) % points.length;
  const segmentLength = cumulative[segment + 1] - cumulative[segment];
  const t = segmentLength < 1e-9 ? 0 : (target - cumulative[segment]) / segmentLength;
  return {
    x: mix(points[segment].x, points[nextIndex].x, t),
    y: mix(points[segment].y, points[nextIndex].y, t),
  };
}

function catmullRom(p0: Point2, p1: Point2, p2: Point2, p3: Point2, t: number): Point2 {
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  };
}

function cellCoordinate(value: number): number {
  return Math.floor(value / INDEX_CELL_SIZE);
}

function distance(a: Point2, b: Point2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
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
