import {
  Cartesian3,
  Color,
  EllipsoidTerrainProvider,
  ImageryLayer,
  Math as CesiumMath,
  OpenStreetMapImageryProvider,
  SceneMode,
  Viewer,
} from 'cesium';
import type { AreaSelection } from './osm-scene';

export interface AreaSelectionRenderer {
  viewer: Viewer;
  getSelection(): AreaSelection;
  setCenter(longitude: number, latitude: number): void;
  setSize(sizeMetres: number): void;
  focusSelection(): void;
  destroy(): void;
}

export function createAreaSelectionRenderer(
  containerId: string,
  initialSelection: AreaSelection,
  onChange: (selection: AreaSelection) => void,
): AreaSelectionRenderer {
  const viewer = new Viewer(containerId, {
    animation: false,
    baseLayer: false,
    baseLayerPicker: false,
    fullscreenButton: false,
    geocoder: false,
    homeButton: false,
    infoBox: false,
    navigationHelpButton: false,
    sceneMode: SceneMode.SCENE2D,
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
  osmLayer.alpha = 1;
  viewer.imageryLayers.add(osmLayer);

  viewer.scene.globe.show = true;
  viewer.scene.globe.depthTestAgainstTerrain = false;
  viewer.scene.globe.baseColor = Color.fromCssColorString('#07111f');
  if (viewer.scene.skyBox) viewer.scene.skyBox.show = false;
  if (viewer.scene.sun) viewer.scene.sun.show = false;
  if (viewer.scene.moon) viewer.scene.moon.show = false;
  if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = false;
  viewer.scene.fog.enabled = false;
  viewer.scene.backgroundColor = Color.fromCssColorString('#07111f');

  const controls = viewer.scene.screenSpaceCameraController;
  controls.enableTranslate = true;
  controls.enableZoom = true;
  controls.enableRotate = false;
  controls.enableTilt = false;
  controls.enableLook = false;
  controls.enableCollisionDetection = false;

  let selection = sanitiseSelection(initialSelection);

  function readViewportCentre(): { longitude: number; latitude: number } | null {
    const centre = viewer.camera.positionCartographic;
    if (!centre) return null;

    return {
      longitude: CesiumMath.toDegrees(centre.longitude),
      latitude: CesiumMath.toDegrees(centre.latitude),
    };
  }

  function syncSelectionFromViewport(notify: boolean): void {
    const centre = readViewportCentre();
    if (!centre) return;

    const next = sanitiseSelection({
      ...selection,
      longitude: centre.longitude,
      latitude: centre.latitude,
    });

    const changed = Math.abs(next.longitude - selection.longitude) > 1e-8
      || Math.abs(next.latitude - selection.latitude) > 1e-8;

    selection = next;
    if (notify && changed) onChange({ ...selection });
  }

  const removeMoveEndListener = viewer.camera.moveEnd.addEventListener(() => {
    syncSelectionFromViewport(true);
  });

  function focusSelection(): void {
    void viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(
        selection.longitude,
        selection.latitude,
        Math.max(1800, selection.sizeMetres * 1.85),
      ),
      duration: 0.45,
    });
  }

  focusSelection();

  return {
    viewer,
    getSelection(): AreaSelection {
      syncSelectionFromViewport(false);
      return { ...selection };
    },
    setCenter(longitude: number, latitude: number): void {
      selection = sanitiseSelection({ ...selection, longitude, latitude });
      onChange({ ...selection });
      focusSelection();
    },
    setSize(sizeMetres: number): void {
      syncSelectionFromViewport(false);
      selection = sanitiseSelection({ ...selection, sizeMetres });
      onChange({ ...selection });
      focusSelection();
    },
    focusSelection,
    destroy(): void {
      removeMoveEndListener();
      if (!viewer.isDestroyed()) viewer.destroy();
    },
  };
}

function sanitiseSelection(selection: AreaSelection): AreaSelection {
  return {
    longitude: Math.max(-180, Math.min(180, Number(selection.longitude))),
    latitude: Math.max(-85, Math.min(85, Number(selection.latitude))),
    sizeMetres: Math.max(500, Math.min(4000, Math.round(Number(selection.sizeMetres)))),
  };
}
