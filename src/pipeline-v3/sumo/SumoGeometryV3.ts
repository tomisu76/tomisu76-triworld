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
): SumoPlanStation[] {
  if (shape.length < 2) return [];

  // Filter zero-length consecutive duplicates (< 1e-4 m)
  const clean: Vec2[] = [shape[0]];
  for (let i = 1; i < shape.length; i++) {
    const pt = shape[i];
    const prev = clean[clean.length - 1];
    if (Math.hypot(pt.x - prev.x, pt.y - prev.y) >= 1e-4) {
      clean.push(pt);
    }
  }

  if (clean.length < 2) return [];

  // Compute cumulative 2D distance
  const cumDist: number[] = [0];
  for (let i = 1; i < clean.length; i++) {
    const d = Math.hypot(clean[i].x - clean[i - 1].x, clean[i].y - clean[i - 1].y);
    cumDist.push(cumDist[i - 1] + d);
  }

  const totalLength = cumDist[cumDist.length - 1];
  if (totalLength < 1e-4) return [];

  // Adaptive stationing: 0.5m density on sharp curves, 1.0m on straights
  const rawStationsS: number[] = [0];
  let currentS = 0;

  while (currentS < totalLength - 0.10) {
    const ptBack = samplePolylinePoint(clean, cumDist, Math.max(0, currentS - 1.0));
    const ptCenter = samplePolylinePoint(clean, cumDist, currentS);
    const ptFwd = samplePolylinePoint(clean, cumDist, Math.min(totalLength, currentS + 1.0));

    const v1x = ptCenter.x - ptBack.x;
    const v1y = ptCenter.y - ptBack.y;
    const v2x = ptFwd.x - ptCenter.x;
    const v2y = ptFwd.y - ptCenter.y;

    const len1 = Math.hypot(v1x, v1y);
    const len2 = Math.hypot(v2x, v2y);

    let curvature = 0;
    if (len1 > 1e-3 && len2 > 1e-3) {
      const dot = (v1x * v2x + v1y * v2y) / (len1 * len2);
      const angle = Math.acos(Math.min(1, Math.max(-1, dot)));
      curvature = angle;
    }

    const step = curvature > 0.08 ? 0.5 : defaultStationSpacing;
    currentS += step;
    if (currentS < totalLength - 0.10) {
      rawStationsS.push(currentS);
    }
  }

  if (rawStationsS[rawStationsS.length - 1] !== totalLength) {
    rawStationsS.push(totalLength);
  }

  const stations: SumoPlanStation[] = [];

  for (const sTarget of rawStationsS) {
    const clampedS = Math.min(totalLength, Math.max(0, sTarget));
    const pt = samplePolylinePoint(clean, cumDist, clampedS);

    // Compute smooth tangent using continuous central difference +/- 0.35m
    const deltaS = 0.35;
    const sBack = Math.max(0, clampedS - deltaS);
    const sFwd = Math.min(totalLength, clampedS + deltaS);

    const ptBack = samplePolylinePoint(clean, cumDist, sBack);
    const ptFwd = samplePolylinePoint(clean, cumDist, sFwd);

    let dx = ptFwd.x - ptBack.x;
    let dy = ptFwd.y - ptBack.y;
    let len = Math.hypot(dx, dy);

    if (len < 1e-6) {
      dx = 1;
      dy = 0;
      len = 1;
    }

    const tangentX = dx / len;
    const tangentY = dy / len;
    const normalX = -tangentY;
    const normalY = tangentX;

    stations.push({
      station: clampedS,
      x: pt.x,
      y: pt.y,
      tangentX,
      tangentY,
      normalX,
      normalY,
    });
  }

  return stations;
}

function samplePolylinePoint(clean: Vec2[], cumDist: number[], s: number): Vec2 {
  const totalLength = cumDist[cumDist.length - 1];
  const targetS = Math.min(totalLength, Math.max(0, s));

  let segmentIdx = 0;
  while (segmentIdx < clean.length - 2 && cumDist[segmentIdx + 1] < targetS) {
    segmentIdx++;
  }

  const s0 = cumDist[segmentIdx];
  const s1 = cumDist[segmentIdx + 1];
  const p0 = clean[segmentIdx];
  const p1 = clean[segmentIdx + 1];

  const segLen = s1 - s0;
  const t = segLen < 1e-6 ? 0 : (targetS - s0) / segLen;

  return {
    x: p0.x + t * (p1.x - p0.x),
    y: p0.y + t * (p1.y - p0.y),
  };
}
