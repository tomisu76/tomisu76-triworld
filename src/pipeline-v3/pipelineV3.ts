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

  // 3. Resample global arc-length stations. Gate 3 retains its historical
  // sub-metre tangent window. A true Gate 4 subgrade uses a civil transition
  // at least as wide as the paved half-width plus shoulder, preventing raw
  // SUMO polyline vertices from rotating a full cross-section in one station.
  const shoulderWidth = 1.0;
  const tangentSmoothingHalfWindowMetres = formationDepthMetres > 0
    ? Math.max(5.0, lane.width / 2 + shoulderWidth)
    : 0.35;
  const planStations = resampleSumoShapeGlobal(
    sumoResult.canonicalShape,
    1.0,
    tangentSmoothingHalfWindowMetres,
  );

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
  const corridorResult = buildCorridorV3(stations, grid, lane.edgeId, laneHalfWidth, shoulderWidth);

  // 6. Execute atomic transaction.
  const transactionResult = executeCorridorTransactionV3(corridorResult.triangles, grid);

  if (transactionResult.status !== 'success') {
    throw new Error(`Pipeline V3 Transaction Failed: ${transactionResult.error}`);
  }

  // 7. Compute fingerprints.
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
