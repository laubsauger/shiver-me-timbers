"""
The Drift's Earth maps (src/drift/getTheDrift/earth.ts), built from public-domain satellite data.

  NASA Blue Marble Next Generation, July 2004 (surface colour, no clouds, no relief shading)
  NASA Black Marble 2016, grey (VIIRS night lights)
  NASA cloud_combined_8192 (global cloud composite)
  NASA Worldview / GIBS VIIRS NOAA-20 corrected reflectance, 2023-09-08 (a real day's clouds over Europe: an Atlantic
  cyclone and its fronts, central Europe clear)
  Mapzen / AWS Terrain Tiles, terrarium encoding (SRTM, ETOPO1 bathymetry, ... — see their attribution)

Two levels, both equirectangular (lon, lat):

  global   the whole planet, for the approach (8192 x 4096 colour, lights, clouds; 4096 x 2048 elevation)
  region   lon -25..45, lat 18..68 at 1/100 deg (~1 km): Europe, the Mediterranean, North Africa — every
           view from the arrival over the Mediterranean to the flood over the North German plain

Raw downloads live in out/drift/data/raw (see docs/drift/earth-data.md for the URLs). Run with a venv that
has numpy, pillow, tifffile and imagecodecs:

  out/drift/data/.venv/bin/python -I scripts/drift-earth-data.py out/drift/data/raw public/drift/earth
"""

import math
import sys
from pathlib import Path

import numpy as np
import tifffile
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

RAW = Path(sys.argv[1])
OUT = Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)

LON0, LON1, LAT0, LAT1 = -25.0, 45.0, 18.0, 68.0
STEP = 0.01
RW, RH = round((LON1 - LON0) / STEP), round((LAT1 - LAT0) / STEP)
GW, GH = 8192, 4096


def tile_crop(tiles: dict, res: float, lon0: float, lon1: float, lat0: float, lat1: float, read) -> np.ndarray:
    """mosaic of 90-degree NASA tiles (A1..D2 at `res` deg/px), cropped to the box"""
    parts = []
    for name, (tlon, tlat) in tiles.items():
        a, b = max(lon0, tlon), min(lon1, tlon + 90)
        if a >= b:
            continue
        img = read(name)
        r0, r1 = round((tlat - lat1) / res), round((tlat - lat0) / res)
        c0, c1 = round((a - tlon) / res), round((b - tlon) / res)
        parts.append(np.ascontiguousarray(img[r0:r1, c0:c1]))
        del img
    return np.concatenate(parts, axis=1)


def resize(a: np.ndarray, w: int, h: int, box: bool = False) -> np.ndarray:
    mode = 'RGB' if a.ndim == 3 else 'L'
    return np.asarray(Image.fromarray(a, mode).resize((w, h), Image.BOX if box else Image.LANCZOS))


# ------------------------------------------------------------------ elevation (terrarium tiles, Web Mercator)
def terrarium_mosaic(z: int, xs: range, ys: range) -> np.ndarray:
    m = np.zeros((len(ys) * 256, len(xs) * 256), np.float32)
    for i, x in enumerate(xs):
        for j, y in enumerate(ys):
            t = np.asarray(Image.open(RAW / 'terrarium' / f'{z}_{x}_{y}.png').convert('RGB')).astype(np.float32)
            m[j * 256:(j + 1) * 256, i * 256:(i + 1) * 256] = t[..., 0] * 256 + t[..., 1] + t[..., 2] / 256 - 32768
    return m


def merc_xy(lon: np.ndarray, lat: np.ndarray, z: int):
    n = 2 ** z * 256
    lat = np.clip(lat, -85.0511, 85.0511)
    r = np.radians(lat)
    return (lon + 180) / 360 * n, (1 - np.log(np.tan(r) + 1 / np.cos(r)) / math.pi) / 2 * n


def bilinear(m: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    x = np.clip(x - 0.5, 0, m.shape[1] - 1.001)
    y = np.clip(y - 0.5, 0, m.shape[0] - 1.001)
    x0, y0 = np.floor(x).astype(np.int32), np.floor(y).astype(np.int32)
    fx, fy = x - x0, y - y0
    a = m[y0, x0] * (1 - fx) + m[y0, x0 + 1] * fx
    b = m[y0 + 1, x0] * (1 - fx) + m[y0 + 1, x0 + 1] * fx
    return a * (1 - fy) + b * fy


def elevation(z: int, lon0: float, lon1: float, lat0: float, lat1: float, w: int, h: int) -> np.ndarray:
    n = 2 ** z
    tx = lambda lon: int((lon + 180) / 360 * n)
    ty = lambda lat: int(merc_xy(np.array(0.0), np.array(lat), z)[1] // 256)
    xs = range(max(0, tx(lon0)), min(n - 1, tx(lon1 - 1e-9)) + 1)
    ys = range(max(0, ty(lat1)), min(n - 1, ty(lat0)) + 1)
    m = terrarium_mosaic(z, xs, ys)
    lon = lon0 + (np.arange(w) + 0.5) * (lon1 - lon0) / w
    out = np.zeros((h, w), np.float16)
    for j in range(h):
        lat = lat1 - (j + 0.5) * (lat1 - lat0) / h
        x, y = merc_xy(lon, np.full(w, lat), z)
        out[j] = bilinear(m, x - xs.start * 256, y - ys.start * 256)
    return out


def water_mask(rgb: np.ndarray) -> np.ndarray:
    """Blue Marble's open water (sea and lakes) is a flat near-black navy: dark, and bluer than it is red"""
    r, g, b = (rgb[..., i].astype(np.int16) for i in range(3))
    return (r < 14) & (g < 40) & (b > r + 4) & (b < 70)


def land_sea(elev: np.ndarray, water: np.ndarray) -> np.ndarray:
    """the elevation agreeing with the colour's coastline: land is above the sea (polders at +0.5 m: the
    flood takes them first), open water is the colour's (an inland lake keeps its surface elevation)"""
    out = elev.astype(np.float32)
    out[~water] = np.maximum(out[~water], 0.5)
    return np.clip(out, -11000, 8900).astype('<f2')


def pack(lights: np.ndarray, clouds: np.ndarray, water: np.ndarray, path: Path) -> None:
    """R night lights (Black Marble grey), G cloud cover (sqrt), B open water"""
    rgb = np.stack([lights, clouds, water.astype(np.uint8) * 255], -1).astype(np.uint8)
    Image.fromarray(rgb, 'RGB').save(path, optimize=True)
    print(path, rgb.shape)


# ------------------------------------------------------------------ region
BM_TILES = {'B1': (-90, 90), 'C1': (0, 90)}


def read_bm(name: str) -> np.ndarray:
    img = Image.open(RAW / f'world.200407.3x21600x21600.{name}.jpg')
    img.draft('RGB', (10800, 10800))  # decode at half size: 1/120 deg
    return np.asarray(img.convert('RGB'))


albedo = tile_crop(BM_TILES, 1 / 120, LON0, LON1, LAT0, LAT1, read_bm)
albedo = resize(albedo, RW, RH)
Image.fromarray(albedo, 'RGB').save(OUT / 'region-albedo.jpg', quality=92)
print(OUT / 'region-albedo.jpg', albedo.shape)
water = water_mask(albedo)

lights = tile_crop(BM_TILES, 1 / 240, LON0, LON1, LAT0, LAT1, lambda name: tifffile.imread(RAW / f'BlackMarble_2016_{name}_geo_gray.tif')[..., 0])
lights = resize(lights, RW, RH, box=True)

# clouds: the VIIRS day against the cloud-free Blue Marble — what is brighter AND whiter than the ground
viirs = np.asarray(Image.open(RAW / 'wv' / 'viirs_2023-09-08_7000.jpg').convert('RGB')).astype(np.float32) / 255
ground = albedo.astype(np.float32) / 255
lin = lambda c: np.power(c, 2.2)
lum = lambda c: c[..., 0] * 0.2126 + c[..., 1] * 0.7152 + c[..., 2] * 0.0722
o, g = lin(viirs), lin(ground)
sat = (o.max(-1) - o.min(-1)) / np.maximum(o.max(-1), 1e-3)
alpha = np.clip((lum(o) - lum(g) - 0.015) / np.maximum(0.9 - lum(g), 0.05), 0, 1) * np.clip(1 - (sat - 0.12) / 0.25, 0, 1)
# no data (swath gaps) comes as black: leave it clear
alpha *= viirs.max(-1) > 0.02
pack(lights, np.sqrt(alpha) * 255, water, OUT / 'region-lcw.png')
del viirs, ground, o, g, sat, alpha, albedo, lights

# raw little-endian float16 metres, rows north to south (the shader's r16float texture)
land_sea(elevation(7, LON0, LON1, LAT0, LAT1, RW, RH), water).tofile(OUT / 'region-elevation.f16')
print(OUT / 'region-elevation.f16')

# ------------------------------------------------------------------ global
img = Image.open(RAW / 'world.200407.3x21600x10800.jpg')
img.draft('RGB', (10800, 5400))
albedo = np.asarray(img.convert('RGB').resize((GW, GH), Image.LANCZOS))
Image.fromarray(albedo, 'RGB').save(OUT / 'global-albedo.jpg', quality=92)
print(OUT / 'global-albedo.jpg')
water = water_mask(albedo)
lights = resize(tifffile.imread(RAW / 'BlackMarble_2016_3km_gray_geo.tif')[..., 0], GW, GH, box=True)
clouds = resize(tifffile.imread(RAW / 'cloud_combined_8192.tif')[..., 0], GW, GH)
pack(lights, clouds, water, OUT / 'global-lcw.png')
small = np.asarray(Image.fromarray(water.astype(np.uint8) * 255, 'L').resize((GW // 2, GH // 2), Image.BOX)) > 127
land_sea(elevation(4, -180, 180, -90, 90, GW // 2, GH // 2), small).tofile(OUT / 'global-elevation.f16')
print(OUT / 'global-elevation.f16')
