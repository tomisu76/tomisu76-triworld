import type { TerrainGridV3 } from '../terrain/TerrainGridV3';
import type { TriangleV3 } from '../corridor/triangulateQuad';
import {
  createRasterizationBuffersV3,
  PRIORITY_GROUND_ROAD_SURFACE,
  PRIORITY_NONE,
  rasterizeTriangleAtomicV3,
  SENTINEL_UINT32,
  type RasterizationBuffersV3,
} from './fixedPointRasterizer';

export interface TransactionResultV3 {
  status: 'success' | 'failed';
  buffers?: RasterizationBuffersV3;
  nextWorkingElevations?: Float32Array;
  error?: string;
}

export function executeCorridorTransactionV3(
  triangles: readonly TriangleV3[],
  grid: TerrainGridV3,
): TransactionResultV3 {
  const N = grid.N;
  const count = N * N;

  // 1. Sort candidate primitives canonically by priority rank (GROUND_ROAD_SURFACE = 3 > SLOPE = 1)
  const sortedTriangles = [...triangles].sort((a, b) => {
    const aPrio = a.role === 'formation' ? PRIORITY_GROUND_ROAD_SURFACE : 1;
    const bPrio = b.role === 'formation' ? PRIORITY_GROUND_ROAD_SURFACE : 1;
    if (aPrio !== bPrio) return bPrio - aPrio;
    if (a.segmentRank !== b.segmentRank) return a.segmentRank - b.segmentRank;
    return a.primitiveRank - b.primitiveRank;
  });

  const buffers = createRasterizationBuffersV3(N);

  try {
    // 2. Rasterize every primitive into candidate buffers
    for (const tri of sortedTriangles) {
      rasterizeTriangleAtomicV3(tri, grid, buffers);
    }

    // 3. Validate candidate buffers and build nextWorking Float32Array
    const nextWorking = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      const prio = buffers.priority[i];
      const z = buffers.targetZ[i];
      const seg = buffers.segmentRank[i];
      const prim = buffers.primitiveRank[i];

      if (prio === PRIORITY_NONE) {
        if (!Number.isNaN(z)) {
          throw new Error(`Buffer validation error at index ${i}: priority is NONE but targetZ is ${z}`);
        }
        if (seg !== SENTINEL_UINT32 || prim !== SENTINEL_UINT32) {
          throw new Error(`Buffer validation error at index ${i}: priority is NONE but rank is set`);
        }
        nextWorking[i] = grid.getSourceElevation(i);
      } else {
        if (!Number.isFinite(z)) {
          throw new Error(`Buffer validation error at index ${i}: priority is ${prio} but targetZ is non-finite ${z}`);
        }
        if (seg === SENTINEL_UINT32 || prim === SENTINEL_UINT32) {
          throw new Error(`Buffer validation error at index ${i}: priority is ${prio} but rank is sentinel`);
        }
        nextWorking[i] = z;
      }
    }

    // 4. TRULY ATOMIC COMMIT: Only ONE final set() call on 100% success!
    grid.workingElevations.set(nextWorking);

    return {
      status: 'success',
      buffers,
      nextWorkingElevations: nextWorking,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      status: 'failed',
      error: errorMsg,
    };
  }
}
