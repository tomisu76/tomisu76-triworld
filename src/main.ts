import 'cesium/Build/Cesium/Widgets/widgets.css';
import './styles.css';
import { buildSceneManifest, serializeScene, type CanonicalScene, type SceneManifest } from './core';
import { createTriWorldRenderer, type TriWorldRenderer } from './cesium-renderer';
import {
  buildOsmSceneV3,
  type OsmSceneResultV3,
} from './pipeline-v3/osm-scene-v3';
import type { AreaSelectionV2 } from './pipeline-v2/osm-scene-v2';
import { createAreaSelectionRenderer, type AreaSelectionRenderer } from './selection-renderer';

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}

const app = requireElement<HTMLDivElement>('#app');
let selection: AreaSelectionV2 = {
  longitude: 18.343444,
  latitude: 48.732751,
  sizeMetres: 512, // Default 512m preset
  inspectMode: false,
};
let validationAlphaMode: boolean = false; // Default to Real OSM Roads so alignment matches basemap map 100%
let selectionRenderer: AreaSelectionRenderer | null = null;
let sceneRenderer: TriWorldRenderer | null = null;
let generatedScene: CanonicalScene | null = null;
let generatedManifest: SceneManifest | null = null;
let lastResult: OsmSceneResultV3 | null = null;

renderSelectionMode();
window.addEventListener('beforeunload', destroyRenderers, { once: true });

function renderSelectionMode(message?: { type: 'error' | 'info'; text: string }): void {
  destroyRenderers();
  generatedScene = null;
  generatedManifest = null;
  lastResult = null;

  app.innerHTML = renderShell(`
    ${renderBrand()}
    <div class="mode-tabs" aria-label="Job mode">
      <button class="mode-tab active" type="button">▣ Single Area (Pipeline V3)</button>
      <button class="mode-tab" type="button" disabled>▦ Batch Job</button>
    </div>

    <section class="workflow-section">
      <div class="section-title-row">
        <span class="step-number">1</span>
        <div>
          <h2>Select BeamNG Area (Pipeline V3)</h2>
          <p>Move the map beneath the fixed selection square. The centre of the screen becomes the output centre.</p>
        </div>
      </div>

      <label class="field-label" for="areaSize">BeamNG Preset Area Size</label>
      <select id="areaSize" class="field-control">
        ${[512, 1024, 2048, 4096]
          .map((size) => `<option value="${size}" ${size === selection.sizeMetres ? 'selected' : ''}>BeamNG ${size} (${size} × ${size} m @ 1m)</option>`)
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

    <section class="workflow-section compact">
      <h3>Road Generation Source</h3>
      <label class="check-row">
        <input id="valAlphaToggle" type="checkbox" ${validationAlphaMode ? 'checked' : ''} />
        Validation Alpha Synthetic Test (Single Synthetic Curve)
      </label>
      <p class="muted-note">Unchecked = Real OSM Road Network (100% aligned with map overlay).</p>
    </section>

    <button id="generate" class="generate-button" type="button">
      <span>▲</span>
      <span><strong>Generate Area (Pipeline V3)</strong><small>Fetch 1.0m DMR LiDAR & compile 100% metre-based terrain</small></span>
    </button>

    <div id="status" class="status-card ${message?.type ?? 'idle'}">
      <strong>${message?.type === 'error' ? 'Generation failed' : 'Ready to generate'}</strong>
      <span>${message?.text ?? 'Pipeline V3 runs 100% deterministic SUMO direction & daylighting solver.'}</span>
    </div>

    <section class="workflow-section output-section">
      <h3>Pipeline V3 Scale & Contract Settings</h3>
      <label class="field-label">Authoritative Canonical Terrain V3</label>
      <div class="readonly-control">1.000 m/sample LiDAR · Overview Spacing ensures full map coverage</div>
      <label class="check-row"><input type="checkbox" checked disabled /> Relative Datum (anchorZ = 0.0m)</label>
      <label class="check-row"><input type="checkbox" checked disabled /> Surface Render (surfaceZ = formationZ + 0.30m)</label>
      <p class="muted-note">Major visual grid interval: 8.000 m.</p>
    </section>
  `, `
    <div class="map-tabs">
      <button class="map-tab active" type="button">◉ 2D Map</button>
      <button class="map-tab" type="button" disabled>▰ 3D Overview</button>
      <button class="map-tab" type="button" disabled>🔬 Canonical 1m Inspect</button>
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
    selection = { ...selection, ...nextSelection };
    syncSelectionControls();
  });

  const areaSize = requireElement<HTMLSelectElement>('#areaSize');
  const latitude = requireElement<HTMLInputElement>('#latitude');
  const longitude = requireElement<HTMLInputElement>('#longitude');
  const focusArea = requireElement<HTMLButtonElement>('#focusArea');
  const generate = requireElement<HTMLButtonElement>('#generate');
  const valAlphaToggle = requireElement<HTMLInputElement>('#valAlphaToggle');

  areaSize.addEventListener('change', () => {
    selectionRenderer?.setSize(Number(areaSize.value));
  });

  valAlphaToggle.addEventListener('change', () => {
    validationAlphaMode = valAlphaToggle.checked;
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

async function generateSelectedArea(inspectMode: boolean = false): Promise<void> {
  if (!selectionRenderer && !lastResult) return;
  if (selectionRenderer) {
    const sel = selectionRenderer.getSelection();
    selection = { ...selection, ...sel };
  }
  selection.inspectMode = inspectMode;

  const generateButton = document.querySelector<HTMLButtonElement>('#generate');
  if (generateButton) {
    generateButton.disabled = true;
    generateButton.classList.add('busy');
  }
  setStatus('working', 'Executing Pipeline V3: Fetching 1.0m LiDAR DMR chunks…');

  try {
    await nextPaint();
    const result = await buildOsmSceneV3(selection, validationAlphaMode);
    lastResult = result;
    renderGeneratedMode(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown generation error';
    if (generateButton) {
      generateButton.disabled = false;
      generateButton.classList.remove('busy');
    }
    setStatus('error', message);
  }
}

function renderGeneratedMode(result: OsmSceneResultV3): void {
  destroyRenderers();
  generatedScene = result.scene;
  generatedManifest = buildSceneManifest(result.scene);

  const manifest = generatedManifest;
  const terrain = manifest.meshes.find((mesh) => mesh.role === 'terrain');
  const road = manifest.meshes.find((mesh) => mesh.role === 'road');
  const coordinateLabel = `${result.scene.anchor.latitude.toFixed(7)}, ${result.scene.anchor.longitude.toFixed(7)}`;
  const isInspect = Boolean(selection.inspectMode);
  const semantic = result.semanticReport;

  app.innerHTML = renderShell(`
    ${renderBrand()}
    <div class="mode-tabs" aria-label="Job mode">
      <button class="mode-tab active" type="button">▣ Single Area (Pipeline V3)</button>
      <button class="mode-tab" type="button" disabled>▦ Batch Job</button>
    </div>

    <section class="workflow-section result-heading">
      <div class="section-title-row">
        <span class="step-number ${semantic.overallValid ? 'complete' : 'error'}">${semantic.overallValid ? '✓' : '✕'}</span>
        <div>
          <h2>Area generated (${result.stats.presetLabel})</h2>
          <p>${isInspect ? 'Showing Canonical 1m Inspect Patch (128 × 128 m @ exact 1.000 m spacing)' : `Showing Full Terrain Mesh (${result.stats.terrainMeshResolution} × ${result.stats.terrainMeshResolution} v @ ${result.stats.terrainVertexIntervalMetres.toFixed(3)} m/vertex)`}</p>
        </div>
      </div>
      <button id="changeArea" class="secondary-action" type="button">Change selected area</button>
    </section>

    <section class="result-stats">
      <div><span>BeamNG Terrain</span><strong>${result.stats.presetLabel} (${result.stats.exactSizeMetres})</strong></div>
      <div><span>Canonical Spacing</span><strong>1.000 m/sample (${result.stats.totalHeightSamples.toLocaleString()} samples)</strong></div>
      <div><span>Terrain Vertex Spacing</span><strong>${result.stats.terrainVertexIntervalMetres.toFixed(3)} m/vertex (${result.stats.terrainMeshResolution}×${result.stats.terrainMeshResolution})</strong></div>
      <div><span>Major Visual Grid</span><strong>8.000 m</strong></div>
      <div><span>Road Quads</span><strong>${result.stats.roadSegmentsCount.toLocaleString()} quads</strong></div>
      <div><span>Road Length</span><strong>${(result.stats.totalRoadLengthMetres / 1000).toFixed(2)} km</strong></div>
    </section>

    <section class="workflow-section compact">
      <h3>${isInspect ? 'Canonical 1m Inspect Metadata (V3)' : '3D Terrain Metadata (V3)'}</h3>
      <dl class="result-list">
        <div><dt>Centre</dt><dd>${coordinateLabel}</dd></div>
        <div><dt>Rendered Terrain</dt><dd>${terrain?.vertices ?? 0} v / ${terrain?.triangles ?? 0} t (${result.stats.terrainSourceLabel})</dd></div>
        <div><dt>Road Mesh V3</dt><dd>${road?.vertices ?? 0} v / ${road?.triangles ?? 0} t (Surface Z = formationZ + 0.30m)</dd></div>
        <div><dt>Logical Corridor Vertices</dt><dd>${semantic.vertexCounts.logicalCorridorVertices} shared vertices (${semantic.vertexCounts.logicalQuads} quads)</dd></div>
        <div><dt>Expanded Render Vertices</dt><dd>${semantic.vertexCounts.expandedRenderVertices} GPU vertices (${semantic.vertexCounts.renderTriangles} triangles)</dd></div>
        <div><dt>Road-Terrain Clearance</dt><dd>min: ${semantic.clearanceMetrics.minClearanceMetres.toFixed(3)}m · max: ${semantic.clearanceMetrics.maxClearanceMetres.toFixed(3)}m · mean: ${semantic.clearanceMetrics.meanClearanceMetres.toFixed(3)}m</dd></div>
        <div><dt>Negative Clearance Count</dt><dd><strong>${semantic.clearanceMetrics.negativeClearanceCount}</strong> (must be 0)</dd></div>
      </dl>
    </section>

    <section class="workflow-section compact">
      <h3>Preview layers</h3>
      <label class="check-row"><input id="map" type="checkbox" checked /> OpenStreetMap</label>
      <label class="range-row"><span>Map opacity</span><input id="mapOpacity" type="range" min="0" max="100" value="72" /></label>
      <label class="check-row"><input id="terrain" type="checkbox" checked /> ${isInspect ? 'Canonical 1m Inspect Patch' : 'Working Deformed Terrain (workingElevations)'}</label>
      <label class="check-row"><input id="road" type="checkbox" /> Road Surface Mesh V3 (surfaceZ)</label>
      <label class="check-row"><input id="wire" type="checkbox" /> Triangle edges</label>
      <label class="check-row"><input id="points" type="checkbox" /> Canonical 1m vertices</label>
    </section>

    <button id="download" class="generate-button" type="button">
      <span>↓</span>
      <span><strong>Download scene JSON</strong><small>Canonical scene and validation manifest V3</small></span>
    </button>

    <div class="status-card ${semantic.overallValid ? 'success' : 'error'}">
      <strong>${semantic.overallValid ? 'Pipeline V3 Geometry & Clearance Validation Passed' : 'Pipeline V3 Validation Failed'}</strong>
      <span>${semantic.overallValid
        ? 'Pipeline V3: 100% semantic geometry checks, overview scale invariants, and clearance >= 0.25m passed.'
        : escapeHtml(semantic.failureReasons.join(' · '))}</span>
    </div>
  `, `
    <div class="map-tabs">
      <button id="mapView" class="map-tab" type="button">◉ 2D Map</button>
      <button id="overviewView" class="map-tab ${!isInspect ? 'active' : ''}" type="button">▰ 3D Terrain (${result.stats.terrainMeshResolution}×${result.stats.terrainMeshResolution} @ ${result.stats.terrainVertexIntervalMetres.toFixed(3)}m)</button>
      <button id="inspectView" class="map-tab ${isInspect ? 'active' : ''}" type="button">🔬 Canonical 1m Inspect (128×128m @ 1.000m)</button>
    </div>
    <div class="map-hint generated">${result.stats.presetLabel} (${result.stats.exactSizeMetres}) · 1.000m Canonical Spacing · ${result.stats.terrainVertexIntervalMetres.toFixed(3)}m Terrain Vertex Spacing</div>
  `);

  sceneRenderer = createTriWorldRenderer('cesiumContainer', result.scene);
  if (isInspect) {
    sceneRenderer.focusInspectPatch();
  } else {
    sceneRenderer.resetCamera();
  }
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
  const overviewViewButton = requireElement<HTMLButtonElement>('#overviewView');
  const inspectViewButton = requireElement<HTMLButtonElement>('#inspectView');
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

  overviewViewButton.addEventListener('click', () => void generateSelectedArea(false));
  inspectViewButton.addEventListener('click', () => void generateSelectedArea(true));
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
        <div class="map-attribution-note">OpenStreetMap context · GKÚ SR DMR 5.0 WCS 1.0m LiDAR · Pipeline V3</div>
      </section>
    </main>`;
}

function renderBrand(): string {
  return `
    <div class="brand-row">
      <div class="brand-mark">▲</div>
      <div><strong>TriWorld V3</strong><span>BeamNG real-world terrain toolkit</span></div>
      <button class="help-button" type="button" title="TriWorld area workflow">?</button>
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
  if (title) title.textContent = type === 'working' ? 'Executing Pipeline V3' : type === 'error' ? 'Generation failed' : 'Ready to generate';
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
  return `BeamNG ${sizeMetres} (${sizeMetres} × ${sizeMetres} m)`;
}

function formatCoordinates(area: AreaSelectionV2): string {
  return `${area.latitude.toFixed(6)}, ${area.longitude.toFixed(6)}`;
}

function formatBbox(area: AreaSelectionV2): string {
  return selectionToBboxV2(area.longitude, area.latitude, area.sizeMetres).map((value) => value.toFixed(5)).join(', ');
}

function selectionToBboxV2(longitude: number, latitude: number, sizeMetres: number): readonly [number, number, number, number] {
  const halfExtent = sizeMetres / 2;
  const metresPerDegreeLat = 111_320;
  const metresPerDegreeLon = metresPerDegreeLat * Math.cos((latitude * Math.PI) / 180);
  const deltaLat = halfExtent / metresPerDegreeLat;
  const deltaLon = halfExtent / metresPerDegreeLon;

  return [
    longitude - deltaLon,
    latitude - deltaLat,
    longitude + deltaLon,
    latitude + deltaLat,
  ] as const;
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
