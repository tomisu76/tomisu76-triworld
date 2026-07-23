import type { CanonicalScene, CanonicalMesh } from '../core';
import { loadElevationModel, type ElevationModel } from '../elevation';
import {
  buildCanonical1mInspectMesh,
  buildCesiumTerrainPreviewMesh,
  type BeamNgPreset,
  type CanonicalTerrain,
} from '../roads/canonical-terrain';
import { TerrainGridV3 } from './terrain/TerrainGridV3';
import { canonicalizeSumoDirection, resampleSumoShapeGlobal, type SumoLaneGeometry, type DesignedSumoStation } from './sumo/SumoGeometryV3';
import { designVerticalProfileV3 } from './civil/designVerticalProfile';
import { buildCorridorV3, type CorridorResultV3 } from './corridor/buildCorridor';
import { executeCorridorTransactionV3 } from './raster/corridorTransaction';
import { syntheticLane } from './testing/syntheticSumoLane';
import { validateV3Semantics, type SemanticValidationReportV3 } from './diagnostics/validateV3Semantics';
import type { AreaSelectionV2, OsmNodeV2, OsmWayV2 } from '../pipeline-v2/osm-scene-v2';
import { clipRoadWayToBoundsV2 } from '../pipeline-v2/roads/road-clip-v2';

export interface OsmSceneResultV3 {
  scene: CanonicalScene;
  gridV3: TerrainGridV3;
  semanticReport: SemanticValidationReportV3;
  stats: {
    presetLabel: string;
    exactSizeMetres: string;
    terrainVertexIntervalMetres: number;
    terrainMeshResolution: number;
    totalHeightSamples: number;
    roadSegmentsCount: number;
    totalRoadLengthMetres: number;
    terrainSourceLabel: string;
  };
}

export async function buildOsmSceneV3(
  selection: AreaSelectionV2,
  useValidationAlphaSynthetic: boolean = false,
  loadElevation: (sel: AreaSelectionV2) => Promise<ElevationModel> = loadElevationModel,
): Promise<OsmSceneResultV3> {
  const presetResolution: BeamNgPreset = snapToBeamNgPreset(selection.sizeMetres);
  const elevation = await loadElevation({ ...selection, sizeMetres: presetResolution });

  // 1. Create TerrainGridV3 storing relative local elevations (anchorElevation = 0 at center)
  const gridV3 = new TerrainGridV3(presetResolution, 1.0, (x, y) => elevation.sampleRelativeLocal(x, y));

  const anchor = {
    longitude: selection.longitude,
    latitude: selection.latitude,
    height: elevation.anchorElevationMetres,
  };

  const maxSampleExtent = (presetResolution - 1) / 2;
  const halfExtent = presetResolution / 2;
  const terrainMeshResolution = presetResolution + 1; // 513x513 vertices for 512m preset = exact 1.000m/vertex
  const terrainVertexIntervalMetres = presetResolution / (terrainMeshResolution - 1); // Exactly 1.000m

  // Fatal scale invariant check
  if (Math.abs(terrainVertexIntervalMetres - 1.0) >= 1e-6) {
    throw new Error(`Fatal Overview Scale Contradiction: interval ${terrainVertexIntervalMetres} != 1.000`);
  }

  const allRenderTriangles: Array<{ v0: { x: number; y: number; z: number }; v1: { x: number; y: number; z: number }; v2: { x: number; y: number; z: number } }> = [];
  const allCorridorTriangles: CorridorResultV3['triangles'] = [];

  let roadSegmentsCount = 0;
  let totalRoadLengthMetres = 0;
  let primaryCorridor: CorridorResultV3 = { crossSections: [], quads: [], triangles: [] };
  let primaryStations: DesignedSumoStation[] = [];

  const VISUAL_PREVIEW_ROAD_LIFT = 0.05; // 5cm UI visual lift to prevent WebGL GPU Z-fighting with terrain

  if (useValidationAlphaSynthetic) {
    // Isolated Validation Alpha: Render single synthetic curved SumoLaneGeometry
    const width = syntheticLane.width;
    const laneGeom = syntheticLane;

    const sumoResult = canonicalizeSumoDirection(laneGeom);
    const planStations = resampleSumoShapeGlobal(sumoResult.canonicalShape, 1.0);
    const profiled = designVerticalProfileV3(planStations, gridV3, false);

    primaryStations = profiled;
    primaryCorridor = buildCorridorV3(profiled, gridV3, laneGeom.edgeId, width / 2, 1.0);

    executeCorridorTransactionV3(primaryCorridor.triangles, gridV3);

    for (const tri of primaryCorridor.triangles) {
      if (tri.role === 'formation') {
        allRenderTriangles.push({
          v0: { x: tri.v0.x, y: tri.v0.y, z: tri.v0.z + VISUAL_PREVIEW_ROAD_LIFT },
          v1: { x: tri.v1.x, y: tri.v1.y, z: tri.v1.z + VISUAL_PREVIEW_ROAD_LIFT },
          v2: { x: tri.v2.x, y: tri.v2.y, z: tri.v2.z + VISUAL_PREVIEW_ROAD_LIFT },
        });
      }
    }

    roadSegmentsCount = primaryCorridor.quads.length;
    totalRoadLengthMetres = planStations[planStations.length - 1].station;
  } else {
    // Real OSM mode: Ground Road Mode Unified Multi-Pass Corridor Transaction
    const bbox = selectionToBboxV2(selection.longitude, selection.latitude, presetResolution);
    const payload = await fetchOsmPayloadV2(bbox);

    const nodes = new Map<number, { x: number; y: number }>();
    for (const element of payload.elements) {
      if (element.type === 'node') {
        nodes.set(element.id, geographicToLocalV2(element.lon, element.lat, anchor));
      }
    }

    const laneGeometries: Array<{ laneGeom: SumoLaneGeometry; width: number }> = [];

    for (const element of payload.elements) {
      if (element.type !== 'way') continue;
      const way = element as OsmWayV2;
      const tags = way.tags ?? {};
      const highway = tags.highway;
      if (!highway || tags.area === 'yes') continue;

      const sourcePoints = way.nodes
        .map((nodeId) => nodes.get(nodeId))
        .filter((p): p is { x: number; y: number } => p !== undefined);

      if (sourcePoints.length < 2) continue;

      const clippedSegments = clipRoadWayToBoundsV2(sourcePoints, maxSampleExtent);

      for (let segIdx = 0; segIdx < clippedSegments.length; segIdx++) {
        const segPoints = clippedSegments[segIdx];
        if (segPoints.length < 2) continue;

        const width = roadWidthV3(tags);

        const laneGeom: SumoLaneGeometry = {
          edgeId: `way-${way.id}-seg-${segIdx}`,
          laneId: `way-${way.id}-seg-${segIdx}_0`,
          laneIndex: 0,
          width,
          speed: 13.89,
          function: 'normal',
          shape: segPoints,
        };

        laneGeometries.push({ laneGeom, width });
      }
    }

    // Pass 1: Build & Profile All Road Lanes with Junction Endpoint Snapping
    for (const item of laneGeometries) {
      const sumoResult = canonicalizeSumoDirection(item.laneGeom);
      const planStations = resampleSumoShapeGlobal(sumoResult.canonicalShape, 1.0);
      if (planStations.length < 2) continue;

      const pStart = sumoResult.canonicalShape[0];
      const pEnd = sumoResult.canonicalShape[sumoResult.canonicalShape.length - 1];

      const startConstraintZ = gridV3.sampleSourceStrict(pStart.x, pStart.y);
      const endConstraintZ = gridV3.sampleSourceStrict(pEnd.x, pEnd.y);

      const profiled = designVerticalProfileV3(
        planStations,
        gridV3,
        false,
        startConstraintZ,
        endConstraintZ,
      );
      const corridor = buildCorridorV3(profiled, gridV3, item.laneGeom.edgeId, item.width / 2, 1.0);

      if (primaryStations.length === 0) {
        primaryStations = profiled;
        primaryCorridor = corridor;
      }

      allCorridorTriangles.push(...corridor.triangles);

      for (const tri of corridor.triangles) {
        if (tri.role === 'formation') {
          allRenderTriangles.push({
            v0: { x: tri.v0.x, y: tri.v0.y, z: tri.v0.z + VISUAL_PREVIEW_ROAD_LIFT },
            v1: { x: tri.v1.x, y: tri.v1.y, z: tri.v1.z + VISUAL_PREVIEW_ROAD_LIFT },
            v2: { x: tri.v2.x, y: tri.v2.y, z: tri.v2.z + VISUAL_PREVIEW_ROAD_LIFT },
          });
        }
      }

      roadSegmentsCount += corridor.quads.length;
      totalRoadLengthMetres += planStations[planStations.length - 1].station;
    }

    // Pass 2: Unified Atomic Transaction for Entire Network
    executeCorridorTransactionV3(allCorridorTriangles, gridV3);
  }

  // 3. Build Projected Road Surface Overlay (+0.05m visual lift above workingTerrainZ)
  const roadPositions: number[] = new Array(allRenderTriangles.length * 9);
  const roadIndices: number[] = new Array(allRenderTriangles.length * 3);

  for (let i = 0; i < allRenderTriangles.length; i++) {
    const tri = allRenderTriangles[i];
    const offset = i * 9;
    roadPositions[offset + 0] = tri.v0.x;
    roadPositions[offset + 1] = tri.v0.y;
    roadPositions[offset + 2] = tri.v0.z;

    roadPositions[offset + 3] = tri.v1.x;
    roadPositions[offset + 4] = tri.v1.y;
    roadPositions[offset + 5] = tri.v1.z;

    roadPositions[offset + 6] = tri.v2.x;
    roadPositions[offset + 7] = tri.v2.y;
    roadPositions[offset + 8] = tri.v2.z;

    roadIndices[i * 3 + 0] = i * 3 + 0;
    roadIndices[i * 3 + 1] = i * 3 + 1;
    roadIndices[i * 3 + 2] = i * 3 + 2;
  }

  const roadMesh: CanonicalMesh = {
    id: 'mesh-road-v3',
    role: 'road',
    materialId: 'road-osm',
    positions: roadPositions,
    indices: roadIndices,
  };

  // 4. Build Cesium Terrain Mesh directly at full 1x1m resolution (513 x 513 vertices)
  const canonicalTerrain: CanonicalTerrain = {
    resolution: presetResolution,
    squareSize: 1,
    worldSideMetres: presetResolution,
    origin: [-halfExtent, -halfExtent, 0],
    heights: gridV3.workingElevations,
    minimumElevation: 0,
    maximumElevation: 0,
    verticalDatum: 'EPSG:25834',
    source: `${elevation.source} (Working Elevations)`,
    transform: {
      resolution: presetResolution,
      squareSize: 1,
      halfExtentMetres: halfExtent,
      sampleSpacingMetres: 1.0,
      row0Location: 'north',
      col0Location: 'west',
    },
    seams: {
      maxHorizontalSeamMismatch: 0,
      maxVerticalSeamMismatch: 0,
    },
    encoding: {
      minimumElevation: 0,
      maximumElevation: 0,
      localRelief: 0,
      chosenMaxHeight: 0,
      verticalStep: 0,
      maximumEncodingError: 0,
      u16Heights: new Uint16Array(0),
    },
  };

  const full1mMesh = buildCesiumTerrainPreviewMesh(canonicalTerrain, 0, terrainMeshResolution);
  const inspectMesh = buildCanonical1mInspectMesh(canonicalTerrain, { x: 0, y: 0 }, 128, 0);

  const selectedTerrainMesh = selection.inspectMode ? inspectMesh : full1mMesh;

  const scene: CanonicalScene = {
    id: `triworld-v3-beamng-${presetResolution}m`,
    schemaVersion: '0.1.0',
    coordinateSystem: {
      handedness: 'right',
      upAxis: 'Z',
      units: 'metres',
      localFrame: 'ENU',
    },
    anchor,
    materials: [
      { id: 'terrain-dem', name: 'Deformed Working Terrain V3 (1x1m)', color: [0.16, 0.42, 0.24, 1] },
      { id: 'road-osm', name: 'Validation Surface Road V3', color: [1, 0.08, 0.58, 1] },
    ],
    meshes: [selectedTerrainMesh, roadMesh],
    spawns: [
      {
        id: 'spawn-v3',
        position: [0, 0, gridV3.sampleSourceStrict(0, 0) + 3],
        headingDegrees: 0,
      },
    ],
  };

  // Run Semantic Geometry & Clearance Validation
  const semanticReport = validateV3Semantics(
    gridV3,
    primaryStations,
    primaryCorridor,
    presetResolution,
    terrainMeshResolution,
    1.75,
    1.0,
  );

  return {
    scene,
    gridV3,
    semanticReport,
    stats: {
      presetLabel: `BeamNG ${presetResolution}`,
      exactSizeMetres: `${presetResolution} × ${presetResolution} m`,
      terrainVertexIntervalMetres,
      terrainMeshResolution,
      totalHeightSamples: gridV3.workingElevations.length,
      roadSegmentsCount,
      totalRoadLengthMetres,
      terrainSourceLabel: 'workingElevations (Ground Road Terrain)',
    },
  };
}

async function fetchOsmPayloadV2(bbox: readonly [number, number, number, number]): Promise<{ elements: Array<OsmWayV2 | OsmNodeV2> }> {
  const bboxText = bbox.join(',');
  const response = await fetch(`/api/osm?bbox=${encodeURIComponent(bboxText)}`);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OSM request failed (${response.status}): ${text.slice(0, 220)}`);
  }
  const json = await response.json();
  return json.data ?? json;
}

function snapToBeamNgPreset(sizeMetres: number): BeamNgPreset {
  if (sizeMetres <= 768) return 512;
  if (sizeMetres <= 1536) return 1024;
  if (sizeMetres <= 3072) return 2048;
  return 4096;
}

function selectionToBboxV2(longitude: number, latitude: number, sizeMetres: number): readonly [number, number, number, number] {
  const halfExtent = sizeMetres / 2;
  const metresPerDegreeLat = 111_320;
  const metresPerDegreeLon = metresPerDegreeLat * Math.cos((latitude * Math.PI) / 180);
  const deltaLat = halfExtent / metresPerDegreeLat;
  const deltaLon = halfExtent / metresPerDegreeLon;

  return [
    longitude - deltaLon,
    latitude - deltaLat,
    longitude + deltaLon,
    latitude + deltaLat,
  ] as const;
}

function geographicToLocalV2(lon: number, lat: number, anchor: { longitude: number; latitude: number }): { x: number; y: number } {
  const metresPerDegreeLatitude = 111_320;
  const metresPerDegreeLongitude = metresPerDegreeLatitude * Math.cos((anchor.latitude * Math.PI) / 180);
  return {
    x: (lon - anchor.longitude) * metresPerDegreeLongitude,
    y: (lat - anchor.latitude) * metresPerDegreeLatitude,
  };
}

function roadWidthV3(tags: Record<string, string>): number {
  const highway = tags.highway;
  const baseWidths: Record<string, number> = {
    motorway: 14,
    trunk: 12,
    primary: 10,
    secondary: 9,
    tertiary: 8,
    residential: 6.5,
    service: 4.5,
    track: 3.5,
  };
  return baseWidths[highway] ?? 6.0;
}
