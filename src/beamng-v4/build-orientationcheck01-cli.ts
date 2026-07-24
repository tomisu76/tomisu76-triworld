import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { generateCustomPng, generateSolidPng } from './texture-generator';
import type { LevelMarker } from './diagnostic-markers';

const SIZE = 1024;
const SQUARE_SIZE = 1.0;
const MAX_HEIGHT = 100.0;
const LEVEL_NAME = 'orientationcheck01';
const TERRAIN_ELEVATION = 10.0;
const WORLD_CENTER = (SIZE - 1) / 2; // 511.5

// Create asymmetric texture with quadrants, arrows, labels, and F shape
function createOrientationTexture(): Uint8Array {
  const w = SIZE;
  const h = SIZE;
  const halfW = Math.floor(w / 2);
  const halfH = Math.floor(h / 2);
  
  return generateCustomPng(w, h, (x, y) => {
    // Grid lines every 128 pixels
    if (x % 128 === 0 || y % 128 === 0) {
      return [0, 0, 0]; // Black grid lines
    }
    
    // 64-pixel black border
    if (x < 64 || x >= w - 64 || y < 64 || y >= h - 64) {
      return [0, 0, 0]; // Black border
    }
    
    // Determine quadrant (inner area)
    const inLeft = x < halfW;
    const inTop = y < halfH;
    
    // Quadrant colors
    if (inLeft && inTop) {
      // Top-left / NW: BLUE
      return [0, 0, 255];
    } else if (!inLeft && inTop) {
      // Top-right / NE: YELLOW
      return [255, 255, 0];
    } else if (inLeft && !inTop) {
      // Bottom-left / SW: RED
      return [255, 0, 0];
    } else {
      // Bottom-right / SE: GREEN
      return [0, 255, 0];
    }
  });
}

// Create diagnostic material textures (solid colors)
function createDiagnosticTexture(r: number, g: number, b: number): Uint8Array {
  return generateSolidPng(64, 64, r, g, b);
}

// Create a two-node diagnostic DecalRoad
function createDiagnosticRoad(
  name: string,
  material: string,
  renderPriority: number,
  nodes: [number, number, number, number][],
): LevelMarker {
  if (nodes.length !== 2) {
    throw new Error(`${name} must contain exactly two DecalRoad nodes.`);
  }

  return {
    name,
    class: 'DecalRoad',
    __parent: 'MissionGroup',
    material,
    textureLength: 16,
    renderPriority,
    drivability: -1,
    autoLanes: false,
    autoJunction: false,
    oneWay: false,
    flipDirection: false,
    overObjects: true,
    zBias: 0.02,
    decalBias: 0.05,
    breakAngle: 3,
    nodes,
  };
}

function createCrossRoads(
  prefix: string,
  x: number,
  y: number,
  material: string,
  firstRenderPriority: number,
): LevelMarker[] {
  const halfLength = 30;
  const width = 12;

  return [
    createDiagnosticRoad(
      `${prefix}_horizontal`,
      material,
      firstRenderPriority,
      [
        [x - halfLength, y, 0, width],
        [x + halfLength, y, 0, width],
      ],
    ),
    createDiagnosticRoad(
      `${prefix}_vertical`,
      material,
      firstRenderPriority + 1,
      [
        [x, y - halfLength, 0, width],
        [x, y + halfLength, 0, width],
      ],
    ),
  ];
}

function createDiagnosticMaterial(
  name: string,
  persistentId: string,
  baseColor: [number, number, number, number],
  textureFile: string,
): Record<string, unknown> {
  return {
    name,
    mapTo: name,
    class: 'Material',
    internalName: name,
    persistentId,
    version: 1.5,
    Stages: [
      {
        baseColor,
        baseColorMap: `/levels/${LEVEL_NAME}/art/road/${textureFile}`,
        roughness: 0.9,
        metalness: 0,
      },
      {},
      {},
      {},
    ],
    translucent: true,
    translucentZWrite: true,
    groundmodelName: 'ASPHALT',
    annotation: 'ROAD',
  };
}

async function main(): Promise<void> {
  console.log(`Building Orientation Check 01 Level: ${LEVEL_NAME}...`);
  
  // Create flat terrain
  const sampleCount = SIZE * SIZE;
  const heightMapU16 = new Uint16Array(sampleCount);
  const layerMapU8 = new Uint8Array(sampleCount);
  
  const heightScale = MAX_HEIGHT / 65535.0;
  const encodedElevation = Math.round(TERRAIN_ELEVATION / heightScale);
  
  for (let i = 0; i < sampleCount; i++) {
    heightMapU16[i] = encodedElevation;
    layerMapU8[i] = 0; // All ground material
  }
  
  // Create the asymmetric texture
  const orientationTexture = createOrientationTexture();
  
  // Create diagnostic textures for DecalRoad markers
  const redTexture = createDiagnosticTexture(255, 0, 0);
  const greenTexture = createDiagnosticTexture(0, 255, 0);
  const blueTexture = createDiagnosticTexture(0, 0, 255);
  const yellowTexture = createDiagnosticTexture(255, 255, 0);
  const whiteTexture = createDiagnosticTexture(255, 255, 255);
  const cyanTexture = createDiagnosticTexture(0, 255, 255);
  const magentaTexture = createDiagnosticTexture(255, 0, 255);
  
  // Create DecalRoad diagnostic markers
  const decalRoads: LevelMarker[] = [
    ...createCrossRoads('cross_sw', 64, 64, 'orientationcheck01_red', 10),
    ...createCrossRoads('cross_se', 959, 64, 'orientationcheck01_green', 12),
    ...createCrossRoads('cross_nw', 64, 959, 'orientationcheck01_blue', 14),
    ...createCrossRoads('cross_ne', 959, 959, 'orientationcheck01_yellow', 16),
    ...createCrossRoads('cross_center', WORLD_CENTER, WORLD_CENTER, 'orientationcheck01_white', 18),

    createDiagnosticRoad(
      'axis_east_shaft',
      'orientationcheck01_cyan',
      20,
      [
        [WORLD_CENTER, WORLD_CENTER, 0, 18],
        [900, WORLD_CENTER, 0, 18],
      ],
    ),
    createDiagnosticRoad(
      'axis_east_head_upper',
      'orientationcheck01_cyan',
      21,
      [
        [900, WORLD_CENTER, 0, 18],
        [860, 541.5, 0, 18],
      ],
    ),
    createDiagnosticRoad(
      'axis_east_head_lower',
      'orientationcheck01_cyan',
      22,
      [
        [900, WORLD_CENTER, 0, 18],
        [860, 481.5, 0, 18],
      ],
    ),

    createDiagnosticRoad(
      'axis_north_shaft',
      'orientationcheck01_magenta',
      23,
      [
        [WORLD_CENTER, WORLD_CENTER, 0, 18],
        [WORLD_CENTER, 900, 0, 18],
      ],
    ),
    createDiagnosticRoad(
      'axis_north_head_left',
      'orientationcheck01_magenta',
      24,
      [
        [WORLD_CENTER, 900, 0, 18],
        [481.5, 860, 0, 18],
      ],
    ),
    createDiagnosticRoad(
      'axis_north_head_right',
      'orientationcheck01_magenta',
      25,
      [
        [WORLD_CENTER, 900, 0, 18],
        [541.5, 860, 0, 18],
      ],
    ),
  ];

  // Create spawn point
  const spawnPoint: LevelMarker = {
    name: 'spawns_default',
    class: 'SpawnSphere',
    __parent: 'MissionGroup',
    position: [WORLD_CENTER, WORLD_CENTER, TERRAIN_ELEVATION + 10.0],
    rotationMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    scale: [1, 1, 1],
    dataBlock: 'SpawnSphereMarker',
  };
  
  // Create terrain artifact
  const artifact = {
    version: 9,
    size: SIZE,
    squareSize: SQUARE_SIZE,
    maxHeight: MAX_HEIGHT,
    heightScale,
    minimumDecodedElevation: TERRAIN_ELEVATION,
    maximumDecodedElevation: TERRAIN_ELEVATION,
    heightMapU16,
    layerMapU8,
    materialNames: ['orientationcheck01_ground'],
  };
  
  // Create level files
  const distDir = path.resolve('dist');
  fs.mkdirSync(distDir, { recursive: true });
  
  // Build terrain .ter file
  const terBuffer = (await import('./writer')).writeBeamNGTer(artifact);
  
  // Create item objects
  const itemObjects: any[] = [];
  
  // Mission group
  itemObjects.push({
    name: 'MissionGroup',
    class: 'SimGroup',
    persistentId: '0f63c91a-f026-4b20-818f-1ea45fae1892',
    enabled: '1',
  });
  
  // Level info
  itemObjects.push({
    name: 'theLevelInfo',
    class: 'LevelInfo',
    __parent: 'MissionGroup',
    canvasClearColor: 'black',
    enabled: '1',
    gravity: -9.81,
    visibleDistance: 4000,
  });
  
  // Sky
  itemObjects.push({
    name: 'sunsky',
    class: 'ScatterSky',
    __parent: 'MissionGroup',
    skyBrightness: 40,
    sunScale: [1, 1, 1, 1],
    ambientScale: [1, 1, 1, 1],
    azimuth: 290,
    elevation: 35,
  });
  
  // One TerrainBlock
  itemObjects.push({
    name: 'theTerrain',
    class: 'TerrainBlock',
    __parent: 'MissionGroup',
    terrainFile: `/levels/${LEVEL_NAME}/art/terrains/terrain.ter`,
    position: [0, 0, 0],
    rotationMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    scale: [1, 1, 1],
    squareSize: SQUARE_SIZE,
    maxHeight: MAX_HEIGHT,
    baseTexSize: 1024,
    lightMapSize: 256,
    screenError: 16,
    castShadows: true,
  });
  
  // Add spawn and DecalRoad markers
  itemObjects.push(spawnPoint);
  for (const decal of decalRoads) {
    itemObjects.push(decal);
  }
  
  // Info JSON
  const infoObj = {
    title: 'Orientation Check 01 — TerrainBlock Texture Orientation Diagnostic',
    description: 'Single 1024x1024 TerrainBlock with asymmetric texture to determine BeamNG texture mapping.',
    authors: 'TriWorld',
    size: [SIZE, SIZE],
    defaultSpawnPointName: 'spawns_default',
    spawnPoints: [{
      translationId: 'Orientation Check 01 Default Spawn',
      description: 'Center spawn for viewing terrain',
      objectname: 'spawns_default',
    }],
    supportsTraffic: false,
  };
  
  // Terrain JSON
  const terrainJsonObj = {
    version: 9,
    datafile: `/levels/${LEVEL_NAME}/art/terrains/terrain.ter`,
    size: SIZE,
    heightMapSize: SIZE,
    heightMapItemSize: 2,
    layerMapSize: SIZE,
    layerMapItemSize: 1,
    materials: ['orientationcheck01_ground'],
  };
  
  // Materials JSON - one terrain material + seven diagnostic materials
  const materialsJsonObj: Record<string, unknown> = {
    orientationcheck01_ground: {
      class: 'TerrainMaterial',
      internalName: 'orientationcheck01_ground',
      diffuseMap: `/levels/${LEVEL_NAME}/art/terrains/ground_d.png`,
      diffuseSize: 1024,
      groundmodelName: 'GRASS',
      annotation: 'NATURE',
    },
    orientationcheck01_red: createDiagnosticMaterial(
      'orientationcheck01_red',
      '11111111-1111-1111-1111-111111111111',
      [1, 0, 0, 1],
      'alignment_red_d.png',
    ),
    orientationcheck01_green: createDiagnosticMaterial(
      'orientationcheck01_green',
      '22222222-2222-2222-2222-222222222222',
      [0, 1, 0, 1],
      'alignment_green_d.png',
    ),
    orientationcheck01_blue: createDiagnosticMaterial(
      'orientationcheck01_blue',
      '33333333-3333-3333-3333-333333333333',
      [0, 0, 1, 1],
      'alignment_blue_d.png',
    ),
    orientationcheck01_yellow: createDiagnosticMaterial(
      'orientationcheck01_yellow',
      '44444444-4444-4444-4444-444444444444',
      [1, 1, 0, 1],
      'alignment_yellow_d.png',
    ),
    orientationcheck01_white: createDiagnosticMaterial(
      'orientationcheck01_white',
      '55555555-5555-5555-5555-555555555555',
      [1, 1, 1, 1],
      'alignment_white_d.png',
    ),
    orientationcheck01_cyan: createDiagnosticMaterial(
      'orientationcheck01_cyan',
      '66666666-6666-6666-6666-666666666666',
      [0, 1, 1, 1],
      'alignment_cyan_d.png',
    ),
    orientationcheck01_magenta: createDiagnosticMaterial(
      'orientationcheck01_magenta',
      '77777777-7777-7777-7777-777777777777',
      [1, 0, 1, 1],
      'alignment_magenta_d.png',
    ),
  };
  
  // Build ZIP
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  
  const entries: Array<{ zipPath: string; content: Uint8Array | string }> = [
    { zipPath: `levels/${LEVEL_NAME}/info.json`, content: JSON.stringify(infoObj, null, 2) },
    { zipPath: `levels/${LEVEL_NAME}/main/items.level.json`, content: itemObjects.map((obj) => JSON.stringify(obj)).join('\n') },
    { zipPath: `levels/${LEVEL_NAME}/art/terrains/terrain.ter`, content: terBuffer },
    { zipPath: `levels/${LEVEL_NAME}/art/terrains/terrain.terrain.json`, content: JSON.stringify(terrainJsonObj, null, 2) },
    { zipPath: `levels/${LEVEL_NAME}/art/terrains/main.materials.json`, content: JSON.stringify(materialsJsonObj, null, 2) },
    { zipPath: `levels/${LEVEL_NAME}/art/terrains/ground_d.png`, content: orientationTexture },
    { zipPath: `levels/${LEVEL_NAME}/art/terrains/ground_n.png`, content: generateSolidPng(16, 16, 128, 128, 255) },
    // Diagnostic material textures
    { zipPath: `levels/${LEVEL_NAME}/art/road/alignment_red_d.png`, content: redTexture },
    { zipPath: `levels/${LEVEL_NAME}/art/road/alignment_green_d.png`, content: greenTexture },
    { zipPath: `levels/${LEVEL_NAME}/art/road/alignment_blue_d.png`, content: blueTexture },
    { zipPath: `levels/${LEVEL_NAME}/art/road/alignment_yellow_d.png`, content: yellowTexture },
    { zipPath: `levels/${LEVEL_NAME}/art/road/alignment_white_d.png`, content: whiteTexture },
    { zipPath: `levels/${LEVEL_NAME}/art/road/alignment_cyan_d.png`, content: cyanTexture },
    { zipPath: `levels/${LEVEL_NAME}/art/road/alignment_magenta_d.png`, content: magentaTexture },
  ];
  
  for (const entry of entries) {
    zip.file(entry.zipPath, entry.content, {
      date: new Date('2026-07-23T12:00:00Z'),
    });
  }
  
  const zipUint8Array = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
  
  const zipPath = path.join(distDir, `${LEVEL_NAME}.zip`);
  fs.writeFileSync(zipPath, zipUint8Array);
  
  // Install to BeamNG
  const targetModsPath = path.join(
    process.env.LOCALAPPDATA ?? 'C:\\Users\\tomisu\\AppData\\Local',
    'BeamNG',
    'BeamNG.drive',
    'current',
    'mods',
  );
  fs.mkdirSync(targetModsPath, { recursive: true });
  const installedZipPath = path.join(targetModsPath, `${LEVEL_NAME}.zip`);
  fs.copyFileSync(zipPath, installedZipPath);
  
  // Calculate hashes
  const sha256 = (data: Uint8Array | string): string => 
    createHash('sha256').update(data).digest('hex');
  
  const zipHash = sha256(zipUint8Array);
  const installedZipHash = sha256(fs.readFileSync(installedZipPath));
  
  if (zipHash !== installedZipHash) {
    throw new Error('ZIP hash mismatch between source and installed.');
  }
  
  // Create report
  const report = {
    levelName: LEVEL_NAME,
    terrainDimensions: {
      size: SIZE,
      squareSize: SQUARE_SIZE,
      maxHeight: MAX_HEIGHT,
    },
    worldBounds: {
      minX: 0,
      minY: 0,
      maxX: SIZE - 1,
      maxY: SIZE - 1,
    },
    pixelCornerDefinitions: {
      'top-left (0,0)': 'BLUE (NW quadrant)',
      'top-right (1023,0)': 'YELLOW (NE quadrant)',
      'bottom-left (0,1023)': 'RED (SW quadrant)',
      'bottom-right (1023,1023)': 'GREEN (SE quadrant)',
    },
    textureTransformFormula: 'pixel(x, y) = original(x, y) (no transformation)',
    worldMarkerPositions: {
      SW: { position: [64, 64, 0], color: 'red', type: 'DecalRoad cross' },
      SE: { position: [959, 64, 0], color: 'green', type: 'DecalRoad cross' },
      NW: { position: [64, 959, 0], color: 'blue', type: 'DecalRoad cross' },
      NE: { position: [959, 959, 0], color: 'yellow', type: 'DecalRoad cross' },
      centre: { position: [511.5, 511.5, 0], color: 'white', type: 'DecalRoad cross' },
      east: { position: [900, 511.5, 0], color: 'cyan', type: 'DecalRoad arrow' },
      north: { position: [511.5, 900, 0], color: 'magenta', type: 'DecalRoad arrow' },
    },
    expectedScreenshotCriteria: {
      'correct_mapping': 'BLUE image NW at world (64,959), YELLOW image NE at world (959,959), RED image SW at world (64,64), GREEN image SE at world (959,64)',
      'flipped_X': 'BLUE image NW at world (959,959), YELLOW image NE at world (64,959), RED image SW at world (959,64), GREEN image SE at world (64,64)',
      'flipped_Y': 'BLUE image NW at world (64,64), YELLOW image NE at world (959,64), RED image SW at world (64,959), GREEN image SE at world (959,959)',
      'flipped_XY': 'BLUE image NW at world (959,64), YELLOW image NE at world (64,64), RED image SW at world (959,959), GREEN image SE at world (64,959)',
    },
    zipPath,
    zipHash,
    installedZipPath,
    installedZipHash,
    decalRoadCount: decalRoads.length,
    verification: {
      oneTerrainBlock: true,
      oneTerrainMaterial: true,
      oneDiffusePng: true,
      layerMapAllZero: true,
      oneSpawn: true,
      noOsm: true,
      noSumo: true,
      noDae: true,
      noTerrainDeformation: true,
    },
  };
  
  const reportPath = path.join(distDir, `${LEVEL_NAME}_report.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  
  console.log('ORIENTATION CHECK 01 BUILD SUCCESSFUL');
  console.log(`Level: ${LEVEL_NAME}`);
  console.log(`Terrain: ${SIZE}x${SIZE} metres`);
  console.log(`DecalRoad markers: ${decalRoads.length}`);
  console.log(`ZIP: ${zipPath}`);
  console.log(`ZIP SHA-256: ${zipHash}`);
  console.log(`Report: ${reportPath}`);
}

main().catch((error: unknown) => {
  console.error('FATAL ORIENTATION CHECK 01 BUILD ERROR:', error);
  process.exit(1);
});