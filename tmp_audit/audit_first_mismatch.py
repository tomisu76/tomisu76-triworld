import re, math, struct
from pathlib import Path
root = Path('tmp_audit/test08/levels/test08/art')
text = (root/'road/road_surface.dae').read_text(encoding='utf-8')
match = re.search(r'<float_array id="RoadMesh-positions-array" count="(\d+)">([^<]+)</float_array>', text)
vals = [float(x) for x in match.group(2).split()]
positions = [vals[i:i+3] for i in range(0, len(vals), 3)]
ter_path = root/'terrains/terrain.ter'
data = ter_path.read_bytes()
size = int.from_bytes(data[1:5], 'little')
sample_count = size*size
offset = 5
height_u16 = list(struct.unpack('<%dH' % sample_count, data[offset:offset+2*sample_count]))
height_scale = 500.0/65535.0

def sample_terrain(x,y):
    column = x/1.0
    row = (size-1) - y/1.0
    c0 = min(size-2, math.floor(column))
    r0 = min(size-2, math.floor(row))
    c1 = c0+1; r1 = r0+1
    tx = column-c0; ty = row-r0
    z00 = height_u16[r0*size+c0] * height_scale
    z10 = height_u16[r0*size+c1] * height_scale
    z01 = height_u16[r1*size+c0] * height_scale
    z11 = height_u16[r1*size+c1] * height_scale
    z0 = z00 + (z10-z00)*tx
    z1 = z01 + (z11-z01)*tx
    return z0 + (z1-z0)*ty

for s in range(0, 200):
    for v in range(7):
        p = positions[s*7+v]
        tz = sample_terrain(p[0], p[1])
        delta = p[2]-tz
        if abs(delta) > 0.29:
            print('station', s, 'vertex', v, 'dae', p, 'terrain', tz, 'delta', delta)
            raise SystemExit
print('none_found')
