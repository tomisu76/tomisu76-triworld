import type { TerrainGridV3 } from '../terrain/TerrainGridV3';
import type { TriangleV3 } from '../corridor/triangulateQuad';

export const PRIORITY_NONE = 0;
export const PRIORITY_SLOPE = 1;
export const PRIORITY_GROUND_ROAD_SURFACE = 3;

export const SENTINEL_UINT32 = 0xffff_ffff;

export interface RasterizationBuffersV3 {
  N: number;
  targetZ: Float32Array;
  priority: Uint8Array;
  segmentRank: Uint32Array;
  primitiveRank: Uint32Array;
  slopeOwnerSegmentRank: Uint32Array;
  slopeOwnerPrimitiveRank: Uint32Array;
}

export function createRasterizationBuffersV3(N: number): RasterizationBuffersV3 {
  const count = N * N;
  const targetZ = new Float32Array(count);
  targetZ.fill(Number.NaN);

  const priority = new Uint8Array(count);
  priority.fill(PRIORITY_NONE);

  const segmentRank = new Uint32Array(count);
  segmentRank.fill(SENTINEL_UINT32);

  const primitiveRank = new Uint32Array(count);
  primitiveRank.fill(SENTINEL_UINT32);

  const slopeOwnerSegmentRank = new Uint32Array(count);
  slopeOwnerSegmentRank.fill(SENTINEL_UINT32);

  const slopeOwnerPrimitiveRank = new Uint32Array(count);
  slopeOwnerPrimitiveRank.fill(SENTINEL_UINT32);

  return {
    N,
    targetZ,
    priority,
    segmentRank,
    primitiveRank,
    slopeOwnerSegmentRank,
    slopeOwnerPrimitiveRank,
  };
}

export function rasterizeTriangleAtomicV3(
  tri: TriangleV3,
  grid: TerrainGridV3,
  buffers: RasterizationBuffersV3,
): void {
  const N = grid.N;
  const v0 = tri.v0;
  const v1 = tri.v1;
  const v2 = tri.v2;

  const p0 = { x: BigInt(v0.fixedX), y: BigInt(v0.fixedY) };
  const p1 = { x: BigInt(v1.fixedX), y: BigInt(v1.fixedY) };
  const p2 = { x: BigInt(v2.fixedX), y: BigInt(v2.fixedY) };

  // Calculate 2D fixed-point signed double area
  const area2 = crossFixed(p0, p1, p2);
  if (area2 <= 0n) return; // Skip degenerate or non-CCW triangles

  // Edge vectors and top-left rules
  const e0 = { x: p2.x - p1.x, y: p2.y - p1.y };
  const e1 = { x: p0.x - p2.x, y: p0.y - p2.y };
  const e2 = { x: p1.x - p0.x, y: p1.y - p0.y };

  const isTopLeft01 = e2.y < 0n || (e2.y === 0n && e2.x < 0n);
  const isTopLeft12 = e0.y < 0n || (e0.y === 0n && e0.x < 0n);
  const isTopLeft20 = e1.y < 0n || (e1.y === 0n && e1.x < 0n);

  // Determine pixel bounding box
  const minX = Math.min(v0.x, v1.x, v2.x);
  const maxX = Math.max(v0.x, v1.x, v2.x);
  const minY = Math.min(v0.y, v1.y, v2.y);
  const maxY = Math.max(v0.y, v1.y, v2.y);

  const minCol = Math.max(0, Math.floor(grid.xToContinuousColumn(minX)));
  const maxCol = Math.min(N - 1, Math.ceil(grid.xToContinuousColumn(maxX)));
  const minRow = Math.max(0, Math.floor(grid.yToContinuousRow(maxY))); // Row 0 is North (+Y)
  const maxRow = Math.min(N - 1, Math.ceil(grid.yToContinuousRow(minY)));

  const coveredPixels: Array<{ index: number; col: number; row: number; interpolatedZ: number }> = [];

  // Pass 1: Test inclusion
  for (let r = minRow; r <= maxRow; r++) {
    const sampleY = grid.rowToY(r);
    const sampleYFixed = BigInt(Math.round(sampleY * 1000));

    for (let c = minCol; c <= maxCol; c++) {
      const sampleX = grid.columnToX(c);
      const sampleXFixed = BigInt(Math.round(sampleX * 1000));

      const p = { x: sampleXFixed, y: sampleYFixed };

      const w0 = crossFixed(p1, p2, p);
      const w1 = crossFixed(p2, p0, p);
      const w2 = crossFixed(p0, p1, p);

      const inside01 = isTopLeft01 ? w2 >= 0n : w2 > 0n;
      const inside12 = isTopLeft12 ? w0 >= 0n : w0 > 0n;
      const inside20 = isTopLeft20 ? w1 >= 0n : w1 > 0n;

      if (inside01 && inside12 && inside20) {
        const lambda0 = Number(w0) / Number(area2);
        const lambda1 = Number(w1) / Number(area2);
        const lambda2 = Number(w2) / Number(area2);

        const interpolatedZ = lambda0 * v0.z + lambda1 * v1.z + lambda2 * v2.z;
        if (!Number.isFinite(interpolatedZ)) {
          continue;
        }

        const idx = r * N + c;
        coveredPixels.push({ index: idx, col: c, row: r, interpolatedZ });
      }
    }
  }

  // Pass 2: Write candidate pixels to rasterization buffers with GROUND_ROAD_SURFACE priority (3)
  const currentPriority = tri.role === 'formation' ? PRIORITY_GROUND_ROAD_SURFACE : PRIORITY_SLOPE;

  for (const pixel of coveredPixels) {
    const idx = pixel.index;
    const existingPriority = buffers.priority[idx];

    let winner = false;
    if (existingPriority === PRIORITY_NONE) {
      winner = true;
    } else if (currentPriority > existingPriority) {
      winner = true;
    } else if (currentPriority === existingPriority) {
      if (currentPriority === PRIORITY_SLOPE) {
        if (pixel.interpolatedZ < buffers.targetZ[idx]) {
          winner = true;
        }
      } else if (tri.segmentRank < buffers.segmentRank[idx]) {
        winner = true;
      }
    }

    if (winner) {
      buffers.priority[idx] = currentPriority;
      buffers.targetZ[idx] = pixel.interpolatedZ;
      buffers.segmentRank[idx] = tri.segmentRank;
      buffers.primitiveRank[idx] = tri.primitiveRank;
      if (tri.role !== 'formation') {
        buffers.slopeOwnerSegmentRank[idx] = tri.segmentRank;
        buffers.slopeOwnerPrimitiveRank[idx] = tri.primitiveRank;
      }
    }
  }
}

function crossFixed(a: { x: bigint; y: bigint }, b: { x: bigint; y: bigint }, c: { x: bigint; y: bigint }): bigint {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}
