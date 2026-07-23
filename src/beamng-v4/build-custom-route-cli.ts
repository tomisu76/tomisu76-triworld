import fs from 'node:fs';
import path from 'node:path';
import { buildCustomRouteTerrain } from './custom-route-terrain';
import type { LevelMarker } from './diagnostic-markers';
import { generateLevelPackageFiles } from './level-generator';
import type { RoadFirstStation } from './road-first-terrain';
import { loadRouteDefinition } from './route-input';
import { buildBeamNgZipPackage } from './zip-builder';

async function main(): Promise<void> {
  const routePath = process.argv[2] ?? 'routes/jankov-vrsok-demo.route.json';
  const route = loadRouteDefinition(routePath);
  console.log(`Building TriWorld V4 custom route: ${route.name}`);

  const result = buildCustomRouteTerrain(route, {
    size: 1024,
    squareSize: 1,
    maxHeight: 500,
  });
  const spawnSelection = selectStableSpawnStation(result.roadStations);
  const spawn = createRoadSpawnMarker(
    spawnSelection.station,
    spawnSelection.next,
    result.sampleElevation,
  );

  const files = generateLevelPackageFiles(result.artifact, {
    title: `TriWorld V4 Route — ${route.name}`,
    description: 'User-defined WGS84 route converted into an engineered BeamNG road, collision terrain and AI DecalRoad',
    extraMarkers: [spawn],
    extraObjects: [result.road as unknown as Record<string, unknown>],
  });

  const outputDirectory = path.resolve('dist');
  fs.mkdirSync(outputDirectory, { recursive: true });
  const zipPath = path.join(outputDirectory, 'triworld_v4_custom_route.zip');
  const manifestPath = path.join(outputDirectory, 'triworld_v4_custom_route.manifest.json');
  const normalisedRoutePath = path.join(outputDirectory, 'triworld_v4_custom_route.input.json');
  const nativeManifest = await buildBeamNgZipPackage(result.artifact, files, zipPath, manifestPath);

  const manifest = {
    ...nativeManifest,
    gate: 'V4 Gate 4 custom WGS84 route input',
    routeSource: path.normalize(routePath),
    route: {
      name: route.name,
      closed: true,
      inputControlPoints: route.points.length,
      localControlPoints: result.controlPointsLocal,
      roadWidth: result.roadStations[0].width,
      objectName: result.road.name,
      drivability: result.road.drivability,
      nodes: result.road.nodes.length,
      ...result.stats,
    },
    map: {
      wgs84Center: result.transformer.origin.centerWgs84,
      utmCenter: result.transformer.origin.centerUtm,
      sizeMetres: result.transformer.origin.sizeMetres,
    },
    spawn: {
      station: spawnSelection.station.station,
      position: spawn.position,
    },
  };

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(normalisedRoutePath, JSON.stringify(route, null, 2), 'utf8');
  console.log(`SUCCESS: ${zipPath}`);
  console.log(`Manifest: ${manifestPath}`);
  console.log(`Input: ${normalisedRoutePath}`);
  console.log(JSON.stringify(manifest.route, null, 2));
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
  return { station: stations[bestIndex], next: stations[bestIndex + 1] };
}

function createRoadSpawnMarker(
  station: RoadFirstStation,
  next: RoadFirstStation,
  sampleElevation: (x: number, y: number) => number,
): LevelMarker {
  const rightLaneOffset = station.width * 0.23;
  const x = station.x - station.normalX * rightLaneOffset;
  const y = station.y - station.normalY * rightLaneOffset;
  return {
    name: 'spawns_default',
    class: 'SpawnSphere',
    __parent: 'MissionGroup',
    position: [x, y, sampleElevation(x, y) + 0.65],
    rotationMatrix: headingRotationMatrix(station.x, station.y, next.x, next.y),
    scale: [1, 1, 1],
    dataBlock: 'SpawnSphereMarker',
    description: 'Stable right-lane spawn on the user-defined route',
  };
}

function headingRotationMatrix(x0: number, y0: number, x1: number, y1: number): number[] {
  const heading = Math.atan2(y1 - y0, x1 - x0);
  const cosine = Math.cos(heading);
  const sine = Math.sin(heading);
  return [cosine, -sine, 0, sine, cosine, 0, 0, 0, 1];
}

main().catch((error) => {
  console.error('Custom route V4 build failed:', error);
  process.exitCode = 1;
});
