#!/usr/bin/env python3
"""
Corridor comparison analysis - determines which mapping aligns with terrain modification
"""

import json
import math
import re
from pathlib import Path

# Constants
SIZE = 1024
WORLD_SAMPLE_CENTER = 511.5
WORLD_RUNTIME_SPAN = 1023.0

# Parse SUMO data for centered coordinates
sumo_file = Path("artifacts/gate3-osm/banovce_authoritative.net.xml")
with open(sumo_file, 'r', encoding='utf-8') as f:
    sumo_xml = f.read()

edge_pattern = r'<edge id="([^"]+)"[^>]*shape="([^"]+)"'
edge_0_shape = None
edge_1_shape = None

for match in re.finditer(edge_pattern, sumo_xml):
    edge_id = match.group(1)
    if edge_id == "109459194#0":
        edge_0_shape = match.group(2)
    elif edge_id == "109459194#1":
        edge_1_shape = match.group(2)

def parse_points(shape_str):
    return [(float(p.split(',')[0]), float(p.split(',')[1])) for p in shape_str.split()]

full_centerline = parse_points(edge_0_shape) + parse_points(edge_1_shape)

SUMO_NET_OFFSET_X = -304540.54
SUMO_NET_OFFSET_Y = -5399298.81

# UTM to local transformation
center_easting = 501978.7353747739  # Approx from BANOVCE center
center_northing = 5400254.758548571  # Approx from BANOVCE center

min_easting = center_easting - 512
max_easting = center_easting + 512
min_northing = center_northing - 512
max_northing = center_northing + 512

centered_points = []
for pt in full_centerline:
    utm_x = pt[0] - SUMO_NET_OFFSET_X
    utm_y = pt[1] - SUMO_NET_OFFSET_Y
    local_x = utm_x - min_easting
    local_y = utm_y - min_northing
    centered_x = local_x - 512.0
    centered_y = local_y - 512.0
    centered_points.append((centered_x, centered_y))

print("=" * 70)
print("CORRIDOR ALIGNMENT ANALYSIS")
print("=" * 70)

# The key insight: TerrainGridV3 uses centred coordinates directly
# From TerrainGridV3.ts:
#   column = (xCentered + halfSampleSpan) / squareSize
#   row = (N - 1) - (yCentered + halfSampleSpan) / squareSize
# where halfSampleSpan = (N - 1) / 2 = 511.5

# So for a centred point (x_c, y_c):
#   col = x_c + 511.5
#   row = 1023 - (y_c + 511.5) = 511.5 - y_c

# The DecalRoad X+Y flip:
#   runtimeX = 1023 - (x_c + 511.5)
#   runtimeY = 1023 - (y_c + 511.5)

# After orthophoto 180° rotation:
#   pixelX = 1023 - runtimeX = x_c + 511.5 = col
#   pixelY = 1023 - runtimeY = y_c + 511.5

print("\nKEY INSIGHT: Coordinate system relationships")
print("=" * 70)

sample_idx = 10  # Middle-ish point
sample_c = centered_points[sample_idx]

print(f"\nSample centred point: ({sample_c[0]:.2f}, {sample_c[1]:.2f})")
print(f"Logical coordinates: ({sample_c[0] + WORLD_SAMPLE_CENTER:.2f}, {sample_c[1] + WORLD_SAMPLE_CENTER:.2f})")

# Terrain grid mapping
col = sample_c[0] + WORLD_SAMPLE_CENTER
row = 511.5 - sample_c[1]  # Note: Y-axis inversion!
print(f"Terrain grid (col, row): ({col:.2f}, {row:.2f})")

# DecalRoad X+Y flip mapping
runtime_x = WORLD_RUNTIME_SPAN - (sample_c[0] + WORLD_SAMPLE_CENTER)
runtime_y = WORLD_RUNTIME_SPAN - (sample_c[1] + WORLD_SAMPLE_CENTER)
print(f"DecalRoad runtime (X+Y flip): ({runtime_x:.2f}, {runtime_y:.2f})")

# After orthophoto rotation
pixel_x = 1024 - 1 - int(runtime_x)  # 0-indexed
pixel_y = 1024 - 1 - int(runtime_y)
print(f"Orthophoto pixel (after 180° rotation): ({pixel_x}, {pixel_y})")

print("\n" + "=" * 70)
print("COORDINATE SYSTEM MISMATCH ANALYSIS")
print("=" * 70)

# The issue: Terrain grid row = 511.5 - y_c
# But orthophoto pixel Y = y_c + 511.5
# These are INVERTED!

print("\nTerrain grid Y-axis: row increases going SOUTH (top of image)")
print("Orthophoto Y-axis: row increases going NORTH (top of image after 180° rotation)")

print("\nFor the terrain grid:")
print("  row = 511.5 - y_centered")
print("  This means y_centered < 0 maps to row > 511.5 (top half of grid)")
print("  And y_centered > 0 maps to row < 511.5 (bottom half of grid)")

print("\nFor the orthophoto pixel (after 180° rotation):")
print("  pixelY = y_centered + 511.5")
print("  This means y_centered = -5.1 maps to pixel 506 (middle-ish)")
print("  And y_centered = -89.1 maps to pixel ~422")

print("\n" + "=" * 70)
print("ERROR DETECTED: Y-AXIS ORIENTATION MISMATCH")
print("=" * 70)

print("""
The terrain grid uses:
  row = (N-1) / 2 - y_centered
  
But the DecalRoad/orthophoto mapping uses:
  pixelY = y_centered + (N-1) / 2

These are OPPOSITE signs! The Y-axis is inverted between them.

This explains why the DecalRoad appears at the wrong vertical position:
- The terrain modification is in the CORRECT place (rows calculated by TerrainGridV3)
- The DecalRoad is using an INVERTED Y mapping
- The X+Y flip compensates for the orthophoto rotation but NOT the terrain grid Y inversion

SOLUTION: The Y-axis needs to be inverted to match the terrain grid:
  runtimeY = centeredY + WORLD_SAMPLE_CENTER  (NOT flipped)
  OR
  runtimeY = WORLD_RUNTIME_SPAN - (centeredY + WORLD_SAMPLE_CENTER) doesn't match terrain grid

Let's verify with the actual corridor bounds from the report:
""")

# Load report
report_file = Path("dist/roadfix02_report.json")
with open(report_file, 'r') as f:
    report = json.load(f)

bounds = report['sumoRoadBoundsCentered']
print(f"\nCorridor bounds (centered coordinates):")
print(f"  X: [{bounds['minX']:.2f}, {bounds['maxX']:.2f}]")
print(f"  Y: [{bounds['minY']:.2f}, {bounds['maxY']:.2f}]")

# These bounds are centred, so they apply to the terrain grid
# The terrain grid rows would be:
#   row_min = 511.5 - bounds['maxY']  (because Y is inverted)
#   row_max = 511.5 - bounds['minY']

row_min = 511.5 - bounds['maxY']
row_max = 511.5 - bounds['minY']
col_min = bounds['minX'] + 511.5
col_max = bounds['maxX'] + 511.5

print(f"\nCorridor extent in terrain grid:")
print(f"  Row range: [{row_min:.2f}, {row_max:.2f}]")
print(f"  Col range: [{col_min:.2f}, {col_max:.2f}]")

# Now check what the DecalRoad Y position would be
# For the corridor's minY (-89.1):
decalroad_y_min = WORLD_RUNTIME_SPAN - (bounds['minY'] + WORLD_SAMPLE_CENTER)
decalroad_y_max = WORLD_RUNTIME_SPAN - (bounds['maxY'] + WORLD_SAMPLE_CENTER)

print(f"\nDecalRoad Y position (X+Y flip):")
print(f"  Range: [{decalroad_y_min:.2f}, {decalroad_y_max:.2f}]")

print(f"\nDISCREPANCY:")
print(f"  Terrain grid row for corridor: [{row_min:.2f}, {row_max:.2f}]")
print(f"  DecalRoad Y for corridor: [{decalroad_y_min:.2f}, {decalroad_y_max:.2f}]")

# The relationship shows:
# Terrain row = 511.5 - y_centered
# DecalRoad Y (current) = 1023 - (y_centered + 511.5) = 511.5 - y_centered
# These should be the same!

# Wait, let me recalculate...
# If y_centered ranges from -89.1 to 500:
# Terrain row: 511.5 - (-89.1) = 600.6 to 511.5 - 500 = 111.5
# DecalRoad Y: 1023 - (-89.1 + 511.5) = 1023 - 422.4 = 600.6 to 1023 - (500 + 511.5) = 11.5

print(f"\nRecalculating:")
y_centered_min = bounds['minY']
y_centered_max = bounds['maxY']
terrain_row_min = 511.5 - y_centered_min  # = 600.6
terrain_row_max = 511.5 - y_centered_max  # = 11.5
decalroad_y_min = 1023 - (y_centered_min + 511.5)  # = 600.6
decalroad_y_max = 1023 - (y_centered_max + 511.5)  # = 11.5

print(f"  Terrain row range: [{terrain_row_min:.1f}, {terrain_row_max:.1f}]")
print(f"  DecalRoad Y range: [{decalroad_y_min:.1f}, {decalroad_y_max:.1f}]")

print(f"\nThese ARE the same! So the Y-axis is correctly aligned.")
print(f"The issue must be elsewhere...")

# Let me check X-axis as well
x_centered_min = bounds['minX']
x_centered_max = bounds['maxX']
terrain_col_min = x_centered_min + 511.5
terrain_col_max = x_centered_max + 511.5
decalroad_x_min = 1023 - (x_centered_min + 511.5)
decalroad_x_max = 1023 - (x_centered_max + 511.5)

print(f"\nX-axis check:")
print(f"  Terrain col range: [{terrain_col_min:.1f}, {terrain_col_max:.1f}]")
print(f"  DecalRoad X range: [{decalroad_x_min:.1f}, {decalroad_x_max:.1f}]")

print(f"\nX ranges are INVERTED (as expected for X+Y flip)!")
print(f"If terrain col is [422.4, 910.7], DecalRoad X is [112.3, 600.6]")
print(f"These should match after orthophoto rotation...")

# Save findings
findings = {
    "terrain_row_range": [terrain_row_min, terrain_row_max],
    "decalroad_y_range": [decalroad_y_min, decalroad_y_max],
    "terrain_col_range": [terrain_col_min, terrain_col_max],
    "decalroad_x_range": [decalroad_x_min, decalroad_x_max],
    "y_axis_aligned": abs(terrain_row_min - decalroad_y_min) < 0.1,
    "x_axis_inverted": True,
    "conclusion": "X+Y flip appears correct. Check if corridor modification is in correct location."
}

with open("tmp_audit/corridor_findings.json", 'w') as f:
    json.dump(findings, f, indent=2)

print(f"\nFindings saved to tmp_audit/corridor_findings.json")