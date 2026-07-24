const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.join(process.cwd(), 'tmp_audit/test08/levels/test08/art');
const daePath = path.join(root, 'road/road_surface.dae');
const terPath = path.join(root, 'terrains/terrain.ter');
const daeText = fs.readFileSync(daePath, 'utf8');
const terBytes = fs.readFileSync(terPath);
const size = terBytes.readUInt32LE(1);
const sampleCount = size * size;
const heightScale = 500.0 / 65535.0;
const heightU16 = [];
for (let i = 0; i < sampleCount; i++) {
  heightU16.push(terBytes.readUInt16LE(5 + i * 2));
}
function sampleTerrain(x, y) {
  const column = x / 1.0;
  const row = (size - 1) - y / 1.0;
  const c0 = Math.min(size - 2, Math.floor(column));
  const r0 = Math.min(size - 2, Math.floor(row));
  const c1 = c0 + 1;
  const r1 = r0 + 1;
  const tx = column - c0;
  const ty = row - r0;
  const z00 = heightU16[r0 * size + c0] * heightScale;
  const z10 = heightU16[r0 * size + c1] * heightScale;
  const z01 = heightU16[r1 * size + c0] * heightScale;
  const z11 = heightU16[r1 * size + c1] * heightScale;
  const z0 = z00 + (z10 - z00) * tx;
  const z1 = z01 + (z11 - z01) * tx;
  return z0 + (z1 - z0) * ty;
}
const posMatch = daeText.match(/<float_array id="RoadMesh-positions-array" count="(\d+)">([^<]+)<\/float_array>/);
const posVals = posMatch[2].trim().split(/\s+/).map(Number);
const positions = [];
for (let i = 0; i < posVals.length; i += 3) {
  positions.push([posVals[i], posVals[i + 1], posVals[i + 2]]);
}
const pMatch = daeText.match(/<p>([^<]+)<\/p>/s);
const pVals = pMatch[1].trim().split(/\s+/).map(Number);
const triangles = [];
for (let i = 0; i < pVals.length; i += 9) {
  triangles.push([pVals[i], pVals[i + 3], pVals[i + 6]]);
}
const stationCount = positions.length / 7;
const crownIndex = 3;
const crownPositions = [];
for (let s = 0; s < stationCount; s++) {
  crownPositions.push(positions[s * 7 + crownIndex]);
}
let maxCandXY = 0;
let maxCandZ = 0;
for (let i = 1; i < crownPositions.length; i++) {
  const a = crownPositions[i - 1];
  const b = crownPositions[i];
  const dxy = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const dz = Math.abs(b[2] - a[2]);
  if (dxy > maxCandXY) maxCandXY = dxy;
  if (dz > maxCandZ) maxCandZ = dz;
}
let maxEdge = 0;
let maxZExtent = 0;
let edgeGt3 = 0;
let zExtentGt1 = 0;
let firstSep = null;
for (let triIndex = 0; triIndex < triangles.length; triIndex++) {
  const tri = triangles[triIndex];
  const pts = tri.map((idx) => positions[idx]);
  for (let i = 0; i < 3; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 3];
    const edge = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (edge > maxEdge) maxEdge = edge;
    if (edge > 3.0) {
      edgeGt3 += 1;
      if (!firstSep) firstSep = { type: 'edge', triIndex, edge };
    }
  }
  const zExtent = Math.max(...pts.map((p) => p[2])) - Math.min(...pts.map((p) => p[2]));
  if (zExtent > maxZExtent) maxZExtent = zExtent;
  if (zExtent > 1.0) {
    zExtentGt1 += 1;
    if (!firstSep) firstSep = { type: 'zextent', triIndex, zExtent };
  }
}
let firstMismatch = null;
for (let s = 0; s < stationCount; s++) {
  for (let v = 0; v < 7; v++) {
    const p = positions[s * 7 + v];
    const terrainZ = sampleTerrain(p[0], p[1]);
    const delta = p[2] - terrainZ;
    if (Math.abs(delta) > 0.29) {
      firstMismatch = { station: s, vertex: v, dae: p, terrain: terrainZ, delta };
      break;
    }
  }
  if (firstMismatch) break;
}

const candidates = [
  ['no_flip', (x, y) => [x, y]],
  ['x_flip', (x, y) => [1023 - x, y]],
  ['y_flip', (x, y) => [x, 1023 - y]],
  ['xy_flip', (x, y) => [1023 - x, 1023 - y]],
];
for (const [label, fn] of candidates) {
  let worst = null;
  let maxAbsDelta = 0;
  for (let s = 0; s < stationCount; s++) {
    for (let v = 0; v < 7; v++) {
      const p = positions[s * 7 + v];
      const [qx, qy] = fn(p[0], p[1]);
      const terrainZ = sampleTerrain(qx, qy);
      const delta = p[2] - terrainZ;
      if (Math.abs(delta) > maxAbsDelta) {
        maxAbsDelta = Math.abs(delta);
        worst = { station: s, vertex: v, emitted: p, sampled: [qx, qy], terrain: terrainZ, delta };
      }
    }
  }
  console.log(label, 'max_abs_delta_to_candidate_terrain', maxAbsDelta.toFixed(6), 'worst', JSON.stringify(worst));
}
console.log('max_crown_xy_distance', maxCandXY.toFixed(6));
console.log('max_crown_z_difference', maxCandZ.toFixed(6));
console.log('max_triangle_edge_length', maxEdge.toFixed(6));
console.log('max_triangle_vertical_extent', maxZExtent.toFixed(6));
console.log('triangles_edge_gt_3m', edgeGt3);
console.log('triangles_zextent_gt_1m', zExtentGt1);
console.log('first_sep', JSON.stringify(firstSep));
console.log('first_mismatch', JSON.stringify(firstMismatch));
console.log('dae_minmax', { minX: Math.min(...positions.map((p) => p[0])), maxX: Math.max(...positions.map((p) => p[0])), minY: Math.min(...positions.map((p) => p[1])), maxY: Math.max(...positions.map((p) => p[1])), minZ: Math.min(...positions.map((p) => p[2])), maxZ: Math.max(...positions.map((p) => p[2])) });
console.log('terrain_decoded_minmax_z', { min: Math.min(...heightU16) * heightScale, max: Math.max(...heightU16) * heightScale });
