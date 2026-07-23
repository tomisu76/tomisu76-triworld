import type { CorridorVertex } from './CorridorVertex';
import type { CorridorQuadV3 } from './validateQuad';

export interface TriangleV3 {
  primitiveId: string;
  quadId: string;
  segmentRank: number;
  primitiveRank: number;
  role: 'formation' | 'slope-side-a' | 'slope-side-b';
  v0: CorridorVertex;
  v1: CorridorVertex;
  v2: CorridorVertex;
  chosenDiagonalKey: string;
}

export function triangulateQuadV3(quad: CorridorQuadV3, primitiveRankStart: number): TriangleV3[] {
  const { v0, v1, v2, v3 } = quad;

  // Vertices: v0 = A, v1 = B, v2 = C, v3 = D
  const dxAC = BigInt(v2.fixedX - v0.fixedX);
  const dyAC = BigInt(v2.fixedY - v0.fixedY);
  const distAC2 = dxAC * dxAC + dyAC * dyAC;

  const dxBD = BigInt(v3.fixedX - v1.fixedX);
  const dyBD = BigInt(v3.fixedY - v1.fixedY);
  const distBD2 = dxBD * dxBD + dyBD * dyBD;

  let splitAC = true;

  if (distAC2 < distBD2) {
    splitAC = true;
  } else if (distBD2 < distAC2) {
    splitAC = false;
  } else {
    // Tie-breaker: compare complete canonical endpoint-ID pairs lexicographically
    const keyAC = canonicalPairKey(v0.stableVertexId, v2.stableVertexId);
    const keyBD = canonicalPairKey(v1.stableVertexId, v3.stableVertexId);
    splitAC = keyAC < keyBD;
  }

  const chosenDiagonalKey = splitAC
    ? canonicalPairKey(v0.stableVertexId, v2.stableVertexId)
    : canonicalPairKey(v1.stableVertexId, v3.stableVertexId);

  if (splitAC) {
    // Split along AC (v0-v2): Triangles (A, B, C) and (A, C, D)
    return [
      {
        primitiveId: `${quad.quadId}-t0`,
        quadId: quad.quadId,
        segmentRank: quad.segmentRank,
        primitiveRank: primitiveRankStart,
        role: quad.role,
        v0: v0,
        v1: v1,
        v2: v2,
        chosenDiagonalKey,
      },
      {
        primitiveId: `${quad.quadId}-t1`,
        quadId: quad.quadId,
        segmentRank: quad.segmentRank,
        primitiveRank: primitiveRankStart + 1,
        role: quad.role,
        v0: v0,
        v1: v2,
        v2: v3,
        chosenDiagonalKey,
      },
    ];
  } else {
    // Split along BD (v1-v3): Triangles (A, B, D) and (B, C, D)
    return [
      {
        primitiveId: `${quad.quadId}-t0`,
        quadId: quad.quadId,
        segmentRank: quad.segmentRank,
        primitiveRank: primitiveRankStart,
        role: quad.role,
        v0: v0,
        v1: v1,
        v2: v3,
        chosenDiagonalKey,
      },
      {
        primitiveId: `${quad.quadId}-t1`,
        quadId: quad.quadId,
        segmentRank: quad.segmentRank,
        primitiveRank: primitiveRankStart + 1,
        role: quad.role,
        v0: v1,
        v1: v2,
        v2: v3,
        chosenDiagonalKey,
      },
    ];
  }
}

function canonicalPairKey(id1: string, id2: string): string {
  return id1 < id2 ? `${id1}<->${id2}` : `${id2}<->${id1}`;
}
