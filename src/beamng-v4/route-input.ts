import fs from 'node:fs';
import path from 'node:path';
import type { Wgs84Point } from './geodetic-transformer';

export interface RouteWaypoint extends Wgs84Point {
  altitude: number;
}

export interface RouteDefinition {
  name: string;
  closed: true;
  points: RouteWaypoint[];
  roadWidth?: number;
  shoulderWidth?: number;
  maximumGrade?: number;
  maximumBank?: number;
  designSpeedKmh?: number;
  stationSpacing?: number;
  minimumBlendWidth?: number;
  maximumBlendWidth?: number;
}

interface RouteJsonShape {
  name?: unknown;
  closed?: unknown;
  points?: unknown;
  roadWidth?: unknown;
  shoulderWidth?: unknown;
  maximumGrade?: unknown;
  maximumBank?: unknown;
  designSpeedKmh?: unknown;
  stationSpacing?: unknown;
  minimumBlendWidth?: unknown;
  maximumBlendWidth?: unknown;
}

export function loadRouteDefinition(filePath: string): RouteDefinition {
  const absolutePath = path.resolve(filePath);
  const text = fs.readFileSync(absolutePath, 'utf8');
  return parseRouteDefinition(text, path.basename(filePath, path.extname(filePath)));
}

export function parseRouteDefinition(text: string, fallbackName = 'custom_route'): RouteDefinition {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid route JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (isGeoJson(raw)) return parseGeoJson(raw, fallbackName);
  if (!isRecord(raw)) throw new Error('Route input must be a JSON object or GeoJSON Feature');
  return parseNativeRoute(raw as RouteJsonShape, fallbackName);
}

function parseNativeRoute(raw: RouteJsonShape, fallbackName: string): RouteDefinition {
  if (raw.closed === false) {
    throw new Error('Gate 4 currently requires a closed route; set "closed": true');
  }
  if (!Array.isArray(raw.points)) throw new Error('Route input requires a points array');
  const points = raw.points.map((point, index) => parsePoint(point, `points[${index}]`));
  validatePointCount(points);

  return {
    name: normaliseName(typeof raw.name === 'string' ? raw.name : fallbackName),
    closed: true,
    points: removeDuplicateClosure(points),
    roadWidth: optionalNumber(raw.roadWidth, 'roadWidth', 4, 14),
    shoulderWidth: optionalNumber(raw.shoulderWidth, 'shoulderWidth', 0.5, 5),
    maximumGrade: optionalNumber(raw.maximumGrade, 'maximumGrade', 0.03, 0.18),
    maximumBank: optionalNumber(raw.maximumBank, 'maximumBank', 0, 0.08),
    designSpeedKmh: optionalNumber(raw.designSpeedKmh, 'designSpeedKmh', 20, 100),
    stationSpacing: optionalNumber(raw.stationSpacing, 'stationSpacing', 2, 8),
    minimumBlendWidth: optionalNumber(raw.minimumBlendWidth, 'minimumBlendWidth', 8, 35),
    maximumBlendWidth: optionalNumber(raw.maximumBlendWidth, 'maximumBlendWidth', 12, 90),
  };
}

function parseGeoJson(raw: Record<string, unknown>, fallbackName: string): RouteDefinition {
  const feature = raw.type === 'Feature' ? raw : null;
  const geometry = feature ? feature.geometry : raw;
  if (!isRecord(geometry)) throw new Error('GeoJSON route requires a geometry object');
  const geometryType = geometry.type;
  const coordinates = geometry.coordinates;

  let line: unknown;
  if (geometryType === 'LineString') line = coordinates;
  else if (geometryType === 'Polygon' && Array.isArray(coordinates)) line = coordinates[0];
  else throw new Error(`Unsupported GeoJSON geometry: ${String(geometryType)}; use LineString or Polygon`);

  if (!Array.isArray(line)) throw new Error('GeoJSON geometry has no coordinate array');
  const points = line.map((coordinate, index) => parseGeoJsonCoordinate(coordinate, index));
  validatePointCount(points);
  const properties = feature && isRecord(feature.properties) ? feature.properties : {};

  return {
    name: normaliseName(
      typeof properties.name === 'string'
        ? properties.name
        : typeof raw.name === 'string'
          ? raw.name
          : fallbackName,
    ),
    closed: true,
    points: removeDuplicateClosure(points),
    roadWidth: optionalNumber(properties.roadWidth, 'roadWidth', 4, 14),
    shoulderWidth: optionalNumber(properties.shoulderWidth, 'shoulderWidth', 0.5, 5),
    maximumGrade: optionalNumber(properties.maximumGrade, 'maximumGrade', 0.03, 0.18),
    maximumBank: optionalNumber(properties.maximumBank, 'maximumBank', 0, 0.08),
    designSpeedKmh: optionalNumber(properties.designSpeedKmh, 'designSpeedKmh', 20, 100),
    stationSpacing: optionalNumber(properties.stationSpacing, 'stationSpacing', 2, 8),
    minimumBlendWidth: optionalNumber(properties.minimumBlendWidth, 'minimumBlendWidth', 8, 35),
    maximumBlendWidth: optionalNumber(properties.maximumBlendWidth, 'maximumBlendWidth', 12, 90),
  };
}

function parsePoint(raw: unknown, label: string): RouteWaypoint {
  if (Array.isArray(raw)) return parseGeoJsonCoordinate(raw, label);
  if (!isRecord(raw)) throw new Error(`${label} must be an object or [longitude, latitude] tuple`);
  const longitude = requiredNumber(raw.longitude ?? raw.lon ?? raw.lng, `${label}.longitude`);
  const latitude = requiredNumber(raw.latitude ?? raw.lat, `${label}.latitude`);
  const altitude = optionalAltitude(raw.altitude ?? raw.alt ?? raw.elevation);
  validateWgs84(longitude, latitude, label);
  return { longitude, latitude, altitude };
}

function parseGeoJsonCoordinate(raw: unknown, index: number | string): RouteWaypoint {
  const label = typeof index === 'number' ? `coordinates[${index}]` : String(index);
  if (!Array.isArray(raw) || raw.length < 2) {
    throw new Error(`${label} must be [longitude, latitude, optional altitude]`);
  }
  const longitude = requiredNumber(raw[0], `${label}[0]`);
  const latitude = requiredNumber(raw[1], `${label}[1]`);
  const altitude = optionalAltitude(raw[2]);
  validateWgs84(longitude, latitude, label);
  return { longitude, latitude, altitude };
}

function validatePointCount(points: RouteWaypoint[]): void {
  const unique = removeDuplicateClosure(points);
  if (unique.length < 4) throw new Error('Closed route requires at least four unique points');
}

function removeDuplicateClosure(points: RouteWaypoint[]): RouteWaypoint[] {
  if (points.length < 2) return points;
  const first = points[0];
  const last = points[points.length - 1];
  if (Math.abs(first.longitude - last.longitude) < 1e-10
    && Math.abs(first.latitude - last.latitude) < 1e-10) {
    return points.slice(0, -1);
  }
  return points;
}

function optionalNumber(
  raw: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = requiredNumber(raw, label);
  if (value < minimum || value > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}; got ${value}`);
  }
  return value;
}

function optionalAltitude(raw: unknown): number {
  if (raw === undefined || raw === null) return 0;
  return requiredNumber(raw, 'altitude');
}

function requiredNumber(raw: unknown, label: string): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new Error(`${label} must be a finite number`);
  return raw;
}

function validateWgs84(longitude: number, latitude: number, label: string): void {
  if (longitude < -180 || longitude > 180) throw new Error(`${label} longitude is outside WGS84 bounds`);
  if (latitude < -90 || latitude > 90) throw new Error(`${label} latitude is outside WGS84 bounds`);
}

function normaliseName(name: string): string {
  const normalised = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return normalised || 'custom_route';
}

function isGeoJson(raw: unknown): raw is Record<string, unknown> {
  return isRecord(raw) && (raw.type === 'Feature' || raw.type === 'LineString' || raw.type === 'Polygon');
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}
