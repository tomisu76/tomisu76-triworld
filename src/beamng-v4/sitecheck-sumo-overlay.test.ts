import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GeodeticTransformer } from './geodetic-transformer';
import { resolveSitecheckNamedRoadOverlays } from './sitecheck-sumo-overlay';

const SITE_CENTER = {
  longitude: 18.25561213182195,
  latitude: 48.710782486104385,
  altitude: 0,
};

describe('SITECHECK01 SUMO principal road overlays', () => {
  it('deduplicates reverse directions and discards a short named branch', () => {
    const transformer = new GeodeticTransformer(SITE_CENTER, 100);
    const netOffset = `${-transformer.minUtm.easting},${-transformer.minUtm.northing}`;

    const osm = `<?xml version="1.0"?>
<osm>
  <way id="10">
    <nd ref="1"/><nd ref="2"/>
    <tag k="highway" v="primary"/>
    <tag k="name" v="Trenčianska cesta"/>
  </way>
</osm>`;

    const net = `<?xml version="1.0"?>
<net>
  <location netOffset="${netOffset}" projParameter="+proj=utm +zone=34 +ellps=WGS84 +units=m"/>
  <edge id="10#0" from="A" to="B" type="highway.primary" shape="10,50 50,50">
    <lane id="10#0_0" shape="10,48 50,48"/>
  </edge>
  <edge id="-10#0" from="B" to="A" type="highway.primary" shape="50,50 10,50">
    <lane id="-10#0_0" shape="50,52 10,52"/>
  </edge>
  <edge id="10#1" from="B" to="C" type="highway.primary" shape="50,50 90,50">
    <lane id="10#1_0" shape="50,48 90,48"/>
  </edge>
  <edge id="-10#1" from="C" to="B" type="highway.primary" shape="90,50 50,50">
    <lane id="-10#1_0" shape="90,52 50,52"/>
  </edge>
  <edge id="10#2" from="B" to="D" type="highway.primary" shape="50,50 50,56">
    <lane id="10#2_0" shape="50,50 50,56"/>
  </edge>
  <edge id="-10#2" from="D" to="B" type="highway.primary" shape="50,56 50,50">
    <lane id="-10#2_0" shape="50,56 50,50"/>
  </edge>
</net>`;

    const result = resolveSitecheckNamedRoadOverlays(
      osm,
      net,
      transformer,
      ['Trenčianska cesta'],
      {
        clippingMaximum: 99,
        maximumPrincipalComponentsPerRoad: 1,
      },
    );

    expect(result.roads).toHaveLength(1);
    expect(result.audits[0].rawDirectedEdgeCount).toBe(6);
    expect(result.audits[0].canonicalEdgeCount).toBe(3);
    expect(result.roads[0].sourceEdgeIds).toEqual(['10#0', '10#1']);
    expect(result.roads[0].lengthMetres).toBeCloseTo(80, 4);
    expect(result.roads[0].localPoints[0].x).toBeCloseTo(9.5, 4);
    expect(result.roads[0].localPoints.at(-1)!.x).toBeCloseTo(89.5, 4);
  });

  it('resolves the committed correct-site OSM/SUMO package into bounded principal corridors', () => {
    const osm = fs.readFileSync(
      path.resolve('artifacts/sitecheck01-sources/banovce_accident_site.osm'),
      'utf-8',
    );
    const net = fs.readFileSync(
      path.resolve('artifacts/sitecheck01-sources/banovce_accident_site.net.xml'),
      'utf-8',
    );
    const transformer = new GeodeticTransformer(SITE_CENTER, 1024);

    const expectedRoads = [
      'Partizánska',
      'Trenčianska cesta',
      'Ľudmily Podjavorinskej',
    ];

    const result = resolveSitecheckNamedRoadOverlays(
      osm,
      net,
      transformer,
      expectedRoads,
    );

    expect(result.sourceType).toBe('sumo-netconvert-principal-centerlines');
    expect(result.audits).toHaveLength(3);
    expect(result.roads.length).toBeGreaterThanOrEqual(3);
    expect(result.roads.length).toBeLessThanOrEqual(6);

    for (const expectedName of expectedRoads) {
      const audit = result.audits.find((candidate) => candidate.name === expectedName);
      const overlays = result.roads.filter((road) => road.name === expectedName);

      expect(audit).toBeDefined();
      expect(audit!.rawDirectedEdgeCount).toBeGreaterThanOrEqual(
        audit!.canonicalEdgeCount,
      );
      expect(audit!.selectedComponentCount).toBeGreaterThanOrEqual(1);
      expect(audit!.selectedComponentCount).toBeLessThanOrEqual(2);
      expect(audit!.selectedLengthMetres).toBeGreaterThan(2);
      expect(overlays.length).toBe(audit!.selectedOverlayCount);

      for (const overlay of overlays) {
        expect(overlay.localPoints.length).toBeGreaterThanOrEqual(2);
        expect(overlay.lengthMetres).toBeGreaterThan(2);
        expect(overlay.sourceEdgeIds.length).toBeGreaterThanOrEqual(1);
        for (const point of overlay.localPoints) {
          expect(point.x).toBeGreaterThanOrEqual(-0.001);
          expect(point.y).toBeGreaterThanOrEqual(-0.001);
          expect(point.x).toBeLessThanOrEqual(1023.001);
          expect(point.y).toBeLessThanOrEqual(1023.001);
        }
      }
    }

    const trencianska = result.audits.find(
      (candidate) => candidate.name === 'Trenčianska cesta',
    )!;
    expect(trencianska.selectedOverlayCount).toBeLessThanOrEqual(2);
    expect(trencianska.rawDirectedEdgeCount).toBeGreaterThan(
      trencianska.selectedOverlayCount,
    );

    const geometryKeys = result.roads.map((road) => {
      const forward = road.localPoints
        .map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`)
        .join('|');
      const reverse = [...road.localPoints]
        .reverse()
        .map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`)
        .join('|');
      return forward < reverse ? forward : reverse;
    });
    expect(new Set(geometryKeys).size).toBe(geometryKeys.length);
  });
});
