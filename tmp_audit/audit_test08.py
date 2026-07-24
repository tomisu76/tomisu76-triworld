import re, math, struct
from pathlib import Path

root = Path('tmp_audit/test08/levels/test08/art')
text = (root / 'road/road_surface.dae').read_text(encoding='utf-8')
arr = re.search(r'<float_array id="RoadMesh-positions-array" count="(\d+)">([^<]+)</float_array>', text)
vals = [float(x) for x in arr.group(2).split()]
positions = [vals[i:i+3] for i in range(0, len(vals), 3)]
tri_match = re.search(r'<triangles[^>]*count="(\d+)".*?<p>([^<]+)</p>', text, re.S)
tri_vals = [int(x) for x in tri_match.group(2).split()]
triangles = [tri_vals[i:i+3] for i in range(0, len(tri_vals), 3)]

ter_path = root / 'terrains/terrain.ter'
data = ter_path.read_bytes()
version = data[0]
size = int.from_bytes(data[1:5], 'little')
sample_count = size * size
offset = 5
height_u16 = list(struct.unpack('<%dH' % sample_count, data[offset:offset + 2 * sample_count]))
height_scale = 500.0 / 65535.0


def sample_terrain(x, y):
    column = x / 1.0
    row = (size - 1) - y / 1.0
    if column < 0 or column > size - 1 or row < 0 or row > size - 1:
        raise ValueError((x, y, column, row))
    c0 = min(size - 2, math.floor(column))
    r0 = min(size - 2, math.floor(row))
    c1 = c0 + 1
    r1 = r0 + 1
    tx = column - c0
    ty = row - r0
    z00 = height_u16[r0 * size + c0] * height_scale
    z10 = height_u16[r0 * size + c1] * height_scale
    z01 = height_u16[r1 * size + c0] * height_scale
    z11 = height_u16[r1 * size + c1] * height_scale
    z0 = z00 + (z10 - z00) * tx
    z1 = z01 + (z11 - z01) * tx
    return z0 + (z1 - z0) * ty

station_count = len(positions) // 7
crown_idx = 3
crown_positions = [positions[s * 7 + crown_idx] for s in range(station_count)]

print('size', size)
print('station_count', station_count)
print('positions', len(positions))
print('triangles', len(triangles))
print('terrain_minmax', min(height_u16) * height_scale, max(height_u16) * height_scale)

max_xy = 0.0
max_zdiff = 0.0
for i in range(1, station_count):
    prev = crown_positions[i - 1]
    curr = crown_positions[i]
    d = math.hypot(curr[0] - prev[0], curr[1] - prev[1])
    dz = abs(curr[2] - prev[2])
    max_xy = max(max_xy, d)
    max_zdiff = max(max_zdiff, dz)
print('max_crown_xy_distance', max_xy)
print('max_crown_z_diff', max_zdiff)

max_edge = 0.0
max_zextent = 0.0
edge_bad = 0
z_bad = 0
first_sep = None
for tri in triangles:
    pts = [positions[i] for i in tri]
    for i in range(3):
        a = pts[i]
        b = pts[(i + 1) % 3]
        d = math.dist((a[0], a[1]), (b[0], b[1]))
        max_edge = max(max_edge, d)
        if d > 3.0:
            edge_bad += 1
            if first_sep is None:
                first_sep = ('edge', tri, d)
    zext = max(p[2] for p in pts) - min(p[2] for p in pts)
    max_zextent = max(max_zextent, zext)
    if zext > 1.0:
        z_bad += 1
        if first_sep is None:
            first_sep = ('zext', tri, zext)
print('max_triangle_edge_length', max_edge)
print('max_triangle_z_extent', max_zextent)
print('triangles_edge_gt_3m', edge_bad)
print('triangles_zextent_gt_1m', z_bad)
print('first_sep', first_sep)

# DAE min/max
xs = [p[0] for p in positions]
ys = [p[1] for p in positions]
zs = [p[2] for p in positions]
print('dae_minmax_xy_z', min(xs), max(xs), min(ys), max(ys), min(zs), max(zs))
print('terrain_decoded_minmax_z', min(height_u16) * height_scale, max(height_u16) * height_scale)

# first station/vertex that differs from terrain by >0.5m and first station with big separation
for s in range(station_count):
    for v in range(7):
        p = positions[s * 7 + v]
        try:
            tz = sample_terrain(p[0], p[1])
        except Exception:
            continue
        delta = p[2] - tz
        if abs(delta) > 0.5 and 'first_large' not in locals():
            print('first_large_delta', s, v, p, tz, delta)
            first_large = True
        if abs(delta) > 1.0 and 'first_big' not in locals():
            print('first_big_delta', s, v, p, tz, delta)
            first_big = True
    if 'first_big' in locals() and 'first_large' in locals():
        break

# compare against candidate flips
span = (size - 1) * 1.0
candidates = [
    ('no_flip', lambda x, y: (x, y)),
    ('x_flip', lambda x, y: (span - x, y)),
    ('y_flip', lambda x, y: (x, span - y)),
    ('xy_flip', lambda x, y: (span - x, span - y)),
]
for label, fn in candidates:
    max_delta = 0.0
    worst = None
    for s in range(station_count):
        for v in range(7):
            p = positions[s * 7 + v]
            qx, qy = fn(p[0], p[1])
            try:
                tz = sample_terrain(qx, qy)
            except Exception:
                continue
            delta = p[2] - tz
            if abs(delta) > max_delta:
                max_delta = abs(delta)
                worst = (s, v, p[0], p[1], qx, qy, p[2], tz, delta)
    print(label, 'max_abs_delta_to_candidate_terrain', max_delta, 'worst', worst)

# Compare emitted DAE coordinate to terrain at same coordinates and under flipped coords.
for label, fn in candidates:
    max_xy_dist = 0.0
    worst_xy = None
    for s in range(station_count):
        for v in range(7):
            p = positions[s * 7 + v]
            qx, qy = fn(p[0], p[1])
            try:
                tz = sample_terrain(qx, qy)
            except Exception:
                continue
            dist = math.hypot(p[0] - qx, p[1] - qy)
            if dist > max_xy_dist:
                max_xy_dist = dist
                worst_xy = (s, v, p[0], p[1], qx, qy, dist)
    print(label, 'max_xy_distance_to_candidate_point', max_xy_dist, 'worst', worst_xy)
PY