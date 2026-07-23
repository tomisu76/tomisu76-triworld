import { describe, expect, it } from 'vitest';
import {
  appendPreparedRoadMesh,
  prepareRoadCorridor,
  RoadTerrainIndex,
  roadHeadingDegrees,
} from './road-terrain';

describe('road-first terrain engine', () => {
  it('densifies, smooths and grade-limits a noisy DEM profile', () => {
    const road = prepareRoadCorridor(
      'grade-test',
      [{ x: 0, y: 0 }, { x: 100, y: 0 }],
      (x) => Math.sin(x * 0.7) * 7 + x * 0.08,
      {
        widthMetres: 7,
        stationSpacingMetres: 4,
        maximumGrade: 0.10,
        maximumBank: 0.03,
        surfaceRaiseMetres: 0.1,
      },
    );

    expect(road.stations.length).toBeGreaterThan(20);
    expect(road.lengthMetres).toBeCloseTo(100, 6);
    expect(road.maximumGrade).toBeLessThanOrEqual(0.100001);
    expect(road.maximumBank).toBeLessThanOrEqual(0.030001);
  });

  it('cuts or fills the terrain under the road and leaves distant DEM samples unchanged', () => {
    const road = prepareRoadCorridor(
      'earthworks-test',
      [{ x: -50, y: 0 }, { x: 50, y: 0 }],
      () => 0,
      {
        widthMetres: 8,
        stationSpacingMetres: 5,
        maximumBank: 0,
        shoulderWidthMetres: 1,
        minimumBlendWidthMetres: 8,
        maximumBlendWidthMetres: 20,
        surfaceRaiseMetres: 0.2,
        surfaceClearanceMetres: 0.2,
      },
    );
    const index = new RoadTerrainIndex([road]);

    const centre = index.sample(5, 0, 0);
    const transition = index.sample(5, 0, 10);
    const distant = index.sample(5, 0, 50);

    expect(centre.elevation).toBeCloseTo(0, 6);
    expect(centre.cutMetres).toBeCloseTo(5, 6);
    expect(centre.influence).toBe(1);
    expect(transition.elevation).toBeGreaterThan(0);
    expect(transition.elevation).toBeLessThan(5);
    expect(distant.elevation).toBe(5);
    expect(distant.influence).toBe(0);
  });

  it('uses the same prepared stations for a correctly wound road mesh', () => {
    const road = prepareRoadCorridor(
      'mesh-test',
      [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 60, y: 20 }],
      () => 3,
      { widthMetres: 6, stationSpacingMetres: 5 },
    );
    const positions: number[] = [];
    const indices: number[] = [];
    const result = appendPreparedRoadMesh(positions, indices, road);

    expect(positions.length).toBe(road.stations.length * 6);
    expect(indices.length).toBe(result.segments * 6);
    expect(result.lengthMetres).toBeCloseTo(road.lengthMetres, 8);

    for (let triangle = 0; triangle < indices.length; triangle += 3) {
      const a = vertex(positions, indices[triangle]);
      const b = vertex(positions, indices[triangle + 1]);
      const c = vertex(positions, indices[triangle + 2]);
      const crossZ = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      expect(crossZ).toBeGreaterThan(0);
    }
  });

  it('reports BeamNG-style compass heading from the first road segment', () => {
    const north = prepareRoadCorridor(
      'north',
      [{ x: 0, y: 0 }, { x: 0, y: 20 }],
      () => 0,
      { widthMetres: 6 },
    );
    const east = prepareRoadCorridor(
      'east',
      [{ x: 0, y: 0 }, { x: 20, y: 0 }],
      () => 0,
      { widthMetres: 6 },
    );

    expect(roadHeadingDegrees(north)).toBeCloseTo(0, 8);
    expect(roadHeadingDegrees(east)).toBeCloseTo(90, 8);
  });
});

function vertex(positions: number[], index: number): { x: number; y: number } {
  return { x: positions[index * 3], y: positions[index * 3 + 1] };
}
