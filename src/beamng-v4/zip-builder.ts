import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { generateAnalyticGate0Terrain } from './analytic-terrain';
import { generateLevelPackageFiles, type LevelPackageFiles } from './level-generator';
import { writeBeamNGTer } from './writer';
import type { BeamNGTerrainArtifact, ValidationManifest } from './types';

export function sha256(data: Uint8Array | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export async function buildBeamNgZipPackage(
  artifact: BeamNGTerrainArtifact,
  files: LevelPackageFiles,
  targetZipPath: string,
  targetManifestPath: string,
  levelName: string = 'triworld_v4'
): Promise<ValidationManifest> {
  const terBuffer = writeBeamNGTer(artifact);
  const zip = new JSZip();

  const entries: Array<{ zipPath: string; content: Uint8Array | string }> = [
    { zipPath: `levels/${levelName}/info.json`, content: files.infoJson },
    { zipPath: `levels/${levelName}/main/items.level.json`, content: files.itemsLevelJson },
    { zipPath: `levels/${levelName}/art/terrains/terrain.ter`, content: terBuffer },
    { zipPath: `levels/${levelName}/art/terrains/terrain.terrain.json`, content: files.terrainJson },
    { zipPath: `levels/${levelName}/art/terrains/main.materials.json`, content: files.materialsJson },
    { zipPath: `levels/${levelName}/art/terrains/ground_d.png`, content: files.diffusePng },
    { zipPath: `levels/${levelName}/art/terrains/ground_n.png`, content: files.normalPng },
  ];

  entries.sort((a, b) => a.zipPath.localeCompare(b.zipPath));

  const packagedFileHashes: Record<string, string> = {};

  for (const entry of entries) {
    zip.file(entry.zipPath, entry.content, {
      date: new Date('2026-07-23T12:00:00Z'),
    });
    packagedFileHashes[entry.zipPath] = sha256(entry.content);
  }

  const zipUint8Array = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });

  const zipDir = path.dirname(targetZipPath);
  if (!fs.existsSync(zipDir)) {
    fs.mkdirSync(zipDir, { recursive: true });
  }

  fs.writeFileSync(targetZipPath, zipUint8Array);

  const manifest: ValidationManifest = {
    targetBeamNgBuild: '0.36.4.0',
    terrainVersion: artifact.version,
    terrainSize: artifact.size,
    squareSize: artifact.squareSize,
    maxHeight: artifact.maxHeight,
    heightScale: artifact.heightScale,
    terrainPosition: [0, 0, 0],
    minimumDecodedElevation: artifact.minimumDecodedElevation,
    maximumDecodedElevation: artifact.maximumDecodedElevation,
    controlPointElevations: {
      p0_0: artifact.heightMapU16[0] * artifact.heightScale,
      p511_0: artifact.heightMapU16[artifact.size - 1] * artifact.heightScale,
      p0_511: artifact.heightMapU16[(artifact.size - 1) * artifact.size] * artifact.heightScale,
      p511_511: artifact.heightMapU16[artifact.size * artifact.size - 1] * artifact.heightScale,
      p256_256: artifact.heightMapU16[Math.floor(artifact.size / 2) * artifact.size + Math.floor(artifact.size / 2)] * artifact.heightScale,
    },
    heightMapHash: sha256(new Uint8Array(artifact.heightMapU16.buffer)),
    layerMapHash: sha256(artifact.layerMapU8),
    terHash: sha256(terBuffer),
    packagedFileHashes,
    zipManifestHash: sha256(zipUint8Array),
  };

  const manifestDir = path.dirname(targetManifestPath);
  if (!fs.existsSync(manifestDir)) {
    fs.mkdirSync(manifestDir, { recursive: true });
  }

  fs.writeFileSync(targetManifestPath, JSON.stringify(manifest, null, 2));

  return manifest;
}

export async function buildGate0ZipPackage(outputDir: string = 'dist'): Promise<{ zipPath: string; manifestPath: string; manifest: ValidationManifest }> {
  const { result: analytic, artifact } = generateAnalyticGate0Terrain(512, 1.0, 100.0, [0, 0, 0]);
  const files = generateLevelPackageFiles(analytic);
  const zipPath = path.join(outputDir, 'triworld_v4_gate0.zip');
  const manifestPath = path.join(outputDir, 'triworld_v4_gate0.manifest.json');

  const manifest = await buildBeamNgZipPackage(artifact, files, zipPath, manifestPath);
  return { zipPath, manifestPath, manifest };
}
