export interface LocalPoint {
  x: number;
  y: number;
}

export interface HorizontalStation {
  station: number; // s = cumulative horizontal distance
  x: number;
  y: number;
  tangentX: number;
  tangentY: number;
  normalX: number;
  normalY: number;
  leftX: number;
  leftY: number;
  rightX: number;
  rightY: number;
}

export function resampleHorizontalCenterline(
  points: LocalPoint[],
  stationSpacing: number = 2.5,
  width: number = 6.0,
  miterLimit: number = 2.0,
): HorizontalStation[] {
  if (points.length < 2) return [];

  // 1. Remove duplicate points (distance < 0.05m)
  const cleanPoints: LocalPoint[] = [];
  for (const p of points) {
    if (
      cleanPoints.length === 0 ||
      Math.hypot(p.x - cleanPoints[cleanPoints.length - 1].x, p.y - cleanPoints[cleanPoints.length - 1].y) >= 0.05
    ) {
      cleanPoints.push(p);
    }
  }

  if (cleanPoints.length < 2) return [];

  // 2. Compute cumulative 2D distances
  const cumDist: number[] = [0];
  for (let i = 1; i < cleanPoints.length; i++) {
    const d = Math.hypot(cleanPoints[i].x - cleanPoints[i - 1].x, cleanPoints[i].y - cleanPoints[i - 1].y);
    cumDist.push(cumDist[i - 1] + d);
  }

  const totalLength = cumDist[cumDist.length - 1];
  if (totalLength < 0.1) return [];

  // 3. Generate regular stationing
  const sampleStations: number[] = [];
  let s = 0;
  while (s < totalLength) {
    sampleStations.push(s);
    s += stationSpacing;
  }
  if (totalLength - sampleStations[sampleStations.length - 1] > 0.5) {
    sampleStations.push(totalLength);
  } else {
    sampleStations[sampleStations.length - 1] = totalLength;
  }

  const resampledCoords: Array<{ s: number; x: number; y: number }> = [];
  let segmentIndex = 0;

  for (const stat of sampleStations) {
    while (segmentIndex < cumDist.length - 2 && cumDist[segmentIndex + 1] < stat) {
      segmentIndex++;
    }

    const s1 = cumDist[segmentIndex];
    const s2 = cumDist[segmentIndex + 1];
    const p1 = cleanPoints[segmentIndex];
    const p2 = cleanPoints[segmentIndex + 1];
    const t = s2 - s1 > 1e-6 ? (stat - s1) / (s2 - s1) : 0;

    const rx = p1.x + t * (p2.x - p1.x);
    const ry = p1.y + t * (p2.y - p1.y);

    if (
      resampledCoords.length === 0 ||
      Math.hypot(rx - resampledCoords[resampledCoords.length - 1].x, ry - resampledCoords[resampledCoords.length - 1].y) >= 0.05
    ) {
      resampledCoords.push({ s: stat, x: rx, y: ry });
    }
  }

  const count = resampledCoords.length;
  if (count < 2) return [];

  const result: HorizontalStation[] = [];
  let prevNormalX = 0;
  let prevNormalY = 0;
  const halfWidth = width / 2;

  for (let i = 0; i < count; i++) {
    const curr = resampledCoords[i];

    // Item 3: Centered tangent
    let dx = 0;
    let dy = 0;
    if (i === 0) {
      const next = resampledCoords[1];
      dx = next.x - curr.x;
      dy = next.y - curr.y;
    } else if (i === count - 1) {
      const prev = resampledCoords[count - 2];
      dx = curr.x - prev.x;
      dy = curr.y - prev.y;
    } else {
      const prev = resampledCoords[i - 1];
      const next = resampledCoords[i + 1];
      dx = next.x - prev.x;
      dy = next.y - prev.y;
    }

    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;

    const tangentX = dx / len;
    const tangentY = dy / len;

    // Item 4: Initial normal + FORCE NORMAL CONTINUITY
    let normalX = -tangentY;
    let normalY = tangentX;

    if (i > 0) {
      const dot = prevNormalX * normalX + prevNormalY * normalY;
      if (dot < 0) {
        normalX = -normalX;
        normalY = -normalY;
      }
    }

    prevNormalX = normalX;
    prevNormalY = normalY;

    // Item 8: Miter join calculation & clamping at sharp bends
    let offsetFactorX = normalX;
    let offsetFactorY = normalY;

    if (i > 0 && i < count - 1) {
      const prev = resampledCoords[i - 1];
      const next = resampledCoords[i + 1];
      const t1x = curr.x - prev.x;
      const t1y = curr.y - prev.y;
      const len1 = Math.hypot(t1x, t1y) || 1;
      const t2x = next.x - curr.x;
      const t2y = next.y - curr.y;
      const len2 = Math.hypot(t2x, t2y) || 1;

      const n1x = -(t1y / len1);
      const n1y = t1x / len1;
      const n2x = -(t2y / len2);
      const n2y = t2x / len2;

      const miterX = (n1x + n2x) / 2;
      const miterY = (n1y + n2y) / 2;
      const miterLen = Math.hypot(miterX, miterY);

      if (miterLen > 1e-3) {
        const dotMiter = normalX * (miterX / miterLen) + normalY * (miterY / miterLen);
        const scale = Math.min(miterLimit, 1.0 / Math.max(0.2, Math.abs(dotMiter)));
        offsetFactorX = (miterX / miterLen) * scale;
        offsetFactorY = (miterY / miterLen) * scale;
      }
    }

    // Item 5: CONSISTENT LEFT AND RIGHT EDGES
    const leftX = curr.x + offsetFactorX * halfWidth;
    const leftY = curr.y + offsetFactorY * halfWidth;
    const rightX = curr.x - offsetFactorX * halfWidth;
    const rightY = curr.y - offsetFactorY * halfWidth;

    result.push({
      station: curr.s,
      x: curr.x,
      y: curr.y,
      tangentX,
      tangentY,
      normalX,
      normalY,
      leftX,
      leftY,
      rightX,
      rightY,
    });
  }

  return result;
}
