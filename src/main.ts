import 'cesium/Build/Cesium/Widgets/widgets.css';
import './styles.css';
import { buildSceneManifest, buildSyntheticScene, serializeScene, type CanonicalScene } from './core';
import { createTriWorldRenderer } from './cesium-renderer';
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
      <p class="eyebrow">TriWorld v0.5</p>
      <h1>Compiling the selected road network…</h1>
      <p>Downloading OpenStreetMap elements around ${selectedArea.latitude.toFixed(7)}, ${selectedArea.longitude.toFixed(7)} and converting highway centre-lines into canonical indexed triangles.</p>
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

app.innerHTML = `
  <main class="shell">
    <header>
      <div>
        <p class="eyebrow">TriWorld v0.5 · selectable OSM road compiler</p>
        <h1>${sourceIsLive ? 'Choose a place. Compile its roads.' : 'OSM fallback active.'}</h1>
        <p class="lede">${sourceIsLive
          ? `Driveable OpenStreetMap ways inside a ${formatAreaSize(selectedArea.sizeMetres)} site at <strong>${coordinateLabel}</strong> are converted into the same local ENU / Z-up triangle buffers intended for BeamNG.`
          : `The live OSM request failed, so the synthetic diagnostic scene is shown at the selected anchor. <strong>${escapeHtml(sourceError ?? '')}</strong>`}</p>
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
        <div class="location-badge">
          <span>Geographic anchor</span>
          <strong>${coordinateLabel}</strong>
        </div>
        <div class="viewport-badge">Canonical mesh hash <strong>${manifest.hash}</strong></div>
      </div>

      <aside>
        <div>
          <p class="section-label">Select processing area</p>
          <form id="locationForm" class="location-form" novalidate>
            <div class="coordinate-grid">
              <label>
                <span>Latitude</span>
                <input id="latitude" name="latitude" type="number" inputmode="decimal" step="any" min="-85" max="85" value="${selectedArea.latitude}" required />
              </label>
              <label>
                <span>Longitude</span>
                <input id="longitude" name="longitude" type="number" inputmode="decimal" step="any" min="-180" max="180" value="${selectedArea.longitude}" required />
              </label>
              <label class="area-size-field">
                <span>Area size</span>
                <select id="areaSize" name="areaSize">
                  ${renderSizeOptions(selectedArea.sizeMetres)}
                </select>
              </label>
            </div>
            <button type="submit" class="primary">Generate selected area</button>
            <p id="locationStatus" class="location-status">Paste coordinates from Google Maps or any GIS application.</p>
          </form>
        </div>

        <div class="scene-heading">
          <p class="section-label">CanonicalScene</p>
          <h2>${scene.id}</h2>
        </div>

        <dl>
          <div><dt>Location</dt><dd>${coordinateLabel}</dd></div>
          <div><dt>Road source</dt><dd>${sourceIsLive ? 'OSM API v0.6' : 'Synthetic fallback'}</dd></div>
          <div><dt>Terrain source</dt><dd>${sourceIsLive ? 'Procedural preview' : 'Synthetic preview'}</dd></div>
          <div><dt>Frame</dt><dd>ENU / Z-up</dd></div>
          <div><dt>Area</dt><dd>${sourceIsLive ? formatAreaSize(selectedArea.sizeMetres) : formatBounds()}</dd></div>
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
          <button id="download" type="button" class="primary">Download scene JSON</button>
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
const locationForm = requireElement<HTMLFormElement>('#locationForm');
const latitudeInput = requireElement<HTMLInputElement>('#latitude');
const longitudeInput = requireElement<HTMLInputElement>('#longitude');
const areaSizeInput = requireElement<HTMLSelectElement>('#areaSize');
const locationStatus = requireElement<HTMLParagraphElement>('#locationStatus');
const mapToggle = requireElement<HTMLInputElement>('#map');
const mapOpacity = requireElement<HTMLInputElement>('#mapOpacity');
const terrainToggle = requireElement<HTMLInputElement>('#terrain');
const roadToggle = requireElement<HTMLInputElement>('#road');
const wireToggle = requireElement<HTMLInputElement>('#wire');
const pointToggle = requireElement<HTMLInputElement>('#points');
const localViewButton = requireElement<HTMLButtonElement>('#localView');
const mapViewButton = requireElement<HTMLButtonElement>('#mapView');
const downloadButton = requireElement<HTMLButtonElement>('#download');

locationForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const latitude = Number(latitudeInput.value);
  const longitude = Number(longitudeInput.value);
  const sizeMetres = Number(areaSizeInput.value);
  const validationError = validateSceneOptions({ latitude, longitude, sizeMetres });

  if (validationError) {
    locationStatus.textContent = validationError;
    locationStatus.classList.add('error');
    return;
  }

  locationStatus.textContent = 'Loading selected OpenStreetMap area…';
  locationStatus.classList.remove('error');
  const params = new URLSearchParams(window.location.search);
  params.set('lat', latitude.toFixed(7));
  params.set('lon', longitude.toFixed(7));
  params.set('size', String(Math.round(sizeMetres)));
  window.location.search = params.toString();
});

renderer.setMapOpacity(Number(mapOpacity.value) / 100);
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

function renderSizeOptions(selectedSize: number): string {
  return [500, 1000, 1500, 2000]
    .map((size) => `<option value="${size}"${size === selectedSize ? ' selected' : ''}>${formatAreaSize(size)}</option>`)
    .join('');
}

function formatAreaSize(sizeMetres: number): string {
  const kilometres = sizeMetres / 1000;
  const label = Number.isInteger(kilometres) ? kilometres.toFixed(0) : kilometres.toFixed(1);
  return `${label} × ${label} km`;
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
  return `${width.toFixed(0)} × ${depth.toFixed(0)} × ${height.toFixed(1)}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
