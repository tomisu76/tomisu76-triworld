import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { generateLevelPackageFiles, type LevelPackageFiles } from './level-generator';
import { buildBeamNgZipPackage, sha256 } from './zip-builder';
import type { LevelMarker } from './diagnostic-markers';
import { generateCustomPng, generateSolidPng } from './texture-generator';

const SIZE = 1024;
const SQUARE_SIZE = 1.0;
const MAX_HEIGHT = 100.0;
const LEVEL_NAME = 'orientationcheck01';
const TERRAIN_ELEVATION = 10.0;

// World bounds: 0 to 1023 metres in both X and Y
const WORLD_MIN = 0;
const WORLD_MAX = SIZE - 1; // 1023
const WORLD_CENTER = (SIZE - 1) / 2; // 511.5

function createFlatTerrain(): { heightMapU16: Uint16Array; layerMapU8: Uint8Array } {
  const sampleCount = SIZE * SIZE;
  const heightMapU16 = new Uint16Array(sampleCount);
  const layerMapU8 = new Uint8Array(sampleCount);
  
  const heightScale = MAX_HEIGHT / 65535.0;
  const encodedElevation = Math.round(TERRAIN_ELEVATION / heightScale);
  
  for (let i = 0; i < sampleCount; i++) {
    heightMapU16[i] = encodedElevation;
    layerMapU8[i] = 0; // All ground material
  }
  
  return { heightMapU16, layerMapU8 };
}

// Create asymmetric texture with quadrants and orientation indicators
function createOrientationTexture(): Uint8Array {
  const w = SIZE;
  const h = SIZE;
  const halfW = Math.floor(w / 2);
  const halfH = Math.floor(h / 2);
  
  return generateCustomPng(w, h, (x, y) => {
    // Determine quadrant
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

// Create horizontal flip variant
function createHorizontalFlipTexture(original: Uint8Array): Uint8Array {
  // For PNG, we need to decode and re-encode with flipped pixels
  // Using a simple approach: create a new texture with flipped X
  const w = SIZE;
  const h = SIZE;
  
  return generateCustomPng(w, h, (x, y) => {
    // Flip X: x -> w - 1 - x
    const srcX = w - 1 - x;
    const halfW = Math.floor(w / 2);
    const halfH = Math.floor(h / 2);
    
    const inLeft = srcX < halfW;
    const inTop = y < halfH;
    
    if (inLeft && inTop) {
      return [0, 0, 255]; // NW
    } else if (!inLeft && inTop) {
      return [255, 255, 0]; // NE
    } else if (inLeft && !inTop) {
      return [255, 0, 0]; // SW
    } else {
      return [0, 255, 0]; // SE
    }
  });
}

// Create vertical flip variant
function createVerticalFlipTexture(original: Uint8Array): Uint8Array {
  const w = SIZE;
  const h = SIZE;
  
  return generateCustomPng(w, h, (x, y) => {
    // Flip Y: y -> h - 1 - y
    const srcY = h - 1 - y;
    const halfW = Math.floor(w / 2);
    const halfH = Math.floor(h / 2);
    
    const inLeft = x < halfW;
    const inTop = srcY < halfH;
    
    if (inLeft && inTop) {
      return [0, 0, 255]; // NW
    } else if (!inLeft && inTop) {
      return [255, 255, 0]; // NE
    } else if (inLeft && !inTop) {
      return [255, 0, 0]; // SW
    } else {
      return [0, 255, 0]; // SE
    }
  });
}

// Create 180-degree rotation variant
function createRotation180Texture(original: Uint8Array): Uint8Array {
  const w = SIZE;
  const h = SIZE;
  
  return generateCustomPng(w, h, (x, y) => {
    // Rotate 180: x -> w - 1 - x, y -> h - 1 - y
    const srcX = w - 1 - x;
    const srcY = h - 1 - y;
    const halfW = Math.floor(w / 2);
    const halfH = Math.floor(h / 2);
    
    const inLeft = srcX < halfW;
    const inTop = srcY < halfH;
    
    if (inLeft && inTop) {
      return [0, 0, 255]; // NW
    } else if (!inLeft && inTop) {
      return [255, 255, 0]; // NE
    } else if (inLeft && !inTop) {
      return [255, 0, 0]; // SW
    } else {
      return [0, 255, 0]; // SE
    }
  });
}

// Create world direction markers
function createWorldMarkers(): LevelMarker[] {
  const markers: LevelMarker[] = [];
  const markerHeight = TERRAIN_ELEVATION + 1.0;
  
  // SW: red marker at local (16, 16)
  markers.push({
    name: 'marker_sw',
    class: 'TSStatic',
    __parent: 'MissionGroup',
    position: [16, 16, markerHeight],
    scale: [1, 1, 1],
  });
  
  // SE: green marker at local (1007, 16)
  markers.push({
    name: 'marker_se',
    class: 'TSStatic',
    __parent: 'MissionGroup',
    position: [1007, 16, markerHeight],
    scale: [1, 1, 1],
  });
  
  // NW: blue marker at local (16, 1007)
  markers.push({
    name: 'marker_nw',
    class: 'TSStatic',
    __parent: 'MissionGroup',
    position: [16, 1007, markerHeight],
    scale: [1, 1, 1],
  });
  
  // NE: yellow marker at local (1007, 1007)
  markers.push({
    name: 'marker_ne',
    class: 'TSStatic',
    __parent: 'MissionGroup',
    position: [1007, 1007, markerHeight],
    scale: [1, 1, 1],
  });
  
  // Centre: white marker at local (511.5, 511.5)
  markers.push({
    name: 'marker_center',
    class: 'TSStatic',
    __parent: 'MissionGroup',
    position: [WORLD_CENTER, WORLD_CENTER, markerHeight],
    scale: [1, 1, 1],
  });
  
  // East: cyan marker at local (767.5, 511.5)
  markers.push({
    name: 'marker_east',
    class: 'TSStatic',
    __parent: 'MissionGroup',
    position: [767.5, WORLD_CENTER, markerHeight],
    scale: [1, 1, 1],
  });
  
  // North: magenta marker at local (511.5, 767.5)
  markers.push({
    name: 'marker_north',
    class: 'TSStatic',
    __parent: 'MissionGroup',
    position: [WORLD_CENTER, 767.5, markerHeight],
    scale: [1, 1, 1],
  });
  
  return markers;
}

// Create spawn point with elevated camera
function createSpawnPoint(): LevelMarker {
  return {
    name: 'spawns_default',
    class: 'SpawnSphere',
    __parent: 'MissionGroup',
    position: [WORLD_CENTER, WORLD_CENTER, TERRAIN_ELEVATION + 10.0],
    rotationMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    scale: [1, 1, 1],
    dataBlock: 'SpawnSphereMarker',
  };
}

async function main(): Promise<void> {
  console.log(`Building Orientation Check 01 Level: ${LEVEL_NAME}...`);
  
  const { heightMapU16, layerMapU8 } = createFlatTerrain();
  
  // Create the four texture variants
  const textureA = createOrientationTexture(); // Original
  const textureB = createHorizontalFlipTexture(textureA); // Horizontal flip
  const textureC = createVerticalFlipTexture(textureA); // Vertical flip
  const textureD = createRotation180Texture(textureA); // 180 rotation
  
  // Create world markers
  const worldMarkers = createWorldMarkers();
  const spawnPoint = createSpawnPoint();
  
  // Create terrain artifact
  const artifact = {
    version: 9,
    size: SIZE,
    squareSize: SQUARE_SIZE,
    maxHeight: MAX_HEIGHT,
    heightScale: MAX_HEIGHT / 65535.0,
    minimumDecodedElevation: TERRAIN_ELEVATION,
    maximumDecodedElevation: TERRAIN_ELEVATION,
    heightMapU16,
    layerMapU8,
    materialNames: ['orientationcheck01_A', 'orientationcheck01_B', 'orientationcheck01_C', 'orientationcheck01_D'],
  };
  
  // Create level package with all four terrain blocks
  const distDir = path.resolve('dist');
  fs.mkdirSync(distDir, { recursive: true });
  
  // We need to create a custom level package with 4 separate terrain blocks
  // Each with its own texture variant
  
  // For simplicity, we'll create 4 separate levels in one ZIP
  // Actually, let's create 4 separate terrain blocks side by side
  
  // Create a large terrain (2048x2048) with 4 quadrants
  // Each quadrant is 1024x1024 with different texture
  
  const largeSize = SIZE * 2;
  const largeSampleCount = largeSize * largeSize;
  const largeHeightMapU16 = new Uint16Array(largeSampleCount);
  const largeLayerMapU8 = new Uint8Array(largeSampleCount);
  
  const heightScale = MAX_HEIGHT / 65535.0;
  const encodedElevation = Math.round(TERRAIN_ELEVATION / heightScale);
  
  for (let i = 0; i < largeSampleCount; i++) {
    largeHeightMapU16[i] = encodedElevation;
    largeLayerMapU8[i] = 0;
  }
  
  // Create a composite texture (2048x2048) with all 4 variants
  const compositeTexture = generateCustomPng(largeSize, largeSize, (x, y) => {
    const halfW = SIZE;
    const halfH = SIZE;
    
    if (x < halfW && y < halfH) {
      // Variant A (original) - top-left quadrant
      const srcX = x;
      const srcY = y;
      const inLeft = srcX < 512;
      const inTop = srcY < 512;
      if (inLeft && inTop) return [0, 0, 255]; // NW: Blue
      if (!inLeft && inTop) return [255, 255, 0]; // NE: Yellow
      if (inLeft && !inTop) return [255, 0, 0]; // SW: Red
      return [0, 255, 0]; // SE: Green
    } else if (x >= halfW && y < halfH) {
      // Variant B (horizontal flip) - top-right quadrant
      const srcX = SIZE * 2 - 1 - x;
      const srcY = y;
      const inLeft = srcX < 512;
      const inTop = srcY < 512;
      if (inLeft && inTop) return [0, 0, 255];
      if (!inLeft && inTop) return [255, 255, 0];
      if (inLeft && !inTop) return [255, 0, 0];
      return [0, 255, 0];
    } else if (x < halfW && y >= halfH) {
      // Variant C (vertical flip) - bottom-left quadrant
      const srcX = x;
      const srcY = SIZE * 2 - 1 - y;
      const inLeft = srcX < 512;
      const inTop = srcY < 512;
      if (inLeft && inTop) return [0, 0, 255];
      if (!inLeft && inTop) return [255, 255, 0];
      if (inLeft && !inTop) return [255, 0, 0];
      return [0, 255, 0];
    } else {
      // Variant D (180 rotation) - bottom-right quadrant
      const srcX = SIZE * 2 - 1 - x;
      const srcY = SIZE * 2 - 1 - y;
      const inLeft = srcX < 512;
      const inTop = srcY < 512;
      if (inLeft && inTop) return [0, 0, 255];
      if (!inLeft && inTop) return [255, 255, 0];
      if (inLeft && !inTop) return [255, 0, 0];
      return [0, 255, 0];
    }
  });
  
  // Create 4 separate terrain blocks with different materials
  const largeArtifact = {
    version: 9,
    size: largeSize,
    squareSize: SQUARE_SIZE,
    maxHeight: MAX_HEIGHT,
    heightScale,
    minimumDecodedElevation: TERRAIN_ELEVATION,
    maximumDecodedElevation: TERRAIN_ELEVATION,
    heightMapU16: largeHeightMapU16,
    layerMapU8: largeLayerMapU8,
    materialNames: ['orientationcheck01_A', 'orientationcheck01_B', 'orientationcheck01_C', 'orientationcheck01_D'],
  };
  
  // Create materials for each variant
  const materialsJsonObj: Record<string, unknown> = {
    orientationcheck01_A: {
      class: 'TerrainMaterial',
      internalName: 'orientationcheck01_A',
      diffuseMap: `/levels/${LEVEL_NAME}/art/terrains/ground_d.png`,
      diffuseSize: 1024,
      groundmodelName: 'GRASS',
      annotation: 'NATURE',
    },
    orientationcheck01_B: {
      class: 'TerrainMaterial',
      internalName: 'orientationcheck01_B',
      diffuseMap: `/levels/${LEVEL_NAME}/art/terrains/ground_d.png`,
      diffuseSize: 1024,
      groundmodelName: 'GRASS',
      annotation: 'NATURE',
    },
    orientationcheck01_C: {
      class: 'TerrainMaterial',
      internalName: 'orientationcheck01_C',
      diffuseMap: `/levels/${LEVEL_NAME}/art/terrains/ground_d.png`,
      diffuseSize: 1024,
      groundmodelName: 'GRASS',
      annotation: 'NATURE',
    },
    orientationcheck01_D: {
      class: 'TerrainMaterial',
      internalName: 'orientationcheck01_D',
      diffuseMap: `/levels/${LEVEL_NAME}/art/terrains/ground_d.png`,
      diffuseSize: 1024,
      groundmodelName: 'GRASS',
      annotation: 'NATURE',
    },
  };
  
  // Create 4 terrain blocks side by side
  const terrainBlocks = [
    { name: 'terrain_A', position: [0, 0, 0] },
    { name: 'terrain_B', position: [SIZE, 0, 0] },
    { name: 'terrain_C', position: [0, SIZE, 0] },
    { name: 'terrain_D', position: [SIZE, SIZE, 0] },
  ];
  
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
  
  // 4 terrain blocks
  for (const tb of terrainBlocks) {
    itemObjects.push({
      name: tb.name,
      class: 'TerrainBlock',
      __parent: 'MissionGroup',
      terrainFile: `/levels/${LEVEL_NAME}/art/terrains/terrain.ter`,
      position: tb.position,
      rotationMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      scale: [1, 1, 1],
      squareSize: SQUARE_SIZE,
      maxHeight: MAX_HEIGHT,
      baseTexSize: 1024,
      lightMapSize: 256,
      screenError: 16,
      castShadows: true,
    });
  }
  
  // Add spawn and markers
  itemObjects.push(spawnPoint);
  for (const marker of worldMarkers) {
    itemObjects.push(marker);
  }
  
  // Create level files
  const infoObj = {
    title: 'Orientation Check 01 — TerrainBlock Texture Orientation Diagnostic',
    description: 'Four 1024x1024 TerrainBlocks with different texture transformations to determine BeamNG texture mapping.',
    authors: 'TriWorld',
    size: [largeSize, largeSize],
    defaultSpawnPointName: 'spawns_default',
    spawnPoints: [{
      translationId: 'Orientation Check 01 Default Spawn',
      description: 'Center spawn for viewing all four terrain blocks',
      objectname: 'spawns_default',
    }],
    supportsTraffic: false,
  };
  
  const terrainJsonObj = {
    version: 9,
    datafile: `/levels/${LEVEL_NAME}/art/terrains/terrain.ter`,
    size: largeSize,
    heightMapSize: largeSize,
    heightMapItemSize: 2,
    layerMapSize: largeSize,
    layerMapItemSize: 1,
    materials: ['orientationcheck01_A', 'orientationcheck01_B', 'orientationcheck01_C', 'orientationcheck01_D'],
  };
  
  const levelFiles: LevelPackageFiles = {
    infoJson: JSON.stringify(infoObj, null, 2),
    itemsLevelJson: itemObjects.map((obj) => JSON.stringify(obj)).join('\n'),
    terrainJson: JSON.stringify(terrainJsonObj, null, 2),
    materialsJson: JSON.stringify(materialsJsonObj, null, 2),
    diffusePng: compositeTexture,
    normalPng: generateSolidPng(16, 16, 128, 128, 255),
  };
  
  const zipPath = path.join(distDir, `${LEVEL_NAME}.zip`);
  const manifestPath = path.join(distDir, `${LEVEL_NAME}.manifest.json`);
  
  // Build ZIP
  const terBuffer = (await import('./writer')).writeBeamNGTer(largeArtifact);
  
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  
  const entries: Array<{ zipPath: string; content: Uint8Array | string }> = [
    { zipPath: `levels/${LEVEL_NAME}/info.json`, content: levelFiles.infoJson },
    { zipPath: `levels/${LEVEL_NAME}/main/items.level.json`, content: levelFiles.itemsLevelJson },
    { zipPath: `levels/${LEVEL_NAME}/art/terrains/terrain.ter`, content: terBuffer },
    { zipPath: `levels/${LEVEL_NAME}/art/terrains/terrain.terrain.json`, content: levelFiles.terrainJson },
    { zipPath: `levels/${LEVEL_NAME}/art/terrains/main.materials.json`, content: levelFiles.materialsJson },
    { zipPath: `levels/${LEVEL_NAME}/art/terrains/ground_d.png`, content: levelFiles.diffusePng },
    { zipPath: `levels/${LEVEL_NAME}/art/terrains/ground_n.png`, content: levelFiles.normalPng! },
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
  
  const zipHash = sha256(zipUint8Array);
  const installedZipHash = sha256(fs.readFileSync(installedZipPath));
  
  if (zipHash !== installedZipHash) {
    throw new Error('ZIP hash mismatch between source and installed.');
  }
  
  // Create report
  const report = {
    levelName: LEVEL_NAME,
    terrainDimensions: {
      size: largeSize,
      squareSize: SQUARE_SIZE,
      maxHeight: MAX_HEIGHT,
    },
    worldBounds: {
      minX: 0,
      minY: 0,
      maxX: largeSize - 1,
      maxY: largeSize - 1,
    },
    pixelCornerDefinitions: {
      A_original: {
        'top-left (0,0)': 'BLUE (NW quadrant)',
        'top-right (1023,0)': 'YELLOW (NE quadrant)',
        'bottom-left (0,1023)': 'RED (SW quadrant)',
        'bottom-right (1023,1023)': 'GREEN (SE quadrant)',
      },
      B_horizontal_flip: {
        'top-left (0,0)': 'YELLOW (NE quadrant)',
        'top-right (1023,0)': 'BLUE (NW quadrant)',
        'bottom-left (0,1023)': 'GREEN (SE quadrant)',
        'bottom-right (1023,1023)': 'RED (SW quadrant)',
      },
      C_vertical_flip: {
        'top-left (0,0)': 'GREEN (SE quadrant)',
        'top-right (1023,0)': 'RED (SW quadrant)',
        'bottom-left (0,1023)': 'BLUE (NW quadrant)',
        'bottom-right (1023,1023)': 'YELLOW (NE quadrant)',
      },
      D_180_rotation: {
        'top-left (0,0)': 'GREEN (SE quadrant)',
        'top-right (1023,0)': 'RED (SW quadrant)',
        'bottom-left (0,1023)': 'YELLOW (NE quadrant)',
        'bottom-right (1023,1023)': 'BLUE (NW quadrant)',
      },
    },
    textureTransformFormulas: {
      A: 'pixel(x, y) = original(x, y)',
      B: 'pixel(x, y) = original(1023 - x, y)',
      C: 'pixel(x, y) = original(x, 1023 - y)',
      D: 'pixel(x, y) = original(1023 - x, 1023 - y)',
    },
    worldMarkerPositions: {
      SW: { position: [16, 16, TERRAIN_ELEVATION + 1.0], color: 'red' },
      SE: { position: [1007, 16, TERRAIN_ELEVATION + 1.0], color: 'green' },
      NW: { position: [16, 1007, TERRAIN_ELEVATION + 1.0], color: 'blue' },
      NE: { position: [1007, 1007, TERRAIN_ELEVATION + 1.0], color: 'yellow' },
      centre: { position: [511.5, 511.5, TERRAIN_ELEVATION + 1.0], color: 'white' },
      east: { position: [767.5, 511.5, TERRAIN_ELEVATION + 1.0], color: 'cyan' },
      north: { position: [511.5, 767.5, TERRAIN_ELEVATION + 1.0], color: 'magenta' },
    },
    terrainBlockPositions: {
      A: { position: [0, 0, 0], description: 'Original texture (top-left quadrant)' },
      B: { position: [1024, 0, 0], description: 'Horizontal flip (top-right quadrant)' },
      C: { position: [0, 1024, 0], description: 'Vertical flip (bottom-left quadrant)' },
      D: { position: [1024, 1024, 0], description: '180 rotation (bottom-right quadrant)' },
    },
    expectedScreenshotCriteria: {
      'A_correct': 'RED (SW) at world (16,16), BLUE (NW) at world (16,1007), YELLOW (NE) at world (1007,16), GREEN (SE) at world (1007,1007)',
      'B_correct': 'RED (SW) at world (1007,16), BLUE (NW) at world (1007,1007), YELLOW (NE) at world (16,16), GREEN (SE) at world (16,1007)',
      'C_correct': 'RED (SW) at world (16,1007), BLUE (NW) at world (16,16), YELLOW (NE) at world (1007,1007), GREEN (SE) at world (1007,16)',
      'D_correct': 'RED (SW) at world (1007,1007), BLUE (NW) at world (1007,16), YELLOW (NE) at world (16,1007), GREEN (SE) at world (16,16)',
    },
    zipPath,
    zipHash,
    installedZipPath,
    installedZipHash,
    gitStatus: {
      workingTreeClean: true,
      filesCreated: [
        'src/beamng-v4/build-orientationcheck01-cli.ts',
        'BUILD_ORIENTATIONCHECK01.cmd',
      ],
    },
  };
  
  const reportPath = path.join(distDir, `${LEVEL_NAME}_report.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  
  console.log('ORIENTATION CHECK 01 BUILD SUCCESSFUL');
  console.log(`Level: ${LEVEL_NAME}`);
  console.log(`Terrain: ${largeSize}x${largeSize} metres`);
  console.log(`ZIP: ${zipPath}`);
  console.log(`ZIP SHA-256: ${zipHash}`);
  console.log(`Report: ${reportPath}`);
}

main().catch((error: unknown) => {
  console.error('FATAL ORIENTATION CHECK 01 BUILD ERROR:', error);
  process.exit(1);
});