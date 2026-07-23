/**
 * CLI Generator for TriWorld V4 Gate 3 — Real DEM + Satellite Ortofoto + Coupled Road Corridor (Bánovce nad Bebravou)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildBanovceRealWorldTerrainAsync } from './gis-terrain';
import { fetchRealBanovceOrthophoto } from './ortho-generator';
import { generateDiagnosticMarkers } from './diagnostic-markers';
import { generateLevelPackageFiles } from './level-generator';
import { buildBeamNgZipPackage } from './zip-builder';

async function main() {
  console.log('Building TriWorld V4 Gate 3 Real DEM Terrain + Satellite Ortofoto + Coupled Road Corridor (Bánovce nad Bebravou)...');

  const { artifact, transformer, scannedMinElevation, scannedMaxElevation, isRealDem, sampleElevation, corridorPriorityBuffer } = await buildBanovceRealWorldTerrainAsync({
    size: 1024,
    squareSize: 1.0,
    maxHeight: 500.0,
    withRoadCorridor: true,
  });

  console.log(`DEM Elevation Mode: ${isRealDem ? 'REAL Copernicus DEM 30m Raster (Smooth Bilinear)' : 'Analytic Fallback'}`);
  console.log(`Scanned Terrain Elevation Range: ${scannedMinElevation.toFixed(2)}m to ${scannedMaxElevation.toFixed(2)}m`);

  // Generate markers and default spawn sphere at EXACT real DEM surface elevation + 3.0m
  const markers = generateDiagnosticMarkers(transformer, (x, y) => sampleElevation(x, y));
  
  const centerElevation = sampleElevation(512, 512);
  console.log(`Center Spawn Surface Elevation: ${centerElevation.toFixed(2)}m (Spawn Z: ${(centerElevation + 3.0).toFixed(2)}m)`);

  const { diffusePng, normalPng, isRealSatellite } = await fetchRealBanovceOrthophoto({
    transformer,
    textureSize: 1024,
    corridorPriorityBuffer,
  });

  console.log(`Satellite Orthophoto Mode: ${isRealSatellite ? 'REAL ESRI Satellite Imagery' : 'Procedural Fallback'}`);
  console.log(`Orthophoto PNG Size: ${diffusePng.length} bytes`);

  const levelFiles = generateLevelPackageFiles(artifact, {
    title: 'TriWorld V4 Native Gate 3 (Bánovce Real DEM & Road Corridor)',
    description: 'Bánovce nad Bebravou real GIS Copernicus DEM + ESRI satellite + 3D Road Corridor',
    extraMarkers: markers,
    diffusePng,
    normalPng,
  });

  const distDir = path.resolve('dist');
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  const zipPath = path.join(distDir, 'triworld_v4_gate3.zip');
  const manifestPath = path.join(distDir, 'triworld_v4_gate3.manifest.json');

  const manifest = await buildBeamNgZipPackage(artifact, levelFiles, zipPath, manifestPath);

  // Append GIS Manifest Metadata
  const gisManifest = {
    ...manifest,
    gate: 'Gate 3 — Real DEM + Satellite Ortofoto + Coupled Road Corridor',
    gisLocation: 'Bánovce nad Bebravou, Slovakia',
    demProvider: isRealDem ? 'Copernicus / AWS Terrarium DEM (30m, Bilinear Interpolated)' : 'Analytic Fallback',
    orthoTextureProvider: isRealSatellite ? 'ESRI World Imagery MapServer (EPSG:4326)' : 'Procedural Fallback',
    orthoTextureBytes: diffusePng.length,
    wgs84Center: transformer.origin.centerWgs84,
    utmCenter: transformer.origin.centerUtm,
    utmMinCorner: transformer.minUtm,
    utmMaxCorner: transformer.maxUtm,
    scannedMinElevation,
    scannedMaxElevation,
    centerSpawnSurfaceElevation: centerElevation,
    diagnosticMarkersCount: markers.length,
  };

  fs.writeFileSync(manifestPath, JSON.stringify(gisManifest, null, 2), 'utf-8');

  console.log('SUCCESS!');
  console.log(`Zip package: ${zipPath}`);
  console.log(`Manifest path: ${manifestPath}`);
  console.log('GIS Gate 3 Manifest details:\n', JSON.stringify(gisManifest, null, 2));

  // Copy to BeamNG mods directories
  const targetModsPaths = [
    'C:\\Users\\tomisu\\AppData\\Local\\BeamNG\\BeamNG.drive\\current\\mods\\triworld_v4_gate3.zip',
    'C:\\Users\\tomisu\\AppData\\Local\\BeamNG.drive\\0.36\\mods\\triworld_v4_gate3.zip',
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
  console.error('Gate 3 CLI Build Failed:', err);
  process.exit(1);
});
