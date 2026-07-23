/**
 * High-Resolution Real-World GIS Satellite Orthophoto Generator — TriWorld V4 Gate 2
 * Fetches real ESRI World Imagery satellite orthophoto for Bánovce nad Bebravou bounding box.
 */

import { GeodeticTransformer, BANOVCE_ORIGIN_WGS84 } from './geodetic-transformer';
import { generateCustomPng, generateSolidPng } from './texture-generator';

export interface OrthoGeneratorOptions {
  sizeMetres?: number;
  textureSize?: number;
  transformer?: GeodeticTransformer;
}

export interface OrthoGeneratorResult {
  diffusePng: Uint8Array;
  normalPng: Uint8Array;
  width: number;
  height: number;
  isRealSatellite: boolean;
}

/**
 * Fetches real ESRI World Imagery satellite orthophoto for the exact geodetic bounding box of Bánovce nad Bebravou.
 */
export async function fetchRealBanovceOrthophoto(options: OrthoGeneratorOptions = {}): Promise<OrthoGeneratorResult> {
  const sizeMetres = options.sizeMetres ?? 1024;
  const textureSize = options.textureSize ?? 1024;
  const transformer = options.transformer ?? new GeodeticTransformer(BANOVCE_ORIGIN_WGS84, sizeMetres);

  // Exact WGS84 Bounding Box for the 1024m x 1024m local grid
  const swWgs = transformer.localToWgs84({ x: 0, y: 0, z: 0 });
  const neWgs = transformer.localToWgs84({ x: sizeMetres, y: sizeMetres, z: 0 });

  const minLon = swWgs.longitude;
  const minLat = swWgs.latitude;
  const maxLon = neWgs.longitude;
  const maxLat = neWgs.latitude;

  // ESRI World Imagery MapServer Export URL
  const esriUrl = new URL('https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/export');
  esriUrl.searchParams.set('bbox', `${minLon},${minLat},${maxLon},${maxLat}`);
  esriUrl.searchParams.set('bboxSR', '4326');
  esriUrl.searchParams.set('imageSR', '4326');
  esriUrl.searchParams.set('size', `${textureSize},${textureSize}`);
  esriUrl.searchParams.set('format', 'png');
  esriUrl.searchParams.set('f', 'image');

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(esriUrl.toString(), { signal: controller.signal });
    clearTimeout(timeout);

    if (res.ok) {
      const buffer = new Uint8Array(await res.arrayBuffer());
      // Check PNG signature: [137, 80, 78, 71, 13, 10, 26, 10]
      if (buffer.length > 50000 && buffer[0] === 137 && buffer[1] === 80) {
        const normalPng = generateSolidPng(textureSize, textureSize, 128, 128, 255);
        return {
          diffusePng: buffer,
          normalPng,
          width: textureSize,
          height: textureSize,
          isRealSatellite: true,
        };
      }
    }
  } catch (e) {
    console.warn('Real satellite orthophoto fetch failed or timed out, falling back to local generator:', e);
  }

  // Fallback to local procedural orthophoto
  return {
    ...generateProceduralOrthophoto(textureSize, textureSize),
    isRealSatellite: false,
  };
}

export function generateProceduralOrthophoto(width: number = 1024, height: number = 1024): { diffusePng: Uint8Array; normalPng: Uint8Array; width: number; height: number } {
  const diffusePng = generateCustomPng(width, height, (px, py) => {
    const u = (px / (width - 1)) * 1024;
    const v = ((height - 1 - py) / (height - 1)) * 1024;

    const fieldPattern = Math.sin(u * 0.015) * Math.cos(v * 0.015);
    let r = fieldPattern > 0 ? 80 : 95;
    let g = fieldPattern > 0 ? 125 : 140;
    let b = fieldPattern > 0 ? 55 : 65;

    const riverX = 560 + 40 * Math.sin(v * 0.008);
    const riverDist = Math.abs(u - riverX);
    if (riverDist < 12) {
      r = 45; g = 115; b = 165;
    } else if (riverDist < 20) {
      r = 135; g = 125; b = 100;
    }

    const roadY = 480 + 20 * Math.sin(u * 0.005);
    const roadDist = Math.abs(v - roadY);
    if (roadDist < 8) {
      r = 60; g = 60; b = 65;
      if (roadDist < 0.6 && (Math.floor(u / 8) % 2 === 0)) {
        r = 230; g = 230; b = 230;
      }
    }

    return [r, g, b];
  });

  const normalPng = generateSolidPng(width, height, 128, 128, 255);
  return { diffusePng, normalPng, width, height };
}
