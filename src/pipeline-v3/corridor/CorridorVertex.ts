export interface CorridorVertex {
  x: number;
  y: number;
  z: number;
  fixedX: number;
  fixedY: number;
  stableVertexId: string;
  semanticRole: string;
}

export const FIXED_SCALE = 1000; // Millimetre quantization

export function createCorridorVertex(
  x: number,
  y: number,
  z: number,
  stableVertexId: string,
  semanticRole: string,
): CorridorVertex {
  const fixedX = normalizeNegativeZero(Math.round(x * FIXED_SCALE));
  const fixedY = normalizeNegativeZero(Math.round(y * FIXED_SCALE));

  if (!Number.isSafeInteger(fixedX) || !Number.isSafeInteger(fixedY)) {
    throw new Error(`CorridorVertex fixed coordinate overflow: (${fixedX}, ${fixedY})`);
  }

  return {
    x,
    y,
    z,
    fixedX,
    fixedY,
    stableVertexId,
    semanticRole,
  };
}

function normalizeNegativeZero(val: number): number {
  return Object.is(val, -0) ? 0 : val;
}

export function fixedPointKey(v: { fixedX: number; fixedY: number }): string {
  return `${v.fixedX}:${v.fixedY}`;
}
