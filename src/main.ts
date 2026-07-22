import 'cesium/Build/Cesium/Widgets/widgets.css';
import './styles.css';
import { buildSceneManifest, buildSyntheticScene, serializeScene } from './core';
import { createTriWorldRenderer } from './cesium-renderer';

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}

const scene = buildSyntheticScene();
const manifest = buildSceneManifest(scene);
const terrain = manifest.meshes.find((mesh) => mesh.role === 'terrain');
const road = manifest.meshes.find((mesh) => mesh.role === 'road');

const app = requireElement<HTMLDivElement>('#app');
app.innerHTML = `
  <main class="shell">
    <header>
      <div>
        <p class="eyebrow">TriWorld v0.2 · Cesium primitive renderer</p>
        <h1>One triangle world. Every engine.</h1>
        <p class="lede">Road-first canonical geometry in a right-handed, Z-up, metre-based local ENU frame. Cesium receives the exact indexed triangle buffers that will later feed BeamNG.</p>
      </div>
      <div class="stats">
        <span>${manifest.vertices.toLocaleString()} vertices</span>
        <span>${manifest.triangles.toLocaleString()} triangles</span>
        <span class="${manifest.validation.valid ? 'good' : 'bad'}">${manifest.validation.valid ? 'VALID' : 'INVALID'}</span>
      </div>
    </header>

    <section class="panel">
      <div class="viewport-card">
        <div id="cesiumContainer"></div>
        <div class="viewport-badge">Canonical mesh hash <strong>${manifest.hash}</strong></div>
      </div>

      <aside>
        <div>
          <p class="section-label">CanonicalScene</p>
          <h2>${scene.id}</h2>
        </div>

        <dl>
          <div><dt>Frame</dt><dd>ENU / Z-up</dd></div>
          <div><dt>Units</dt><dd>metres</dd></div>
          <div><dt>Terrain</dt><dd>${terrain?.vertices ?? 0} v / ${terrain?.triangles ?? 0} t</dd></div>
          <div><dt>Road</dt><dd>${road?.vertices ?? 0} v / ${road?.triangles ?? 0} t</dd></div>
          <div><dt>Bounds</dt><dd>${formatBounds()}</dd></div>
        </dl>

        <div class="controls">
          <label><input id="terrain" type="checkbox" checked /> Terrain surface</label>
          <label><input id="road" type="checkbox" checked /> Road surface</label>
          <label><input id="wire" type="checkbox" checked /> Triangle edges</label>
          <label><input id="points" type="checkbox" /> Canonical vertices</label>
        </div>

        <div class="buttons">
          <button id="reset" type="button">Reset camera</button>
          <button id="download" type="button" class="primary">Download scene JSON</button>
        </div>

        <div class="validation ${manifest.validation.valid ? 'valid' : 'invalid'}">
          <strong>${manifest.validation.valid ? 'Geometry validation passed' : 'Geometry validation failed'}</strong>
          <span>${manifest.validation.valid ? 'No invalid indices, degenerate faces, or inverted surface triangles.' : manifest.validation.errors.slice(0, 3).join(' · ')}</span>
        </div>
      </aside>
    </section>
  </main>`;

const renderer = createTriWorldRenderer('cesiumContainer', scene);
const terrainToggle = requireElement<HTMLInputElement>('#terrain');
const roadToggle = requireElement<HTMLInputElement>('#road');
const wireToggle = requireElement<HTMLInputElement>('#wire');
const pointToggle = requireElement<HTMLInputElement>('#points');
const resetButton = requireElement<HTMLButtonElement>('#reset');
const downloadButton = requireElement<HTMLButtonElement>('#download');

terrainToggle.addEventListener('change', () => renderer.setTerrainVisible(terrainToggle.checked));
roadToggle.addEventListener('change', () => renderer.setRoadVisible(roadToggle.checked));
wireToggle.addEventListener('change', () => renderer.setWireframeVisible(wireToggle.checked));
pointToggle.addEventListener('change', () => renderer.setVerticesVisible(pointToggle.checked));
resetButton.addEventListener('click', () => renderer.resetCamera());
downloadButton.addEventListener('click', downloadScene);
window.addEventListener('beforeunload', () => renderer.destroy(), { once: true });

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

function formatBounds(): string {
  const { min, max } = manifest.bounds;
  const width = max[0] - min[0];
  const depth = max[1] - min[1];
  const height = max[2] - min[2];
  return `${width.toFixed(0)} × ${depth.toFixed(0)} × ${height.toFixed(1)}`;
}
