import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { GeodeticTransformer } from './geodetic-transformer';
import { resolveSitecheckNamedRoadOverlays } from './sitecheck-sumo-overlay';
import { buildSitecheckPackage } from './sitecheck-level-package';
import { buildSitecheckTerrain, SITECHECK_SIZE } from './sitecheck-terrain';

type SiteConfig = {
  centerWgs84: { longitude: number; latitude: number; altitude: number };
  centerUtm34N: {
    easting: number;
    northing: number;
    elevation: number;
    zone: number;
  };
  crs: { horizontal: string; geographic: string };
  sizeMetres: number;
  textureSizePixels: number;
  orthophotoTransform: string;
  expectedRoadNames: string[];
  sourcePaths: {
    osm: string;
    sumoNet: string;
    orthophoto: string;
    demTileDirectory: string;
  };
};

const EXPECTED = {
  latitude: 48.710782486104385,
  longitude: 18.25561213182195,
  osmHash: '28d0a874c34c322da378f8599adf66697fec352b4901d0494ffeb1bec0936a84',
  sumoHash: '52a86316e6c336df7e115c664cd420c8b93c341eda0bd3e09d3b65a90424a3a9',
  orthophotoHash: '6d24d68ca15407d9abbc43c8da80bfa3fbe1bf2a0c234c9bdffe186ae00797aa',
};

async function main(): Promise<void> {
  const configPath = path.resolve('config/banovce-accident-site.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as SiteConfig;
  validateConfig(config);

  const osmPath = path.resolve(config.sourcePaths.osm);
  const sumoPath = path.resolve(config.sourcePaths.sumoNet);
  const orthophotoPath = path.resolve(config.sourcePaths.orthophoto);
  const demRoot = path.resolve(config.sourcePaths.demTileDirectory);

  verifyHash(osmPath, EXPECTED.osmHash, 'OSM');
  verifyHash(sumoPath, EXPECTED.sumoHash, 'SUMO');
  verifyHash(orthophotoPath, EXPECTED.orthophotoHash, 'orthophoto');

  console.log('Building SITECHECK01 from authoritative principal SUMO centerlines...');
  console.log(`Centre: ${config.centerWgs84.latitude}, ${config.centerWgs84.longitude}`);
  console.log('Orthophoto transform: NONE');

  const transformer = new GeodeticTransformer(config.centerWgs84, SITECHECK_SIZE);
  const overlayResolution = resolveSitecheckNamedRoadOverlays(
    fs.readFileSync(osmPath, 'utf8'),
    fs.readFileSync(sumoPath, 'utf8'),
    transformer,
    config.expectedRoadNames,
    {
      localSampleOffsetMetres: 0.5,
      clippingMinimum: 0,
      clippingMaximum: SITECHECK_SIZE - 1,
      maximumPrincipalComponentsPerRoad: 2,
      parallelComponentToleranceMetres: 15,
      minimumOverlayLengthMetres: 2,
    },
  );

  for (const audit of overlayResolution.audits) {
    const overlays = overlayResolution.roads.filter(
      (road) => normalizeName(road.name) === normalizeName(audit.name),
    );
    const pointCount = overlays.reduce(
      (sum, road) => sum + road.localPoints.length,
      0,
    );
    console.log(
      `SUMO principal geometry: ${audit.name}: ` +
      `${audit.rawDirectedEdgeCount} directed -> ` +
      `${audit.canonicalEdgeCount} canonical -> ` +
      `${audit.selectedOverlayCount} overlay(s), ${pointCount} point(s).`,
    );
  }

  const terrain = buildSitecheckTerrain(demRoot, config.centerUtm34N);
  const result = await buildSitecheckPackage({
    centerWgs84: config.centerWgs84,
    centerUtm34N: config.centerUtm34N,
    expectedRoadNames: config.expectedRoadNames,
    sourcePaths: {
      osm: config.sourcePaths.osm,
      sumoNet: config.sourcePaths.sumoNet,
      orthophoto: config.sourcePaths.orthophoto,
    },
    sourceHashes: {
      osm: EXPECTED.osmHash,
      sumo: EXPECTED.sumoHash,
      orthophoto: EXPECTED.orthophotoHash,
    },
    orthophotoPath,
    roads: overlayResolution.roads,
    overlayResolution,
    terrain,
  });

  console.log('SITECHECK01 BUILD SUCCESSFUL');
  console.log(
    `Terrain elevation: ${terrain.minElevation.toFixed(3)}..` +
    `${terrain.maxElevation.toFixed(3)}m`,
  );
  console.log(`Principal road overlays: ${overlayResolution.roads.length}`);
  console.log(`ZIP: ${result.zipPath}`);
  console.log(`ZIP SHA-256: ${result.zipHash}`);
  console.log(
    result.installedZipPath
      ? `Installed: ${result.installedZipPath}`
      : 'Installed: skipped on non-Windows host',
  );
  console.log(`Report: ${result.reportPath}`);
}

function validateConfig(config: SiteConfig): void {
  if (
    Math.abs(config.centerWgs84.latitude - EXPECTED.latitude) > 1e-12 ||
    Math.abs(config.centerWgs84.longitude - EXPECTED.longitude) > 1e-12
  ) {
    throw new Error(
      'SITECHECK01 rejected: configuration centre does not match the accident site.',
    );
  }
  if (config.crs.horizontal !== 'EPSG:32634') {
    throw new Error(
      `SITECHECK01 rejected: expected EPSG:32634, found ` +
      `${config.crs.horizontal}.`,
    );
  }
  if (config.orthophotoTransform !== 'none') {
    throw new Error(
      `SITECHECK01 rejected: orthophoto transform must be none, found ` +
      `${config.orthophotoTransform}.`,
    );
  }
  if (config.sizeMetres !== SITECHECK_SIZE) {
    throw new Error(
      `SITECHECK01 rejected: expected ${SITECHECK_SIZE}m, found ` +
      `${config.sizeMetres}m.`,
    );
  }
}

function verifyHash(filePath: string, expected: string, label: string): void {
  const actual = createHash('sha256')
    .update(fs.readFileSync(filePath))
    .digest('hex');
  if (actual !== expected) {
    throw new Error(
      `SITECHECK01 rejected: authoritative ${label} hash mismatch; ` +
      `expected ${expected}, found ${actual}.`,
    );
  }
}

function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

main().catch((error: unknown) => {
  console.error('FATAL SITECHECK01 BUILD ERROR:', error);
  process.exit(1);
});
