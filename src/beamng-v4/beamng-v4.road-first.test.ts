import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { describe, expect, test } from 'vitest';
import { generateLevelPackageFiles } from './level-generator';
import {
  buildMountainLoopRoadFirstTerrain,
  MOUNTAIN_LOOP_CENTER_WGS84,
} from './road-first-terrain';
import { buildBeamNgZipPackage } from './zip-builder';

describe('TRIWORLD V4 — ROAD-FIRST NATIVE CORRIDOR', () => {
  test('1. closed road has bounded grade, bank and a stable BeamNG DecalRoad', () => {
    const result = buildMountainLoopRoadFirstTerrain({
      size: 256,
      squareSize: 1,
      centerWgs84: MOUNTAIN_LOOP_CENTER_WGS84,
      stationSpacing: 3,
      maximumGrade: 0.075,
    });

    expect(result.artifact.version).toBe(9);
    expect(result.road.class).toBe('DecalRoad');
    expect(result.road.drivability).toBe(1);
    expect(result.road.nodes.length).toBeGreaterThan(50);
    expect(result.road.nodes[0]).toEqual(result.road.nodes[result.road.nodes.length - 1]);
    expect(result.stats.roadLengthMetres).toBeGreaterThan(550);
    expect(result.stats.maximumGrade).toBeLessThanOrEqual(0.10001);
    expect(result.stats.maximumBank).toBeLessThanOrEqual(0.04501);
  });

  test('2. collision terrain is physically conformed to the engineered road profile', () => {
    const result = buildMountainLoopRoadFirstTerrain({ size: 256, squareSize: 1, stationSpacing: 3 });
    expect(result.stats.modifiedTerrainSamples).toBeGreaterThan(10_000);
    expect(result.stats.maximumCutMetres).toBeGreaterThan(0);
    expect(result.stats.maximumFillMetres).toBeGreaterThan(0);

    for (let index = 0; index < result.roadStations.length - 1; index += 23) {
      const station = result.roadStations[index];
      const terrainZ = result.sampleElevation(station.x, station.y);
      expect(Math.abs(terrainZ - station.z)).toBeLessThan(0.35);
    }
  });

  test('3. generated items and materials contain a valid AI DecalRoad and local asphalt assets', () => {
    const result = buildMountainLoopRoadFirstTerrain({ size: 256, squareSize: 1 });
    const files = generateLevelPackageFiles(result.artifact, {
      extraObjects: [result.road as unknown as Record<string, unknown>],
    });
    const objects = files.itemsLevelJson.split('\n').map((line) => JSON.parse(line));
    const road = objects.find((object) => object.class === 'DecalRoad');
    const materials = JSON.parse(files.materialsJson);

    expect(road.name).toBe('triworld_mountain_loop');
    expect(road.material).toBe('triworld_v4_asphalt');
    expect(road.nodes.length).toBe(result.road.nodes.length);
    expect(materials.triworld_v4_asphalt.class).toBe('Material');
    expect(materials.triworld_v4_asphalt.baseColorMap[0]).toContain('/levels/triworld_v4/art/roads/');
    expect(files.roadDiffusePng.subarray(0, 8)).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
  });

  test('4. deterministic road-first builds produce byte-identical native terrain and nodes', () => {
    const first = buildMountainLoopRoadFirstTerrain({ size: 256, squareSize: 1 });
    const second = buildMountainLoopRoadFirstTerrain({ size: 256, squareSize: 1 });
    expect(first.artifact.heightMapU16).toEqual(second.artifact.heightMapU16);
    expect(first.road.nodes).toEqual(second.road.nodes);
    expect(first.stats).toEqual(second.stats);
  });

  test('5. ZIP contains terrain collision, DecalRoad scene data and asphalt textures', async () => {
    const result = buildMountainLoopRoadFirstTerrain({ size: 256, squareSize: 1 });
    const files = generateLevelPackageFiles(result.artifact, {
      title: 'TriWorld V4 Road-First Validation',
      extraObjects: [result.road as unknown as Record<string, unknown>],
    });
    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'triworld-road-first-'));
    const zipPath = path.join(output, 'road-first.zip');
    const manifestPath = path.join(output, 'road-first.manifest.json');
    await buildBeamNgZipPackage(result.artifact, files, zipPath, manifestPath);

    const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
    expect(zip.file('levels/triworld_v4/art/terrains/terrain.ter')).not.toBeNull();
    expect(zip.file('levels/triworld_v4/main/items.level.json')).not.toBeNull();
    expect(zip.file('levels/triworld_v4/art/roads/triworld_v4_asphalt.color.png')).not.toBeNull();
    expect(zip.file('levels/triworld_v4/art/roads/triworld_v4_asphalt.normal.png')).not.toBeNull();

    const items = await zip.file('levels/triworld_v4/main/items.level.json')!.async('string');
    expect(items).toContain('"class":"DecalRoad"');
    expect(items).toContain('"drivability":1');
    fs.rmSync(output, { recursive: true, force: true });
  });
});
