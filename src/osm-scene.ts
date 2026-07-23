import type { CanonicalMesh, CanonicalScene, Vec3 } from './core';
import { loadElevationModel, type ElevationModel } from './elevation';
import {
  buildCanonical1mInspectMesh,
  buildCanonicalTerrain,
  buildCesiumTerrainPreviewMesh,
  sampleCrossSectionDiagnostics,
  verifyCanonicalSampleAlignment,
  type BeamNgPreset,
  type CanonicalTerrain,
  type CrossSectionDiagnostics,
  type SampleAlignmentReport,
} from './roads/canonical-terrain';
import { buildEngineeredRoadMesh } from './roads/road-mesh';
import { type LocalPoint } from './roads/road-stationing';
import { SpatialRoadIndex } from './roads/spatial-road-index';
import { buildDesignedRoad, type DesignedRoad, type RoadInput } from './roads/vertical-alignment';

export interface AreaSelection {
  longitude: number;
  latitude: number;
  sizeMetres: number;
  inspectMode?: boolean;
}

export interface OsmWay {
  type: 'way';
  id: number;
  nodes: number[];
  tags?: OsmTags;
}

export interface OsmNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
}

export type OsmTags = Record<string, string>;

export interface OsmPayload {
  elements: Array<OsmWay | OsmNode>;
}

export interface ProxyResponse {
  source: string;
  fetchedAt: string;
  data: OsmPayload;
}

export interface StageTimings {
  demLoadMs: number;
  osmLoadMs: number;
  profileDesignMs: number;
  spatialIndexMs: number;
  terrainDeformMs: number;
  roadMeshMs: number;
  totalCompilationMs: number;
}

export interface OsmSceneStats {
  source: string;
  fetchedAt: string;
  bbox: readonly [number, number, number, number];
  waysImported: number;
  roadSegments: number;
  namedRoads: string[];
  totalLengthMetres: number;
  highwayCounts: Record<string, number>;
  elevationSource: string;
  anchorElevationMetres: number;
  minimumElevationMetres: number;
  maximumElevationMetres: number;
  reliefMetres: number;
  timings: StageTimings;
  earthworks: {
    maximumCutMetres: number;
    maximumFillMetres: number;
    totalCutVolumeEstimate: number;
    totalFillVolumeEstimate: number;
  };
  beamNgTerrain: {
    presetLabel: string;
    exactSizeMetres: string;
    squareSizeMetres: number;
    totalHeightSamples: number;
  };
  canonicalTerrain: {
    resolution: BeamNgPreset;
    squareSize: 1;
    worldSideMetres: number;
    totalSamples: number;
    sampleSpacingMetres: number;
    alignment: SampleAlignmentReport;
    crossSection: CrossSectionDiagnostics;
    encoding: {
      localRelief: number;
      chosenMaxHeight: number;
      verticalStep: number;
      maximumEncodingError: number;
    };
  };
  cesiumOverview: {
    previewVertices: number;
    previewTriangles: number;
    previewSpacingMetres: number;
  };
  canonical1mInspect: {
    active: boolean;
    patchSizeMetres: number;
    renderedSpacingMetres: number;
    renderedVertices: number;
  };
}

export interface OsmSceneResult {
  scene: CanonicalScene;
  stats: OsmSceneStats;
  canonicalTerrain: CanonicalTerrain;
}

const EXCLUDED_HIGHWAYS = new Set([
  'footway',
  'pedestrian',
  'steps',
  'path',
  'bridleway',
  'cycleway',
  'proposed',
  'construction',
  'platform',
  'raceway',
]);

export const DEFAULT_AREA_SELECTION: AreaSelection = {
  longitude: 18.343444,
  latitude: 48.732751,
  sizeMetres: 2048, // BeamNG 2048 preset
  inspectMode: false,
};

export function selectionToBbox(selection: AreaSelection): readonly [number, number, number, number] {
  const norm = normaliseSelection(selection);
  const halfExtent = norm.sizeMetres / 2;
  const metresPerDegreeLat = 111_320;
  const metresPerDegreeLon = metresPerDegreeLat * Math.cos((norm.latitude * Math.PI) / 180);
  const deltaLat = halfExtent / metresPerDegreeLat;
  const deltaLon = halfExtent / metresPerDegreeLon;

  return [
    norm.longitude - deltaLon,
    norm.latitude - deltaLat,
    norm.longitude + deltaLon,
    norm.latitude + deltaLat,
  ] as const;
}

export async function buildOsmScene(
  selection: AreaSelection,
  loadElevation: (sel: AreaSelection) => Promise<ElevationModel> = loadElevationModel,
): Promise<OsmSceneResult> {
  const totalStart = performance.now();
  const normSelection = normaliseSelection(selection);
  const bbox = selectionToBbox(normSelection);
  const halfExtentMetres = normSelection.sizeMetres / 2;
  const presetResolution = snapToBeamNgPreset(normSelection.sizeMetres);

  const demStart = performance.now();
  const elevation = await loadElevation(normSelection);
  const demLoadMs = performance.now() - demStart;

  const osmStart = performance.now();
  const payload = await fetchOsmPayload(bbox);
  const osmLoadMs = performance.now() - osmStart;

  const anchor = {
    longitude: normSelection.longitude,
    latitude: normSelection.latitude,
    height: elevation.anchorElevationMetres,
  };

  const nodes = new Map<number, LocalPoint>();
  for (const element of payload.data.elements) {
    if (element.type === 'node') {
      nodes.set(element.id, geographicToLocal(element.lon, element.lat, anchor));
    }
  }

  let waysImported = 0;
  const highwayCounts: Record<string, number> = {};
  const namedRoads = new Set<string>();

  const rawInputs: RoadInput[] = [];

  for (const element of payload.data.elements) {
    if (element.type !== 'way') continue;
    const way = element as OsmWay;
    const tags = way.tags ?? {};
    const highway = tags.highway;

    if (!highway || EXCLUDED_HIGHWAYS.has(highway) || tags.area === 'yes') continue;

    const sourcePoints = way.nodes
      .map((nodeId) => nodes.get(nodeId))
      .filter((point): point is LocalPoint => point !== undefined);
    if (sourcePoints.length < 2) continue;

    const closed = way.nodes.length > 2 && way.nodes[0] === way.nodes[way.nodes.length - 1];
    const cleanPoints = deduplicatePoints(closed ? sourcePoints.slice(0, -1) : sourcePoints);
    if (cleanPoints.length < 2) continue;

    const polylines = clipPolyline(cleanPoints, closed, halfExtentMetres + 20);
    if (polylines.length === 0) continue;

    const width = roadWidth(tags);
    let wayAdded = false;

    for (let pIdx = 0; pIdx < polylines.length; pIdx++) {
      const polyline = polylines[pIdx];
      if (polyline.length < 2) continue;
      rawInputs.push({
        id: `way-${way.id}-${pIdx}`,
        osmWayId: way.id,
        highwayClass: highway,
        points: polyline,
        width,
        bridge: tags.bridge === 'yes',
        tunnel: tags.tunnel === 'yes',
        layer: Number.parseInt(tags.layer ?? '0', 10),
      });
      wayAdded = true;
    }

    if (!wayAdded) continue;
    waysImported += 1;
    highwayCounts[highway] = (highwayCounts[highway] ?? 0) + 1;
    if (tags.name) namedRoads.add(tags.name);
  }

  // 1. Profile Design Stage
  const profileStart = performance.now();
  const designedRoads: DesignedRoad[] = rawInputs.map((input) => buildDesignedRoad(input, elevation));
  const profileDesignMs = performance.now() - profileStart;

  // Aggregate earthwork stats
  let maximumCutMetres = 0;
  let maximumFillMetres = 0;
  let totalCutVolumeEstimate = 0;
  let totalFillVolumeEstimate = 0;

  for (const dr of designedRoads) {
    maximumCutMetres = Math.max(maximumCutMetres, dr.maximumCut);
    maximumFillMetres = Math.max(maximumFillMetres, dr.maximumFill);
    totalCutVolumeEstimate += dr.totalCutVolumeEstimate;
    totalFillVolumeEstimate += dr.totalFillVolumeEstimate;
  }

  // 2. Spatial Index Stage
  const spatialStart = performance.now();
  const spatialIndex = new SpatialRoadIndex(halfExtentMetres, designedRoads);
  const spatialIndexMs = performance.now() - spatialStart;

  // 3. Authoritative CanonicalTerrain Heightfield (1m per sample)
  const terrainStart = performance.now();
  const canonicalTerrain = buildCanonicalTerrain(presetResolution, elevation, spatialIndex);
  const terrainDeformMs = performance.now() - terrainStart;

  // 4. Cesium Overview Mesh (257 x 257 vertices)
  const overviewMesh = buildCesiumTerrainPreviewMesh(canonicalTerrain, elevation.anchorElevationMetres, 257);

  // 5. Optional Canonical 1m Inspect Mesh (128m x 128m patch @ exact 1m spacing)
  const inspectMesh = buildCanonical1mInspectMesh(
    canonicalTerrain,
    { x: 0, y: 0 },
    128,
    elevation.anchorElevationMetres,
  );

  // 6. Road Mesh Generation Stage
  const roadMeshStart = performance.now();
  const roadResult = buildEngineeredRoadMesh(designedRoads, spatialIndex, elevation);
  const roadMeshMs = performance.now() - roadMeshStart;

  const totalCompilationMs = performance.now() - totalStart;

  if (roadResult.segments === 0) throw new Error('No driveable OSM highway geometry was found in the selected area.');

  const terrainMeshToRender = normSelection.inspectMode ? inspectMesh : overviewMesh;

  const scene: CanonicalScene = {
    id: `triworld-osm-beamng-${presetResolution}m-v04`,
    schemaVersion: '0.1.0',
    coordinateSystem: {
      handedness: 'right',
      upAxis: 'Z',
      units: 'metres',
      localFrame: 'ENU',
    },
    anchor,
    materials: [
      { id: 'terrain-dem', name: 'Real DEM terrain', color: [0.16, 0.42, 0.24, 1] },
      { id: 'road-osm', name: 'OpenStreetMap roads', color: [1, 0.08, 0.58, 1] },
    ],
    meshes: [terrainMeshToRender, roadResult.mesh],
    spawns: [buildSpawn(roadResult.mesh.positions, elevation)],
  };

  const alignment = verifyCanonicalSampleAlignment(canonicalTerrain, elevation);
  const crossSection = sampleCrossSectionDiagnostics(canonicalTerrain, elevation, Math.floor(canonicalTerrain.resolution / 2));

  return {
    scene,
    canonicalTerrain,
    stats: {
      source: payload.source,
      fetchedAt: payload.fetchedAt,
      bbox,
      waysImported,
      roadSegments: roadResult.segments,
      namedRoads: [...namedRoads].sort((a, b) => a.localeCompare(b)),
      totalLengthMetres: roadResult.length,
      highwayCounts,
      elevationSource: elevation.source,
      anchorElevationMetres: elevation.anchorElevationMetres,
      minimumElevationMetres: canonicalTerrain.minimumElevation,
      maximumElevationMetres: canonicalTerrain.maximumElevation,
      reliefMetres: canonicalTerrain.maximumElevation - canonicalTerrain.minimumElevation,
      timings: {
        demLoadMs,
        osmLoadMs,
        profileDesignMs,
        spatialIndexMs,
        terrainDeformMs,
        roadMeshMs,
        totalCompilationMs,
      },
      earthworks: {
        maximumCutMetres,
        maximumFillMetres,
        totalCutVolumeEstimate,
        totalFillVolumeEstimate,
      },
      beamNgTerrain: {
        presetLabel: `BeamNG ${presetResolution}`,
        exactSizeMetres: `${presetResolution} × ${presetResolution} m`,
        squareSizeMetres: 1,
        totalHeightSamples: canonicalTerrain.heights.length,
      },
      canonicalTerrain: {
        resolution: presetResolution,
        squareSize: 1,
        worldSideMetres: presetResolution,
        totalSamples: canonicalTerrain.heights.length,
        sampleSpacingMetres: 1.0,
        alignment,
        crossSection,
        encoding: {
          localRelief: canonicalTerrain.encoding.localRelief,
          chosenMaxHeight: canonicalTerrain.encoding.chosenMaxHeight,
          verticalStep: canonicalTerrain.encoding.verticalStep,
          maximumEncodingError: canonicalTerrain.encoding.maximumEncodingError,
        },
      },
      cesiumOverview: {
        previewVertices: overviewMesh.positions.length / 3,
        previewTriangles: overviewMesh.indices.length / 3,
        previewSpacingMetres: presetResolution / 256.0,
      },
      canonical1mInspect: {
        active: Boolean(normSelection.inspectMode),
        patchSizeMetres: 128,
        renderedSpacingMetres: 1.0,
        renderedVertices: inspectMesh.positions.length / 3,
      },
    },
  };
}

async function fetchOsmPayload(bbox: readonly [number, number, number, number]): Promise<ProxyResponse> {
  const bboxText = bbox.join(',');
  const response = await fetch(`/api/osm?bbox=${encodeURIComponent(bboxText)}`);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OSM request failed (${response.status}): ${text.slice(0, 220)}`);
  }
  return (await response.json()) as ProxyResponse;
}

function snapToBeamNgPreset(sizeMetres: number): BeamNgPreset {
  if (sizeMetres <= 768) return 512;
  if (sizeMetres <= 1536) return 1024;
  if (sizeMetres <= 3072) return 2048;
  return 4096;
}

function normaliseSelection(selection: AreaSelection): AreaSelection {
  const longitude = Number(selection.longitude);
  const latitude = Number(selection.latitude);
  const sizeMetres = snapToBeamNgPreset(Number(selection.sizeMetres));

  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new Error('Selected longitude is invalid.');
  }
  if (!Number.isFinite(latitude) || latitude < -85 || latitude > 85) {
    throw new Error('Selected latitude is invalid.');
  }

  return {
    longitude,
    latitude,
    sizeMetres,
    inspectMode: Boolean(selection.inspectMode),
  };
}

function clipPolyline(points: LocalPoint[], closed: boolean, extent: number): LocalPoint[][] {
  const result: LocalPoint[][] = [];
  let current: LocalPoint[] = [];
  const segmentCount = closed ? points.length : points.length - 1;

  for (let index = 0; index < segmentCount; index++) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const clipped = clipSegment(a, b, extent);

    if (!clipped) {
      if (current.length > 1) result.push(current);
      current = [];
      continue;
    }

    const [start, end] = clipped;
    if (current.length === 0) {
      current = [start, end];
    } else if (distance(current[current.length - 1], start) < 0.02) {
      if (distance(current[current.length - 1], end) >= 0.02) current.push(end);
    } else {
      if (current.length > 1) result.push(current);
      current = [start, end];
    }
  }

  if (current.length > 1) result.push(current);
  return result;
}

function clipSegment(a: LocalPoint, b: LocalPoint, extent: number): [LocalPoint, LocalPoint] | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;

  const tests: Array<[number, number]> = [
    [-dx, a.x + extent],
    [dx, extent - a.x],
    [-dy, a.y + extent],
    [dy, extent - a.y],
  ];

  for (const [p, q] of tests) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return null;
      continue;
    }

    const ratio = q / p;
    if (p < 0) {
      if (ratio > t1) return null;
      t0 = Math.max(t0, ratio);
    } else {
      if (ratio < t0) return null;
      t1 = Math.min(t1, ratio);
    }
  }

  return [
    { x: a.x + dx * t0, y: a.y + dy * t0 },
    { x: a.x + dx * t1, y: a.y + dy * t1 },
  ];
}

function geographicToLocal(
  longitude: number,
  latitude: number,
  anchor: { longitude: number; latitude: number },
): LocalPoint {
  const metresPerDegreeLatitude = 111_320;
  const metresPerDegreeLongitude = metresPerDegreeLatitude * Math.cos((anchor.latitude * Math.PI) / 180);
  return {
    x: (longitude - anchor.longitude) * metresPerDegreeLongitude,
    y: (latitude - anchor.latitude) * metresPerDegreeLatitude,
  };
}

function roadWidth(tags: OsmTags): number {
  const highway = tags.highway;
  const baseWidths: Record<string, number> = {
    motorway: 14,
    motorway_link: 6.5,
    trunk: 12,
    trunk_link: 6.5,
    primary: 10,
    primary_link: 6,
    secondary: 9,
    secondary_link: 5.8,
    tertiary: 8,
    tertiary_link: 5.5,
    residential: 6.5,
    living_street: 5.5,
    unclassified: 6,
    service: 4.5,
    track: 3.5,
    road: 5.5,
  };

  const lanes = Number.parseFloat(tags.lanes ?? '');
  const laneWidth = Number.isFinite(lanes) && lanes > 0 ? lanes * 3.15 : 0;
  return Math.max(baseWidths[highway] ?? 5, laneWidth);
}

function buildSpawn(roadPositions: number[], elevation: ElevationModel): { id: string; position: Vec3; headingDegrees: number } {
  if (roadPositions.length >= 6) {
    const x = (roadPositions[0] + roadPositions[3]) / 2;
    const y = (roadPositions[1] + roadPositions[4]) / 2;
    const z = Math.max(roadPositions[2], roadPositions[5]) + 2.8;
    return { id: 'spawn-osm-first-road', position: [x, y, z], headingDegrees: 0 };
  }
  return { id: 'spawn-centre', position: [0, 0, elevation.sampleRelativeLocal(0, 0) + 3], headingDegrees: 0 };
}

function deduplicatePoints(points: LocalPoint[]): LocalPoint[] {
  const result: LocalPoint[] = [];
  for (const point of points) {
    if (result.length === 0 || distance(result[result.length - 1], point) >= 0.02) result.push(point);
  }
  return result;
}

function distance(a: LocalPoint, b: LocalPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}
