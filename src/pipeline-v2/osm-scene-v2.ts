import type { CanonicalScene } from '../core';
import { loadElevationModel, type ElevationModel } from '../elevation';
import {
  buildCanonical1mInspectMesh,
  buildCesiumTerrainPreviewMesh,
  type BeamNgPreset,
  type CanonicalTerrain,
} from '../roads/canonical-terrain';
import { createCanonicalTerrainV2, type CanonicalTerrainV2 } from './terrain/canonical-terrain-v2';
import { clipRoadWayToBoundsV2 } from './roads/road-clip-v2';
import { resampleRoadStationingV2, type RoadPointV2 } from './roads/road-stationing-v2';
import { solveRoadTerrainCoupledV3 } from './roads/coupled-solver-v3';
import { buildRoadMeshV2PhaseA, type RoadWayV2 } from './roads/road-mesh-v2';
import { SpatialIndexV2 } from './roads/spatial-index-v2';
import { applyRoadFormationV2 } from './roads/terrain-corridor-v2';

export interface AreaSelectionV2 {
  longitude: number;
  latitude: number;
  sizeMetres: number;
  inspectMode?: boolean;
}

export interface OsmWayV2 {
  type: 'way';
  id: number;
  nodes: number[];
  tags?: Record<string, string>;
}

export interface OsmNodeV2 {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
}

export interface OsmSceneResultV2 {
  scene: CanonicalScene;
  terrainV2: CanonicalTerrainV2;
  stats: {
    presetLabel: string;
    exactSizeMetres: string;
    totalHeightSamples: number;
    roadSegmentsCount: number;
    totalRoadLengthMetres: number;
  };
}

export async function buildOsmSceneV2(
  selection: AreaSelectionV2,
  loadElevation: (sel: AreaSelectionV2) => Promise<ElevationModel> = loadElevationModel,
): Promise<OsmSceneResultV2> {
  const presetResolution: BeamNgPreset = snapToBeamNgPreset(selection.sizeMetres);
  const elevation = await loadElevation({ ...selection, sizeMetres: presetResolution });

  // 1. Create CanonicalTerrainV2 storing RELATIVE elevation (localZ = absolute - anchor)
  // This guarantees terrain Z is centered around Z = 0 at the anchor
  const terrainV2 = createCanonicalTerrainV2(presetResolution, (x, y) => elevation.sampleRelativeLocal(x, y));

  // 2. Fetch OSM payload and project into local ENU metre points
  const bbox = selectionToBboxV2(selection.longitude, selection.latitude, presetResolution);
  const payload = await fetchOsmPayloadV2(bbox);

  const anchor = {
    longitude: selection.longitude,
    latitude: selection.latitude,
    height: elevation.anchorElevationMetres,
  };

  const nodes = new Map<number, RoadPointV2>();
  for (const element of payload.elements) {
    if (element.type === 'node') {
      nodes.set(element.id, geographicToLocalV2(element.lon, element.lat, anchor));
    }
  }

  const rawWays: RoadWayV2[] = [];
  const halfExtent = presetResolution / 2;

  for (const element of payload.elements) {
    if (element.type !== 'way') continue;
    const way = element as OsmWayV2;
    const tags = way.tags ?? {};
    const highway = tags.highway;
    if (!highway || tags.area === 'yes') continue;

    const sourcePoints = way.nodes
      .map((nodeId) => nodes.get(nodeId))
      .filter((p): p is RoadPointV2 => p !== undefined);

    if (sourcePoints.length < 2) continue;

    // Strict 2D Clipping to terrain bounds [-halfExtent, +halfExtent]
    const clippedSegments = clipRoadWayToBoundsV2(sourcePoints, halfExtent);

    for (let segIdx = 0; segIdx < clippedSegments.length; segIdx++) {
      const segPoints = clippedSegments[segIdx];
      if (segPoints.length < 2) continue;

      // Resample stations at exact 1.0m fixed spacing
      const stations = resampleRoadStationingV2(segPoints, 1.0);
      if (stations.length < 2) continue;

      // Execute Road-Terrain Coupled Solver V3
      const solved = solveRoadTerrainCoupledV3(stations, terrainV2, roadWidthV2(tags));

      rawWays.push({
        id: `way-${way.id}-seg-${segIdx}`,
        roadWidthMetres: roadWidthV2(tags),
        stations: solved.solvedStations,
      });
    }
  }

  // 3. Build Metre-based Spatial Index V2
  const spatialIndex = new SpatialIndexV2(halfExtent, rawWays);

  // 4. Apply Road Corridor Formation V2 directly onto terrainV2.workingHeights
  applyRoadFormationV2(terrainV2, rawWays, spatialIndex);

  // 5. Build Road Mesh V2 (Phase A: Segment Quads)
  const roadMeshResult = buildRoadMeshV2PhaseA(rawWays);

  // 6. Build Cesium Meshes from terrainV2.workingHeights with relative elevation (anchorElevation = 0)
  const canonicalTerrain: CanonicalTerrain = {
    resolution: presetResolution,
    squareSize: 1,
    worldSideMetres: presetResolution,
    origin: [-halfExtent, -halfExtent, 0],
    heights: terrainV2.workingHeights,
    minimumElevation: 0,
    maximumElevation: 0,
    verticalDatum: 'EPSG:25834',
    source: elevation.source,
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

  const overviewMesh = buildCesiumTerrainPreviewMesh(canonicalTerrain, 0, 257); // 0 anchor because heights are relative!
  const inspectMesh = buildCanonical1mInspectMesh(canonicalTerrain, { x: 0, y: 0 }, 128, 0);

  const selectedTerrainMesh = selection.inspectMode ? inspectMesh : overviewMesh;

  const scene: CanonicalScene = {
    id: `triworld-v2-beamng-${presetResolution}m`,
    schemaVersion: '0.1.0',
    coordinateSystem: {
      handedness: 'right',
      upAxis: 'Z',
      units: 'metres',
      localFrame: 'ENU',
    },
    anchor,
    materials: [
      { id: 'terrain-dem', name: 'Real DEM terrain V2', color: [0.16, 0.42, 0.24, 1] },
      { id: 'road-osm', name: 'OpenStreetMap roads V2', color: [1, 0.08, 0.58, 1] },
    ],
    meshes: [selectedTerrainMesh, roadMeshResult.mesh],
    spawns: [
      {
        id: 'spawn-v2',
        position: [0, 0, elevation.sampleRelativeLocal(0, 0) + 3],
        headingDegrees: 0,
      },
    ],
  };

  return {
    scene,
    terrainV2,
    stats: {
      presetLabel: `BeamNG ${presetResolution}`,
      exactSizeMetres: `${presetResolution} × ${presetResolution} m`,
      totalHeightSamples: terrainV2.workingHeights.length,
      roadSegmentsCount: roadMeshResult.segmentsCount,
      totalRoadLengthMetres: roadMeshResult.totalLengthMetres,
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

function geographicToLocalV2(lon: number, lat: number, anchor: { longitude: number; latitude: number }): RoadPointV2 {
  const metresPerDegreeLatitude = 111_320;
  const metresPerDegreeLongitude = metresPerDegreeLatitude * Math.cos((anchor.latitude * Math.PI) / 180);
  return {
    x: (lon - anchor.longitude) * metresPerDegreeLongitude,
    y: (lat - anchor.latitude) * metresPerDegreeLatitude,
  };
}

function roadWidthV2(tags: Record<string, string>): number {
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
