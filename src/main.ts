import 'cesium/Build/Cesium/Widgets/widgets.css';
import './styles.css';
import { buildSceneManifest, serializeScene, type CanonicalScene, type SceneManifest } from './core';
import { createTriWorldRenderer, type TriWorldRenderer } from './cesium-renderer';
import {
  buildOsmScene,
  DEFAULT_AREA_SELECTION,
  selectionToBbox,
  type AreaSelection,
  type OsmSceneResult,
  type OsmSceneStats,
} from './osm-scene';
import { createAreaSelectionRenderer, type AreaSelectionRenderer } from './selection-renderer';

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}

const app = requireElement<HTMLDivElement>('#app');
let selection: AreaSelection = { ...DEFAULT_AREA_SELECTION };
let selectionRenderer: AreaSelectionRenderer | null = null;
let sceneRenderer: TriWorldRenderer | null = null;
let generatedScene: CanonicalScene | null = null;
let generatedManifest: SceneManifest | null = null;

renderSelectionMode();
window.addEventListener('beforeunload', destroyRenderers, { once: true });

function renderSelectionMode(message?: { type: 'error' | 'info'; text: string }): void {
  destroyRenderers();
  generatedScene = null;
  generatedManifest = null;

  app.innerHTML = renderShell(`
    ${renderBrand()}
    <div class="mode-tabs" aria-label="Job mode">
      <button class="mode-tab active" type="button">▣ Single Area</button>
      <button class="mode-tab" type="button" disabled>▦ Batch Job</button>
    </div>

    <section class="workflow-section">
      <div class="section-title-row">
        <span class="step-number">1</span>
        <div>
          <h2>Select area</h2>
          <p>Move the map beneath the fixed selection square. The centre of the screen becomes the output centre.</p>
        </div>
      </div>

      <label class="field-label" for="areaSize">Area size</label>
      <select id="areaSize" class="field-control">
        ${[1000, 2000, 3000, 4000]
          .map((size) => `<option value="${size}" ${size === selection.sizeMetres ? 'selected' : ''}>${formatArea(size)}</option>`)
          .join('')}
      </select>

      <div class="coordinate-grid">
        <label>
          <span>Latitude</span>
          <input id="latitude" class="field-control" type="number" step="0.000001" value="${selection.latitude.toFixed(7)}" />
        </label>
        <label>
          <span>Longitude</span>
          <input id="longitude" class="field-control" type="number" step="0.000001" value="${selection.longitude.toFixed(7)}" />
        </label>
      </div>

      <button id="focusArea" class="secondary-action" type="button">Return map to entered coordinates</button>
    </section>

    <section class="workflow-section compact">
      <div class="selection-summary">
        <span>Selected output area</span>
        <strong id="selectedAreaLabel">${formatArea(selection.sizeMetres)}</strong>
        <small id="bboxLabel">${formatBbox(selection)}</small>
      </div>
    </section>

    <button id="generate" class="generate-button" type="button">
      <span>▲</span>
      <span><strong>Generate Area</strong><small>Fetch OSM and DMR, engineer road profiles and reshape the terrain</small></span>
    </button>

    <div id="status" class="status-card ${message?.type ?? 'idle'}">
      <strong>${message?.type === 'error' ? 'Generation failed' : 'Ready to generate'}</strong>
      <span>${message?.text ?? 'No road, elevation or earthwork calculation runs until Generate Area is pressed.'}</span>
    </div>

    <section class="workflow-section output-section">
      <h3>Output settings</h3>
      <label class="field-label">Canonical grid</label>
      <div class="readonly-control">Approximately 12.5 m spacing · official DMR heights · 1.0× vertical scale</div>
      <label class="check-row"><input type="checkbox" checked disabled /> Engineer OSM road centre lines in 3D</label>
      <label class="check-row"><input type="checkbox" checked disabled /> Apply shoulders, cut/fill and terrain blending</label>
      <label class="check-row"><input type="checkbox" checked disabled /> Include GKÚ SR DMR 5.0 elevation grid</label>
      <p class="muted-note">The road mesh and terrain bed use the same grade-limited profile. Roads are no longer placed independently above an unchanged DEM.</p>
    </section>
  `, `
    <div class="map-tabs">
      <button class="map-tab active" type="button">◉ 2D Map</button>
      <button class="map-tab" type="button" disabled>▰ 3D Preview</button>
      <button class="map-tab" type="button" disabled>◇ Cesium Preview</button>
    </div>
    <div class="map-hint">Drag the map under the fixed frame · <strong id="mapAreaLabel">${formatArea(selection.sizeMetres)}</strong></div>
    <div class="fixed-area-selector" aria-hidden="true">
      <div class="selector-crosshair"></div>
      <div class="selector-label">
        <strong id="fixedAreaLabel">${formatArea(selection.sizeMetres)}</strong>
        <span id="selectorCoordinateLabel">${formatCoordinates(selection)}</span>
      </div>
    </div>
  `);

  selectionRenderer = createAreaSelectionRenderer('cesiumContainer', selection, (nextSelection) => {
    selection = nextSelection;
    syncSelectionControls();
  });

  const areaSize = requireElement<HTMLSelectElement>('#areaSize');
  const latitude = requireElement<HTMLInputElement>('#latitude');
  const longitude = requireElement<HTMLInputElement>('#longitude');
  const focusArea = requireElement<HTMLButtonElement>('#focusArea');
  const generate = requireElement<HTMLButtonElement>('#generate');

  areaSize.addEventListener('change', () => {
    selectionRenderer?.setSize(Number(areaSize.value));
  });

  const applyCoordinates = (): void => {
    const nextLatitude = Number(latitude.value);
    const nextLongitude = Number(longitude.value);
    if (!Number.isFinite(nextLatitude) || !Number.isFinite(nextLongitude)) {
      setStatus('error', 'Coordinates must be valid numbers.');
      return;
    }
    selectionRenderer?.setCenter(nextLongitude, nextLatitude);
    setStatus('idle', 'Selection updated. Press Generate Area when ready.');
  };

  latitude.addEventListener('change', applyCoordinates);
  longitude.addEventListener('change', applyCoordinates);
  focusArea.addEventListener('click', () => selectionRenderer?.focusSelection());
  generate.addEventListener('click', () => void generateSelectedArea());
}

async function generateSelectedArea(): Promise<void> {
  if (!selectionRenderer) return;
  selection = selectionRenderer.getSelection();
  const generateButton = requireElement<HTMLButtonElement>('#generate');
  generateButton.disabled = true;
  generateButton.classList.add('busy');
  setStatus('working', 'Downloading OSM and DMR data, then engineering road profiles and terrain earthworks…');

  try {
    await nextPaint();
    const result = await buildOsmScene(selection);
    renderGeneratedMode(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown generation error';
    generateButton.disabled = false;
    generateButton.classList.remove('busy');
    setStatus('error', message);
  }
}

function renderGeneratedMode(result: OsmSceneResult): void {
  destroyRenderers();
  generatedScene = result.scene;
  generatedManifest = buildSceneManifest(result.scene);

  const manifest = generatedManifest;
  const terrain = manifest.meshes.find((mesh) => mesh.role === 'terrain');
  const road = manifest.meshes.find((mesh) => mesh.role === 'road');
  const coordinateLabel = `${result.scene.anchor.latitude.toFixed(7)}, ${result.scene.anchor.longitude.toFixed(7)}`;

  app.innerHTML = renderShell(`
    ${renderBrand()}
    <div class="mode-tabs" aria-label="Job mode">
      <button class="mode-tab active" type="button">▣ Single Area</button>
      <button class="mode-tab" type="button" disabled>▦ Batch Job</button>
    </div>

    <section class="workflow-section result-heading">
      <div class="section-title-row">
        <span class="step-number complete">✓</span>
        <div>
          <h2>Area generated</h2>
          <p>Road profiles were engineered first; the DMR terrain was then cut, filled and blended to match them.</p>
        </div>
      </div>
      <button id="changeArea" class="secondary-action" type="button">Change selected area</button>
    </section>

    <section class="result-stats">
      <div><span>Area</span><strong>${formatArea(selection.sizeMetres)}</strong></div>
      <div><span>Relief</span><strong>${result.stats.reliefMetres.toFixed(1)} m</strong></div>
      <div><span>Road length</span><strong>${(result.stats.totalLengthMetres / 1000).toFixed(2)} km</strong></div>
      <div><span>Maximum grade</span><strong>${result.stats.maximumRoadGradePercent.toFixed(1)}%</strong></div>
      <div><span>Maximum bank</span><strong>${result.stats.maximumRoadBankPercent.toFixed(1)}%</strong></div>
      <div><span>Maximum cut</span><strong>${result.stats.maximumTerrainCutMetres.toFixed(2)} m</strong></div>
      <div><span>Maximum fill</span><strong>${result.stats.maximumTerrainFillMetres.toFixed(2)} m</strong></div>
      <div><span>Triangles</span><strong>${manifest.triangles.toLocaleString()}</strong></div>
    </section>

    <section class="workflow-section compact">
      <h3>Generated data</h3>
      <dl class="result-list">
        <div><dt>Centre</dt><dd>${coordinateLabel}</dd></div>
        <div><dt>Elevation source</dt><dd>${escapeHtml(result.stats.elevationSource)}</dd></div>
        <div><dt>Elevation range</dt><dd>${result.stats.minimumElevationMetres.toFixed(1)}–${result.stats.maximumElevationMetres.toFixed(1)} m</dd></div>
        <div><dt>Terrain</dt><dd>${terrain?.vertices ?? 0} v / ${terrain?.triangles ?? 0} t</dd></div>
        <div><dt>Road mesh</dt><dd>${road?.vertices ?? 0} v / ${road?.triangles ?? 0} t</dd></div>
        <div><dt>OSM ways</dt><dd>${result.stats.waysImported.toLocaleString()}</dd></div>
        <div><dt>3D profile stations</dt><dd>${result.stats.roadProfileStations.toLocaleString()}</dd></div>
        <div><dt>Road segments</dt><dd>${result.stats.roadSegments.toLocaleString()}</dd></div>
        <div><dt>Mesh hash</dt><dd>${manifest.hash}</dd></div>
      </dl>
      ${renderRoadNames(result.stats)}
    </section>

    <section class="workflow-section compact">
      <h3>Preview layers</h3>
      <label class="check-row"><input id="map" type="checkbox" checked /> OpenStreetMap</label>
      <label class="range-row"><span>Map opacity</span><input id="mapOpacity" type="range" min="0" max="100" value="72" /></label>
      <label class="check-row"><input id="terrain" type="checkbox" checked /> Road-conformed DMR terrain</label>
      <label class="check-row"><input id="road" type="checkbox" checked /> Engineered road mesh</label>
      <label class="check-row"><input id="wire" type="checkbox" checked /> Triangle edges</label>
      <label class="check-row"><input id="points" type="checkbox" /> Canonical vertices</label>
    </section>

    <button id="download" class="generate-button" type="button">
      <span>↓</span>
      <span><strong>Download scene JSON</strong><small>Canonical scene, road profiles and validation manifest</small></span>
    </button>

    <div class="status-card ${manifest.validation.valid ? 'success' : 'error'}">
      <strong>${manifest.validation.valid ? 'Geometry validation passed' : 'Geometry validation failed'}</strong>
      <span>${manifest.validation.valid
        ? 'Road surface and terrain earthworks share one engineered alignment. Preview vertical scale is exactly 1.0×.'
        : escapeHtml(manifest.validation.errors.slice(0, 3).join(' · '))}</span>
    </div>
  `, `
    <div class="map-tabs">
      <button id="mapView" class="map-tab" type="button">◉ 2D Map</button>
      <button id="localView" class="map-tab active" type="button">▰ 3D Preview</button>
      <button class="map-tab" type="button" disabled>◇ Cesium Preview</button>
    </div>
    <div class="map-hint generated">Road-first 3D · ${formatArea(selection.sizeMetres)} · ${result.stats.reliefMetres.toFixed(1)} m relief</div>
  `);

  sceneRenderer = createTriWorldRenderer('cesiumContainer', result.scene);
  sceneRenderer.resetCamera();
  wireGeneratedControls();
}

function wireGeneratedControls(): void {
  if (!sceneRenderer) return;

  const mapToggle = requireElement<HTMLInputElement>('#map');
  const mapOpacity = requireElement<HTMLInputElement>('#mapOpacity');
  const terrainToggle = requireElement<HTMLInputElement>('#terrain');
  const roadToggle = requireElement<HTMLInputElement>('#road');
  const wireToggle = requireElement<HTMLInputElement>('#wire');
  const pointToggle = requireElement<HTMLInputElement>('#points');
  const localViewButton = requireElement<HTMLButtonElement>('#localView');
  const mapViewButton = requireElement<HTMLButtonElement>('#mapView');
  const changeAreaButton = requireElement<HTMLButtonElement>('#changeArea');
  const downloadButton = requireElement<HTMLButtonElement>('#download');

  sceneRenderer.setMapOpacity(Number(mapOpacity.value) / 100);
  mapToggle.addEventListener('change', () => sceneRenderer?.setMapVisible(mapToggle.checked));
  mapOpacity.addEventListener('input', () => sceneRenderer?.setMapOpacity(Number(mapOpacity.value) / 100));
  terrainToggle.addEventListener('change', () => sceneRenderer?.setTerrainVisible(terrainToggle.checked));
  roadToggle.addEventListener('change', () => sceneRenderer?.setRoadVisible(roadToggle.checked));
  wireToggle.addEventListener('change', () => sceneRenderer?.setWireframeVisible(wireToggle.checked));
  pointToggle.addEventListener('change', () => sceneRenderer?.setVerticesVisible(pointToggle.checked));

  localViewButton.addEventListener('click', () => {
    sceneRenderer?.resetCamera();
    setActiveMapTab(localViewButton);
  });
  mapViewButton.addEventListener('click', () => {
    sceneRenderer?.showMapOverview();
    setActiveMapTab(mapViewButton);
  });
  changeAreaButton.addEventListener('click', () => renderSelectionMode({ type: 'info', text: 'Previous result cleared. Move the map beneath the fixed frame and generate again.' }));
  downloadButton.addEventListener('click', downloadScene);
}

function renderShell(sidebar: string, mapOverlay: string): string {
  return `
    <main class="mapng-shell">
      <aside class="sidebar">${sidebar}</aside>
      <section class="map-workspace">
        <div id="cesiumContainer"></div>
        ${mapOverlay}
        <div class="map-attribution-note">OpenStreetMap context · elevation GKÚ SR DMR 5.0</div>
      </section>
    </main>`;
}

function renderBrand(): string {
  return `
    <div class="brand-row">
      <div class="brand-mark">▲</div>
      <div><strong>TriWorld</strong><span>BeamNG road-first terrain toolkit</span></div>
      <button class="help-button" type="button" title="TriWorld area workflow">?</button>
    </div>`;
}

function renderRoadNames(stats: OsmSceneStats): string {
  if (stats.namedRoads.length === 0) return '';
  const visibleNames = stats.namedRoads.slice(0, 10);
  const remainder = stats.namedRoads.length - visibleNames.length;
  return `
    <div class="road-list">
      <span>Named OSM roads</span>
      <div>${visibleNames.map((name) => `<small>${escapeHtml(name)}</small>`).join('')}</div>
      ${remainder > 0 ? `<em>+ ${remainder} more</em>` : ''}
    </div>`;
}

function syncSelectionControls(): void {
  const latitude = document.querySelector<HTMLInputElement>('#latitude');
  const longitude = document.querySelector<HTMLInputElement>('#longitude');
  const areaSize = document.querySelector<HTMLSelectElement>('#areaSize');
  const selectedAreaLabel = document.querySelector<HTMLElement>('#selectedAreaLabel');
  const mapAreaLabel = document.querySelector<HTMLElement>('#mapAreaLabel');
  const fixedAreaLabel = document.querySelector<HTMLElement>('#fixedAreaLabel');
  const selectorCoordinateLabel = document.querySelector<HTMLElement>('#selectorCoordinateLabel');
  const bboxLabel = document.querySelector<HTMLElement>('#bboxLabel');

  if (latitude) latitude.value = selection.latitude.toFixed(7);
  if (longitude) longitude.value = selection.longitude.toFixed(7);
  if (areaSize) areaSize.value = String(selection.sizeMetres);
  if (selectedAreaLabel) selectedAreaLabel.textContent = formatArea(selection.sizeMetres);
  if (mapAreaLabel) mapAreaLabel.textContent = formatArea(selection.sizeMetres);
  if (fixedAreaLabel) fixedAreaLabel.textContent = formatArea(selection.sizeMetres);
  if (selectorCoordinateLabel) selectorCoordinateLabel.textContent = formatCoordinates(selection);
  if (bboxLabel) bboxLabel.textContent = formatBbox(selection);
}

function setStatus(type: 'idle' | 'working' | 'error', text: string): void {
  const status = document.querySelector<HTMLElement>('#status');
  if (!status) return;
  status.className = `status-card ${type}`;
  const title = status.querySelector('strong');
  const detail = status.querySelector('span');
  if (title) title.textContent = type === 'working' ? 'Generating selected area' : type === 'error' ? 'Generation failed' : 'Ready to generate';
  if (detail) detail.textContent = text;
}

function setActiveMapTab(active: HTMLButtonElement): void {
  document.querySelectorAll<HTMLButtonElement>('.map-tab').forEach((button) => button.classList.toggle('active', button === active));
}

function downloadScene(): void {
  if (!generatedScene || !generatedManifest) return;
  const blob = new Blob([serializeScene(generatedScene, generatedManifest)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${generatedScene.id}-${generatedManifest.hash}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function destroyRenderers(): void {
  selectionRenderer?.destroy();
  sceneRenderer?.destroy();
  selectionRenderer = null;
  sceneRenderer = null;
}

function formatArea(sizeMetres: number): string {
  const kilometres = sizeMetres / 1000;
  const label = Number.isInteger(kilometres) ? kilometres.toFixed(0) : kilometres.toFixed(1);
  return `${label} × ${label} km`;
}

function formatCoordinates(area: AreaSelection): string {
  return `${area.latitude.toFixed(6)}, ${area.longitude.toFixed(6)}`;
}

function formatBbox(area: AreaSelection): string {
  return selectionToBbox(area).map((value) => value.toFixed(5)).join(', ');
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
