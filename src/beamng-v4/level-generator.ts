import type { BeamNGTerrainArtifact } from './types';
import { generateCustomPng } from './texture-generator';
import type { LevelMarker } from './diagnostic-markers';

export interface LevelPackageOptions {
  title?: string;
  description?: string;
  extraMarkers?: LevelMarker[];
  extraObjects?: Array<Record<string, unknown>>;
  diffusePng?: Uint8Array;
  normalPng?: Uint8Array;
  terrainMacroPng?: Uint8Array;
  terrainDetailPng?: Uint8Array;
  roadDiffusePng?: Uint8Array;
  roadNormalPng?: Uint8Array;
}

export interface LevelPackageFiles {
  infoJson: string;
  itemsLevelJson: string;
  terrainJson: string;
  materialsJson: string;
  diffusePng: Uint8Array;
  normalPng: Uint8Array;
  terrainMacroPng: Uint8Array;
  terrainDetailPng: Uint8Array;
  roadDiffusePng: Uint8Array;
  roadNormalPng: Uint8Array;
}

export function generateLevelPackageFiles(
  artifact: Pick<BeamNGTerrainArtifact, 'size' | 'squareSize' | 'maxHeight'> & {
    controlPoints?: Record<string, { decoded: number }>;
  },
  options: LevelPackageOptions = {},
): LevelPackageFiles {
  const size = artifact.size;
  const half = (size * artifact.squareSize) / 2;
  const defaultSpawnZ = artifact.controlPoints?.p256_256?.decoded
    ? artifact.controlPoints.p256_256.decoded + 1.0
    : 30.0;

  const title = options.title ?? 'TriWorld V4 Native Gate 0';
  const description = options.description ?? 'Native BeamNG terrain format validation level';
  const hasRoad = Boolean(options.extraObjects?.some((object) => object.class === 'DecalRoad'));

  const infoObj = {
    title,
    description,
    authors: 'TriWorld',
    size: [size, size],
    defaultSpawnPointName: 'spawns_default',
    spawnPoints: [
      {
        translationId: `${title} Default Spawn`,
        description: hasRoad ? 'Road start' : 'Centre validation spawn',
        objectname: 'spawns_default',
      },
    ],
    supportsTraffic: hasRoad,
    roadRules: {
      rightHandDrive: true,
      turnOnRed: false,
    },
  };

  const missionGroupObj = {
    name: 'MissionGroup',
    class: 'SimGroup',
    persistentId: '0f63c91a-f026-4b20-818f-1ea45fae1892',
    enabled: '1',
  };

  const levelInfoObj = {
    name: 'theLevelInfo',
    class: 'LevelInfo',
    __parent: 'MissionGroup',
    canvasClearColor: '0.40 0.55 0.70 1',
    enabled: '1',
    gravity: -9.81,
    visibleDistance: 5000,
  };

  const scatterSkyObj = {
    name: 'sunsky',
    class: 'ScatterSky',
    __parent: 'MissionGroup',
    skyBrightness: 18,
    sunScale: [0.95, 0.93, 0.88, 1],
    ambientScale: [0.62, 0.68, 0.72, 1],
    azimuth: 225,
    elevation: 38,
  };

  const terrainBlockObj = {
    name: 'theTerrain',
    class: 'TerrainBlock',
    __parent: 'MissionGroup',
    terrainFile: '/levels/triworld_v4/art/terrains/terrain.ter',
    position: [0, 0, 0],
    rotationMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    scale: [1, 1, 1],
    squareSize: artifact.squareSize,
    maxHeight: artifact.maxHeight,
    baseTexSize: 1024,
    lightMapSize: 256,
    screenError: 12,
    castShadows: true,
  };

  const defaultSpawnObj = {
    name: 'spawns_default',
    class: 'SpawnSphere',
    __parent: 'MissionGroup',
    position: [half, half, defaultSpawnZ],
    rotationMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    scale: [1, 1, 1],
    dataBlock: 'SpawnSphereMarker',
  };

  const itemObjects: Array<Record<string, unknown>> = [
    missionGroupObj,
    levelInfoObj,
    scatterSkyObj,
    terrainBlockObj,
  ];

  if (options.extraMarkers) {
    for (const marker of options.extraMarkers) itemObjects.push(marker as unknown as Record<string, unknown>);
  }
  if (options.extraObjects) {
    for (const object of options.extraObjects) itemObjects.push(object);
  }
  if (!itemObjects.some((object) => object.name === 'spawns_default')) {
    itemObjects.push(defaultSpawnObj);
  }

  const itemsLevelJson = itemObjects.map((obj) => JSON.stringify(obj)).join('\n');

  const terrainJsonObj = {
    version: 9,
    datafile: '/levels/triworld_v4/art/terrains/terrain.ter',
    size,
    heightMapSize: size,
    heightMapItemSize: 2,
    layerMapSize: size,
    layerMapItemSize: 1,
    materials: ['triworld_v4_ground'],
  };

  const materialsJsonObj = {
    triworld_v4_ground: {
      name: 'triworld_v4_ground',
      class: 'TerrainMaterial',
      internalName: 'triworld_v4_ground',
      annotation: 'NATURE',
      diffuseMap: '/levels/triworld_v4/art/terrains/triworld_v4_ground_d.png',
      diffuseSize: 48,
      normalMap: '/levels/triworld_v4/art/terrains/triworld_v4_ground_n.png',
      detailMap: '/levels/triworld_v4/art/terrains/triworld_v4_ground_detail.png',
      detailSize: 4,
      detailStrength: 0.32,
      detailDistance: 180,
      macroMap: '/levels/triworld_v4/art/terrains/triworld_v4_ground_macro.png',
      macroSize: 220,
      macroStrength: 0.38,
      macroDistance: 1800,
      useSideProjection: true,
      parallaxScale: 0.018,
      groundmodelName: 'GRASS',
    },
    triworld_v4_asphalt: {
      name: 'triworld_v4_asphalt',
      class: 'Material',
      mapTo: 'triworld_v4_asphalt',
      annotation: 'ROAD',
      baseColorMap: ['/levels/triworld_v4/art/roads/triworld_v4_asphalt.color.png'],
      normalMap: ['/levels/triworld_v4/art/roads/triworld_v4_asphalt.normal.png'],
      baseColorFactor: [[1.12, 1.12, 1.12, 1]],
      roughnessFactor: [0.84],
      metallicFactor: [0],
      useAnisotropic: true,
      translucent: false,
      translucentZWrite: false,
      doubleSided: false,
      materialTag0: 'beamng',
      materialTag1: 'RoadAndPath',
      groundType: 'ASPHALT',
      version: 1.5,
    },
  };

  const diffusePng = options.diffusePng ?? generateTerrainBaseTexture();
  const normalPng = options.normalPng ?? generateTerrainNormalTexture();
  const terrainMacroPng = options.terrainMacroPng ?? generateTerrainMacroTexture();
  const terrainDetailPng = options.terrainDetailPng ?? generateTerrainDetailTexture();
  const roadDiffusePng = options.roadDiffusePng ?? generateAsphaltTexture();
  const roadNormalPng = options.roadNormalPng ?? generateRoadNormalTexture();

  return {
    infoJson: JSON.stringify(infoObj, null, 2),
    itemsLevelJson,
    terrainJson: JSON.stringify(terrainJsonObj, null, 2),
    materialsJson: JSON.stringify(materialsJsonObj, null, 2),
    diffusePng,
    normalPng,
    terrainMacroPng,
    terrainDetailPng,
    roadDiffusePng,
    roadNormalPng,
  };
}

function generateTerrainBaseTexture(): Uint8Array {
  const width = 512;
  const height = 512;
  return generateCustomPng(width, height, (x, y) => {
    const px = x / width;
    const py = y / height;
    const broad = Math.sin(px * Math.PI * 2) * 0.42
      + Math.cos(py * Math.PI * 2) * 0.34
      + Math.sin((px + py) * Math.PI * 4) * 0.18;
    const medium = Math.sin((px * 5 - py * 3) * Math.PI * 2) * 0.13;
    const grain = hashNoise(x, y) - 0.5;
    const earth = clamp01(0.46 + broad * 0.22 + medium * 0.18);
    return [
      67 + earth * 30 + grain * 12,
      79 - earth * 10 + grain * 10,
      45 - earth * 5 + grain * 8,
    ];
  });
}

function generateTerrainMacroTexture(): Uint8Array {
  const width = 256;
  const height = 256;
  return generateCustomPng(width, height, (x, y) => {
    const px = x / width;
    const py = y / height;
    const variation = Math.sin(px * Math.PI * 4) * 8
      + Math.cos(py * Math.PI * 6) * 6
      + (hashNoise(Math.floor(x / 3), Math.floor(y / 3)) - 0.5) * 8;
    return [126 + variation, 128 + variation * 0.72, 122 + variation * 0.46];
  });
}

function generateTerrainDetailTexture(): Uint8Array {
  const width = 256;
  const height = 256;
  return generateCustomPng(width, height, (x, y) => {
    const grain = (hashNoise(x, y) - 0.5) * 32;
    const fibres = Math.sin((x * 0.43 + y * 0.17) * Math.PI) * 5;
    const value = 128 + grain + fibres;
    return [value + 2, value, value - 3];
  });
}

function generateTerrainNormalTexture(): Uint8Array {
  const width = 256;
  const height = 256;
  return generateCustomPng(width, height, (x, y) => {
    const nx = (hashNoise(x, y) - 0.5) * 10;
    const ny = (hashNoise(y + 73, x + 29) - 0.5) * 10;
    return [128 + nx, 128 + ny, 254];
  });
}

function generateAsphaltTexture(): Uint8Array {
  const width = 256;
  const height = 512;
  return generateCustomPng(width, height, (x, y) => {
    const edgeLine = (x >= 10 && x <= 14) || (x >= width - 15 && x <= width - 11);
    const centreLine = Math.abs(x - width / 2) <= 2 && (y % 112) < 62;
    if (edgeLine) return [218, 216, 198];
    if (centreLine) return [205, 202, 176];
    const coarse = (hashNoise(Math.floor(x / 3), Math.floor(y / 3)) - 0.5) * 15;
    const fine = (hashNoise(x + 191, y + 47) - 0.5) * 18;
    const aggregate = ((x * 13 + y * 7) % 31 === 0) ? 18 : 0;
    const value = 82 + coarse + fine + aggregate;
    return [value, value, value + 2];
  });
}

function generateRoadNormalTexture(): Uint8Array {
  const width = 256;
  const height = 512;
  return generateCustomPng(width, height, (x, y) => {
    const nx = (hashNoise(x, y) - 0.5) * 7;
    const ny = (hashNoise(y + 11, x + 101) - 0.5) * 7;
    return [128 + nx, 128 + ny, 254];
  });
}

function hashNoise(x: number, y: number): number {
  let value = Math.imul(x + 374761393, 668265263) ^ Math.imul(y + 1274126177, 2246822519);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
