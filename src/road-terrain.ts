export interface RoadPoint {
  x: number;
  y: number;
}

export interface RoadDesign {
  widthMetres: number;
  stationSpacingMetres: number;
  maximumGrade: number;
  maximumBank: number;
  designSpeedMetresPerSecond: number;
  shoulderWidthMetres: number;
  minimumBlendWidthMetres: number;
  maximumBlendWidthMetres: number;
  surfaceRaiseMetres: number;
  surfaceClearanceMetres: number;
  terrainConform: boolean;
}

export interface RoadStation extends RoadPoint {
  distanceMetres: number;
  z: number;
  tangentX: number;
  tangentY: number;
  normalX: number;
  normalY: number;
  bank: number;
}

export interface PreparedRoadCorridor {
  id: string;
  design: RoadDesign;
  stations: RoadStation[];
  lengthMetres: number;
  maximumGrade: number;
  maximumBank: number;
}

export interface TerrainConformanceSample {
  elevation: number;
  influence: number;
  cutMetres: number;
  fillMetres: number;
  roadId?: string;
}

export interface RoadMeshAppendResult {
  segments: number;
  lengthMetres: number;
}

const GRAVITY_METRES_PER_SECOND_SQUARED = 9.80665;
const INDEX_CELL_SIZE_METRES = 48;

const DEFAULT_DESIGN: RoadDesign = {
  widthMetres: 6,
  stationSpacingMetres: 5,
  maximumGrade: 0.16,
  maximumBank: 0.04,
  designSpeedMetresPerSecond: 13.9,
  shoulderWidthMetres: 1.5,
  minimumBlendWidthMetres: 8,
  maximumBlendWidthMetres: 36,
  surfaceRaiseMetres: 0.12,
  surfaceClearanceMetres: 0.18,
  terrainConform: true,
};

type IndexedSegment = {
  road: PreparedRoadCorridor;
  a: RoadStation;
  b: RoadStation;
  segmentIndex: number;
};

type SurfaceCandidate = {
  roadId: string;
  targetElevation: number;
  influence: number;
  distanceFromCentre: number;
};

/**
 * Converts an XY polyline into a road-first 3D alignment. The alignment is
 * densified, sampled from the DEM, vertically smoothed, grade-limited and then
 * assigned a bounded curve bank. The resulting stations are the single source
 * of truth for both the road mesh and terrain earthworks.
 */
export function prepareRoadCorridor(
  id: string,
  sourcePoints: readonly RoadPoint[],
  sampleBaseElevation: (x: number, y: number) => number,
  requestedDesign: Partial<RoadDesign> & Pick<RoadDesign, 'widthMetres'>,
): PreparedRoadCorridor {
  const design = normaliseDesign(requestedDesign);
  const points = deduplicatePoints(sourcePoints);
  if (points.length < 2) throw new Error(`Road ${id} requires at least two distinct points`);

  const densePoints = densifyPolyline(points, design.stationSpacingMetres);
  const distances = cumulativeDistances(densePoints);
  const rawElevations = densePoints.map((point) => (
    sampleBaseElevation(point.x, point.y) + design.surfaceRaiseMetres
  ));
  const elevations = smoothAndLimitProfile(rawElevations, distances, design.maximumGrade);
  const frames = buildFrames(densePoints);
  const banks = buildBanks(frames, distances, design);

  const stations: RoadStation[] = densePoints.map((point, index) => ({
    ...point,
    distanceMetres: distances[index],
    z: elevations[index],
    tangentX: frames[index].tangentX,
    tangentY: frames[index].tangentY,
    normalX: frames[index].normalX,
    normalY: frames[index].normalY,
    bank: banks[index],
  }));

  return {
    id,
    design,
    stations,
    lengthMetres: distances[distances.length - 1],
    maximumGrade: calculateMaximumGrade(stations),
    maximumBank: stations.reduce((maximum, station) => Math.max(maximum, Math.abs(station.bank)), 0),
  };
}

/** Adds the prepared road ribbon to a canonical positions/indices pair. */
export function appendPreparedRoadMesh(
  positions: number[],
  indices: number[],
  road: PreparedRoadCorridor,
): RoadMeshAppendResult {
  const startVertex = positions.length / 3;
  const halfWidth = road.design.widthMetres / 2;

  for (const station of road.stations) {
    const leftOffset = halfWidth;
    const rightOffset = -halfWidth;
    positions.push(
      station.x + station.normalX * leftOffset,
      station.y + station.normalY * leftOffset,
      station.z + leftOffset * station.bank,
      station.x + station.normalX * rightOffset,
      station.y + station.normalY * rightOffset,
      station.z + rightOffset * station.bank,
    );
  }

  let segments = 0;
  for (let index = 0; index < road.stations.length - 1; index++) {
    const left = startVertex + index * 2;
    const right = left + 1;
    const nextLeft = left + 2;
    const nextRight = left + 3;
    if (distance(road.stations[index], road.stations[index + 1]) < 0.05) continue;
    indices.push(left, right, nextRight, left, nextRight, nextLeft);
    segments += 1;
  }

  return { segments, lengthMetres: road.lengthMetres };
}

/**
 * Spatially indexes prepared road segments and reshapes DEM samples into a
 * road bed with shoulders plus a dynamic cut/fill transition. This avoids both
 * roads buried in terrain and unsupported road ribbons floating above it.
 */
export class RoadTerrainIndex {
  private readonly segments: IndexedSegment[] = [];
  private readonly cells = new Map<string, number[]>();

  constructor(roads: readonly PreparedRoadCorridor[]) {
    for (const road of roads) {
      if (!road.design.terrainConform) continue;
      const searchRadius = road.design.widthMetres / 2
        + road.design.shoulderWidthMetres
        + road.design.maximumBlendWidthMetres;

      for (let index = 0; index < road.stations.length - 1; index++) {
        const a = road.stations[index];
        const b = road.stations[index + 1];
        const segmentIndex = this.segments.length;
        this.segments.push({ road, a, b, segmentIndex: index });

        const minimumCellX = cellCoordinate(Math.min(a.x, b.x) - searchRadius);
        const maximumCellX = cellCoordinate(Math.max(a.x, b.x) + searchRadius);
        const minimumCellY = cellCoordinate(Math.min(a.y, b.y) - searchRadius);
        const maximumCellY = cellCoordinate(Math.max(a.y, b.y) + searchRadius);

        for (let cellY = minimumCellY; cellY <= maximumCellY; cellY++) {
          for (let cellX = minimumCellX; cellX <= maximumCellX; cellX++) {
            const key = cellKey(cellX, cellY);
            const bucket = this.cells.get(key);
            if (bucket) bucket.push(segmentIndex);
            else this.cells.set(key, [segmentIndex]);
          }
        }
      }
    }
  }

  sample(baseElevation: number, x: number, y: number): TerrainConformanceSample {
    const bucket = this.cells.get(cellKey(cellCoordinate(x), cellCoordinate(y)));
    if (!bucket || bucket.length === 0) {
      return { elevation: baseElevation, influence: 0, cutMetres: 0, fillMetres: 0 };
    }

    const candidates: SurfaceCandidate[] = [];
    let strongestInfluence = 0;
    let strongestRoadId: string | undefined;

    for (const index of bucket) {
      const segment = this.segments[index];
      const candidate = sampleSegment(segment, baseElevation, x, y);
      if (!candidate || candidate.influence <= 0) continue;
      candidates.push(candidate);
      if (candidate.influence > strongestInfluence) {
        strongestInfluence = candidate.influence;
        strongestRoadId = candidate.roadId;
      }
    }

    if (candidates.length === 0) {
      return { elevation: baseElevation, influence: 0, cutMetres: 0, fillMetres: 0 };
    }

    let weightedTarget = 0;
    let totalWeight = 0;
    for (const candidate of candidates) {
      const centreBias = 1 / (1 + candidate.distanceFromCentre * 0.03);
      const weight = Math.max(1e-6, candidate.influence ** 3 * centreBias);
      weightedTarget += candidate.targetElevation * weight;
      totalWeight += weight;
    }

    const targetElevation = weightedTarget / totalWeight;
    const elevation = mix(baseElevation, targetElevation, strongestInfluence);
    return {
      elevation,
      influence: strongestInfluence,
      cutMetres: Math.max(0, baseElevation - elevation),
      fillMetres: Math.max(0, elevation - baseElevation),
      roadId: strongestRoadId,
    };
  }
}

export function roadHeadingDegrees(road: PreparedRoadCorridor): number {
  const first = road.stations[0];
  const next = road.stations[Math.min(1, road.stations.length - 1)];
  const heading = Math.atan2(next.x - first.x, next.y - first.y) * 180 / Math.PI;
  return (heading + 360) % 360;
}

function sampleSegment(
  segment: IndexedSegment,
  baseElevation: number,
  x: number,
  y: number,
): SurfaceCandidate | null {
  const dx = segment.b.x - segment.a.x;
  const dy = segment.b.y - segment.a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-8) return null;

  const t = clamp(((x - segment.a.x) * dx + (y - segment.a.y) * dy) / lengthSquared, 0, 1);
  const nearestX = segment.a.x + dx * t;
  const nearestY = segment.a.y + dy * t;
  const segmentLength = Math.sqrt(lengthSquared);
  const normalX = -dy / segmentLength;
  const normalY = dx / segmentLength;
  const signedLateral = (x - nearestX) * normalX + (y - nearestY) * normalY;
  const distanceFromCentre = Math.abs(signedLateral);
  const centreElevation = mix(segment.a.z, segment.b.z, t);
  const bank = mix(segment.a.bank, segment.b.bank, t);
  const surfaceElevation = centreElevation + signedLateral * bank;
  const targetElevation = surfaceElevation - segment.road.design.surfaceClearanceMetres;
  const innerRadius = segment.road.design.widthMetres / 2 + segment.road.design.shoulderWidthMetres;
  const verticalDifference = Math.abs(baseElevation - targetElevation);
  const dynamicBlendWidth = clamp(
    segment.road.design.minimumBlendWidthMetres + verticalDifference * 1.8,
    segment.road.design.minimumBlendWidthMetres,
    segment.road.design.maximumBlendWidthMetres,
  );
  const outerRadius = innerRadius + dynamicBlendWidth;
  if (distanceFromCentre > outerRadius) return null;

  const influence = distanceFromCentre <= innerRadius
    ? 1
    : smoothstep(1 - (distanceFromCentre - innerRadius) / dynamicBlendWidth);

  return {
    roadId: segment.road.id,
    targetElevation,
    influence,
    distanceFromCentre,
  };
}

function normaliseDesign(requested: Partial<RoadDesign> & Pick<RoadDesign, 'widthMetres'>): RoadDesign {
  const design: RoadDesign = { ...DEFAULT_DESIGN, ...requested };
  if (!Number.isFinite(design.widthMetres) || design.widthMetres < 2 || design.widthMetres > 40) {
    throw new Error(`Invalid road width: ${design.widthMetres}`);
  }
  design.stationSpacingMetres = clamp(design.stationSpacingMetres, 1.5, 12);
  design.maximumGrade = clamp(design.maximumGrade, 0.02, 0.35);
  design.maximumBank = clamp(design.maximumBank, 0, 0.08);
  design.designSpeedMetresPerSecond = clamp(design.designSpeedMetresPerSecond, 5, 45);
  design.shoulderWidthMetres = clamp(design.shoulderWidthMetres, 0, 8);
  design.minimumBlendWidthMetres = clamp(design.minimumBlendWidthMetres, 3, 40);
  design.maximumBlendWidthMetres = clamp(
    design.maximumBlendWidthMetres,
    design.minimumBlendWidthMetres,
    80,
  );
  design.surfaceRaiseMetres = clamp(design.surfaceRaiseMetres, 0, 1);
  design.surfaceClearanceMetres = clamp(design.surfaceClearanceMetres, 0.05, 1);
  return design;
}

function densifyPolyline(points: readonly RoadPoint[], spacing: number): RoadPoint[] {
  const result: RoadPoint[] = [{ ...points[0] }];
  for (let index = 0; index < points.length - 1; index++) {
    const a = points[index];
    const b = points[index + 1];
    const segmentLength = distance(a, b);
    if (segmentLength < 0.02) continue;
    const divisions = Math.max(1, Math.ceil(segmentLength / spacing));
    for (let division = 1; division <= divisions; division++) {
      const t = division / divisions;
      result.push({ x: mix(a.x, b.x, t), y: mix(a.y, b.y, t) });
    }
  }
  return result;
}

function cumulativeDistances(points: readonly RoadPoint[]): number[] {
  const distances = [0];
  for (let index = 1; index < points.length; index++) {
    distances.push(distances[index - 1] + distance(points[index - 1], points[index]));
  }
  return distances;
}

function smoothAndLimitProfile(raw: readonly number[], distances: readonly number[], maximumGrade: number): number[] {
  let values = [...raw];
  for (let pass = 0; pass < 4; pass++) {
    const next = [...values];
    for (let index = 1; index < values.length - 1; index++) {
      next[index] = values[index - 1] * 0.25 + values[index] * 0.5 + values[index + 1] * 0.25;
    }
    values = next;
  }

  for (let pass = 0; pass < 5; pass++) {
    for (let index = 1; index < values.length; index++) {
      const run = Math.max(0.01, distances[index] - distances[index - 1]);
      const delta = maximumGrade * run;
      values[index] = clamp(values[index], values[index - 1] - delta, values[index - 1] + delta);
    }
    for (let index = values.length - 2; index >= 0; index--) {
      const run = Math.max(0.01, distances[index + 1] - distances[index]);
      const delta = maximumGrade * run;
      values[index] = clamp(values[index], values[index + 1] - delta, values[index + 1] + delta);
    }
  }
  return values;
}

function buildFrames(points: readonly RoadPoint[]): Array<Pick<RoadStation, 'tangentX' | 'tangentY' | 'normalX' | 'normalY'>> {
  return points.map((_, index) => {
    const previous = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    const length = Math.hypot(dx, dy) || 1;
    const tangentX = dx / length;
    const tangentY = dy / length;
    return { tangentX, tangentY, normalX: -tangentY, normalY: tangentX };
  });
}

function buildBanks(
  frames: readonly Array<Pick<RoadStation, 'tangentX' | 'tangentY'>>,
  distances: readonly number[],
  design: RoadDesign,
): number[] {
  const banks = new Array<number>(frames.length).fill(0);
  for (let index = 1; index < frames.length - 1; index++) {
    const previous = frames[index - 1];
    const next = frames[index + 1];
    const cross = previous.tangentX * next.tangentY - previous.tangentY * next.tangentX;
    const dot = clamp(previous.tangentX * next.tangentX + previous.tangentY * next.tangentY, -1, 1);
    const signedAngle = Math.atan2(cross, dot);
    const arcLength = Math.max(0.1, distances[index + 1] - distances[index - 1]);
    const curvature = signedAngle / arcLength;
    const equilibriumBank = curvature * design.designSpeedMetresPerSecond ** 2
      / GRAVITY_METRES_PER_SECOND_SQUARED;
    banks[index] = clamp(equilibriumBank * 0.65, -design.maximumBank, design.maximumBank);
  }

  let values = banks;
  for (let pass = 0; pass < 3; pass++) {
    const next = [...values];
    for (let index = 1; index < values.length - 1; index++) {
      next[index] = clamp(
        values[index - 1] * 0.2 + values[index] * 0.6 + values[index + 1] * 0.2,
        -design.maximumBank,
        design.maximumBank,
      );
    }
    values = next;
  }
  values[0] = 0;
  values[values.length - 1] = 0;
  return values;
}

function calculateMaximumGrade(stations: readonly RoadStation[]): number {
  let maximum = 0;
  for (let index = 1; index < stations.length; index++) {
    const run = Math.max(0.01, stations[index].distanceMetres - stations[index - 1].distanceMetres);
    maximum = Math.max(maximum, Math.abs(stations[index].z - stations[index - 1].z) / run);
  }
  return maximum;
}

function deduplicatePoints(points: readonly RoadPoint[]): RoadPoint[] {
  const result: RoadPoint[] = [];
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    if (result.length === 0 || distance(result[result.length - 1], point) >= 0.02) {
      result.push({ x: point.x, y: point.y });
    }
  }
  return result;
}

function cellCoordinate(value: number): number {
  return Math.floor(value / INDEX_CELL_SIZE_METRES);
}

function cellKey(x: number, y: number): string {
  return `${x}:${y}`;
}

function distance(a: RoadPoint, b: RoadPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function smoothstep(value: number): number {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
