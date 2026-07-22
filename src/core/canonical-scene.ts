export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];

export interface CanonicalMaterial {
  readonly id: string;
  readonly baseColor: readonly [number, number, number, number];
  readonly roughness: number;
  readonly metallic: number;
}

export interface CanonicalMesh {
  readonly id: string;
  readonly role: "terrain" | "road" | "junction" | "collision" | "object";
  readonly positions: readonly Vec3[];
  readonly indices: readonly number[];
  readonly normals?: readonly Vec3[];
  readonly uvs?: readonly Vec2[];
  readonly materialId: string;
}

export interface SpawnPoint {
  readonly id: string;
  readonly position: Vec3;
  readonly forward: Vec3;
}

export interface CanonicalScene {
  readonly schema: "triworld.scene.v1";
  readonly coordinateSystem: {
    readonly handedness: "right";
    readonly upAxis: "Z";
    readonly units: "metres";
    readonly originWgs84?: readonly [number, number, number];
  };
  readonly materials: readonly CanonicalMaterial[];
  readonly meshes: readonly CanonicalMesh[];
  readonly spawns: readonly SpawnPoint[];
}
