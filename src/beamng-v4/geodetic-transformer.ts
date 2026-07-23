/**
 * Geodetic Coordinate Transformer — TriWorld V4 Gate 1
 * Handles bidirectional mapping:
 * Local BeamNG (x, y, z) <---> UTM Zone 34N (Easting, Northing, Elevation) <---> WGS84 (Lon, Lat, Alt)
 */

export interface Wgs84Point {
  longitude: number;
  latitude: number;
  altitude: number;
}

export interface UtmPoint {
  easting: number;
  northing: number;
  elevation: number;
  zone: number;
}

export interface LocalPoint {
  x: number;
  y: number;
  z: number;
}

export interface GeodeticOrigin {
  centerWgs84: Wgs84Point;
  centerUtm: UtmPoint;
  sizeMetres: number;
}

// Bánovce region target center location (WGS84)
export const BANOVCE_ORIGIN_WGS84: Wgs84Point = {
  longitude: 18.352620306978697,
  latitude: 48.72566288876834,
  altitude: 260.0, // Local elevation in metres
};

/**
 * WGS84 Ellipsoid constants (GRS80 / WGS84)
 */
const A = 6378137.0; // semi-major axis
const F = 1 / 298.257223563; // flattening
const E2 = 2 * F - F * F; // first eccentricity squared
const K0 = 0.9996; // UTM scale factor
const FALSE_EASTING = 500000.0;
const FALSE_NORTHING = 0.0;

/**
 * Direct WGS84 (lon, lat) to UTM Zone 34N (Easting, Northing)
 */
export function wgs84ToUtm34N(lon: number, lat: number, alt: number = 0): UtmPoint {
  const radLat = (lat * Math.PI) / 180;
  const radLon = (lon * Math.PI) / 180;
  const lon0 = (21 * Math.PI) / 180; // Central meridian for UTM Zone 34 (21° E)

  const N = A / Math.sqrt(1 - E2 * Math.sin(radLat) ** 2);
  const T = Math.tan(radLat) ** 2;
  const C = (E2 / (1 - E2)) * Math.cos(radLat) ** 2;
  const A_val = (radLon - lon0) * Math.cos(radLat);

  // Meridian arc length calculation
  const e4 = E2 * E2;
  const e6 = e4 * E2;
  const M = A * (
    (1 - E2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * radLat -
    ((3 * E2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * radLat) +
    (((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * radLat)) -
    ((35 * e6) / 3072) * Math.sin(6 * radLat)
  );

  const easting = FALSE_EASTING + K0 * N * (
    A_val +
    ((1 - T + C) * A_val ** 3) / 6 +
    ((5 - 18 * T + T ** 2 + 72 * C - 58 * E2) * A_val ** 5) / 120
  );

  const northing = FALSE_NORTHING + K0 * (
    M + N * Math.tan(radLat) * (
      (A_val ** 2) / 2 +
      ((5 - T + 9 * C + 4 * C ** 2) * A_val ** 4) / 24 +
      ((61 - 58 * T + T ** 2 + 600 * C - 330 * E2) * A_val ** 6) / 720
    )
  );

  return { easting, northing, elevation: alt, zone: 34 };
}

/**
 * Inverse UTM Zone 34N (Easting, Northing) to WGS84 (lon, lat)
 */
export function utm34NToWgs84(easting: number, northing: number, elevation: number = 0): Wgs84Point {
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const x = easting - FALSE_EASTING;
  const y = northing - FALSE_NORTHING;
  const M = y / K0;
  const mu = M / (A * (1 - E2 / 4 - (3 * (E2 ** 2)) / 64 - (5 * (E2 ** 3)) / 256));

  const phi1Rad = mu +
    ((3 * e1) / 2 - (27 * (e1 ** 3)) / 32) * Math.sin(2 * mu) +
    ((21 * (e1 ** 2)) / 16 - (55 * (e1 ** 4)) / 32) * Math.sin(4 * mu) +
    ((151 * (e1 ** 3)) / 96) * Math.sin(6 * mu) +
    ((1097 * (e1 ** 4)) / 512) * Math.sin(8 * mu);

  const N1 = A / Math.sqrt(1 - E2 * Math.sin(phi1Rad) ** 2);
  const T1 = Math.tan(phi1Rad) ** 2;
  const C1 = (E2 / (1 - E2)) * Math.cos(phi1Rad) ** 2;
  const R1 = (A * (1 - E2)) / (1 - E2 * Math.sin(phi1Rad) ** 2) ** 1.5;
  const D = x / (N1 * K0);

  const latRad = phi1Rad -
    ((N1 * Math.tan(phi1Rad)) / R1) * (
      (D ** 2) / 2 -
      ((5 + 3 * T1 + 10 * C1 - 4 * (C1 ** 2) - 9 * E2) * (D ** 4)) / 24 +
      ((61 + 90 * T1 + 298 * C1 + 45 * (T1 ** 2) - 252 * E2 - 3 * (C1 ** 2)) * (D ** 6)) / 720
    );

  const lon0Rad = (21 * Math.PI) / 180;
  const lonRad = lon0Rad +
    (
      D -
      ((1 + 2 * T1 + C1) * (D ** 3)) / 6 +
      ((5 - 2 * C1 + 28 * T1 - 3 * (C1 ** 2) + 8 * E2 + 24 * (T1 ** 2)) * (D ** 5)) / 120
    ) / Math.cos(phi1Rad);

  return {
    latitude: (latRad * 180) / Math.PI,
    longitude: (lonRad * 180) / Math.PI,
    altitude: elevation,
  };
}

/**
 * Geodetic Transformer Class
 * Maps local BeamNG coords [0..sizeMetres, 0..sizeMetres] to UTM / WGS84.
 * Invariant: Local (0,0) is SW corner (min Easting, min Northing).
 * Local (sizeMetres, sizeMetres) is NE corner (max Easting, max Northing).
 * Local (sizeMetres/2, sizeMetres/2) is Center (center WGS84 / UTM).
 */
export class GeodeticTransformer {
  public readonly origin: GeodeticOrigin;
  public readonly minUtm: UtmPoint;
  public readonly maxUtm: UtmPoint;

  constructor(centerWgs84: Wgs84Point = BANOVCE_ORIGIN_WGS84, sizeMetres: number = 1024) {
    const centerUtm = wgs84ToUtm34N(centerWgs84.longitude, centerWgs84.latitude, centerWgs84.altitude);
    const half = sizeMetres / 2;

    this.origin = {
      centerWgs84,
      centerUtm,
      sizeMetres,
    };

    this.minUtm = {
      easting: centerUtm.easting - half,
      northing: centerUtm.northing - half,
      elevation: centerUtm.elevation,
      zone: 34,
    };

    this.maxUtm = {
      easting: centerUtm.easting + half,
      northing: centerUtm.northing + half,
      elevation: centerUtm.elevation,
      zone: 34,
    };
  }

  /**
   * Local BeamNG (x, y, z) -> UTM (E, N, Z)
   */
  localToUtm(local: LocalPoint): UtmPoint {
    return {
      easting: this.minUtm.easting + local.x,
      northing: this.minUtm.northing + local.y,
      elevation: local.z,
      zone: 34,
    };
  }

  /**
   * UTM (E, N, Z) -> Local BeamNG (x, y, z)
   */
  utmToLocal(utm: UtmPoint): LocalPoint {
    return {
      x: utm.easting - this.minUtm.easting,
      y: utm.northing - this.minUtm.northing,
      z: utm.elevation,
    };
  }

  /**
   * Local BeamNG (x, y, z) -> WGS84 (lon, lat, alt)
   */
  localToWgs84(local: LocalPoint): Wgs84Point {
    const utm = this.localToUtm(local);
    return utm34NToWgs84(utm.easting, utm.northing, utm.elevation);
  }

  /**
   * WGS84 (lon, lat, alt) -> Local BeamNG (x, y, z)
   */
  wgs84ToLocal(wgs: Wgs84Point): LocalPoint {
    const utm = wgs84ToUtm34N(wgs.longitude, wgs.latitude, wgs.altitude);
    return this.utmToLocal(utm);
  }

  /**
   * Validates horizontal and vertical round-trip errors.
   */
  validateRoundTripError(local: LocalPoint): { horizontalErrorMetres: number; verticalErrorMetres: number } {
    const wgs = this.localToWgs84(local);
    const recovered = this.wgs84ToLocal(wgs);

    const dx = recovered.x - local.x;
    const dy = recovered.y - local.y;
    const dz = recovered.z - local.z;

    const horizontalErrorMetres = Math.sqrt(dx * dx + dy * dy);
    const verticalErrorMetres = Math.abs(dz);

    return { horizontalErrorMetres, verticalErrorMetres };
  }
}
