import { PNG } from 'pngjs';
import type { OsmRoadAlignment } from './osm-road-source';

export interface RoadMeshVertex {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  u: number;
  v: number;
  terrainZ: number;
  clearance: number;
}

export interface RoadSurfaceMeshResult {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
  segmentCount: number;
  lengthMetres: number;
  widthMetres: number;
  clearanceStats: {
    minMetres: number;
    maxMetres: number;
    meanMetres: number;
    negativeCount: number;
  };
}

export function generateRoadSurfaceMesh(
  road: OsmRoadAlignment,
  sampleTerrainElevation: (x: number, y: number) => number,
  textureRepeatMetres: number = 5.0,
): RoadSurfaceMeshResult {
  const halfGrid = 512.0; // Centered coords [-512, 512] -> local grid coords [0, 1024]
  const halfWidth = road.laneWidthMetres / 2.0;

  const vertices: RoadMeshVertex[] = [];
  const indices: number[] = [];

  let accumulatedLength = 0;
  let totalClearance = 0;
  let minClearance = Number.POSITIVE_INFINITY;
  let maxClearance = Number.NEGATIVE_INFINITY;
  let negativeCount = 0;

  const points = road.pointsCentered;

  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    const localX = pt.x + halfGrid;
    const localY = pt.y + halfGrid;

    if (i > 0) {
      const prev = points[i - 1];
      accumulatedLength += Math.hypot(pt.x - prev.x, pt.y - prev.y);
    }

    // Compute tangent vector
    let tx = 0;
    let ty = 0;
    if (i < points.length - 1) {
      const next = points[i + 1];
      tx = next.x - pt.x;
      ty = next.y - pt.y;
    } else if (i > 0) {
      const prev = points[i - 1];
      tx = pt.x - prev.x;
      ty = pt.y - prev.y;
    }

    const len = Math.hypot(tx, ty);
    const normTx = len > 1e-6 ? tx / len : 1;
    const normTy = len > 1e-6 ? ty / len : 0;

    // Perpendicular normal pointing left (-ty, tx)
    const nx = -normTy;
    const ny = normTx;

    const leftX = localX + nx * halfWidth;
    const leftY = localY + ny * halfWidth;
    const rightX = localX - nx * halfWidth;
    const rightY = localY - ny * halfWidth;

    const terrainZLeft = sampleTerrainElevation(leftX, leftY);
    const terrainZRight = sampleTerrainElevation(rightX, rightY);
    const terrainZCenter = sampleTerrainElevation(localX, localY);
    const maxTerrainZ = Math.max(terrainZLeft, terrainZRight, terrainZCenter);

    const baseProfileZ = pt.z !== undefined && Number.isFinite(pt.z) ? pt.z : terrainZCenter;
    const surfaceZ = Math.max(baseProfileZ + 0.05, maxTerrainZ + 0.05);

    const vTex = accumulatedLength / textureRepeatMetres;

    // Left vertex
    const clearanceLeft = surfaceZ - terrainZLeft;
    vertices.push({
      x: leftX,
      y: leftY,
      z: surfaceZ,
      nx: 0,
      ny: 0,
      nz: 1,
      u: 0.0,
      v: vTex,
      terrainZ: terrainZLeft,
      clearance: clearanceLeft,
    });

    // Right vertex
    const clearanceRight = surfaceZ - terrainZRight;
    vertices.push({
      x: rightX,
      y: rightY,
      z: surfaceZ,
      nx: 0,
      ny: 0,
      nz: 1,
      u: 1.0,
      v: vTex,
      terrainZ: terrainZRight,
      clearance: clearanceRight,
    });

    for (const c of [clearanceLeft, clearanceRight]) {
      if (c < 0) negativeCount++;
      if (c < minClearance) minClearance = c;
      if (c > maxClearance) maxClearance = c;
      totalClearance += c;
    }
  }

  // Build quad ribbon indices
  let segmentCount = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const idxL0 = i * 2;
    const idxR0 = idxL0 + 1;
    const idxL1 = idxL0 + 2;
    const idxR1 = idxL0 + 3;

    // Triangle 1: L0 -> R0 -> R1
    indices.push(idxL0, idxR0, idxR1);
    // Triangle 2: L0 -> R1 -> L1
    indices.push(idxL0, idxR1, idxL1);

    segmentCount++;
  }

  const vertexCount = vertices.length;
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);

  for (let i = 0; i < vertexCount; i++) {
    const v = vertices[i];
    positions[i * 3] = v.x;
    positions[i * 3 + 1] = v.y;
    positions[i * 3 + 2] = v.z;

    normals[i * 3] = v.nx;
    normals[i * 3 + 1] = v.ny;
    normals[i * 3 + 2] = v.nz;

    uvs[i * 2] = v.u;
    uvs[i * 2 + 1] = v.v;
  }

  return {
    positions,
    normals,
    uvs,
    indices: new Uint32Array(indices),
    vertexCount,
    triangleCount: indices.length / 3,
    segmentCount,
    lengthMetres: road.lengthMetres,
    widthMetres: road.laneWidthMetres,
    clearanceStats: {
      minMetres: Number(minClearance.toFixed(3)),
      maxMetres: Number(maxClearance.toFixed(3)),
      meanMetres: Number((totalClearance / vertexCount).toFixed(3)),
      negativeCount,
    },
  };
}

export function exportRoadMeshToDae(
  mesh: RoadSurfaceMeshResult,
  materialName: string = 'triworld_asphalt',
): string {
  const posArr: string[] = [];
  for (let i = 0; i < mesh.positions.length; i++) {
    posArr.push(mesh.positions[i].toFixed(4));
  }

  const normArr: string[] = [];
  for (let i = 0; i < mesh.normals.length; i++) {
    normArr.push(mesh.normals[i].toFixed(4));
  }

  const uvArr: string[] = [];
  for (let i = 0; i < mesh.uvs.length; i++) {
    uvArr.push(mesh.uvs[i].toFixed(4));
  }

  const pArr: string[] = [];
  for (let i = 0; i < mesh.indices.length; i++) {
    const idx = mesh.indices[i];
    // Index mapping for position, normal, texcoord (all offset 0, 1, 2)
    pArr.push(`${idx} ${idx} ${idx}`);
  }

  return `<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset>
    <contributor>
      <author>TriWorld V4 Engine</author>
      <authoring_tool>TriWorld Road Mesh Exporter V3</authoring_tool>
    </contributor>
    <created>2026-07-24T00:00:00Z</created>
    <modified>2026-07-24T00:00:00Z</modified>
    <unit name="meter" meter="1.0"/>
    <up_axis>Z_UP</up_axis>
  </asset>
  <library_materials>
    <material id="${materialName}-material" name="${materialName}">
      <instance_effect url="#${materialName}-effect"/>
    </material>
  </library_materials>
  <library_effects>
    <effect id="${materialName}-effect">
      <profile_COMMON>
        <technique sid="common">
          <phong>
            <diffuse>
              <color>0.25 0.25 0.25 1.0</color>
            </diffuse>
          </phong>
        </technique>
      </profile_COMMON>
    </effect>
  </library_effects>
  <library_geometries>
    <geometry id="RoadMesh-mesh" name="RoadMesh">
      <mesh>
        <source id="RoadMesh-positions">
          <float_array id="RoadMesh-positions-array" count="${mesh.positions.length}">${posArr.join(' ')}</float_array>
          <technique_common>
            <accessor source="#RoadMesh-positions-array" count="${mesh.vertexCount}" stride="3">
              <param name="X" type="float"/>
              <param name="Y" type="float"/>
              <param name="Z" type="float"/>
            </accessor>
          </technique_common>
        </source>
        <source id="RoadMesh-normals">
          <float_array id="RoadMesh-normals-array" count="${mesh.normals.length}">${normArr.join(' ')}</float_array>
          <technique_common>
            <accessor source="#RoadMesh-normals-array" count="${mesh.vertexCount}" stride="3">
              <param name="X" type="float"/>
              <param name="Y" type="float"/>
              <param name="Z" type="float"/>
            </accessor>
          </technique_common>
        </source>
        <source id="RoadMesh-map-0">
          <float_array id="RoadMesh-map-0-array" count="${mesh.uvs.length}">${uvArr.join(' ')}</float_array>
          <technique_common>
            <accessor source="#RoadMesh-map-0-array" count="${mesh.vertexCount}" stride="2">
              <param name="S" type="float"/>
              <param name="T" type="float"/>
            </accessor>
          </technique_common>
        </source>
        <vertices id="RoadMesh-vertices">
          <input semantic="POSITION" source="#RoadMesh-positions"/>
        </vertices>
        <triangles material="${materialName}-material" count="${mesh.triangleCount}">
          <input semantic="VERTEX" source="#RoadMesh-vertices" offset="0"/>
          <input semantic="NORMAL" source="#RoadMesh-normals" offset="1"/>
          <input semantic="TEXCOORD" source="#RoadMesh-map-0" offset="2" set="0"/>
          <p>${pArr.join(' ')}</p>
        </triangles>
      </mesh>
    </geometry>
  </library_geometries>
  <library_visual_scenes>
    <visual_scene id="Scene" name="Scene">
      <node id="RoadMesh" name="RoadMesh" type="NODE">
        <matrix sid="transform">1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1</matrix>
        <instance_geometry url="#RoadMesh-mesh" name="RoadMesh">
          <bind_material>
            <technique_common>
              <instance_material symbol="${materialName}-material" target="#${materialName}-material"/>
            </technique_common>
          </bind_material>
        </instance_geometry>
      </node>
    </visual_scene>
  </library_visual_scenes>
  <scene>
    <instance_visual_scene url="#Scene"/>
  </scene>
</COLLADA>`;
}

export function generateAsphaltTexturePng(size: number = 256): Uint8Array {
  const png = new PNG({
    width: size,
    height: size,
    colorType: 6, // RGBA
    bitDepth: 8,
  });

  // Generate realistic charcoal asphalt texture with subtle procedural grain noise
  let seed = 12345;
  const pseudoRand = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const noise = (pseudoRand() - 0.5) * 20;
      const baseGrey = 48 + noise; // Charcoal asphalt value ~48-52
      const r = Math.min(255, Math.max(0, Math.round(baseGrey)));
      const g = Math.min(255, Math.max(0, Math.round(baseGrey + 2)));
      const b = Math.min(255, Math.max(0, Math.round(baseGrey + 4)));

      png.data[idx] = r;
      png.data[idx + 1] = g;
      png.data[idx + 2] = b;
      png.data[idx + 3] = 255;
    }
  }

  return Uint8Array.from(PNG.sync.write(png));
}
