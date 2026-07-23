/**
 * CLI Generator for TriWorld V4 Gate 2 — Real Satellite Ortofoto & Terrain Materials (Bánovce nad Bebravou)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildBanovceRealWorldTerrain, sampleBanovceElevation } from './gis-terrain';
import { fetchRealBanovceOrthophoto } from './ortho-generator';
import { generateDiagnosticMarkers } from './diagnostic-markers';
import { generateLevelPackageFiles } from './level-generator';
import { buildBeamNgZipPackage } from './zip-builder';

async function main() {
  console.log('Building TriWorld V4 Gate 2 Real Satellite Ortofoto & Terrain (Bánovce nad Bebravou)...');

  const { artifact, transformer, scannedMinElevation, scannedMaxElevation } = buildBanovceRealWorldTerrain({
    size: 1024,
    squareSize: 1.0,
    maxHeight: 500.0,
  });

  const markers = generateDiagnosticMarkers(transformer, (x, y) => sampleBanovceElevation(x, y, transformer));
  const { diffusePng, normalPng, isRealSatellite } = await fetchRealBanovceOrthophoto({
    transformer,
    textureSize: 1024,
  });

  console.log(`Satellite Orthophoto Mode: ${isRealSatellite ? 'REAL ESRI Satellite Imagery' : 'Procedural Fallback'}`);
  console.log(`Orthophoto PNG Size: ${diffusePng.length} bytes`);

  const levelFiles = generateLevelPackageFiles(artifact, {
    title: 'TriWorld V4 Native Gate 2 (Bánovce Real Satellite Ortofoto & Terrain)',
    description: 'Bánovce nad Bebravou real GIS ESRI satellite orthophoto & terrain level',
    extraMarkers: markers,
    diffusePng,
    normalPng,
  });

  const distDir = path.resolve('dist');
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  const zipPath = path.join(distDir, 'triworld_v4_gate2.zip');
  const manifestPath = path.join(distDir, 'triworld_v4_gate2.manifest.json');

  const manifest = await buildBeamNgZipPackage(artifact, levelFiles, zipPath, manifestPath);

  // Append GIS Manifest Metadata
  const gisManifest = {
    ...manifest,
    gate: 'Gate 2 — Real Satellite Ortofoto & Terrain Materials',
    gisLocation: 'Bánovce nad Bebravou, Slovakia',
    orthoTextureProvider: isRealSatellite ? 'ESRI World Imagery MapServer (EPSG:4326)' : 'Procedural Fallback',
    orthoTextureBytes: diffusePng.length,
    wgs84Center: transformer.origin.centerWgs84,
    utmCenter: transformer.origin.centerUtm,
    utmMinCorner: transformer.minUtm,
    utmMaxCorner: transformer.maxUtm,
    scannedMinElevation,
    scannedMaxElevation,
    diagnosticMarkersCount: markers.length,
  };

  fs.writeFileSync(manifestPath, JSON.stringify(gisManifest, null, 2), 'utf-8');

  console.log('SUCCESS!');
  console.log(`Zip package: ${zipPath}`);
  console.log(`Manifest path: ${manifestPath}`);
  console.log('GIS Gate 2 Manifest details:\n', JSON.stringify(gisManifest, null, 2));

  // Copy to BeamNG mods directories
  const targetModsPaths = [
    'C:\\Users\\tomisu\\AppData\\Local\\BeamNG\\BeamNG.drive\\current\\mods\\triworld_v4_gate2.zip',
    'C:\\Users\\tomisu\\AppData\\Local\\BeamNG.drive\\0.36\\mods\\triworld_v4_gate2.zip',
  ];

  for (const modPath of targetModsPaths) {
    try {
      const dir = path.dirname(modPath);
      if (fs.existsSync(dir)) {
        fs.copyFileSync(zipPath, modPath);
        console.log(`Copied ZIP to BeamNG userfolder: ${modPath}`);
      }
    } catch (e) {
      console.warn(`Could not copy to ${modPath}:`, e);
    }
  }
}

main().catch((err) => {
  console.error('Gate 2 CLI Build Failed:', err);
  process.exit(1);
});
