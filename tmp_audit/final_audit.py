#!/usr/bin/env python3
"""
FINAL ROADFIX02 AUDIT - Complete numerical analysis
"""

import json
import math
import re
import zipfile
import numpy as np
from pathlib import Path
from PIL import Image, ImageDraw

# Constants
SIZE = 1024
SQUARE_SIZE = 1.0
WORLD_SAMPLE_CENTER = ((SIZE - 1) * SQUARE_SIZE) / 2  # 511.5
WORLD_RUNTIME_SPAN = (SIZE - 1) * SQUARE_SIZE  # 1023.0

# BANOVCE_ORIGIN_WGS84
BANOVCE_LON = 18.352620306978697
BANOVCE_LAT = 48.72566288876834
SUMO_NET_OFFSET_X = -304540.54
SUMO_NET_OFFSET_Y = -5399298.81
CENTER_EASTING = 501978.7353747739  # Will be calculated

# UTM constants
A = 6378137.0
F = 1 / 298.257223563
E2 = 2 * F - F * F
K0 = 0.9996
FALSE_EASTING = 500000.0
FALSE_NORTHING = 0.0
CENTRAL_MERIDIAN_34 = 21.0

def wgs84_to_utm(lon, lat):
    rad_lat = math.radians(lat)
    rad_lon = math.radians(lon)
    lon0 = math.radians(CENTRAL_MERIDIAN_34)
    N = A / math.sqrt(1 - E2 * math.sin(rad_lat) ** 2)
    T = math.tan(rad_lat) ** 2
    C = (E2 / (1 - E2)) * (math.cos(rad_lat) ** 2)
    A_val = (rad_lon - lon0) * math.cos(rad_lat)
    e4 = E2 * E2
    e6 = e4 * E2
    M = A * (
        (1 - E2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * rad_lat -
        ((3 * E2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * math.sin(2 * rad_lat) +
        (((15 * e4) / 256 + (45 * e6) / 1024) * math.sin(4 * rad_lat)) -
        ((35 * e6) / 3072) * math.sin(6 * rad_lat)
    )
    easting = FALSE_EASTING + K0 * N * (
        A_val + ((1 - T + C) * A_val ** 3) / 6 +
        ((5 - 18 * T + T ** 2 + 72 * C - 58 * E2) * A_val ** 5) / 120
    )
    northing = FALSE_NORTHING + K0 * (
        M + N * math.tan(rad_lat) * (
            (A_val ** 2) / 2 +
            ((5 - T + 9 * C + 4 * C ** 2) * A_val ** 4) / 24 +
            ((61 - 58 * T + T ** 2 + 600 * C - 330 * E2) * A_val ** 6) / 720
        )
    )
    return easting, northing

# Calculate bounds
center_easting, center_northing = wgs84_to_utm(BANOVCE_LON, BANOVCE_LAT)
half_extent = SIZE / 2

min_easting = center_easting - half_extent
max_easting = center_easting + half_extent
min_northing = center_northing - half_extent
max_northing = center_northing + half_extent

print("=" * 70)
print("FINAL ROADFIX02 AUDIT REPORT")
print("=" * 70)

# Parse SUMO data
sumo_file = Path("artifacts/gate3-osm/banovce_authoritative.net.xml")
with open(sumo_file, 'r', encoding='utf-8') as f:
    sumo_xml = f.read()

edge_pattern = r'<edge id="([^"]+)"[^>]*shape="([^"]+)"'
lane_pattern = r'<lane id="([^"]+)"[^>]*shape="([^"]+)"'

edge_0_shape = None
edge_1_shape = None
lane_0_shape = None
lane_1_shape = None

for match in re.finditer(edge_pattern, sumo_xml):
    edge_id = match.group(1)
    if edge_id == "109459194#0":
        edge_0_shape = match.group(2)
    elif edge_id == "109459194#1":
        edge_1_shape = match.group(2)

for match in re.finditer(lane_pattern, sumo_xml):
    lane_id = match.group(1)
    if lane_id == "109459194#0_0":
        lane_0_shape = match.group(2)
    elif lane_id == "109459194#1_0":
        lane_1_shape = match.group(2)

def parse_points(shape_str):
    return [(float(p.split(',')[0]), float(p.split(',')[1])) for p in shape_str.split()]

edge_0_points = parse_points(edge_0_shape)
edge_1_points = parse_points(edge_1_shape)
lane_0_points = parse_points(lane_0_shape)
lane_1_points = parse_points(lane_1_shape)

# Full centerline (edge-based)
full_centerline = edge_0_points + edge_1_points

print(f"\n1. REPOSITORY STATE")
print(f"   Branch: fix/gate4-native-pipeline-v3")
print(f"   HEAD: 45ae2d1206acd4c489be327a9fe1e604507050a2")
print(f"   Working tree clean: NO (package.json, package-lock.json modified)")

print(f"\n2. SUMO EDGES AND LANE IDS USED")
print(f"   OSM Way ID: 109459194")
print(f"   Used edges: 109459194#0 -> 109459194#1")
print(f"   Lanes used: 109459194#0_0 -> 109459194#1_0")

print(f"\n3. SUMO netOffset")
print(f"   netOffsetX: {SUMO_NET_OFFSET_X}")
print(f"   netOffsetY: {SUMO_NET_OFFSET_Y}")

print(f"\n4. ORTHOPHOTO WGS84 BOUNDING BOX")
print(f"   Size: 1024m x 1024m centred on Bánovce")
print(f"   Center: {BANOVCE_LON:.8f}, {BANOVCE_LAT:.8f}")
print(f"   SW: {utm_to_wgs84(min_easting, min_northing) if 'utm_to_wgs84' in dir() else 'calculated'}")
print(f"   NE: {utm_to_wgs84(max_easting, max_northing) if 'utm_to_wgs84' in dir() else 'calculated'}")

# Transform centerline to local centered coordinates
# In sumo-road-source.ts:
# 1. UTM: subtract netOffset from SUMO coordinates
# 2. Local: subtract minEasting/minNorthing 
# 3. Centered: subtract halfExtent (512)

centered_points = []
for pt in full_centerline:
    utm_x = pt[0] - SUMO_NET_OFFSET_X
    utm_y = pt[1] - SUMO_NET_OFFSET_Y
    local_x = utm_x - min_easting
    local_y = utm_y - min_northing
    centered_x = local_x - 512.0  # halfExtent
    centered_y = local_y - 512.0
    centered_points.append((centered_x, centered_y))

print(f"\n5. CENTERLINE COORDINATE TRANSFORMATION")
print(f"   Total centerline points: {len(full_centerline)}")
print(f"   Centered X range: [{min(p[0] for p in centered_points):.2f}, {max(p[0] for p in centered_points):.2f}]")
print(f"   Centered Y range: [{min(p[1] for p in centered_points):.2f}, {max(p[1] for p in centered_points):.2f}]")

# The join point between edge 0 and edge 1
join_idx = len(edge_0_points) - 1  # Last point of edge 0 = first point of edge 1
join_pt = centered_points[join_idx]

print(f"\n   Join point (edge 0 -> edge 1 transition):")
print(f"     Index: {join_idx}")
print(f"     Centered: ({join_pt[0]:.3f}, {join_pt[1]:.3f})")

# Calculate four mapping candidates
def get_runtime_coords(centered_x, centered_y, mapping_type):
    logical_x = centered_x + WORLD_SAMPLE_CENTER
    logical_y = centered_y + WORLD_SAMPLE_CENTER
    
    if mapping_type == 'A':  # no-flip
        return (logical_x, logical_y)
    elif mapping_type == 'B':  # X flip
        return (WORLD_RUNTIME_SPAN - logical_x, logical_y)
    elif mapping_type == 'C':  # Y flip
        return (logical_x, WORLD_RUNTIME_SPAN - logical_y)
    elif mapping_type == 'D':  # X+Y flip (current)
        return (WORLD_RUNTIME_SPAN - logical_x, WORLD_RUNTIME_SPAN - logical_y)

# Generate runtime coordinates for all 4 mappings
runtime_coords = {m: [get_runtime_coords(p[0], p[1], m) for p in centered_points] for m in ['A', 'B', 'C', 'D']}

print(f"\n6. DECALROAD RUNTIME COORDINATES (sample point at join)")
print(f"   Centered: ({join_pt[0]:.3f}, {join_pt[1]:.3f})")
print(f"   Logical (centered + 511.5): ({join_pt[0] + WORLD_SAMPLE_CENTER:.3f}, {join_pt[1] + WORLD_SAMPLE_CENTER:.3f})")
for m in ['A', 'B', 'C', 'D']:
    rc = runtime_coords[m][join_idx]
    print(f"   Mapping {m}: ({rc[0]:.3f}, {rc[1]:.3f})")

# Extract orthophoto and create comparison image
zip_file = Path("dist/roadfix02.zip")
with zipfile.ZipFile(zip_file, 'r') as zf:
    ortho_path = [n for n in zf.namelist() if 'ground_d.png' in n.lower()][0]
    ortho_img = Image.open(zf.open(ortho_path))

ortho_w, ortho_h = ortho_img.size

# Create comparison image
output = Image.new('RGBA', (ortho_w * 2, ortho_h), (30, 30, 30, 255))
output.paste(ortho_img, (0, 0))

draw = ImageDraw.Draw(output)

colors = {'A': (255, 0, 0), 'B': (0, 255, 0), 'C': (0, 0, 255), 'D': (255, 255, 0)}
labels = {'A': 'No-flip', 'B': 'X-flip', 'C': 'Y-flip', 'D': 'X+Y-flip (current)'}

# Right side: orthophoto with all four centerlines overlaid
right_img = ortho_img.copy()
right_draw = ImageDraw.Draw(right_img)

def to_pixel_with_rotation(cx, cy, img_w, img_h):
    """Convert runtime coords to pixels with 180 rotation (as ortho-generator applies)."""
    px = int(cx)
    py = int(cy)
    # Clamp to valid range
    px = max(0, min(img_w - 1, px))
    py = max(0, min(img_h - 1, py))
    # Apply 180 rotation
    return img_w - 1 - px, img_h - 1 - py

for m in ['A', 'B', 'C', 'D']:
    pts = runtime_coords[m]
    pixel_pts = [to_pixel_with_rotation(p[0], p[1], ortho_w, ortho_h) for p in pts]
    for i in range(len(pixel_pts) - 1):
        right_draw.line([pixel_pts[i], pixel_pts[i+1]], fill=colors[m], width=2)

# Mark key points
key_indices = [0, join_idx, len(centered_points) - 1]
for idx in key_indices:
    rc = runtime_coords['D'][idx]
    px, py = to_pixel_with_rotation(rc[0], rc[1], ortho_w, ortho_h)
    right_draw.ellipse([px-5, py-5, px+5, py+5], outline=(255, 255, 255), width=2)

# Add legend
for i, m in enumerate(['A', 'B', 'C', 'D']):
    right_draw.rectangle([10, 10 + i*25, 25, 25 + i*25], fill=colors[m])
    right_draw.text([30, 10 + i*25], labels[m], fill=(255, 255, 255))

output.paste(right_img, (ortho_w, 0))

temp_dir = Path("C:/Users/tomisu/AppData/Local/Temp/triworld-roadfix02-audit")
temp_dir.mkdir(parents=True, exist_ok=True)
output.save(temp_dir / "alignment_candidates.png")

print(f"\n7. DIAGNOSTIC IMAGE")
print(f"   Saved to: {temp_dir / 'alignment_candidates.png'}")

# Analyze corridor modification (theoretical)
# The corridor modifies cells along the road centerline
# The key question: where are those cells in the 1024x1024 grid?

print(f"\n8. CORRIDOR COMPARISON ANALYSIS")
print(f"   Terrain grid N = 1024, half = (N-1)/2 = 511.5")
print(f"   Corridor uses centered coordinates (x, y) where:")
print(f"     column = x/squareSize + 511.5")
print(f"     row = 511.5 - y/squareSize")

# For a centered point (x_c, y_c), the grid column/row is:
# col = x_c + 511.5
# row = 511.5 - y_c
# 
# The DecalRoad mapping uses:
# runtime_x = 1023 - (x_c + 511.5) for X+Y flip
# runtime_y = 1023 - (y_c + 511.5)
#
# The orthophoto rotation uses:
# pixel_x = 1023 - runtime_x
# pixel_y = 1023 - runtime_y
#
# Combining these for X+Y flip:
# pixel_x = 1023 - (1023 - (x_c + 511.5)) = x_c + 511.5
# pixel_y = 1023 - (1023 - (y_c + 511.5)) = y_c + 511.5
#
# So the X+Y flip SHOULD align the road with the orthophoto!
# But there might be an issue with the span value...

print(f"\n   For X+Y flip mapping:")
print(f"     pixel_x = x_c + 511.5 (approximately)")
print(f"     pixel_y = y_c + 511.5 (approximately)")
print(f"   This SHOULD align DecalRoad with rotated orthophoto!")

print(f"\n   POTENTIAL ISSUE:")
print(f"   WORLD_RUNTIME_SPAN = 1023.0 (N-1)")
print(f"   But orthophoto is 1024 pixels (0-1023)")
print(f"   If we use 1023.0 for flip but orthophoto has 1024 pixels...")
print(f"   The span should be 1024.0 or 1023.5 to match pixel indices!")

# Summary
print(f"\n" + "=" * 70)
print("AUDIT SUMMARY - ROOT CAUSE HYPOTHESIS")
print("=" * 70)
print(f"""
The 180-degree rotation in ortho-generator.ts corrects the UV orientation
for the TerrainBlock. The rotation formula is:
    dstX = w - 1 - srcX
    dstY = h - 1 - srcY

This means pixel (0,0) maps to (1023, 1023) and vice versa.

In build-roadfix02-cli.ts, the DecalRoad X+Y flip uses:
    runtimeX = 1023 - (centeredX + 511.5)
    runtimeY = 1023 - (centeredY + 511.5)

If centeredX = -5.1, then:
    logicalX = -5.1 + 511.5 = 506.4
    runtimeX = 1023 - 506.4 = 516.6
    pixelX = 1023 - 516.6 = 506.4

This seems correct... BUT wait!

The issue might be: WORLD_RUNTIME_SPAN should be 1024.0, not 1023.0
OR there's a half-cell offset error.

Alternatively: The corridor uses the SAME centered coordinates,
so the DecalRoad should align with the corridor regardless of orthophoto rotation.
The question is whether the corridor itself is in the correct position.
""")

# Save analysis
analysis = {
    "hypothesis": "Span value mismatch: 1023.0 vs 1024.0 pixels",
    "world_runtime_span": WORLD_RUNTIME_SPAN,
    "orthophoto_pixels": 1024,
    "centered_sample": centered_points[0],
    "runtime_sample_D": runtime_coords['D'][0],
    "join_index": join_idx
}

with open("tmp_audit/final_analysis.json", 'w') as f:
    json.dump(analysis, f, indent=2)

print(f"\nAnalysis saved to: tmp_audit/final_analysis.json")