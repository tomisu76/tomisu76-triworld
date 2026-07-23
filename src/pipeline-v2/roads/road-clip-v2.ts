import type { RoadPointV2 } from './road-stationing-v2';

export function clipRoadWayToBoundsV2(
  points: RoadPointV2[],
  halfExtentMetres: number,
): RoadPointV2[][] {
  if (points.length < 2) return [];

  const resultSegments: RoadPointV2[][] = [];
  let currentSegment: RoadPointV2[] = [];

  const minX = -halfExtentMetres;
  const maxX = halfExtentMetres;
  const minY = -halfExtentMetres;
  const maxY = halfExtentMetres;

  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];

    const clipped = clipSegmentLiangBarsky(p1.x, p1.y, p2.x, p2.y, minX, maxX, minY, maxY);

    if (clipped) {
      const [c1, c2] = clipped;
      if (currentSegment.length === 0) {
        currentSegment.push({ x: c1.x, y: c1.y });
      } else {
        const last = currentSegment[currentSegment.length - 1];
        if (Math.hypot(last.x - c1.x, last.y - c1.y) > 0.05) {
          resultSegments.push(currentSegment);
          currentSegment = [{ x: c1.x, y: c1.y }];
        }
      }
      currentSegment.push({ x: c2.x, y: c2.y });
    } else if (currentSegment.length > 0) {
      resultSegments.push(currentSegment);
      currentSegment = [];
    }
  }

  if (currentSegment.length >= 2) {
    resultSegments.push(currentSegment);
  }

  return resultSegments;
}

function clipSegmentLiangBarsky(
  x0: number, y0: number,
  x1: number, y1: number,
  minX: number, maxX: number,
  minY: number, maxY: number,
): [{ x: number; y: number }, { x: number; y: number }] | null {
  const dx = x1 - x0;
  const dy = y1 - y0;

  let u1 = 0.0;
  let u2 = 1.0;

  const p = [-dx, dx, -dy, dy];
  const q = [x0 - minX, maxX - x0, y0 - minY, maxY - y0];

  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) {
        if (t > u2) return null;
        if (t > u1) u1 = t;
      } else {
        if (t < u1) return null;
        if (t < u2) u2 = t;
      }
    }
  }

  return [
    { x: x0 + u1 * dx, y: y0 + u1 * dy },
    { x: x0 + u2 * dx, y: y0 + u2 * dy },
  ];
}
