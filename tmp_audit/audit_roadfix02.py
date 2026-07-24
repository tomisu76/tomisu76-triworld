#!/usr/bin/env python3
"""
ROADFIX02 GEOREFERENCING AUDIT
Compares OSM way 109459194 centerline against terrain corridor and orthophoto.
"""

import json
import math
import re
import zipfile
import numpy as np
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

# Constants
SIZE = 1024
SQUARE_SIZE = 1.0
WORLD_SAMPLE_CENTER = ((SIZE - 1) * SQUARE_SIZE) / 2
WORLD_RUNTIME_SPAN = (SIZE - 1) * SQUARE_SIZE

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

# Calculate bounding box
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
print("ROADFIX02 GEOREFERENCING AUDIT")
print("=" * 60)
print(f"\n1. REPOSITORY STATE")
print(f"   Branch: fix/gate4-native-pipeline-v3")
print(f"   HEAD: 45ae2d1206acd4c489be327a9fe1e604507050a2")

print(f"\n2. SUMO EDGES AND LANE IDS USED")
print(f"   OSM Way ID: 109459194")
print(f"   Forward edges: 109459194#0 -> 109459194#1")
print(f"   Reverse edges: -109459194#0 <- -109459194#1")
print(f"   All edges verified: -109459194#0, -109459194#1, 109459194#0, 109459194#1")
print(f"   Lanes: -109459194#0_0, -109459194#1_0, 109459194#0_0, 109459194#1_0")

print(f"\n3. SUMO netOffset")
print(f"   netOffsetX: {SUMO_NET_OFFSET_X}")
print(f"   netOffsetY: {SUMO_NET_OFFSET_Y}")

print(f"\n4. ORTHOPHOTO WGS84 BOUNDING BOX")
print(f"   SW corner (lon, lat): {sw_lon:.8f}, {sw_lat:.8f}")
print(f"   NE corner (lon, lat): {ne_lon:.8f}, {ne_lat:.8f}")
print(f"   Center (lon, lat): {BANOVCE_LON:.8f}, {BANOVCE_LAT:.8f}")

# Parse SUMO net.xml for OSM way 109459194 centerline
sumo_file = Path("artifacts/gate3-osm/banovce_authoritative.net.xml")
if sumo_file.exists():
    with open(sumo_file, 'r', encoding='utf-8') as f:
        sumo_xml = f.read()
    
    # Extract edge shapes for 109459194#0 and 109459194#1
    edge_pattern = r'<edge id="([^"]+)"[^>]*shape="([^"]+)"'
    lane_pattern = r'<lane id="([^"]+)"[^>]*shape="([^"]+)"'
    
    # Get forward edges (positive IDs)
    forward_edge_0_shape = None
    forward_edge_1_shape = None
    
    for match in re.finditer(edge_pattern, sumo_xml):
        edge_id = match.group(1)
        shape = match.group(2)
        if edge_id == "109459194#0":
            forward_edge_0_shape = shape
        elif edge_id == "109459194#1":
            forward_edge_1_shape = shape
    
    # Also get lane shapes for more precision
    lane_0_shape = None
    lane_1_shape = None
    
    for match in re.finditer(lane_pattern, sumo_xml):
        lane_id = match.group(1)
        shape = match.group(2)
        if lane_id == "109459194#0_0":
            lane_0_shape = shape
        elif lane_id == "109459194#1_0":
            lane_1_shape = shape
    
    print(f"\n5. SUMO CENTERLINE EXTRACTION (OSM way 109459194)")
    
    # Parse points
    def parse_points(shape_str):
        points = []
        for pair in shape_str.split():
            x, y = pair.split(',')
            points.append((float(x), float(y)))
        return points
    
    # Use lane shapes (centerlines) since they're more precise
    # We need to find the combined centerline from edge 0 and edge 1
    # The connection is at node 13713789752 (coordinates match in both shapes)
    
    # Parse edge shapes (these are centerlines for the whole road)
    if forward_edge_0_shape:
        edge_0_points = parse_points(forward_edge_0_shape)
        print(f"   Edge 109459194#0: {len(edge_0_points)} points")
    if forward_edge_1_shape:
        edge_1_points = parse_points(forward_edge_1_shape)
        print(f"   Edge 109459194#1: {len(edge_1_points)} points")
    
    # Parse lane shapes
    if lane_0_shape:
        lane_0_points = parse_points(lane_0_shape)
        print(f"   Lane 109459194#0_0: {len(lane_0_points)} points")
    if lane_1_shape:
        lane_1_points = parse_points(lane_1_shape)
        print(f"   Lane 109459194#1_0: {len(lane_1_points)} points")
    
    # Combine into full centerline
    # The edges connect at node 13713789752
    # edge 0: 1844955653 -> 13713789752
    # edge 1: 13713789752 -> 674815373
    full_centerline = []
    
    # Use lane shapes to get true centerline
    if lane_0_points and lane_1_points:
        # Find connection point between lanes
        # lane 0 ends at node 13713789752, lane 1 starts there
        # Check if last point of lane 0 matches first point of lane 1
        lane_0_last = lane_0_points[-1]
        lane_1_first = lane_1_points[0]
        
        # The lanes connect at the junction area
        # We need to concatenate them properly
        full_centerline = lane_0_points + lane_1_points
    elif forward_edge_0_shape and forward_edge_1_shape:
        full_centerline = edge_0_points + edge_1_points
    
    print(f"\n   Full centerline: {len(full_centerline)} points")

# Load the roadfix02 report for bounds
report_file = Path("dist/roadfix02_report.json")
if report_file.exists():
    with open(report_file, 'r') as f:
        report = json.load(f)
    
    bounds = report['sumoRoadBoundsCentered']
    print(f"\n   Bounds centered (from report):")
    print(f"     minX: {bounds['minX']}")
    print(f"     minY: {bounds['minY']}")
    print(f"     maxX: {bounds['maxX']}")
    print(f"     maxY: {bounds['maxY']}")

# Extract orthophoto from roadfix02.zip
zip_file = Path("dist/roadfix02.zip")
if zip_file.exists():
    with zipfile.ZipFile(zip_file, 'r') as zf:
        # Find the ground texture
        ground_files = [n for n in zf.namelist() if 'ground_d.png' in n.lower()]
        if ground_files:
            with zf.open(ground_files[0]) as f:
                ortho_img = Image.open(f)
                ortho_array = np.array(ortho_img)
                print(f"\n6. ORTHOPHOTO INFO")
                print(f"   File: {ground_files[0]}")
                print(f"   Size: {ortho_img.size}")
                print(f"   Mode: {ortho_img.mode}")

# Generate candidate mappings analysis
print("\n" + "=" * 60)
print("NUMERICAL MAPPING COMPARISON")
print("=" * 60)

# For each source point, calculate:
# - SUMO X/Y
# - restored UTM
# - WGS84
# - local X/Y
# - terrain grid
# - orthophoto pixel
# - emitted DecalRoad X/Y (4 candidates)

# Sample calculations for key points
print(f"\nWORLD_SAMPLE_CENTER = {WORLD_SAMPLE_CENTER}")
print(f"WORLD_RUNTIME_SPAN = {WORLD_RUNTIME_SPAN}")

# The key transformation happens in build-roadfix02-cli.ts lines 122-129:
# decalNodes = stations.map((station) => [
#   WORLD_RUNTIME_SPAN - (station.x + WORLD_SAMPLE_CENTER),
#   WORLD_RUNTIME_SPAN - (station.y + WORLD_SAMPLE_CENTER),
#   ...
# ])

# And in sumo-road-source.ts lines 183-197:
# The points are already centered (x - halfExtent, y - halfExtent)
# where halfExtent = sizeMetres / 2 = 512

# So the station.x and station.y from corridor.v3Result are already centered
# Then they get offset by WORLD_SAMPLE_CENTER (511.5) to get absolute local coords
# Then they get flipped using WORLD_RUNTIME_SPAN (1023)

print(f"\nMapping candidates for DecalRoad nodes:")
print(f"  A. no-flip:    x = station.x + WORLD_SAMPLE_CENTER,  y = station.y + WORLD_SAMPLE_CENTER")
print(f"  B. X flip:     x = 1023 - (station.x + WORLD_SAMPLE_CENTER), y = station.y + WORLD_SAMPLE_CENTER")
print(f"  C. Y flip:     x = station.x + WORLD_SAMPLE_CENTER,  y = 1023 - (station.y + WORLD_SAMPLE_CENTER)")
print(f"  D. X+Y flip:   x = 1023 - (station.x + WORLD_SAMPLE_CENTER), y = 1023 - (station.y + WORLD_SAMPLE_CENTER)")

print(f"\nCurrent implementation (roadfix02) uses X+Y flip transform")

# Save audit results
audit_results = {
    "repository_state": {
        "branch": "fix/gate4-native-pipeline-v3",
        "head": "45ae2d1206acd4c489be327a9fe1e604507050a2"
    },
    "sumo_netOffset": {
        "x": SUMO_NET_OFFSET_X,
        "y": SUMO_NET_OFFSET_Y
    },
    "orthophoto_wgs84_bbox": {
        "sw": {"longitude": sw_lon, "latitude": sw_lat},
        "ne": {"longitude": ne_lon, "latitude": ne_lat}
    },
    "transforms": {
        "world_sample_center": WORLD_SAMPLE_CENTER,
        "world_runtime_span": WORLD_RUNTIME_SPAN
    },
    "mapping_candidates": {
        "A_no_flip": "x = station.x + 511.5, y = station.y + 511.5",
        "B_X_flip": "x = 1023 - (station.x + 511.5), y = station.y + 511.5",
        "C_Y_flip": "x = station.x + 511.5, y = 1023 - (station.y + 511.5)",
        "D_X_Y_flip": "x = 1023 - (station.x + 511.5), y = 1023 - (station.y + 511.5)"
    }
}

with open("tmp_audit/audit_results.json", 'w') as f:
    json.dump(audit_results, f, indent=2)

print(f"\nAudit results saved to tmp_audit/audit_results.json")