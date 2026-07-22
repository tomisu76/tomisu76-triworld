export type Vec3 = readonly [number, number, number];
export type Rgba = readonly [number, number, number, number];

export type MeshRole = 'terrain' | 'road';

export interface CanonicalMaterial {
  id: string;
  name: string;
  color: Rgba;
}

export interface CanonicalMesh {
  id: string;
  role: MeshRole;
  materialId: string;
  positions: number[];
  indices: number[];
}

export interface CanonicalScene {
  id: string;
  schemaVersion: '0.1.0';
  coordinateSystem: {
    handedness: 'right';
    upAxis: 'Z';
    units: 'metres';
    localFrame: 'ENU';
  };
  anchor: {
    longitude: number;
    latitude: number;
    height: number;
  };
  materials: CanonicalMaterial[];
  meshes: CanonicalMesh[];
  spawns: Array<{
    id: string;
    position: Vec3;
    headingDegrees: number;
  }>;
}

export interface SceneManifest {
  sceneId: string;
  schemaVersion: string;
  hash: string;
  vertices: number;
  triangles: number;
  bounds: {
    min: Vec3;
    max: Vec3;
  };
  validation: {
    valid: boolean;
    errors: string[];
  };
  meshes: Array<{
    id: string;
    role: MeshRole;
    vertices: number;
    triangles: number;
    hash: string;
  }>;
}

type CenterPoint = {
  x: number;
  y: number;
  z: number;
};

const ROAD_HALF_WIDTH = 4;
const TERRAIN_CLEARANCE = 0.18;

export function buildSyntheticScene(): CanonicalScene {
  const centerline = buildCenterline();
  const terrain = buildTerrain(centerline);
  const road = buildRoad(centerline);

  return {
    id: 'triworld-synthetic-v01',
    schemaVersion: '0.1.0',
    coordinateSystem: {
      handedness: 'right',
      upAxis: 'Z',
      units: 'metres',
      localFrame: 'ENU',
    },
    anchor: {
      longitude: 18.34344407408825,
      latitude: 48.73275071557837,
      height: 0,
    },
    materials: [
      { id: 'terrain-green', name: 'Terrain', color: [0.18, 0.48, 0.28, 1] },
      { id: 'road-magenta', name: 'Road', color: [1, 0.08, 0.58, 1] },
    ],
    meshes: [terrain, road],
    spawns: [{ id: 'spawn-main', position: [-58, 0, 3.2], headingDegrees: 90 }],
  };
}

export function buildSceneManifest(scene: CanonicalScene): SceneManifest {
  const validation = validateScene(scene);
  const bounds = computeBounds(scene.meshes);
  const meshes = scene.meshes.map((mesh) => ({
    id: mesh.id,
    role: mesh.role,
    vertices: mesh.positions.length / 3,
    triangles: mesh.indices.length / 3,
    hash: hashMesh(mesh),
  }));

  return {
    sceneId: scene.id,
    schemaVersion: scene.schemaVersion,
    hash: hashScene(scene),
    vertices: meshes.reduce((sum, mesh) => sum + mesh.vertices, 0),
    triangles: meshes.reduce((sum, mesh) => sum + mesh.triangles, 0),
    bounds,
    validation,
    meshes,
  };
}

export function validateScene(scene: CanonicalScene): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const materialIds = new Set(scene.materials.map((material) => material.id));

  for (const mesh of scene.meshes) {
    if (!materialIds.has(mesh.materialId)) {
      errors.push(`${mesh.id}: material ${mesh.materialId} does not exist`);
    }
    if (mesh.positions.length % 3 !== 0) {
      errors.push(`${mesh.id}: positions length is not divisible by 3`);
      continue;
    }
    if (mesh.indices.length % 3 !== 0) {
      errors.push(`${mesh.id}: indices length is not divisible by 3`);
      continue;
    }

    const vertexCount = mesh.positions.length / 3;
    for (let triangle = 0; triangle < mesh.indices.length; triangle += 3) {
      const ia = mesh.indices[triangle];
      const ib = mesh.indices[triangle + 1];
      const ic = mesh.indices[triangle + 2];

      if (ia >= vertexCount || ib >= vertexCount || ic >= vertexCount || ia < 0 || ib < 0 || ic < 0) {
        errors.push(`${mesh.id}: triangle ${triangle / 3} references an invalid vertex`);
        continue;
      }
      if (ia === ib || ib === ic || ia === ic) {
        errors.push(`${mesh.id}: triangle ${triangle / 3} repeats a vertex`);
        continue;
      }

      const a = readVertex(mesh.positions, ia);
      const b = readVertex(mesh.positions, ib);
      const c = readVertex(mesh.positions, ic);
      const ab = subtract(b, a);
      const ac = subtract(c, a);
      const cross = crossProduct(ab, ac);
      const areaSquared = dot(cross, cross);

      if (areaSquared < 1e-12) {
        errors.push(`${mesh.id}: triangle ${triangle / 3} has zero area`);
      }
      if (cross[2] <= 0) {
        errors.push(`${mesh.id}: triangle ${triangle / 3} has non-positive Z winding`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function serializeScene(scene: CanonicalScene, manifest: SceneManifest): string {
  return JSON.stringify({ scene, manifest }, null, 2);
}

function buildCenterline(): CenterPoint[] {
  const points: CenterPoint[] = [];
  const segments = 64;

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const x = -76 + t * 152;
    const y = Math.sin(t * Math.PI * 2.15) * 13 + Math.sin(t * Math.PI * 0.85) * 3;
    const z = 2.2 + Math.sin(t * Math.PI) * 4.2 + Math.sin(t * Math.PI * 3.1) * 0.65;
    points.push({ x, y, z });
  }

  return points;
}

function buildTerrain(centerline: CenterPoint[]): CanonicalMesh {
  const size = 41;
  const step = 4;
  const positions: number[] = [];
  const indices: number[] = [];
  const corridorRadius = 15;
  const roadBedRadius = ROAD_HALF_WIDTH + 0.7;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x - (size - 1) / 2) * step;
      const py = (y - (size - 1) / 2) * step;
      const base = Math.sin(px * 0.055) * 5.2 + Math.cos(py * 0.061) * 4.1 + Math.sin((px + py) * 0.027) * 2.4;
      const nearest = nearestCenterPoint(px, py, centerline);
      const roadBed = nearest.z - TERRAIN_CLEARANCE;

      let z = base;
      if (nearest.distance <= roadBedRadius) {
        z = roadBed;
      } else if (nearest.distance < corridorRadius) {
        const blend = smoothstep((corridorRadius - nearest.distance) / (corridorRadius - roadBedRadius));
        z = mix(base, roadBed, blend);
      }

      positions.push(px, py, z);
    }
  }

  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const a = y * size + x;
      const b = a + 1;
      const c = a + size;
      const d = c + 1;
      indices.push(a, b, d, a, d, c);
    }
  }

  return {
    id: 'terrain-main',
    role: 'terrain',
    materialId: 'terrain-green',
    positions,
    indices,
  };
}

function buildRoad(centerline: CenterPoint[]): CanonicalMesh {
  const positions: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i < centerline.length; i++) {
    const previous = centerline[Math.max(0, i - 1)];
    const current = centerline[i];
    const next = centerline[Math.min(centerline.length - 1, i + 1)];
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    const length = Math.hypot(dx, dy) || 1;
    const nx = -dy / length;
    const ny = dx / length;

    positions.push(
      current.x + nx * ROAD_HALF_WIDTH,
      current.y + ny * ROAD_HALF_WIDTH,
      current.z,
      current.x - nx * ROAD_HALF_WIDTH,
      current.y - ny * ROAD_HALF_WIDTH,
      current.z,
    );
  }

  for (let i = 0; i < centerline.length - 1; i++) {
    const left = i * 2;
    const right = left + 1;
    const nextLeft = left + 2;
    const nextRight = left + 3;
    indices.push(left, right, nextRight, left, nextRight, nextLeft);
  }

  return {
    id: 'road-main',
    role: 'road',
    materialId: 'road-magenta',
    positions,
    indices,
  };
}

function nearestCenterPoint(x: number, y: number, centerline: CenterPoint[]): { distance: number; z: number } {
  let bestDistanceSquared = Number.POSITIVE_INFINITY;
  let bestZ = centerline[0].z;

  for (let i = 0; i < centerline.length - 1; i++) {
    const a = centerline[i];
    const b = centerline[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy || 1;
    const t = clamp(((x - a.x) * dx + (y - a.y) * dy) / lengthSquared, 0, 1);
    const qx = a.x + dx * t;
    const qy = a.y + dy * t;
    const distanceSquared = (x - qx) ** 2 + (y - qy) ** 2;

    if (distanceSquared < bestDistanceSquared) {
      bestDistanceSquared = distanceSquared;
      bestZ = mix(a.z, b.z, t);
    }
  }

  return { distance: Math.sqrt(bestDistanceSquared), z: bestZ };
}

function computeBounds(meshes: CanonicalMesh[]): { min: Vec3; max: Vec3 } {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const mesh of meshes) {
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const x = mesh.positions[i];
      const y = mesh.positions[i + 1];
      const z = mesh.positions[i + 2];
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      maxZ = Math.max(maxZ, z);
    }
  }

  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

function hashScene(scene: CanonicalScene): string {
  let hash = 0x811c9dc5;
  hash = updateHash(hash, scene.id);
  hash = updateHash(hash, scene.schemaVersion);
  for (const mesh of scene.meshes) {
    hash = updateHash(hash, hashMesh(mesh));
  }
  return toHex(hash);
}

function hashMesh(mesh: CanonicalMesh): string {
  let hash = 0x811c9dc5;
  hash = updateHash(hash, mesh.id);
  hash = updateHash(hash, mesh.role);
  hash = updateHash(hash, mesh.materialId);
  for (const value of mesh.positions) hash = updateHash(hash, value.toFixed(6));
  for (const index of mesh.indices) hash = updateHash(hash, String(index));
  return toHex(hash);
}

function updateHash(initial: number, value: string): number {
  let hash = initial >>> 0;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function toHex(value: number): string {
  return value.toString(16).padStart(8, '0');
}

function readVertex(positions: number[], index: number): Vec3 {
  const offset = index * 3;
  return [positions[offset], positions[offset + 1], positions[offset + 2]];
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function crossProduct(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(value: number): number {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
