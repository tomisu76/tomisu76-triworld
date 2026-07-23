/**
 * Coupled Road-Terrain Corridor Processor — TriWorld V4 Gate 3
 * Integrates real 3D road centerline alignment (S-curve mountain highway)
 * with 1V:2H cut & fill daylight slopes flattened into native Uint16 terrain heightfield.
 */

import { runPipelineV3ValidationAlpha, PipelineV3Result } from '../pipeline-v3/pipelineV3';
import { SumoLaneGeometry, Vec2 } from '../pipeline-v3/sumo/SumoGeometryV3';

export interface RoadCorridorConfig {
  size?: number; // 1024
  squareSize?: number; // 1.0
  laneWidth?: number; // 8.0m (2-lane asphalt road)
  roadShapeCentered?: Vec2[];
}

/**
 * Centered S-curve mountain road centerline passing through the 1024m x 1024m target terrain [-512..+512].
 */
export const DEFAULT_BANNOVE_ROAD_SHAPE_CENTERED: Vec2[] = [
  { x: -420, y: -380 },
  { x: -220, y: -200 },
  { x: 0, y: 0 },
  { x: 220, y: 240 },
  { x: 420, y: 390 },
];

/**
 * Applies coupled 3D road centerline formation bed flattening and 1V:2H cut & fill daylight slopes
 * onto real DEM terrain heightfield while preserving absolute DEM elevations.
 */
export function applyCoupledRoadTerrainCorridor(
  rawElevations: Float32Array,
  size: number = 1024,
  squareSize: number = 1.0,
  maxHeight: number = 500.0,
  config: RoadCorridorConfig = {}
): {
  workingElevations: Float32Array;
  heightMapU16: Uint16Array;
  priorityBuffer: Uint8Array;
  v3Result: PipelineV3Result;
} {
  const shape = config.roadShapeCentered ?? DEFAULT_BANNOVE_ROAD_SHAPE_CENTERED;
  const laneWidth = config.laneWidth ?? 8.0;

  const lane: SumoLaneGeometry = {
    edgeId: 'I9_Banovce_Mountain_Corridor',
    laneId: 'I9_Banovce_Mountain_Corridor_0',
    laneIndex: 0,
    width: laneWidth,
    speed: 25.0,
    function: 'normal',
    shape,
  };

  const half = size / 2;

  const absoluteElevationFactory = (xCentered: number, yCentered: number): number => {
    const xMetres = xCentered + half;
    const yMetres = yCentered + half;
    const c = Math.max(0, Math.min(size - 1, Math.round(xMetres / squareSize)));
    const r = Math.max(0, Math.min(size - 1, Math.round((size - 1 - yMetres / squareSize))));
    return rawElevations[r * size + c];
  };

  // Run authoritative Pipeline V3 Civil Engineering Road Corridor Engine
  const v3Result = runPipelineV3ValidationAlpha(
    lane,
    absoluteElevationFactory,
    size,
    squareSize,
    false
  );

  const workingElevations = new Float32Array(rawElevations.length);
  const srcElev = (v3Result.grid as any).sourceElevations;
  const wrkElev = (v3Result.grid as any).workingElevations;

  for (let i = 0; i < rawElevations.length; i++) {
    const delta = wrkElev[i] - srcElev[i];
    workingElevations[i] = rawElevations[i] + delta;
  }

  // Quantize modified elevations into native Uint16 heightmap
  const heightScale = maxHeight / 65535.0;
  const heightMapU16 = new Uint16Array(size * size);

  for (let i = 0; i < workingElevations.length; i++) {
    const val = workingElevations[i];
    const quantized = Math.round(val / heightScale);
    heightMapU16[i] = Math.max(0, Math.min(65535, quantized));
  }

  return {
    workingElevations,
    v3Result,
    heightMapU16,
    priorityBuffer: v3Result.transactionResult.buffers!.priority,
  };
}
