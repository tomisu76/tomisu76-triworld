import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const SOURCE = path.resolve('src/beamng-v4/build-gate4-nativev3-cli.ts');
const GENERATED = path.resolve('src/beamng-v4/.generated-build-roadfix01-cli.ts');

function replaceExactly(source: string, oldValue: string, newValue: string, label: string): string {
  const count = source.split(oldValue).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one anchor, found ${count}.`);
  return source.replace(oldValue, newValue);
}

function replaceRegexExactly(source: string, pattern: RegExp, replacement: string, label: string): string {
  const matches = source.match(pattern);
  if (!matches || matches.length !== 1) {
    throw new Error(`${label}: expected one regex anchor, found ${matches?.length ?? 0}.`);
  }
  return source.replace(pattern, replacement);
}

function main(): void {
  let transformed = fs.readFileSync(SOURCE, 'utf-8');

  transformed = replaceExactly(
    transformed,
    "const LEVEL_NAME = 'triworld_v4_gate4_nativev3_real1';",
    "const LEVEL_NAME = 'roadfix01';",
    'level name',
  );

  transformed = replaceExactly(
    transformed,
    'const WORLD_SAMPLE_CENTER = ((SIZE - 1) * SQUARE_SIZE) / 2;',
    'const WORLD_SAMPLE_CENTER = ((SIZE - 1) * SQUARE_SIZE) / 2;\nconst WORLD_RUNTIME_SPAN = (SIZE - 1) * SQUARE_SIZE;',
    'runtime span',
  );

  transformed = replaceRegexExactly(
    transformed,
    /\s{2}const debugMarkers: LevelMarker\[\] = \[\r?\n\s{4}\.\.\.baseMarkers,\r?\n\s{4}\.\.\.createStationMarkers\(stations, profileAnchorElevation\),\r?\n\s{2}\];/g,
    `  const spawnStation = stations[Math.min(100, stations.length - 1)];
  const spawnLogicalX = spawnStation.x + WORLD_SAMPLE_CENTER;
  const spawnLogicalY = spawnStation.y + WORLD_SAMPLE_CENTER;
  const spawnRuntimeX = spawnLogicalX;
  const spawnRuntimeY = WORLD_RUNTIME_SPAN - spawnLogicalY;
  const spawnRuntimeZ = sampleTerrainElevation(spawnLogicalX, spawnLogicalY) + 5.0;
  const heading = Math.atan2(-spawnStation.tangentY, spawnStation.tangentX);
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  const debugMarkers: LevelMarker[] = [{
    name: 'spawns_default',
    class: 'SpawnSphere',
    __parent: 'MissionGroup',
    position: [spawnRuntimeX, spawnRuntimeY, spawnRuntimeZ],
    rotationMatrix: [c, -s, 0, s, c, 0, 0, 0, 1],
    scale: [1, 1, 1],
    dataBlock: 'SpawnSphereMarker',
  }];`,
    'safe projected-road spawn',
  );

  transformed = replaceExactly(
    transformed,
    '    materialNames: [`${LEVEL_NAME}_ground`],',
    "    materialNames: ['ASPHALT'],",
    'terrain material names',
  );

  transformed = replaceExactly(
    transformed,
    "    title: 'TriWorld V4 Native Gate 4 — SUMO Engineered Road and Subgrade',",
    "    title: 'ROADFIX01 — Terrain Projected SUMO Road',",
    'title',
  );

  transformed = replaceExactly(
    transformed,
    '    roadDae,',
    '    roadDae: undefined,',
    'remove runtime DAE road',
  );

  transformed = replaceExactly(
    transformed,
    "  const distDir = path.resolve('dist');",
    `  levelFiles.terrainJson = JSON.stringify({
    ...JSON.parse(levelFiles.terrainJson),
    materials: ['ASPHALT'],
  }, null, 2);

  levelFiles.materialsJson = JSON.stringify({
    ASPHALT: {
      class: 'TerrainMaterial',
      internalName: 'ASPHALT',
      diffuseMap: \`/levels/\${LEVEL_NAME}/art/terrains/ground_d.png\`,
      diffuseSize: 1024,
      annotation: 'ROAD',
    },
    roadfix_asphalt: {
      name: 'roadfix_asphalt',
      mapTo: 'roadfix_asphalt',
      class: 'Material',
      internalName: 'roadfix_asphalt',
      persistentId: '98f8ce35-88bd-40e6-8f08-5abf1c98d201',
      version: 1.5,
      Stages: [{
        baseColor: [0.12, 0.12, 0.12, 1],
        baseColorMap: \`/levels/\${LEVEL_NAME}/art/road/asphalt_d.png\`,
        roughness: 0.88,
        metalness: 0,
      }, {}, {}, {}],
      translucent: true,
      translucentZWrite: true,
      groundmodelName: 'ASPHALT',
      annotation: 'ROAD',
    },
  }, null, 2);

  const decalNodes = stations
    .filter((_station, index) => index % 5 === 0 || index === stations.length - 1)
    .map((station) => [
      station.x + WORLD_SAMPLE_CENTER,
      WORLD_RUNTIME_SPAN - (station.y + WORLD_SAMPLE_CENTER),
      0,
      roadMetadata.laneWidthMetres,
    ]);

  const runtimeItems = levelFiles.itemsLevelJson
    .split('\\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  runtimeItems.push({
    name: 'road_surface_decal',
    class: 'DecalRoad',
    __parent: 'MissionGroup',
    material: 'roadfix_asphalt',
    textureLength: 5,
    renderPriority: 10,
    drivability: 1,
    autoLanes: true,
    autoJunction: false,
    oneWay: false,
    flipDirection: false,
    overObjects: false,
    zBias: 0.001,
    decalBias: 0.01,
    breakAngle: 3,
    nodes: decalNodes,
  });

  levelFiles.itemsLevelJson = runtimeItems.map((item) => JSON.stringify(item)).join('\\n');

  const distDir = path.resolve('dist');`,
    'hard terrain and projected DecalRoad',
  );

  fs.writeFileSync(GENERATED, transformed, 'utf-8');
  try {
    const tsxCli = path.resolve('node_modules/tsx/dist/cli.mjs');
    const result = spawnSync(process.execPath, [tsxCli, GENERATED], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: process.env,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`roadfix01 build exited with code ${result.status}.`);
  } finally {
    if (fs.existsSync(GENERATED)) fs.unlinkSync(GENERATED);
  }
}

try {
  main();
} catch (error) {
  console.error('FATAL ROADFIX01 BUILD ERROR:', error);
  process.exit(1);
}
