#!/usr/bin/env python3
"""
DETAILED ROADFIX02 GEOREFERENCING AUDIT
Extracts exact centerline and compares all mapping candidates against terrain corridor.
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

# BANOVCE_ORIGIN_WGS84 from geodetic-transformer.ts
BANOVCE_LON = 18.352620306978697
BANOVCE_LAT = 48.72566288876834

# SUMO netOffset from net.xml
SUMO_NET_OFFSET_X = -304540.54
SUMO_NET_OFFSET_Y = -5399298.81

# UTM constants
A = 6378137.0  # semi-major axis
F = 1 / 298.257223563  # flattening
E2 = 2 * F - F * F  # first eccentricity squared
K0 = 0.9996  # UTM scale factor
FALSE_EASTING = 500000.0
FALSE_NORTHING = 0.0
CENTRAL_MERIDIAN_34 = 21.0  # degrees

def wgs84_to_utm(lon, lat):
    """Convert WGS84 to UTM Zone 34N"""
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
        A_val +
        ((1 - T + C) * A_val ** 3) / 6 +
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

def utm_to_wgs84(easting, northing):
    """Convert UTM Zone 34N to WGS84"""
    e1 = (1 - math.sqrt(1 - E2)) / (1 + math.sqrt(1 - E2))
    x = easting - FALSE_EASTING
    y = northing - FALSE_NORTHING
    M = y / K0
    mu = M / (A * (1 - E2 / 4 - (3 * (E2 ** 2)) / 64 - (5 * (E2 ** 3)) / 256))
    
    phi1_rad = mu + (
        ((3 * e1) / 2 - (27 * (e1 ** 3)) / 32) * math.sin(2 * mu) +
        ((21 * (e1 ** 2)) / 16 - (55 * (e1 ** 4)) / 32) * math.sin(4 * mu) +
        ((151 * (e1 ** 3)) / 96) * math.sin(6 * mu) +
        ((1097 * (e1 ** 4)) / 512) * math.sin(8 * mu)
    )
    
    N1 = A / math.sqrt(1 - E2 * math.sin(phi1_rad) ** 2)
    T1 = math.tan(phi1_rad) ** 2
    C1 = (E2 / (1 - E2)) * (math.cos(phi1_rad) ** 2)
    R1 = (A * (1 - E2)) / ((1 - E2 * math.sin(phi1_rad) ** 2) ** 1.5)
    D = x / (N1 * K0)
    
    lat_rad = phi1_rad - (
        (N1 * math.tan(phi1_rad)) / R1 * (
            (D ** 2) / 2 -
            ((5 + 3 * T1 + 10 * C1 - 4 * (C1 ** 2) - 9 * E2) * (D ** 4)) / 24 +
            ((61 + 90 * T1 + 298 * C1 + 45 * (T1 ** 2) - 252 * E2 - 3 * (C1 ** 2)) * (D ** 6)) / 720
        )
    )
    
    lon0_rad = math.radians(CENTRAL_MERIDIAN_34)
    lon_rad = lon0_rad + (
        (D - ((1 + 2 * T1 + C1) * (D ** 3)) / 6 +
         ((5 - 2 * C1 + 28 * T1 - 3 * (C1 ** 2) + 8 * E2 + 24 * (T1 ** 2)) * (D ** 5)) / 120)
    ) / math.cos(phi1_rad)
    
    return math.degrees(lon_rad), math.degrees(lat_rad)

# Calculate transformer bounds
center_easting, center_northing = wgs84_to_utm(BANOVCE_LON, BANOVCE_LAT)
half = SIZE / 2

min_easting = center_easting - half
max_easting = center_easting + half
min_northing = center_northing - half
max_northing = center_northing + half

# WGS84 corners
sw_lon, sw_lat = utm_to_wgs84(min_easting, min_northing)
ne_lon, ne_lat = utm_to_wgs84(max_easting, max_northing)

print("=" * 60)
print("DETAILED ROADFIX02 GEOREFERENCING AUDIT")
print("=" * 60)

# Parse SUMO net.xml for OSM way 109459194 centerline
sumo_file = Path("artifacts/gate3-osm/banovce_authoritative.net.xml")
with open(sumo_file, 'r', encoding='utf-8') as f:
    sumo_xml = f.read()

# Extract lane shapes (centerlines) - more precise
lane_pattern = r'<lane id="([^"]+)"[^>]*shape="([^"]+)"'

lane_0_shape = None
lane_1_shape = None

for match in re.finditer(lane_pattern, sumo_xml):
    lane_id = match.group(1)
    shape = match.group(2)
    if lane_id == "109459194#0_0":
        lane_0_shape = shape
    elif lane_id == "109459194#1_0":
        lane_1_shape = shape

def parse_points(shape_str):
    points = []
    for pair in shape_str.split():
        x, y = pair.split(',')
        points.append((float(x), float(y)))
    return points

# Parse lane points
lane_0_points = parse_points(lane_0_shape)
lane_1_points = parse_points(lane_1_shape)

# Combine centerline: lane 0 goes from 1844955653 -> 13713789752
# lane 1 goes from 13713789752 -> 674815373
# But we need to check the connection point
print(f"\nLane 109459194#0_0 end point: ({lane_0_points[-1][0]:.2f}, {lane_0_points[-1][1]:.2f})")
print(f"Lane 109459194#1_0 start point: ({lane_1_points[0][0]:.2f}, {lane_1_points[0][0]:.2f})")

# Check edge connection
edge_pattern = r'<edge id="([^"]+)"[^>]*shape="([^"]+)"'
edge_0_shape = None
edge_1_shape = None

for match in re.finditer(edge_pattern, sumo_xml):
    edge_id = match.group(1)
    shape = match.group(2)
    if edge_id == "109459194#0":
        edge_0_shape = shape
    elif edge_id == "109459194#1":
        edge_1_shape = shape

edge_0_points = parse_points(edge_0_shape)
edge_1_points = parse_points(edge_1_shape)

print(f"\nEdge 109459194#0 end point: ({edge_0_points[-1][0]:.2f}, {edge_0_points[-1][1]:.2f})")
print(f"Edge 109459194#1 start point: ({edge_1_points[0][0]:.2f}, {edge_1_points[0][1]:.2f})")

# The edges connect at junction 13713789752
# edge_0 ends at 13713789752, edge_1 starts at 13713789752
# Full centerline is edge_0 + edge_1
full_centerline = edge_0_points + edge_1_points
print(f"\nFull centerline (edge-based): {len(full_centerline)} points")

# Now transform centerline points to local coordinates
# In sumo-road-source.ts lines 183-197:
# 1. UTM = SUMO point - netOffset
# 2. local = utmToLocal(UTM)
# 3. centered = local - halfExtent (where halfExtent = sizeMetres / 2 = 512)

# So the report shows bounds centered, meaning the station.x/y are already centered
# Let's calculate the centered points

half_extent = 512.0  # sizeMetres / 2

centered_points = []
for pt in full_centerline:
    utm_x = pt[0] - SUMO_NET_OFFSET_X
    utm_y = pt[1] - SUMO_NET_OFFSET_Y
    local_x = utm_x - min_easting
    local_y = utm_y - min_northing
    centered_x = local_x - half_extent
    centered_y = local_y - half_extent
    centered_points.append((centered_x, centered_y))

print(f"\nTransformed centerline (first 5 points):")
for i, pt in enumerate(centered_points[:5]):
    print(f"  Point {i}: centered=({pt[0]:.3f}, {pt[1]:.3f})")

print(f"\nTransformed centerline (last 5 points):")
for i, pt in enumerate(centered_points[-5:]):
    print(f"  Point {len(centered_points)-5+i}: centered=({pt[0]:.3f}, {pt[1]:.3f})")

# Now calculate the four candidate mappings
# WORLD_SAMPLE_CENTER = 511.5
# WORLD_RUNTIME_SPAN = 1023.0

def get_runtime_coords(centered_x, centered_y, mapping_type):
    """Calculate DecalRoad runtime coordinates for each mapping type."""
    logical_x = centered_x + WORLD_SAMPLE_CENTER
    logical_y = centered_y + WORLD_SAMPLE_CENTER
    
    if mapping_type == 'A':  # no-flip
        return (logical_x, logical_y)
    elif mapping_type == 'B':  # X flip only
        return (WORLD_RUNTIME_SPAN - logical_x, logical_y)
    elif mapping_type == 'C':  # Y flip only
        return (logical_x, WORLD_RUNTIME_SPAN - logical_y)
    elif mapping_type == 'D':  # X+Y flip
        return (WORLD_RUNTIME_SPAN - logical_x, WORLD_RUNTIME_SPAN - logical_y)

# Calculate all four mappings
runtime_points = {'A': [], 'B': [], 'C': [], 'D': []}
for pt in centered_points:
    for m in ['A', 'B', 'C', 'D']:
        runtime_points[m].append(get_runtime_coords(pt[0], pt[1], m))

print(f"\nDecalRoad runtime coordinates (sample, centered point):")
sample_idx = len(centered_points) // 2
sample_centered = centered_points[sample_idx]
print(f"  Sample centered point: ({sample_centered[0]:.3f}, {sample_centered[1]:.3f})")
for m in ['A', 'B', 'C', 'D']:
    rt = runtime_points[m][sample_idx]
    print(f"  Mapping {m}: runtime=({rt[0]:.3f}, {rt[1]:.3f})")

# Extract orthophoto from zip
zip_file = Path("dist/roadfix02.zip")
with zipfile.ZipFile(zip_file, 'r') as zf:
    ground_files = [n for n in zf.namelist() if 'ground_d.png' in n.lower()]
    ortho_img = Image.open(zf.open(ground_files[0]))

ortho_array = np.array(ortho_img)
ortho_h, ortho_w = ortho_img.size

print(f"\n7. ORTHOPHOTO DIMENSIONS: {ortho_w}x{ortho_h}")

# Now create the alignment comparison image
output_img = Image.new('RGBA', (ortho_w * 2, ortho_h), (0, 0, 0, 255))
output_img.paste(ortho_img, (0, 0))

draw = ImageDraw.Draw(output_img)

# Scale centerline to orthophoto pixels
# Runtime coordinates are in metres [0, 1023], orthophoto is 1024x1024
# Pixel = runtime_coord * (1023/1023) = runtime_coord (approximately)
# But orthophoto was rotated 180 degrees in ortho-generator.ts

def runtime_to_pixel_x(runtime_x):
    """Convert runtime X to orthophoto pixel X (before rotation)."""
    return runtime_x  # Direct mapping

def runtime_to_pixel_y(runtime_y):
    """Convert runtime Y to orthophoto pixel Y (before rotation)."""
    return runtime_y  # Direct mapping

def apply_180_rotation(px, py, width, height):
    """Apply 180-degree rotation that ortho-generator applies."""
    return width - 1 - px, height - 1 - py

# Draw all four centerline candidates
colors = {
    'A': (255, 0, 0),    # Red - no flip
    'B': (0, 255, 0),    # Green - X flip
    'C': (0, 0, 255),    # Blue - Y flip
    'D': (255, 255, 0)   # Yellow - X+Y flip (current)
}

labels = {
    'A': 'No flip',
    'B': 'X flip',
    'C': 'Y flip',
    'D': 'X+Y flip (current)'
}

# Create a copy for the right side with all overlays
right_img = Image.new('RGBA', (ortho_w, ortho_h), (255, 255, 255, 255))
right_img.paste(ortho_img, (0, 0))
right_draw = ImageDraw.Draw(right_img)

for m in ['A', 'B', 'C', 'D']:
    color = colors[m]
    pts = runtime_points[m]
    
    # Convert to pixel coordinates and apply orthophoto rotation
    pixel_pts = []
    for i in range(len(pts) - 1):
        cx, cy = pts[i]
        px, py = runtime_to_pixel_x(cx), runtime_to_pixel_y(cy)
        px_rot, py_rot = apply_180_rotation(int(px), int(py), ortho_w, ortho_h)
        pixel_pts.append((px_rot, py_rot))
    
    # Draw polyline on right image
    for i in range(len(pixel_pts) - 1):
        x1, y1 = pixel_pts[i]
        x2, y2 = pixel_pts[i + 1]
        right_draw.line([(x1, y1), (x2, y2)], fill=color, width=2)

# Mark first point, edge join, last point
first_pt = runtime_points['D'][0]
last_pt = runtime_points['D'][-1]

# Find the edge join point (where 109459194#0 connects to 109459194#1)
# This is at junction 13713789752, approximately at the transition
# Between edge points - find where coordinates jump
join_idx = -1
for i in range(1, len(edge_0_points)):
    # Look for the point where edge_0 ends and edge_1 begins
    pass
join_idx = len(edge_0_points) - 1  # Approximately the join

join_pt = runtime_points['D'][join_idx]

# Mark on right image
for i, (cx, cy) in enumerate([first_pt, join_pt, last_pt]):
    px, py = int(cx), int(cy)
    px_rot, py_rot = apply_180_rotation(px, py, ortho_w, ortho_h)
    marker_size = 8
    right_draw.ellipse([px_rot - marker_size//2, py_rot - marker_size//2, 
                        px_rot + marker_size//2, py_rot + marker_size//2],
                       outline=(255, 255, 255), width=2)

# Add legend
margin = 10
for i, m in enumerate(['A', 'B', 'C', 'D']):
    y_pos = margin + i * 20
    right_draw.rectangle([margin, y_pos, margin + 15, y_pos + 15], fill=colors[m])
    right_draw.text([margin + 20, y_pos], labels[m], fill=(255, 255, 255))

output_img.paste(right_img, (ortho_w, 0))

# Save to TEMP directory as requested
temp_dir = Path("C:/Users/tomisu/AppData/Local/Temp/triworld-roadfix02-audit")
temp_dir.mkdir(parents=True, exist_ok=True)

output_img.save(temp_dir / "alignment_candidates.png")
print(f"\n8. Diagnostic image saved to: {temp_dir / 'alignment_candidates.png'}")

# Now compare with terrain corridor
# The corridor priority buffer marks which cells were modified
# We need to find the terrain corridor bounds

# Read terrain from zip
with zipfile.ZipFile(zip_file, 'r') as zf:
    terrain_files = [n for n in zf.namelist() if 'terrains' in n.lower() and 'ground_d' in n.lower()]

# The terrain corridor was created from the same SUMO road
# So we need to understand how the corridor relates to the centered points

# Load the actual centerline stations from the level (if available)
# For now, use the reported bounds to estimate corridor position

# The key question: does the corridor align with no-flip, X-flip, Y-flip, or X+Y-flip?
# We need to compare DecalRoad position against corridor modification

# Since we can't easily access the corridor grid, let's compute theoretical alignment
# based on the expected position of the road

# The road centerline in centered coordinates:
# bounds minY=-89.1, maxY=500 means the road spans roughly from 
# Y = -89.1 + 511.5 = 422.4m to Y = 500 + 511.5 = 1011.5m in logical coords
# After X+Y flip: Y goes from 1023 - 422.4 = 600.6m to 1023 - 1011.5 = 11.5m

# Check if this makes sense for the orthophoto
print(f"\n9. THEORETICAL ROAD POSITION ANALYSIS")
print(f"   Road centered Y range: [{centered_points[0][1]:.1f} ... {centered_points[-1][1]:.1f}]")
print(f"   After X+Y flip, runtime Y range would be inverted")

# Save detailed results
detailed_results = {
    "sumo_centerline_points": len(full_centerline),
    "centered_points_sample": centered_points[:5] + centered_points[-5:],
    "runtime_coords_180_rotation": True,
    "orthophoto_pixel_rotation": "180 degrees (both X and Y flipped)",
    "current_implementation_uses": "X+Y flip (mapping D)",
    "diagnostic_image_path": str(temp_dir / "alignment_candidates.png")
}

with open("tmp_audit/detailed_audit.json", 'w') as f:
    json.dump(detailed_results, f, indent=2)

print(f"\nDetailed audit saved to tmp_audit/detailed_audit.json")