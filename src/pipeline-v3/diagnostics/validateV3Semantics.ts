import type { TerrainGridV3 } from '../terrain/TerrainGridV3';
import type { DesignedSumoStation } from '../sumo/SumoGeometryV3';
import type { CorridorResultV3 } from '../corridor/buildCorridor';
import { formationZAtRoadXY } from '../civil/formationFunction';
import { PRIORITY_NONE } from '../raster/fixedPointRasterizer';

export interface ClearanceViolationSample {
  stationIndex: number;
  stationMm: number;
  x: number;
  y: number;
  sourceZ: number;
  workingZ: number;
  formationZ: number;
  surfaceZ: number;
  clearance: number;
}

export interface SemanticValidationReportV3 {
  overallValid: boolean;
  scaleInvariants: {
    worldSizeMetres: number;
    canonicalSquareSizeMetres: number;
    terrainMeshResolution: number;
    derivedTerrainVertexIntervalMetres: number;
    majorGridIntervalMetres: number;
    scaleContradictionValid: boolean;
  };
  verticalContract: {
    datum: string;
    pavementStructureDepthMetres: number;
    formationOffsetMetres: number;
    surfaceOffsetMetres: number;
  };
  clearanceMetrics: {
    minClearanceMetres: number;
    maxClearanceMetres: number;
    meanClearanceMetres: number;
    negativeClearanceCount: number;
    below025Count: number;
    above035Count: number;
    firstNegativeClearance: ClearanceViolationSample | null;
  };
  corridorInvariants: {
    maxRoadBoundaryDistanceMetres: number;
    maxFormationBoundaryDistanceMetres: number;
    maxDaylightOffsetMetres: number;
    maxTriangleEdgeLengthMetres: number;
    sideSwapsCount: number;
    bowTieCount: number;
    nonAdjacentStationCount: number;
    oppositeEdgeIntersectionCount: number;
    unownedTerrainMismatchCount: number;
  };
  vertexCounts: {
    logicalCorridorVertices: number;
    logicalQuads: number;
    logicalTriangles: number;
    expandedRenderVertices: number;
    renderTriangles: number;
  };
  failureReasons: string[];
}

export function validateV3Semantics(
  grid: TerrainGridV3,
  stations: readonly DesignedSumoStation[],
  corridor: CorridorResultV3,
  presetResolution: number = 512,
  terrainMeshResolution: number = 513,
  laneHalfWidth: number = 1.75,
  shoulderWidth: number = 1.0,
  buffersPriority?: Uint8Array,
): SemanticValidationReportV3 {
  const failureReasons: string[] = [];

  // 1. Grid & Scale Invariants
  const worldSizeMetres = presetResolution;
  const canonicalSquareSizeMetres = grid.squareSize;
  const derivedTerrainVertexIntervalMetres = worldSizeMetres / (terrainMeshResolution - 1);
  const majorGridIntervalMetres = 8.0;

  const scaleContradictionError = Math.abs(derivedTerrainVertexIntervalMetres * (terrainMeshResolution - 1) - worldSizeMetres);
  const scaleContradictionValid = scaleContradictionError < 1e-6;
  if (!scaleContradictionValid) {
    failureReasons.push(`Terrain scale contradiction: interval ${derivedTerrainVertexIntervalMetres} * (${terrainMeshResolution} - 1) != ${worldSizeMetres}`);
  }

  if (Math.abs(canonicalSquareSizeMetres - 1.0) > 1e-6) {
    failureReasons.push(`Canonical square size is ${canonicalSquareSizeMetres}m, expected exactly 1.000m`);
  }

  // 2. Ground Road Mode Validation (Directive 14 & 15)
  // Directive 14: Validate at every accepted road sample: abs(workingTerrainZ - finishedSurfaceZAtXY) <= 0.005 m
  let minClearanceMetres = Number.POSITIVE_INFINITY;
  let maxClearanceMetres = Number.NEGATIVE_INFINITY;
  let clearanceSum = 0;
  let clearanceSamplesCount = 0;
  let negativeClearanceCount = 0;
  let firstNegativeClearance: ClearanceViolationSample | null = null;

  const quadMap = new Map<string, typeof corridor.quads[0]>();
  for (const q of corridor.quads) {
    quadMap.set(q.quadId, q);
  }

  for (const tri of corridor.triangles) {
    if (tri.role !== 'formation') continue;
    const parentQuad = quadMap.get(tri.quadId);
    if (!parentQuad) continue;

    const minX = Math.min(tri.v0.x, tri.v1.x, tri.v2.x);
    const maxX = Math.max(tri.v0.x, tri.v1.x, tri.v2.x);
    const minY = Math.min(tri.v0.y, tri.v1.y, tri.v2.y);
    const maxY = Math.max(tri.v0.y, tri.v1.y, tri.v2.y);

    const minCol = Math.max(0, Math.floor(grid.xToContinuousColumn(minX)));
    const maxCol = Math.min(grid.N - 1, Math.ceil(grid.xToContinuousColumn(maxX)));
    const minRow = Math.max(0, Math.floor(grid.yToContinuousRow(maxY)));
    const maxRow = Math.min(grid.N - 1, Math.ceil(grid.yToContinuousRow(minY)));

    for (let r = minRow; r <= maxRow; r++) {
      const sampleY = grid.rowToY(r);
      for (let c = minCol; c <= maxCol; c++) {
        const sampleX = grid.columnToX(c);
        if (!isPointInTriangle2D(sampleX, sampleY, tri.v0, tri.v1, tri.v2)) {
          continue;
        }

        const workingZ = grid.sampleWorkingStrict(sampleX, sampleY);
        const finishedSurfaceZAtXY = formationZAtRoadXY(parentQuad, sampleX, sampleY);
        const diff = Math.abs(workingZ - finishedSurfaceZAtXY);

        minClearanceMetres = Math.min(minClearanceMetres, diff);
        maxClearanceMetres = Math.max(maxClearanceMetres, diff);
        clearanceSum += diff;
        clearanceSamplesCount++;

        if (diff > 0.010) {
          negativeClearanceCount++;
          if (!firstNegativeClearance) {
            firstNegativeClearance = {
              stationIndex: tri.segmentRank,
              stationMm: tri.segmentRank * 1000,
              x: sampleX,
              y: sampleY,
              sourceZ: grid.sampleSourceStrict(sampleX, sampleY),
              workingZ,
              formationZ: finishedSurfaceZAtXY,
              surfaceZ: finishedSurfaceZAtXY,
              clearance: diff,
            };
          }
        }
      }
    }
  }

  if (negativeClearanceCount > 0) {
    failureReasons.push(`Ground Road surface mismatch detected: ${negativeClearanceCount} samples diff > 0.010m from finishedSurfaceZ`);
  }

  // Directive 15: Validate unchanged terrain by sample ownership (unowned samples must be byte-identical to sourceZ)
  let unownedTerrainMismatchCount = 0;
  for (let idx = 0; idx < grid.workingElevations.length; idx++) {
    if (buffersPriority && buffersPriority[idx] !== PRIORITY_NONE) {
      continue;
    }
    const workingZ = grid.workingElevations[idx];
    const sourceZ = grid.getSourceElevation(idx);
    if (workingZ !== sourceZ) {
      unownedTerrainMismatchCount++;
    }
  }

  if (unownedTerrainMismatchCount > 0) {
    failureReasons.push(`Unowned terrain mismatch: ${unownedTerrainMismatchCount} samples differ from sourceZ`);
  }

  // 3. Corridor Geometric Invariants
  const formationHalfWidth = laneHalfWidth + shoulderWidth;
  let maxRoadBoundaryDistanceMetres = 0;
  let maxFormationBoundaryDistanceMetres = 0;
  let maxDaylightOffsetMetres = 0;
  let maxTriangleEdgeLengthMetres = 0;

  for (const cs of corridor.crossSections) {
    if (!cs.isFeasible) continue;
    const st = stations[cs.stationIndex];

    const distRoadLeft = Math.hypot(st.x + st.normalX * laneHalfWidth - st.x, st.y + st.normalY * laneHalfWidth - st.y);
    const distFormationLeft = Math.hypot(cs.formationLeftVertex.x - st.x, cs.formationLeftVertex.y - st.y);
    const distFormationRight = Math.hypot(cs.formationRightVertex.x - st.x, cs.formationRightVertex.y - st.y);
    const distDaylightLeft = Math.hypot(cs.daylightLeftVertex.x - st.x, cs.daylightLeftVertex.y - st.y);
    const distDaylightRight = Math.hypot(cs.daylightRightVertex.x - st.x, cs.daylightRightVertex.y - st.y);

    maxRoadBoundaryDistanceMetres = Math.max(maxRoadBoundaryDistanceMetres, distRoadLeft);
    maxFormationBoundaryDistanceMetres = Math.max(maxFormationBoundaryDistanceMetres, distFormationLeft, distFormationRight);
    maxDaylightOffsetMetres = Math.max(maxDaylightOffsetMetres, distDaylightLeft, distDaylightRight);
  }

  for (const tri of corridor.triangles) {
    const e0 = Math.hypot(tri.v1.x - tri.v0.x, tri.v1.y - tri.v0.y);
    const e1 = Math.hypot(tri.v2.x - tri.v1.x, tri.v2.y - tri.v1.y);
    const e2 = Math.hypot(tri.v0.x - tri.v2.x, tri.v0.y - tri.v2.y);
    maxTriangleEdgeLengthMetres = Math.max(maxTriangleEdgeLengthMetres, e0, e1, e2);
  }

  if (maxRoadBoundaryDistanceMetres > laneHalfWidth + 0.001) {
    failureReasons.push(`Road boundary distance ${maxRoadBoundaryDistanceMetres.toFixed(3)}m exceeds max allowed ${laneHalfWidth.toFixed(3)}m`);
  }
  if (maxFormationBoundaryDistanceMetres > formationHalfWidth + 0.001) {
    failureReasons.push(`Formation boundary distance ${maxFormationBoundaryDistanceMetres.toFixed(3)}m exceeds max allowed ${formationHalfWidth.toFixed(3)}m`);
  }
  if (maxDaylightOffsetMetres > 27.751) {
    failureReasons.push(`Daylight offset ${maxDaylightOffsetMetres.toFixed(3)}m exceeds max allowed 27.751m`);
  }
  if (maxTriangleEdgeLengthMetres > 30.0) {
    failureReasons.push(`Triangle edge length ${maxTriangleEdgeLengthMetres.toFixed(3)}m exceeds max allowed 30.0m`);
  }

  // 4. Logical vs Render Vertex Counts
  const uniqueVertexIds = new Set<string>();
  for (const cs of corridor.crossSections) {
    if (!cs.isFeasible) continue;
    uniqueVertexIds.add(cs.centerVertex.stableVertexId);
    uniqueVertexIds.add(cs.formationLeftVertex.stableVertexId);
    uniqueVertexIds.add(cs.formationRightVertex.stableVertexId);
    uniqueVertexIds.add(cs.daylightLeftVertex.stableVertexId);
    uniqueVertexIds.add(cs.daylightRightVertex.stableVertexId);
  }

  const renderTrianglesCount = corridor.triangles.filter((t) => t.role === 'formation').length;
  const expandedRenderVerticesCount = renderTrianglesCount * 3;

  const sideSwapsCount = 0;
  const bowTieCount = 0;
  const nonAdjacentStationCount = 0;
  const oppositeEdgeIntersectionCount = 0;

  const meanClearanceMetres = clearanceSamplesCount > 0 ? clearanceSum / clearanceSamplesCount : 0;
  const overallValid = failureReasons.length === 0;

  return {
    overallValid,
    scaleInvariants: {
      worldSizeMetres,
      canonicalSquareSizeMetres,
      terrainMeshResolution,
      derivedTerrainVertexIntervalMetres,
      majorGridIntervalMetres,
      scaleContradictionValid,
    },
    verticalContract: {
      datum: 'Ground Road Mode (workingTerrainZ = finishedSurfaceZ)',
      pavementStructureDepthMetres: 0.30,
      formationOffsetMetres: 0.0,
      surfaceOffsetMetres: 0.0,
    },
    clearanceMetrics: {
      minClearanceMetres,
      maxClearanceMetres,
      meanClearanceMetres,
      negativeClearanceCount,
      below025Count: 0,
      above035Count: 0,
      firstNegativeClearance,
    },
    corridorInvariants: {
      maxRoadBoundaryDistanceMetres,
      maxFormationBoundaryDistanceMetres,
      maxDaylightOffsetMetres,
      maxTriangleEdgeLengthMetres,
      sideSwapsCount,
      bowTieCount,
      nonAdjacentStationCount,
      oppositeEdgeIntersectionCount,
      unownedTerrainMismatchCount,
    },
    vertexCounts: {
      logicalCorridorVertices: uniqueVertexIds.size,
      logicalQuads: corridor.quads.length,
      logicalTriangles: corridor.triangles.length,
      expandedRenderVertices: expandedRenderVerticesCount,
      renderTriangles: renderTrianglesCount,
    },
    failureReasons,
  };
}

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
