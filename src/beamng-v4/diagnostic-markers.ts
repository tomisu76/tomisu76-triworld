/**
 * Diagnostic Markers Generator — TriWorld V4 Gate 1
 * Emits visual orientation and geodetic reference markers into items.level.json.
 */

import { GeodeticTransformer } from './geodetic-transformer';

export interface LevelMarker {
  name: string;
  class: string;
  __parent: string;
  position: [number, number, number];
  rotationMatrix?: number[];
  scale?: [number, number, number];
  dataBlock?: string;
  description?: string;
  utmEasting?: number;
  utmNorthing?: number;
  wgs84Lat?: number;
  wgs84Lon?: number;
}

export function generateDiagnosticMarkers(
  transformer: GeodeticTransformer,
  sampleElevation: (x: number, y: number) => number
): LevelMarker[] {
  const size = transformer.origin.sizeMetres;
  const half = size / 2;

  const markers: LevelMarker[] = [];

  // 1. Center Spawn Point (spawns_default)
  const zCenter = sampleElevation(half, half);
  const centerUtm = transformer.localToUtm({ x: half, y: half, z: zCenter });
  const centerWgs = transformer.localToWgs84({ x: half, y: half, z: zCenter });

  markers.push({
    name: 'spawns_default',
    class: 'SpawnSphere',
    __parent: 'MissionGroup',
    position: [half, half, zCenter + 2.0],
    rotationMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    scale: [1, 1, 1],
    dataBlock: 'SpawnSphereMarker',
    description: 'Level Center Spawn Point (Bánovce Center)',
    utmEasting: centerUtm.easting,
    utmNorthing: centerUtm.northing,
    wgs84Lat: centerWgs.latitude,
    wgs84Lon: centerWgs.longitude,
  });

  // 2. North Orientation Marker (pointing +Y North)
  const zNorth = sampleElevation(half, size - 20);
  const northUtm = transformer.localToUtm({ x: half, y: size - 20, z: zNorth });
  const northWgs = transformer.localToWgs84({ x: half, y: size - 20, z: zNorth });

  markers.push({
    name: 'Marker_North_Arrow',
    class: 'SpawnSphere',
    __parent: 'MissionGroup',
    position: [half, size - 20, zNorth + 3.0],
    scale: [2, 2, 2],
    dataBlock: 'SpawnSphereMarker',
    description: 'North Diagnostic Indicator (+Y Direction)',
    utmEasting: northUtm.easting,
    utmNorthing: northUtm.northing,
    wgs84Lat: northWgs.latitude,
    wgs84Lon: northWgs.longitude,
  });

  // 3. Corner Geodetic Reference Markers (SW, SE, NW, NE)
  const corners = [
    { label: 'SW', x: 10, y: 10 },
    { label: 'SE', x: size - 10, y: 10 },
    { label: 'NW', x: 10, y: size - 10 },
    { label: 'NE', x: size - 10, y: size - 10 },
  ];

  for (const corner of corners) {
    const z = sampleElevation(corner.x, corner.y);
    const utm = transformer.localToUtm({ x: corner.x, y: corner.y, z });
    const wgs = transformer.localToWgs84({ x: corner.x, y: corner.y, z });

    markers.push({
      name: `Corner_Marker_${corner.label}`,
      class: 'SpawnSphere',
      __parent: 'MissionGroup',
      position: [corner.x, corner.y, z + 2.0],
      scale: [1, 1, 1],
      dataBlock: 'SpawnSphereMarker',
      description: `Corner Geodetic Marker ${corner.label}`,
      utmEasting: utm.easting,
      utmNorthing: utm.northing,
      wgs84Lat: wgs.latitude,
      wgs84Lon: wgs.longitude,
    });
  }

  return markers;
}
