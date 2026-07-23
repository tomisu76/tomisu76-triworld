import type { CanonicalMesh } from '../../core';

export interface TopologyValidationReport {
  valid: boolean;
  vertexCount: number;
  triangleCount: number;
  side: number;
  boundaryEdgeCount: number;
  internalEdgeCount: number;
  singleUseInternalEdgeCount: number;
  overusedEdgeCount: number;
  maximumConnectedGridRowDistance: number;
  maximumConnectedGridColumnDistance: number;
  maximumWorldXYEdgeLength: number;
  failureReasons: string[];
  firstFailingTriangle: {
    triangleIndex: number;
    vertexIndices: [number, number, number];
    vertexRowsCols: Array<{ row: number; col: number }>;
    worldPositions: Array<{ x: number; y: number; z: number }>;
    signedXYArea: number;
    edgeLengths: [number, number, number];
    winding: 'CCW' | 'CW' | 'DEGENERATE';
  } | null;
}

export function validateTerrainTopology(mesh: CanonicalMesh, expectedSide: number): TopologyValidationReport {
  const failureReasons: string[] = [];
  const positions = mesh.positions;
  const indices = mesh.indices;
  const side = expectedSide;

  const vertexCount = positions.length / 3;
  const triangleCount = indices.length / 3;

  let boundaryEdgeCount = 0;
  let internalEdgeCount = 0;
  let singleUseInternalEdgeCount = 0;
  let overusedEdgeCount = 0;
  let maximumConnectedGridRowDistance = 0;
  let maximumConnectedGridColumnDistance = 0;
  let maximumWorldXYEdgeLength = 0;
  let firstFailingTriangle: TopologyValidationReport['firstFailingTriangle'] = null;

  // 1. Basic Counts
  const expectedTriangles = (side - 1) * (side - 1) * 2;
  const expectedIndices = expectedTriangles * 3;

  if (indices.length !== expectedIndices) {
    failureReasons.push(`Index count mismatch: got ${indices.length}, expected ${expectedIndices}`);
  }
  if (triangleCount !== expectedTriangles) {
    failureReasons.push(`Triangle count mismatch: got ${triangleCount}, expected ${expectedTriangles}`);
  }

  // 2. Position Checks (NaN, Infinity)
  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i])) {
      failureReasons.push(`Position at index ${i} is not finite: ${positions[i]}`);
      break;
    }
  }

  // 3. Triangle Index and Topology Validation
  const edgeMap = new Map<string, number>();

  for (let triIdx = 0; triIdx < triangleCount; triIdx++) {
    const idx0 = indices[triIdx * 3 + 0];
    const idx1 = indices[triIdx * 3 + 1];
    const idx2 = indices[triIdx * 3 + 2];

    const r0 = Math.floor(idx0 / side);
    const c0 = idx0 % side;
    const r1 = Math.floor(idx1 / side);
    const c1 = idx1 % side;
    const r2 = Math.floor(idx2 / side);
    const c2 = idx2 % side;

    const rowDist = Math.max(r0, r1, r2) - Math.min(r0, r1, r2);
    const colDist = Math.max(c0, c1, c2) - Math.min(c0, c1, c2);

    maximumConnectedGridRowDistance = Math.max(maximumConnectedGridRowDistance, rowDist);
    maximumConnectedGridColumnDistance = Math.max(maximumConnectedGridColumnDistance, colDist);

    const x0 = positions[idx0 * 3 + 0];
    const y0 = positions[idx0 * 3 + 1];
    const z0 = positions[idx0 * 3 + 2];

    const x1 = positions[idx1 * 3 + 0];
    const y1 = positions[idx1 * 3 + 1];
    const z1 = positions[idx1 * 3 + 2];

    const x2 = positions[idx2 * 3 + 0];
    const y2 = positions[idx2 * 3 + 1];
    const z2 = positions[idx2 * 3 + 2];

    const e01 = Math.hypot(x1 - x0, y1 - y0);
    const e12 = Math.hypot(x2 - x1, y2 - y1);
    const e20 = Math.hypot(x0 - x2, y0 - y2);

    maximumWorldXYEdgeLength = Math.max(maximumWorldXYEdgeLength, e01, e12, e20);

    const signedArea = 0.5 * ((x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0));
    const winding: 'CCW' | 'CW' | 'DEGENERATE' = signedArea > 1e-6 ? 'CCW' : signedArea < -1e-6 ? 'CW' : 'DEGENERATE';

    let isTriValid = true;
    if (idx0 === idx1 || idx1 === idx2 || idx2 === idx0) isTriValid = false;
    if (rowDist > 1 || colDist > 1) isTriValid = false;
    if (Math.abs(signedArea) < 1e-8) isTriValid = false;

    if (!isTriValid && !firstFailingTriangle) {
      firstFailingTriangle = {
        triangleIndex: triIdx,
        vertexIndices: [idx0, idx1, idx2],
        vertexRowsCols: [
          { row: r0, col: c0 },
          { row: r1, col: c1 },
          { row: r2, col: c2 },
        ],
        worldPositions: [
          { x: x0, y: y0, z: z0 },
          { x: x1, y: y1, z: z1 },
          { x: x2, y: y2, z: z2 },
        ],
        signedXYArea: signedArea,
        edgeLengths: [e01, e12, e20],
        winding,
      };
      failureReasons.push(`Triangle ${triIdx} failed topology checks: rowDist=${rowDist}, colDist=${colDist}, signedArea=${signedArea}`);
    }

    // Edge Frequency Counting
    addEdge(idx0, idx1);
    addEdge(idx1, idx2);
    addEdge(idx2, idx0);
  }

  function addEdge(u: number, v: number): void {
    const min = Math.min(u, v);
    const max = Math.max(u, v);
    const key = `${min}_${max}`;
    edgeMap.set(key, (edgeMap.get(key) ?? 0) + 1);
  }

  for (const [key, count] of edgeMap.entries()) {
    const [u, v] = key.split('_').map(Number);
    const rU = Math.floor(u / side);
    const cU = u % side;
    const rV = Math.floor(v / side);
    const cV = v % side;

    const isBoundary = (rU === 0 && rV === 0) ||
                       (rU === side - 1 && rV === side - 1) ||
                       (cU === 0 && cV === 0) ||
                       (cU === side - 1 && cV === side - 1);

    if (count === 1) {
      if (isBoundary) {
        boundaryEdgeCount++;
      } else {
        singleUseInternalEdgeCount++;
      }
    } else if (count === 2) {
      internalEdgeCount++;
    } else if (count > 2) {
      overusedEdgeCount++;
    }
  }

  if (singleUseInternalEdgeCount > 0) {
    failureReasons.push(`Internal edges with single use: ${singleUseInternalEdgeCount}`);
  }
  if (overusedEdgeCount > 0) {
    failureReasons.push(`Overused edges (>2 usages): ${overusedEdgeCount}`);
  }
  if (maximumConnectedGridRowDistance > 1) {
    failureReasons.push(`Connected vertices span >1 row: max distance = ${maximumConnectedGridRowDistance}`);
  }
  if (maximumConnectedGridColumnDistance > 1) {
    failureReasons.push(`Connected vertices span >1 column: max distance = ${maximumConnectedGridColumnDistance}`);
  }

  return {
    valid: failureReasons.length === 0,
    vertexCount,
    triangleCount,
    side,
    boundaryEdgeCount,
    internalEdgeCount,
    singleUseInternalEdgeCount,
    overusedEdgeCount,
    maximumConnectedGridRowDistance,
    maximumConnectedGridColumnDistance,
    maximumWorldXYEdgeLength,
    failureReasons,
    firstFailingTriangle,
  };
}
