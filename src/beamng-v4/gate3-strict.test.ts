import { describe, it, expect } from 'vitest';
import * as crypto from 'node:crypto';
import { designVerticalProfileV3, GATE3_PRODUCTION_PROFILE_CONFIG } from '../pipeline-v3/civil/designVerticalProfile';
import { TerrainGridV3 } from '../pipeline-v3/terrain/TerrainGridV3';
import { SumoPlanStation } from '../pipeline-v3/sumo/SumoGeometryV3';
import { buildBanovceRealWorldTerrainAsync } from './gis-terrain';
import {
  applyCoupledRoadTerrainCorridor,
  SYNTHETIC_VALIDATION_ROAD_SHAPE_CENTERED,
} from './road-terrain-corridor';

function hashFloat64Array(arr: Float32Array): string {
  const f64 = new Float64Array(arr);
  const buffer = Buffer.from(f64.buffer);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

describe('Gate 3 Strict Verification Requirements', () => {
  it('1. Production profile does not equal raw DEM (smooths short bumps)', () => {
    const rawElevations = [100, 105, 100, 95, 100];
    const absoluteElevationFactory = (x: number, y: number) => {
      const idx = Math.min(4, Math.max(0, Math.round(x + 2)));
      return rawElevations[idx];
    };
    const grid = new TerrainGridV3(6, 1.0, absoluteElevationFactory);
    const stations: SumoPlanStation[] = [
      { station: 0, x: -2, y: 0, tangentX: 1, tangentY: 0, normalX: 0, normalY: 1 },
      { station: 1, x: -1, y: 0, tangentX: 1, tangentY: 0, normalX: 0, normalY: 1 },
      { station: 2, x: 0, y: 0, tangentX: 1, tangentY: 0, normalX: 0, normalY: 1 },
      { station: 3, x: 1, y: 0, tangentX: 1, tangentY: 0, normalX: 0, normalY: 1 },
      { station: 4, x: 2, y: 0, tangentX: 1, tangentY: 0, normalX: 0, normalY: 1 },
    ];
    const profile = designVerticalProfileV3(stations, grid);

    expect(profile[2].designZ).not.toBe(100);
    expect(profile.some((point) => Math.abs(point.designZ - point.groundZ) > 0.1)).toBe(true);
    expect(GATE3_PRODUCTION_PROFILE_CONFIG.smoothingWindowStations).toBeGreaterThan(1);
  });

  it('2. Production profile is not always a straight line', () => {
    const absoluteElevationFactory = (x: number) => {
      const idx = Math.min(100, Math.max(0, Math.round(x + 50)));
      return Math.abs(idx - 50) * 2;
    };
    const grid = new TerrainGridV3(102, 1.0, absoluteElevationFactory);
    const stations: SumoPlanStation[] = Array.from({ length: 101 }, (_, i) => ({
      station: i,
      x: i - 50,
      y: 0,
      tangentX: 1,
      tangentY: 0,
      normalX: 0,
      normalY: 1,
    }));

    const profile = designVerticalProfileV3(stations, grid);
    expect(profile[50].designZ).not.toBe(100);
    expect(profile[50].designZ).toBeLessThan(90);
  });

  it('3. Missing road input fails', () => {
    const terrain = new Float32Array(16 * 16).fill(100);
    expect(() => applyCoupledRoadTerrainCorridor(terrain, 16, 1, 500)).toThrow(
      'explicit real road alignment',
    );
  });

  it('4. Hashes change only when terrain changes', () => {
    const grid1 = new Float32Array([100.5, 101.2, 99.8]);
    const grid2 = new Float32Array([100.5, 101.2, 99.8]);
    const grid3 = new Float32Array([100.5, 101.3, 99.8]);

    expect(hashFloat64Array(grid1)).toEqual(hashFloat64Array(grid2));
    expect(hashFloat64Array(grid1)).not.toEqual(hashFloat64Array(grid3));
  });

  it('5. Explicit synthetic fixture produces measurable terrain deformation', async () => {
    const { rawElevations } = await buildBanovceRealWorldTerrainAsync({
      size: 1024,
      squareSize: 1.0,
      maxHeight: 500.0,
      withRoadCorridor: false,
      levelName: 'test',
    });

    const corridor = applyCoupledRoadTerrainCorridor(
      rawElevations,
      1024,
      1.0,
      500.0,
      {
        roadShapeCentered: SYNTHETIC_VALIDATION_ROAD_SHAPE_CENTERED,
        roadSourceId: 'synthetic-test-fixture',
        laneWidth: 8.0,
      },
    );

    expect(corridor.stats.terrainCellsModified).toBeGreaterThan(0);
    expect(hashFloat64Array(corridor.workingElevations)).not.toEqual(
      hashFloat64Array(rawElevations),
    );
  }, 30000);
});
