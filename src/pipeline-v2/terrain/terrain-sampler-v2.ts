import type { CanonicalTerrainV2 } from './canonical-terrain-v2';
import {
  localXToContinuousColumn,
  localYToContinuousRow,
} from './terrain-grid-transform';

export function getSample(
  terrain: CanonicalTerrainV2,
  col: number,
  row: number,
  useWorking: boolean = true,
): number {
  const c = Math.max(0, Math.min(terrain.resolution - 1, col));
  const r = Math.max(0, Math.min(terrain.resolution - 1, row));
  const idx = r * terrain.resolution + c;
  return useWorking ? terrain.workingHeights[idx] : terrain.sourceHeights[idx];
}

export function setWorkingSample(
  terrain: CanonicalTerrainV2,
  col: number,
  row: number,
  elevation: number,
): void {
  if (col < 0 || col >= terrain.resolution || row < 0 || row >= terrain.resolution) return;
  const idx = row * terrain.resolution + col;
  terrain.workingHeights[idx] = elevation;
}

export function sampleBilinearLocal(
  terrain: CanonicalTerrainV2,
  xMetres: number,
  yMetres: number,
  useWorking: boolean = true,
): number {
  const u = localXToContinuousColumn(terrain.transform, xMetres);
  const v = localYToContinuousRow(terrain.transform, yMetres);

  const c0 = Math.floor(u);
  const r0 = Math.floor(v);
  const c1 = Math.min(terrain.resolution - 1, c0 + 1);
  const r1 = Math.min(terrain.resolution - 1, r0 + 1);

  const tx = Math.max(0, Math.min(1, u - c0));
  const ty = Math.max(0, Math.min(1, v - r0));

  const z00 = getSample(terrain, c0, r0, useWorking);
  const z10 = getSample(terrain, c1, r0, useWorking);
  const z01 = getSample(terrain, c0, r1, useWorking);
  const z11 = getSample(terrain, c1, r1, useWorking);

  const zBottom = z00 + (z10 - z00) * tx;
  const zTop = z01 + (z11 - z01) * tx;
  return zBottom + (zTop - zBottom) * ty;
}
