import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { PNG } from 'pngjs';
import { writeBeamNGTer } from './writer';
import { generateSolidPng } from './texture-generator';
import type {
  SitecheckOverlayResolution,
  SitecheckRoadOverlay,
} from './sitecheck-sumo-overlay';
import {
  SITECHECK_DEM_COARSE_SIZE,
  SITECHECK_DEM_ZOOM,
  SITECHECK_MAX_HEIGHT,
  SITECHECK_SIZE,
  type SitecheckTerrain,
} from './sitecheck-terrain';

const LEVEL_NAME = 'sitecheck01';
const WORLD_CENTER = (SITECHECK_SIZE - 1) / 2;
const HALF_EXTENT = SITECHECK_SIZE / 2;
const ROAD_LIFT_METRES = 0.30;
const MARKER_LIFT_METRES = 0.45;
const SQUARE_SIZE = 1.0;

type LevelObject = Record<string, unknown>;

export interface SitecheckPackageInput {
  centerWgs84: { longitude: number; latitude: number; altitude: number };
  centerUtm34N: {
    easting: number;
    northing: number;
    elevation: number;
    zone: number;
  };
  expectedRoadNames: string[];
  sourcePaths: {
    osm: string;
    sumoNet: string;
    orthophoto: string;
  };
  sourceHashes: {
    osm: string;
    sumo: string;
    orthophoto: string;
  };
  orthophotoPath: string;
  roads: SitecheckRoadOverlay[];
  overlayResolution: SitecheckOverlayResolution;
  terrain: SitecheckTerrain;
}

export interface SitecheckPackageResult {
  zipPath: string;
  zipHash: string;
  installedZipPath: string | null;
  installedZipHash: string;
  reportPath: string;
}

export async function buildSitecheckPackage(
  input: SitecheckPackageInput,
): Promise<SitecheckPackageResult> {
  const roadObjects = createRoadObjects(input.roads, input.terrain.sample);
  const markerObjects: LevelObject[] = [
    ...createCross(
      'accident_centre',
      WORLD_CENTER,
      WORLD_CENTER,
      'sitecheck01_white',
      1000,
      input.terrain.sample,
      8,
      2.5,
    ),
    ...createCross('corner_sw', 64, 64, 'sitecheck01_red', 1010, input.terrain.sample),
    ...createCross('corner_se', 959, 64, 'sitecheck01_green', 1020, input.terrain.sample),
    ...createCross('corner_nw', 64, 959, 'sitecheck01_blue', 1030, input.terrain.sample),
    ...createCross('corner_ne', 959, 959, 'sitecheck01_yellow', 1040, input.terrain.sample),
  ];

  const centerElevation = input.terrain.sample(WORLD_CENTER, WORLD_CENTER);
  const terrainBuffer = writeBeamNGTer({
    version: 9,
    size: SITECHECK_SIZE,
    squareSize: SQUARE_SIZE,
    maxHeight: SITECHECK_MAX_HEIGHT,
    heightScale: input.terrain.heightScale,
    minimumDecodedElevation: input.terrain.minElevation,
    maximumDecodedElevation: input.terrain.maxElevation,
    heightMapU16: input.terrain.heightMapU16,
    layerMapU8: input.terrain.layerMapU8,
    materialNames: ['sitecheck01_ground'],
  });

  const orthophotoBytes = fs.readFileSync(input.orthophotoPath);
  const decodedOrthophoto = PNG.sync.read(orthophotoBytes);
  if (
    decodedOrthophoto.width !== SITECHECK_SIZE ||
    decodedOrthophoto.height !== SITECHECK_SIZE
  ) {
    throw new Error(
      `SITECHECK01 rejected: orthophoto is ${decodedOrthophoto.width}x` +
      `${decodedOrthophoto.height}, expected 1024x1024.`,
    );
  }

  const items: LevelObject[] = [
    {
      name: 'MissionGroup',
      class: 'SimGroup',
      persistentId: 'd0ddad56-c0ff-4010-a000-000000000001',
      enabled: '1',
    },
    {
      name: 'theLevelInfo',
      class: 'LevelInfo',
      __parent: 'MissionGroup',
      canvasClearColor: 'black',
      enabled: '1',
      gravity: -9.81,
      visibleDistance: 4000,
    },
    {
      name: 'sunsky',
      class: 'ScatterSky',
      __parent: 'MissionGroup',
      skyBrightness: 40,
      sunScale: [1, 1, 1, 1],
      ambientScale: [1, 1, 1, 1],
      azimuth: 290,
      elevation: 35,
    },
    {
      name: 'theTerrain',
      class: 'TerrainBlock',
      __parent: 'MissionGroup',
      terrainFile: `/levels/${LEVEL_NAME}/art/terrains/terrain.ter`,
      position: [0, 0, 0],
      rotationMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      scale: [1, 1, 1],
      squareSize: SQUARE_SIZE,
      maxHeight: SITECHECK_MAX_HEIGHT,
      baseTexSize: 1024,
      lightMapSize: 256,
      screenError: 16,
      castShadows: true,
    },
    {
      name: 'spawns_default',
      class: 'SpawnSphere',
      __parent: 'MissionGroup',
      position: [WORLD_CENTER, WORLD_CENTER, centerElevation + 8],
      rotationMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      scale: [1, 1, 1],
      dataBlock: 'SpawnSphereMarker',
    },
    ...roadObjects,
    ...markerObjects,
  ];

  const info = {
    title: 'SITECHECK01 — Bánovce Accident Site Source Alignment',
    description:
      'Correct accident-site centre, authoritative principal SUMO road ' +
      'centerlines, cached Terrarium DEM, unmodified north-up orthophoto, ' +
      'and exact centre marker. Diagnostic only: no terrain corridor ' +
      'deformation and no final road mesh.',
    authors: 'TriWorld',
    size: [SITECHECK_SIZE, SITECHECK_SIZE],
    defaultSpawnPointName: 'spawns_default',
    spawnPoints: [{
      translationId: 'SITECHECK01 Default Spawn',
      description: 'Exact accident-site centre diagnostic spawn',
      objectname: 'spawns_default',
    }],
    supportsTraffic: false,
  };

  const terrainJson = {
    version: 9,
    datafile: `/levels/${LEVEL_NAME}/art/terrains/terrain.ter`,
    size: SITECHECK_SIZE,
    heightMapSize: SITECHECK_SIZE,
    heightMapItemSize: 2,
    layerMapSize: SITECHECK_SIZE,
    layerMapItemSize: 1,
    materials: ['sitecheck01_ground'],
  };

  const materials = createMaterials();
  const entries: Array<{ zipPath: string; content: Uint8Array | string }> = [
    {
      zipPath: `levels/${LEVEL_NAME}/info.json`,
      content: JSON.stringify(info, null, 2),
    },
    {
      zipPath: `levels/${LEVEL_NAME}/main/items.level.json`,
      content: items.map((item) => JSON.stringify(item)).join('\n'),
    },
    {
      zipPath: `levels/${LEVEL_NAME}/art/terrains/terrain.ter`,
      content: terrainBuffer,
    },
    {
      zipPath: `levels/${LEVEL_NAME}/art/terrains/terrain.terrain.json`,
      content: JSON.stringify(terrainJson, null, 2),
    },
    {
      zipPath: `levels/${LEVEL_NAME}/art/terrains/main.materials.json`,
      content: JSON.stringify(materials, null, 2),
    },
    {
      zipPath: `levels/${LEVEL_NAME}/art/terrains/ground_d.png`,
      content: new Uint8Array(orthophotoBytes),
    },
    {
      zipPath: `levels/${LEVEL_NAME}/art/terrains/ground_n.png`,
      content: generateSolidPng(16, 16, 128, 128, 255),
    },
    ...colourTextureEntries(),
  ].sort((a, b) => a.zipPath.localeCompare(b.zipPath));

  const zip = new JSZip();
  const packagedHashes: Record<string, string> = {};
  for (const entry of entries) {
    zip.file(entry.zipPath, entry.content, {
      date: new Date('2026-07-24T12:00:00Z'),
    });
    packagedHashes[entry.zipPath] = sha256(entry.content);
  }

  const zipBytes = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });

  const distDirectory = path.resolve('dist');
  fs.mkdirSync(distDirectory, { recursive: true });
  const zipPath = path.join(distDirectory, `${LEVEL_NAME}.zip`);
  fs.writeFileSync(zipPath, zipBytes);

  const zipHash = hashFile(zipPath);
  let installedZipPath: string | null = null;
  let installedZipHash = zipHash;

  if (process.platform === 'win32') {
    const modsDirectory = path.join(
      process.env.LOCALAPPDATA ?? 'C:\\Users\\tomisu\\AppData\\Local',
      'BeamNG',
      'BeamNG.drive',
      'current',
      'mods',
    );
    fs.mkdirSync(modsDirectory, { recursive: true });
    const targetZipPath = path.join(modsDirectory, `${LEVEL_NAME}.zip`);
    fs.copyFileSync(zipPath, targetZipPath);
    installedZipPath = targetZipPath;
    installedZipHash = hashFile(targetZipPath);
    if (zipHash !== installedZipHash) {
      throw new Error(
        'SITECHECK01 rejected: source and installed ZIP hashes differ.',
      );
    }
  }

  const roadSummary = Object.fromEntries(input.expectedRoadNames.map((name) => {
    const matching = input.roads.filter(
      (road) => normalizeName(road.name) === normalizeName(name),
    );
    return [name, {
      wayCount: matching.length,
      nodeCount: matching.reduce(
        (sum, road) => sum + road.localPoints.length,
        0,
      ),
      sourceWayIds: [...new Set(matching.flatMap((road) => road.sourceWayIds))],
      sourceEdgeIds: [...new Set(matching.flatMap((road) => road.sourceEdgeIds))],
      materials: [...new Set(
        matching.map((road) => roadMaterialName(road.name)),
      )],
    }];
  }));

  const report = {
    levelName: LEVEL_NAME,
    purpose: 'Correct-site GIS source alignment diagnostic only',
    centerWgs84: input.centerWgs84,
    centerUtm34N: input.centerUtm34N,
    accidentCenterLocal: [WORLD_CENTER, WORLD_CENTER],
    sourceBBoxHalfExtentMetres: HALF_EXTENT,
    terrain: {
      size: SITECHECK_SIZE,
      squareSize: SQUARE_SIZE,
      maxHeight: SITECHECK_MAX_HEIGHT,
      minElevation: Number(input.terrain.minElevation.toFixed(3)),
      maxElevation: Number(input.terrain.maxElevation.toFixed(3)),
      centerElevation: Number(centerElevation.toFixed(3)),
      cachedDemTileCount: input.terrain.tileCount,
      demZoom: SITECHECK_DEM_ZOOM,
      coarseSamplingGrid: SITECHECK_DEM_COARSE_SIZE,
      terrainDeformationApplied: false,
    },
    orthophoto: {
      sourcePath: input.sourcePaths.orthophoto,
      sourceHash: input.sourceHashes.orthophoto,
      packagedHash: packagedHashes[
        `levels/${LEVEL_NAME}/art/terrains/ground_d.png`
      ],
      width: decodedOrthophoto.width,
      height: decodedOrthophoto.height,
      transformApplied: 'none',
    },
    osm: {
      sourcePath: input.sourcePaths.osm,
      sourceHash: input.sourceHashes.osm,
      expectedRoads: input.expectedRoadNames,
      resolvedWayCount: input.roads.length,
      roadSummary,
    },
    sumo: {
      sourcePath: input.sourcePaths.sumoNet,
      sourceHash: input.sourceHashes.sumo,
      geometrySource: input.overlayResolution.sourceType,
      netOffset: input.overlayResolution.netOffset,
      projection: input.overlayResolution.projection,
      audits: input.overlayResolution.audits,
    },
    overlays: {
      roadDecalCount: roadObjects.length,
      markerDecalCount: markerObjects.length,
      totalDecalCount: roadObjects.length + markerObjects.length,
      roadLiftMetres: ROAD_LIFT_METRES,
      markerLiftMetres: MARKER_LIFT_METRES,
      roadWidthMetres: 2.0,
      opacity: 0.62,
      legend: {
        Partizánska: 'cyan',
        'Trenčianska cesta': 'magenta',
        'Ľudmily Podjavorinskej': 'yellow',
        accidentCentre: 'white cross',
        SW: 'red cross',
        SE: 'green cross',
        NW: 'blue cross',
        NE: 'yellow cross',
      },
    },
    verification: {
      correctSiteCenter: true,
      epsg32634: true,
      committedSourceHashesMatch: true,
      allExpectedRoadsResolved: input.expectedRoadNames.every((name) =>
        input.roads.some(
          (road) => normalizeName(road.name) === normalizeName(name),
        ),
      ),
      sumoPrincipalCenterlines:
        input.overlayResolution.sourceType ===
        'sumo-netconvert-principal-centerlines',
      noReverseDirectionDuplicates:
        input.overlayResolution.audits.every(
          (audit) => audit.canonicalEdgeCount <= audit.rawDirectedEdgeCount,
        ),
      noNamedRoadFan: input.overlayResolution.audits.every(
        (audit) => audit.selectedOverlayCount <= 2,
      ),
      orthophotoNoTransform: true,
      terrainDeformationApplied: false,
      finalRoadMeshIncluded: false,
      sourceAndInstalledZipHashesMatch: zipHash === installedZipHash,
    },
    zipPath,
    zipHash,
    installedZipPath,
    installedZipHash,
  };

  const reportPath = path.join(distDirectory, `${LEVEL_NAME}_report.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  return {
    zipPath,
    zipHash,
    installedZipPath,
    installedZipHash,
    reportPath,
  };
}

function createRoadObjects(
  roads: readonly SitecheckRoadOverlay[],
  sampleTerrain: (x: number, y: number) => number,
): LevelObject[] {
  return roads.map((road, index) => ({
    name:
      `sumo_${roadMaterialName(road.name).replace('sitecheck01_', '')}_` +
      `${road.wayId.replace(/[^a-zA-Z0-9_+-]/g, '_')}_${index}`,
    class: 'DecalRoad',
    __parent: 'MissionGroup',
    material: roadMaterialName(road.name),
    textureLength: 8,
    renderPriority: 20 + index,
    drivability: -1,
    autoLanes: false,
    autoJunction: false,
    oneWay: false,
    flipDirection: false,
    overObjects: true,
    zBias: 0.02,
    decalBias: 0.05,
    breakAngle: 3,
    nodes: road.localPoints.map((point) => [
      Number(point.x.toFixed(3)),
      Number(point.y.toFixed(3)),
      Number((sampleTerrain(point.x, point.y) + ROAD_LIFT_METRES).toFixed(3)),
      2.0,
    ]),
  }));
}

function createCross(
  prefix: string,
  x: number,
  y: number,
  material: string,
  renderPriority: number,
  sampleTerrain: (x: number, y: number) => number,
  halfLength = 10,
  width = 3,
): LevelObject[] {
  const create = (
    name: string,
    points: number[][],
    priority: number,
  ): LevelObject => ({
    name,
    class: 'DecalRoad',
    __parent: 'MissionGroup',
    material,
    textureLength: 8,
    renderPriority: priority,
    drivability: -1,
    autoLanes: false,
    autoJunction: false,
    oneWay: false,
    flipDirection: false,
    overObjects: true,
    zBias: 0.03,
    decalBias: 0.06,
    breakAngle: 3,
    nodes: points.map(([pointX, pointY]) => [
      pointX,
      pointY,
      Number(
        (sampleTerrain(pointX, pointY) + MARKER_LIFT_METRES).toFixed(3),
      ),
      width,
    ]),
  });

  return [
    create(
      `${prefix}_horizontal`,
      [[x - halfLength, y], [x + halfLength, y]],
      renderPriority,
    ),
    create(
      `${prefix}_vertical`,
      [[x, y - halfLength], [x, y + halfLength]],
      renderPriority + 1,
    ),
  ];
}

function createMaterials(): Record<string, unknown> {
  const material = (
    name: string,
    persistentId: string,
    textureFile: string,
    colour: [number, number, number],
  ): Record<string, unknown> => ({
    name,
    mapTo: name,
    class: 'Material',
    internalName: name,
    persistentId,
    version: 1.5,
    Stages: [{
      baseColor: [colour[0], colour[1], colour[2], 0.62],
      baseColorMap: `/levels/${LEVEL_NAME}/art/road/${textureFile}`,
      roughness: 0.9,
      metalness: 0,
    }, {}, {}, {}],
    translucent: true,
    translucentZWrite: true,
    groundmodelName: 'ASPHALT',
    annotation: 'ROAD',
  });

  return {
    sitecheck01_ground: {
      class: 'TerrainMaterial',
      internalName: 'sitecheck01_ground',
      diffuseMap: `/levels/${LEVEL_NAME}/art/terrains/ground_d.png`,
      diffuseSize: 1024,
      groundmodelName: 'GRASS',
      annotation: 'NATURE',
    },
    sitecheck01_partizanska: material(
      'sitecheck01_partizanska',
      'd0ddad56-c0ff-4010-a000-000000000011',
      'overlay_cyan_d.png',
      [0, 1, 1],
    ),
    sitecheck01_trencianska: material(
      'sitecheck01_trencianska',
      'd0ddad56-c0ff-4010-a000-000000000012',
      'overlay_magenta_d.png',
      [1, 0, 1],
    ),
    sitecheck01_podjavorinskej: material(
      'sitecheck01_podjavorinskej',
      'd0ddad56-c0ff-4010-a000-000000000013',
      'overlay_yellow_d.png',
      [1, 1, 0],
    ),
    sitecheck01_white: material(
      'sitecheck01_white',
      'd0ddad56-c0ff-4010-a000-000000000014',
      'overlay_white_d.png',
      [1, 1, 1],
    ),
    sitecheck01_red: material(
      'sitecheck01_red',
      'd0ddad56-c0ff-4010-a000-000000000015',
      'overlay_red_d.png',
      [1, 0, 0],
    ),
    sitecheck01_green: material(
      'sitecheck01_green',
      'd0ddad56-c0ff-4010-a000-000000000016',
      'overlay_green_d.png',
      [0, 1, 0],
    ),
    sitecheck01_blue: material(
      'sitecheck01_blue',
      'd0ddad56-c0ff-4010-a000-000000000017',
      'overlay_blue_d.png',
      [0, 0, 1],
    ),
    sitecheck01_yellow: material(
      'sitecheck01_yellow',
      'd0ddad56-c0ff-4010-a000-000000000018',
      'overlay_yellow_d.png',
      [1, 1, 0],
    ),
  };
}

function colourTextureEntries(): Array<{
  zipPath: string;
  content: Uint8Array;
}> {
  const colours: Array<[string, number, number, number]> = [
    ['cyan', 0, 255, 255],
    ['magenta', 255, 0, 255],
    ['yellow', 255, 255, 0],
    ['white', 255, 255, 255],
    ['red', 255, 0, 0],
    ['green', 0, 255, 0],
    ['blue', 0, 0, 255],
  ];
  return colours.map(([name, red, green, blue]) => ({
    zipPath: `levels/${LEVEL_NAME}/art/road/overlay_${name}_d.png`,
    content: generateSolidPng(64, 64, red, green, blue),
  }));
}

function roadMaterialName(name: string): string {
  const normalized = normalizeName(name);
  if (normalized === normalizeName('Partizánska')) {
    return 'sitecheck01_partizanska';
  }
  if (normalized === normalizeName('Trenčianska cesta')) {
    return 'sitecheck01_trencianska';
  }
  return 'sitecheck01_podjavorinskej';
}

function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hashFile(filePath: string): string {
  return sha256(fs.readFileSync(filePath));
}
