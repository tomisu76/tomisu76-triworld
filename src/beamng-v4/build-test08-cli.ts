import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const SOURCE = path.resolve('src/beamng-v4/build-gate4-nativev3-cli.ts');
const GENERATED = path.resolve('src/beamng-v4/.generated-build-test08-cli.ts');

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
    "const LEVEL_NAME = 'test08';",
    'level name',
  );

  transformed = replaceRegexExactly(
    transformed,
    /\s{4}const x = engineered\.mesh\.positions\[source\] \+ WORLD_SAMPLE_CENTER;\r?\n\s{4}const y = engineered\.mesh\.positions\[source \+ 1\] \+ WORLD_SAMPLE_CENTER;\r?\n\s{4}const z = engineered\.mesh\.positions\[source \+ 2\];\r?\n\s{4}positions\[source\] = x;\r?\n\s{4}positions\[source \+ 1\] = y;\r?\n\s{4}positions\[source \+ 2\] = z;/g,
    `    // TerrainBlock and DAE share the same local world frame. Do not mirror X or Y.
    const x = engineered.mesh.positions[source] + WORLD_SAMPLE_CENTER;
    const y = engineered.mesh.positions[source + 1] + WORLD_SAMPLE_CENTER;
    const terrainZ = sampleTerrainElevation(x, y);
    const roleClearance = [0.22, 0.22, 0.26, 0.30, 0.26, 0.22, 0.22][crossSectionIndex];
    const z = terrainZ + roleClearance;
    positions[source] = x;
    positions[source + 1] = y;
    positions[source + 2] = z;`,
    'unflipped runtime DAE frame',
  );

  transformed = replaceExactly(
    transformed,
    '    const clearance = z - sampleTerrainElevation(x, y);',
    '    const clearance = z - terrainZ;',
    'mesh clearance',
  );

  transformed = replaceRegexExactly(
    transformed,
    /\s{2}const debugMarkers: LevelMarker\[\] = \[\r?\n\s{4}\.\.\.baseMarkers,\r?\n\s{4}\.\.\.createStationMarkers\(stations, profileAnchorElevation\),\r?\n\s{2}\];/g,
    `  const spawnStation = stations[Math.min(100, stations.length - 1)];
  const spawnX = spawnStation.x + WORLD_SAMPLE_CENTER;
  const spawnY = spawnStation.y + WORLD_SAMPLE_CENTER;
  const spawnZ = sampleTerrainElevation(spawnX, spawnY) + 5.0;
  const heading = Math.atan2(spawnStation.tangentY, spawnStation.tangentX);
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  const debugMarkers: LevelMarker[] = [{
    name: 'spawns_default',
    class: 'SpawnSphere',
    __parent: 'MissionGroup',
    position: [spawnX, spawnY, spawnZ],
    rotationMatrix: [c, -s, 0, s, c, 0, 0, 0, 1],
    scale: [1, 1, 1],
    dataBlock: 'SpawnSphereMarker',
  }];`,
    'unflipped road spawn',
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
    "    title: 'TEST08 — Shared Terrain and DAE Frame',",
    'title',
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
    triworld_asphalt: {
      name: 'triworld_asphalt',
      mapTo: 'triworld_asphalt',
      class: 'Material',
      internalName: 'triworld_asphalt',
      persistentId: '7f8b91c2-3e4a-4d56-b789-0123456789ab',
      version: 1.5,
      Stages: [{
        baseColor: [1, 0.02, 0.02, 1],
        baseColorMap: \`/levels/\${LEVEL_NAME}/art/road/asphalt_d.png\`,
        roughness: 0.8,
        metalness: 0,
      }, {}, {}, {}],
      groundmodelName: 'ASPHALT',
      annotation: 'ROAD',
    },
  }, null, 2);
  const runtimeItems = levelFiles.itemsLevelJson
    .split('\\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const roadObject = runtimeItems.find((item) => item.name === 'road_surface_mesh');
  if (!roadObject) throw new Error('test08 expected road_surface_mesh in items.level.json.');
  roadObject.collisionType = 'None';
  roadObject.decalType = 'None';
  roadObject.meshCulling = false;
  roadObject.useInstanceRenderData = false;
  roadObject.isRenderEnabled = true;
  levelFiles.itemsLevelJson = runtimeItems.map((item) => JSON.stringify(item)).join('\\n');

  const distDir = path.resolve('dist');`,
    'hard terrain and unflipped visual road',
  );

  fs.writeFileSync(GENERATED, transformed, 'utf-8');
  try {
    const tsxCli = path.resolve('node_modules/tsx/dist/cli.mjs');
    const result = spawnSync(process.execPath, [tsxCli, GENERATED], {
      cwd: process.cwd(), stdio: 'inherit', env: process.env,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`test08 build exited with code ${result.status}.`);
  } finally {
    if (fs.existsSync(GENERATED)) fs.unlinkSync(GENERATED);
  }
}

try { main(); } catch (error) {
  console.error('FATAL TEST08 BUILD ERROR:', error);
  process.exit(1);
}
