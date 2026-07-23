import { TerrainGridV3 } from './terrain/TerrainGridV3';
import {
  canonicalizeSumoDirection,
  resampleSumoShapeGlobal,
  type CanonicalSumoShapeResult,
  type DesignedSumoStation,
  type SumoLaneGeometry,
} from './sumo/SumoGeometryV3';
import { designVerticalProfileV3 } from './civil/designVerticalProfile';
import { buildCorridorV3, type CorridorResultV3 } from './corridor/buildCorridor';
import { executeCorridorTransactionV3, type TransactionResultV3 } from './raster/corridorTransaction';
import { computePipelineFingerprintsV3, type PipelineFingerprintsV3 } from './diagnostics/fingerprints';

export interface PipelineV3Result {
  grid: TerrainGridV3;
  sumoResult: CanonicalSumoShapeResult;
  stations: DesignedSumoStation[];
  corridorResult: CorridorResultV3;
  transactionResult: TransactionResultV3;
  fingerprints: PipelineFingerprintsV3;
}

export function runPipelineV3ValidationAlpha(
  lane: SumoLaneGeometry,
  absoluteElevationFactory: (x: number, y: number) => number,
  N: number = 512,
  squareSize: number = 1.0,
  useSyntheticFormula: boolean = false,
): PipelineV3Result {
  // 1. Create TerrainGridV3
  const grid = new TerrainGridV3(N, squareSize, absoluteElevationFactory);

  // 2. Canonicalize SUMO direction
  const sumoResult = canonicalizeSumoDirection(lane);

  // 3. Resample global arc-length stations (1.0m spacing)
  const planStations = resampleSumoShapeGlobal(sumoResult.canonicalShape, 1.0);

  // 4. Design vertical profile
  const stations = designVerticalProfileV3(planStations, grid, useSyntheticFormula);

  // 5. Build corridor quads and triangles
  const laneHalfWidth = lane.width / 2;
  const shoulderWidth = 1.0;
  const corridorResult = buildCorridorV3(stations, grid, lane.edgeId, laneHalfWidth, shoulderWidth);

  // 6. Execute atomic transaction
  const transactionResult = executeCorridorTransactionV3(corridorResult.triangles, grid);

  if (transactionResult.status !== 'success') {
    throw new Error(`Pipeline V3 Transaction Failed: ${transactionResult.error}`);
  }

  // 7. Compute fingerprints
  const fingerprints = computePipelineFingerprintsV3(grid, sumoResult, corridorResult, transactionResult);

  return {
    grid,
    sumoResult,
    stations,
    corridorResult,
    transactionResult,
    fingerprints,
  };
}
