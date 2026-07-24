export interface Vec2 {
  x: number;
  y: number;
}

export interface SumoLaneGeometry {
  edgeId: string;
  laneId: string;
  laneIndex: number;
  width: number;
  speed: number;
  function: 'normal' | 'internal';
  shape: readonly Vec2[];
}

export interface SumoPlanStation {
  station: number;
  x: number;
  y: number;
  tangentX: number;
  tangentY: number;
  normalX: number;
  normalY: number;
}

export interface DesignedSumoStation extends SumoPlanStation {
  groundZ: number;
  designZ: number;
  formationZ: number;
  surfaceZ: number;
}

export interface CanonicalSumoShapeResult {
  lane: SumoLaneGeometry;
  canonicalShape: Vec2[];
  wasReversed: boolean;
}

export function canonicalizeSumoDirection(lane: SumoLaneGeometry): CanonicalSumoShapeResult {
  const shape = [...lane.shape];
  if (shape.length < 2) {
    return { lane, canonicalShape: shape, wasReversed: false };
  }

  const first = shape[0];
  const last = shape[shape.length - 1];

  const firstKey = `${Math.round(first.x * 1000)}:${Math.round(first.y * 1000)}`;
  const lastKey = `${Math.round(last.x * 1000)}:${Math.round(last.y * 1000)}`;

  let wasReversed = false;
  let canonicalShape = shape;

  if (lastKey < firstKey) {
    canonicalShape = [...shape].reverse();
    wasReversed = true;
  }

  return {
    lane,
    canonicalShape,
    wasReversed,
  };
}

export function resampleSumoShapeGlobal(
  shape: readonly Vec2[],
  defaultStationSpacing: number = 1.0,
  tangentSmoothingHalfWindowMetres: number = 0.35,
): SumoPlanStation[] {
  if (shape.length < 2) return [];
  if (!Number.isFinite(defaultStationSpacing) || defaultStationSpacing <= 0) {
    throw new RangeError(
      `defaultStationSpacing must be finite and > 0, received ${defaultStationSpacing}.`,
    );
  }
  if (!Number.isFinite(tangentSmoothingHalfWindowMetres) || tangentSmoothingHalfWindowMetres <= 0) {
    throw new RangeError(
      `tangentSmoothingHalfWindowMetres must be finite and > 0, ` +
      `received ${tangentSmoothingHalfWindowMetres}.`,
    );
  }

  const clean = removeConsecutiveDuplicates(shape);
  if (clean.length < 2) return [];

  const sourceCumDist = cumulativeDistances(clean);
  const sourceLength = sourceCumDist[sourceCumDist.length - 1];
  if (sourceLength < 1e-4) return [];

  // Gate 3 remains source-faithful. Gate 4 receives a bounded corner-cut plan
  // curve. Chaikin subdivision cannot overshoot the convex hull of the SUMO
  // chain, unlike an unconstrained spline, and preserves both endpoints.
  const smoothingIterations = tangentSmoothingHalfWindowMetres > 0.5
    ? Math.max(1, Math.min(3, Math.round(tangentSmoothingHalfWindowMetres / 2.5)))
    : 0;
  const planCurve = smoothingIterations > 0
    ? chaikinOpenPolyline(clean, smoothingIterations)
    : clean;
  const planCumDist = cumulativeDistances(planCurve);
  const planLength = planCumDist[planCumDist.length - 1];
  if (planLength < 1e-4) return [];

  // Keep authoritative SUMO station values and deterministic station count.
  const rawStationsS: number[] = [0];
  let currentS = 0;
  while (currentS < sourceLength - 0.10) {
    const ptBack = samplePolylinePoint(clean, sourceCumDist, Math.max(0, currentS - 1.0));
    const ptCenter = samplePolylinePoint(clean, sourceCumDist, currentS);
    const ptFwd = samplePolylinePoint(clean, sourceCumDist, Math.min(sourceLength, currentS + 1.0));

    const v1x = ptCenter.x - ptBack.x;
    const v1y = ptCenter.y - ptBack.y;
    const v2x = ptFwd.x - ptCenter.x;
    const v2y = ptFwd.y - ptCenter.y;
    const len1 = Math.hypot(v1x, v1y);
    const len2 = Math.hypot(v2x, v2y);

    let curvature = 0;
    if (len1 > 1e-3 && len2 > 1e-3) {
      const dot = (v1x * v2x + v1y * v2y) / (len1 * len2);
      curvature = Math.acos(Math.min(1, Math.max(-1, dot)));
    }

    currentS += curvature > 0.08 ? 0.5 : defaultStationSpacing;
    if (currentS < sourceLength - 0.10) rawStationsS.push(currentS);
  }
  if (rawStationsS[rawStationsS.length - 1] !== sourceLength) {
    rawStationsS.push(sourceLength);
  }

  const stations: SumoPlanStation[] = [];
  let previousTangent: Vec2 | undefined;

  for (const sourceS of rawStationsS) {
    const sourceFraction = sourceLength <= 0 ? 0 : sourceS / sourceLength;
    const planS = sourceFraction * planLength;
    const point = samplePolylinePoint(planCurve, planCumDist, planS);

    const derivativeWindow = Math.max(
      0.25,
      Math.min(defaultStationSpacing * 1.5, tangentSmoothingHalfWindowMetres, 2.0),
    );
    const backS = Math.max(0, planS - derivativeWindow);
    const forwardS = Math.min(planLength, planS + derivativeWindow);
    const back = samplePolylinePoint(planCurve, planCumDist, backS);
    const forward = samplePolylinePoint(planCurve, planCumDist, forwardS);

    let dx = forward.x - back.x;
    let dy = forward.y - back.y;
    let length = Math.hypot(dx, dy);
    if (length < 1e-6) {
      dx = 1;
      dy = 0;
      length = 1;
    }

    let tangentX = dx / length;
    let tangentY = dy / length;

    // Defensive continuity guard. A valid ordered road chain must never flip its
    // frame by 180 degrees between neighbouring stations.
    if (previousTangent && tangentX * previousTangent.x + tangentY * previousTangent.y < 0) {
      tangentX = -tangentX;
      tangentY = -tangentY;
    }
    previousTangent = { x: tangentX, y: tangentY };

    stations.push({
      station: sourceS,
      x: point.x,
      y: point.y,
      tangentX,
      tangentY,
      normalX: -tangentY,
      normalY: tangentX,
    });
  }

  return stations;
}

function chaikinOpenPolyline(points: readonly Vec2[], iterations: number): Vec2[] {
  let result = points.map((point) => ({ x: point.x, y: point.y }));
  for (let iteration = 0; iteration < iterations; iteration++) {
    if (result.length < 3) break;
    const next: Vec2[] = [{ ...result[0] }];
    for (let index = 0; index < result.length - 1; index++) {
      const a = result[index];
      const b = result[index + 1];
      next.push(
        { x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y },
        { x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y },
      );
    }
    next.push({ ...result[result.length - 1] });
    result = removeConsecutiveDuplicates(next);
  }
  return result;
}

function removeConsecutiveDuplicates(points: readonly Vec2[]): Vec2[] {
  const clean: Vec2[] = [];
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new Error(`SUMO shape contains a non-finite point (${point.x}, ${point.y}).`);
    }
    const previous = clean[clean.length - 1];
    if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) >= 1e-4) {
      clean.push({ x: point.x, y: point.y });
    }
  }
  return clean;
}

function cumulativeDistances(points: readonly Vec2[]): number[] {
  const distances: number[] = [0];
  for (let index = 1; index < points.length; index++) {
    distances.push(
      distances[index - 1] + Math.hypot(
        points[index].x - points[index - 1].x,
        points[index].y - points[index - 1].y,
      ),
    );
  }
  return distances;
}

function samplePolylinePoint(points: readonly Vec2[], cumulative: readonly number[], s: number): Vec2 {
  const totalLength = cumulative[cumulative.length - 1];
  const targetS = Math.min(totalLength, Math.max(0, s));

  let segmentIndex = 0;
  while (segmentIndex < points.length - 2 && cumulative[segmentIndex + 1] < targetS) {
    segmentIndex++;
  }

  const s0 = cumulative[segmentIndex];
  const s1 = cumulative[segmentIndex + 1];
  const p0 = points[segmentIndex];
  const p1 = points[segmentIndex + 1];
  const segmentLength = s1 - s0;
  const t = segmentLength < 1e-6 ? 0 : (targetS - s0) / segmentLength;

  return {
    x: p0.x + t * (p1.x - p0.x),
    y: p0.y + t * (p1.y - p0.y),
  };
}
