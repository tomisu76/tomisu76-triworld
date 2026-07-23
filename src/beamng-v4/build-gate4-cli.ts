import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { buildBanovceRealWorldTerrainAsync } from './gis-terrain';
import { generateLevelPackageFiles } from './level-generator';
import { fetchPrimaryOsmRoadAlignment } from './osm-road-source';
import { fetchRealBanovceOrthophoto } from './ortho-generator';
import { applyCoupledRoadTerrainCorridor } from './road-terrain-corridor';
function scanDecodedRange(
  values: Uint16Array,
  heightScale: number,
): { minimum: number; maximum: number } {
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const decoded = value * heightScale;
    minimum = Math.min(minimum, decoded);
    maximum = Math.max(maximum, decoded);
  }
  return { minimum, maximum };
}
import { generateDiagnosticMarkers } from './diagnostic-markers';
import {
  generateRoadSurfaceMesh,
  exportRoadMeshToDae,
  generateAsphaltTexturePng,
} from './road-mesh-exporter';
import { buildBeamNgZipPackage } from './zip-builder';

const SIZE = 1024;
const SQUARE_SIZE = 1.0;
const MAX_HEIGHT = 500.0;
const LEVEL_NAME = 'triworld_v4_gate4_roadmesh1';

function sha256(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

function hashFile(filePath: string): string {
  return sha256(fs.readFileSync(filePath));
}

function createStrictTerrainSampler(
  elevations: Float32Array,
  size: number,
  squareSize: number,
): (xMetres: number, yMetres: number) => number {
  return (xMetres: number, yMetres: number): number => {
    const column = xMetres / squareSize;
    const row = (size - 1) - yMetres / squareSize;
    if (
      !Number.isFinite(column) || !Number.isFinite(row) ||
      column < 0 || column > size - 1 || row < 0 || row > size - 1
    ) {
      throw new RangeError(`Terrain sample outside grid: (${xMetres}, ${yMetres}).`);
    }

    const c0 = Math.min(size - 2, Math.floor(column));
    const r0 = Math.min(size - 2, Math.floor(row));
    const c1 = c0 + 1;
    const r1 = r0 + 1;
    const tx = column - c0;
    const ty = row - r0;
    const z00 = elevations[r0 * size + c0];
    const z10 = elevations[r0 * size + c1];
    const z01 = elevations[r1 * size + c0];
    const z11 = elevations[r1 * size + c1];
    const z0 = z00 + (z10 - z00) * tx;
    const z1 = z01 + (z11 - z01) * tx;
    return z0 + (z1 - z0) * ty;
  };
}

async function main(): Promise<void> {
  console.log('Building TriWorld V4 Gate 4 Level: Road Surface Mesh V3 + Asphalt Material...');

  const sourceTerrain = await buildBanovceRealWorldTerrainAsync({
    size: SIZE,
    squareSize: SQUARE_SIZE,
    maxHeight: MAX_HEIGHT,
    withRoadCorridor: false,
    levelName: LEVEL_NAME,
  });

  if (!sourceTerrain.isRealDem) {
    throw new Error('Gate 4 rejected: DEM download failed and analytic fallback was used.');
  }

  const road = await fetchPrimaryOsmRoadAlignment(sourceTerrain.transformer, {
    minimumLengthMetres: 80,
    minimumInsetMetres: 12,
  });

  console.log(
    `OSM road selected: way ${road.wayId}, fragment ${road.fragmentIndex}, ` +
    `${road.name ?? road.highway}, ${road.pointCount} points, ${road.lengthMetres.toFixed(1)}m`,
  );

  const corridor = applyCoupledRoadTerrainCorridor(
    sourceTerrain.rawElevations,
    SIZE,
    SQUARE_SIZE,
    MAX_HEIGHT,
    {
      roadShapeCentered: road.pointsCentered,
      roadSourceId: `osm-way-${road.wayId}-fragment-${road.fragmentIndex}`,
      laneWidth: road.laneWidthMetres,
    },
  );

  const heightScale = MAX_HEIGHT / 65535.0;
  const decodedRange = scanDecodedRange(corridor.heightMapU16, heightScale);
  const artifact = {
    ...sourceTerrain.artifact,
    heightMapU16: corridor.heightMapU16,
    minimumDecodedElevation: decodedRange.minimum,
    maximumDecodedElevation: decodedRange.maximum,
    materialNames: [`${LEVEL_NAME}_ground`],
  };

  const sampleTerrainElevation = createStrictTerrainSampler(
    corridor.workingElevations,
    SIZE,
    SQUARE_SIZE,
  );

  const markers = generateDiagnosticMarkers(sourceTerrain.transformer, sampleTerrainElevation);

  // Generate Road Surface Mesh V3
  const roadMesh = generateRoadSurfaceMesh(road, sampleTerrainElevation);
  const roadDae = exportRoadMeshToDae(roadMesh, 'triworld_asphalt');
  const asphaltPng = generateAsphaltTexturePng(256);

  console.log(`Road Mesh V3 generated: ${roadMesh.vertexCount} vertices, ${roadMesh.triangleCount} triangles, ${roadMesh.segmentCount} segments.`);
  console.log(`Terrain Clearance Stats: min=${roadMesh.clearanceStats.minMetres}m, max=${roadMesh.clearanceStats.maxMetres}m, mean=${roadMesh.clearanceStats.meanMetres}m, negativeCount=${roadMesh.clearanceStats.negativeCount}.`);

  if (roadMesh.clearanceStats.negativeCount > 0) {
    throw new Error(`Gate 4 rejected: ${roadMesh.clearanceStats.negativeCount} negative-clearance vertices detected.`);
  }

  const { diffusePng, isRealSatellite } = await fetchRealBanovceOrthophoto({
    transformer: sourceTerrain.transformer,
    textureSize: SIZE,
  });

  if (!isRealSatellite) {
    throw new Error('Gate 4 rejected: Satellite orthophoto download failed.');
  }

  const levelFiles = generateLevelPackageFiles(artifact, {
    levelName: LEVEL_NAME,
    title: 'TriWorld V4 Native Gate 4 — Road Surface Mesh V3',
    description: 'Native BeamNG level with real DEM terrain, 180-deg rotated satellite orthophoto, and 3D asphalt road mesh object.',
    extraMarkers: markers,
    diffusePng,
    normalPng: undefined,
    roadDae,
    asphaltPng,
    asphaltMaterialName: 'triworld_asphalt',
  });

  const distDir = path.resolve('dist');
  fs.mkdirSync(distDir, { recursive: true });
  const zipPath = path.join(distDir, `${LEVEL_NAME}.zip`);
  const manifestPath = path.join(distDir, `${LEVEL_NAME}.manifest.json`);

  const manifest = await buildBeamNgZipPackage(
    artifact,
    levelFiles,
    zipPath,
    manifestPath,
    LEVEL_NAME,
  );

  const zipHash = hashFile(zipPath);

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

  const installedZipHash = hashFile(installedZipPath);

  if (zipHash !== installedZipHash) {
    throw new Error('Gate 4 rejected: Source ZIP and installed ZIP SHA-256 mismatch.');
  }

  const reportJsonPath = path.join(distDir, `${LEVEL_NAME}_report.json`);
  const buildReport = {
    levelName: LEVEL_NAME,
    roadWayId: road.wayId,
    roadLengthMetres: road.lengthMetres,
    roadWidthMetres: road.laneWidthMetres,
    roadMeshStats: {
      vertexCount: roadMesh.vertexCount,
      triangleCount: roadMesh.triangleCount,
      segmentCount: roadMesh.segmentCount,
      clearanceStats: roadMesh.clearanceStats,
    },
    zipPath,
    zipHash,
    installedZipPath,
    installedZipHash,
    collisionConfig: {
      class: 'TSStatic',
      shapeName: `/levels/${LEVEL_NAME}/art/road/road_surface.dae`,
      collisionType: 'Visible Mesh',
      decalType: 'Collision Mesh',
    },
    asphaltMaterial: {
      internalName: 'triworld_asphalt',
      groundmodelName: 'ASPHALT',
      colorMap: `/levels/${LEVEL_NAME}/art/road/asphalt_d.png`,
    },
    acceptance: {
      negativeClearanceCountZero: roadMesh.clearanceStats.negativeCount === 0,
      minClearancePositive: roadMesh.clearanceStats.minMetres >= 0.05,
      zipHashesMatch: zipHash === installedZipHash,
      realDemUsed: true,
      realOsmRoadUsed: true,
    },
  };

  fs.writeFileSync(reportJsonPath, JSON.stringify(buildReport, null, 2));

  console.log(`GATE 4 ACCEPTED`);
  console.log(`Level: ${LEVEL_NAME}`);
  console.log(`Road Mesh: ${roadMesh.vertexCount} vertices, ${roadMesh.triangleCount} triangles, ${roadMesh.lengthMetres.toFixed(1)}m length`);
  console.log(`Clearance: min=${roadMesh.clearanceStats.minMetres}m, max=${roadMesh.clearanceStats.maxMetres}m, negativeCount=${roadMesh.clearanceStats.negativeCount}`);
  console.log(`ZIP: ${zipPath}`);
  console.log(`Installed Mod: ${installedZipPath}`);
  console.log(`ZIP SHA-256: ${zipHash}`);
}

main().catch((err) => {
  console.error('FATAL GATE 4 ERROR:', err);
  process.exit(1);
});
