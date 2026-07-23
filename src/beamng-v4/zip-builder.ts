import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { generateAnalyticGate0Terrain } from './analytic-terrain';
import { generateLevelPackageFiles } from './level-generator';
import { writeBeamNGTer } from './writer';
import type { ValidationManifest } from './types';

export function sha256(data: Uint8Array | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export async function buildGate0ZipPackage(outputDir: string = 'dist'): Promise<{ zipPath: string; manifestPath: string; manifest: ValidationManifest }> {
  const { result: analytic, artifact } = generateAnalyticGate0Terrain(512, 1.0, 100.0, [0, 0, 0]);
  const terBuffer = writeBeamNGTer(artifact);
  const files = generateLevelPackageFiles(analytic);

  const zip = new JSZip();

  const entries: Array<{ zipPath: string; content: Uint8Array | string }> = [
    { zipPath: 'levels/triworld_v4/info.json', content: files.infoJson },
    { zipPath: 'levels/triworld_v4/main/items.level.json', content: files.itemsLevelJson },
    { zipPath: 'levels/triworld_v4/art/terrains/terrain.ter', content: terBuffer },
    { zipPath: 'levels/triworld_v4/art/terrains/terrain.terrain.json', content: files.terrainJson },
    { zipPath: 'levels/triworld_v4/art/terrains/main.materials.json', content: files.materialsJson },
    { zipPath: 'levels/triworld_v4/art/terrains/triworld_v4_ground_d.png', content: files.diffusePng },
    { zipPath: 'levels/triworld_v4/art/terrains/triworld_v4_ground_n.png', content: files.normalPng },
  ];

  // Sort entries deterministically by path
  entries.sort((a, b) => a.zipPath.localeCompare(b.zipPath));

  const packagedFileHashes: Record<string, string> = {};

  for (const entry of entries) {
    zip.file(entry.zipPath, entry.content, {
      date: new Date('2026-07-23T12:00:00Z'), // Deterministic timestamp
    });
    packagedFileHashes[entry.zipPath] = sha256(entry.content);
  }

  const zipUint8Array = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const zipPath = path.join(outputDir, 'triworld_v4_gate0.zip');
  fs.writeFileSync(zipPath, zipUint8Array);

  const manifest: ValidationManifest = {
    targetBeamNgBuild: "0.36.4.0",
    terrainVersion: artifact.version,
    terrainSize: artifact.size,
    squareSize: analytic.squareSize,
    maxHeight: analytic.maxHeight,
    heightScale: analytic.heightScale,
    terrainPosition: analytic.terrainPosition,
    minimumDecodedElevation: analytic.minElevation,
    maximumDecodedElevation: analytic.maxElevation,
    controlPointElevations: {
      p0_0: analytic.controlPoints.p0_0.decoded,
      p511_0: analytic.controlPoints.p511_0.decoded,
      p0_511: analytic.controlPoints.p0_511.decoded,
      p511_511: analytic.controlPoints.p511_511.decoded,
      p256_256: analytic.controlPoints.p256_256.decoded,
    },
    heightMapHash: sha256(new Uint8Array(artifact.heightMapU16.buffer)),
    layerMapHash: sha256(artifact.layerMapU8),
    terHash: sha256(terBuffer),
    packagedFileHashes,
    zipManifestHash: sha256(zipUint8Array),
  };

  const manifestPath = path.join(outputDir, 'triworld_v4_gate0.manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return { zipPath, manifestPath, manifest };
}
