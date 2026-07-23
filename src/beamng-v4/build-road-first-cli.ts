import fs from 'node:fs';
import path from 'node:path';
import type { LevelMarker } from './diagnostic-markers';
import { generateLevelPackageFiles } from './level-generator';
import { buildValidatedMountainLoopTerrain } from './road-first-finalizer';
import type { RoadFirstStation } from './road-first-terrain';
import { buildBeamNgZipPackage } from './zip-builder';

async function main(): Promise<void> {
  console.log('Building TriWorld V4 road-first mountain circuit...');
  const result = buildValidatedMountainLoopTerrain({
    size: 1024,
    squareSize: 1,
    maxHeight: 500,
    roadWidth: 7.2,
    shoulderWidth: 1.8,
    maximumGrade: 0.10,
    maximumBank: 0.045,
    designSpeedKmh: 55,
    stationSpacing: 4,
    minimumBlendWidth: 22,
    maximumBlendWidth: 70,
  });

  const spawnSelection = selectStableSpawnStation(result.roadStations);
  const spawn = createRoadSpawnMarker(
    spawnSelection.station,
    spawnSelection.next,
    result.sampleElevation,
  );

  const levelFiles = generateLevelPackageFiles(result.artifact, {
    title: 'TriWorld V4 Road-First Mountain Circuit',
    description: 'Closed engineered mountain road with smooth terrain cut/fill, natural materials, collision and AI navigation',
    extraMarkers: [spawn],
    extraObjects: [result.road as unknown as Record<string, unknown>],
  });

  const distDir = path.resolve('dist');
  fs.mkdirSync(distDir, { recursive: true });
  const zipPath = path.join(distDir, 'triworld_v4_road_first.zip');
  const manifestPath = path.join(distDir, 'triworld_v4_road_first.manifest.json');
  const nativeManifest = await buildBeamNgZipPackage(result.artifact, levelFiles, zipPath, manifestPath);
  const manifest = {
    ...nativeManifest,
    gate: 'V4 road-first corridor visual and AI refinement',
    location: 'Jankov vŕšok / Uhrovec area, Slovakia',
    wgs84Center: result.transformer.origin.centerWgs84,
    utmCenter: result.transformer.origin.centerUtm,
    spawn: {
      station: spawnSelection.station.station,
      position: spawn.position,
      rightLaneOffsetMetres: result.roadStations[0].width * 0.23,
    },
    road: {
      objectClass: result.road.class,
      objectName: result.road.name,
      material: result.road.material,
      drivability: result.road.drivability,
      improvedSpline: (result.road as unknown as Record<string, unknown>).improvedSpline,
      useSubdivisions: (result.road as unknown as Record<string, unknown>).useSubdivisions,
      lanesLeft: (result.road as unknown as Record<string, unknown>).lanesLeft,
      lanesRight: (result.road as unknown as Record<string, unknown>).lanesRight,
      closed: true,
      nodes: result.road.nodes.length,
      ...result.stats,
    },
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  console.log(`SUCCESS: ${zipPath}`);
  console.log(`Manifest: ${manifestPath}`);
  console.log(JSON.stringify({ spawn: manifest.spawn, road: manifest.road }, null, 2));

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

function selectStableSpawnStation(stations: readonly RoadFirstStation[]): {
  station: RoadFirstStation;
  next: RoadFirstStation;
} {
  const lastUniqueIndex = stations.length - 2;
  const totalLength = stations[stations.length - 1].station;
  let bestIndex = Math.min(20, lastUniqueIndex - 1);
  let bestScore = Number.POSITIVE_INFINITY;

  for (let index = 2; index < lastUniqueIndex - 2; index++) {
    const station = stations[index];
    if (station.station < 80 || station.station > totalLength - 80) continue;
    const previous = stations[index - 1];
    const next = stations[index + 1];
    const run = Math.max(0.1, Math.hypot(next.x - station.x, next.y - station.y));
    const grade = Math.abs(next.z - station.z) / run;
    const tangentDot = Math.max(-1, Math.min(1,
      previous.tangentX * next.tangentX + previous.tangentY * next.tangentY,
    ));
    const curvature = Math.acos(tangentDot);
    const score = grade * 6 + Math.abs(station.bank) * 8 + curvature * 0.7;
    if (score < bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  return {
    station: stations[bestIndex],
    next: stations[bestIndex + 1],
  };
}

function createRoadSpawnMarker(
  station: RoadFirstStation,
  next: RoadFirstStation,
  sampleElevation: (x: number, y: number) => number,
): LevelMarker {
  const rightLaneOffset = station.width * 0.23;
  const x = station.x - station.normalX * rightLaneOffset;
  const y = station.y - station.normalY * rightLaneOffset;
  const z = sampleElevation(x, y) + 0.65;
  return {
    name: 'spawns_default',
    class: 'SpawnSphere',
    __parent: 'MissionGroup',
    position: [x, y, z],
    rotationMatrix: headingRotationMatrix(station.x, station.y, next.x, next.y),
    scale: [1, 1, 1],
    dataBlock: 'SpawnSphereMarker',
    description: 'Stable right-lane start on the generated mountain circuit',
  };
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
