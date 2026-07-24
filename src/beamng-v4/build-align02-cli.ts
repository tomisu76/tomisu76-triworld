// Build align02 diagnostic level - based on working align01 template
// Added texture maps and updated widths for visual identification (A=1.0m, B=1.5m, C=2.0m, D=2.5m)
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

// Use the working ALIGN01 template as base
const SOURCE = path.resolve('src/beamng-v4/build-align01-cli.ts');
const GENERATED = path.resolve('src/beamng-v4/.generated-build-align02-cli.ts');

function replaceExactly(source, oldValue, newValue, label) {
  const count = source.split(oldValue).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one anchor, found ${count}.`);
  return source.replace(oldValue, newValue);
}

function replaceRegexExactly(source, pattern, replacement, label) {
  const matches = source.match(pattern);
  if (!matches || matches.length !== 1) {
    throw new Error(`${label}: expected one regex anchor, found ${matches?.length ?? 0}.`);
  }
  return source.replace(pattern, replacement);
}

function main() {
  let transformed = fs.readFileSync(SOURCE, 'utf8');

  // Update level name and title
  transformed = replaceExactly(
    transformed,
    "const LEVEL_NAME = 'align01';",
    "const LEVEL_NAME = 'align02';",
    'level name'
  );

  transformed = replaceExactly(
    transformed,
    "    title: 'ALIGN01 — Four-Frame DecalRoad Alignment Diagnostic',",
    "    title: 'ALIGN02 — Textured Four-Frame Alignment Diagnostic',",
    'title'
  );

  // Update materials to include texture maps (align01 had baseColor only)
  transformed = replaceExactly(
    transformed,
    '    ASPHALT: {',
    `    ASPHALT: {
      class: 'TerrainMaterial',
      internalName: 'ASPHALT',
      diffuseMap: `/levels/\${LEVEL_NAME}/art/terrains/ground_d.png`,
      diffuseSize: 1024,
      annotation: 'ROAD',
    },
    alignment_red: {
      name: 'alignment_red',
      mapTo: 'alignment_red',
      class: 'Material',
      internalName: 'alignment_red',
      persistentId: '11111111-1111-4111-8111-111111111111',
      version: 1.5,
      Stages: [{
        baseColor: [1, 0, 0, 1],
        baseColorMap: `/levels/\${LEVEL_NAME}/art/road/alignment_red_d.png`,
        roughness: 0.9,
        metalness: 0,
      }, {}, {}, {}],
      translucent: false,
      groundmodelName: 'ASPHALT',
      annotation: 'ROAD',
    },
    alignment_blue: {
      name: 'alignment_blue',
      mapTo: 'alignment_blue',
      class: 'Material',
      internalName: 'alignment_blue',
      persistentId: '22222222-2222-4222-8222-222222222222',
      version: 1.5,
      Stages: [{
        baseColor: [0, 0.2, 1, 1],
        baseColorMap: `/levels/\${LEVEL_NAME}/art/road/alignment_blue_d.png`,
        roughness: 0.9,
        metalness: 0,
      }, {}, {}, {}],
      translucent: false,
      groundmodelName: 'ASPHALT',
      annotation: 'ROAD',
    },
    alignment_yellow: {
      name: 'alignment_yellow',
      mapTo: 'alignment_yellow',
      class: 'Material',
      internalName: 'alignment_yellow',
      persistentId: '33333333-3333-4333-8333-333333333333',
      version: 1.5,
      Stages: [{
        baseColor: [1, 1, 0, 1],
        baseColorMap: `/levels/\${LEVEL_NAME}/art/road/alignment_yellow_d.png`,
        roughness: 0.9,
        metalness: 0,
      }, {}, {}, {}],
      translucent: false,
      groundmodelName: 'ASPHALT',
      annotation: 'ROAD',
    },
    alignment_magenta: {
      name: 'alignment_magenta',
      mapTo: 'alignment_magenta',
      class: 'Material',
      internalName: 'alignment_magenta',
      persistentId: '44444444-4444-4444-8444-444444444444',
      version: 1.5,
      Stages: [{
        baseColor: [1, 0, 1, 1],
        baseColorMap: `/levels/\${LEVEL_NAME}/art/road/alignment_magenta_d.png`,
        roughness: 0.9,
        metalness: 0,
      }, {}, {}, {}],
      translucent: false,
      groundmodelName: 'ASPHALT',
      annotation: 'ROAD',
    },`,
    'hard terrain and alignment materials'
  );

  // Update spawn to include alignmentDecalRoads (keep the working pattern)
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
  }, ...alignmentDecalRoads];`,
    'safe spawn with alignment decals'
  );

  // Ensure road art directory exists before build
  transformed = replaceExactly(
    transformed,
    "  const distDir = path.resolve('dist');",
    `  const roadArtDir = path.join(distDir, LEVEL_NAME, 'art', 'road');
  if (!fs.existsSync(roadArtDir)) {
    fs.mkdirSync(roadArtDir, { recursive: true });
  }

  const distDir = path.resolve('dist');`,
    'ensure road art directory'
  );

  fs.writeFileSync(GENERATED, transformed, 'utf8');
  try {
    const tsxCli = path.resolve('node_modules/tsx/dist/cli.mjs');
    const result = spawnSync(process.execPath, [tsxCli, GENERATED], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: process.env,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`align02 build exited with code ${result.status}.`);
  } finally {
    if (fs.existsSync(GENERATED)) fs.unlinkSync(GENERATED);
  }
}

try {
  main();
} catch (error) {
  console.error('FATAL ALIGN02 BUILD ERROR:', error);
  process.exit(1);
}

// Generate texture files
console.log('Generating align02 color textures...');

function createColorTexture(r, g, b, filename) {
  const size = 64;
  const data = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = 255;
    }
  }
  const outputDir = path.join('dist', 'align02', 'art', 'road');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  const fullPath = path.join(outputDir, filename);
  fs.writeFileSync(fullPath, data);
  console.log(`Generated texture: ${fullPath}`);
}

createColorTexture(255, 0, 0, 'alignment_red_d.png');
createColorTexture(0, 51, 255, 'alignment_blue_d.png');
createColorTexture(255, 255, 0, 'alignment_yellow_d.png');
createColorTexture(255, 0, 255, 'alignment_magenta_d.png');

console.log('Align02 build completed successfully');