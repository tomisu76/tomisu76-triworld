import './styles.css';

type Vec3 = readonly [number, number, number];

type CanonicalMesh = {
  id: string;
  material: string;
  positions: Vec3[];
  indices: number[];
};

const terrain = buildTerrain();
const road = buildRoad();

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing #app');

app.innerHTML = `
  <main class="shell">
    <header>
      <div>
        <p class="eyebrow">TriWorld v0.1</p>
        <h1>One triangle world. Every engine.</h1>
        <p class="lede">Canonical Z-up metre geometry rendered directly in the browser. The same buffers will feed Cesium and BeamNG.</p>
      </div>
      <div class="stats">
        <span>${terrain.positions.length + road.positions.length} vertices</span>
        <span>${(terrain.indices.length + road.indices.length) / 3} triangles</span>
      </div>
    </header>
    <section class="panel">
      <canvas id="view" width="1200" height="700"></canvas>
      <aside>
        <h2>CanonicalScene</h2>
        <dl>
          <div><dt>Handedness</dt><dd>Right-handed</dd></div>
          <div><dt>Up axis</dt><dd>Z</dd></div>
          <div><dt>Units</dt><dd>Metres</dd></div>
          <div><dt>Terrain</dt><dd>${terrain.positions.length} vertices</dd></div>
          <div><dt>Road</dt><dd>${road.positions.length} vertices</dd></div>
        </dl>
        <label><input id="wire" type="checkbox" checked /> Wireframe</label>
        <label><input id="points" type="checkbox" /> Vertices</label>
      </aside>
    </section>
  </main>`;

const canvas = document.querySelector<HTMLCanvasElement>('#view');
const wire = document.querySelector<HTMLInputElement>('#wire');
const points = document.querySelector<HTMLInputElement>('#points');
if (!canvas || !wire || !points) throw new Error('Missing controls');

const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('Canvas 2D unavailable');

function buildTerrain(): CanonicalMesh {
  const size = 22;
  const step = 4;
  const positions: Vec3[] = [];
  const indices: number[] = [];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x - (size - 1) / 2) * step;
      const py = (y - (size - 1) / 2) * step;
      const ridge = Math.sin(px * 0.08) * 4 + Math.cos(py * 0.07) * 3;
      const roadFlatten = Math.exp(-Math.pow(py / 10, 2));
      const z = ridge * (1 - roadFlatten * 0.82);
      positions.push([px, py, z]);
    }
  }

  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const a = y * size + x;
      const b = a + 1;
      const c = a + size;
      const d = c + 1;
      indices.push(a, b, d, a, d, c);
    }
  }

  return { id: 'terrain', material: 'terrain', positions, indices };
}

function buildRoad(): CanonicalMesh {
  const positions: Vec3[] = [];
  const indices: number[] = [];
  const segments = 36;
  const halfWidth = 4;

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const x = -42 + t * 84;
    const y = Math.sin(t * Math.PI * 1.8) * 7;
    const z = 0.7 + Math.sin(t * Math.PI) * 1.4;
    const dx = 84;
    const dy = Math.cos(t * Math.PI * 1.8) * 7 * Math.PI * 1.8;
    const len = Math.hypot(dx, dy);
    const nx = -dy / len;
    const ny = dx / len;
    positions.push([x + nx * halfWidth, y + ny * halfWidth, z]);
    positions.push([x - nx * halfWidth, y - ny * halfWidth, z]);
  }

  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    indices.push(a, b, d, a, d, c);
  }

  return { id: 'road', material: 'road', positions, indices };
}

const camera = { yaw: -0.6, pitch: 0.62, scale: 6.1, tx: 0, ty: 22 };
let dragging = false;
let lastX = 0;
let lastY = 0;

canvas.addEventListener('pointerdown', (event) => {
  dragging = true;
  lastX = event.clientX;
  lastY = event.clientY;
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointerup', () => (dragging = false));
canvas.addEventListener('pointermove', (event) => {
  if (!dragging) return;
  camera.yaw += (event.clientX - lastX) * 0.008;
  camera.pitch = Math.max(0.15, Math.min(1.3, camera.pitch + (event.clientY - lastY) * 0.006));
  lastX = event.clientX;
  lastY = event.clientY;
  draw();
});
canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  camera.scale = Math.max(2.8, Math.min(12, camera.scale * (event.deltaY > 0 ? 0.9 : 1.1)));
  draw();
}, { passive: false });
wire.addEventListener('change', draw);
points.addEventListener('change', draw);

function project([x, y, z]: Vec3): [number, number, number] {
  const cy = Math.cos(camera.yaw);
  const sy = Math.sin(camera.yaw);
  const rx = x * cy - y * sy;
  const ry = x * sy + y * cy;
  const cp = Math.cos(camera.pitch);
  const sp = Math.sin(camera.pitch);
  const rz = z * cp - ry * sp;
  const depth = z * sp + ry * cp;
  return [canvas.width / 2 + rx * camera.scale, canvas.height / 2 + rz * camera.scale + camera.ty, depth];
}

function drawMesh(mesh: CanonicalMesh, fill: string, stroke: string): void {
  const projected = mesh.positions.map(project);
  const tris: { idx: number[]; depth: number }[] = [];
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const idx = [mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]];
    tris.push({ idx, depth: (projected[idx[0]][2] + projected[idx[1]][2] + projected[idx[2]][2]) / 3 });
  }
  tris.sort((a, b) => a.depth - b.depth);

  for (const tri of tris) {
    const [a, b, c] = tri.idx.map((index) => projected[index]);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(c[0], c[1]);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (wire.checked) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 0.75;
      ctx.stroke();
    }
  }

  if (points.checked) {
    ctx.fillStyle = '#ffffff';
    for (const [x, y] of projected) {
      ctx.beginPath();
      ctx.arc(x, y, 1.7, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function draw(): void {
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, '#163153');
  gradient.addColorStop(1, '#07111f');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawMesh(terrain, 'rgba(70, 150, 105, 0.92)', 'rgba(185, 255, 216, 0.2)');
  drawMesh(road, 'rgba(255, 62, 174, 0.96)', 'rgba(255, 230, 248, 0.75)');
}

draw();
