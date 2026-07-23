import { PNG } from 'pngjs';
import type { OsmRoadAlignment } from './osm-road-source';
import type { DesignedSumoStation } from '../pipeline-v3/sumo/SumoGeometryV3';

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
    maxAdjacentZJumpMetres: number;
  };
}

export function generateRoadSurfaceMesh(
  road: OsmRoadAlignment,
  sampleTerrainElevation: (x: number, y: number) => number,
  stations?: readonly DesignedSumoStation[],
  textureRepeatMetres: number = 5.0,
): RoadSurfaceMeshResult {
  const halfGrid = 512.0; // Centered coords [-512, 512] -> local grid coords [0, 1024]
  const halfWidth = road.laneWidthMetres / 2.0;

  const vertices: RoadMeshVertex[] = [];
  const indices: number[] = [];

  let totalClearance = 0;
  let minClearance = Number.POSITIVE_INFINITY;
  let maxClearance = Number.NEGATIVE_INFINITY;
  let negativeCount = 0;
  let totalLength = 0;
  let maxAdjacentZJump = 0;

  let prevLateral: { x: number; y: number } | null = null;
  let prevCenterZ: number | null = null;

  if (stations && stations.length >= 2) {
    // Dense 1.0m stationing mode from Pipeline V3 design solver
    const rawLeftZ: number[] = [];
    const rawRightZ: number[] = [];
    const stationData: Array<{
      localX: number;
      localY: number;
      leftX: number;
      leftY: number;
      rightX: number;
      rightY: number;
      terrainZLeft: number;
      terrainZRight: number;
      station: number;
    }> = [];

    for (let i = 0; i < stations.length; i++) {
      const st = stations[i];
      const localX = st.x + halfGrid;
      const localY = st.y + halfGrid;

      let tx = st.tangentX;
      let ty = st.tangentY;
      if (!Number.isFinite(tx) || !Number.isFinite(ty) || Math.hypot(tx, ty) < 1e-6) {
        if (i < stations.length - 1) {
          tx = stations[i + 1].x - st.x;
          ty = stations[i + 1].y - st.y;
        } else {
          tx = st.x - stations[i - 1].x;
          ty = st.y - stations[i - 1].y;
        }
      }

      const len = Math.hypot(tx, ty);
      const normTx = len > 1e-6 ? tx / len : 1;
      const normTy = len > 1e-6 ? ty / len : 0;

      let currLateral = { x: -normTy, y: normTx };

      if (prevLateral !== null) {
        const dot = prevLateral.x * currLateral.x + prevLateral.y * currLateral.y;
        if (dot < 0) {
          currLateral.x = -currLateral.x;
          currLateral.y = -currLateral.y;
        }
      }
      prevLateral = { ...currLateral };

      const leftX = localX + currLateral.x * halfWidth;
      const leftY = localY + currLateral.y * halfWidth;
      const rightX = localX - currLateral.x * halfWidth;
      const rightY = localY - currLateral.y * halfWidth;

      const terrainZLeft = sampleTerrainElevation(leftX, leftY);
      const terrainZRight = sampleTerrainElevation(rightX, rightY);

      stationData.push({
        localX,
        localY,
        leftX,
        leftY,
        rightX,
        rightY,
        terrainZLeft,
        terrainZRight,
        station: st.station,
      });

      const baseLeftZ = terrainZLeft + 0.04;
      const baseRightZ = terrainZRight + 0.04;
      rawLeftZ.push(baseLeftZ);
      rawRightZ.push(baseRightZ);
    }

    // Apply 5-point moving average smoothing over station elevations to eliminate micro-steps
    const smoothLeftZ = [...rawLeftZ];
    const smoothRightZ = [...rawRightZ];
    const window = 2;
    for (let i = 0; i < stations.length; i++) {
      let sumL = 0, sumR = 0, count = 0;
      for (let w = -window; w <= window; w++) {
        const idx = i + w;
        if (idx >= 0 && idx < stations.length) {
          sumL += rawLeftZ[idx];
          sumR += rawRightZ[idx];
          count++;
        }
      }
      const avgL = sumL / count;
      const avgR = sumR / count;
      // Ensure elevation is never below terrainZ + 0.04m and never above terrainZ + 0.08m
      smoothLeftZ[i] = Math.min(stationData[i].terrainZLeft + 0.08, Math.max(stationData[i].terrainZLeft + 0.04, avgL));
      smoothRightZ[i] = Math.min(stationData[i].terrainZRight + 0.08, Math.max(stationData[i].terrainZRight + 0.04, avgR));
    }

    for (let i = 0; i < stations.length; i++) {
      const data = stationData[i];
      const surfaceZLeft = smoothLeftZ[i];
      const surfaceZRight = smoothRightZ[i];

      const currCenterZ = (surfaceZLeft + surfaceZRight) / 2.0;
      if (prevCenterZ !== null) {
        const dz = Math.abs(currCenterZ - prevCenterZ);
        if (i < stations.length - 2) {
          if (dz > maxAdjacentZJump) maxAdjacentZJump = dz;
          if (dz > 0.35) {
            throw new Error(`Abnormal Z jump of ${dz.toFixed(3)}m detected between station ${i - 1} and ${i}.`);
          }
        }
      }
      prevCenterZ = currCenterZ;

      const clearanceLeft = surfaceZLeft - data.terrainZLeft;
      const clearanceRight = surfaceZRight - data.terrainZRight;

      const vTex = data.station / textureRepeatMetres;

      vertices.push({
        x: data.leftX,
        y: data.leftY,
        z: surfaceZLeft,
        nx: 0,
        ny: 0,
        nz: 1,
        u: 0.0,
        v: vTex,
        terrainZ: data.terrainZLeft,
        clearance: clearanceLeft,
      });

      vertices.push({
        x: data.rightX,
        y: data.rightY,
        z: surfaceZRight,
        nx: 0,
        ny: 0,
        nz: 1,
        u: 1.0,
        v: vTex,
        terrainZ: data.terrainZRight,
        clearance: clearanceRight,
      });

      for (const c of [clearanceLeft, clearanceRight]) {
        if (c < 0) negativeCount++;
        if (c < minClearance) minClearance = c;
        if (c > maxClearance) maxClearance = c;
        totalClearance += c;
      }
    }

    totalLength = stations[stations.length - 1].station;

    for (let i = 0; i < stations.length - 1; i++) {
      const idxL0 = i * 2;
      const idxR0 = idxL0 + 1;
      const idxL1 = idxL0 + 2;
      const idxR1 = idxL0 + 3;

      indices.push(idxL0, idxR0, idxR1);
      indices.push(idxL0, idxR1, idxL1);
    }
  } else {
    // Sparse node fallback mode
    const points = road.pointsCentered;
    let accumulatedLength = 0;

    for (let i = 0; i < points.length; i++) {
      const pt = points[i];
      const localX = pt.x + halfGrid;
      const localY = pt.y + halfGrid;

      if (i > 0) {
        const prev = points[i - 1];
        accumulatedLength += Math.hypot(pt.x - prev.x, pt.y - prev.y);
      }

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

      let currLateral = { x: -normTy, y: normTx };

      if (prevLateral !== null) {
        const dot = prevLateral.x * currLateral.x + prevLateral.y * currLateral.y;
        if (dot < 0) {
          currLateral.x = -currLateral.x;
          currLateral.y = -currLateral.y;
        }
      }
      prevLateral = { ...currLateral };

      const leftX = localX + currLateral.x * halfWidth;
      const leftY = localY + currLateral.y * halfWidth;
      const rightX = localX - currLateral.x * halfWidth;
      const rightY = localY - currLateral.y * halfWidth;

      const terrainZLeft = sampleTerrainElevation(leftX, leftY);
      const terrainZRight = sampleTerrainElevation(rightX, rightY);

      const surfaceZLeft = terrainZLeft + 0.04;
      const surfaceZRight = terrainZRight + 0.04;

      const clearanceLeft = surfaceZLeft - terrainZLeft;
      const clearanceRight = surfaceZRight - terrainZRight;

      const vTex = accumulatedLength / textureRepeatMetres;

      vertices.push({
        x: leftX,
        y: leftY,
        z: surfaceZLeft,
        nx: 0,
        ny: 0,
        nz: 1,
        u: 0.0,
        v: vTex,
        terrainZ: terrainZLeft,
        clearance: clearanceLeft,
      });

      vertices.push({
        x: rightX,
        y: rightY,
        z: surfaceZRight,
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

    totalLength = road.lengthMetres;

    for (let i = 0; i < points.length - 1; i++) {
      const idxL0 = i * 2;
      const idxR0 = idxL0 + 1;
      const idxL1 = idxL0 + 2;
      const idxR1 = idxL0 + 3;

      indices.push(idxL0, idxR0, idxR1);
      indices.push(idxL0, idxR1, idxL1);
    }
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

  const segmentCount = indices.length / 6;

  return {
    positions,
    normals,
    uvs,
    indices: new Uint32Array(indices),
    vertexCount,
    triangleCount: indices.length / 3,
    segmentCount,
    lengthMetres: totalLength,
    widthMetres: road.laneWidthMetres,
    clearanceStats: {
      minMetres: Number(minClearance.toFixed(3)),
      maxMetres: Number(maxClearance.toFixed(3)),
      meanMetres: Number((totalClearance / vertexCount).toFixed(3)),
      negativeCount,
      maxAdjacentZJumpMetres: Number(maxAdjacentZJump.toFixed(3)),
    },
  };
}

export function parseDaeVerticesAndAuditClearance(
  daeXml: string,
  sampleTerrainElevation: (x: number, y: number) => number,
): {
  parsedVertexCount: number;
  minClearance: number;
  maxClearance: number;
  meanClearance: number;
  negativeCount: number;
  maxClearanceVertex: { x: number; y: number; z: number; clearance: number };
} {
  const match = daeXml.match(/<float_array id="RoadMesh-positions-array" count="(\d+)">([^<]+)<\/float_array>/);
  if (!match) {
    throw new Error('Failed to parse RoadMesh-positions-array from Collada DAE string.');
  }

  const rawValues = match[2].trim().split(/\s+/).map(Number);
  const parsedVertexCount = rawValues.length / 3;

  let minClearance = Number.POSITIVE_INFINITY;
  let maxClearance = Number.NEGATIVE_INFINITY;
  let totalClearance = 0;
  let negativeCount = 0;
  let maxVertex = { x: 0, y: 0, z: 0, clearance: 0 };

  for (let i = 0; i < parsedVertexCount; i++) {
    const x = rawValues[i * 3];
    const y = rawValues[i * 3 + 1];
    const z = rawValues[i * 3 + 2];

    const terrainZ = sampleTerrainElevation(x, y);
    const clearance = z - terrainZ;

    if (clearance < 0) negativeCount++;
    if (clearance < minClearance) minClearance = clearance;
    if (clearance > maxClearance) {
      maxClearance = clearance;
      maxVertex = { x, y, z, clearance };
    }
    totalClearance += clearance;
  }

  return {
    parsedVertexCount,
    minClearance: Number(minClearance.toFixed(3)),
    maxClearance: Number(maxClearance.toFixed(3)),
    meanClearance: Number((totalClearance / parsedVertexCount).toFixed(3)),
    negativeCount,
    maxClearanceVertex: maxVertex,
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

  let seed = 12345;
  const pseudoRand = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const noise = (pseudoRand() - 0.5) * 20;
      const baseGrey = 48 + noise;
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
