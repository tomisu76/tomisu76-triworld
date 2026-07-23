import fs from 'node:fs';
import path from 'node:path';
import { generateDiagnosticMarkers } from './diagnostic-markers';
import { generateLevelPackageFiles } from './level-generator';
import { buildMountainLoopRoadFirstTerrain } from './road-first-terrain';
import { buildBeamNgZipPackage } from './zip-builder';

async function main(): Promise<void> {
  console.log('Building TriWorld V4 road-first mountain circuit...');
  const result = buildMountainLoopRoadFirstTerrain({
    size: 1024,
    squareSize: 1,
    maxHeight: 500,
    roadWidth: 7.2,
    shoulderWidth: 1.6,
    // Conservative solver target leaves reserve below the 10% acceptance ceiling.
    maximumGrade: 0.075,
    maximumBank: 0.045,
    designSpeedKmh: 55,
    stationSpacing: 4,
  });

  const markers = generateDiagnosticMarkers(result.transformer, result.sampleElevation);
  const spawn = markers.find((marker) => marker.name === 'spawns_default');
  const first = result.roadStations[0];
  const second = result.roadStations[1];
  if (spawn) {
    spawn.position = [first.x, first.y, first.z + 2.2];
    spawn.rotationMatrix = headingRotationMatrix(first.x, first.y, second.x, second.y);
    spawn.description = 'Road-first mountain loop start';
  }

  const levelFiles = generateLevelPackageFiles(result.artifact, {
    title: 'TriWorld V4 Road-First Mountain Circuit',
    description: 'Closed engineered mountain road with terrain cut/fill, banking, collision and AI navigation',
    extraMarkers: markers,
    extraObjects: [result.road as unknown as Record<string, unknown>],
  });

  const distDir = path.resolve('dist');
  fs.mkdirSync(distDir, { recursive: true });
  const zipPath = path.join(distDir, 'triworld_v4_road_first.zip');
  const manifestPath = path.join(distDir, 'triworld_v4_road_first.manifest.json');
  const nativeManifest = await buildBeamNgZipPackage(result.artifact, levelFiles, zipPath, manifestPath);
  const manifest = {
    ...nativeManifest,
    gate: 'V4 road-first corridor',
    location: 'Jankov vŕšok / Uhrovec area, Slovakia',
    wgs84Center: result.transformer.origin.centerWgs84,
    utmCenter: result.transformer.origin.centerUtm,
    road: {
      objectClass: result.road.class,
      objectName: result.road.name,
      material: result.road.material,
      drivability: result.road.drivability,
      closed: true,
      nodes: result.road.nodes.length,
      ...result.stats,
    },
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  console.log(`SUCCESS: ${zipPath}`);
  console.log(`Manifest: ${manifestPath}`);
  console.log(JSON.stringify(manifest.road, null, 2));

  const targets = [
    'C:\\Users\\tomisu\\AppData\\Local\\BeamNG\\BeamNG.drive\\current\\mods\\triworld_v4_road_first.zip',
    'C:\\Users\\tomisu\\AppData\\Local\\BeamNG.drive\\0.36\\mods\\triworld_v4_road_first.zip',
  ];
  for (const target of targets) {
    try {
      if (fs.existsSync(path.dirname(target))) {
        fs.copyFileSync(zipPath, target);
        console.log(`Copied to ${target}`);
      }
    } catch (error) {
      console.warn(`Could not copy to ${target}:`, error);
    }
  }
}

function headingRotationMatrix(x0: number, y0: number, x1: number, y1: number): number[] {
  const heading = Math.atan2(y1 - y0, x1 - x0);
  const cosine = Math.cos(heading);
  const sine = Math.sin(heading);
  return [cosine, -sine, 0, sine, cosine, 0, 0, 0, 1];
}

main().catch((error) => {
  console.error('Road-first V4 build failed:', error);
  process.exitCode = 1;
});
