import os, zipfile, json, math
from xml.etree import ElementTree as ET

path = os.path.join(r'C:\Users\tomisu\triworld-gate4', 'dist', 'test09.zip')
with zipfile.ZipFile(path) as z:
    dae_xml = z.read('levels/test09/art/road/road_surface.dae').decode('utf-8')
    terrain_json = json.loads(z.read('levels/test09/art/terrains/terrain.terrain.json').decode('utf-8'))
    items_lines = z.read('levels/test09/main/items.level.json').decode('utf-8').splitlines()
    items = [json.loads(line) for line in items_lines if line.strip()]
    ter = z.read('levels/test09/art/terrains/terrain.ter')

print('ZIP_OK', os.path.exists(path), len(ter))
print('SIZE', terrain_json['size'])
print('ITEMS', len(items))
for item in items:
    if item.get('class') == 'TerrainBlock':
        print('TERRAIN_ITEM', item)
    if item.get('class') == 'TSStatic' and item.get('shapeName','').endswith('road_surface.dae'):
        print('ROAD_ITEM', item)

root = ET.fromstring(dae_xml)
ns = {'c':'http://www.collada.org/2005/11/COLLADASchema'}
positions = None
for fa in root.findall('.//c:float_array', ns):
    if fa.get('id') == 'RoadMesh-positions-array':
        positions = [float(x) for x in fa.text.split()]
        break
print('POSITION_COUNT', len(positions)//3)
polylist = root.find('.//c:polylist', ns)
p_el = polylist.find('c:p', ns)
indices = [int(x) for x in p_el.text.split()]
print('INDEX_COUNT', len(indices))
print('FIRST_INDICES', indices[:30])
