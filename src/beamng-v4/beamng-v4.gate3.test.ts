import { describe, expect, test } from 'vitest';
import { buildBanovceRealWorldTerrain } from './gis-terrain';
import { generateLevelPackageFiles } from './level-generator';
import { buildBakedMountainLoopRoadTerrain } from './road-terrain-gate3-baked';

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

describe('TRIWORLD V4 — BEAMNG NATIVE, GATE 3 (Road-First Baked Terrain Corridor)', () => {
  const makeResult = () => buildBakedMountainLoopRoadTerrain(
    buildBanovceRealWorldTerrain({ size: 256, squareSize: 1.0, maxHeight: 500 }),
  );

  test('1. Builds native v9 terrain with one valid material and a separate road mask', () => {
    const result = makeResult();
    expect(result.artifact.version).toBe(9);
    expect(result.artifact.size).toBe(256);
    expect(result.artifact.materialNames).toEqual(['triworld_v4_ground']);
    expect(result.artifact.layerMapU8.every((value) => value === 0)).toBe(true);
    expect(result.roadMaskU8.some((value) => value === 255)).toBe(true);
    expect(result.stats.modifiedSampleCount).toBeGreaterThan(10_000);
    expect(result.stats.asphaltSampleCount).toBeGreaterThan(1_000);
  });

  test('2. Preserves the closed, dense designed road alignment', () => {
    const result = makeResult();
    const nodes = result.roadObject.nodes as number[][];
    expect(nodes.length).toBeGreaterThan(80);
    expect(nodes[0][0]).toBe(nodes[nodes.length - 1][0]);
    expect(nodes[0][1]).toBe(nodes[nodes.length - 1][1]);
    expect(nodes[0][2]).toBe(nodes[nodes.length - 1][2]);
    expect(result.stats.roadLengthMetres).toBeGreaterThan(550);
  });

  test('3. Enforces civil-design grade and banking limits', () => {
    const result = makeResult();
    expect(result.stats.maximumAbsoluteGrade).toBeLessThanOrEqual(0.095001);
    expect(result.stats.maximumAbsoluteBank).toBeLessThanOrEqual(0.075001);
    expect(Number.isFinite(result.stats.minimumCutFillMetres)).toBe(true);
    expect(Number.isFinite(result.stats.maximumCutFillMetres)).toBe(true);
  });

  test('4. Road centerline is supported by the final terrain', () => {
    const result = makeResult();
    for (let index = 0; index < result.roadNodes.length; index += 7) {
      const node = result.roadNodes[index];
      const terrainElevation = result.sampleElevation(node.x, node.y);
      expect(Math.abs(terrainElevation - node.z)).toBeLessThanOrEqual(0.25);
    }
  });

  test('5. Terrain outside the corridor is byte-stable', () => {
    const result = makeResult();
    const size = result.artifact.size;
    const untouchedIndices = [0, size - 1, (size - 1) * size, size * size - 1];
    for (const index of untouchedIndices) {
      expect(result.deformedElevations[index]).toBe(result.originalElevations[index]);
      expect(result.artifact.layerMapU8[index]).toBe(0);
      expect(result.roadMaskU8[index]).toBe(0);
    }
  });

  test('6. Level package has no DecalRoad and no secondary terrain material', () => {
    const result = makeResult();
    const files = generateLevelPackageFiles(result.artifact, {
      title: 'TriWorld V4 Native Gate 3',
      description: 'Road-first mountain circuit with baked road appearance',
      defaultSpawnObject: result.roadSpawn,
      supportsTraffic: false,
      diffusePng: result.bakedDiffusePng,
    });

    const objects = files.itemsLevelJson.split('\n').map((line) => JSON.parse(line));
    const materials = JSON.parse(files.materialsJson);
    const terrain = JSON.parse(files.terrainJson);
    const info = JSON.parse(files.infoJson);

    expect(objects.some((object: Record<string, unknown>) => object.class === 'DecalRoad')).toBe(false);
    expect(objects.some((object: Record<string, unknown>) => object.name === 'spawns_default')).toBe(true);
    expect(materials.triworld_v4_ground.class).toBe('TerrainMaterial');
    expect(materials.ASPHALT).toBeUndefined();
    expect(materials.triworld_v4_road_decal).toBeUndefined();
    expect(terrain.materials).toEqual(['triworld_v4_ground']);
    expect(info.supportsTraffic).toBe(false);
    expect(Array.from(files.diffusePng.subarray(0, 8))).toEqual(PNG_SIGNATURE);
    expect(files.roadDiffusePng).toBeUndefined();
  });

  test('7. Baked ground texture visibly contains both road and terrain pixels', () => {
    const result = makeResult();
    expect(Array.from(result.bakedDiffusePng.subarray(0, 8))).toEqual(PNG_SIGNATURE);
    expect(result.bakedDiffusePng.length).toBeGreaterThan(10_000);
  });

  test('8. Repeated runs are byte-identical', () => {
    const first = makeResult();
    const second = makeResult();
    expect(first.artifact.heightMapU16).toEqual(second.artifact.heightMapU16);
    expect(first.artifact.layerMapU8).toEqual(second.artifact.layerMapU8);
    expect(first.roadMaskU8).toEqual(second.roadMaskU8);
    expect(first.bakedDiffusePng).toEqual(second.bakedDiffusePng);
    expect(first.roadNodes).toEqual(second.roadNodes);
    expect(first.stats).toEqual(second.stats);
  });
});
