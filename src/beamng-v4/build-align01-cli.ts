import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const SOURCE = path.resolve('src/beamng-v4/build-gate4-nativev3-cli.ts');
const GENERATED = path.resolve('src/beamng-v4/.generated-build-align01-cli.ts');

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
    "const LEVEL_NAME = 'align01';",
    'level name',
  );

  transformed = replaceExactly(
    transformed,
    'const WORLD_SAMPLE_CENTER = ((SIZE - 1) * SQUARE_SIZE) / 2;',
    'const WORLD_SAMPLE_CENTER = ((SIZE - 1) * SQUARE_SIZE) / 2;\nconst WORLD_RUNTIME_SPAN = (SIZE - 1) * SQUARE_SIZE;',
    'runtime span',
  );

  transformed = replaceExactly(
    transformed,
    '  const stations = corridor.v3Result.stations;',
    `  const stations = corridor.v3Result.stations;

  const createBounds = (nodes: number[][]) => nodes.reduce(
    (bounds, node) => ({
      minX: Math.min(bounds.minX, node[0]),
      minY: Math.min(bounds.minY, node[1]),
      maxX: Math.max(bounds.maxX, node[0]),
      maxY: Math.max(bounds.maxY, node[1]),
    }),
    { minX: Number.POSITIVE_INFINITY, minY: Number.POSITIVE_INFINITY, maxX: Number.NEGATIVE_INFINITY, maxY: Number.NEGATIVE_INFINITY },
  );
  const createSampleNodes = (nodes: number[][]) => ({
    first: nodes[0],
    middle: nodes[Math.floor(nodes.length / 2)],
    last: nodes[nodes.length - 1],
  });

  const decalNodesA = stations.map((station) => [
    station.x + WORLD_SAMPLE_CENTER,
    station.y + WORLD_SAMPLE_CENTER,
    0,
    2.0,
  ]);

  const decalNodesB = stations.map((station) => [
    WORLD_RUNTIME_SPAN - (station.x + WORLD_SAMPLE_CENTER),
    station.y + WORLD_SAMPLE_CENTER,
    0,
    2.0,
  ]);

  const decalNodesC = stations.map((station) => [
    station.x + WORLD_SAMPLE_CENTER,
    WORLD_RUNTIME_SPAN - (station.y + WORLD_SAMPLE_CENTER),
    0,
    2.0,
  ]);

  const decalNodesD = stations.map((station) => [
    WORLD_RUNTIME_SPAN - (station.x + WORLD_SAMPLE_CENTER),
    WORLD_RUNTIME_SPAN - (station.y + WORLD_SAMPLE_CENTER),
    0,
    2.0,
  ]);

  const alignmentCandidates = [
    {
      name: 'alignment_A_no_flip',
      material: 'alignment_red',
      color: [1, 0, 0, 1],
      formula: 'x = station.x + WORLD_SAMPLE_CENTER; y = station.y + WORLD_SAMPLE_CENTER',
      renderPriority: 20,
      nodes: decalNodesA,
    },
    {
      name: 'alignment_B_x_flip',
      material: 'alignment_blue',
      color: [0, 0.2, 1, 1],
      formula: 'x = WORLD_RUNTIME_SPAN - (station.x + WORLD_SAMPLE_CENTER); y = station.y + WORLD_SAMPLE_CENTER',
      renderPriority: 21,
      nodes: decalNodesB,
    },
    {
      name: 'alignment_C_y_flip',
      material: 'alignment_yellow',
      color: [1, 1, 0, 1],
      formula: 'x = station.x + WORLD_SAMPLE_CENTER; y = WORLD_RUNTIME_SPAN - (station.y + WORLD_SAMPLE_CENTER)',
      renderPriority: 22,
      nodes: decalNodesC,
    },
    {
      name: 'alignment_D_xy_flip',
      material: 'alignment_magenta',
      color: [1, 0, 1, 1],
      formula: 'x = WORLD_RUNTIME_SPAN - (station.x + WORLD_SAMPLE_CENTER); y = WORLD_RUNTIME_SPAN - (station.y + WORLD_SAMPLE_CENTER)',
      renderPriority: 23,
      nodes: decalNodesD,
    },
  ];

  const alignmentDecalRoads: LevelMarker[] = alignmentCandidates.map((candidate) => ({
    name: candidate.name,
    class: 'DecalRoad',
    __parent: 'MissionGroup',
    material: candidate.material,
    textureLength: 5,
    renderPriority: candidate.renderPriority,
    drivability: 0,
    autoLanes: false,
    autoJunction: false,
    oneWay: false,
    flipDirection: false,
    overObjects: false,
    zBias: 0.001,
    decalBias: 0.01,
    breakAngle: 3,
    nodes: candidate.nodes,
  }));`,
    'add four full-station alignment candidates',
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
  }, ...alignmentDecalRoads];`,
    'safe no-flip spawn and alignment decals',
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
    "    title: 'ALIGN01 — Four-Frame DecalRoad Alignment Diagnostic',",
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
    alignment_red: {
      name: 'alignment_red',
      mapTo: 'alignment_red',
      class: 'Material',
      internalName: 'alignment_red',
      persistentId: '11111111-1111-4111-8111-111111111111',
      version: 1.5,
      Stages: [{ baseColor: [1, 0, 0, 1], roughness: 0.9, metalness: 0 }, {}, {}, {}],
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
      Stages: [{ baseColor: [0, 0.2, 1, 1], roughness: 0.9, metalness: 0 }, {}, {}, {}],
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
      Stages: [{ baseColor: [1, 1, 0, 1], roughness: 0.9, metalness: 0 }, {}, {}, {}],
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
      Stages: [{ baseColor: [1, 0, 1, 1], roughness: 0.9, metalness: 0 }, {}, {}, {}],
      translucent: false,
      groundmodelName: 'ASPHALT',
      annotation: 'ROAD',
    },
  }, null, 2);

  const distDir = path.resolve('dist');`,
    'hard terrain and alignment materials',
  );

  transformed = replaceExactly(
    transformed,
    '  fs.writeFileSync(reportJsonPath, JSON.stringify(buildReport, null, 2));',
    `  fs.writeFileSync(reportJsonPath, JSON.stringify(buildReport, null, 2));

  const alignmentReportJsonPath = path.join(distDir, \`\${LEVEL_NAME}_alignment_report.json\`);
  const alignmentReport = {
    levelName: LEVEL_NAME,
    worldSampleCenterMetres: WORLD_SAMPLE_CENTER,
    worldRuntimeSpanMetres: WORLD_RUNTIME_SPAN,
    stationCount: stations.length,
    sumoEdges: sumoRoad.usedEdgeIds,
    sumoLanes: sumoRoad.usedLaneIds,
    netOffset: sumoRoad.netOffset,
    candidates: Object.fromEntries(alignmentCandidates.map((candidate) => [candidate.name, {
      material: candidate.material,
      color: candidate.color,
      formula: candidate.formula,
      renderPriority: candidate.renderPriority,
      nodeCount: candidate.nodes.length,
      bounds: createBounds(candidate.nodes),
      sampleNodes: createSampleNodes(candidate.nodes),
    }])),
  };
  fs.writeFileSync(alignmentReportJsonPath, JSON.stringify(alignmentReport, null, 2));`,
    'alignment report',
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
    if (result.status !== 0) throw new Error(`align01 build exited with code ${result.status}.`);
  } finally {
    if (fs.existsSync(GENERATED)) fs.unlinkSync(GENERATED);
  }
}

try {
  main();
} catch (error) {
  console.error('FATAL ALIGN01 BUILD ERROR:', error);
  process.exit(1);
}
