import { describe, expect, it } from 'vitest';
import { BANOVCE_ORIGIN_WGS84, GeodeticTransformer } from './geodetic-transformer';
import { selectPrimaryOsmRoadAlignment, type OsmMapPayload } from './osm-road-source';
import { applyCoupledRoadTerrainCorridor } from './road-terrain-corridor';

function nodeFromLocal(
  transformer: GeodeticTransformer,
  id: number,
  x: number,
  y: number,
): { type: 'node'; id: number; lat: number; lon: number } {
  const wgs = transformer.localToWgs84({ x, y, z: 0 });
  return { type: 'node', id, lat: wgs.latitude, lon: wgs.longitude };
}

describe('Gate 3 real OSM road source', () => {
  it('selects the same central driveable alignment regardless of element order', () => {
    const transformer = new GeodeticTransformer(BANOVCE_ORIGIN_WGS84, 512);
    const payload: OsmMapPayload = {
      elements: [
        nodeFromLocal(transformer, 1, 20, 256),
        nodeFromLocal(transformer, 2, 256, 256),
        nodeFromLocal(transformer, 3, 492, 256),
        nodeFromLocal(transformer, 4, 20, 470),
        nodeFromLocal(transformer, 5, 492, 470),
        {
          type: 'way',
          id: 100,
          nodes: [1, 2, 3],
          tags: { highway: 'secondary', name: 'Central Road', lanes: '2' },
        },
        {
          type: 'way',
          id: 200,
          nodes: [4, 5],
          tags: { highway: 'primary', name: 'Far Road' },
        },
      ],
    };

    const first = selectPrimaryOsmRoadAlignment(payload, transformer, {
      minimumLengthMetres: 50,
      minimumInsetMetres: 10,
    });
    const second = selectPrimaryOsmRoadAlignment(
      { elements: [...payload.elements].reverse() },
      transformer,
      { minimumLengthMetres: 50, minimumInsetMetres: 10 },
    );

    expect(first.wayId).toBe(100);
    expect(first.name).toBe('Central Road');
    expect(first.pointCount).toBeGreaterThanOrEqual(2);
    expect(first.lengthMetres).toBeGreaterThan(400);
    expect(first.minimumDistanceToCentreMetres).toBeLessThan(1);
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(second.wayId).toBe(first.wayId);
    expect(second.sha256).toBe(first.sha256);
  });

  it('rejects payloads without a driveable alignment', () => {
    const transformer = new GeodeticTransformer(BANOVCE_ORIGIN_WGS84, 512);
    const payload: OsmMapPayload = {
      elements: [
        nodeFromLocal(transformer, 1, 100, 100),
        nodeFromLocal(transformer, 2, 200, 200),
        { type: 'way', id: 300, nodes: [1, 2], tags: { highway: 'footway' } },
      ],
    };

    expect(() => selectPrimaryOsmRoadAlignment(payload, transformer)).toThrow(
      'No valid driveable OSM road alignment',
    );
  });

  it('never falls back to the synthetic road when production input is missing', () => {
    const terrain = new Float32Array(16 * 16).fill(100);
    expect(() => applyCoupledRoadTerrainCorridor(terrain, 16, 1, 500)).toThrow(
      'explicit real road alignment',
    );
  });
});
