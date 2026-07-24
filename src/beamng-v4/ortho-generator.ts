/**
 * High-Resolution Real-World GIS Satellite Orthophoto Generator — TriWorld V4 Gate 2
 * Fetches real ESRI World Imagery satellite orthophoto for Bánovce nad Bebravou bounding box
 * and flips image vertically to align 1:1 with Torque3D / BeamNG terrain UVs.
 */

import { GeodeticTransformer, BANOVCE_ORIGIN_WGS84 } from './geodetic-transformer';
import { generateCustomPng, generateSolidPng } from './texture-generator';
import { PNG } from 'pngjs';

export interface OrthoGeneratorOptions {
  sizeMetres?: number;
  textureSize?: number;
  transformer?: GeodeticTransformer;
  corridorPriorityBuffer?: Uint8Array;
}

export interface OrthoGeneratorResult {
  diffusePng: Uint8Array;
  normalPng: Uint8Array;
  width: number;
  height: number;
  isRealSatellite: boolean;
}

/**
 * Flips raw RGB pixel buffer vertically so row 0 (top/North) becomes row H-1 (bottom/South).
 */
export function flipRgbVertically(rgbBuffer: Uint8Array, width: number, height: number): Uint8Array {
  const flipped = new Uint8Array(rgbBuffer.length);
  const rowBytes = width * 3;
  for (let r = 0; r < height; r++) {
    const srcRow = r * rowBytes;
    const dstRow = (height - 1 - r) * rowBytes;
    flipped.set(rgbBuffer.subarray(srcRow, srcRow + rowBytes), dstRow);
  }
  return flipped;
}

/**
 * Parses raw uncompressed RGB pixels from simple uncompressed PNG or raw buffer if available.
 * For ESRI World Imagery PNG, we can use PNG row flip or canvas flip.
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
  // Note: bboxSR=4326, imageSR=4326
  const esriUrl = new URL('https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/export');
  esriUrl.searchParams.set('bbox', `${minLon},${minLat},${maxLon},${maxLat}`);
  esriUrl.searchParams.set('bboxSR', '4326');
  esriUrl.searchParams.set('imageSR', '4326');
  esriUrl.searchParams.set('size', `${textureSize},${textureSize}`);
  esriUrl.searchParams.set('format', 'png');
  esriUrl.searchParams.set('f', 'image');

  const maxAttempts = 3;
  const baseTimeoutMs = 60000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), baseTimeoutMs);

      const res = await fetch(esriUrl.toString(), { signal: controller.signal });
      clearTimeout(timeout);

      if (res.ok) {
        const buffer = new Uint8Array(await res.arrayBuffer());
        if (buffer.length > 50000 && buffer[0] === 137 && buffer[1] === 80) {
          const decoded = PNG.sync.read(Buffer.from(buffer));
          const w = decoded.width;
          const h = decoded.height;

          const sanitized = new PNG({
            width: w,
            height: h,
            colorType: 6,
            bitDepth: 8,
            inputHasAlpha: true,
          });

          // Rotate 180 degrees (flip both horizontally and vertically) to align with BeamNG UVs
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              const srcIdx = (y * w + x) * 4;
              const dstX = w - 1 - x;
              const dstY = h - 1 - y;
              const dstIdx = (dstY * w + dstX) * 4;

              sanitized.data[dstIdx + 0] = decoded.data[srcIdx + 0];
              sanitized.data[dstIdx + 1] = decoded.data[srcIdx + 1];
              sanitized.data[dstIdx + 2] = decoded.data[srcIdx + 2];
              sanitized.data[dstIdx + 3] = 255;
            }
          }

          const finalDiffusePng = new Uint8Array(PNG.sync.write(sanitized));

          return {
            diffusePng: finalDiffusePng,
            normalPng: generateSolidPng(w, h, 128, 128, 255),
            width: w,
            height: h,
            isRealSatellite: true,
          };
        }
      } else {
        console.warn(`Orthophoto fetch attempt ${attempt}/${maxAttempts} failed: HTTP ${res.status} ${res.statusText}`);
      }
    } catch (e: unknown) {
      const err = e as Error & { name?: string; cause?: unknown };
      const reason = err.name === 'AbortError' ? 'timeout (60s)' : err.message ?? String(e);
      console.warn(`Orthophoto fetch attempt ${attempt}/${maxAttempts} failed: ${reason}`);
    }

    if (attempt < maxAttempts) {
      const delayMs = 1000 * attempt;
      console.log(`Retrying orthophoto fetch in ${delayMs}ms...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  throw new Error('Gate 4 rejected: Satellite orthophoto download failed after 3 attempts.');
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
