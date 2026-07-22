import 'cesium/Build/Cesium/Widgets/widgets.css';
import './styles.css';
import { buildSceneManifest, buildSyntheticScene, serializeScene, type CanonicalScene } from './core';
import {
  createTriWorldRenderer,
  type MapSquareSelection,
} from './cesium-renderer';
import {
  buildOsmScene,
  DEFAULT_OSM_SCENE_OPTIONS,
  type OsmSceneOptions,
  type OsmSceneStats,
} from './osm-scene';

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}

const selectedArea = readSceneOptions();
const app = requireElement<HTMLDivElement>('#app');
app.innerHTML = `
  <main class="loading-screen">
    <div class="loading-card">
      <p class="eyebrow">TriWorld v0.6</p>
      <h1>Building the selected square…</h1>
      <p>Downloading OpenStreetMap elements around ${selectedArea.latitude.toFixed(7)}, ${selectedArea.longitude.toFixed(7)} and converting road centre-lines into canonical indexed triangles.</p>
      <div class="loading-bar"><span></span></div>
    </div>
  </main>`;

let osmStats: OsmSceneStats | null = null;
let sourceError: string | null = null;
let scene: CanonicalScene;

try {
  const result = await buildOsmScene(selectedArea);
  scene = result.scene;
  osmStats = result.stats;
} catch (error) {
  sourceError = error instanceof Error ? error.message : 'Unknown OpenStreetMap loading error';
  const fallback = buildSyntheticScene();
  scene = {
    ...fallback,
    id: 'triworld-selected-area-fallback',
    anchor: {
      longitude: selectedArea.longitude,
      latitude: selectedArea.latitude,
      height: 0,
    },
  };
}

const manifest = buildSceneManifest(scene);
const terrain = manifest.meshes.find((mesh) => mesh.role === 'terrain');
const road = manifest.meshes.find((mesh) => mesh.role === 'road');
const coordinateLabel = `${scene.anchor.latitude.toFixed(7)}, ${scene.anchor.longitude.toFixed(7)}`;
const sourceIsLive = osmStats !== null;
let pendingSelection: MapSquareSelection = { ...selectedArea };

app.innerHTML = `
  <main class="shell">
    <header>
      <div>
        <p class="eyebrow">TriWorld v0.6 · map square selector</p>
        <h1>Draw a square. Fetch it. Build the map.</h1>
        <p class="lede">Move around the OpenStreetMap view, draw the exact square you want processed, then press <strong>Fetch & build map</strong>. No coordinate entry is required.</p>
      </div>
      <div class="stats">
        <span>${manifest.vertices.toLocaleString()} vertices</span>
        <span>${manifest.triangles.toLocaleString()} triangles</span>
        <span class="${sourceIsLive ? 'good' : 'bad'}">${sourceIsLive ? 'LIVE OSM ROADS' : 'FALLBACK'}</span>
        <span class="${manifest.validation.valid ? 'good' : 'bad'}">${manifest.validation.valid ? 'VALID' : 'INVALID'}</span>
      </div>
    </header>

    <section class="panel">
      <div class="viewport-card">
        <div id="cesiumContainer"></div>

        <div class="area-builder" id="areaBuilder">
          <div class="area-builder-heading">
            <span>New processing area</span>
            <strong id="selectionSize">${formatAreaSize(pendingSelection.sizeMetres)}</strong>
          </div>
          <p id="selectionCoordinates">${formatCoordinates(pendingSelection)}</p>
          <div class="area-builder-actions">
            <button id="drawSquare" type="button">1. Draw square</button>
            <button id="fetchSquare" type="button" class="primary">2. Fetch & build map</button>
          </div>
          <button id="cancelSquare" type="button" class="text-button" hidden>Cancel drawing</button>
          <small id="selectionStatus">Pan and zoom first. Then press Draw square and drag diagonally across the map.</small>
        </div>

        <div class="location-badge">
          <span>Currently compiled scene</span>
          <strong>${coordinateLabel}</strong>
        </div>
        <div class="viewport-badge">Canonical mesh hash <strong>${manifest.hash}</strong></div>
      </div>

      <aside>
        <div>
          <p class="section-label">Selected processing square</p>
          <div class="selected-area-card">
            <strong id="selectedAreaSize">${formatAreaSize(pendingSelection.sizeMetres)}</strong>
            <span id="selectedAreaCoordinates">${formatCoordinates(pendingSelection)}</span>
          </div>
        </div>

        <div class="scene-heading">
          <p class="section-label">Current CanonicalScene</p>
          <h2>${scene.id}</h2>
        </div>

        <dl>
          <div><dt>Compiled location</dt><dd>${coordinateLabel}</dd></div>
          <div><dt>Road source</dt><dd>${sourceIsLive ? 'OSM API v0.6' : 'Synthetic fallback'}</dd></div>
          <div><dt>Terrain source</dt><dd>${sourceIsLive ? 'Procedural preview' : 'Synthetic preview'}</dd></div>
          <div><dt>Frame</dt><dd>ENU / Z-up</dd></div>
          <div><dt>Compiled area</dt><dd>${sourceIsLive ? formatAreaSize(selectedArea.sizeMetres) : formatBounds()}</dd></div>
          <div><dt>Terrain</dt><dd>${terrain?.vertices ?? 0} v / ${terrain?.triangles ?? 0} t</dd></div>
          <div><dt>Road mesh</dt><dd>${road?.vertices ?? 0} v / ${road?.triangles ?? 0} t</dd></div>
          ${osmStats ? `<div><dt>OSM ways</dt><dd>${osmStats.waysImported}</dd></div>` : ''}
          ${osmStats ? `<div><dt>Road length</dt><dd>${(osmStats.totalLengthMetres / 1000).toFixed(2)} km</dd></div>` : ''}
        </dl>

        ${renderRoadNames(osmStats)}

        <p class="section-label control-heading">Map context</p>
        <div class="controls">
          <label><input id="map" type="checkbox" checked /> Real OSM map</label>
          <label class="range-label">
            <span>Map opacity</span>
            <input id="mapOpacity" type="range" min="0" max="100" value="72" />
          </label>
        </div>

        <p class="section-label control-heading">Canonical layers</p>
        <div class="controls">
          <label><input id="terrain" type="checkbox" checked /> Terrain preview</label>
          <label><input id="road" type="checkbox" checked /> OSM road mesh</label>
          <label><input id="wire" type="checkbox" checked /> Triangle edges</label>
          <label><input id="points" type="checkbox" /> Canonical vertices</label>
        </div>

        <div class="buttons">
          <button id="localView" type="button">Local triangle view</button>
          <button id="mapView" type="button">Map overview</button>
          <button id="download" type="button">Download scene JSON</button>
        </div>

        <div class="validation ${manifest.validation.valid ? 'valid' : 'invalid'}">
          <strong>${manifest.validation.valid ? 'Geometry validation passed' : 'Geometry validation failed'}</strong>
          <span>${manifest.validation.valid
            ? sourceIsLive
              ? 'Road plan geometry is compiled from current OSM data. The elevation surface is still an explicitly labelled procedural preview.'
              : 'Synthetic fallback geometry contains no invalid indices or degenerate faces.'
            : manifest.validation.errors.slice(0, 3).join(' · ')}</span>
        </div>
      </aside>
    </section>
  </main>`;

const renderer = createTriWorldRenderer('cesiumContainer', scene);
const drawSquareButton = requireElement<HTMLButtonElement>('#drawSquare');
const fetchSquareButton = requireElement<HTMLButtonElement>('#fetchSquare');
const cancelSquareButton = requireElement<HTMLButtonElement>('#cancelSquare');
const selectionSize = requireElement<HTMLElement>('#selectionSize');
const selectionCoordinates = requireElement<HTMLElement>('#selectionCoordinates');
const selectionStatus = requireElement<HTMLElement>('#selectionStatus');
const selectedAreaSize = requireElement<HTMLElement>('#selectedAreaSize');
const selectedAreaCoordinates = requireElement<HTMLElement>('#selectedAreaCoordinates');
const mapToggle = requireElement<HTMLInputElement>('#map');
const mapOpacity = requireElement<HTMLInputElement>('#mapOpacity');
const terrainToggle = requireElement<HTMLInputElement>('#terrain');
const roadToggle = requireElement<HTMLInputElement>('#road');
const wireToggle = requireElement<HTMLInputElement>('#wire');
const pointToggle = requireElement<HTMLInputElement>('#points');
const localViewButton = requireElement<HTMLButtonElement>('#localView');
const mapViewButton = requireElement<HTMLButtonElement>('#mapView');
const downloadButton = requireElement<HTMLButtonElement>('#download');

renderer.setAreaSelection(pendingSelection);
renderer.setMapOpacity(Number(mapOpacity.value) / 100);
renderer.showMapOverview();

drawSquareButton.addEventListener('click', () => {
  drawSquareButton.disabled = true;
  fetchSquareButton.disabled = true;
  cancelSquareButton.hidden = false;
  selectionStatus.textContent = 'Drawing mode: drag diagonally from one corner to the opposite corner. A simple click moves the current square.';
  selectionStatus.classList.add('active');

  renderer.beginAreaSelection(
    (selection) => {
      pendingSelection = selection;
      updateSelectionReadout();
    },
    (selection) => {
      pendingSelection = selection;
      updateSelectionReadout();
      endDrawingMode('Square ready. Press Fetch & build map.');
    },
  );
});

cancelSquareButton.addEventListener('click', () => {
  renderer.cancelAreaSelection();
  renderer.setAreaSelection(pendingSelection);
  endDrawingMode('Drawing cancelled. The last selected square is still ready.');
});

fetchSquareButton.addEventListener('click', () => {
  selectionStatus.textContent = 'Fetching OpenStreetMap and building canonical triangles…';
  selectionStatus.classList.add('active');
  fetchSquareButton.disabled = true;
  drawSquareButton.disabled = true;

  const params = new URLSearchParams();
  params.set('lat', pendingSelection.latitude.toFixed(7));
  params.set('lon', pendingSelection.longitude.toFixed(7));
  params.set('size', String(Math.round(pendingSelection.sizeMetres)));
  window.location.search = params.toString();
});

mapToggle.addEventListener('change', () => renderer.setMapVisible(mapToggle.checked));
mapOpacity.addEventListener('input', () => renderer.setMapOpacity(Number(mapOpacity.value) / 100));
terrainToggle.addEventListener('change', () => renderer.setTerrainVisible(terrainToggle.checked));
roadToggle.addEventListener('change', () => renderer.setRoadVisible(roadToggle.checked));
wireToggle.addEventListener('change', () => renderer.setWireframeVisible(wireToggle.checked));
pointToggle.addEventListener('change', () => renderer.setVerticesVisible(pointToggle.checked));
localViewButton.addEventListener('click', () => renderer.resetCamera());
mapViewButton.addEventListener('click', () => renderer.showMapOverview());
downloadButton.addEventListener('click', downloadScene);
window.addEventListener('beforeunload', () => renderer.destroy(), { once: true });

function endDrawingMode(message: string): void {
  drawSquareButton.disabled = false;
  drawSquareButton.textContent = '1. Draw another square';
  fetchSquareButton.disabled = false;
  cancelSquareButton.hidden = true;
  selectionStatus.textContent = message;
  selectionStatus.classList.remove('active');
}

function updateSelectionReadout(): void {
  const sizeText = formatAreaSize(pendingSelection.sizeMetres);
  const coordinateText = formatCoordinates(pendingSelection);
  selectionSize.textContent = sizeText;
  selectionCoordinates.textContent = coordinateText;
  selectedAreaSize.textContent = sizeText;
  selectedAreaCoordinates.textContent = coordinateText;
}

function readSceneOptions(): OsmSceneOptions {
  const params = new URLSearchParams(window.location.search);
  const latitude = Number(params.get('lat'));
  const longitude = Number(params.get('lon'));
  const sizeMetres = Number(params.get('size'));
  const candidate: OsmSceneOptions = {
    latitude: Number.isFinite(latitude) && params.has('lat') ? latitude : DEFAULT_OSM_SCENE_OPTIONS.latitude,
    longitude: Number.isFinite(longitude) && params.has('lon') ? longitude : DEFAULT_OSM_SCENE_OPTIONS.longitude,
    sizeMetres: Number.isFinite(sizeMetres) && params.has('size') ? sizeMetres : DEFAULT_OSM_SCENE_OPTIONS.sizeMetres,
  };
  return validateSceneOptions(candidate) ? DEFAULT_OSM_SCENE_OPTIONS : candidate;
}

function validateSceneOptions(options: OsmSceneOptions): string | null {
  if (!Number.isFinite(options.latitude) || options.latitude < -85 || options.latitude > 85) {
    return 'Latitude must be between -85 and 85 degrees.';
  }
  if (!Number.isFinite(options.longitude) || options.longitude < -180 || options.longitude > 180) {
    return 'Longitude must be between -180 and 180 degrees.';
  }
  if (!Number.isFinite(options.sizeMetres) || options.sizeMetres < 250 || options.sizeMetres > 2000) {
    return 'Area size must be between 250 and 2000 metres.';
  }
  return null;
}

function formatAreaSize(sizeMetres: number): string {
  const kilometres = sizeMetres / 1000;
  const label = kilometres >= 1 ? kilometres.toFixed(kilometres % 1 === 0 ? 0 : 2) : `${Math.round(sizeMetres)} m`;
  return kilometres >= 1 ? `${label} × ${label} km` : `${label} × ${label}`;
}

function formatCoordinates(selection: Pick<MapSquareSelection, 'latitude' | 'longitude'>): string {
  return `${selection.latitude.toFixed(7)}, ${selection.longitude.toFixed(7)}`;
}

function downloadScene(): void {
  const blob = new Blob([serializeScene(scene, manifest)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${scene.id}-${manifest.hash}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function renderRoadNames(stats: OsmSceneStats | null): string {
  if (!stats || stats.namedRoads.length === 0) return '';
  const visibleNames = stats.namedRoads.slice(0, 12);
  const remainder = stats.namedRoads.length - visibleNames.length;
  return `
    <div class="road-list">
      <p class="section-label">Named OSM roads</p>
      <div>${visibleNames.map((name) => `<span>${escapeHtml(name)}</span>`).join('')}</div>
      ${remainder > 0 ? `<small>+ ${remainder} more</small>` : ''}
    </div>`;
}

function formatBounds(): string {
  const { min, max } = manifest.bounds;
  const width = max[0] - min[0];
  const depth = max[1] - min[1];
  const height = max[2] - min[2];
  return `${width.toFixed(0)} × ${depth.toFixed(0)} × ${height.toFixed(1)} m`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
