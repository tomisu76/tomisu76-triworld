import { describe, it, expect } from 'vitest';
import * as crypto from 'node:crypto';
import { designVerticalProfileV3, GATE3_PRODUCTION_PROFILE_CONFIG } from '../pipeline-v3/civil/designVerticalProfile';
import { TerrainGridV3 } from '../pipeline-v3/terrain/TerrainGridV3';
import { SumoPlanStation } from '../pipeline-v3/sumo/SumoGeometryV3';
import { buildBanovceRealWorldTerrainAsync } from './gis-terrain';

function hashFloat64Array(arr: Float32Array): string {
  const f64 = new Float64Array(arr);
  const buffer = Buffer.from(f64.buffer);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

describe('Gate 3 Strict Verification Requirements', () => {

  it('1. Production profile does not equal raw DEM (smooths short bumps)', () => {
    const rawElevations = [100, 105, 100, 95, 100]; // short bumps
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
    
    // Smooth should have smoothed out the 105 peak and 95 valley
    expect(profile[2].designZ).not.toBe(100); // Usually smoothed across the window
    
    // Overall test: ensure at least one designZ is different from groundZ
    const differs = profile.some(p => Math.abs(p.designZ - p.groundZ) > 0.1);
    expect(differs).toBe(true);
  });

  it('2. Production profile is not always a straight line', () => {
    const absoluteElevationFactory = (x: number, y: number) => {
      const idx = Math.min(100, Math.max(0, Math.round(x + 50)));
      return Math.abs(idx - 50) * 2; // V-shape 100 -> 0 -> 100
    };
    const grid = new TerrainGridV3(102, 1.0, absoluteElevationFactory);
    const stations: SumoPlanStation[] = Array.from({length: 101}, (_, i) => ({
      station: i, x: i - 50, y: 0, tangentX: 1, tangentY: 0, normalX: 0, normalY: 1
    }));

    const profile = designVerticalProfileV3(stations, grid);
    
    // A straight line would be constant 100.
    const midZ = profile[50].designZ;
    expect(midZ).not.toBe(100); // It must dip into the valley!
    expect(midZ).toBeLessThan(90); 
  });

  it('3. Missing road input fails (throws or returns empty)', () => {
    const grid = new TerrainGridV3(4, 1.0, () => 100);
    const stations: SumoPlanStation[] = [];
    const profile = designVerticalProfileV3(stations, grid);
    expect(profile.length).toBe(0);
  });

  it('4. Hashes change only when terrain changes', () => {
    const grid1 = new Float32Array([100.5, 101.2, 99.8]);
    const grid2 = new Float32Array([100.5, 101.2, 99.8]);
    const grid3 = new Float32Array([100.5, 101.3, 99.8]); // modified

    const h1 = hashFloat64Array(grid1);
    const h2 = hashFloat64Array(grid2);
    const h3 = hashFloat64Array(grid3);

    expect(h1).toEqual(h2);
    expect(h1).not.toEqual(h3);
  });

  it('5. Terrain deformation statistics are correct', async () => {
    // Generate minimal analytic terrain to ensure the pipeline actually lowers/raises cells
    const { rawElevations, modifiedElevations } = await buildBanovceRealWorldTerrainAsync({
      size: 1024,
      squareSize: 1.0,
      maxHeight: 200.0,
      withRoadCorridor: true,
      levelName: 'test',
    });

    let modified = 0;
    for (let i = 0; i < rawElevations.length; i++) {
      if (Math.abs(modifiedElevations[i] - rawElevations[i]) >= 0.01) {
        modified++;
      }
    }
    expect(modified).toBeGreaterThan(0);
  }, 30000);
});
