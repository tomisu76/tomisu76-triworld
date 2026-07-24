import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const SOURCE = path.resolve('src/beamng-v4/build-gate4-nativev3-cli.ts');
const GENERATED = path.resolve('src/beamng-v4/.generated-build-test02-cli.ts');

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
    "const LEVEL_NAME = 'test02';",
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
    /\s{4}const x = engineered\.mesh\.positions\[source\] \+ WORLD_SAMPLE_CENTER;\r?\n\s{4}const y = engineered\.mesh\.positions\[source \+ 1\] \+ WORLD_SAMPLE_CENTER;\r?\n\s{4}const z = engineered\.mesh\.positions\[source \+ 2\];\r?\n\s{4}positions\[source\] = x;\r?\n\s{4}positions\[source \+ 1\] = y;\r?\n\s{4}positions\[source \+ 2\] = z;/g,
    `    const logicalX = engineered.mesh.positions[source] + WORLD_SAMPLE_CENTER;\n    const logicalY = engineered.mesh.positions[source + 1] + WORLD_SAMPLE_CENTER;\n    // BeamNG terrain rows reverse the logical GIS Y axis; X remains unchanged.\n    const x = logicalX;\n    const y = WORLD_RUNTIME_SPAN - logicalY;\n    const terrainZ = sampleTerrainElevation(logicalX, logicalY);\n    const roleClearance = [0.22, 0.22, 0.26, 0.30, 0.26, 0.22, 0.22][crossSectionIndex];\n    const z = terrainZ + roleClearance;\n    positions[source] = x;\n    positions[source + 1] = y;\n    positions[source + 2] = z;`,
    'runtime DAE Y frame',
  );

  transformed = replaceExactly(
    transformed,
    '    const clearance = z - sampleTerrainElevation(x, y);',
    '    const clearance = z - terrainZ;',
    'mesh clearance',
  );

  transformed = replaceExactly(
    transformed,
    "  const daeAudit = parseDaeVerticesAndAuditClearance(roadDae, sampleTerrainElevation);",
    `  const sampleRuntimeTerrainElevation = (x: number, y: number): number =>\n    sampleTerrainElevation(x, WORLD_RUNTIME_SPAN - y);\n  const daeAudit = parseDaeVerticesAndAuditClearance(roadDae, sampleRuntimeTerrainElevation);`,
    'runtime audit sampler',
  );

  transformed = replaceRegexExactly(
    transformed,
    /\s{2}const debugMarkers: LevelMarker\[\] = \[\r?\n\s{4}\.\.\.baseMarkers,\r?\n\s{4}\.\.\.createStationMarkers\(stations, profileAnchorElevation\),\r?\n\s{2}\];/g,
    `  const spawnStation = stations[Math.min(20, stations.length - 1)];\n  const spawnLogicalX = spawnStation.x + WORLD_SAMPLE_CENTER;\n  const spawnLogicalY = spawnStation.y + WORLD_SAMPLE_CENTER;\n  const spawnRuntimeX = spawnLogicalX;\n  const spawnRuntimeY = WORLD_RUNTIME_SPAN - spawnLogicalY;\n  const spawnRuntimeZ = sampleTerrainElevation(spawnLogicalX, spawnLogicalY) + 1.5;\n  const heading = Math.atan2(-spawnStation.tangentY, spawnStation.tangentX);\n  const c = Math.cos(heading);\n  const s = Math.sin(heading);\n  const debugMarkers: LevelMarker[] = [{\n    name: 'spawns_default',\n    class: 'SpawnSphere',\n    __parent: 'MissionGroup',\n    position: [spawnRuntimeX, spawnRuntimeY, spawnRuntimeZ],\n    rotationMatrix: [c, -s, 0, s, c, 0, 0, 0, 1],\n    scale: [1, 1, 1],\n    dataBlock: 'SpawnSphereMarker',\n  }];`,
    'road spawn',
  );

  transformed = replaceExactly(
    transformed,
    "    title: 'TriWorld V4 Native Gate 4 — SUMO Engineered Road and Subgrade',",
    "    title: 'TEST02 — Y Frame Road Alignment',",
    'title',
  );

  fs.writeFileSync(GENERATED, transformed, 'utf-8');
  try {
    const tsxCli = path.resolve('node_modules/tsx/dist/cli.mjs');
    const result = spawnSync(process.execPath, [tsxCli, GENERATED], {
      cwd: process.cwd(), stdio: 'inherit', env: process.env,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`test02 build exited with code ${result.status}.`);
  } finally {
    if (fs.existsSync(GENERATED)) fs.unlinkSync(GENERATED);
  }
}

try { main(); } catch (error) {
  console.error('FATAL TEST02 BUILD ERROR:', error);
  process.exit(1);
}
