/**
 * TriWorld V4 Gate 3 strict production builder.
 * Real DEM -> deterministic real OSM road -> Pipeline V3 corridor -> native BeamNG ZIP.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildBanovceRealWorldTerrainAsync } from './gis-terrain';
import { fetchRealBanovceOrthophoto } from './ortho-generator';
import { generateDiagnosticMarkers } from './diagnostic-markers';
import { generateLevelPackageFiles } from './level-generator';
import { fetchPrimaryOsmRoadAlignment } from './osm-road-source';
import { applyCoupledRoadTerrainCorridor } from './road-terrain-corridor';
import { generateCheckerboardRgbaPng } from './texture-generator';
import { buildBeamNgZipPackage } from './zip-builder';

const SIZE = 1024;
const SQUARE_SIZE = 1.0;
const MAX_HEIGHT = 500.0;
const LEVEL_NAME = 'triworld_v4_gate3_osm_texturetest_a';
const HEIGHT_COMPARISON_EPSILON_METRES = 0.01;
const MINIMUM_MEANINGFUL_CUT_OR_FILL_METRES = 0.05;

async function main(): Promise<void> {
  console.log('Building TriWorld V4 Gate 3 Diagnostic TEST A: RGBA Checkerboard PNG...');

  const sourceTerrain = await buildBanovceRealWorldTerrainAsync({
    size: SIZE,
    squareSize: SQUARE_SIZE,
    maxHeight: MAX_HEIGHT,
    withRoadCorridor: false,
    levelName: LEVEL_NAME,
  });

  if (!sourceTerrain.isRealDem) {
    throw new Error('Gate 3 rejected: DEM download failed and analytic fallback was used.');
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

  const sampleElevation = createStrictTerrainSampler(
    corridor.workingElevations,
    SIZE,
    SQUARE_SIZE,
  );
  const markers = generateDiagnosticMarkers(sourceTerrain.transformer, sampleElevation);
  const centerElevation = sampleElevation(SIZE / 2, SIZE / 2);

  const diffusePng = generateCheckerboardRgbaPng(1024, 1024);

  const levelFiles = generateLevelPackageFiles(artifact, {
    levelName: LEVEL_NAME,
    title: 'TriWorld V4 Native Gate 3 — Texture Test A',
    description: 'Diagnostic build for testing 8-bit RGBA checkerboard PNG texture mapping in BeamNG.',
    extraMarkers: markers,
    diffusePng,
    normalPng: undefined,
  });

  const distDir = path.resolve('dist');
  const artifactsDir = path.resolve('artifacts', 'gate3-osm');
  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(artifactsDir, { recursive: true });

  const zipPath = path.join(distDir, `${LEVEL_NAME}.zip`);
  const manifestPath = path.join(distDir, `${LEVEL_NAME}.manifest.json`);
  const reportJsonPath = path.join(artifactsDir, 'gate3-build-report.json');
  const reportTextPath = path.join(artifactsDir, 'gate3-build-report.txt');

  const manifest = await buildBeamNgZipPackage(
    artifact,
    levelFiles,
    zipPath,
    manifestPath,
    LEVEL_NAME,
  );

  const originalTerrainHash = hashFloat64Array(sourceTerrain.rawElevations);
  const modifiedTerrainHash = hashFloat64Array(corridor.workingElevations);
  const zipHash = hashFile(zipPath);
  const safeInset = Math.max(12, road.laneWidthMetres / 2 + 2);
  const safeHalfExtent = SIZE / 2 - safeInset;
  const roadSamplesOutsideTerrain = road.pointsCentered.filter(
    (point) => Math.abs(point.x) > safeHalfExtent + 1e-6 || Math.abs(point.y) > safeHalfExtent + 1e-6,
  ).length;

  const terrainCellsUnchanged =
    corridor.stats.terrainCellsTotal - corridor.stats.terrainCellsModified;
  const acceptance = {
    realDemUsed: sourceTerrain.isRealDem,
    realRoadAlignmentUsed: road.sourceType === 'osm-api-v0.6',
    noSyntheticProductionFallbackUsed: true,
    realOrthophotoUsed: true,
    roadPointCount: road.pointCount >= 2,
    roadSamplesProcessed: corridor.stats.roadStationCount > 0,
    roadSamplesOutsideTerrain: roadSamplesOutsideTerrain === 0,
    terrainCellsModified: corridor.stats.terrainCellsModified >= 100,
    terrainHashChanged: originalTerrainHash !== modifiedTerrainHash,
    cutOrFillRequired:
      corridor.stats.maximumCutMetres >= MINIMUM_MEANINGFUL_CUT_OR_FILL_METRES ||
      corridor.stats.maximumFillMetres >= MINIMUM_MEANINGFUL_CUT_OR_FILL_METRES,
    terrainFormatVersion: artifact.version === 9,
    zipCreated: fs.existsSync(zipPath) && fs.statSync(zipPath).size > 0,
  };

  const accepted = Object.values(acceptance).every(Boolean);
  const buildReport = {
    accepted,
    generatedAt: new Date().toISOString(),
    gitBranch: 'codex/beamng-v4-gate3-recovery',
    targetBeamNgVersion: '0.36.4.0',
    terrainFormatVersion: artifact.version,
    levelName: LEVEL_NAME,
    roadSourceType: road.sourceType,
    roadSourceUrl: road.sourceUrl,
    roadSourcePathOrIdentifier: `osm-way-${road.wayId}-fragment-${road.fragmentIndex}`,
    roadWayId: road.wayId,
    roadFragmentIndex: road.fragmentIndex,
    roadName: road.name ?? null,
    roadHighway: road.highway,
    roadGeometryHash: road.sha256,
    roadPointCount: road.pointCount,
    roadStationCount: corridor.stats.roadStationCount,
    roadTotalLengthMetres: corridor.stats.roadLengthMetres,
    roadSamplesProcessed: corridor.stats.roadStationCount,
    roadSamplesOutsideTerrain,
    roadBoundsCentered: road.boundsCentered,
    roadLaneWidthMetres: road.laneWidthMetres,
    terrainCellsTotal: corridor.stats.terrainCellsTotal,
    terrainCellsModified: corridor.stats.terrainCellsModified,
    terrainCellsUnchanged,
    terrainCellsLowered: corridor.stats.terrainCellsLowered,
    terrainCellsRaised: corridor.stats.terrainCellsRaised,
    maximumCutMetres: corridor.stats.maximumCutMetres,
    maximumFillMetres: corridor.stats.maximumFillMetres,
    meanAbsoluteModificationMetresModifiedCells:
      corridor.stats.meanAbsoluteModificationMetres,
    heightComparisonEpsilonMetres: HEIGHT_COMPARISON_EPSILON_METRES,
    originalTerrainHash,
    modifiedTerrainHash,
    terrainHashEncoding: 'Float64 little-endian, row-major, north-to-south rows',
    scannedMinimumElevation: decodedRange.minimum,
    scannedMaximumElevation: decodedRange.maximum,
    centerSpawnSurfaceElevation: centerElevation,
    orthophotoBytes: diffusePng.length,
    diagnosticMarkersCount: markers.length,
    zipPath,
    zipSize: fs.statSync(zipPath).size,
    zipHash,
    manifestPath,
    manifest,
    acceptance,
  };

  writeReportsAtomically(reportJsonPath, reportTextPath, buildReport);

  if (!accepted) {
    const failed = Object.entries(acceptance)
      .filter(([, passed]) => !passed)
      .map(([name]) => name)
      .join(', ');
    throw new Error(`Gate 3 acceptance failed: ${failed}. See ${reportJsonPath}.`);
  }

  const targetModsPath =
    process.env.TRIWORLD_BEAMNG_MOD_PATH ??
    `C:\\Users\\tomisu\\AppData\\Local\\BeamNG\\BeamNG.drive\\current\\mods\\${LEVEL_NAME}.zip`;
  fs.mkdirSync(path.dirname(targetModsPath), { recursive: true });
  fs.copyFileSync(zipPath, targetModsPath);

  const installedHash = hashFile(targetModsPath);
  if (installedHash !== zipHash) {
    throw new Error(`Installed ZIP hash mismatch: source=${zipHash}, installed=${installedHash}`);
  }

  const completedReport = {
    ...buildReport,
    installedZipPath: targetModsPath,
    installedZipHash: installedHash,
  };
  writeReportsAtomically(reportJsonPath, reportTextPath, completedReport);

  fs.writeFileSync(
    manifestPath,
    JSON.stringify({ ...manifest, gate3Report: completedReport }, null, 2),
    'utf8',
  );

  console.log('GATE 3 ACCEPTED');
  console.log(`OSM way: ${road.wayId} (${road.name ?? road.highway})`);
  console.log(`Road length: ${corridor.stats.roadLengthMetres.toFixed(1)}m`);
  console.log(`Modified terrain cells: ${corridor.stats.terrainCellsModified}`);
  console.log(
    `Maximum cut/fill: ${corridor.stats.maximumCutMetres.toFixed(3)}m / ` +
    `${corridor.stats.maximumFillMetres.toFixed(3)}m`,
  );
  console.log(`ZIP: ${zipPath}`);
  console.log(`Installed: ${targetModsPath}`);
  console.log(`Report: ${reportJsonPath}`);
}

function hashFloat64Array(values: Float32Array): string {
  const float64 = new Float64Array(values);
  return crypto.createHash('sha256').update(Buffer.from(float64.buffer)).digest('hex');
}

function hashFile(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

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

function writeReportsAtomically(
  jsonPath: string,
  textPath: string,
  report: Record<string, unknown>,
): void {
  const acceptance = report.acceptance as Record<string, boolean>;
  const text = [
    `TriWorld V4 Gate 3 OSM: ${report.accepted ? 'ACCEPTED' : 'REJECTED'}`,
    `Generated: ${report.generatedAt}`,
    `Road: ${report.roadSourcePathOrIdentifier} (${report.roadName ?? report.roadHighway})`,
    `Road points/stations: ${report.roadPointCount} / ${report.roadStationCount}`,
    `Road length: ${Number(report.roadTotalLengthMetres).toFixed(1)} m`,
    `Modified cells: ${report.terrainCellsModified}`,
    `Maximum cut: ${Number(report.maximumCutMetres).toFixed(3)} m`,
    `Maximum fill: ${Number(report.maximumFillMetres).toFixed(3)} m`,
    `Original terrain hash: ${report.originalTerrainHash}`,
    `Modified terrain hash: ${report.modifiedTerrainHash}`,
    `ZIP: ${report.zipPath}`,
    `ZIP SHA-256: ${report.zipHash}`,
    '',
    'Acceptance:',
    ...Object.entries(acceptance).map(([name, passed]) => `- ${name}: ${passed ? 'PASS' : 'FAIL'}`),
    '',
  ].join('\n');

  atomicWrite(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  atomicWrite(textPath, text);
}

function atomicWrite(filePath: string, content: string): void {
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, content, 'utf8');
  if (fs.existsSync(filePath)) fs.rmSync(filePath);
  fs.renameSync(temporaryPath, filePath);
}

main().catch((error) => {
  console.error('Gate 3 CLI Build Failed:', error);
  process.exit(1);
});
