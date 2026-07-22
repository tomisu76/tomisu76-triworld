import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Color,
  ColorGeometryInstanceAttribute,
  ComponentDatatype,
  EllipsoidTerrainProvider,
  Geometry,
  GeometryAttribute,
  GeometryAttributes,
  GeometryInstance,
  ImageryLayer,
  Math as CesiumMath,
  Matrix4,
  OpenStreetMapImageryProvider,
  PerInstanceColorAppearance,
  PointPrimitiveCollection,
  Primitive,
  PrimitiveType,
  Transforms,
  Viewer,
} from 'cesium';
import type { CanonicalMaterial, CanonicalMesh, CanonicalScene } from './core';

export interface TriWorldRenderer {
  viewer: Viewer;
  setMapVisible(visible: boolean): void;
  setMapOpacity(opacity: number): void;
  setTerrainVisible(visible: boolean): void;
  setRoadVisible(visible: boolean): void;
  setWireframeVisible(visible: boolean): void;
  setVerticesVisible(visible: boolean): void;
  resetCamera(): void;
  showMapOverview(): void;
  destroy(): void;
}

export function createTriWorldRenderer(containerId: string, scene: CanonicalScene): TriWorldRenderer {
  const viewer = new Viewer(containerId, {
    animation: false,
    baseLayer: false,
    baseLayerPicker: false,
    fullscreenButton: false,
    geocoder: false,
    homeButton: false,
    infoBox: false,
    navigationHelpButton: false,
    sceneModePicker: false,
    selectionIndicator: false,
    shouldAnimate: false,
    timeline: false,
    terrainProvider: new EllipsoidTerrainProvider(),
    requestRenderMode: true,
  });

  const osmLayer = new ImageryLayer(
    new OpenStreetMapImageryProvider({
      url: 'https://tile.openstreetmap.org/',
      maximumLevel: 19,
    }),
  );
  osmLayer.alpha = 0.78;
  viewer.imageryLayers.add(osmLayer);

  viewer.scene.globe.show = true;
  viewer.scene.globe.depthTestAgainstTerrain = false;
  viewer.scene.globe.baseColor = Color.fromCssColorString('#162238');
  if (viewer.scene.skyBox) viewer.scene.skyBox.show = false;
  if (viewer.scene.sun) viewer.scene.sun.show = false;
  if (viewer.scene.moon) viewer.scene.moon.show = false;
  if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = false;
  viewer.scene.fog.enabled = false;
  viewer.scene.backgroundColor = Color.fromCssColorString('#07111f');
  viewer.scene.screenSpaceCameraController.enableCollisionDetection = false;

  const anchor = Cartesian3.fromDegrees(scene.anchor.longitude, scene.anchor.latitude, scene.anchor.height);
  const modelMatrix = Transforms.eastNorthUpToFixedFrame(anchor);
  const materials = new Map(scene.materials.map((material) => [material.id, material]));
  const surfacePrimitives = new Map<string, Primitive>();
  const wirePrimitives = new Map<string, Primitive>();
  let mapVisible = true;
  let terrainVisible = true;
  let roadVisible = true;
  let wireVisible = true;

  for (const mesh of scene.meshes) {
    const material = materials.get(mesh.materialId);
    if (!material) throw new Error(`Missing material ${mesh.materialId}`);

    const surface = createSurfacePrimitive(mesh, material, modelMatrix);
    const wire = createWirePrimitive(mesh, modelMatrix);
    surfacePrimitives.set(mesh.id, surface);
    wirePrimitives.set(mesh.id, wire);
    viewer.scene.primitives.add(surface);
    viewer.scene.primitives.add(wire);
  }

  const points = createVertexPoints(scene.meshes, modelMatrix);
  points.show = false;
  viewer.scene.primitives.add(points);

  const anchorEntity = viewer.entities.add({
    id: 'triworld-anchor',
    position: Cartesian3.fromDegrees(
      scene.anchor.longitude,
      scene.anchor.latitude,
      scene.anchor.height + 12,
    ),
    point: {
      pixelSize: 13,
      color: Color.fromCssColorString('#ff3eae'),
      outlineColor: Color.WHITE,
      outlineWidth: 2,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      text: `TriWorld anchor\n${scene.anchor.latitude.toFixed(7)}, ${scene.anchor.longitude.toFixed(7)}`,
      font: '13px Inter, sans-serif',
      fillColor: Color.WHITE,
      showBackground: true,
      backgroundColor: Color.fromCssColorString('#07111f').withAlpha(0.82),
      pixelOffset: new Cartesian2(0, -34),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });

  function roleVisible(mesh: CanonicalMesh): boolean {
    return mesh.role === 'terrain' ? terrainVisible : roadVisible;
  }

  function applyVisibility(): void {
    viewer.scene.globe.show = mapVisible;
    osmLayer.show = mapVisible;
    anchorEntity.show = mapVisible;

    for (const mesh of scene.meshes) {
      const visible = roleVisible(mesh);
      const surface = surfacePrimitives.get(mesh.id);
      const wire = wirePrimitives.get(mesh.id);
      if (surface) surface.show = visible;
      if (wire) wire.show = visible && wireVisible;
    }
    viewer.scene.requestRender();
  }

  function resetCamera(): void {
    viewer.camera.lookAtTransform(modelMatrix, new Cartesian3(175, -205, 145));
    viewer.scene.requestRender();
  }

  function showMapOverview(): void {
    viewer.camera.lookAtTransform(Matrix4.IDENTITY);
    void viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(
        scene.anchor.longitude,
        scene.anchor.latitude,
        1450,
      ),
      orientation: {
        heading: 0,
        pitch: CesiumMath.toRadians(-76),
        roll: 0,
      },
      duration: 1.1,
    });
  }

  applyVisibility();
  resetCamera();

  return {
    viewer,
    setMapVisible(visible: boolean): void {
      mapVisible = visible;
      applyVisibility();
    },
    setMapOpacity(opacity: number): void {
      osmLayer.alpha = Math.max(0, Math.min(1, opacity));
      viewer.scene.requestRender();
    },
    setTerrainVisible(visible: boolean): void {
      terrainVisible = visible;
      applyVisibility();
    },
    setRoadVisible(visible: boolean): void {
      roadVisible = visible;
      applyVisibility();
    },
    setWireframeVisible(visible: boolean): void {
      wireVisible = visible;
      applyVisibility();
    },
    setVerticesVisible(visible: boolean): void {
      points.show = visible;
      viewer.scene.requestRender();
    },
    resetCamera,
    showMapOverview,
    destroy(): void {
      if (!viewer.isDestroyed()) viewer.destroy();
    },
  };
}

function createSurfacePrimitive(mesh: CanonicalMesh, material: CanonicalMaterial, modelMatrix: Matrix4): Primitive {
  const geometry = createGeometry(mesh.positions, mesh.indices, PrimitiveType.TRIANGLES);
  const color = new Color(material.color[0], material.color[1], material.color[2], material.color[3]);

  return new Primitive({
    geometryInstances: new GeometryInstance({
      id: mesh.id,
      geometry,
      attributes: {
        color: ColorGeometryInstanceAttribute.fromColor(color),
      },
    }),
    appearance: new PerInstanceColorAppearance({
      closed: false,
      faceForward: true,
      flat: true,
      translucent: false,
    }),
    asynchronous: false,
    modelMatrix,
    releaseGeometryInstances: false,
  });
}

function createWirePrimitive(mesh: CanonicalMesh, modelMatrix: Matrix4): Primitive {
  const raisedPositions = mesh.positions.slice();
  for (let i = 2; i < raisedPositions.length; i += 3) raisedPositions[i] += 0.045;
  const geometry = createGeometry(raisedPositions, buildEdgeIndices(mesh.indices), PrimitiveType.LINES);

  return new Primitive({
    geometryInstances: new GeometryInstance({
      id: `${mesh.id}-wire`,
      geometry,
      attributes: {
        color: ColorGeometryInstanceAttribute.fromColor(Color.WHITE.withAlpha(mesh.role === 'road' ? 0.72 : 0.22)),
      },
    }),
    appearance: new PerInstanceColorAppearance({
      closed: false,
      faceForward: true,
      flat: true,
      translucent: true,
    }),
    asynchronous: false,
    modelMatrix,
    releaseGeometryInstances: false,
  });
}

function createGeometry(positions: number[], indices: number[], primitiveType: number): Geometry {
  const values = new Float64Array(positions);
  const vertexCount = positions.length / 3;
  const attributes = new GeometryAttributes();
  attributes.position = new GeometryAttribute({
    componentDatatype: ComponentDatatype.DOUBLE,
    componentsPerAttribute: 3,
    values,
  });

  return new Geometry({
    attributes,
    indices: vertexCount < 65_536 ? new Uint16Array(indices) : new Uint32Array(indices),
    primitiveType,
    boundingSphere: BoundingSphere.fromVertices(positions),
  });
}

function buildEdgeIndices(triangleIndices: number[]): number[] {
  const edges = new Set<string>();
  const indices: number[] = [];

  for (let i = 0; i < triangleIndices.length; i += 3) {
    addEdge(triangleIndices[i], triangleIndices[i + 1]);
    addEdge(triangleIndices[i + 1], triangleIndices[i + 2]);
    addEdge(triangleIndices[i + 2], triangleIndices[i]);
  }

  return indices;

  function addEdge(a: number, b: number): void {
    const low = Math.min(a, b);
    const high = Math.max(a, b);
    const key = `${low}:${high}`;
    if (edges.has(key)) return;
    edges.add(key);
    indices.push(low, high);
  }
}

function createVertexPoints(meshes: CanonicalMesh[], modelMatrix: Matrix4): PointPrimitiveCollection {
  const collection = new PointPrimitiveCollection();
  const local = new Cartesian3();
  const world = new Cartesian3();

  for (const mesh of meshes) {
    const color = mesh.role === 'road' ? Color.WHITE : Color.fromCssColorString('#9fffc7');
    const stride = mesh.role === 'terrain' ? 2 : 1;

    for (let vertex = 0; vertex < mesh.positions.length / 3; vertex += stride) {
      const offset = vertex * 3;
      Cartesian3.fromElements(
        mesh.positions[offset],
        mesh.positions[offset + 1],
        mesh.positions[offset + 2] + 0.08,
        local,
      );
      Matrix4.multiplyByPoint(modelMatrix, local, world);
      collection.add({
        position: Cartesian3.clone(world),
        color,
        pixelSize: mesh.role === 'road' ? 4 : 2.5,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    }
  }

  return collection;
}
