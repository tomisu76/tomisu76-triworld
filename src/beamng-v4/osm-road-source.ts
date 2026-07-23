import { createHash } from 'node:crypto';
import { clipRoadWayToBoundsV2 } from '../pipeline-v2/roads/road-clip-v2';
import type { Vec2 } from '../pipeline-v3/sumo/SumoGeometryV3';
import type { GeodeticTransformer } from './geodetic-transformer';

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

export interface OsmMapPayload {
  elements: OsmElement[];
}

export interface OsmRoadAlignment {
  sourceType: 'osm-api-v0.6';
  sourceUrl: string;
  wayId: number;
  fragmentIndex: number;
  highway: string;
  name?: string;
  laneWidthMetres: number;
  pointsCentered: Vec2[];
  pointCount: number;
  lengthMetres: number;
  minimumDistanceToCentreMetres: number;
  boundsCentered: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  };
  sha256: string;
}

export interface OsmRoadSourceOptions {
  minimumLengthMetres?: number;
  minimumInsetMetres?: number;
  timeoutMilliseconds?: number;
}

const DRIVEABLE_HIGHWAYS = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'residential',
  'living_street', 'unclassified', 'service', 'track', 'road',
]);

const HIGHWAY_RANK: Record<string, number> = {
  motorway: 12,
  motorway_link: 11,
  trunk: 10,
  trunk_link: 9,
  primary: 8,
  primary_link: 7,
  secondary: 6,
  secondary_link: 5,
  tertiary: 4,
  tertiary_link: 3,
  residential: 2,
  living_street: 2,
  unclassified: 1,
  service: 0,
  track: -1,
  road: 0,
};

export async function fetchPrimaryOsmRoadAlignment(
  transformer: GeodeticTransformer,
  options: OsmRoadSourceOptions = {},
): Promise<OsmRoadAlignment> {
  const southWest = transformer.localToWgs84({ x: 0, y: 0, z: 0 });
  const northEast = transformer.localToWgs84({
    x: transformer.origin.sizeMetres,
    y: transformer.origin.sizeMetres,
    z: 0,
  });

  const bbox = [
    Math.min(southWest.longitude, northEast.longitude),
    Math.min(southWest.latitude, northEast.latitude),
    Math.max(southWest.longitude, northEast.longitude),
    Math.max(southWest.latitude, northEast.latitude),
  ];

  const sourceUrl = new URL('https://api.openstreetmap.org/api/0.6/map.json');
  sourceUrl.searchParams.set('bbox', bbox.join(','));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMilliseconds ?? 20_000);

  try {
    const response = await fetch(sourceUrl, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'TriWorld/0.6 BeamNG-native Gate3 verifier',
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OSM road request failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const payload = await response.json() as OsmMapPayload;
    return selectPrimaryOsmRoadAlignment(payload, transformer, {
      ...options,
      sourceUrl: sourceUrl.toString(),
    });
  } finally {
    clearTimeout(timeout);
  }
}

interface SelectionOptions extends OsmRoadSourceOptions {
  sourceUrl?: string;
}

export function selectPrimaryOsmRoadAlignment(
  payload: OsmMapPayload,
  transformer: GeodeticTransformer,
  options: SelectionOptions = {},
): OsmRoadAlignment {
  const minimumLengthMetres = options.minimumLengthMetres ?? 50;
  const minimumInsetMetres = options.minimumInsetMetres ?? 10;
  const halfExtent = transformer.origin.sizeMetres / 2;
  const nodes = new Map<number, OsmNode>();

  for (const element of payload.elements) {
    if (element.type === 'node') nodes.set(element.id, element as OsmNode);
  }

  const candidates: Array<OsmRoadAlignment & { score: number }> = [];

  for (const element of payload.elements) {
    if (element.type !== 'way') continue;
    const way = element as OsmWay;
    const tags = way.tags ?? {};
    const highway = tags.highway;
    if (!highway || !DRIVEABLE_HIGHWAYS.has(highway) || tags.area === 'yes') continue;

    const laneWidthMetres = roadWidth(tags, highway);
    const safeInset = Math.max(minimumInsetMetres, laneWidthMetres / 2 + 2);
    const safeHalfExtent = halfExtent - safeInset;
    if (safeHalfExtent <= 0) {
      throw new RangeError(`Road inset ${safeInset}m leaves no valid terrain domain.`);
    }

    const centeredPoints = way.nodes
      .map((nodeId) => nodes.get(nodeId))
      .filter((node): node is OsmNode => node !== undefined)
      .map((node) => transformer.wgs84ToLocal({
        longitude: node.lon,
        latitude: node.lat,
        altitude: 0,
      }))
      .map((point) => ({ x: point.x - halfExtent, y: point.y - halfExtent }));

    if (centeredPoints.length < 2) continue;

    const fragments = clipRoadWayToBoundsV2(centeredPoints, safeHalfExtent);
    for (let fragmentIndex = 0; fragmentIndex < fragments.length; fragmentIndex++) {
      const pointsCentered = removeConsecutiveDuplicates(fragments[fragmentIndex]);
      if (pointsCentered.length < 2) continue;

      const lengthMetres = polylineLength(pointsCentered);
      if (lengthMetres < minimumLengthMetres) continue;

      const minimumDistanceToCentreMetres = minimumDistanceToPolyline({ x: 0, y: 0 }, pointsCentered);
      const rank = HIGHWAY_RANK[highway] ?? 0;
      const score = rank * 10_000 - minimumDistanceToCentreMetres * 1_000 + lengthMetres;
      const boundsCentered = boundsOf(pointsCentered);
      const sha256 = hashRoadAlignment({
        wayId: way.id,
        fragmentIndex,
        highway,
        name: tags.name,
        laneWidthMetres,
        pointsCentered,
      });

      candidates.push({
        sourceType: 'osm-api-v0.6',
        sourceUrl: options.sourceUrl ?? 'fixture://osm-map-payload',
        wayId: way.id,
        fragmentIndex,
        highway,
        name: tags.name,
        laneWidthMetres,
        pointsCentered,
        pointCount: pointsCentered.length,
        lengthMetres,
        minimumDistanceToCentreMetres,
        boundsCentered,
        sha256,
        score,
      });
    }
  }

  candidates.sort((a, b) =>
    b.score - a.score || a.wayId - b.wayId || a.fragmentIndex - b.fragmentIndex,
  );

  const selected = candidates[0];
  if (!selected) {
    throw new Error('No valid driveable OSM road alignment intersects the Gate 3 terrain domain.');
  }

  const { score: _score, ...alignment } = selected;
  return alignment;
}

function roadWidth(tags: OsmTags, highway: string): number {
  const baseWidths: Record<string, number> = {
    motorway: 14,
    motorway_link: 7,
    trunk: 12,
    trunk_link: 7,
    primary: 10,
    primary_link: 6.5,
    secondary: 9,
    secondary_link: 6,
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
  const widthFromLanes = Number.isFinite(lanes) && lanes > 0 ? lanes * 3.15 : 0;
  return Math.max(baseWidths[highway] ?? 5.5, widthFromLanes);
}

function removeConsecutiveDuplicates(points: readonly Vec2[]): Vec2[] {
  const result: Vec2[] = [];
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new Error(`OSM road contains a non-finite point (${point.x}, ${point.y}).`);
    }
    const previous = result[result.length - 1];
    if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) >= 0.02) {
      result.push({ x: point.x, y: point.y });
    }
  }
  return result;
}

function polylineLength(points: readonly Vec2[]): number {
  let length = 0;
  for (let index = 1; index < points.length; index++) {
    length += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
  }
  return length;
}

function minimumDistanceToPolyline(point: Vec2, polyline: readonly Vec2[]): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 0; index < polyline.length - 1; index++) {
    minimum = Math.min(minimum, distanceToSegment(point, polyline[index], polyline[index + 1]));
  }
  return minimum;
}

function distanceToSegment(point: Vec2, start: Vec2, end: Vec2): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 1e-12) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function boundsOf(points: readonly Vec2[]): OsmRoadAlignment['boundsCentered'] {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { minX, minY, maxX, maxY };
}

function hashRoadAlignment(value: {
  wayId: number;
  fragmentIndex: number;
  highway: string;
  name?: string;
  laneWidthMetres: number;
  pointsCentered: readonly Vec2[];
}): string {
  const normalized = {
    ...value,
    laneWidthMetres: roundMillimetres(value.laneWidthMetres),
    pointsCentered: value.pointsCentered.map((point) => ({
      x: roundMillimetres(point.x),
      y: roundMillimetres(point.y),
    })),
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function roundMillimetres(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
