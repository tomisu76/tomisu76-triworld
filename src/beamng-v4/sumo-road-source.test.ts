import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BANOVCE_ORIGIN_WGS84, GeodeticTransformer } from './geodetic-transformer';
import {
  parseAuthoritativeSumoRoadNetwork,
  resolveAuthoritativeSumoRoadAlignment,
} from './sumo-road-source';

function buildFixtureXml(transformer: GeodeticTransformer, osmWayId: number = 42): string {
  const netOffset = `${-transformer.minUtm.easting},${-transformer.minUtm.northing}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<net>
  <location netOffset="${netOffset}" convBoundary="0,0,100,100" origBoundary="0,0,1,1" projParameter="+proj=utm +zone=34 +ellps=WGS84 +datum=WGS84 +units=m +no_defs"/>
  <edge id="${osmWayId}#0" from="A" to="B" shape="10,50 50,50">
    <lane id="${osmWayId}#0_0" index="0" width="3.2" shape="10,48.4 50,48.4"/>
  </edge>
  <edge id="${osmWayId}#1" from="B" to="C" shape="50,50 90,50">
    <lane id="${osmWayId}#1_0" index="0" width="3.2" shape="50,48.4 90,48.4"/>
  </edge>
  <edge id="-${osmWayId}#1" from="C" to="B" shape="90,50 50,50">
    <lane id="-${osmWayId}#1_0" index="0" width="3.2" shape="90,51.6 50,51.6"/>
  </edge>
  <edge id="-${osmWayId}#0" from="B" to="A" shape="50,50 10,50">
    <lane id="-${osmWayId}#0_0" index="0" width="3.2" shape="50,51.6 10,51.6"/>
  </edge>
</net>`;
}

describe('Gate 4 authoritative SUMO road source', () => {
  it('orders both directions, restores UTM coordinates, and clips one canonical centerline', () => {
    const transformer = new GeodeticTransformer(BANOVCE_ORIGIN_WGS84, 100);
    const xml = buildFixtureXml(transformer);
    const parsed = parseAuthoritativeSumoRoadNetwork(xml, 42);
    const alignment = resolveAuthoritativeSumoRoadAlignment(xml, transformer, 42, 6, 5, 20);

    expect(parsed.edges).toHaveLength(4);
    expect(alignment.usedEdgeIds).toEqual(['42#0', '42#1']);
    expect(alignment.usedLaneIds).toEqual(['42#0_0', '42#1_0']);
    expect(alignment.allEdgeIds).toEqual(['-42#0', '-42#1', '42#0', '42#1']);
    expect(alignment.pointsCentered).toEqual([
      { x: -40, y: 0 },
      { x: 0, y: 0 },
      { x: 40, y: 0 },
    ]);
    expect(alignment.lengthMetres).toBeCloseTo(80, 6);
    expect(alignment.minimumDistanceToCentreMetres).toBeCloseTo(0, 6);
    expect(alignment.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects directional edges that are not topological reverses', () => {
    const transformer = new GeodeticTransformer(BANOVCE_ORIGIN_WGS84, 100);
    const malformed = buildFixtureXml(transformer).replace(
      '<edge id="-42#1" from="C" to="B"',
      '<edge id="-42#1" from="D" to="B"',
    );

    expect(() => resolveAuthoritativeSumoRoadAlignment(malformed, transformer, 42, 6, 5, 20))
      .toThrow('not topological reverses');
  });

  it('resolves the committed Bánovce network into the terrain-safe real fragment', () => {
    const xml = fs.readFileSync(
      path.resolve('artifacts/gate3-osm/banovce_authoritative.net.xml'),
      'utf-8',
    );
    const transformer = new GeodeticTransformer(BANOVCE_ORIGIN_WGS84, 1024);
    const alignment = resolveAuthoritativeSumoRoadAlignment(
      xml,
      transformer,
      109459194,
      8,
      12,
      80,
    );

    expect(alignment.usedEdgeIds).toEqual(['109459194#0', '109459194#1']);
    expect(alignment.allEdgeIds).toEqual([
      '-109459194#0',
      '-109459194#1',
      '109459194#0',
      '109459194#1',
    ]);
    expect(alignment.lengthMetres).toBeGreaterThan(800);
    expect(alignment.lengthMetres).toBeLessThan(900);
    expect(alignment.pointCount).toBeGreaterThanOrEqual(20);
    expect(alignment.boundsCentered.minX).toBeGreaterThanOrEqual(-500.001);
    expect(alignment.boundsCentered.minY).toBeGreaterThanOrEqual(-500.001);
    expect(alignment.boundsCentered.maxX).toBeLessThanOrEqual(500.001);
    expect(alignment.boundsCentered.maxY).toBeLessThanOrEqual(500.001);
  });
});
