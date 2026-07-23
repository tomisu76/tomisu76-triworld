import type { GisTerrainResult } from './gis-terrain';
import type { BeamNGTerrainArtifact } from './types';

export interface RoadTerrainConfig {
  roadWidth: number;
  shoulderWidth: number;
  blendWidth: number;
  stationSpacing: number;
  maxGrade: number;
  maxBank: number;
  designSpeedMetresPerSecond: number;
}

export interface RoadTerrainNode {
  x: number;
  y: number;
  z: number;
  width: number;
  station: number;
  headingRadians: number;
  bank: number;
}

export interface RoadTerrainStats {
  roadLengthMetres: number;
  stationCount: number;
  maximumAbsoluteGrade: number;
  maximumAbsoluteBank: number;
  minimumCutFillMetres: number;
  maximumCutFillMetres: number;
  modifiedSampleCount: number;
  asphaltSampleCount: number;
}

export interface RoadTerrainResult {
  artifact: BeamNGTerrainArtifact;
  originalElevations: Float32Array;
  deformedElevations: Float32Array;
  roadNodes: RoadTerrainNode[];
  roadObject: Record<string, unknown>;
  roadSpawn: Record<string, unknown>;
  stats: RoadTerrainStats;
  sampleElevation: (xMetres: number, yMetres: number) => number;
}

interface Point2 {
  x: number;
  y: number;
}

const DEFAULT_CONFIG: RoadTerrainConfig = {
  roadWidth: 7.2,
  shoulderWidth: 1.4,
  blendWidth: 15.0,
  stationSpacing: 7.5,
  maxGrade: 0.095,
  maxBank: 0.075,
  designSpeedMetresPerSecond: 18.0,
};

/**
 * Builds a closed two-lane mountain circuit first, then cuts/fills the terrain
 * around that designed 3D alignment. The road therefore never floats above or
 * intersects the final heightfield. All calculations are deterministic.
 */
export function buildMountainLoopRoadTerrain(
  base: GisTerrainResult,
  overrides: Partial<RoadTerrainConfig> = {},
): RoadTerrainResult {
  const config = { ...DEFAULT_CONFIG, ...overrides };
  validateConfig(config, base.artifact);

  const size = base.artifact.size;
  const squareSize = base.artifact.squareSize;
  const worldSize = size * squareSize;
  const controlPoints = makeMountainLoopControlPoints(worldSize);
  const denseCenterline = catmullRomClosed(controlPoints, 28);
  const centerline = resampleClosedPolyline(denseCenterline, config.stationSpacing);
  const horizontal = buildHorizontalStations(centerline);
  const terrainProfile = centerline.map((point) => sampleGridBilinear(
    base.rawElevations,
    size,
    squareSize,
    point.x,
    point.y,
  ));
  const profile = designClosedVerticalProfile(horizontal.segmentLengths, terrainProfile, config.maxGrade);
  const banks = designBanks(centerline, horizontal.segmentLengths, config);

  const roadNodes: RoadTerrainNode[] = centerline.map((point, index) => ({
    x: round(point.x, 4),
    y: round(point.y, 4),
    z: round(profile[index], 4),
    width: config.roadWidth,
    station: round(horizontal.stations[index], 4),
    headingRadians: round(horizontal.headings[index], 8),
    bank: round(banks[index], 8),
  }));

  const deformation = deformTerrainToRoad(
    base.rawElevations,
    size,
    squareSize,
    roadNodes,
    config,
  );

  const heightMapU16 = quantizeElevations(
    deformation.elevations,
    base.artifact.heightScale,
  );
  const decodedBounds = scanDecodedBounds(heightMapU16, base.artifact.heightScale);

  const artifact: BeamNGTerrainArtifact = {
    ...base.artifact,
    heightMapU16,
    layerMapU8: deformation.layerMap,
    materialNames: ['triworld_v4_ground', 'ASPHALT'],
    minimumDecodedElevation: decodedBounds.minimum,
    maximumDecodedElevation: decodedBounds.maximum,
  };

  const closedRoadNodes = [...roadNodes, { ...roadNodes[0], station: round(horizontal.totalLength, 4) }];
  const roadObject = makeDecalRoadObject(closedRoadNodes);
  const roadSpawn = makeRoadSpawn(roadNodes[0], roadNodes[1]);

  const maximumAbsoluteGrade = calculateMaximumGrade(profile, horizontal.segmentLengths);
  const maximumAbsoluteBank = banks.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);

  return {
    artifact,
    originalElevations: new Float32Array(base.rawElevations),
    deformedElevations: deformation.elevations,
    roadNodes,
    roadObject,
    roadSpawn,
    stats: {
      roadLengthMetres: horizontal.totalLength,
      stationCount: roadNodes.length,
      maximumAbsoluteGrade,
      maximumAbsoluteBank,
      minimumCutFillMetres: deformation.minimumCutFill,
      maximumCutFillMetres: deformation.maximumCutFill,
      modifiedSampleCount: deformation.modifiedSampleCount,
      asphaltSampleCount: deformation.asphaltSampleCount,
    },
    sampleElevation: (xMetres: number, yMetres: number) => sampleGridBilinear(
      deformation.elevations,
      size,
      squareSize,
      xMetres,
      yMetres,
    ),
  };
}

function validateConfig(config: RoadTerrainConfig, artifact: BeamNGTerrainArtifact): void {
  if (artifact.size < 128 || artifact.squareSize <= 0) {
    throw new Error('Road terrain requires a valid native terrain grid');
  }
  if (config.roadWidth < 4 || config.roadWidth > 20) {
    throw new Error(`Road width out of range: ${config.roadWidth}`);
  }
  if (config.shoulderWidth < 0 || config.blendWidth < artifact.squareSize * 2) {
    throw new Error('Road shoulder/blend widths are invalid');
  }
  if (config.stationSpacing < 2 || config.stationSpacing > 25) {
    throw new Error(`Station spacing out of range: ${config.stationSpacing}`);
  }
  if (config.maxGrade <= 0 || config.maxGrade > 0.2) {
    throw new Error(`Maximum grade out of range: ${config.maxGrade}`);
  }
  if (config.maxBank < 0 || config.maxBank > 0.15) {
    throw new Error(`Maximum bank out of range: ${config.maxBank}`);
  }
}

function makeMountainLoopControlPoints(worldSize: number): Point2[] {
  const normalized: ReadonlyArray<readonly [number, number]> = [
    [0.16, 0.55],
    [0.19, 0.72],
    [0.31, 0.84],
    [0.50, 0.88],
    [0.69, 0.82],
    [0.83, 0.68],
    [0.87, 0.50],
    [0.79, 0.31],
    [0.62, 0.17],
    [0.43, 0.14],
    [0.25, 0.22],
    [0.13, 0.38],
  ];
  return normalized.map(([x, y]) => ({ x: x * worldSize, y: y * worldSize }));
}

function catmullRomClosed(points: readonly Point2[], subdivisions: number): Point2[] {
  if (points.length < 4) throw new Error('Closed road spline requires at least four control points');
  const output: Point2[] = [];
  const count = points.length;

  for (let i = 0; i < count; i++) {
    const p0 = points[(i - 1 + count) % count];
    const p1 = points[i];
    const p2 = points[(i + 1) % count];
    const p3 = points[(i + 2) % count];

    for (let step = 0; step < subdivisions; step++) {
      const t = step / subdivisions;
      const t2 = t * t;
      const t3 = t2 * t;
      output.push({
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  return output;
}

function resampleClosedPolyline(points: readonly Point2[], requestedSpacing: number): Point2[] {
  const cumulative = new Float64Array(points.length + 1);
  for (let i = 0; i < points.length; i++) {
    cumulative[i + 1] = cumulative[i] + distance(points[i], points[(i + 1) % points.length]);
  }
  const totalLength = cumulative[cumulative.length - 1];
  const stationCount = Math.max(48, Math.round(totalLength / requestedSpacing));
  const spacing = totalLength / stationCount;
  const output: Point2[] = [];
  let segment = 0;

  for (let i = 0; i < stationCount; i++) {
    const target = i * spacing;
    while (segment + 1 < cumulative.length - 1 && cumulative[segment + 1] < target) segment++;
    const a = points[segment % points.length];
    const b = points[(segment + 1) % points.length];
    const length = cumulative[segment + 1] - cumulative[segment];
    const t = length > 0 ? (target - cumulative[segment]) / length : 0;
    output.push({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });
  }
  return output;
}

function buildHorizontalStations(points: readonly Point2[]): {
  stations: Float64Array;
  segmentLengths: Float64Array;
  headings: Float64Array;
  totalLength: number;
} {
  const n = points.length;
  const stations = new Float64Array(n);
  const segmentLengths = new Float64Array(n);
  const headings = new Float64Array(n);
  let totalLength = 0;

  for (let i = 0; i < n; i++) {
    stations[i] = totalLength;
    const next = points[(i + 1) % n];
    const length = distance(points[i], next);
    segmentLengths[i] = length;
    totalLength += length;

    const previous = points[(i - 1 + n) % n];
    headings[i] = Math.atan2(next.y - previous.y, next.x - previous.x);
  }
  return { stations, segmentLengths, headings, totalLength };
}

function designClosedVerticalProfile(
  segmentLengths: Float64Array,
  sampledTerrain: readonly number[],
  maxGrade: number,
): Float64Array {
  const n = sampledTerrain.length;
  let elevations = Float64Array.from(sampledTerrain);

  for (let iteration = 0; iteration < 10; iteration++) {
    const smoothed = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      smoothed[i] = (
        elevations[(i - 2 + n) % n] +
        2 * elevations[(i - 1 + n) % n] +
        4 * elevations[i] +
        2 * elevations[(i + 1) % n] +
        elevations[(i + 2) % n]
      ) / 10;
    }
    elevations = smoothed;
    enforceClosedGradeLimit(elevations, segmentLengths, maxGrade, 8);
  }

  enforceClosedGradeLimit(elevations, segmentLengths, maxGrade, 160);
  return elevations;
}

function enforceClosedGradeLimit(
  elevations: Float64Array,
  segmentLengths: Float64Array,
  maxGrade: number,
  passes: number,
): void {
  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < elevations.length; i++) {
      const j = (i + 1) % elevations.length;
      const allowed = maxGrade * segmentLengths[i];
      const delta = elevations[j] - elevations[i];
      if (Math.abs(delta) > allowed) {
        const excess = (Math.abs(delta) - allowed) * 0.5;
        const sign = Math.sign(delta);
        elevations[i] += sign * excess;
        elevations[j] -= sign * excess;
      }
    }
  }
}

function designBanks(
  points: readonly Point2[],
  segmentLengths: Float64Array,
  config: RoadTerrainConfig,
): Float64Array {
  const n = points.length;
  let banks = new Float64Array(n);
  const speedSquaredOverGravity = (config.designSpeedMetresPerSecond ** 2) / 9.81;

  for (let i = 0; i < n; i++) {
    const previous = points[(i - 1 + n) % n];
    const current = points[i];
    const next = points[(i + 1) % n];
    const a = normalize(current.x - previous.x, current.y - previous.y);
    const b = normalize(next.x - current.x, next.y - current.y);
    const signedAngle = Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y);
    const averageLength = Math.max(1, (segmentLengths[(i - 1 + n) % n] + segmentLengths[i]) * 0.5);
    const curvature = signedAngle / averageLength;
    banks[i] = clamp(curvature * speedSquaredOverGravity, -config.maxBank, config.maxBank);
  }

  for (let iteration = 0; iteration < 6; iteration++) {
    const smoothed = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      smoothed[i] = clamp(
        (banks[(i - 1 + n) % n] + 2 * banks[i] + banks[(i + 1) % n]) / 4,
        -config.maxBank,
        config.maxBank,
      );
    }
    banks = smoothed;
  }
  return banks;
}

function deformTerrainToRoad(
  original: Float32Array,
  size: number,
  squareSize: number,
  nodes: readonly RoadTerrainNode[],
  config: RoadTerrainConfig,
): {
  elevations: Float32Array;
  layerMap: Uint8Array;
  minimumCutFill: number;
  maximumCutFill: number;
  modifiedSampleCount: number;
  asphaltSampleCount: number;
} {
  const sampleCount = size * size;
  const bestDistance = new Float32Array(sampleCount);
  bestDistance.fill(Number.POSITIVE_INFINITY);
  const bestTarget = new Float32Array(sampleCount);
  const roadHalfWidth = config.roadWidth * 0.5;
  const formationHalfWidth = roadHalfWidth + config.shoulderWidth;
  const outerRadius = formationHalfWidth + config.blendWidth;

  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    const b = nodes[(i + 1) % nodes.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared < 1e-8) continue;
    const length = Math.sqrt(lengthSquared);
    const tangentX = dx / length;
    const tangentY = dy / length;
    const normalX = -tangentY;
    const normalY = tangentX;

    const minColumn = clampInt(Math.floor((Math.min(a.x, b.x) - outerRadius) / squareSize), 0, size - 1);
    const maxColumn = clampInt(Math.ceil((Math.max(a.x, b.x) + outerRadius) / squareSize), 0, size - 1);
    const minLocalRow = clampInt(Math.floor((Math.min(a.y, b.y) - outerRadius) / squareSize), 0, size - 1);
    const maxLocalRow = clampInt(Math.ceil((Math.max(a.y, b.y) + outerRadius) / squareSize), 0, size - 1);

    for (let localRow = minLocalRow; localRow <= maxLocalRow; localRow++) {
      const y = localRow * squareSize;
      const rasterRow = size - 1 - localRow;
      for (let column = minColumn; column <= maxColumn; column++) {
        const x = column * squareSize;
        const projection = clamp(((x - a.x) * dx + (y - a.y) * dy) / lengthSquared, 0, 1);
        const qx = a.x + projection * dx;
        const qy = a.y + projection * dy;
        const offsetX = x - qx;
        const offsetY = y - qy;
        const distanceToSegment = Math.hypot(offsetX, offsetY);
        if (distanceToSegment > outerRadius) continue;

        const index = rasterRow * size + column;
        if (distanceToSegment >= bestDistance[index]) continue;

        const signedOffset = offsetX * normalX + offsetY * normalY;
        const centerElevation = lerp(a.z, b.z, projection);
        const bank = lerp(a.bank, b.bank, projection);
        bestDistance[index] = distanceToSegment;
        bestTarget[index] = centerElevation + signedOffset * bank;
      }
    }
  }

  const elevations = new Float32Array(original);
  const layerMap = new Uint8Array(sampleCount);
  let minimumCutFill = Number.POSITIVE_INFINITY;
  let maximumCutFill = Number.NEGATIVE_INFINITY;
  let modifiedSampleCount = 0;
  let asphaltSampleCount = 0;

  for (let index = 0; index < sampleCount; index++) {
    const distanceToRoad = bestDistance[index];
    if (!Number.isFinite(distanceToRoad) || distanceToRoad > outerRadius) continue;

    const blend = distanceToRoad <= formationHalfWidth
      ? 1
      : 1 - smoothstep(formationHalfWidth, outerRadius, distanceToRoad);
    const originalElevation = original[index];
    const targetElevation = bestTarget[index];
    const finalElevation = lerp(originalElevation, targetElevation, blend);
    const cutFill = finalElevation - originalElevation;

    elevations[index] = finalElevation;
    modifiedSampleCount++;
    minimumCutFill = Math.min(minimumCutFill, cutFill);
    maximumCutFill = Math.max(maximumCutFill, cutFill);

    if (distanceToRoad <= roadHalfWidth) {
      layerMap[index] = 1;
      asphaltSampleCount++;
    }
  }

  if (modifiedSampleCount === 0) {
    throw new Error('Road corridor did not modify any terrain samples');
  }

  return {
    elevations,
    layerMap,
    minimumCutFill,
    maximumCutFill,
    modifiedSampleCount,
    asphaltSampleCount,
  };
}

function makeDecalRoadObject(nodes: readonly RoadTerrainNode[]): Record<string, unknown> {
  return {
    name: 'triworld_v4_mountain_loop',
    class: 'DecalRoad',
    __parent: 'MissionGroup',
    material: 'triworld_v4_road_decal',
    textureLength: 8,
    drivability: 1,
    autoLanes: true,
    autoJunction: false,
    oneWay: false,
    useSubdivisions: true,
    overObjects: false,
    renderPriority: 10,
    decalBias: 0.001,
    nodes: nodes.map((node) => [node.x, node.y, node.z + 0.025, node.width]),
  };
}

function makeRoadSpawn(first: RoadTerrainNode, second: RoadTerrainNode): Record<string, unknown> {
  const heading = Math.atan2(second.y - first.y, second.x - first.x);
  const rotation = heading - Math.PI / 2;
  const cosine = round(Math.cos(rotation), 9);
  const sine = round(Math.sin(rotation), 9);
  return {
    name: 'spawns_default',
    class: 'SpawnSphere',
    __parent: 'MissionGroup',
    position: [first.x, first.y, first.z + 1.5],
    rotationMatrix: [cosine, -sine, 0, sine, cosine, 0, 0, 0, 1],
    scale: [1, 1, 1],
    dataBlock: 'SpawnSphereMarker',
    description: 'TriWorld V4 road-aligned mountain circuit spawn',
  };
}

function sampleGridBilinear(
  values: Float32Array,
  size: number,
  squareSize: number,
  xMetres: number,
  yMetres: number,
): number {
  const gridX = clamp(xMetres / squareSize, 0, size - 1);
  const localGridY = clamp(yMetres / squareSize, 0, size - 1);
  const rasterY = (size - 1) - localGridY;
  const x0 = Math.floor(gridX);
  const y0 = Math.floor(rasterY);
  const x1 = Math.min(size - 1, x0 + 1);
  const y1 = Math.min(size - 1, y0 + 1);
  const tx = gridX - x0;
  const ty = rasterY - y0;
  const z00 = values[y0 * size + x0];
  const z10 = values[y0 * size + x1];
  const z01 = values[y1 * size + x0];
  const z11 = values[y1 * size + x1];
  return lerp(lerp(z00, z10, tx), lerp(z01, z11, tx), ty);
}

function quantizeElevations(elevations: Float32Array, heightScale: number): Uint16Array {
  const output = new Uint16Array(elevations.length);
  for (let i = 0; i < elevations.length; i++) {
    output[i] = clampInt(Math.round(elevations[i] / heightScale), 0, 65535);
  }
  return output;
}

function scanDecodedBounds(values: Uint16Array, heightScale: number): { minimum: number; maximum: number } {
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < values.length; i++) {
    const decoded = values[i] * heightScale;
    minimum = Math.min(minimum, decoded);
    maximum = Math.max(maximum, decoded);
  }
  return { minimum, maximum };
}

function calculateMaximumGrade(elevations: Float64Array, segmentLengths: Float64Array): number {
  let maximum = 0;
  for (let i = 0; i < elevations.length; i++) {
    const next = (i + 1) % elevations.length;
    maximum = Math.max(maximum, Math.abs(elevations[next] - elevations[i]) / Math.max(1e-6, segmentLengths[i]));
  }
  return maximum;
}

function distance(a: Point2, b: Point2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function normalize(x: number, y: number): { x: number; y: number } {
  const length = Math.hypot(x, y);
  return length > 1e-9 ? { x: x / length, y: y / length } : { x: 1, y: 0 };
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / Math.max(1e-9, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function clampInt(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function round(value: number, decimalPlaces: number): number {
  const factor = 10 ** decimalPlaces;
  return Math.round(value * factor) / factor;
}
