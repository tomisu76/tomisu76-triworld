import type { CorridorVertex } from './CorridorVertex';
import { fixedPointKey } from './CorridorVertex';

export interface CorridorQuadV3 {
  quadId: string;
  segmentRank: number;
  role: 'formation' | 'slope-side-a' | 'slope-side-b';
  v0: CorridorVertex;
  v1: CorridorVertex;
  v2: CorridorVertex;
  v3: CorridorVertex;
}

export function validateQuadV3(quad: CorridorQuadV3): void {
  const { v0, v1, v2, v3 } = quad;

  // 1. Four unique stable vertex IDs
  const idSet = new Set([v0.stableVertexId, v1.stableVertexId, v2.stableVertexId, v3.stableVertexId]);
  if (idSet.size !== 4) {
    throw new Error(`Quad ${quad.quadId} has duplicate stable vertex IDs: ${[...idSet].join(', ')}`);
  }

  // 2. Four unique fixed-point XY coordinates
  const keySet = new Set([fixedPointKey(v0), fixedPointKey(v1), fixedPointKey(v2), fixedPointKey(v3)]);
  if (keySet.size !== 4) {
    throw new Error(`Quad ${quad.quadId} has duplicate fixed-point coordinates`);
  }

  // 3. Finite XYZ
  for (const v of [v0, v1, v2, v3]) {
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) {
      throw new Error(`Quad ${quad.quadId} contains non-finite vertex coordinates`);
    }
  }

  // 4. Fixed-point area check (must be strictly positive CCW)
  const areaFixed = computeFixedPolygonArea([v0, v1, v2, v3]);
  if (areaFixed <= 0) {
    throw new Error(`Quad ${quad.quadId} is not strictly positive CCW (areaFixed = ${areaFixed})`);
  }

  // 5. Quad simplicity & non-self-intersection: Diagonals AC (v0-v2) and BD (v1-v3) MUST intersect internally
  if (!doFixedDiagonalsIntersectInternally(v0, v1, v2, v3)) {
    throw new Error(`Quad ${quad.quadId} has a bow-tie self-intersection or non-intersecting diagonals`);
  }
}

export function computeFixedPolygonArea(vertices: readonly CorridorVertex[]): number {
  let sum = 0;
  const n = vertices.length;
  for (let i = 0; i < n; i++) {
    const current = vertices[i];
    const next = vertices[(i + 1) % n];
    sum += (next.fixedX - current.fixedX) * (next.fixedY + current.fixedY);
  }
  return -sum / 2; // Positive for CCW
}

export function doFixedDiagonalsIntersectInternally(
  v0: CorridorVertex,
  v1: CorridorVertex,
  v2: CorridorVertex,
  v3: CorridorVertex,
): boolean {
  // Test if v1 and v3 lie on opposite sides of diagonal v0-v2
  const cross02_1 = crossFixed(v0, v2, v1);
  const cross02_3 = crossFixed(v0, v2, v3);

  const opp13 = (cross02_1 > 0n && cross02_3 < 0n) || (cross02_1 < 0n && cross02_3 > 0n);
  if (!opp13) return false;

  // Test if v0 and v2 lie on opposite sides of diagonal v1-v3
  const cross13_0 = crossFixed(v1, v3, v0);
  const cross13_2 = crossFixed(v1, v3, v2);

  const opp02 = (cross13_0 > 0n && cross13_2 < 0n) || (cross13_0 < 0n && cross13_2 > 0n);
  return opp02;
}

function crossFixed(a: CorridorVertex, b: CorridorVertex, p: CorridorVertex): bigint {
  const dx1 = BigInt(b.fixedX - a.fixedX);
  const dy1 = BigInt(b.fixedY - a.fixedY);
  const dx2 = BigInt(p.fixedX - a.fixedX);
  const dy2 = BigInt(p.fixedY - a.fixedY);
  return dx1 * dy2 - dy1 * dx2;
}
