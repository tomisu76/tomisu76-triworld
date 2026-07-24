import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { PNG } from 'pngjs';

const SOURCE = path.resolve('src/beamng-v4/build-align01-cli.ts');
const GENERATED = path.resolve('src/beamng-v4/.generated-build-align02-cli.ts');
const LEVEL_NAME = 'align02';

function replaceExactly(source: string, oldValue: string, newValue: string, label: string): string {
  const count = source.split(oldValue).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one anchor, found ${count}.`);
  return source.replace(oldValue, newValue);
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function createSolidPng(r: number, g: number, b: number): Uint8Array {
  const width = 64;
  const height = 64;
  const png = new PNG({ width, height, colorType: 6, bitDepth: 8, inputHasAlpha: true });
  for (let pixel = 0; pixel < width * height; pixel++) {
    const offset = pixel * 4;
    png.data[offset] = r;
    png.data[offset + 1] = g;
    png.data[offset + 2] = b;
    png.data[offset + 3] = 255;
  }
  return new Uint8Array(PNG.sync.write(png));
}

async function injectAndVerifyTextures(): Promise<void> {
  const distDir = path.resolve('dist');
  const zipPath = path.join(distDir, `${LEVEL_NAME}.zip`);
  if (!fs.existsSync(zipPath)) throw new Error(`ALIGN02 ZIP missing after build: ${zipPath}`);

  const textures: Record<string, Uint8Array> = {
    'alignment_red_d.png': createSolidPng(255, 0, 0),
    'alignment_blue_d.png': createSolidPng(0, 51, 255),
    'alignment_yellow_d.png': createSolidPng(255, 255, 0),
    'alignment_magenta_d.png': createSolidPng(255, 0, 255),
  };

  const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
  const fixedDate = new Date('2026-07-23T12:00:00Z');
  for (const [name, bytes] of Object.entries(textures)) {
    zip.file(`levels/${LEVEL_NAME}/art/road/${name}`, bytes, { date: fixedDate });
  }

  const zipBytes = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
  fs.writeFileSync(zipPath, zipBytes);

  const verificationZip = await JSZip.loadAsync(zipBytes);
  const expectedCandidates: Array<[string, string, number]> = [
    ['alignment_A_no_flip', 'alignment_red', 1.0],
    ['alignment_B_x_flip', 'alignment_blue', 1.5],
    ['alignment_C_y_flip', 'alignment_yellow', 2.0],
    ['alignment_D_xy_flip', 'alignment_magenta', 2.5],
  ];

  const itemsPath = `levels/${LEVEL_NAME}/main/items.level.json`;
  const itemsText = await verificationZip.file(itemsPath)?.async('string');
  if (!itemsText) throw new Error(`Missing ${itemsPath}.`);
  const items = itemsText.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);

  if (items.filter((item) => item.name === 'spawns_default').length !== 1) {
    throw new Error('ALIGN02 expected exactly one spawns_default object.');
  }
  if (items.some((item) => item.name === 'road_surface_mesh' || item.name === 'road_surface_decal')) {
    throw new Error('ALIGN02 unexpectedly contains a legacy road object.');
  }
  if (items.some((item) => String(item.name ?? '').startsWith('station_marker_'))) {
    throw new Error('ALIGN02 unexpectedly contains station markers.');
  }

  for (const [objectName, materialName, width] of expectedCandidates) {
    const road = items.find((item) => item.name === objectName);
    if (!road) throw new Error(`Missing DecalRoad ${objectName}.`);
    if (road.material !== materialName) throw new Error(`${objectName} material mismatch.`);
    const nodes = road.nodes as number[][];
    if (!Array.isArray(nodes) || nodes.length !== 876) {
      throw new Error(`${objectName} expected 876 nodes, received ${nodes?.length ?? 0}.`);
    }
    if (nodes.some((node) => node[3] !== width)) {
      throw new Error(`${objectName} width mismatch; expected ${width}m.`);
    }
  }

  const materialsPath = `levels/${LEVEL_NAME}/art/terrains/main.materials.json`;
  const materialsText = await verificationZip.file(materialsPath)?.async('string');
  if (!materialsText) throw new Error(`Missing ${materialsPath}.`);
  const materials = JSON.parse(materialsText) as Record<string, any>;

  const textureReport: Record<string, { zipPath: string; sha256: string; width: number; height: number }> = {};
  for (const [filename, bytes] of Object.entries(textures)) {
    const texturePath = `levels/${LEVEL_NAME}/art/road/${filename}`;
    const packagedBytes = await verificationZip.file(texturePath)?.async('uint8array');
    if (!packagedBytes) throw new Error(`Missing packaged texture ${texturePath}.`);
    const decoded = PNG.sync.read(Buffer.from(packagedBytes));
    if (decoded.width !== 64 || decoded.height !== 64 || decoded.colorType !== 6) {
      throw new Error(`Invalid RGBA PNG ${texturePath}.`);
    }
    textureReport[filename] = {
      zipPath: texturePath,
      sha256: sha256(packagedBytes),
      width: decoded.width,
      height: decoded.height,
    };
  }

  const expectedMaps: Record<string, string> = {
    alignment_red: 'alignment_red_d.png',
    alignment_blue: 'alignment_blue_d.png',
    alignment_yellow: 'alignment_yellow_d.png',
    alignment_magenta: 'alignment_magenta_d.png',
  };
  for (const [materialName, textureName] of Object.entries(expectedMaps)) {
    const material = materials[materialName];
    if (!material) throw new Error(`Missing material ${materialName}.`);
    const expectedPath = `/levels/${LEVEL_NAME}/art/road/${textureName}`;
    if (material.name !== materialName || material.internalName !== materialName || material.mapTo !== materialName) {
      throw new Error(`${materialName} naming fields are inconsistent.`);
    }
    if (material.Stages?.[0]?.baseColorMap !== expectedPath) {
      throw new Error(`${materialName} does not reference ${expectedPath}.`);
    }
  }

  const installedPath = path.join(
    process.env.LOCALAPPDATA ?? 'C:\\Users\\tomisu\\AppData\\Local',
    'BeamNG',
    'BeamNG.drive',
    'current',
    'mods',
    `${LEVEL_NAME}.zip`,
  );
  fs.mkdirSync(path.dirname(installedPath), { recursive: true });
  fs.copyFileSync(zipPath, installedPath);
  const finalHash = sha256(zipBytes);
  const installedHash = sha256(fs.readFileSync(installedPath));
  if (finalHash !== installedHash) throw new Error('ALIGN02 installed ZIP hash mismatch.');

  const reportPath = path.join(distDir, `${LEVEL_NAME}_report.json`);
  if (fs.existsSync(reportPath)) {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as Record<string, any>;
    report.zipHash = finalHash;
    report.installedZipHash = installedHash;
    report.installedZipPath = installedPath;
    report.align02TextureVerification = textureReport;
    if (report.acceptance) report.acceptance.zipHashesMatch = true;
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  }

  const textureReportPath = path.join(distDir, `${LEVEL_NAME}_texture_report.json`);
  fs.writeFileSync(textureReportPath, JSON.stringify({
    levelName: LEVEL_NAME,
    zipPath,
    installedPath,
    zipSha256: finalHash,
    textures: textureReport,
    candidates: expectedCandidates.map(([name, material, width]) => ({ name, material, width, nodeCount: 876 })),
  }, null, 2));

  console.log(`ALIGN02 ZIP post-processing successful: ${zipPath}`);
  console.log(`Installed Mod: ${installedPath}`);
  console.log(`Final ZIP SHA-256: ${finalHash}`);
  console.log(`Texture report: ${textureReportPath}`);
}

async function main(): Promise<void> {
  let transformed = fs.readFileSync(SOURCE, 'utf8').replace(/\r\n/g, '\n');

  transformed = replaceExactly(
    transformed,
    "const LEVEL_NAME = 'align01';",
    "const LEVEL_NAME = 'align02';",
    'level name',
  );
  transformed = replaceExactly(
    transformed,
    "    title: 'ALIGN01 — Four-Frame DecalRoad Alignment Diagnostic',",
    "    title: 'ALIGN02 — Textured Four-Frame Alignment Diagnostic',",
    'title',
  );

  transformed = replaceExactly(transformed, `  const decalNodesA = stations.map((station) => [
    station.x + WORLD_SAMPLE_CENTER,
    station.y + WORLD_SAMPLE_CENTER,
    0,
    2.0,
  ]);`, `  const decalNodesA = stations.map((station) => [
    station.x + WORLD_SAMPLE_CENTER,
    station.y + WORLD_SAMPLE_CENTER,
    0,
    1.0,
  ]);`, 'candidate A width');
  transformed = replaceExactly(transformed, `  const decalNodesB = stations.map((station) => [
    WORLD_RUNTIME_SPAN - (station.x + WORLD_SAMPLE_CENTER),
    station.y + WORLD_SAMPLE_CENTER,
    0,
    2.0,
  ]);`, `  const decalNodesB = stations.map((station) => [
    WORLD_RUNTIME_SPAN - (station.x + WORLD_SAMPLE_CENTER),
    station.y + WORLD_SAMPLE_CENTER,
    0,
    1.5,
  ]);`, 'candidate B width');
  transformed = replaceExactly(transformed, `  const decalNodesD = stations.map((station) => [
    WORLD_RUNTIME_SPAN - (station.x + WORLD_SAMPLE_CENTER),
    WORLD_RUNTIME_SPAN - (station.y + WORLD_SAMPLE_CENTER),
    0,
    2.0,
  ]);`, `  const decalNodesD = stations.map((station) => [
    WORLD_RUNTIME_SPAN - (station.x + WORLD_SAMPLE_CENTER),
    WORLD_RUNTIME_SPAN - (station.y + WORLD_SAMPLE_CENTER),
    0,
    2.5,
  ]);`, 'candidate D width');

  const materialMaps: Array<[string, string]> = [
    ["Stages: [{ baseColor: [1, 0, 0, 1], roughness: 0.9, metalness: 0 }, {}, {}, {}]", "Stages: [{ baseColor: [1, 0, 0, 1], baseColorMap: `/levels/${LEVEL_NAME}/art/road/alignment_red_d.png`, roughness: 0.9, metalness: 0 }, {}, {}, {}]"],
    ["Stages: [{ baseColor: [0, 0.2, 1, 1], roughness: 0.9, metalness: 0 }, {}, {}, {}]", "Stages: [{ baseColor: [0, 0.2, 1, 1], baseColorMap: `/levels/${LEVEL_NAME}/art/road/alignment_blue_d.png`, roughness: 0.9, metalness: 0 }, {}, {}, {}]"],
    ["Stages: [{ baseColor: [1, 1, 0, 1], roughness: 0.9, metalness: 0 }, {}, {}, {}]", "Stages: [{ baseColor: [1, 1, 0, 1], baseColorMap: `/levels/${LEVEL_NAME}/art/road/alignment_yellow_d.png`, roughness: 0.9, metalness: 0 }, {}, {}, {}]"],
    ["Stages: [{ baseColor: [1, 0, 1, 1], roughness: 0.9, metalness: 0 }, {}, {}, {}]", "Stages: [{ baseColor: [1, 0, 1, 1], baseColorMap: `/levels/${LEVEL_NAME}/art/road/alignment_magenta_d.png`, roughness: 0.9, metalness: 0 }, {}, {}, {}]"],
  ];
  for (const [oldValue, newValue] of materialMaps) {
    transformed = replaceExactly(transformed, oldValue, newValue, `material texture ${oldValue}`);
  }

  fs.writeFileSync(GENERATED, transformed, 'utf8');
  try {
    const tsxCli = path.resolve('node_modules/tsx/dist/cli.mjs');
    const result = spawnSync(process.execPath, [tsxCli, GENERATED], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: process.env,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`ALIGN02 base build exited with code ${result.status}.`);
  } finally {
    if (fs.existsSync(GENERATED)) fs.unlinkSync(GENERATED);
  }

  await injectAndVerifyTextures();
}

main().catch((error) => {
  console.error('FATAL ALIGN02 BUILD ERROR:', error);
  process.exit(1);
});
