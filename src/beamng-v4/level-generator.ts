import type { AnalyticTerrainResult } from './types';
import { generateSolidPng } from './texture-generator';

export interface LevelPackageFiles {
  infoJson: string;
  itemsLevelJson: string;
  terrainJson: string;
  materialsJson: string;
  diffusePng: Uint8Array;
  normalPng: Uint8Array;
}

export function generateLevelPackageFiles(analytic: AnalyticTerrainResult): LevelPackageFiles {
  const spawnZ = analytic.controlPoints.p256_256.decoded + 3.0; // 3m safe offset above terrain

  const infoObj = {
    title: "TriWorld V4 Native Gate 0",
    description: "Native BeamNG terrain format validation level",
    authors: "TriWorld",
    size: [analytic.size, analytic.size],
    defaultSpawnPointName: "spawns_default",
    spawnPoints: [
      {
        translationId: "TriWorld V4 Default Spawn",
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
    squareSize: analytic.squareSize,
    maxHeight: analytic.maxHeight,
    baseTexSize: 1024,
    lightMapSize: 256,
    screenError: 16,
    castShadows: true,
  };

  const spawnSphereObj = {
    name: "spawns_default",
    class: "SpawnSphere",
    __parent: "MissionGroup",
    position: [256, 256, spawnZ],
    rotationMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    scale: [1, 1, 1],
    dataBlock: "SpawnSphereMarker",
  };

  // Line-delimited JSON for items.level.json
  const itemsLevelJson = [
    JSON.stringify(missionGroupObj),
    JSON.stringify(levelInfoObj),
    JSON.stringify(scatterSkyObj),
    JSON.stringify(terrainBlockObj),
    JSON.stringify(spawnSphereObj),
  ].join('\n');

  const terrainJsonObj = {
    version: 9,
    datafile: "terrain.ter",
    size: analytic.size,
    heightMapSize: analytic.size,
    heightMapItemSize: 2,
    layerMapSize: analytic.size,
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
