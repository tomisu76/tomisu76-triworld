import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  EllipsoidTerrainProvider,
  ImageryLayer,
  Math as CesiumMath,
  OpenStreetMapImageryProvider,
  Rectangle,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Viewer,
} from 'cesium';
import { selectionToBbox, type AreaSelection } from './osm-scene';

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
  viewer.scene.globe.baseColor = Color.fromCssColorString('#dce7d3');
  if (viewer.scene.skyBox) viewer.scene.skyBox.show = false;
  if (viewer.scene.sun) viewer.scene.sun.show = false;
  if (viewer.scene.moon) viewer.scene.moon.show = false;
  if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = false;
  viewer.scene.fog.enabled = false;
  viewer.scene.backgroundColor = Color.fromCssColorString('#dce7d3');
  viewer.scene.screenSpaceCameraController.enableCollisionDetection = false;

  let selection = sanitiseSelection(initialSelection);
  let areaEntity = addAreaEntity();
  let centreEntity = addCentreEntity();

  const clickHandler = new ScreenSpaceEventHandler(viewer.scene.canvas);
  clickHandler.setInputAction((event: { position: Cartesian2 }) => {
    const picked = viewer.camera.pickEllipsoid(event.position, viewer.scene.globe.ellipsoid);
    if (!picked) return;
    const cartographic = Cartographic.fromCartesian(picked);
    selection = sanitiseSelection({
      ...selection,
      longitude: CesiumMath.toDegrees(cartographic.longitude),
      latitude: CesiumMath.toDegrees(cartographic.latitude),
    });
    refreshSelection();
    onChange({ ...selection });
  }, ScreenSpaceEventType.LEFT_CLICK);

  function addAreaEntity() {
    const [west, south, east, north] = selectionToBbox(selection);
    return viewer.entities.add({
      id: 'triworld-selected-area',
      rectangle: {
        coordinates: Rectangle.fromDegrees(west, south, east, north),
        material: Color.fromCssColorString('#ff6a00').withAlpha(0.18),
        outline: true,
        outlineColor: Color.fromCssColorString('#ff6a00'),
        outlineWidth: 3,
        height: 1,
      },
    });
  }

  function addCentreEntity() {
    return viewer.entities.add({
      id: 'triworld-selected-centre',
      position: Cartesian3.fromDegrees(selection.longitude, selection.latitude, 8),
      point: {
        pixelSize: 11,
        color: Color.fromCssColorString('#ff6a00'),
        outlineColor: Color.WHITE,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: `${formatKilometres(selection.sizeMetres)} selected area`,
        font: '600 13px Inter, sans-serif',
        fillColor: Color.fromCssColorString('#1f2937'),
        showBackground: true,
        backgroundColor: Color.WHITE.withAlpha(0.92),
        pixelOffset: new Cartesian2(0, -30),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  function refreshSelection(): void {
    viewer.entities.remove(areaEntity);
    viewer.entities.remove(centreEntity);
    areaEntity = addAreaEntity();
    centreEntity = addCentreEntity();
    viewer.scene.requestRender();
  }

  function focusSelection(): void {
    void viewer.camera.flyTo({
      destination: Cartesian3.fromDegrees(
        selection.longitude,
        selection.latitude,
        Math.max(1800, selection.sizeMetres * 1.85),
      ),
      orientation: {
        heading: 0,
        pitch: CesiumMath.toRadians(-82),
        roll: 0,
      },
      duration: 0.8,
    });
  }

  focusSelection();

  return {
    viewer,
    getSelection(): AreaSelection {
      return { ...selection };
    },
    setCenter(longitude: number, latitude: number): void {
      selection = sanitiseSelection({ ...selection, longitude, latitude });
      refreshSelection();
      focusSelection();
      onChange({ ...selection });
    },
    setSize(sizeMetres: number): void {
      selection = sanitiseSelection({ ...selection, sizeMetres });
      refreshSelection();
      focusSelection();
      onChange({ ...selection });
    },
    focusSelection,
    destroy(): void {
      clickHandler.destroy();
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

function formatKilometres(sizeMetres: number): string {
  const kilometres = sizeMetres / 1000;
  const label = Number.isInteger(kilometres) ? kilometres.toFixed(0) : kilometres.toFixed(1);
  return `${label} × ${label} km`;
}
