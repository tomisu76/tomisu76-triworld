import fs from 'node:fs';
import { describe, test, expect } from 'vitest';
import { readBeamNGTer } from './reader';
import { writeBeamNGTer } from './writer';
import { generateAnalyticGate0Terrain } from './analytic-terrain';
import { generateLevelPackageFiles } from './level-generator';
import { buildGate0ZipPackage } from './zip-builder';
import JSZip from 'jszip';

function createIndependentGoldenTerFixture(): Uint8Array {
  const size = 256;
  const sampleCount = size * size;
  const materialName = new TextEncoder().encode('test');
  const byteLength = 1 + 4 + sampleCount * 2 + sampleCount + 4 + 1 + materialName.length;
  const bytes = new Uint8Array(byteLength);
  const view = new DataView(bytes.buffer);

  bytes[0] = 9;
  view.setUint32(1, size, true);

  const materialCountOffset = 1 + 4 + sampleCount * 2 + sampleCount;
  view.setUint32(materialCountOffset, 1, true);
  bytes[materialCountOffset + 4] = materialName.length;
  bytes.set(materialName, materialCountOffset + 5);
  return bytes;
}

describe('TRIWORLD V4 — BEAMNG NATIVE, GATE 0 (23 Automated Acceptance Tests)', () => {
  test('1. Golden Fixture Reader — parse independent 256 terrain reference', () => {
    const artifact = readBeamNGTer(createIndependentGoldenTerFixture());

    expect(artifact.version).toBe(9);
    expect(artifact.size).toBe(256);
    expect(artifact.heightMapU16.length).toBe(256 * 256);
    expect(artifact.layerMapU8.length).toBe(256 * 256);
    expect(artifact.materialNames).toEqual(['test']);
  });

  test('2. Exact Format Bounds Checking — reject truncated or malformed buffer', () => {
    expect(() => readBeamNGTer(new Uint8Array([7, 0]))).toThrow(/too short/);
    expect(() => readBeamNGTer(new Uint8Array(100))).toThrow();
  });

  test('3. Deterministic Writing — writing identical artifact produces byte-identical output', () => {
    const { artifact } = generateAnalyticGate0Terrain(512);
    const buf1 = writeBeamNGTer(artifact);
    const buf2 = writeBeamNGTer(artifact);
    expect(buf1).toEqual(buf2);
  });

  test('4. Write/Read Semantic Round-Trip — read(write(artifact)) == artifact', () => {
    const { artifact } = generateAnalyticGate0Terrain(512);
    const bytes = writeBeamNGTer(artifact);
    const reloaded = readBeamNGTer(bytes);

    expect(reloaded.version).toBe(artifact.version);
    expect(reloaded.size).toBe(artifact.size);
    expect(reloaded.heightMapU16).toEqual(artifact.heightMapU16);
    expect(reloaded.layerMapU8).toEqual(artifact.layerMapU8);
    expect(reloaded.materialNames).toEqual(artifact.materialNames);
  });

  test('5. Explicit Little-Endian Encoding — verify endianness byte offsets', () => {
    const { artifact } = generateAnalyticGate0Terrain(512);
    const bytes = writeBeamNGTer(artifact);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(1, true)).toBe(512);
  });

  test('6. Correct Version — version byte is >= 7', () => {
    const { artifact } = generateAnalyticGate0Terrain(512);
    expect(artifact.version).toBeGreaterThanOrEqual(7);
  });

  test('7. Sample Count = 512 x 512 = 262,144', () => {
    const { artifact } = generateAnalyticGate0Terrain(512);
    expect(artifact.heightMapU16.length).toBe(262144);
    expect(artifact.layerMapU8.length).toBe(262144);
  });

  test('8. Material Count and Names — exact match for triworld_v4_ground', () => {
    const { artifact } = generateAnalyticGate0Terrain(512);
    expect(artifact.materialNames).toEqual(['triworld_v4_ground']);
  });

  test('9. All Layer Indices Valid — every sample in layer map is 0', () => {
    const { artifact } = generateAnalyticGate0Terrain(512);
    for (let i = 0; i < artifact.layerMapU8.length; i++) {
      expect(artifact.layerMapU8[i]).toBe(0);
    }
  });

  test('10. No Accidental 255 Layer Values', () => {
    const { artifact } = generateAnalyticGate0Terrain(512);
    let holeCount = 0;
    for (let i = 0; i < artifact.layerMapU8.length; i++) {
      if (artifact.layerMapU8[i] === 255) holeCount++;
    }
    expect(holeCount).toBe(0);
  });

  test('11. Height Values Within Uint16 Bounds — min >= 0, max <= 65535', () => {
    const { artifact } = generateAnalyticGate0Terrain(512);
    for (let i = 0; i < artifact.heightMapU16.length; i++) {
      expect(artifact.heightMapU16[i]).toBeGreaterThanOrEqual(0);
      expect(artifact.heightMapU16[i]).toBeLessThanOrEqual(65535);
    }
  }, 30000);

  test('12. Quantization Error Bounded by heightScale / 2 + epsilon', () => {
    const { result } = generateAnalyticGate0Terrain(512, 1.0, 100.0);
    const maxAllowedErr = result.heightScale / 2 + 1e-6;

    for (let i = 0; i < result.heightsFloat32.length; i++) {
      const unquantized = result.heightsFloat32[i];
      const decoded = result.heightMapU16[i] * result.heightScale;
      expect(Math.abs(unquantized - decoded)).toBeLessThanOrEqual(maxAllowedErr);
    }
  });

  test('13. Exact Decoded Corner Values Within Quantization Tolerance', () => {
    const { result } = generateAnalyticGate0Terrain(512, 1.0, 100.0);
    const tol = result.heightScale / 2 + 1e-6;

    expect(Math.abs(result.controlPoints.p0_0.decoded - 10.0000)).toBeLessThanOrEqual(tol);
    expect(Math.abs(result.controlPoints.p511_0.decoded - 41.2221)).toBeLessThanOrEqual(tol);
    expect(Math.abs(result.controlPoints.p0_511.decoded - 20.2200)).toBeLessThanOrEqual(tol);
    expect(Math.abs(result.controlPoints.p511_511.decoded - 51.4421)).toBeLessThanOrEqual(tol);
  });

  test('14. Exact Decoded Centre Value Within Tolerance', () => {
    const { result } = generateAnalyticGate0Terrain(512, 1.0, 100.0);
    const tol = result.heightScale / 2 + 1e-6;
    expect(Math.abs(result.controlPoints.p256_256.decoded - 24.2336)).toBeLessThanOrEqual(tol);
  });

  test('15. items.level.json is Valid Line-Delimited JSON', () => {
    const { result } = generateAnalyticGate0Terrain(512);
    const files = generateLevelPackageFiles(result);
    const lines = files.itemsLevelJson.trim().split('\n');

    expect(lines.length).toBe(5);
    const objects = lines.map((line) => JSON.parse(line));
    expect(objects.some((object: any) => object.class === 'SimGroup' && object.name === 'MissionGroup')).toBe(true);
    expect(objects.some((object: any) => object.class === 'LevelInfo')).toBe(true);
    expect(objects.some((object: any) => object.class === 'ScatterSky')).toBe(true);
    expect(objects.some((object: any) => object.class === 'TerrainBlock')).toBe(true);
    expect(objects.some((object: any) => object.class === 'SpawnSphere')).toBe(true);
  });

  test('16. TerrainBlock Path Exists in ZIP', async () => {
    const { zipPath } = await buildGate0ZipPackage('dist');
    const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
    expect(zip.file('levels/triworld_v4/art/terrains/terrain.ter')).not.toBeNull();
  });

  test('17. SpawnSphere Object Matches info.json', async () => {
    const { zipPath } = await buildGate0ZipPackage('dist');
    const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
    const info = JSON.parse(await zip.file('levels/triworld_v4/info.json')!.async('text'));
    const items = (await zip.file('levels/triworld_v4/main/items.level.json')!.async('text'))
      .trim().split('\n').map((line) => JSON.parse(line));
    const spawnItem = items.find((item: any) => item.class === 'SpawnSphere');

    expect(spawnItem).toBeDefined();
    expect(info.defaultSpawnPointName).toBe(spawnItem.name);
    expect(info.spawnPoints[0].objectname).toBe(spawnItem.name);
  });

  test('18. Material internalName Matches .ter Material Name', async () => {
    const { zipPath } = await buildGate0ZipPackage('dist');
    const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
    const artifact = readBeamNGTer(
      await zip.file('levels/triworld_v4/art/terrains/terrain.ter')!.async('uint8array'),
    );
    const materials = JSON.parse(
      await zip.file('levels/triworld_v4/art/terrains/main.materials.json')!.async('text'),
    );
    const terrainMaterialName = artifact.materialNames[0];

    expect(materials[terrainMaterialName]).toBeDefined();
    expect(materials[terrainMaterialName].internalName).toBe(terrainMaterialName);
  });

  test('19. Every Project Texture Path Exists in ZIP', async () => {
    const { zipPath } = await buildGate0ZipPackage('dist');
    const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
    expect(zip.file('levels/triworld_v4/art/terrains/ground_d.png')).not.toBeNull();
    expect(zip.file('levels/triworld_v4/art/terrains/ground_n.png')).not.toBeNull();
  });

  test('20. No Absolute Filesystem Paths in Package Metadata', async () => {
    const { zipPath } = await buildGate0ZipPackage('dist');
    const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
    for (const relativePath of Object.keys(zip.files)) {
      expect(relativePath).not.toMatch(/^[A-Za-z]:/);
      expect(relativePath).not.toMatch(/^\//);
    }
  });

  test('21. Deterministic ZIP Entry Ordering', async () => {
    const { zipPath } = await buildGate0ZipPackage('dist');
    const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
    const filenames = Object.keys(zip.files);
    expect(filenames).toEqual(filenames.slice().sort());
  });

  test('22. Deterministic ZIP Manifest', async () => {
    const { manifest: first } = await buildGate0ZipPackage('dist');
    const { manifest: second } = await buildGate0ZipPackage('dist');
    expect(first.zipManifestHash).toBe(second.zipManifestHash);
    expect(first.terHash).toBe(second.terHash);
  });

  test('23. ZIP Has No Extra Enclosing Directory', async () => {
    const { zipPath } = await buildGate0ZipPackage('dist');
    const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
    for (const relativePath of Object.keys(zip.files)) {
      expect(relativePath.startsWith('levels/')).toBe(true);
    }
  });
});
