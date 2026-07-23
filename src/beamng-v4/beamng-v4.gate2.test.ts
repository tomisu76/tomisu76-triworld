import { describe, test, expect } from 'vitest';
import { generateProceduralOrthophoto, fetchRealBanovceOrthophoto } from './ortho-generator';
import { buildBanovceRealWorldTerrain } from './gis-terrain';
import { generateLevelPackageFiles } from './level-generator';

describe('TRIWORLD V4 — BEAMNG NATIVE, GATE 2 (Ortofoto & Terrain Materials)', () => {
  test('1. Procedural & Real Satellite Orthophoto Generation — PNG Signature', async () => {
    const proc = generateProceduralOrthophoto(1024, 1024);

    expect(proc.width).toBe(1024);
    expect(proc.height).toBe(1024);
    expect(proc.diffusePng.length).toBeGreaterThan(5000);
    expect(proc.normalPng.length).toBeGreaterThan(5000);

    // PNG Signature Check: [137, 80, 78, 71, 13, 10, 26, 10]
    expect(Array.from(proc.diffusePng.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

    // Real ESRI Satellite fetch test
    const realOrtho = await fetchRealBanovceOrthophoto({ textureSize: 512 });
    expect(realOrtho.diffusePng.length).toBeGreaterThan(10000);
    expect(Array.from(realOrtho.diffusePng.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  }, 30000);

  test('2. TerrainMaterial Integration in main.materials.json', () => {
    const { artifact } = buildBanovceRealWorldTerrain({ size: 1024, squareSize: 1.0 });
    const { diffusePng, normalPng } = generateProceduralOrthophoto(1024, 1024);

    const files = generateLevelPackageFiles(artifact, { diffusePng, normalPng });
    const materialsObj = JSON.parse(files.materialsJson);

    expect(materialsObj.triworld_v4_ground).toBeDefined();
    expect(materialsObj.triworld_v4_ground.class).toBe('TerrainMaterial');
    expect(materialsObj.triworld_v4_ground.diffuseMap).toBe('/levels/triworld_v4/art/terrains/triworld_v4_ground_d.png');
    expect(materialsObj.triworld_v4_ground.normalMap).toBe('/levels/triworld_v4/art/terrains/triworld_v4_ground_n.png');
    expect(materialsObj.triworld_v4_ground.detailSize).toBe(1024);
  });

  test('3. Deterministic Procedural Output', () => {
    const run1 = generateProceduralOrthophoto(512, 512);
    const run2 = generateProceduralOrthophoto(512, 512);

    expect(run1.diffusePng).toEqual(run2.diffusePng);
    expect(run1.normalPng).toEqual(run2.normalPng);
  });
});
