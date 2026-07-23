import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { describe, expect, test } from 'vitest';
import { generateLevelPackageFiles } from './level-generator';
import { buildValidatedMountainLoopTerrain } from './road-first-finalizer';
import { MOUNTAIN_LOOP_CENTER_WGS84 } from './road-first-terrain';
import { buildBeamNgZipPackage } from './zip-builder';

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

describe('TRIWORLD V4 — ROAD-FIRST NATIVE CORRIDOR', () => {
  test('1. closed road has bounded grade, bank and explicit BeamNG navigation metadata', () => {
    const result = buildValidatedMountainLoopTerrain({
      size: 256,
      squareSize: 1,
      centerWgs84: MOUNTAIN_LOOP_CENTER_WGS84,
      stationSpacing: 3,
      maximumGrade: 0.10,
    });
    const road = result.road as unknown as Record<string, unknown>;

    expect(result.artifact.version).toBe(9);
    expect(result.road.class).toBe('DecalRoad');
    expect(result.road.drivability).toBe(1);
    expect(result.road.autoLanes).toBe(false);
    expect(road.improvedSpline).toBe(true);
    expect(road.useSubdivisions).toBe(true);
    expect(road.lanesLeft).toBe(1);
    expect(road.lanesRight).toBe(1);
    expect(road.hiddenInNavi).toBe(false);
    expect(result.road.nodes.length).toBeGreaterThan(50);
    expect(result.road.nodes[0]).toEqual(result.road.nodes[result.road.nodes.length - 1]);
    expect(result.stats.roadLengthMetres).toBeGreaterThan(550);
    expect(result.stats.maximumGrade).toBeLessThanOrEqual(0.100001);
    expect(result.stats.maximumBank).toBeLessThanOrEqual(0.04501);
  });

  test('2. collision terrain is physically conformed to the finalized road profile', () => {
    const result = buildValidatedMountainLoopTerrain({ size: 256, squareSize: 1, stationSpacing: 3 });
    expect(result.stats.modifiedTerrainSamples).toBeGreaterThan(10_000);
    expect(result.stats.maximumCutMetres).toBeGreaterThan(0);
    expect(result.stats.maximumFillMetres).toBeGreaterThan(0);

    for (let index = 0; index < result.roadStations.length - 1; index += 23) {
      const station = result.roadStations[index];
      const terrainZ = result.sampleElevation(station.x, station.y);
      expect(Math.abs(terrainZ - station.z)).toBeLessThan(0.35);
    }
  });

  test('3. daylight transition has no vertical one-metre walls where the full corridor fits', () => {
    const result = buildValidatedMountainLoopTerrain({
      size: 256,
      squareSize: 1,
      stationSpacing: 3,
      minimumBlendWidth: 22,
      maximumBlendWidth: 70,
    });
    const maximumCoordinate = (result.artifact.size - 1) * result.artifact.squareSize;
    let auditedCrossSections = 0;
    let worstDelta = 0;
    for (let index = 10; index < result.roadStations.length - 1; index += 31) {
      const station = result.roadStations[index];
      for (const side of [-1, 1]) {
        const endX = station.x + station.normalX * 60 * side;
        const endY = station.y + station.normalY * 60 * side;
        if (endX < 1 || endY < 1 || endX > maximumCoordinate - 1 || endY > maximumCoordinate - 1) continue;
        auditedCrossSections += 1;
        let previous = result.sampleElevation(station.x, station.y);
        for (let offset = 1; offset <= 60; offset++) {
          const x = station.x + station.normalX * offset * side;
          const y = station.y + station.normalY * offset * side;
          const current = result.sampleElevation(x, y);
          worstDelta = Math.max(worstDelta, Math.abs(current - previous));
          previous = current;
        }
      }
    }
    expect(auditedCrossSections).toBeGreaterThan(4);
    expect(worstDelta).toBeLessThan(2.5);
  });

  test('4. generated items and materials use natural multi-scale terrain and readable asphalt assets', () => {
    const result = buildValidatedMountainLoopTerrain({ size: 256, squareSize: 1 });
    const files = generateLevelPackageFiles(result.artifact, {
      extraObjects: [result.road as unknown as Record<string, unknown>],
    });
    const objects = files.itemsLevelJson.split('\n').map((line) => JSON.parse(line));
    const road = objects.find((object) => object.class === 'DecalRoad');
    const materials = JSON.parse(files.materialsJson);
    const info = JSON.parse(files.infoJson);

    expect(road.name).toBe('triworld_mountain_loop');
    expect(road.material).toBe('triworld_v4_asphalt');
    expect(road.nodes.length).toBe(result.road.nodes.length);
    expect(materials.triworld_v4_ground.diffuseSize).toBe(48);
    expect(materials.triworld_v4_ground.detailSize).toBe(4);
    expect(materials.triworld_v4_ground.macroSize).toBe(220);
    expect(materials.triworld_v4_asphalt.class).toBe('Material');
    expect(materials.triworld_v4_asphalt.baseColorMap[0]).toContain('/levels/triworld_v4/art/roads/');
    expect(info.roadRules.rightHandDrive).toBe(true);
    expect(files.diffusePng.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    expect(files.terrainMacroPng.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    expect(files.terrainDetailPng.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    expect(files.roadDiffusePng.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    expect(files.diffusePng.length).toBeGreaterThan(10_000);
    expect(files.roadDiffusePng.length).toBeGreaterThan(10_000);
  });

  test('5. deterministic road-first builds produce byte-identical native terrain and nodes', () => {
    const first = buildValidatedMountainLoopTerrain({ size: 256, squareSize: 1 });
    const second = buildValidatedMountainLoopTerrain({ size: 256, squareSize: 1 });
    expect(first.artifact.heightMapU16).toEqual(second.artifact.heightMapU16);
    expect(first.road.nodes).toEqual(second.road.nodes);
    expect(first.stats).toEqual(second.stats);
  });

  test('6. ZIP contains collision terrain, AI DecalRoad and all natural surface textures', async () => {
    const result = buildValidatedMountainLoopTerrain({ size: 256, squareSize: 1 });
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
    expect(zip.file('levels/triworld_v4/art/terrains/triworld_v4_ground_macro.png')).not.toBeNull();
    expect(zip.file('levels/triworld_v4/art/terrains/triworld_v4_ground_detail.png')).not.toBeNull();
    expect(zip.file('levels/triworld_v4/art/roads/triworld_v4_asphalt.color.png')).not.toBeNull();
    expect(zip.file('levels/triworld_v4/art/roads/triworld_v4_asphalt.normal.png')).not.toBeNull();

    const items = await zip.file('levels/triworld_v4/main/items.level.json')!.async('string');
    expect(items).toContain('"class":"DecalRoad"');
    expect(items).toContain('"drivability":1');
    expect(items).toContain('"improvedSpline":true');
    expect(items).toContain('"useSubdivisions":true');
    fs.rmSync(output, { recursive: true, force: true });
  });
});
