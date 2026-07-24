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

// Create DecalRoad cross marker
function createCrossDecalRoad(name: string, x: number, y: number, material: string, renderPriority: number): LevelMarker {
  const crossSize = 8; // 8m wide cross
  return {
    name,
    class: 'DecalRoad',
    __parent: 'MissionGroup',
    material,
    textureLength: 1,
    renderPriority,
    drivability: 0,
    autoLanes: false,
    autoJunction: false,
    oneWay: false,
    flipDirection: false,
    overObjects: false,
    zBias: 0.001,
    decalBias: 0.01,
    breakAngle: 3,
    nodes: [
      // Horizontal bar
      [x - crossSize, y, TERRAIN_ELEVATION + 0.1, 1],
      [x + crossSize, y, TERRAIN_ELEVATION + 0.1, 1],
      // Vertical bar
      [x, y - crossSize, TERRAIN_ELEVATION + 0.1, 1],
      [x, y + crossSize, TERRAIN_ELEVATION + 0.1, 1],
    ],
  };
}

// Create DecalRoad arrow
function createArrowDecalRoad(name: string, fromX: number, fromY: number, toX: number, toY: number, material: string, renderPriority: number): LevelMarker {
  return {
    name,
    class: 'DecalRoad',
    __parent: 'MissionGroup',
    material,
    textureLength: 1,
    renderPriority,
    drivability: 0,
    autoLanes: false,
    autoJunction: false,
    oneWay: false,
    flipDirection: false,
    overObjects: false,
    zBias: 0.001,
    decalBias: 0.01,
    breakAngle: 3,
    nodes: [
      [fromX, fromY, TERRAIN_ELEVATION + 0.1, 1],
      [toX, toY, TERRAIN_ELEVATION + 0.1, 1],
    ],
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
    // Corner crosses
    createCrossDecalRoad('cross_sw', 16, 16, 'orientationcheck01_red', 10),
    createCrossDecalRoad('cross_se', 1007, 16, 'orientationcheck01_green', 11),
    createCrossDecalRoad('cross_nw', 16, 1007, 'orientationcheck01_blue', 12),
    createCrossDecalRoad('cross_ne', 1007, 1007, 'orientationcheck01_yellow', 13),
    // Centre cross
    createCrossDecalRoad('cross_center', WORLD_CENTER, WORLD_CENTER, 'orientationcheck01_white', 14),
    // World +X arrow (cyan)
    createArrowDecalRoad('arrow_east', WORLD_CENTER, WORLD_CENTER, 767.5, WORLD_CENTER, 'orientationcheck01_cyan', 15),
    // World +Y arrow (magenta)
    createArrowDecalRoad('arrow_north', WORLD_CENTER, WORLD_CENTER, WORLD_CENTER, 767.5, 'orientationcheck01_magenta', 16),
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
    orientationcheck01_red: {
      class: 'Material',
      internalName: 'orientationcheck01_red',
      persistentId: '11111111-1111-1111-1111-111111111111',
      version: 1.5,
      Stages: [{ baseColor: [1, 0, 0, 1], roughness: 0.9, metalness: 0 }, {}, {}, {}],
      translucent: false,
      groundmodelName: 'ASPHALT',
      annotation: 'ROAD',
    },
    orientationcheck01_green: {
      class: 'Material',
      internalName: 'orientationcheck01_green',
      persistentId: '22222222-2222-2222-2222-222222222222',
      version: 1.5,
      Stages: [{ baseColor: [0, 1, 0, 1], roughness: 0.9, metalness: 0 }, {}, {}, {}],
      translucent: false,
      groundmodelName: 'ASPHALT',
      annotation: 'ROAD',
    },
    orientationcheck01_blue: {
      class: 'Material',
      internalName: 'orientationcheck01_blue',
      persistentId: '33333333-3333-3333-3333-333333333333',
      version: 1.5,
      Stages: [{ baseColor: [0, 0, 1, 1], roughness: 0.9, metalness: 0 }, {}, {}, {}],
      translucent: false,
      groundmodelName: 'ASPHALT',
      annotation: 'ROAD',
    },
    orientationcheck01_yellow: {
      class: 'Material',
      internalName: 'orientationcheck01_yellow',
      persistentId: '44444444-4444-4444-4444-444444444444',
      version: 1.5,
      Stages: [{ baseColor: [1, 1, 0, 1], roughness: 0.9, metalness: 0 }, {}, {}, {}],
      translucent: false,
      groundmodelName: 'ASPHALT',
      annotation: 'ROAD',
    },
    orientationcheck01_white: {
      class: 'Material',
      internalName: 'orientationcheck01_white',
      persistentId: '55555555-5555-5555-5555-555555555555',
      version: 1.5,
      Stages: [{ baseColor: [1, 1, 1, 1], roughness: 0.9, metalness: 0 }, {}, {}, {}],
      translucent: false,
      groundmodelName: 'ASPHALT',
      annotation: 'ROAD',
    },
    orientationcheck01_cyan: {
      class: 'Material',
      internalName: 'orientationcheck01_cyan',
      persistentId: '66666666-6666-6666-6666-666666666666',
      version: 1.5,
      Stages: [{ baseColor: [0, 1, 1, 1], roughness: 0.9, metalness: 0 }, {}, {}, {}],
      translucent: false,
      groundmodelName: 'ASPHALT',
      annotation: 'ROAD',
    },
    orientationcheck01_magenta: {
      class: 'Material',
      internalName: 'orientationcheck01_magenta',
      persistentId: '77777777-7777-7777-7777-777777777777',
      version: 1.5,
      Stages: [{ baseColor: [1, 0, 1, 1], roughness: 0.9, metalness: 0 }, {}, {}, {}],
      translucent: false,
      groundmodelName: 'ASPHALT',
      annotation: 'ROAD',
    },
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
      SW: { position: [16, 16, TERRAIN_ELEVATION + 0.1], color: 'red', type: 'DecalRoad cross' },
      SE: { position: [1007, 16, TERRAIN_ELEVATION + 0.1], color: 'green', type: 'DecalRoad cross' },
      NW: { position: [16, 1007, TERRAIN_ELEVATION + 0.1], color: 'blue', type: 'DecalRoad cross' },
      NE: { position: [1007, 1007, TERRAIN_ELEVATION + 0.1], color: 'yellow', type: 'DecalRoad cross' },
      centre: { position: [511.5, 511.5, TERRAIN_ELEVATION + 0.1], color: 'white', type: 'DecalRoad cross' },
      east: { position: [767.5, 511.5, TERRAIN_ELEVATION + 0.1], color: 'cyan', type: 'DecalRoad arrow' },
      north: { position: [511.5, 767.5, TERRAIN_ELEVATION + 0.1], color: 'magenta', type: 'DecalRoad arrow' },
    },
    expectedScreenshotCriteria: {
      'correct_mapping': 'BLUE image NW at world (16,1007), YELLOW image NE at world (1007,1007), RED image SW at world (16,16), GREEN image SE at world (1007,16)',
      'flipped_X': 'BLUE image NW at world (1007,1007), YELLOW image NE at world (16,1007), RED image SW at world (1007,16), GREEN image SE at world (16,16)',
      'flipped_Y': 'BLUE image NW at world (16,16), YELLOW image NE at world (1007,16), RED image SW at world (16,1007), GREEN image SE at world (1007,1007)',
      'flipped_XY': 'BLUE image NW at world (1007,16), YELLOW image NE at world (16,16), RED image SW at world (1007,1007), GREEN image SE at world (16,1007)',
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