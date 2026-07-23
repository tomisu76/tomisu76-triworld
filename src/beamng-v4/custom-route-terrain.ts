import { buildBanovceRealWorldTerrain } from './gis-terrain';
import type { GeodeticTransformer, LocalPoint, Wgs84Point } from './geodetic-transformer';
import { enforceClosedGradeConstraint } from './road-first-finalizer';
import type {
  NativeDecalRoad,
  RoadFirstStation,
  RoadFirstTerrainResult,
} from './road-first-terrain';
import type { RouteDefinition } from './route-input';
import type { BeamNGTerrainArtifact } from './types';

const GRAVITY = 9.80665;
const INDEX_CELL_SIZE = 32;
const MAXIMUM_DAYLIGHT_SLOPE = 0.28;

interface Point2 {
  x: number;
  y: number;
}

interface Segment {
  a: RoadFirstStation;
  b: RoadFirstStation;
}

export interface CustomRouteBuildOptions {
  size?: number;
  squareSize?: number;
  maxHeight?: number;
  centerWgs84?: Wgs84Point;
}

export interface CustomRouteTerrainResult extends RoadFirstTerrainResult {
  routeDefinition: RouteDefinition;
  controlPointsLocal: Point2[];
}

export function buildCustomRouteTerrain(
  route: RouteDefinition,
  options: CustomRouteBuildOptions = {},
): CustomRouteTerrainResult {
  const size = options.size ?? 1024;
  const squareSize = options.squareSize ?? 1;
  const maxHeight = options.maxHeight ?? 500;
  const centerWgs84 = options.centerWgs84 ?? calculateRouteCenter(route.points);
  const base = buildBanovceRealWorldTerrain({
    size,
    squareSize,
    maxHeight,
    centerWgs84,
  });

  const roadWidth = clamp(route.roadWidth ?? 7.2, 4, 14);
  const shoulderWidth = clamp(route.shoulderWidth ?? 1.8, 0.5, 5);
  const maximumGrade = clamp(route.maximumGrade ?? 0.10, 0.03, 0.18);
  const maximumBank = clamp(route.maximumBank ?? 0.045, 0, 0.08);
  const designSpeedKmh = clamp(route.designSpeedKmh ?? 55, 20, 100);
  const stationSpacing = clamp(route.stationSpacing ?? 4, 2, 8);
  const minimumBlendWidth = clamp(route.minimumBlendWidth ?? 22, 8, 35);
  const maximumBlendWidth = clamp(
    route.maximumBlendWidth ?? 70,
    minimumBlendWidth,
    90,
  );

  const controls = route.points.map((point) => {
    const local = base.transformer.wgs84ToLocal(point);
    return { x: local.x, y: local.y };
  });
  validateRouteFitsTerrain(
    controls,
    size * squareSize,
    roadWidth / 2 + shoulderWidth + maximumBlendWidth + 2,
  );

  const smoothPlan = smoothClosedControls(controls);
  const densePlan = resampleClosedPlan(smoothPlan, stationSpacing);
  const rawProfile = densePlan.map((point) => sampleHeightBilinear(
    base.rawElevations,
    size,
    squareSize,
    point.x,
    point.y,
  ));
  const designedProfile = smoothVerticalProfile(rawProfile);
  const stations = buildStations(
    densePlan,
    designedProfile,
    roadWidth,
    maximumBank,
    designSpeedKmh,
  );
  enforceClosedGradeConstraint(stations, maximumGrade);

  const elevations = new Float32Array(base.rawElevations);
  const terrainStats = conformTerrainToRoute(
    elevations,
    base.rawElevations,
    size,
    squareSize,
    stations,
    shoulderWidth,
    minimumBlendWidth,
    maximumBlendWidth,
  );
  const artifact = quantizeTerrain(base.artifact, elevations, maxHeight);
  const road = buildRouteDecalRoad(route.name, stations, roadWidth);
  const sampleElevation = (x: number, y: number): number => sampleHeightBilinear(
    elevations,
    size,
    squareSize,
    x,
    y,
  );

  return {
    ...base,
    artifact,
    rawElevations: elevations,
    scannedMinElevation: terrainStats.minimumElevation,
    scannedMaxElevation: terrainStats.maximumElevation,
    sampleElevation,
    road,
    roadStations: stations,
    routeDefinition: route,
    controlPointsLocal: controls,
    stats: {
      roadLengthMetres: stations[stations.length - 1].station,
      stations: stations.length,
      maximumGrade: calculateMaximumGrade(stations),
      maximumBank: stations.reduce((maximum, station) => Math.max(maximum, Math.abs(station.bank)), 0),
      maximumCutMetres: terrainStats.maximumCutMetres,
      maximumFillMetres: terrainStats.maximumFillMetres,
      modifiedTerrainSamples: terrainStats.modifiedTerrainSamples,
      minimumElevation: terrainStats.minimumElevation,
      maximumElevation: terrainStats.maximumElevation,
    },
  };
}

function calculateRouteCenter(points: readonly Wgs84Point[]): Wgs84Point {
  const sum = points.reduce(
    (accumulator, point) => ({
      longitude: accumulator.longitude + point.longitude,
      latitude: accumulator.latitude + point.latitude,
      altitude: accumulator.altitude + point.altitude,
    }),
    { longitude: 0, latitude: 0, altitude: 0 },
  );
  return {
    longitude: sum.longitude / points.length,
    latitude: sum.latitude / points.length,
    altitude: sum.altitude / points.length,
  };
}

function validateRouteFitsTerrain(
  controls: readonly Point2[],
  worldSize: number,
  requiredMargin: number,
): void {
  for (let index = 0; index < controls.length; index++) {
    const point = controls[index];
    const margin = Math.min(point.x, point.y, worldSize - point.x, worldSize - point.y);
    if (margin < requiredMargin) {
      throw new Error(
        `Route point ${index} is only ${margin.toFixed(1)} m from the terrain edge; `
        + `at least ${requiredMargin.toFixed(1)} m is required for the road and cut/fill corridor. `
        + 'Increase map size or move the route centre.',
      );
    }
  }
}

function smoothClosedControls(controls: readonly Point2[]): Point2[] {
  const output: Point2[] = [];
  const subdivisions = Math.max(12, Math.min(28, Math.round(160 / controls.length)));
  for (let index = 0; index < controls.length; index++) {
    const p0 = controls[(index - 1 + controls.length) % controls.length];
    const p1 = controls[index];
    const p2 = controls[(index + 1) % controls.length];
    const p3 = controls[(index + 2) % controls.length];
    for (let step = 0; step < subdivisions; step++) {
      output.push(catmullRom(p0, p1, p2, p3, step / subdivisions));
    }
  }
  output.push({ ...output[0] });
  return output;
}

function resampleClosedPlan(pointsWithClosure: readonly Point2[], spacing: number): Point2[] {
  const points = pointsWithClosure.slice(0, -1);
  const cumulative = [0];
  for (let index = 0; index < points.length; index++) {
    const next = points[(index + 1) % points.length];
    cumulative.push(cumulative[index] + distance(points[index], next));
  }
  const totalLength = cumulative[cumulative.length - 1];
  if (totalLength < 100) throw new Error(`Route is too short: ${totalLength.toFixed(1)} m`);
  const count = Math.max(16, Math.round(totalLength / spacing));
  const output: Point2[] = [];
  for (let index = 0; index < count; index++) {
    output.push(sampleClosedPolyline(points, cumulative, index * totalLength / count));
  }
  return output;
}

function smoothVerticalProfile(raw: readonly number[]): number[] {
  let profile = [...raw];
  for (let pass = 0; pass < 12; pass++) {
    profile = profile.map((value, index) => {
      const previous = profile[(index - 1 + profile.length) % profile.length];
      const next = profile[(index + 1) % profile.length];
      return previous * 0.24 + value * 0.52 + next * 0.24;
    });
  }
  return profile;
}

function buildStations(
  plan: readonly Point2[],
  profile: readonly number[],
  width: number,
  maximumBank: number,
  designSpeedKmh: number,
): RoadFirstStation[] {
  const tangents = plan.map((_, index) => {
    const previous = plan[(index - 1 + plan.length) % plan.length];
    const next = plan[(index + 1) % plan.length];
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    const length = Math.hypot(dx, dy) || 1;
    return { x: dx / length, y: dy / length };
  });
  const banks = plan.map((_, index) => {
    const previousIndex = (index - 1 + plan.length) % plan.length;
    const nextIndex = (index + 1) % plan.length;
    const previousTangent = tangents[previousIndex];
    const nextTangent = tangents[nextIndex];
    const signedAngle = Math.atan2(
      previousTangent.x * nextTangent.y - previousTangent.y * nextTangent.x,
      clamp(previousTangent.x * nextTangent.x + previousTangent.y * nextTangent.y, -1, 1),
    );
    const run = Math.max(1, distance(plan[previousIndex], plan[nextIndex]));
    const curvature = signedAngle / run;
    const speed = designSpeedKmh / 3.6;
    return clamp(curvature * speed * speed / GRAVITY * 0.55, -maximumBank, maximumBank);
  });
  let smoothBanks = banks;
  for (let pass = 0; pass < 5; pass++) {
    smoothBanks = smoothBanks.map((value, index) => {
      const previous = smoothBanks[(index - 1 + smoothBanks.length) % smoothBanks.length];
      const next = smoothBanks[(index + 1) % smoothBanks.length];
      return clamp(previous * 0.22 + value * 0.56 + next * 0.22, -maximumBank, maximumBank);
    });
  }

  const stations: RoadFirstStation[] = [];
  let stationDistance = 0;
  for (let index = 0; index < plan.length; index++) {
    if (index > 0) stationDistance += distance(plan[index - 1], plan[index]);
    const tangent = tangents[index];
    stations.push({
      station: stationDistance,
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
  stations.push({ ...stations[0], station: stationDistance + closingLength });
  return stations;
}

function conformTerrainToRoute(
  elevations: Float32Array,
  baseline: Float32Array,
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
  const segments: Segment[] = [];
  const cells = new Map<string, number[]>();
  const searchRadius = stations[0].width / 2 + shoulderWidth + maximumBlendWidth;
  for (let index = 0; index < stations.length - 1; index++) {
    const segmentIndex = segments.length;
    const segment = { a: stations[index], b: stations[index + 1] };
    segments.push(segment);
    const minCellX = cellCoordinate(Math.min(segment.a.x, segment.b.x) - searchRadius);
    const maxCellX = cellCoordinate(Math.max(segment.a.x, segment.b.x) + searchRadius);
    const minCellY = cellCoordinate(Math.min(segment.a.y, segment.b.y) - searchRadius);
    const maxCellY = cellCoordinate(Math.max(segment.a.y, segment.b.y) + searchRadius);
    for (let cellY = minCellY; cellY <= maxCellY; cellY++) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
        const key = `${cellX}:${cellY}`;
        const bucket = cells.get(key);
        if (bucket) bucket.push(segmentIndex);
        else cells.set(key, [segmentIndex]);
      }
    }
  }

  const mask = new Uint8Array(size * size);
  for (let row = 0; row < size; row++) {
    const y = (size - 1 - row) * squareSize;
    for (let column = 0; column < size; column++) {
      const x = column * squareSize;
      const terrainIndex = row * size + column;
      const original = baseline[terrainIndex];
      const bucket = cells.get(`${cellCoordinate(x)}:${cellCoordinate(y)}`);
      if (!bucket) continue;
      let bestDistance = Number.POSITIVE_INFINITY;
      let bestTarget = original;
      let bestInfluence = 0;
      for (const segmentIndex of bucket) {
        const candidate = sampleSegment(
          segments[segmentIndex],
          x,
          y,
          original,
          shoulderWidth,
          minimumBlendWidth,
          maximumBlendWidth,
        );
        if (!candidate) continue;
        if (candidate.distance < bestDistance - 1e-8
          || (Math.abs(candidate.distance - bestDistance) <= 1e-8
            && candidate.influence > bestInfluence)) {
          bestDistance = candidate.distance;
          bestTarget = candidate.target;
          bestInfluence = candidate.influence;
        }
      }
      if (bestInfluence <= 0) continue;
      elevations[terrainIndex] = mix(original, bestTarget, bestInfluence);
      mask[terrainIndex] = Math.max(1, Math.min(255, Math.round(bestInfluence * 255)));
    }
  }

  smoothTransitionBand(elevations, size, mask, 3);

  let maximumCutMetres = 0;
  let maximumFillMetres = 0;
  let modifiedTerrainSamples = 0;
  let minimumElevation = Number.POSITIVE_INFINITY;
  let maximumElevation = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < elevations.length; index++) {
    const elevation = elevations[index];
    minimumElevation = Math.min(minimumElevation, elevation);
    maximumElevation = Math.max(maximumElevation, elevation);
    if (mask[index] === 0) continue;
    modifiedTerrainSamples += 1;
    maximumCutMetres = Math.max(maximumCutMetres, baseline[index] - elevation);
    maximumFillMetres = Math.max(maximumFillMetres, elevation - baseline[index]);
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
  mask: Uint8Array,
  passes: number,
): void {
  const scratch = new Float32Array(elevations.length);
  for (let pass = 0; pass < passes; pass++) {
    scratch.set(elevations);
    for (let row = 1; row < size - 1; row++) {
      for (let column = 1; column < size - 1; column++) {
        const index = row * size + column;
        const weight = mask[index];
        if (weight === 0 || weight >= 250) continue;
        const average = (
          scratch[index] * 4
          + scratch[index - 1]
          + scratch[index + 1]
          + scratch[index - size]
          + scratch[index + size]
        ) / 8;
        const transitionWeight = 1 - Math.abs(weight / 255 - 0.5) * 2;
        elevations[index] = mix(scratch[index], average, 0.32 + transitionWeight * 0.28);
      }
    }
  }
}

function buildRouteDecalRoad(
  routeName: string,
  stations: readonly RoadFirstStation[],
  width: number,
): NativeDecalRoad {
  const stationDelta = stations.length > 1 ? stations[1].station - stations[0].station : 4;
  const stride = Math.max(1, Math.round(8 / Math.max(1, stationDelta)));
  const nodes: Array<[number, number, number, number]> = [];
  for (let index = 0; index < stations.length - 1; index += stride) {
    const station = stations[index];
    nodes.push([round6(station.x), round6(station.y), round6(station.z), round6(width)]);
  }
  const first = stations[0];
  nodes.push([round6(first.x), round6(first.y), round6(first.z), round6(width)]);

  const road: NativeDecalRoad = {
    class: 'DecalRoad',
    name: `triworld_route_${routeName}`,
    __parent: 'MissionGroup',
    material: 'triworld_v4_asphalt',
    textureLength: 14,
    breakAngle: 1,
    renderPriority: 20,
    zBias: 0.001,
    decalBias: 0.004,
    distanceFade: [5000, 700],
    startEndFade: [0, 0],
    overObjects: false,
    drivability: 1,
    autoLanes: false,
    autoJunction: false,
    oneWay: false,
    nodes,
  };
  Object.assign(road as NativeDecalRoad & Record<string, unknown>, {
    improvedSpline: true,
    useSubdivisions: true,
    lanesLeft: 1,
    lanesRight: 1,
    flipDirection: false,
    gatedRoad: false,
    hiddenInNavi: false,
    persistentId: deterministicUuid(routeName),
  });
  return road;
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

function sampleClosedPolyline(
  points: readonly Point2[],
  cumulative: readonly number[],
  station: number,
): Point2 {
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
    x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t
      + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2
      + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t
      + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2
      + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  };
}

function deterministicUuid(input: string): string {
  const words = [2166136261, 2246822519, 3266489917, 668265263];
  for (let index = 0; index < input.length; index++) {
    const code = input.charCodeAt(index);
    for (let word = 0; word < words.length; word++) {
      words[word] = Math.imul(words[word] ^ (code + word * 31), 16777619 + word * 2) >>> 0;
    }
  }
  const hex = words.map((word) => word.toString(16).padStart(8, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function cellCoordinate(value: number): number {
  return Math.floor(value / INDEX_CELL_SIZE);
}

function distance(a: Point2, b: Point2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
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
