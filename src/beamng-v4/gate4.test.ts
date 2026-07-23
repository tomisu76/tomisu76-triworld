import { describe, it, expect } from 'vitest';
import {
  generateRoadSurfaceMesh,
  exportRoadMeshToDae,
  generateAsphaltTexturePng,
} from './road-mesh-exporter';
import { generateLevelPackageFiles } from './level-generator';
import type { OsmRoadAlignment } from './osm-road-source';

describe('TRIWORLD V4 — BEAMNG NATIVE, GATE 4 (Road Surface Mesh V3)', () => {
  const dummyRoad: OsmRoadAlignment = {
    wayId: 109459194,
    fragmentIndex: 0,
    highway: 'tertiary',
    laneWidthMetres: 6.0,
    lengthMetres: 100.0,
    pointCount: 3,
    pointsCentered: [
      { x: -50, y: -50, z: 350 },
      { x: 0, y: 0, z: 352 },
      { x: 50, y: 50, z: 355 },
    ],
  };

  const dummyTerrainSampler = (x: number, y: number) => 349.5; // 349.5m flat terrain

  it('1. Generates Road Surface Mesh V3 with zero negative clearance and bounded clearance', () => {
    const mesh = generateRoadSurfaceMesh(dummyRoad, dummyTerrainSampler);

    expect(mesh.vertexCount).toBe(6);
    expect(mesh.triangleCount).toBe(4);
    expect(mesh.segmentCount).toBe(2);
    expect(mesh.clearanceStats.negativeCount).toBe(0);
    expect(mesh.clearanceStats.minMetres).toBe(0.04);
    expect(mesh.clearanceStats.maxMetres).toBe(0.04);
  });

  it('1b. Generates dense Road Surface Mesh V3 from 1.0m stations with strictly bounded clearance <= 0.08m', () => {
    const dummyStations = Array.from({ length: 853 }, (_, i) => ({
      station: i * 1.0,
      x: -400 + i * 0.9,
      y: -400 + i * 0.9,
      tangentX: 0.7071,
      tangentY: 0.7071,
      normalX: -0.7071,
      normalY: 0.7071,
      groundZ: 350.0,
      designZ: 350.0,
      formationZ: 349.75,
      surfaceZ: 350.05,
    }));

    const mesh = generateRoadSurfaceMesh(dummyRoad, dummyTerrainSampler, dummyStations);

    expect(mesh.vertexCount).toBe(1706);
    expect(mesh.triangleCount).toBe(1704);
    expect(mesh.segmentCount).toBe(852);
    expect(mesh.clearanceStats.negativeCount).toBe(0);
    expect(mesh.clearanceStats.minMetres).toBe(0.04);
    expect(mesh.clearanceStats.maxMetres).toBeLessThanOrEqual(0.08);
  });

  it('2. Exports valid Collada 1.4.1 DAE with Z_UP up-axis and correct material', () => {
    const mesh = generateRoadSurfaceMesh(dummyRoad, dummyTerrainSampler);
    const daeXml = exportRoadMeshToDae(mesh, 'triworld_asphalt');

    expect(daeXml).toContain('<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">');
    expect(daeXml).toContain('<up_axis>Z_UP</up_axis>');
    expect(daeXml).toContain('<material id="triworld_asphalt-material" name="triworld_asphalt">');
    expect(daeXml).toContain('<geometry id="RoadMesh-mesh" name="RoadMesh">');
    expect(daeXml).toContain('<instance_material symbol="triworld_asphalt-material" target="#triworld_asphalt-material"/>');
  });

  it('3. Generates 8-bit RGBA asphalt texture PNG', () => {
    const asphaltPng = generateAsphaltTexturePng(128);
    expect(asphaltPng).toBeInstanceOf(Uint8Array);
    expect(asphaltPng.length).toBeGreaterThan(100);
    // Standard PNG header signature 0x89 'P' 'N' 'G'
    expect(asphaltPng[0]).toBe(0x89);
    expect(asphaltPng[1]).toBe(0x50);
    expect(asphaltPng[2]).toBe(0x4e);
    expect(asphaltPng[3]).toBe(0x47);
  });

  it('4. Includes TSStatic road mesh object and asphalt material in level package files', () => {
    const mesh = generateRoadSurfaceMesh(dummyRoad, dummyTerrainSampler);
    const roadDae = exportRoadMeshToDae(mesh, 'triworld_asphalt');
    const asphaltPng = generateAsphaltTexturePng(64);

    const levelFiles = generateLevelPackageFiles(
      { size: 512, squareSize: 1.0, maxHeight: 500.0, minimumDecodedElevation: 300, maximumDecodedElevation: 400 },
      {
        levelName: 'triworld_v4_gate4_roadmesh1',
        roadDae,
        asphaltPng,
        asphaltMaterialName: 'triworld_asphalt',
      },
    );

    expect(levelFiles.itemsLevelJson).toContain('"class":"TSStatic"');
    expect(levelFiles.itemsLevelJson).toContain('"shapeName":"/levels/triworld_v4_gate4_roadmesh1/art/road/road_surface.dae"');
    expect(levelFiles.itemsLevelJson).toContain('"collisionType":"Visible Mesh"');

    expect(levelFiles.materialsJson).toContain('"triworld_asphalt"');
    expect(levelFiles.materialsJson).toContain('"groundmodelName": "ASPHALT"');
    expect(levelFiles.materialsJson).toContain('"colorMap": "/levels/triworld_v4_gate4_roadmesh1/art/road/asphalt_d.png"');
  });
});
