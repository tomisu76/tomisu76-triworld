import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cartographic,
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
  Rectangle,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Transforms,
  Viewer,
} from 'cesium';
import type { CanonicalMaterial, CanonicalMesh, CanonicalScene } from './core';

export interface MapSquareSelection {
  latitude: number;
  longitude: number;
  sizeMetres: number;
}

export interface TriWorldRenderer {
  viewer: Viewer;
  setMapVisible(visible: boolean): void;
  setMapOpacity(opacity: number): void;
  setTerrainVisible(visible: boolean): void;
  setRoadVisible(visible: boolean): void;
  setWireframeVisible(visible: boolean): void;
  setVerticesVisible(visible: boolean): void;
  setAreaSelection(selection: MapSquareSelection): void;
  beginAreaSelection(
    onPreview: (selection: MapSquareSelection) => void,
    onComplete: (selection: MapSquareSelection) => void,
  ): void;
  cancelAreaSelection(): void;
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
  osmLayer.alpha = 0.72;
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

  const metrics = computeSceneMetrics(scene.meshes);
  const anchor = Cartesian3.fromDegrees(scene.anchor.longitude, scene.anchor.latitude, scene.anchor.height);
  const enuMatrix = Transforms.eastNorthUpToFixedFrame(anchor);
  const localLift = Matrix4.fromTranslation(new Cartesian3(0, 0, metrics.verticalOffset));
  const modelMatrix = Matrix4.multiply(enuMatrix, localLift, new Matrix4());
  const materials = new Map(scene.materials.map((material) => [material.id, material]));
  const surfacePrimitives = new Map<string, Primitive>();
  const wirePrimitives = new Map<string, Primitive>();
  let mapVisible = true;
  let terrainVisible = true;
  let roadVisible = true;
  let wireVisible = true;
  let currentSelection: MapSquareSelection = {
    latitude: scene.anchor.latitude,
    longitude: scene.anchor.longitude,
    sizeMetres: Math.min(2000, Math.max(250, metrics.planSize)),
  };
  let selectionHandler: ScreenSpaceEventHandler | null = null;
  let selectionStart: GeographicPoint | null = null;
  let previewSelection: MapSquareSelection | null = null;

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
      scene.anchor.height + metrics.verticalOffset + 12,
    ),
    point: {
      pixelSize: 13,
      color: Color.fromCssColorString('#ff3eae'),
      outlineColor: Color.WHITE,
      outlineWidth: 2,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      text: `Compiled scene anchor\n${scene.anchor.latitude.toFixed(7)}, ${scene.anchor.longitude.toFixed(7)}`,
      font: '13px Inter, sans-serif',
      fillColor: Color.WHITE,
      showBackground: true,
      backgroundColor: Color.fromCssColorString('#07111f').withAlpha(0.82),
      pixelOffset: new Cartesian2(0, -34),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });

  const selectionEntity = viewer.entities.add({
    id: 'triworld-processing-square',
    rectangle: {
      coordinates: selectionToRectangle(currentSelection),
      material: Color.fromCssColorString('#22d3ee').withAlpha(0.18),
      outline: true,
      outlineColor: Color.fromCssColorString('#b7f7ff'),
      height: 2,
    },
  });

  function roleVisible(mesh: CanonicalMesh): boolean {
    return mesh.role === 'terrain' ? terrainVisible : roadVisible;
  }

  function applyVisibility(): void {
    viewer.scene.globe.show = mapVisible;
    osmLayer.show = mapVisible;
    anchorEntity.show = mapVisible;
    selectionEntity.show = mapVisible;

    for (const mesh of scene.meshes) {
      const visible = roleVisible(mesh);
      const surface = surfacePrimitives.get(mesh.id);
      const wire = wirePrimitives.get(mesh.id);
      if (surface) surface.show = visible;
      if (wire) wire.show = visible && wireVisible;
    }
    viewer.scene.requestRender();
  }

  function setAreaSelection(selection: MapSquareSelection): void {
    currentSelection = normalizeSelection(selection);
    const rectangleGraphics = selectionEntity.rectangle;
    if (rectangleGraphics) rectangleGraphics.coordinates = selectionToRectangle(currentSelection);
    viewer.scene.requestRender();
  }

  function beginAreaSelection(
    onPreview: (selection: MapSquareSelection) => void,
    onComplete: (selection: MapSquareSelection) => void,
  ): void {
    cancelAreaSelection();
    selectionHandler = new ScreenSpaceEventHandler(viewer.scene.canvas);
    viewer.scene.canvas.classList.add('drawing-area');

    selectionHandler.setInputAction((movement: { position: Cartesian2 }) => {
      const point = screenToGeographic(movement.position);
      if (!point) return;
      selectionStart = point;
      previewSelection = null;
      setCameraDragEnabled(false);
    }, ScreenSpaceEventType.LEFT_DOWN);

    selectionHandler.setInputAction((movement: { endPosition: Cartesian2 }) => {
      if (!selectionStart) return;
      const point = screenToGeographic(movement.endPosition);
      if (!point) return;
      previewSelection = squareFromCorners(selectionStart, point);
      setAreaSelection(previewSelection);
      onPreview(previewSelection);
    }, ScreenSpaceEventType.MOUSE_MOVE);

    selectionHandler.setInputAction((movement: { position: Cartesian2 }) => {
      if (!selectionStart) return;
      const point = screenToGeographic(movement.position) ?? selectionStart;
      const rawDistance = geographicDistanceMetres(selectionStart, point);
      const completed = rawDistance < 35
        ? {
            latitude: point.latitude,
            longitude: point.longitude,
            sizeMetres: currentSelection.sizeMetres,
          }
        : previewSelection ?? squareFromCorners(selectionStart, point);

      setAreaSelection(completed);
      onPreview(completed);
      onComplete(completed);
      selectionStart = null;
      previewSelection = null;
      setCameraDragEnabled(true);
      cancelAreaSelection(false);
    }, ScreenSpaceEventType.LEFT_UP);
  }

  function cancelAreaSelection(restoreCamera = true): void {
    if (selectionHandler && !selectionHandler.isDestroyed()) selectionHandler.destroy();
    selectionHandler = null;
    selectionStart = null;
    previewSelection = null;
    viewer.scene.canvas.classList.remove('drawing-area');
    if (restoreCamera) setCameraDragEnabled(true);
  }

  function setCameraDragEnabled(enabled: boolean): void {
    const controller = viewer.scene.screenSpaceCameraController;
    controller.enableRotate = enabled;
    controller.enableTranslate = enabled;
    controller.enableTilt = enabled;
  }

  function screenToGeographic(position: Cartesian2): GeographicPoint | null {
    const cartesian = viewer.camera.pickEllipsoid(position, viewer.scene.globe.ellipsoid);
    if (!cartesian) return null;
    const cartographic = Cartographic.fromCartesian(cartesian);
    return {
      longitude: CesiumMath.toDegrees(cartographic.longitude),
      latitude: CesiumMath.toDegrees(cartographic.latitude),
    };
  }

  function resetCamera(): void {
    viewer.camera.lookAtTransform(
      modelMatrix,
      new Cartesian3(metrics.radius * 1.15, -metrics.radius * 1.35, metrics.radius * 0.92),
    );
    viewer.scene.requestRender();
  }

  function showMapOverview(): void {
    viewer.camera.lookAtTransform(Matrix4.IDENTITY);
    void viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(
        currentSelection.longitude,
        currentSelection.latitude,
        Math.max(1450, currentSelection.sizeMetres * 1.65),
      ),
      orientation: {
        heading: 0,
        pitch: CesiumMath.toRadians(-86),
        roll: 0,
      },
      duration: 0.9,
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
    setAreaSelection,
    beginAreaSelection,
    cancelAreaSelection,
    resetCamera,
    showMapOverview,
    destroy(): void {
      cancelAreaSelection();
      if (!viewer.isDestroyed()) viewer.destroy();
    },
  };
}

type GeographicPoint = {
  latitude: number;
  longitude: number;
};

function normalizeSelection(selection: MapSquareSelection): MapSquareSelection {
  return {
    latitude: Math.max(-85, Math.min(85, selection.latitude)),
    longitude: wrapLongitude(selection.longitude),
    sizeMetres: Math.max(250, Math.min(2000, Math.round(selection.sizeMetres))),
  };
}

function squareFromCorners(start: GeographicPoint, end: GeographicPoint): MapSquareSelection {
  const metresPerDegreeLatitude = 111_320;
  const meanLatitude = (start.latitude + end.latitude) / 2;
  const metresPerDegreeLongitude = metresPerDegreeLatitude * Math.max(0.05, Math.cos(CesiumMath.toRadians(meanLatitude)));
  const dx = (end.longitude - start.longitude) * metresPerDegreeLongitude;
  const dy = (end.latitude - start.latitude) * metresPerDegreeLatitude;
  const side = Math.max(250, Math.min(2000, Math.max(Math.abs(dx), Math.abs(dy))));
  const signedX = (dx < 0 ? -1 : 1) * side;
  const signedY = (dy < 0 ? -1 : 1) * side;

  return normalizeSelection({
    longitude: start.longitude + signedX / metresPerDegreeLongitude / 2,
    latitude: start.latitude + signedY / metresPerDegreeLatitude / 2,
    sizeMetres: side,
  });
}

function geographicDistanceMetres(a: GeographicPoint, b: GeographicPoint): number {
  const metresPerDegreeLatitude = 111_320;
  const metresPerDegreeLongitude = metresPerDegreeLatitude * Math.max(0.05, Math.cos(CesiumMath.toRadians((a.latitude + b.latitude) / 2)));
  return Math.hypot(
    (b.longitude - a.longitude) * metresPerDegreeLongitude,
    (b.latitude - a.latitude) * metresPerDegreeLatitude,
  );
}

function selectionToRectangle(selection: MapSquareSelection): Rectangle {
  const half = selection.sizeMetres / 2;
  const metresPerDegreeLatitude = 111_320;
  const metresPerDegreeLongitude = metresPerDegreeLatitude * Math.max(0.05, Math.cos(CesiumMath.toRadians(selection.latitude)));
  const latitudeDelta = half / metresPerDegreeLatitude;
  const longitudeDelta = half / metresPerDegreeLongitude;

  return Rectangle.fromDegrees(
    selection.longitude - longitudeDelta,
    selection.latitude - latitudeDelta,
    selection.longitude + longitudeDelta,
    selection.latitude + latitudeDelta,
  );
}

function wrapLongitude(value: number): number {
  return ((((value + 180) % 360) + 360) % 360) - 180;
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
  for (let index = 2; index < raisedPositions.length; index += 3) raisedPositions[index] += 0.045;
  const geometry = createGeometry(raisedPositions, buildEdgeIndices(mesh.indices), PrimitiveType.LINES);

  return new Primitive({
    geometryInstances: new GeometryInstance({
      id: `${mesh.id}-wire`,
      geometry,
      attributes: {
        color: ColorGeometryInstanceAttribute.fromColor(Color.WHITE.withAlpha(mesh.role === 'road' ? 0.72 : 0.18)),
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

  for (let index = 0; index < triangleIndices.length; index += 3) {
    addEdge(triangleIndices[index], triangleIndices[index + 1]);
    addEdge(triangleIndices[index + 1], triangleIndices[index + 2]);
    addEdge(triangleIndices[index + 2], triangleIndices[index]);
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
    const stride = mesh.role === 'terrain' ? 4 : 1;

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

function computeSceneMetrics(meshes: CanonicalMesh[]): { radius: number; verticalOffset: number; planSize: number } {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const mesh of meshes) {
    for (let index = 0; index < mesh.positions.length; index += 3) {
      minX = Math.min(minX, mesh.positions[index]);
      minY = Math.min(minY, mesh.positions[index + 1]);
      minZ = Math.min(minZ, mesh.positions[index + 2]);
      maxX = Math.max(maxX, mesh.positions[index]);
      maxY = Math.max(maxY, mesh.positions[index + 1]);
      maxZ = Math.max(maxZ, mesh.positions[index + 2]);
    }
  }

  const width = maxX - minX;
  const depth = maxY - minY;
  const height = maxZ - minZ;
  const radius = Math.max(90, Math.hypot(width, depth, height) * 0.56);
  const verticalOffset = Math.max(2, 3 - minZ);
  const planSize = Math.max(width, depth);
  return { radius, verticalOffset, planSize };
}
