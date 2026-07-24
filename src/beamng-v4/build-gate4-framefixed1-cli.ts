import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const SOURCE = path.resolve('src/beamng-v4/build-gate4-nativev3-cli.ts');
const GENERATED = path.resolve('src/beamng-v4/.generated-build-gate4-framefixed1-cli.ts');

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
    throw new Error(`${label}: expected exactly one regex anchor, found ${matches?.length ?? 0}.`);
  }
  return source.replace(pattern, replacement);
}

function main(): void {
  let transformed = fs.readFileSync(SOURCE, 'utf-8');

  transformed = replaceExactly(
    transformed,
    "const LEVEL_NAME = 'triworld_v4_gate4_nativev3_real1';",
    "const LEVEL_NAME = 'triworld_v4_gate4_framefixed1';",
    'level name',
  );

  transformed = replaceExactly(
    transformed,
    'const WORLD_SAMPLE_CENTER = ((SIZE - 1) * SQUARE_SIZE) / 2;',
    'const WORLD_SAMPLE_CENTER = ((SIZE - 1) * SQUARE_SIZE) / 2;\nconst WORLD_RUNTIME_SPAN = (SIZE - 1) * SQUARE_SIZE;',
    'runtime span constant',
  );

  transformed = replaceRegexExactly(
    transformed,
    /\s{4}const x = engineered\.mesh\.positions\[source\] \+ WORLD_SAMPLE_CENTER;\r?\n\s{4}const y = engineered\.mesh\.positions\[source \+ 1\] \+ WORLD_SAMPLE_CENTER;\r?\n\s{4}const z = engineered\.mesh\.positions\[source \+ 2\];\r?\n\s{4}positions\[source\] = x;\r?\n\s{4}positions\[source \+ 1\] = y;\r?\n\s{4}positions\[source \+ 2\] = z;/g,
    `    const logicalX = engineered.mesh.positions[source] + WORLD_SAMPLE_CENTER;\n    const logicalY = engineered.mesh.positions[source + 1] + WORLD_SAMPLE_CENTER;\n    // BeamNG's native terrain height rows are interpreted in the opposite runtime\n    // frame from the GIS raster. The accepted orthophoto already uses the same 180°\n    // correction. Rotate the DAE around the terrain centre so the road mesh lands on\n    // the actual deformed corridor instead of the opposite side of the TerrainBlock.\n    const x = WORLD_RUNTIME_SPAN - logicalX;\n    const y = WORLD_RUNTIME_SPAN - logicalY;\n    const terrainZ = sampleTerrainElevation(logicalX, logicalY);\n    const roleClearance = [0.22, 0.22, 0.26, 0.30, 0.26, 0.22, 0.22][crossSectionIndex];\n    const z = terrainZ + roleClearance;\n    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {\n      throw new Error(\`Non-finite runtime road vertex at station \${stationIndex}, role \${crossSectionIndex}.\`);\n    }\n    positions[source] = x;\n    positions[source + 1] = y;\n    positions[source + 2] = z;`,
    'runtime DAE frame and elevation',
  );

  transformed = replaceExactly(
    transformed,
    '    const clearance = z - sampleTerrainElevation(x, y);',
    '    const clearance = z - terrainZ;',
    'mesh clearance audit',
  );

  transformed = replaceExactly(
    transformed,
    "  const daeAudit = parseDaeVerticesAndAuditClearance(roadDae, sampleTerrainElevation);",
    `  const sampleRuntimeTerrainElevation = (x: number, y: number): number =>\n    sampleTerrainElevation(WORLD_RUNTIME_SPAN - x, WORLD_RUNTIME_SPAN - y);\n  const daeAudit = parseDaeVerticesAndAuditClearance(roadDae, sampleRuntimeTerrainElevation);`,
    'runtime DAE audit sampler',
  );

  transformed = replaceRegexExactly(
    transformed,
    /\s{2}const debugMarkers: LevelMarker\[\] = \[\r?\n\s{4}\.\.\.baseMarkers,\r?\n\s{4}\.\.\.createStationMarkers\(stations, profileAnchorElevation\),\r?\n\s{2}\];/g,
    `  // No diagnostic TSStatic markers in the runtime-frame validation level.\n  // This prevents missing marker assets from appearing as unrelated floating objects.\n  const debugMarkers: LevelMarker[] = [];`,
    'diagnostic marker removal',
  );

  transformed = replaceExactly(
    transformed,
    "    title: 'TriWorld V4 Native Gate 4 — SUMO Engineered Road and Subgrade',",
    "    title: 'TriWorld V4 Gate 4 — Runtime Frame Fixed Road',",
    'level title',
  );

  transformed = replaceExactly(
    transformed,
    "      'and a seven-point engineered asphalt road surface.',",
    "      'a seven-point engineered asphalt road surface, and a corrected BeamNG runtime frame.',",
    'level description',
  );

  transformed = replaceExactly(
    transformed,
    '    worldSampleCenterMetres: WORLD_SAMPLE_CENTER,',
    '    worldSampleCenterMetres: WORLD_SAMPLE_CENTER,\n    runtimeFrameRotationDegrees: 180,',
    'report runtime frame',
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
      throw new Error(`Frame-fixed Gate 4 build exited with code ${result.status}.`);
    }
  } finally {
    if (fs.existsSync(GENERATED)) fs.unlinkSync(GENERATED);
  }
}

try {
  main();
} catch (error) {
  console.error('FATAL FRAME-FIXED GATE 4 BUILD ERROR:', error);
  process.exit(1);
}
