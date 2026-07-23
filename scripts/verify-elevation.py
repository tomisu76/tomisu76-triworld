import io
import json
import math
import statistics
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

from PIL import Image

CENTER_LAT = 48.73275071557837
CENTER_LON = 18.34344407408825
SIZE_M = 2000
ZOOM = 14
TILE_SIZE = 256
TILE_CACHE = {}


def fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "TriWorld-elevation-verifier/1.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def tile_xy(lon: float, lat: float, zoom: int):
    n = 2 ** zoom
    lat_rad = math.radians(max(-85.05112878, min(85.05112878, lat)))
    x = (lon + 180.0) / 360.0 * n
    y = (1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n
    return x, y


def read_tile(tile_x: int, tile_y: int):
    key = (tile_x, tile_y)
    if key not in TILE_CACHE:
        url = f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{ZOOM}/{tile_x}/{tile_y}.png"
        TILE_CACHE[key] = Image.open(io.BytesIO(fetch(url))).convert("RGB")
    return TILE_CACHE[key]


def terrarium_height(lon: float, lat: float) -> float:
    tx, ty = tile_xy(lon, lat, ZOOM)
    px = tx * TILE_SIZE - 0.5
    py = ty * TILE_SIZE - 0.5
    x0 = math.floor(px)
    y0 = math.floor(py)
    fx = px - x0
    fy = py - y0

    def sample(global_x: int, global_y: int) -> float:
        tile_count = 2 ** ZOOM
        tile_x = (global_x // TILE_SIZE) % tile_count
        tile_y = max(0, min(tile_count - 1, global_y // TILE_SIZE))
        image = read_tile(tile_x, tile_y)
        pixel_x = global_x % TILE_SIZE
        pixel_y = global_y % TILE_SIZE
        r, g, b = image.getpixel((pixel_x, pixel_y))
        return r * 256 + g + b / 256.0 - 32768.0

    h00 = sample(x0, y0)
    h10 = sample(x0 + 1, y0)
    h01 = sample(x0, y0 + 1)
    h11 = sample(x0 + 1, y0 + 1)
    north = h00 + (h10 - h00) * fx
    south = h01 + (h11 - h01) * fx
    return north + (south - north) * fy


def make_points():
    metres_per_lat = 111_320.0
    metres_per_lon = metres_per_lat * math.cos(math.radians(CENTER_LAT))
    offsets = [-1000, -500, 0, 500, 1000]
    points = []
    for north in offsets:
        for east in offsets:
            points.append((
                CENTER_LAT + north / metres_per_lat,
                CENTER_LON + east / metres_per_lon,
                east,
                north,
            ))
    return points


def open_meteo(points):
    lats = ",".join(f"{p[0]:.8f}" for p in points)
    lons = ",".join(f"{p[1]:.8f}" for p in points)
    url = "https://api.open-meteo.com/v1/elevation?" + urllib.parse.urlencode({"latitude": lats, "longitude": lons}, safe=",")
    return json.loads(fetch(url))["elevation"]


def open_topodata(points):
    locations = "|".join(f"{p[0]:.8f},{p[1]:.8f}" for p in points)
    url = "https://api.opentopodata.org/v1/mapzen?" + urllib.parse.urlencode({"locations": locations}, safe="|,")
    payload = json.loads(fetch(url))
    return [result["elevation"] for result in payload["results"]]


def stats(values):
    return {
        "minimum": min(values),
        "maximum": max(values),
        "relief": max(values) - min(values),
        "mean": statistics.mean(values),
    }


def inspect_wcs():
    url = "https://inspirews.skgeodesy.sk/geoserver/el/ows?service=WCS&acceptversions=2.0.1&request=GetCapabilities"
    xml = fetch(url)
    root = ET.fromstring(xml)
    identifiers = []
    for element in root.iter():
        if element.tag.endswith("CoverageId") or element.tag.endswith("Identifier"):
            if element.text and element.text.strip() not in identifiers:
                identifiers.append(element.text.strip())
    return identifiers[:50]


def main():
    points = make_points()
    report = {
        "selection": {"latitude": CENTER_LAT, "longitude": CENTER_LON, "sizeMetres": SIZE_M},
        "points": [{"lat": p[0], "lon": p[1], "east": p[2], "north": p[3]} for p in points],
    }

    mapzen = [terrarium_height(p[1], p[0]) for p in points]
    report["mapzenTerrariumDirect"] = {"values": mapzen, "stats": stats(mapzen)}

    try:
        meteo = open_meteo(points)
        report["openMeteoCopernicusGlo90"] = {"values": meteo, "stats": stats(meteo)}
        differences = [a - b for a, b in zip(mapzen, meteo)]
        report["mapzenMinusCopernicus"] = {"values": differences, "stats": stats(differences)}
    except Exception as error:
        report["openMeteoError"] = repr(error)

    try:
        topo = open_topodata(points)
        report["openTopoDataMapzen"] = {"values": topo, "stats": stats(topo)}
        differences = [a - b for a, b in zip(mapzen, topo)]
        report["mapzenDirectMinusApi"] = {"values": differences, "stats": stats(differences)}
    except Exception as error:
        report["openTopoDataError"] = repr(error)

    try:
        report["slovakWcsCoverageIdentifiers"] = inspect_wcs()
    except Exception as error:
        report["slovakWcsError"] = repr(error)

    with open("elevation-verification.json", "w", encoding="utf-8") as output:
        json.dump(report, output, indent=2)

    print(json.dumps({
        "mapzen": report["mapzenTerrariumDirect"]["stats"],
        "copernicus": report.get("openMeteoCopernicusGlo90", {}).get("stats"),
        "mapzenApi": report.get("openTopoDataMapzen", {}).get("stats"),
        "wcs": report.get("slovakWcsCoverageIdentifiers", report.get("slovakWcsError")),
    }, indent=2))


if __name__ == "__main__":
    main()
