import type { BeamNGTerrainArtifact } from './types';
import { generateSolidPng } from './texture-generator';
import type { LevelMarker } from './diagnostic-markers';

export interface LevelPackageOptions {
  title?: string;
  description?: string;
  extraMarkers?: LevelMarker[];
  extraObjects?: Array<Record<string, unknown>>;
  defaultSpawnObject?: Record<string, unknown>;
  supportsTraffic?: boolean;
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
  roadDiffusePng?: Uint8Array;
  roadNormalPng?: Uint8Array;
}

export function generateLevelPackageFiles(
  artifact: Pick<BeamNGTerrainArtifact, 'size' | 'squareSize' | 'maxHeight'> & {
    materialNames?: readonly string[];
    controlPoints?: Record<string, { decoded: number }>;
  },
  options: LevelPackageOptions = {}
): LevelPackageFiles {
  const size = artifact.size;
  const half = (size * artifact.squareSize) / 2;
  const materialNames = artifact.materialNames ?? ['triworld_v4_ground'];
  const defaultSpawnZ = artifact.controlPoints?.p256_256?.decoded
    ? artifact.controlPoints.p256_256.decoded + 3.0
    : 30.0;

  const title = options.title ?? 'TriWorld V4 Native Gate 0';
  const description = options.description ?? 'Native BeamNG terrain format validation level';
  const extraObjects = options.extraObjects ?? [];
  const hasRoadObject = extraObjects.some((object) => object.class === 'DecalRoad');
  const needsRoadAssets = hasRoadObject || materialNames.includes('ASPHALT');

  const infoObj = {
    title,
    description,
    authors: 'TriWorld',
    size: [size, size],
    defaultSpawnPointName: 'spawns_default',
    spawnPoints: [
      {
        translationId: `${title} Default Spawn`,
        description: 'Road-aligned validation spawn',
        objectname: 'spawns_default',
      },
    ],
    supportsTraffic: options.supportsTraffic ?? hasRoadObject,
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

  const defaultSpawnObj = options.defaultSpawnObject ?? {
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
    itemObjects.push(...options.extraMarkers as Array<Record<string, unknown>>);
  }
  itemObjects.push(...extraObjects);

  const hasExplicitSpawn = itemObjects.some((object) => object.name === 'spawns_default');
  if (!hasExplicitSpawn) itemObjects.push(defaultSpawnObj);

  const itemsLevelJson = itemObjects.map((obj) => JSON.stringify(obj)).join('\n');

  const terrainJsonObj = {
    version: 9,
    datafile: '/levels/triworld_v4/art/terrains/terrain.ter',
    size,
    heightMapSize: size,
    heightMapItemSize: 2,
    layerMapSize: size,
    layerMapItemSize: 1,
    materials: [...materialNames],
  };

  const materialsJsonObj: Record<string, Record<string, unknown>> = {
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
      annotation: 'NATURE',
    },
  };

  if (materialNames.includes('ASPHALT')) {
    materialsJsonObj.ASPHALT = {
      name: 'ASPHALT',
      class: 'TerrainMaterial',
      internalName: 'ASPHALT',
      baseColorBaseTex: '/levels/triworld_v4/art/roads/triworld_v4_asphalt_d.png',
      baseColorBaseTexSize: 8,
      diffuseMap: '/levels/triworld_v4/art/roads/triworld_v4_asphalt_d.png',
      diffuseSize: 8,
      macroMap: '/levels/triworld_v4/art/roads/triworld_v4_asphalt_d.png',
      macroSize: 24,
      normalMap: '/levels/triworld_v4/art/roads/triworld_v4_asphalt_n.png',
      normalBaseTex: '/levels/triworld_v4/art/roads/triworld_v4_asphalt_n.png',
      normalBaseTexSize: 8,
      detailSize: 8,
      groundmodelName: 'ASPHALT',
      annotation: 'ROAD',
    };
  }

  if (hasRoadObject) {
    materialsJsonObj.triworld_v4_road_decal = {
      name: 'triworld_v4_road_decal',
      mapTo: 'triworld_v4_road_decal',
      class: 'Material',
      Stages: [
        {
          baseColorMap: '/levels/triworld_v4/art/roads/triworld_v4_asphalt_d.png',
          normalMap: '/levels/triworld_v4/art/roads/triworld_v4_asphalt_n.png',
          roughnessFactor: 0.88,
          metallicFactor: 0,
        },
        {},
        {},
        {},
      ],
      translucent: false,
      doubleSided: true,
      materialTag0: 'RoadAndPath',
      annotation: 'ROAD',
      version: 1.5,
    };
  }

  const diffusePng = options.diffusePng ?? generateSolidPng(16, 16, 40, 120, 50);
  const normalPng = options.normalPng ?? generateSolidPng(16, 16, 128, 128, 255);
  const roadDiffusePng = needsRoadAssets
    ? options.roadDiffusePng ?? generateSolidPng(32, 32, 48, 49, 52)
    : undefined;
  const roadNormalPng = needsRoadAssets
    ? options.roadNormalPng ?? generateSolidPng(16, 16, 128, 128, 255)
    : undefined;

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
