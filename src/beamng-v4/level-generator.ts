import type { BeamNGTerrainArtifact } from './types';
import { generateSolidPng } from './texture-generator';
import type { LevelMarker } from './diagnostic-markers';

export interface LevelPackageOptions {
  title?: string;
  description?: string;
  extraMarkers?: LevelMarker[];
}

export interface LevelPackageFiles {
  infoJson: string;
  itemsLevelJson: string;
  terrainJson: string;
  materialsJson: string;
  diffusePng: Uint8Array;
  normalPng: Uint8Array;
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

  const title = options.title ?? "TriWorld V4 Native Gate 0";
  const description = options.description ?? "Native BeamNG terrain format validation level";

  const infoObj = {
    title,
    description,
    authors: "TriWorld",
    size: [size, size],
    defaultSpawnPointName: "spawns_default",
    spawnPoints: [
      {
        translationId: `${title} Default Spawn`,
        description: "Centre validation spawn",
        objectname: "spawns_default",
      },
    ],
    supportsTraffic: false,
  };

  const missionGroupObj = {
    name: "MissionGroup",
    class: "SimGroup",
    persistentId: "0f63c91a-f026-4b20-818f-1ea45fae1892",
    enabled: "1",
  };

  const levelInfoObj = {
    name: "theLevelInfo",
    class: "LevelInfo",
    __parent: "MissionGroup",
    canvasClearColor: "black",
    enabled: "1",
    gravity: -9.81,
    visibleDistance: 4000,
  };

  const scatterSkyObj = {
    name: "sunsky",
    class: "ScatterSky",
    __parent: "MissionGroup",
    skyBrightness: 40,
    sunScale: [1, 1, 1, 1],
    ambientScale: [1, 1, 1, 1],
    azimuth: 290,
    elevation: 35,
  };

  const terrainBlockObj = {
    name: "theTerrain",
    class: "TerrainBlock",
    __parent: "MissionGroup",
    terrainFile: "/levels/triworld_v4/art/terrains/terrain.ter",
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
    name: "spawns_default",
    class: "SpawnSphere",
    __parent: "MissionGroup",
    position: [half, half, defaultSpawnZ],
    rotationMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    scale: [1, 1, 1],
    dataBlock: "SpawnSphereMarker",
  };

  const itemObjects = [
    missionGroupObj,
    levelInfoObj,
    scatterSkyObj,
    terrainBlockObj,
  ];

  if (options.extraMarkers && options.extraMarkers.length > 0) {
    for (const marker of options.extraMarkers) {
      itemObjects.push(marker as any);
    }
  } else {
    itemObjects.push(defaultSpawnObj as any);
  }

  // Line-delimited JSON for items.level.json
  const itemsLevelJson = itemObjects.map((obj) => JSON.stringify(obj)).join('\n');

  const terrainJsonObj = {
    version: 9,
    datafile: "terrain.ter",
    size,
    heightMapSize: size,
    heightMapItemSize: 2,
    layerMapSize: size,
    layerMapItemSize: 1,
    materials: ["triworld_v4_ground"],
  };

  const materialsJsonObj = {
    triworld_v4_ground: {
      name: "triworld_v4_ground",
      class: "TerrainMaterial",
      internalName: "triworld_v4_ground",
      diffuseMap: "/levels/triworld_v4/art/terrains/triworld_v4_ground_d.png",
      normalMap: "/levels/triworld_v4/art/terrains/triworld_v4_ground_n.png",
      detailMap: "/levels/triworld_v4/art/terrains/triworld_v4_ground_d.png",
      detailSize: 4,
      groundmodelName: "GRASS",
    },
  };

  const diffusePng = generateSolidPng(16, 16, 40, 120, 50); // Soft green grass
  const normalPng = generateSolidPng(16, 16, 128, 128, 255); // Flat normal map (Z up)

  return {
    infoJson: JSON.stringify(infoObj, null, 2),
    itemsLevelJson,
    terrainJson: JSON.stringify(terrainJsonObj, null, 2),
    materialsJson: JSON.stringify(materialsJsonObj, null, 2),
    diffusePng,
    normalPng,
  };
}
