import type { CanonicalMesh, CanonicalScene, Vec3 } from './core';
import { loadElevationModel, type ElevationModel } from './elevation';
import {
  appendPreparedRoadMesh,
  prepareRoadCorridor,
  RoadTerrainIndex,
  roadHeadingDegrees,
  type PreparedRoadCorridor,
  type RoadDesign,
} from './road-terrain';

export interface AreaSelection {
  longitude: number;
  latitude: number;
  sizeMetres: number;
}

export const DEFAULT_AREA_SELECTION: AreaSelection = {
  longitude: 18.34344407408825,
  latitude: 48.73275071557837,
  sizeMetres: 2000,
};

const EXCLUDED_HIGHWAYS = new Set([
  'bridleway',
  'bus_stop',
  'construction',
  'corridor',
  'cycleway',
  'elevator',
  'escape',
  'footway',
  'path',
  'pedestrian',
  'platform',
  'proposed',
  'raceway',
  'steps',
]);

type OsmTags = Record<string, string>;

type OsmNode = {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
};

type OsmWay = {
  type: 'way';
  id: number;
  nodes: number[];
  tags?: OsmTags;
};

type OsmElement = OsmNode | OsmWay | { type: string; id: number; [key: string]: unknown };

type OsmApiResponse = {
  version: string;
  generator: string;
  elements: OsmElement[];
};

type ProxyResponse = {
  bbox: number[];
  fetchedAt: string;
  source: string;
  data: OsmApiResponse;
};

type LocalPoint = {
  x: number;
  y: number;
};

export interface OsmSceneStats {
  source: string;
  fetchedAt: string;
  bbox: readonly [number, number, number, number];
  waysImported: number;
  roadSegments: number;
  roadProfileStations: number;
  namedRoads: string[];
  totalLengthMetres: number;
  highwayCounts: Record<string, number>;
  elevationSource: string;
  anchorElevationMetres: number;
  minimumElevationMetres: number;
  maximumElevationMetres: number;
  reliefMetres: number;
  maximumRoadGradePercent: number;
  maximumRoadBankPercent: number;
  maximumTerrainCutMetres: number;
  maximumTerrainFillMetres: number;
}

export interface OsmSceneResult {
  scene: CanonicalScene;
  stats: OsmSceneStats;
}

export function selectionToBbox(selection: AreaSelection): readonly [number, number, number, number] {
  const safe = normaliseSelection(selection);
  const halfExtentMetres = safe.sizeMetres / 2;
  const metresPerDegreeLatitude = 111_320;
  const metresPerDegreeLongitude = metresPerDegreeLatitude * Math.cos((safe.latitude * Math.PI) / 180);
  const latitudeDelta = halfExtentMetres / metresPerDegreeLatitude;
  const longitudeDelta = halfExtentMetres / metresPerDegreeLongitude;

  return [
    safe.longitude - longitudeDelta,
    safe.latitude - latitudeDelta,
    safe.longitude + longitudeDelta,
    safe.latitude + latitudeDelta,
  ];
}

export async function buildOsmScene(requestedSelection: AreaSelection = DEFAULT_AREA_SELECTION): Promise<OsmSceneResult> {
  const selection = normaliseSelection(requestedSelection);
  const bbox = selectionToBbox(selection);
  const [payload, elevation] = await Promise.all([
    fetchOsmPayload(bbox),
    loadElevationModel(selection),
  ]);

  const anchor = {
    longitude: selection.longitude,
    latitude: selection.latitude,
    height: elevation.anchorElevationMetres,
  };
  const halfExtentMetres = selection.sizeMetres / 2;
  const nodes = new Map<number, LocalPoint>();

  for (const element of payload.data.elements) {
    if (element.type !== 'node') continue;
    const node = element as OsmNode;
    nodes.set(node.id, geographicToLocal(node.lon, node.lat, anchor));
  }

  const preparedRoads: PreparedRoadCorridor[] = [];
  const namedRoads = new Set<string>();
  const highwayCounts: Record<string, number> = {};
  let waysImported = 0;

  for (const element of payload.data.elements) {
    if (element.type !== 'way') continue;
    const way = element as OsmWay;
    const tags = way.tags ?? {};
    const highway = tags.highway;

    if (!highway || EXCLUDED_HIGHWAYS.has(highway) || tags.area === 'yes') continue;
    if (tags.tunnel === 'yes' || tags.covered === 'yes') continue;

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
    const design = roadDesign(tags, width);
    let wayAdded = false;

    for (let partIndex = 0; partIndex < polylines.length; partIndex++) {
      const polyline = polylines[partIndex];
      if (polyline.length < 2) continue;
      const road = prepareRoadCorridor(
        `osm-${way.id}-${partIndex}`,
        polyline,
        elevation.sampleRelativeLocal,
        design,
      );
      if (road.stations.length < 2 || road.lengthMetres < 0.05) continue;
      preparedRoads.push(road);
      wayAdded = true;
    }

    if (!wayAdded) continue;
    waysImported += 1;
    highwayCounts[highway] = (highwayCounts[highway] ?? 0) + 1;
    if (tags.name) namedRoads.add(tags.name);
  }

  if (preparedRoads.length === 0) {
    throw new Error('No driveable OSM highway geometry was found in the selected area.');
  }

  const roadTerrain = new RoadTerrainIndex(preparedRoads);
  const terrainResult = buildTerrainMesh(
    halfExtentMetres,
    selection.sizeMetres,
    elevation,
    roadTerrain,
  );
  const positions: number[] = [];
  const indices: number[] = [];
  let roadSegments = 0;
  let totalLengthMetres = 0;

  for (const preparedRoad of preparedRoads) {
    const result = appendPreparedRoadMesh(positions, indices, preparedRoad);
    roadSegments += result.segments;
    totalLengthMetres += result.lengthMetres;
  }

  const road: CanonicalMesh = {
    id: 'roads-osm-engineered',
    role: 'road',
    materialId: 'road-osm',
    positions,
    indices,
  };

  const sizeLabel = `${Math.round(selection.sizeMetres)}m`;
  const scene: CanonicalScene = {
    id: `triworld-osm-selected-${sizeLabel}-v03`,
    schemaVersion: '0.1.0',
    coordinateSystem: {
      handedness: 'right',
      upAxis: 'Z',
      units: 'metres',
      localFrame: 'ENU',
    },
    anchor,
    materials: [
      { id: 'terrain-dem', name: 'Road-conformed DMR terrain', color: [0.16, 0.42, 0.24, 1] },
      { id: 'road-osm', name: 'Engineered OpenStreetMap roads', color: [1, 0.08, 0.58, 1] },
    ],
    meshes: [terrainResult.mesh, road],
    spawns: [buildSpawn(preparedRoads, elevation)],
  };

  return {
    scene,
    stats: {
      source: payload.source,
      fetchedAt: payload.fetchedAt,
      bbox,
      waysImported,
      roadSegments,
      roadProfileStations: preparedRoads.reduce((sum, item) => sum + item.stations.length, 0),
      namedRoads: [...namedRoads].sort((a, b) => a.localeCompare(b)),
      totalLengthMetres,
      highwayCounts,
      elevationSource: elevation.source,
      anchorElevationMetres: elevation.anchorElevationMetres,
      minimumElevationMetres: terrainResult.minimumElevationMetres,
      maximumElevationMetres: terrainResult.maximumElevationMetres,
      reliefMetres: terrainResult.maximumElevationMetres - terrainResult.minimumElevationMetres,
      maximumRoadGradePercent: maximumRoadMetric(preparedRoads, 'maximumGrade') * 100,
      maximumRoadBankPercent: maximumRoadMetric(preparedRoads, 'maximumBank') * 100,
      maximumTerrainCutMetres: terrainResult.maximumCutMetres,
      maximumTerrainFillMetres: terrainResult.maximumFillMetres,
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
  return await response.json() as ProxyResponse;
}

function normaliseSelection(selection: AreaSelection): AreaSelection {
  const longitude = Number(selection.longitude);
  const latitude = Number(selection.latitude);
  const sizeMetres = Math.round(Number(selection.sizeMetres));

  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new Error('Selected longitude is invalid.');
  }
  if (!Number.isFinite(latitude) || latitude < -85 || latitude > 85) {
    throw new Error('Selected latitude is invalid.');
  }
  if (!Number.isFinite(sizeMetres) || sizeMetres < 500 || sizeMetres > 4000) {
    throw new Error('Selected area size must be between 500 and 4000 metres.');
  }

  return { longitude, latitude, sizeMetres };
}

function buildTerrainMesh(
  halfExtentMetres: number,
  sizeMetres: number,
  elevation: ElevationModel,
  roadTerrain: RoadTerrainIndex,
): {
  mesh: CanonicalMesh;
  minimumElevationMetres: number;
  maximumElevationMetres: number;
  maximumCutMetres: number;
  maximumFillMetres: number;
} {
  const requestedIntervals = Math.round(sizeMetres / 12.5);
  const intervals = Math.max(40, Math.min(320, requestedIntervals));
  const size = intervals + 1;
  const step = (halfExtentMetres * 2) / intervals;
  const positions: number[] = [];
  const indices: number[] = [];
  let minimumElevationMetres = Number.POSITIVE_INFINITY;
  let maximumElevationMetres = Number.NEGATIVE_INFINITY;
  let maximumCutMetres = 0;
  let maximumFillMetres = 0;

  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const x = -halfExtentMetres + column * step;
      const y = -halfExtentMetres + row * step;
      const baseRelativeElevation = elevation.sampleRelativeLocal(x, y);
      const conformed = roadTerrain.sample(baseRelativeElevation, x, y);
      const absoluteElevation = conformed.elevation + elevation.anchorElevationMetres;
      minimumElevationMetres = Math.min(minimumElevationMetres, absoluteElevation);
      maximumElevationMetres = Math.max(maximumElevationMetres, absoluteElevation);
      maximumCutMetres = Math.max(maximumCutMetres, conformed.cutMetres);
      maximumFillMetres = Math.max(maximumFillMetres, conformed.fillMetres);
      positions.push(x, y, conformed.elevation);
    }
  }

  for (let row = 0; row < size - 1; row++) {
    for (let column = 0; column < size - 1; column++) {
      const a = row * size + column;
      const b = a + 1;
      const c = a + size;
      const d = c + 1;
      indices.push(a, b, d, a, d, c);
    }
  }

  return {
    mesh: {
      id: `terrain-dem-road-conformed-${Math.round(sizeMetres)}m`,
      role: 'terrain',
      materialId: 'terrain-dem',
      positions,
      indices,
    },
    minimumElevationMetres,
    maximumElevationMetres,
    maximumCutMetres,
    maximumFillMetres,
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

function roadDesign(tags: OsmTags, widthMetres: number): Partial<RoadDesign> & Pick<RoadDesign, 'widthMetres'> {
  const highway = tags.highway;
  const maximumGrades: Record<string, number> = {
    motorway: 0.07,
    motorway_link: 0.10,
    trunk: 0.09,
    trunk_link: 0.11,
    primary: 0.11,
    primary_link: 0.13,
    secondary: 0.13,
    secondary_link: 0.15,
    tertiary: 0.15,
    tertiary_link: 0.17,
    residential: 0.18,
    living_street: 0.18,
    unclassified: 0.20,
    service: 0.22,
    track: 0.28,
    road: 0.20,
  };
  const defaultSpeedsKmh: Record<string, number> = {
    motorway: 100,
    motorway_link: 50,
    trunk: 80,
    trunk_link: 50,
    primary: 70,
    primary_link: 45,
    secondary: 60,
    secondary_link: 40,
    tertiary: 50,
    tertiary_link: 35,
    residential: 35,
    living_street: 20,
    unclassified: 40,
    service: 25,
    track: 20,
    road: 35,
  };
  const speedKmh = parseSpeedKmh(tags.maxspeed) ?? defaultSpeedsKmh[highway] ?? 40;
  const majorRoad = ['motorway', 'trunk', 'primary', 'secondary'].includes(highway);

  return {
    widthMetres,
    stationSpacingMetres: majorRoad ? 4 : 5,
    maximumGrade: maximumGrades[highway] ?? 0.20,
    maximumBank: majorRoad ? 0.05 : 0.04,
    designSpeedMetresPerSecond: speedKmh / 3.6,
    shoulderWidthMetres: majorRoad ? 2 : highway === 'track' ? 0.5 : 1.25,
    minimumBlendWidthMetres: majorRoad ? 10 : 7,
    maximumBlendWidthMetres: majorRoad ? 42 : 34,
    surfaceRaiseMetres: highway === 'track' ? 0.06 : 0.12,
    surfaceClearanceMetres: highway === 'track' ? 0.12 : 0.18,
    terrainConform: tags.bridge !== 'yes' && tags.layer !== '1' && tags.layer !== '2',
  };
}

function parseSpeedKmh(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return value.toLowerCase().includes('mph') ? parsed * 1.609344 : parsed;
}

function buildSpawn(
  roads: readonly PreparedRoadCorridor[],
  elevation: ElevationModel,
): { id: string; position: Vec3; headingDegrees: number } {
  const road = roads.find((candidate) => candidate.stations.length >= 2);
  if (road) {
    const station = road.stations[0];
    return {
      id: 'spawn-osm-first-road',
      position: [station.x, station.y, station.z + 2.8],
      headingDegrees: roadHeadingDegrees(road),
    };
  }
  return { id: 'spawn-centre', position: [0, 0, elevation.sampleRelativeLocal(0, 0) + 3], headingDegrees: 0 };
}

function maximumRoadMetric(
  roads: readonly PreparedRoadCorridor[],
  metric: 'maximumGrade' | 'maximumBank',
): number {
  return roads.reduce((maximum, road) => Math.max(maximum, road[metric]), 0);
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
