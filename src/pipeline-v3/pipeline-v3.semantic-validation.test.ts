import { describe, test, expect } from 'vitest';
import { syntheticLane } from './testing/syntheticSumoLane';
import { TerrainGridV3 } from './terrain/TerrainGridV3';
import { buildCorridorV3 } from './corridor/buildCorridor';
import { designVerticalProfileV3 } from './civil/designVerticalProfile';
import { resampleSumoShapeGlobal, canonicalizeSumoDirection } from './sumo/SumoGeometryV3';
import { executeCorridorTransactionV3 } from './raster/corridorTransaction';
import { PRIORITY_NONE } from './raster/fixedPointRasterizer';
import type { TriangleV3 } from './corridor/triangulateQuad';

describe.each([512, 1024])('Pipeline V3 — Ground Road Mode & Terrain Integrity Verification (N=%i)', (N) => {
  const totalSamples = N * N;

  test(`Section 11: Zero-Road Control Test — workingElevations is 100% byte-identical to sourceElevations (${totalSamples} samples)`, () => {
    const grid = new TerrainGridV3(N, 1.0, (x, y) => 25.0 + 0.1 * x - 0.05 * y);
    const sourceArray = grid.getSourceElevationArray();

    // Execute zero-road transaction
    const tx = executeCorridorTransactionV3([], grid);
    expect(tx.status).toBe('success');

    let modifiedCount = 0;
    for (let i = 0; i < grid.workingElevations.length; i++) {
      if (grid.workingElevations[i] !== sourceArray[i]) {
        modifiedCount++;
      }
    }

    expect(modifiedCount).toBe(0);
    expect(grid.workingElevations).toEqual(sourceArray);
  });

  test(`Sections 1 - 4 & 8: Independent Geometric Coverage Mask & Reverse Implication Audit (${totalSamples} samples)`, () => {
    const grid = new TerrainGridV3(N, 1.0, (x, y) => 15.0 + 0.05 * x - 0.02 * y);
    const sumoResult = canonicalizeSumoDirection(syntheticLane);
    const planStations = resampleSumoShapeGlobal(sumoResult.canonicalShape, 1.0);
    const profiled = designVerticalProfileV3(planStations, grid, false);
    const corridor = buildCorridorV3(profiled, grid, syntheticLane.edgeId, 1.75, 1.0);

    const tx = executeCorridorTransactionV3(corridor.triangles, grid);
    expect(tx.status).toBe('success');
    expect(tx.buffers).toBeDefined();

    const buffers = tx.buffers!;
    const actualN = grid.N;
    expect(actualN).toBe(N);
    const count = actualN * actualN;
    expect(count).toBe(totalSamples);

    // 1. Build independent expectedModifiedMask from exact triangle geometry only (NOT from buffers/priority)
    const expectedModifiedMask = new Uint8Array(count);

    for (const tri of corridor.triangles) {
      const minX = Math.min(tri.v0.x, tri.v1.x, tri.v2.x);
      const maxX = Math.max(tri.v0.x, tri.v1.x, tri.v2.x);
      const minY = Math.min(tri.v0.y, tri.v1.y, tri.v2.y);
      const maxY = Math.max(tri.v0.y, tri.v1.y, tri.v2.y);

      const minCol = Math.max(0, Math.floor(grid.xToContinuousColumn(minX)));
      const maxCol = Math.min(actualN - 1, Math.ceil(grid.xToContinuousColumn(maxX)));
      const minRow = Math.max(0, Math.floor(grid.yToContinuousRow(maxY)));
      const maxRow = Math.min(actualN - 1, Math.ceil(grid.yToContinuousRow(minY)));

      for (let r = minRow; r <= maxRow; r++) {
        const sampleY = grid.rowToY(r);
        for (let c = minCol; c <= maxCol; c++) {
          const sampleX = grid.columnToX(c);
          if (isPointInTriangle2D(sampleX, sampleY, tri.v0, tri.v1, tri.v2)) {
            expectedModifiedMask[r * actualN + c] = 1;
          }
        }
      }
    }

    let unexpectedModifiedSampleCount = 0;
    let unexpectedOwnedSampleCount = 0;
    let finiteTargetOutsideExpectedCoverageCount = 0;
    let maximumUnexpectedAbsDeltaZ = 0;

    for (let i = 0; i < count; i++) {
      const workingZ = grid.workingElevations[i];
      const sourceZ = grid.getSourceElevation(i);
      const deltaZ = workingZ - sourceZ;
      const targetZ = buffers.targetZ[i];
      const priority = buffers.priority[i];
      const expected = expectedModifiedMask[i];

      const isModified = workingZ !== sourceZ;
      const isOwned = priority !== PRIORITY_NONE;
      const isTargetFinite = Number.isFinite(targetZ);

      if (expected === 0) {
        if (isModified) {
          unexpectedModifiedSampleCount++;
          maximumUnexpectedAbsDeltaZ = Math.max(maximumUnexpectedAbsDeltaZ, Math.abs(deltaZ));
        }
        if (isOwned) unexpectedOwnedSampleCount++;
        if (isTargetFinite) finiteTargetOutsideExpectedCoverageCount++;
      }
    }

    expect(unexpectedModifiedSampleCount).toBe(0);
    expect(unexpectedOwnedSampleCount).toBe(0);
    expect(finiteTargetOutsideExpectedCoverageCount).toBe(0);
    expect(maximumUnexpectedAbsDeltaZ).toBe(0);
  });

  test(`Section 5: Buffer Initialization & Reset Guarantee (${totalSamples} samples)`, () => {
    const grid = new TerrainGridV3(N, 1.0, () => 20.0);
    const tx = executeCorridorTransactionV3([], grid);
    expect(tx.status).toBe('success');
    expect(tx.buffers).toBeDefined();

    const buffers = tx.buffers!;
    expect(buffers.N).toBe(N);
    expect(buffers.targetZ.length).toBe(totalSamples);

    let nonNaNCount = 0;
    let nonNonePriorityCount = 0;
    for (let i = 0; i < buffers.targetZ.length; i++) {
      if (!Number.isNaN(buffers.targetZ[i])) nonNaNCount++;
      if (buffers.priority[i] !== PRIORITY_NONE) nonNonePriorityCount++;
    }

    expect(nonNaNCount).toBe(0);
    expect(nonNonePriorityCount).toBe(0);
  });

  test('Section 12 Test A: One Small Triangle Rasterization — strict exact coverage only', () => {
    const grid = new TerrainGridV3(N, 1.0, () => 50.0);

    const singleTri: TriangleV3 = {
      primitiveId: 'single-p0',
      chosenDiagonalKey: 'diag_a_c',
      v0: { x: 0, y: 0, z: 5.0, fixedX: 0, fixedY: 0, stableVertexId: 'v0', semanticRole: 'formation-left' },
      v1: { x: 5, y: 0, z: 5.0, fixedX: 5000, fixedY: 0, stableVertexId: 'v1', semanticRole: 'formation-right' },
      v2: { x: 0, y: 5, z: 5.0, fixedX: 0, fixedY: 5000, stableVertexId: 'v2', semanticRole: 'formation-left' },
      role: 'formation' as const,
      quadId: 'single-quad',
      segmentRank: 0,
      primitiveRank: 0,
    };

    const tx = executeCorridorTransactionV3([singleTri], grid);
    expect(tx.status).toBe('success');

    let modifiedCount = 0;
    for (let i = 0; i < grid.workingElevations.length; i++) {
      if (grid.workingElevations[i] !== 0.0) {
        modifiedCount++;
      }
    }

    // A 5m x 5m right triangle has area 12.5m2, covering exactly 10 discrete grid sample points
    expect(modifiedCount).toBe(10);
  });

});

function isPointInTriangle2D(
  px: number,
  py: number,
  v0: { x: number; y: number },
  v1: { x: number; y: number },
  v2: { x: number; y: number },
): boolean {
  const area = (v1.x - v0.x) * (v2.y - v0.y) - (v1.y - v0.y) * (v2.x - v0.x);
  if (Math.abs(area) < 1e-9) return false;

  const w0 = ((v1.x - px) * (v2.y - py) - (v1.y - py) * (v2.x - px)) / area;
  const w1 = ((v2.x - px) * (v0.y - py) - (v2.y - py) * (v0.x - px)) / area;
  const w2 = 1.0 - w0 - w1;

  return w0 >= -1e-4 && w1 >= -1e-4 && w2 >= -1e-4;
}
