/**
 * Coupled Road-Terrain Corridor Processor — TriWorld V4 Gate 3.
 * Production callers must provide an explicit resolved road alignment.
 */

import { runPipelineV3ValidationAlpha, type PipelineV3Result } from '../pipeline-v3/pipelineV3';
import type { SumoLaneGeometry, Vec2 } from '../pipeline-v3/sumo/SumoGeometryV3';

export interface RoadCorridorConfig {
  laneWidth?: number;
  formationDepthMetres?: number;
  roadShapeCentered: readonly Vec2[];
  roadSourceId: string;
}

export interface RoadCorridorStats {
  roadSourceId: string;
  roadShapePointCount: number;
  roadStationCount: number;
  roadLengthMetres: number;
  terrainCellsTotal: number;
  terrainCellsModified: number;
  terrainCellsLowered: number;
  terrainCellsRaised: number;
  maximumCutMetres: number;
  maximumFillMetres: number;
  meanAbsoluteModificationMetres: number;
}

/** Test-only geometry. It is never used as a production fallback. */
export const SYNTHETIC_VALIDATION_ROAD_SHAPE_CENTERED: Vec2[] = [
  { x: -420, y: -380 },
  { x: -220, y: -200 },
  { x: 0, y: 0 },
  { x: 220, y: 240 },
  { x: 420, y: 390 },
];

export function applyCoupledRoadTerrainCorridor(
  rawElevations: Float32Array,
  size: number = 1024,
  squareSize: number = 1.0,
  maxHeight: number = 500.0,
  config?: RoadCorridorConfig,
): {
  workingElevations: Float32Array;
  heightMapU16: Uint16Array;
  priorityBuffer: Uint8Array;
  v3Result: PipelineV3Result;
  stats: RoadCorridorStats;
} {
  if (!config) {
    throw new Error('Gate 3 requires an explicit real road alignment; synthetic fallback is disabled.');
  }
  validateInputs(rawElevations, size, squareSize, maxHeight, config);

  const shape = config.roadShapeCentered.map((point) => ({ x: point.x, y: point.y }));
  const laneWidth = config.laneWidth ?? 8.0;
  const lane: SumoLaneGeometry = {
    edgeId: config.roadSourceId,
    laneId: `${config.roadSourceId}_0`,
    laneIndex: 0,
    width: laneWidth,
    speed: 25.0,
    function: 'normal',
    shape,
  };

  const halfSampleSpan = ((size - 1) * squareSize) / 2;
  const absoluteElevationFactory = (xCentered: number, yCentered: number): number => {
    const column = (xCentered + halfSampleSpan) / squareSize;
    const row = (size - 1) - (yCentered + halfSampleSpan) / squareSize;
    const epsilon = 1e-9;

    if (
      !Number.isFinite(column) || !Number.isFinite(row) ||
      column < -epsilon || column > size - 1 + epsilon ||
      row < -epsilon || row > size - 1 + epsilon
    ) {
      throw new RangeError(
        `Road terrain sample outside source DEM: centered=(${xCentered}, ${yCentered}), grid=(${column}, ${row})`,
      );
    }

    const safeColumn = Math.max(0, Math.min(size - 1, column));
    const safeRow = Math.max(0, Math.min(size - 1, row));
    const c0 = Math.min(size - 2, Math.floor(safeColumn));
    const r0 = Math.min(size - 2, Math.floor(safeRow));
    const c1 = c0 + 1;
    const r1 = r0 + 1;
    const tx = safeColumn - c0;
    const ty = safeRow - r0;

    const z00 = rawElevations[r0 * size + c0];
    const z10 = rawElevations[r0 * size + c1];
    const z01 = rawElevations[r1 * size + c0];
    const z11 = rawElevations[r1 * size + c1];
    const z0 = z00 + (z10 - z00) * tx;
    const z1 = z01 + (z11 - z01) * tx;
    return z0 + (z1 - z0) * ty;
  };

  const v3Result = runPipelineV3ValidationAlpha(
    lane,
    absoluteElevationFactory,
    size,
    squareSize,
    false,
    config.formationDepthMetres ?? 0,
  );

  const sourceRelative = v3Result.grid.getSourceElevationArray();
  const workingRelative = v3Result.grid.workingElevations;
  const workingElevations = new Float32Array(rawElevations.length);

  let terrainCellsModified = 0;
  let terrainCellsLowered = 0;
  let terrainCellsRaised = 0;
  let maximumCutMetres = 0;
  let maximumFillMetres = 0;
  let absoluteModificationSum = 0;

  for (let index = 0; index < rawElevations.length; index++) {
    const delta = workingRelative[index] - sourceRelative[index];
    workingElevations[index] = rawElevations[index] + delta;

    if (Math.abs(delta) >= 0.01) {
      terrainCellsModified += 1;
      absoluteModificationSum += Math.abs(delta);
      if (delta < 0) {
        terrainCellsLowered += 1;
        maximumCutMetres = Math.max(maximumCutMetres, -delta);
      } else {
        terrainCellsRaised += 1;
        maximumFillMetres = Math.max(maximumFillMetres, delta);
      }
    }
  }

  const heightScale = maxHeight / 65535.0;
  const heightMapU16 = new Uint16Array(size * size);
  for (let index = 0; index < workingElevations.length; index++) {
    const quantized = Math.round(workingElevations[index] / heightScale);
    heightMapU16[index] = Math.max(0, Math.min(65535, quantized));
  }

  const lastStation = v3Result.stations[v3Result.stations.length - 1];
  const stats: RoadCorridorStats = {
    roadSourceId: config.roadSourceId,
    roadShapePointCount: shape.length,
    roadStationCount: v3Result.stations.length,
    roadLengthMetres: lastStation?.station ?? 0,
    terrainCellsTotal: rawElevations.length,
    terrainCellsModified,
    terrainCellsLowered,
    terrainCellsRaised,
    maximumCutMetres,
    maximumFillMetres,
    meanAbsoluteModificationMetres:
      terrainCellsModified > 0 ? absoluteModificationSum / terrainCellsModified : 0,
  };

  return {
    workingElevations,
    heightMapU16,
    priorityBuffer: v3Result.transactionResult.buffers!.priority,
    v3Result,
    stats,
  };
}

function validateInputs(
  rawElevations: Float32Array,
  size: number,
  squareSize: number,
  maxHeight: number,
  config: RoadCorridorConfig,
): void {
  if (!Number.isInteger(size) || size < 2 || size % 2 !== 0) {
    throw new RangeError(`Terrain size must be an even integer >= 2, received ${size}.`);
  }
  if (rawElevations.length !== size * size) {
    throw new RangeError(`Elevation count mismatch: expected ${size * size}, received ${rawElevations.length}.`);
  }
  if (!Number.isFinite(squareSize) || squareSize <= 0) {
    throw new RangeError(`squareSize must be finite and > 0, received ${squareSize}.`);
  }
  if (!Number.isFinite(maxHeight) || maxHeight <= 0) {
    throw new RangeError(`maxHeight must be finite and > 0, received ${maxHeight}.`);
  }
  if (
    config.formationDepthMetres !== undefined &&
    (!Number.isFinite(config.formationDepthMetres) || config.formationDepthMetres < 0)
  ) {
    throw new RangeError(
      `formationDepthMetres must be finite and >= 0, received ${config.formationDepthMetres}.`,
    );
  }
  if (!config.roadSourceId.trim()) {
    throw new Error('Gate 3 requires a non-empty roadSourceId.');
  }
  if (config.roadShapeCentered.length < 2) {
    throw new Error('Gate 3 requires at least two real road alignment points.');
  }
  for (let index = 0; index < config.roadShapeCentered.length; index++) {
    const point = config.roadShapeCentered[index];
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new Error(`Non-finite road point at index ${index}.`);
    }
  }
}
