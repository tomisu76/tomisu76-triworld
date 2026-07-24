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
import {
  enforceContinuousFormationCoverageV3,
  type FormationCoverageResultV3,
} from './raster/formationCoverage';
import { computePipelineFingerprintsV3, type PipelineFingerprintsV3 } from './diagnostics/fingerprints';

export interface PipelineV3Result {
  grid: TerrainGridV3;
  sumoResult: CanonicalSumoShapeResult;
  stations: DesignedSumoStation[];
  corridorResult: CorridorResultV3;
  transactionResult: TransactionResultV3;
  formationCoverageResult?: FormationCoverageResultV3;
  fingerprints: PipelineFingerprintsV3;
}

export function runPipelineV3ValidationAlpha(
  lane: SumoLaneGeometry,
  absoluteElevationFactory: (x: number, y: number) => number,
  N: number = 512,
  squareSize: number = 1.0,
  useSyntheticFormula: boolean = false,
  formationDepthMetres: number = 0,
): PipelineV3Result {
  if (!Number.isFinite(formationDepthMetres) || formationDepthMetres < 0) {
    throw new RangeError(
      `formationDepthMetres must be finite and >= 0, received ${formationDepthMetres}.`,
    );
  }

  // 1. Create TerrainGridV3
  const grid = new TerrainGridV3(N, squareSize, absoluteElevationFactory);

  // 2. Canonicalize SUMO direction
  const sumoResult = canonicalizeSumoDirection(lane);

  // 3. Resample global arc-length stations (1.0m spacing)
  const planStations = resampleSumoShapeGlobal(sumoResult.canonicalShape, 1.0);

  // 4. Design authoritative finished-surface vertical profile.
  const designedStations = designVerticalProfileV3(planStations, grid, useSyntheticFormula);

  // Gate 3 keeps the historical ground-road mode with zero formation depth.
  // Gate 4 can request a true subgrade below the authoritative road surface.
  const stations = formationDepthMetres === 0
    ? designedStations
    : designedStations.map((station) => ({
        ...station,
        formationZ: station.surfaceZ - formationDepthMetres,
      }));

  // 5. Build corridor quads and triangles at the requested formation elevation.
  const laneHalfWidth = lane.width / 2;
  const shoulderWidth = 1.0;
  const corridorResult = buildCorridorV3(stations, grid, lane.edgeId, laneHalfWidth, shoulderWidth);

  // 6. Execute atomic triangle transaction.
  const transactionResult = executeCorridorTransactionV3(corridorResult.triangles, grid);

  if (transactionResult.status !== 'success') {
    throw new Error(`Pipeline V3 Transaction Failed: ${transactionResult.error}`);
  }

  // 7. A true Gate 4 subgrade additionally receives a deterministic
  // nearest-segment capsule pass. This closes sub-cell and sharp-bend holes
  // under road edges without changing the designed road surface. Gate 3's
  // historical zero-depth behaviour remains byte-for-byte untouched.
  const formationCoverageResult = formationDepthMetres > 0
    ? enforceContinuousFormationCoverageV3(
        stations,
        grid,
        transactionResult,
        laneHalfWidth,
        shoulderWidth,
      )
    : undefined;

  // 8. Compute fingerprints after every terrain and buffer mutation.
  const fingerprints = computePipelineFingerprintsV3(grid, sumoResult, corridorResult, transactionResult);

  return {
    grid,
    sumoResult,
    stations,
    corridorResult,
    transactionResult,
    formationCoverageResult,
    fingerprints,
  };
}
