import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  EllipsoidTerrainProvider,
  ImageryLayer,
  Math as CesiumMath,
  OpenStreetMapImageryProvider,
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
  viewer.scene.screenSpaceCameraController.enableCollisionDetection = false;
  viewer.scene.screenSpaceCameraController.enableRotate = false;
  viewer.scene.screenSpaceCameraController.enableTilt = false;
  viewer.scene.screenSpaceCameraController.enableLook = false;

  let selection = sanitiseSelection(initialSelection);

  function readViewportCentre(): { longitude: number; latitude: number } | null {
    const canvas = viewer.scene.canvas;
    const centre = new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
    const picked = viewer.camera.pickEllipsoid(centre, viewer.scene.globe.ellipsoid);
    if (!picked) return null;

    const cartographic = Cartographic.fromCartesian(picked);
    return {
      longitude: CesiumMath.toDegrees(cartographic.longitude),
      latitude: CesiumMath.toDegrees(cartographic.latitude),
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
      orientation: {
        heading: 0,
        pitch: CesiumMath.toRadians(-89.5),
        roll: 0,
      },
      duration: 0.65,
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
