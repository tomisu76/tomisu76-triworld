import zipfile
import json

z = zipfile.ZipFile('dist/align01.zip')
print('Files in zip:', z.namelist())
for name in z.namelist():
    if 'items' in name.lower():
        content = z.read(name).decode()
        items = [json.loads(l) for l in content.split('\n') if 'DecalRoad' in l]
        print(f'\nDecalRoad objects in {name}: {len(items)}')
        for o in items:
            print(f"  - {o['name']}")
            print(f"    nodes count: {len(o['nodes'])}")
            print(f"    first node: {o['nodes'][0]}")
            print(f"    last node: {o['nodes'][-1]}")