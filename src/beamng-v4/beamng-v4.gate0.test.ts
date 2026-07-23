import fs from 'node:fs';
import path from 'node:path';
import { describe, test, expect } from 'vitest';
import { readBeamNGTer } from './reader';
import { writeBeamNGTer } from './writer';
import { generateAnalyticGate0Terrain } from './analytic-terrain';
import { generateLevelPackageFiles } from './level-generator';
import { buildGate0ZipPackage } from './zip-builder';
import JSZip from 'jszip';

describe('TRIWORLD V4 — BEAMNG NATIVE, GATE 0 (23 Automated Acceptance Tests)', () => {

  test('1. Golden Fixture Reader — parse smallgrid.ter reference', () => {
    const fixturePath = path.join(process.cwd(), 'test-fixtures', 'beamng-native-reference', 'terrain.ter');
    const buffer = fs.readFileSync(fixturePath);
    const artifact = readBeamNGTer(buffer);

    expect(artifact.version).toBeGreaterThanOrEqual(1);
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

    const size = view.getUint32(1, true);
    expect(size).toBe(512);
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
      const err = Math.abs(unquantized - decoded);
      expect(err).toBeLessThanOrEqual(maxAllowedErr);
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
    const objects = lines.map((l) => JSON.parse(l));

    expect(objects.some((o: any) => o.class === 'SimGroup' && o.name === 'MissionGroup')).toBe(true);
    expect(objects.some((o: any) => o.class === 'LevelInfo')).toBe(true);
    expect(objects.some((o: any) => o.class === 'ScatterSky')).toBe(true);
    expect(objects.some((o: any) => o.class === 'TerrainBlock')).toBe(true);
    expect(objects.some((o: any) => o.class === 'SpawnSphere')).toBe(true);
  });

  test('16. TerrainBlock Path Exists in ZIP', async () => {
    const { zipPath } = await buildGate0ZipPackage('dist');
    const zipData = fs.readFileSync(zipPath);
    const zip = await JSZip.loadAsync(zipData);

    const terEntry = zip.file('levels/triworld_v4/art/terrains/terrain.ter');
    expect(terEntry).not.toBeNull();
  });

  test('17. SpawnSphere Object Matches info.json', async () => {
    const { zipPath } = await buildGate0ZipPackage('dist');
    const zipData = fs.readFileSync(zipPath);
    const zip = await JSZip.loadAsync(zipData);

    const infoJsonText = await zip.file('levels/triworld_v4/info.json')!.async('text');
    const itemsJsonText = await zip.file('levels/triworld_v4/main/items.level.json')!.async('text');

    const info = JSON.parse(infoJsonText);
    const items = itemsJsonText.trim().split('\n').map((l) => JSON.parse(l));

    const spawnItem = items.find((i: any) => i.class === 'SpawnSphere');
    expect(spawnItem).toBeDefined();
    expect(info.defaultSpawnPointName).toBe(spawnItem.name);
    expect(info.spawnPoints[0].objectname).toBe(spawnItem.name);
  });

  test('18. Material internalName Matches .ter Material Name', async () => {
    const { zipPath } = await buildGate0ZipPackage('dist');
    const zipData = fs.readFileSync(zipPath);
    const zip = await JSZip.loadAsync(zipData);

    const terBuf = await zip.file('levels/triworld_v4/art/terrains/terrain.ter')!.async('uint8array');
    const matJsonText = await zip.file('levels/triworld_v4/art/terrains/main.materials.json')!.async('text');

    const artifact = readBeamNGTer(terBuf);
    const materials = JSON.parse(matJsonText);

    const terMatName = artifact.materialNames[0];
    expect(materials[terMatName]).toBeDefined();
    expect(materials[terMatName].internalName).toBe(terMatName);
  });

  test('19. Every Project Texture Path Exists in ZIP', async () => {
    const { zipPath } = await buildGate0ZipPackage('dist');
    const zipData = fs.readFileSync(zipPath);
    const zip = await JSZip.loadAsync(zipData);

    const diffuseEntry = zip.file('levels/triworld_v4/art/terrains/ground_d.png');
    const normalEntry = zip.file('levels/triworld_v4/art/terrains/ground_n.png');

    expect(diffuseEntry).not.toBeNull();
    expect(normalEntry).not.toBeNull();
  });

  test('20. No Absolute Filesystem Paths in Package Metadata', async () => {
    const { zipPath } = await buildGate0ZipPackage('dist');
    const zipData = fs.readFileSync(zipPath);
    const zip = await JSZip.loadAsync(zipData);

    for (const relativePath of Object.keys(zip.files)) {
      expect(relativePath).not.toMatch(/^[A-Za-z]:/); // No Windows drive
      expect(relativePath).not.toMatch(/^\//); // No root leading slash
    }
  });

  test('21. Deterministic ZIP Entry Ordering', async () => {
    const { zipPath: path1 } = await buildGate0ZipPackage('dist');
    const zipData1 = fs.readFileSync(path1);
    const zip1 = await JSZip.loadAsync(zipData1);

    const filenames = Object.keys(zip1.files);
    const sorted = filenames.slice().sort();
    expect(filenames).toEqual(sorted);
  });

  test('22. Deterministic ZIP Manifest', async () => {
    const { manifest: m1 } = await buildGate0ZipPackage('dist');
    const { manifest: m2 } = await buildGate0ZipPackage('dist');

    expect(m1.zipManifestHash).toBe(m2.zipManifestHash);
    expect(m1.terHash).toBe(m2.terHash);
  });

  test('23. ZIP Has No Extra Enclosing Directory', async () => {
    const { zipPath } = await buildGate0ZipPackage('dist');
    const zipData = fs.readFileSync(zipPath);
    const zip = await JSZip.loadAsync(zipData);

    for (const relativePath of Object.keys(zip.files)) {
      expect(relativePath.startsWith('levels/')).toBe(true);
    }
  });

});
