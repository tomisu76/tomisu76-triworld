import type { CanonicalMesh, CanonicalScene, Vec3 } from "./canonical-scene";

export interface ValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly meshId?: string;
}

const crossZ = (a: Vec3, b: Vec3, c: Vec3): number => {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const acx = c[0] - a[0];
  const acy = c[1] - a[1];
  return abx * acy - aby * acx;
};

function validateMesh(mesh: CanonicalMesh): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (mesh.indices.length % 3 !== 0) {
    issues.push({ code: "INDEX_COUNT", message: "Triangle index count must be divisible by three.", meshId: mesh.id });
  }

  for (const index of mesh.indices) {
    if (!Number.isInteger(index) || index < 0 || index >= mesh.positions.length) {
      issues.push({ code: "INDEX_RANGE", message: `Invalid vertex index ${index}.`, meshId: mesh.id });
      break;
    }
  }

  for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
    const a = mesh.positions[mesh.indices[i]];
    const b = mesh.positions[mesh.indices[i + 1]];
    const c = mesh.positions[mesh.indices[i + 2]];
    if (Math.abs(crossZ(a, b, c)) < 1e-12) {
      issues.push({ code: "ZERO_AREA_XY", message: `Degenerate triangle at index ${i / 3}.`, meshId: mesh.id });
    }
  }

  return issues;
}

export function validateScene(scene: CanonicalScene): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const materialIds = new Set(scene.materials.map((material) => material.id));
  const meshIds = new Set<string>();

  for (const mesh of scene.meshes) {
    if (meshIds.has(mesh.id)) {
      issues.push({ code: "DUPLICATE_MESH_ID", message: `Duplicate mesh id ${mesh.id}.`, meshId: mesh.id });
    }
    meshIds.add(mesh.id);

    if (!materialIds.has(mesh.materialId)) {
      issues.push({ code: "MISSING_MATERIAL", message: `Unknown material ${mesh.materialId}.`, meshId: mesh.id });
    }

    issues.push(...validateMesh(mesh));
  }

  return issues;
}
