/**
 * High-Resolution GIS Orthophoto Generator — TriWorld V4 Gate 2
 * Generates orthophoto diffuse and normal maps for Bánovce nad Bebravou region.
 */

import { generateCustomPng } from './texture-generator';

export interface OrthoGeneratorResult {
  diffusePng: Uint8Array;
  normalPng: Uint8Array;
  width: number;
  height: number;
}

export function generateBanovceOrthophoto(width: number = 1024, height: number = 1024): OrthoGeneratorResult {
  const diffusePng = generateCustomPng(width, height, (px, py) => {
    // Local metres (u, v in [0, 1024])
    // Note: py = 0 is North (v = 1024), py = height-1 is South (v = 0)
    const u = (px / (width - 1)) * 1024;
    const v = ((height - 1 - py) / (height - 1)) * 1024;

    const dx = (u - 512) / 500;
    const dy = (v - 512) / 500;

    // 1. Base Agricultural / Meadow Field Colors
    const fieldPattern = Math.sin(u * 0.015) * Math.cos(v * 0.015);
    let r = fieldPattern > 0 ? 80 : 95;
    let g = fieldPattern > 0 ? 125 : 140;
    let b = fieldPattern > 0 ? 55 : 65;

    // 2. Bebrava Riverbed (flowing North to South with mild curve)
    const riverX = 560 + 40 * Math.sin(v * 0.008);
    const riverDist = Math.abs(u - riverX);
    if (riverDist < 12) {
      // River water
      r = 45; g = 115; b = 165;
    } else if (riverDist < 20) {
      // Riverbank gravel / sand
      r = 135; g = 125; b = 100;
    }

    // 3. I/9 Main Road Corridor (running East-West around v = 480m)
    const roadY = 480 + 20 * Math.sin(u * 0.005);
    const roadDist = Math.abs(v - roadY);
    if (roadDist < 8) {
      // Asphalt road surface
      r = 60; g = 60; b = 65;
      // White center line dashes
      if (roadDist < 0.6 && (Math.floor(u / 8) % 2 === 0)) {
        r = 230; g = 230; b = 230;
      }
    } else if (roadDist < 14) {
      // Road shoulder / gravel
      r = 110; g = 105; b = 95;
    }

    // 4. Bánovce Town Street Grid (North-South & East-West local roads)
    const localGridX = Math.abs((u % 200) - 100);
    const localGridY = Math.abs((v % 200) - 100);
    if ((localGridX < 3 || localGridY < 3) && u > 300 && u < 750 && v > 300 && v < 750) {
      // Local street asphalt
      r = 85; g = 85; b = 90;
    }

    // 5. UTM 200m Diagnostic Grid Lines (thin subtle lines)
    if (Math.abs(u % 200) < 1.0 || Math.abs(v % 200) < 1.0) {
      r = Math.min(255, r + 40);
      g = Math.min(255, g + 40);
      b = Math.min(255, b + 40);
    }

    return [r, g, b];
  });

  const normalPng = generateCustomPng(width, height, (px, py) => {
    const u = (px / (width - 1)) * 1024;
    const v = ((height - 1 - py) / (height - 1)) * 1024;

    // Default flat normal (Z = 255, X = 128, Y = 128)
    let nx = 128;
    let ny = 128;
    let nz = 255;

    // Road shoulder normal slope bump
    const roadY = 480 + 20 * Math.sin(u * 0.005);
    const roadDist = v - roadY;
    if (Math.abs(roadDist) >= 6 && Math.abs(roadDist) <= 12) {
      ny = roadDist > 0 ? 150 : 106;
    }

    return [nx, ny, nz];
  });

  return { diffusePng, normalPng, width, height };
}
