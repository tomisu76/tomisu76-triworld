import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { describe, expect, test } from 'vitest';
import { buildCustomRouteTerrain } from './custom-route-terrain';
import { GeodeticTransformer } from './geodetic-transformer';
import { generateLevelPackageFiles } from './level-generator';
import { parseRouteDefinition, type RouteDefinition } from './route-input';
import { buildBeamNgZipPackage } from './zip-builder';

const CENTER = { longitude: 18.3582575, latitude: 48.7245523, altitude: 250 };

function makeCompactRoute(): RouteDefinition {
  const transformer = new GeodeticTransformer(CENTER, 256);
  const localControls = [
    { x: 70, y: 115, z: 0 },
    { x: 82, y: 176, z: 0 },
    { x: 138, y: 188, z: 0 },
    { x: 185, y: 154, z: 0 },
    { x: 184, y: 94, z: 0 },
    { x: 132, y: 67, z: 0 },
    { x: 82, y: 78, z: 0 },
  ];
  return {
    name: 'compact_test_route',
    closed: true,
    points: localControls.map((point) => transformer.localToWgs84(point)),
    roadWidth: 6.8,
    shoulderWidth: 1.2,
    maximumGrade: 0.10,
    maximumBank: 0.04,
    designSpeedKmh: 45,
    stationSpacing: 3,
    minimumBlendWidth: 8,
    maximumBlendWidth: 16,
  };
}

describe('TRIWORLD V4 — GATE 4 CUSTOM ROUTE INPUT', () => {
  test('1. native JSON and GeoJSON parse into the same validated closed route contract', () => {
    const native = parseRouteDefinition(JSON.stringify({
      name: 'My Test Route',
      closed: true,
      points: [
        { longitude: 18.35, latitude: 48.72 },
        { longitude: 18.36, latitude: 48.72 },
        { longitude: 18.36, latitude: 48.73 },
        { longitude: 18.35, latitude: 48.73 },
      ],
    }));
    const geoJson = parseRouteDefinition(JSON.stringify({
      type: 'Feature',
      properties: { name: 'My Test Route' },
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [18.35, 48.72],
          [18.36, 48.72],
          [18.36, 48.73],
          [18.35, 48.73],
          [18.35, 48.72],
        ]],
      },
    }));

    expect(native.name).toBe('my_test_route');
    expect(geoJson.name).toBe('my_test_route');
    expect(native.closed).toBe(true);
    expect(geoJson.closed).toBe(true);
    expect(native.points.length).toBe(4);
    expect(geoJson.points.length).toBe(4);
  });

  test('2. arbitrary WGS84 control points produce engineered road, collision terrain and AI metadata', () => {
    const route = makeCompactRoute();
    const result = buildCustomRouteTerrain(route, {
      size: 256,
      squareSize: 1,
      maxHeight: 500,
      centerWgs84: CENTER,
    });
    const road = result.road as unknown as Record<string, unknown>;

    expect(result.routeDefinition.name).toBe('compact_test_route');
    expect(result.controlPointsLocal.length).toBe(7);
    expect(result.road.name).toBe('triworld_route_compact_test_route');
    expect(result.road.drivability).toBe(1);
    expect(road.improvedSpline).toBe(true);
    expect(road.lanesLeft).toBe(1);
    expect(road.lanesRight).toBe(1);
    expect(result.road.nodes.length).toBeGreaterThan(20);
    expect(result.road.nodes[0]).toEqual(result.road.nodes[result.road.nodes.length - 1]);
    expect(result.stats.roadLengthMetres).toBeGreaterThan(300);
    expect(result.stats.maximumGrade).toBeLessThanOrEqual(0.100001);
    expect(result.stats.maximumBank).toBeLessThanOrEqual(0.04001);
    expect(result.stats.modifiedTerrainSamples).toBeGreaterThan(5_000);
    expect(result.stats.maximumCutMetres).toBeGreaterThan(0);
    expect(result.stats.maximumFillMetres).toBeGreaterThan(0);

    for (let index = 0; index < result.roadStations.length - 1; index += 17) {
      const station = result.roadStations[index];
      expect(Math.abs(result.sampleElevation(station.x, station.y) - station.z)).toBeLessThan(0.4);
    }
  });

  test('3. custom route packages into a directly loadable BeamNG ZIP', async () => {
    const result = buildCustomRouteTerrain(makeCompactRoute(), {
      size: 256,
      squareSize: 1,
      maxHeight: 500,
      centerWgs84: CENTER,
    });
    const files = generateLevelPackageFiles(result.artifact, {
      title: 'TriWorld Custom Route Test',
      extraObjects: [result.road as unknown as Record<string, unknown>],
    });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'triworld-custom-route-'));
    const zipPath = path.join(directory, 'custom-route.zip');
    const manifestPath = path.join(directory, 'custom-route.manifest.json');
    await buildBeamNgZipPackage(result.artifact, files, zipPath, manifestPath);

    const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
    expect(zip.file('levels/triworld_v4/art/terrains/terrain.ter')).not.toBeNull();
    expect(zip.file('levels/triworld_v4/main/items.level.json')).not.toBeNull();
    const items = await zip.file('levels/triworld_v4/main/items.level.json')!.async('string');
    expect(items).toContain('triworld_route_compact_test_route');
    expect(items).toContain('"drivability":1');
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test('4. route validation rejects open, underspecified and edge-clipped inputs', () => {
    expect(() => parseRouteDefinition(JSON.stringify({
      closed: false,
      points: [[18.35, 48.72], [18.36, 48.72], [18.36, 48.73], [18.35, 48.73]],
    }))).toThrow(/closed route/);
    expect(() => parseRouteDefinition(JSON.stringify({
      closed: true,
      points: [[18.35, 48.72], [18.36, 48.72], [18.36, 48.73]],
    }))).toThrow(/four unique points/);

    const edgeRoute = makeCompactRoute();
    edgeRoute.points[0] = { longitude: 18.30, latitude: 48.72, altitude: 0 };
    expect(() => buildCustomRouteTerrain(edgeRoute, {
      size: 256,
      squareSize: 1,
      maxHeight: 500,
      centerWgs84: CENTER,
    })).toThrow(/terrain edge/);
  });
});
