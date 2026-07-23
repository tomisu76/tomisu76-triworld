import { describe, expect, test } from 'vitest';
import { buildBanovceRealWorldTerrain } from './gis-terrain';
import { generateLevelPackageFiles } from './level-generator';
import { buildMountainLoopRoadTerrain } from './road-terrain';

describe('TRIWORLD V4 — BEAMNG NATIVE, GATE 3 (Road-First Terrain Corridor)', () => {
  const makeResult = () => buildMountainLoopRoadTerrain(
    buildBanovceRealWorldTerrain({ size: 256, squareSize: 1.0, maxHeight: 500 }),
  );

  test('1. Builds a native v9 terrain with asphalt layer', () => {
    const result = makeResult();
    expect(result.artifact.version).toBe(9);
    expect(result.artifact.size).toBe(256);
    expect(result.artifact.materialNames).toEqual(['triworld_v4_ground', 'ASPHALT']);
    expect(result.stats.modifiedSampleCount).toBeGreaterThan(10_000);
    expect(result.stats.asphaltSampleCount).toBeGreaterThan(1_000);
  });

  test('2. Produces a closed, dense DecalRoad loop', () => {
    const result = makeResult();
    const nodes = result.roadObject.nodes as number[][];
    expect(result.roadObject.class).toBe('DecalRoad');
    expect(result.roadObject.material).toBe('triworld_v4_road_decal');
    expect(result.roadObject.drivability).toBe(1);
    expect(nodes.length).toBeGreaterThan(80);
    expect(nodes[0][0]).toBe(nodes[nodes.length - 1][0]);
    expect(nodes[0][1]).toBe(nodes[nodes.length - 1][1]);
    expect(nodes[0][2]).toBe(nodes[nodes.length - 1][2]);
    expect(result.stats.roadLengthMetres).toBeGreaterThan(600);
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
    }
  });

  test('6. Level package contains road object, road-aligned spawn and portable materials', () => {
    const result = makeResult();
    const files = generateLevelPackageFiles(result.artifact, {
      title: 'TriWorld V4 Native Gate 3',
      description: 'Road-first mountain circuit with cut/fill terrain corridor',
      extraObjects: [result.roadObject],
      defaultSpawnObject: result.roadSpawn,
      supportsTraffic: true,
    });

    const objects = files.itemsLevelJson.split('\n').map((line) => JSON.parse(line));
    const materials = JSON.parse(files.materialsJson);
    const terrain = JSON.parse(files.terrainJson);
    const info = JSON.parse(files.infoJson);

    expect(objects.some((object: Record<string, unknown>) => object.class === 'DecalRoad')).toBe(true);
    expect(objects.some((object: Record<string, unknown>) => object.name === 'spawns_default')).toBe(true);
    expect(materials.ASPHALT.class).toBe('TerrainMaterial');
    expect(materials.ASPHALT.groundmodelName).toBe('ASPHALT');
    expect(materials.triworld_v4_road_decal.class).toBe('Material');
    expect(terrain.materials).toEqual(['triworld_v4_ground', 'ASPHALT']);
    expect(info.supportsTraffic).toBe(true);
    expect(Array.from(files.roadDiffusePng!.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });

  test('7. Repeated runs are byte-identical', () => {
    const first = makeResult();
    const second = makeResult();
    expect(first.artifact.heightMapU16).toEqual(second.artifact.heightMapU16);
    expect(first.artifact.layerMapU8).toEqual(second.artifact.layerMapU8);
    expect(first.roadNodes).toEqual(second.roadNodes);
    expect(first.stats).toEqual(second.stats);
  });
});
