import type { CorridorQuadV3 } from '../corridor/validateQuad';

/**
 * Authoritative Shared Formation Elevation Function.
 * Returns the exact formation bed elevation at any 2D coordinate (x, y) inside a corridor quad.
 */
export function formationZAtRoadXY(
  quad: CorridorQuadV3,
  x: number,
  y: number,
): number {
  const v0 = quad.v0;
  const v1 = quad.v1;
  const v2 = quad.v2;
  const v3 = quad.v3;

  // Barycentric interpolation over quadrilateral (v0, v1, v2) and (v0, v2, v3)
  const p = { x: BigInt(Math.round(x * 1000)), y: BigInt(Math.round(y * 1000)) };

  const p0 = { x: BigInt(v0.fixedX), y: BigInt(v0.fixedY) };
  const p1 = { x: BigInt(v1.fixedX), y: BigInt(v1.fixedY) };
  const p2 = { x: BigInt(v2.fixedX), y: BigInt(v2.fixedY) };
  const p3 = { x: BigInt(v3.fixedX), y: BigInt(v3.fixedY) };

  // Triangle 0: (v0, v1, v2)
  const area012 = crossFixed(p0, p1, p2);
  if (area012 > 0n) {
    const w0 = crossFixed(p1, p2, p);
    const w1 = crossFixed(p2, p0, p);
    const w2 = crossFixed(p0, p1, p);
    if (w0 >= 0n && w1 >= 0n && w2 >= 0n) {
      const l0 = Number(w0) / Number(area012);
      const l1 = Number(w1) / Number(area012);
      const l2 = Number(w2) / Number(area012);
      return l0 * v0.z + l1 * v1.z + l2 * v2.z;
    }
  }

  // Triangle 1: (v0, v2, v3)
  const area023 = crossFixed(p0, p2, p3);
  if (area023 > 0n) {
    const w0 = crossFixed(p2, p3, p);
    const w2 = crossFixed(p3, p0, p);
    const w3 = crossFixed(p0, p2, p);
    if (w0 >= 0n && w2 >= 0n && w3 >= 0n) {
      const l0 = Number(w0) / Number(area023);
      const l2 = Number(w2) / Number(area023);
      const l3 = Number(w3) / Number(area023);
      return l0 * v0.z + l2 * v2.z + l3 * v3.z;
    }
  }

  // Fallback: Inverse Distance Weighting to 4 quad vertices
  const d0 = Math.hypot(x - v0.x, y - v0.y);
  const d1 = Math.hypot(x - v1.x, y - v1.y);
  const d2 = Math.hypot(x - v2.x, y - v2.y);
  const d3 = Math.hypot(x - v3.x, y - v3.y);

  if (d0 < 1e-4) return v0.z;
  if (d1 < 1e-4) return v1.z;
  if (d2 < 1e-4) return v2.z;
  if (d3 < 1e-4) return v3.z;

  const w0 = 1 / d0;
  const w1 = 1 / d1;
  const w2 = 1 / d2;
  const w3 = 1 / d3;

  return (w0 * v0.z + w1 * v1.z + w2 * v2.z + w3 * v3.z) / (w0 + w1 + w2 + w3);
}

export function roadSurfaceZAtXY(
  quad: CorridorQuadV3,
  x: number,
  y: number,
  pavementStructureDepth: number = 0.30,
): number {
  return formationZAtRoadXY(quad, x, y) + pavementStructureDepth;
}

function crossFixed(a: { x: bigint; y: bigint }, b: { x: bigint; y: bigint }, c: { x: bigint; y: bigint }): bigint {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}
