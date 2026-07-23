import type { BeamNGTerrainArtifact } from './types';
import { generateCustomPng, generateSolidPng } from './texture-generator';
import type { LevelMarker } from './diagnostic-markers';

export interface LevelPackageOptions {
  title?: string;
  description?: string;
  extraMarkers?: LevelMarker[];
  extraObjects?: Array<Record<string, unknown>>;
  diffusePng?: Uint8Array;
  normalPng?: Uint8Array;
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
  roadDiffusePng: Uint8Array;
  roadNormalPng: Uint8Array;
}

export function generateLevelPackageFiles(
  artifact: Pick<BeamNGTerrainArtifact, 'size' | 'squareSize' | 'maxHeight'> & {
    controlPoints?: Record<string, { decoded: number }>;
  },
  options: LevelPackageOptions = {}
): LevelPackageFiles {
  const size = artifact.size;
  const half = (size * artifact.squareSize) / 2;
  const defaultSpawnZ = artifact.controlPoints?.p256_256?.decoded
    ? artifact.controlPoints.p256_256.decoded + 3.0
    : 30.0;

  const title = options.title ?? 'TriWorld V4 Native Gate 0';
  const description = options.description ?? 'Native BeamNG terrain format validation level';

  const infoObj = {
    title,
    description,
    authors: 'TriWorld',
    size: [size, size],
    defaultSpawnPointName: 'spawns_default',
    spawnPoints: [
      {
        translationId: `${title} Default Spawn`,
        description: 'Centre validation spawn',
        objectname: 'spawns_default',
      },
    ],
    supportsTraffic: Boolean(options.extraObjects?.some((object) => object.class === 'DecalRoad')),
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
    canvasClearColor: 'black',
    enabled: '1',
    gravity: -9.81,
    visibleDistance: 4000,
  };

  const scatterSkyObj = {
    name: 'sunsky',
    class: 'ScatterSky',
    __parent: 'MissionGroup',
    skyBrightness: 40,
    sunScale: [1, 1, 1, 1],
    ambientScale: [1, 1, 1, 1],
    azimuth: 290,
    elevation: 35,
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
    screenError: 16,
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

  // BeamNG uses line-delimited JSON: one complete scene object per line.
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
      baseColorBaseTex: '/levels/triworld_v4/art/terrains/triworld_v4_ground_d.png',
      baseColorBaseTexSize: size,
      diffuseMap: '/levels/triworld_v4/art/terrains/triworld_v4_ground_d.png',
      diffuseSize: size,
      macroMap: '/levels/triworld_v4/art/terrains/triworld_v4_ground_d.png',
      macroSize: size,
      normalMap: '/levels/triworld_v4/art/terrains/triworld_v4_ground_n.png',
      normalBaseTex: '/levels/triworld_v4/art/terrains/triworld_v4_ground_n.png',
      normalBaseTexSize: size,
      detailSize: size,
      groundmodelName: 'GRASS',
    },
    triworld_v4_asphalt: {
      name: 'triworld_v4_asphalt',
      class: 'Material',
      mapTo: 'triworld_v4_asphalt',
      baseColorMap: ['/levels/triworld_v4/art/roads/triworld_v4_asphalt.color.png'],
      normalMap: ['/levels/triworld_v4/art/roads/triworld_v4_asphalt.normal.png'],
      baseColorFactor: [[1, 1, 1, 1]],
      roughnessFactor: [0.92],
      metallicFactor: [0],
      useAnisotropic: true,
      materialTag0: 'beamng',
      materialTag1: 'RoadAndPath',
      groundType: 'ASPHALT',
      version: 1.5,
    },
  };

  const diffusePng = options.diffusePng ?? generateSolidPng(16, 16, 40, 120, 50);
  const normalPng = options.normalPng ?? generateSolidPng(16, 16, 128, 128, 255);
  const roadDiffusePng = options.roadDiffusePng ?? generateAsphaltTexture();
  const roadNormalPng = options.roadNormalPng ?? generateSolidPng(16, 16, 128, 128, 255);

  return {
    infoJson: JSON.stringify(infoObj, null, 2),
    itemsLevelJson,
    terrainJson: JSON.stringify(terrainJsonObj, null, 2),
    materialsJson: JSON.stringify(materialsJsonObj, null, 2),
    diffusePng,
    normalPng,
    roadDiffusePng,
    roadNormalPng,
  };
}

function generateAsphaltTexture(): Uint8Array {
  const width = 256;
  const height = 512;
  return generateCustomPng(width, height, (x, y) => {
    const edgeLine = (x >= 11 && x <= 16) || (x >= width - 17 && x <= width - 12);
    const centreLine = Math.abs(x - width / 2) <= 2 && (y % 96) < 54;
    if (edgeLine || centreLine) return [218, 216, 196];
    const deterministicNoise = ((x * 37 + y * 17 + ((x * y) % 23)) % 19) - 9;
    const value = 54 + deterministicNoise;
    return [value, value, value + 2];
  });
}
