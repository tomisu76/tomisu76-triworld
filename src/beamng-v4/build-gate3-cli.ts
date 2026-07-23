/**
 * CLI Generator for TriWorld V4 Gate 3 — road-first closed mountain circuit.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildBanovceRealWorldTerrain } from './gis-terrain';
import { generateDiagnosticMarkers } from './diagnostic-markers';
import { generateLevelPackageFiles } from './level-generator';
import { buildMountainLoopRoadTerrain } from './road-terrain-gate3';
import { buildBeamNgZipPackage } from './zip-builder';

async function main(): Promise<void> {
  console.log('Building TriWorld V4 Gate 3 road-first mountain circuit...');

  const base = buildBanovceRealWorldTerrain({
    size: 1024,
    squareSize: 1.0,
    maxHeight: 500.0,
  });
  const roadTerrain = buildMountainLoopRoadTerrain(base);

  const diagnosticMarkers = generateDiagnosticMarkers(
    base.transformer,
    roadTerrain.sampleElevation,
  ).filter((marker) => marker.name !== 'spawns_default');

  // Visual hotfix: the road surface is rendered exclusively by the native
  // ASPHALT terrain layer. The previous DecalRoad overlay produced BeamNG's
  // magenta missing-material fringe on some installations. Keeping the
  // heightfield and material layer as the single visual source also avoids
  // z-fighting and duplicated road edges.
  const levelFiles = generateLevelPackageFiles(roadTerrain.artifact, {
    title: 'TriWorld V4 Native Gate 3 — Jankov Vŕšok Mountain Circuit',
    description: 'Closed two-lane road designed in 3D first, with deterministic cut/fill terrain adaptation and native asphalt terrain surface.',
    extraMarkers: diagnosticMarkers,
    extraObjects: [],
    defaultSpawnObject: roadTerrain.roadSpawn,
    supportsTraffic: false,
  });

  const distDir = path.resolve('dist');
  fs.mkdirSync(distDir, { recursive: true });

  const zipPath = path.join(distDir, 'triworld_v4_gate3_road_loop.zip');
  const manifestPath = path.join(distDir, 'triworld_v4_gate3_road_loop.manifest.json');
  const manifest = await buildBeamNgZipPackage(
    roadTerrain.artifact,
    levelFiles,
    zipPath,
    manifestPath,
  );

  const roadManifest = {
    ...manifest,
    gate: 3,
    pipeline: 'road-first-cut-fill-v1.1',
    gisLocation: 'Jankov Vŕšok / Bánovce nad Bebravou, Slovakia',
    wgs84Center: base.transformer.origin.centerWgs84,
    road: roadTerrain.stats,
    roadMaterial: 'ASPHALT',
    visualRoadMode: 'native-terrain-layer-only',
    decalRoadOverlay: false,
    trafficSupport: false,
    visualFix: 'Removed DecalRoad overlay to eliminate magenta missing-material fringe and z-fighting.',
    terrainCorridor: {
      roadWidthMetres: 7.2,
      shoulderWidthMetres: 1.4,
      blendWidthMetres: 15.0,
      maximumDesignGrade: 0.095,
      maximumBank: 0.075,
    },
  };
  fs.writeFileSync(manifestPath, JSON.stringify(roadManifest, null, 2), 'utf-8');

  console.log('SUCCESS!');
  console.log(`ZIP package: ${zipPath}`);
  console.log(`Manifest: ${manifestPath}`);
  console.log(`Road length: ${roadTerrain.stats.roadLengthMetres.toFixed(1)} m`);
  console.log(`Road stations: ${roadTerrain.stats.stationCount}`);
  console.log(`Maximum grade: ${(roadTerrain.stats.maximumAbsoluteGrade * 100).toFixed(2)} %`);
  console.log(`Maximum bank: ${(roadTerrain.stats.maximumAbsoluteBank * 100).toFixed(2)} %`);
  console.log(`Cut/fill range: ${roadTerrain.stats.minimumCutFillMetres.toFixed(2)} m .. ${roadTerrain.stats.maximumCutFillMetres.toFixed(2)} m`);

  const targetModsPaths = [
    'C:\\Users\\tomisu\\AppData\\Local\\BeamNG.drive\\0.36\\mods\\triworld_v4_gate3_road_loop.zip',
    'C:\\Users\\tomisu\\AppData\\Local\\BeamNG\\BeamNG.drive\\current\\mods\\triworld_v4_gate3_road_loop.zip',
  ];

  for (const modPath of targetModsPaths) {
    try {
      const directory = path.dirname(modPath);
      if (!fs.existsSync(directory)) continue;
      fs.copyFileSync(zipPath, modPath);
      console.log(`Copied to BeamNG mods folder: ${modPath}`);
    } catch (error) {
      console.warn(`Could not copy to ${modPath}:`, error);
    }
  }
}

main().catch((error) => {
  console.error('Gate 3 CLI build failed:', error);
  process.exit(1);
});
