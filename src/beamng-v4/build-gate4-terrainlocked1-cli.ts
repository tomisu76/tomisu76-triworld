import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const SOURCE = path.resolve('src/beamng-v4/build-gate4-nativev3-cli.ts');
const GENERATED = path.resolve('src/beamng-v4/.generated-build-gate4-terrainlocked1-cli.ts');

function replaceExactly(source: string, oldValue: string, newValue: string, label: string): string {
  const count = source.split(oldValue).length - 1;
  if (count !== 1) {
    throw new Error(`${label}: expected exactly one replacement anchor, found ${count}.`);
  }
  return source.replace(oldValue, newValue);
}

function replaceRegexExactly(source: string, pattern: RegExp, replacement: string, label: string): string {
  const matches = source.match(pattern);
  if (!matches || matches.length !== 1) {
    throw new Error(`${label}: expected exactly one regex replacement anchor, found ${matches?.length ?? 0}.`);
  }
  return source.replace(pattern, replacement);
}

function main(): void {
  let transformed = fs.readFileSync(SOURCE, 'utf-8');

  transformed = replaceExactly(
    transformed,
    "const LEVEL_NAME = 'triworld_v4_gate4_nativev3_real1';",
    "const LEVEL_NAME = 'triworld_v4_gate4_terrainlocked1';",
    'level name',
  );

  transformed = replaceExactly(
    transformed,
    "source: 'Gate 4 SUMO-coupled subgrade terrain',",
    "source: 'Gate 4 terrain-locked runtime pavement',",
    'elevation source label',
  );

  transformed = replaceRegexExactly(
    transformed,
    /    const z = engineered\.mesh\.positions\[source \+ 2\];\r?\n    positions\[source\] = x;\r?\n    positions\[source \+ 1\] = y;\r?\n    positions\[source \+ 2\] = z;/g,
    `    const designedZ = engineered.mesh.positions[source + 2];
    const terrainZ = sampleTerrainElevation(x, y);
    // Runtime-safe pavement elevation: lock the serialized DAE to the exact
    // modified terrain grid that is written into terrain.ter. Semantic
    // clearances retain a simple crown without allowing datum excursions.
    const roleClearance = [0.22, 0.22, 0.26, 0.30, 0.26, 0.22, 0.22][crossSectionIndex];
    const z = terrainZ + roleClearance;
    if (!Number.isFinite(designedZ) || !Number.isFinite(z)) {
      throw new Error(\`Non-finite runtime road elevation at station \${stationIndex}, role \${crossSectionIndex}.\`);
    }
    positions[source] = x;
    positions[source + 1] = y;
    positions[source + 2] = z;`,
    'runtime DAE elevation',
  );

  transformed = replaceExactly(
    transformed,
    '    const clearance = z - sampleTerrainElevation(x, y);',
    '    const clearance = z - terrainZ;',
    'runtime clearance audit',
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
    if (result.status !== 0) {
      throw new Error(`Terrain-locked Gate 4 build exited with code ${result.status}.`);
    }
  } finally {
    if (fs.existsSync(GENERATED)) fs.unlinkSync(GENERATED);
  }
}

try {
  main();
} catch (error) {
  console.error('FATAL TERRAIN-LOCKED GATE 4 BUILD ERROR:', error);
  process.exit(1);
}
