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

  transformed = replaceExactly(
    transformed,
    `    const z = engineered.mesh.positions[source + 2];\n    positions[source] = x;\n    positions[source + 1] = y;\n    positions[source + 2] = z;`,
    `    const designedZ = engineered.mesh.positions[source + 2];\n    const terrainZ = sampleTerrainElevation(x, y);\n    // Runtime-safe pavement elevation: lock the serialized DAE to the exact\n    // modified terrain grid that is written into terrain.ter. Semantic\n    // clearances retain a simple crown without allowing datum excursions.\n    const roleClearance = [0.22, 0.22, 0.26, 0.30, 0.26, 0.22, 0.22][crossSectionIndex];\n    const z = terrainZ + roleClearance;\n    if (!Number.isFinite(designedZ) || !Number.isFinite(z)) {\n      throw new Error(\`Non-finite runtime road elevation at station \${stationIndex}, role \${crossSectionIndex}.\`);\n    }\n    positions[source] = x;\n    positions[source + 1] = y;\n    positions[source + 2] = z;`,
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
