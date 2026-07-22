import type { CanonicalMesh, CanonicalScene, Vec3 } from './core';

export interface OsmSceneOptions {
  latitude: number;
  longitude: number;
  sizeMetres: number;
}

export const DEFAULT_OSM_SCENE_OPTIONS: OsmSceneOptions = {
  longitude: 18.34344407408825,
  latitude: 48.73275071557837,
  sizeMetres: 1000,
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

type GeographicAnchor = {
  longitude: number;
  latitude: number;
  height: number;
};

export interface OsmSceneStats {
  source: string;
  fetchedAt: string;
  bbox: readonly [number, number, number, number];
  waysImported: number;
  roadSegments: number;
  namedRoads: string[];
  totalLengthMetres: number;
  highwayCounts: Record<string, number>;
}

export interface OsmSceneResult {
  scene: CanonicalScene;
  stats: OsmSceneStats;
}

export async function buildOsmScene(input: Partial<OsmSceneOptions> = {}): Promise<OsmSceneResult> {
  const options = normalizeOptions(input);
  const anchor: GeographicAnchor = {
    longitude: options.longitude,
    latitude: options.latitude,
    height: 0,
  };
  const halfExtentMetres = options.sizeMetres / 2;
  const bbox = buildBbox(anchor, halfExtentMetres);
  const bboxText = bbox.join(',');
  const response = await fetch(`/api/osm?bbox=${encodeURIComponent(bboxText)}`);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OSM request failed (${response.status}): ${text.slice(0, 220)}`);
  }

  const payload = (await response.json()) as ProxyResponse;
  const nodes = new Map<number, LocalPoint>();

  for (const element of payload.data.elements) {
    if (element.type !== 'node') continue;
    const node = element as OsmNode;
    nodes.set(node.id, geographicToLocal(node.lon, node.lat, anchor));
  }

  const positions: number[] = [];
  const indices: number[] = [];
  const namedRoads = new Set<string>();
  const highwayCounts: Record<string, number> = {};
  let waysImported = 0;
  let roadSegments = 0;
  let totalLengthMetres = 0;

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

    for (const polyline of polylines) {
      if (polyline.length < 2) continue;
      const result = appendRoadStrip(positions, indices, polyline, width);
      if (result.segments === 0) continue;
      roadSegments += result.segments;
      totalLengthMetres += result.length;
      wayAdded = true;
    }

    if (!wayAdded) continue;
    waysImported += 1;
    highwayCounts[highway] = (highwayCounts[highway] ?? 0) + 1;
    if (tags.name) namedRoads.add(tags.name);
  }

  if (roadSegments === 0) throw new Error('No driveable OSM highway geometry was found in the selected area.');

  const terrain = buildTerrainMesh(halfExtentMetres, options.sizeMetres);
  const road: CanonicalMesh = {
    id: 'roads-osm-live',
    role: 'road',
    materialId: 'road-osm',
    positions,
    indices,
  };

  const scene: CanonicalScene = {
    id: buildSceneId(options),
    schemaVersion: '0.1.0',
    coordinateSystem: {
      handedness: 'right',
      upAxis: 'Z',
      units: 'metres',
      localFrame: 'ENU',
    },
    anchor,
    materials: [
      { id: 'terrain-preview', name: 'Procedural terrain preview', color: [0.16, 0.42, 0.24, 1] },
      { id: 'road-osm', name: 'OpenStreetMap roads', color: [1, 0.08, 0.58, 1] },
    ],
    meshes: [terrain, road],
    spawns: [buildSpawn(positions)],
  };

  return {
    scene,
    stats: {
      source: payload.source,
      fetchedAt: payload.fetchedAt,
      bbox,
      waysImported,
      roadSegments,
      namedRoads: [...namedRoads].sort((a, b) => a.localeCompare(b)),
      totalLengthMetres,
      highwayCounts,
    },
  };
}

function normalizeOptions(input: Partial<OsmSceneOptions>): OsmSceneOptions {
  const options = { ...DEFAULT_OSM_SCENE_OPTIONS, ...input };
  if (!Number.isFinite(options.latitude) || options.latitude < -85 || options.latitude > 85) {
    throw new Error('Latitude must be between -85 and 85 degrees.');
  }
  if (!Number.isFinite(options.longitude) || options.longitude < -180 || options.longitude > 180) {
    throw new Error('Longitude must be between -180 and 180 degrees.');
  }
  if (!Number.isFinite(options.sizeMetres) || options.sizeMetres < 250 || options.sizeMetres > 2000) {
    throw new Error('Area size must be between 250 and 2000 metres.');
  }
  return options;
}

function buildBbox(
  anchor: GeographicAnchor,
  halfExtentMetres: number,
): readonly [number, number, number, number] {
  const metresPerDegreeLatitude = 111_320;
  const longitudeScale = metresPerDegreeLatitude * Math.max(0.05, Math.cos((anchor.latitude * Math.PI) / 180));
  const latitudeDelta = halfExtentMetres / metresPerDegreeLatitude;
  const longitudeDelta = halfExtentMetres / longitudeScale;
  return [
    anchor.longitude - longitudeDelta,
    anchor.latitude - latitudeDelta,
    anchor.longitude + longitudeDelta,
    anchor.latitude + latitudeDelta,
  ];
}

function buildSceneId(options: OsmSceneOptions): string {
  const latitude = coordinateToken(options.latitude);
  const longitude = coordinateToken(options.longitude);
  return `triworld-osm-${latitude}-${longitude}-${Math.round(options.sizeMetres)}m`;
}

function coordinateToken(value: number): string {
  return value.toFixed(5).replace('-', 'm').replace('.', 'p');
}

function buildTerrainMesh(halfExtentMetres: number, sizeMetres: number): CanonicalMesh {
  const gridSize = 81;
  const step = (halfExtentMetres * 2) / (gridSize - 1);
  const positions: number[] = [];
  const indices: number[] = [];

  for (let row = 0; row < gridSize; row++) {
    for (let column = 0; column < gridSize; column++) {
      const x = -halfExtentMetres + column * step;
      const y = -halfExtentMetres + row * step;
      positions.push(x, y, terrainHeight(x, y));
    }
  }

  for (let row = 0; row < gridSize - 1; row++) {
    for (let column = 0; column < gridSize - 1; column++) {
      const a = row * gridSize + column;
      const b = a + 1;
      const c = a + gridSize;
      const d = c + 1;
      indices.push(a, b, d, a, d, c);
    }
  }

  return {
    id: `terrain-procedural-${Math.round(sizeMetres)}m`,
    role: 'terrain',
    materialId: 'terrain-preview',
    positions,
    indices,
  };
}

function appendRoadStrip(
  positions: number[],
  indices: number[],
  points: LocalPoint[],
  width: number,
): { segments: number; length: number } {
  const startVertex = positions.length / 3;
  const halfWidth = width / 2;
  let length = 0;

  for (let index = 0; index < points.length; index++) {
    const previous = points[Math.max(0, index - 1)];
    const current = points[index];
    const next = points[Math.min(points.length - 1, index + 1)];
    const tangentX = next.x - previous.x;
    const tangentY = next.y - previous.y;
    const tangentLength = Math.hypot(tangentX, tangentY) || 1;
    const normalX = -tangentY / tangentLength;
    const normalY = tangentX / tangentLength;
    const z = terrainHeight(current.x, current.y) + 0.42;

    positions.push(
      current.x + normalX * halfWidth,
      current.y + normalY * halfWidth,
      z,
      current.x - normalX * halfWidth,
      current.y - normalY * halfWidth,
      z,
    );

    if (index > 0) length += distance(points[index - 1], current);
  }

  let segments = 0;
  for (let index = 0; index < points.length - 1; index++) {
    const left = startVertex + index * 2;
    const right = left + 1;
    const nextLeft = left + 2;
    const nextRight = left + 3;

    if (distance(points[index], points[index + 1]) < 0.05) continue;
    indices.push(left, right, nextRight, left, nextRight, nextLeft);
    segments += 1;
  }

  return { segments, length };
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

function geographicToLocal(longitude: number, latitude: number, anchor: GeographicAnchor): LocalPoint {
  const metresPerDegreeLatitude = 111_320;
  const metresPerDegreeLongitude = metresPerDegreeLatitude * Math.cos((anchor.latitude * Math.PI) / 180);
  return {
    x: (longitude - anchor.longitude) * metresPerDegreeLongitude,
    y: (latitude - anchor.latitude) * metresPerDegreeLatitude,
  };
}

function terrainHeight(x: number, y: number): number {
  const broad = Math.sin(x * 0.0062) * 8.5 + Math.cos(y * 0.0054) * 7.2;
  const secondary = Math.sin((x + y) * 0.012) * 2.4 + Math.cos((x - y) * 0.009) * 1.8;
  const basin = -5.5 * Math.exp(-((x + 120) ** 2 + (y - 80) ** 2) / 150_000);
  return broad + secondary + basin;
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

function buildSpawn(roadPositions: number[]): { id: string; position: Vec3; headingDegrees: number } {
  if (roadPositions.length >= 6) {
    const x = (roadPositions[0] + roadPositions[3]) / 2;
    const y = (roadPositions[1] + roadPositions[4]) / 2;
    const z = Math.max(roadPositions[2], roadPositions[5]) + 2.8;
    return { id: 'spawn-osm-first-road', position: [x, y, z], headingDegrees: 0 };
  }
  return { id: 'spawn-centre', position: [0, 0, terrainHeight(0, 0) + 3], headingDegrees: 0 };
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
