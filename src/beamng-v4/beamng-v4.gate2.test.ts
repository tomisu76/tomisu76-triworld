import { describe, test, expect } from 'vitest';
import { generateBanovceOrthophoto } from './ortho-generator';
import { buildBanovceRealWorldTerrain } from './gis-terrain';
import { generateLevelPackageFiles } from './level-generator';

describe('TRIWORLD V4 — BEAMNG NATIVE, GATE 2 (Ortofoto & Terrain Materials)', () => {
  test('1. Orthophoto Diffuse & Normal Maps Generation — 1024x1024 PNG', () => {
    const { diffusePng, normalPng, width, height } = generateBanovceOrthophoto(1024, 1024);

    expect(width).toBe(1024);
    expect(height).toBe(1024);
    expect(diffusePng.length).toBeGreaterThan(5000);
    expect(normalPng.length).toBeGreaterThan(5000);

    // PNG Signature Check: [137, 80, 78, 71, 13, 10, 26, 10]
    expect(Array.from(diffusePng.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(Array.from(normalPng.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  test('2. TerrainMaterial Integration in main.materials.json', () => {
    const { artifact } = buildBanovceRealWorldTerrain({ size: 1024, squareSize: 1.0 });
    const { diffusePng, normalPng } = generateBanovceOrthophoto(1024, 1024);

    const files = generateLevelPackageFiles(artifact, { diffusePng, normalPng });
    const materialsObj = JSON.parse(files.materialsJson);

    expect(materialsObj.triworld_v4_ground).toBeDefined();
    expect(materialsObj.triworld_v4_ground.class).toBe('TerrainMaterial');
    expect(materialsObj.triworld_v4_ground.diffuseMap).toBe('/levels/triworld_v4/art/terrains/triworld_v4_ground_d.png');
    expect(materialsObj.triworld_v4_ground.normalMap).toBe('/levels/triworld_v4/art/terrains/triworld_v4_ground_n.png');
    expect(materialsObj.triworld_v4_ground.detailSize).toBe(1024);
  });

  test('3. Deterministic Orthophoto Output', () => {
    const run1 = generateBanovceOrthophoto(512, 512);
    const run2 = generateBanovceOrthophoto(512, 512);

    expect(run1.diffusePng).toEqual(run2.diffusePng);
    expect(run1.normalPng).toEqual(run2.normalPng);
  });
});
