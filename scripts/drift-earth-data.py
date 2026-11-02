"""
The Drift's Earth maps (src/drift/getTheDrift/earth.ts), built from public-domain and CC BY satellite data.

  NASA Blue Marble Next Generation, July 2004 (surface colour, no clouds, no relief shading)
  NASA Black Marble 2016, grey (VIIRS night lights)
  NASA cloud_combined_8192 (global cloud composite)
  NASA Worldview / GIBS VIIRS NOAA-20 corrected reflectance, 2023-09-08 (a real day's clouds over Europe: an Atlantic
  cyclone and its fronts, central Europe clear)
  Mapzen / AWS Terrain Tiles, terrarium encoding (SRTM, ETOPO1 bathymetry, EU-DEM, ... — see their attribution)
  Sentinel-2 cloudless 2016 by EOX IT Services GmbH (CC BY 4.0; contains modified Copernicus Sentinel data 2016)

Four nested levels, all equirectangular (lon, lat), each finer one fading into the one under it near its edges
(earthMaps.ts):

  global   the whole planet, for the approach (8192 x 4096 colour, lights, clouds; 4096 x 2048 elevation)
  region   lon -25..45, lat 18..68 at 1/100 deg (~1 km): Europe, the Mediterranean, North Africa — every
           view from the arrival over the Mediterranean to the flood over the North German plain
  near     lon -12..20, lat 36..54 at 1/240 deg (~460 m): the Blue Marble's and Black Marble's own grid, uncut,
           and the terrain tiles at zoom 9 — where the lights beat, the flood and Drift-2 look closer than the
           region's kilometre (measured 2026-10-30: a 4096 master's pixel falls under 1.1 km on the ground there)
  inset    lon 6..15.984, lat 43.5..47 at ~79 m (1/1000 deg of longitude, 1/1400 of latitude: square on the ground
           at 45 deg N): the western Alps to the Julian Alps and the Karawanks, the Po plain, the northern Apennines,
           Istria — under the end of Drift-2 and the landing, where a 4096 master's pixel comes down to 30–60 m (and
           the left views at ~282 s look east past lon 14). Stored as two overlapping layers of 5120 columns (a
           texture array: 9984 columns are over the 8192 a texture may be on every render box). Sentinel-2 cloudless colour (2016, the
           CC BY edition) matched to the Blue Marble below its own 460 m (so it fades into the near level with no
           seam: only the finer detail is Sentinel's), its own water line, the terrain tiles at zoom 11 (EU-DEM)

Raw downloads live in out/drift/data/raw (see docs/drift/earth-data.md for the URLs). Run with a venv that
has numpy, pillow, tifffile and imagecodecs:

  out/drift/data/.venv/bin/python -I scripts/drift-earth-data.py out/drift/data/raw public/drift/earth [levels]

`levels` is a comma list of region,global,near,inset (default all of them): what to (re)build.
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
LEVELS = (sys.argv[3] if len(sys.argv) > 3 else 'region,global,near,inset').split(',')

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


def elevation(z: int, lon0: float, lon1: float, lat0: float, lat1: float, w: int, h: int, ss: int = 1) -> np.ndarray:
    """the terrain tiles of zoom z resampled to the (w, h) grid over the box; `ss` > 1 averages ss x ss bilinear
    samples a texel (the near and inset levels' tiles are 1.5–2x finer than their grid: one sample would alias)"""
    n = 2 ** z
    tx = lambda lon: int((lon + 180) / 360 * n)
    ty = lambda lat: int(merc_xy(np.array(0.0), np.array(lat), z)[1] // 256)
    xs = range(max(0, tx(lon0)), min(n - 1, tx(lon1 - 1e-9)) + 1)
    ys = range(max(0, ty(lat1)), min(n - 1, ty(lat0)) + 1)
    m = terrarium_mosaic(z, xs, ys)
    if ss == 1:
        lon = lon0 + (np.arange(w) + 0.5) * (lon1 - lon0) / w
        out = np.zeros((h, w), np.float16)
        for j in range(h):
            lat = lat1 - (j + 0.5) * (lat1 - lat0) / h
            x, y = merc_xy(lon, np.full(w, lat), z)
            out[j] = bilinear(m, x - xs.start * 256, y - ys.start * 256)
        return out
    lon = lon0 + (np.arange(w * ss) + 0.5) * (lon1 - lon0) / (w * ss)
    out = np.zeros((h, w), np.float32)
    for j in range(h):
        acc = np.zeros(w, np.float32)
        for k in range(ss):
            lat = lat1 - (j * ss + k + 0.5) * (lat1 - lat0) / (h * ss)
            x, y = merc_xy(lon, np.full(w * ss, lat), z)
            acc += bilinear(m, x - xs.start * 256, y - ys.start * 256).reshape(w, ss).mean(1)
        out[j] = acc / ss
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


def region() -> None:
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
def global_() -> None:
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


# ------------------------------------------------------------------ near
# (the 2026-10-30 question: "at the zoom level we end up in they look kind of low resolution … can we upscale them?"
# Measured first: from the lights beat on, a 4096 master's pixel covers less than the region's 1.1 km of ground over
# lon -13.5..19.5, lat 32..57, less than 460 m over lon -6.5..19, lat 39.5..50.5. Real data before invented detail:
# the Blue Marble and the Black Marble are both 15 arc-seconds (1/240 deg) in their 90-degree tiles, and the region
# throws half of that away. Here they are uncut, on their own pixel grid, over the box where a 4096 master can use
# them: 7680 x 4320, under the 8192 a texture can safely be on every render box)
NEAR = (-12.0, 20.0, 36.0, 54.0)
NEAR_STEP = 1 / 240


def read_bm_full(name: str) -> np.ndarray:
    return np.asarray(Image.open(RAW / f'world.200407.3x21600x21600.{name}.jpg').convert('RGB'))


def read_lights(name: str) -> np.ndarray:
    return tifffile.imread(RAW / f'BlackMarble_2016_{name}_geo_gray.tif')[..., 0]


def near() -> None:
    lon0, lon1, lat0, lat1 = NEAR
    w, h = round((lon1 - lon0) / NEAR_STEP), round((lat1 - lat0) / NEAR_STEP)
    albedo = tile_crop(BM_TILES, NEAR_STEP, lon0, lon1, lat0, lat1, read_bm_full)
    assert albedo.shape[:2] == (h, w), albedo.shape
    Image.fromarray(albedo, 'RGB').save(OUT / 'near-albedo.jpg', quality=92)
    print(OUT / 'near-albedo.jpg', albedo.shape)
    # zoom 9: ~215 m at 45 deg N, averaged 2 x 2 into the ~330 x 460 m texels
    elev = elevation(9, lon0, lon1, lat0, lat1, w, h, ss=2)
    # the water: the colour's, and the sea floor's where the colour misses it — the Blue Marble's turbid shallows (the
    # northern Adriatic off the Po and in the Gulf of Trieste, river plumes) are too green and bright for its water
    # test; 10 m down is sea for certain (no polder lies that deep)
    water = water_mask(albedo) | (elev < -10)
    del albedo
    lights = tile_crop(BM_TILES, NEAR_STEP, lon0, lon1, lat0, lat1, read_lights)
    # (no clouds at this level: the cloud field is the region's VIIRS day, ~1 km, and earth.ts reads it from there)
    pack(lights, np.zeros_like(lights), water, OUT / 'near-lcw.png')
    del lights
    land_sea(elev, water).tofile(OUT / 'near-elevation.f16')
    print(OUT / 'near-elevation.f16', (h, w))



# ------------------------------------------------------------------ inset
# Under the end of Drift-2 and the landing a 4096 master's pixel comes down to 30–120 m on the ground (lon 4.5..14,
# lat 43.5..46.5 under 120 m; the measurements in docs/drift/earth-data.md). No public night-lights or Blue Marble
# data is finer than 460 m; the real colour that is, under an open licence, is Sentinel-2: EOX's cloudless mosaic of
# 2016 (the CC BY 4.0 edition: the later years are non-commercial), 10 m, served as a WGS84 tile pyramid. Level 11 of
# it (~38 m) is averaged down to ~79 m here: 9984 x 4900, square on the ground at 45 deg N.
INSET = (6.0, 15.984, 43.5, 47.0)
INSET_W, INSET_H = 9984, 4900
# (2026-11-02: widened east from lon 14 — the left views at 282 s, yaw ~55 deg, looked past its old edge onto the
# Julian Alps and the Karawanks, which had only the near level's 460 m and read soft. 9984 columns are over the 8192 a
# texture can be on every render box, so the inset is stored as a two-layer texture array (no extra texture binding in
# the earth material, ~100 MB more than the old 8000 columns): layer 0 columns 0..5120 (lon 6..11.12), layer 1
# columns 4864..9984 (lon 10.864..15.984). They overlap by 256 columns and the shader switches at column 4992 (lon
# 10.992), 128 columns from either layer's edge; both are cut from this one bake on one texel grid, with offsets and
# widths that are multiples of 256, so their mips agree through mip 8 and the switch shows no seam)
INSET_LAYERS, INSET_LAYER_W = (0, 4864), 5120
# the bake runs to lon 16 (the Blue Marble's 15'' grid ends there on a whole texel, 2400 of them) and drops the last
# 16 columns
INSET_BAKE_LON1, INSET_BAKE_W = 16.0, 10000
S2_LEVEL = 11
# the Sentinel scenes' own Sun (the mosaic is built from summer 2016 passes at ~10:30 local solar time): a first guess
# that the fit below refines against the terrain
S2_SUN_AZ = (100, 115, 130, 145, 160, 175, 190)
S2_SUN_EL = (35, 45, 55, 65)


def to_lin(a: np.ndarray) -> np.ndarray:
    a = a.astype(np.float32) / 255
    return np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4).astype(np.float32)


def to_srgb(a: np.ndarray) -> np.ndarray:
    a = np.clip(a, 0, 1)
    return np.round(255 * np.where(a <= 0.0031308, a * 12.92, 1.055 * a ** (1 / 2.4) - 0.055)).astype(np.uint8)


def fresize(a: np.ndarray, w: int, h: int, method=Image.BILINEAR) -> np.ndarray:
    """a float32 (h', w') or (h', w', c) array resized per channel"""
    if a.ndim == 3:
        return np.stack([fresize(a[..., c], w, h, method) for c in range(a.shape[2])], -1)
    return np.asarray(Image.fromarray(a.astype(np.float32), 'F').resize((w, h), method))


def blur(a: np.ndarray, sigma: float) -> np.ndarray:
    """separable gaussian (edges clamped), over the first two axes"""
    r = max(1, int(3 * sigma + 0.5))
    k = np.exp(-np.arange(-r, r + 1) ** 2 / (2 * sigma * sigma))
    k /= k.sum()
    pad = [(r, r), (0, 0)] + [(0, 0)] * (a.ndim - 2)
    p = np.pad(a, pad, mode='edge')
    a = sum(k[i] * p[i:i + a.shape[0]] for i in range(2 * r + 1))
    pad = [(0, 0), (r, r)] + [(0, 0)] * (a.ndim - 2)
    p = np.pad(a, pad, mode='edge')
    return sum(k[i] * p[:, i:i + a.shape[1]] for i in range(2 * r + 1)).astype(np.float32)


def grow(m: np.ndarray, n: int) -> np.ndarray:
    """binary dilation by n texels (a square)"""
    for _ in range(n):
        p = np.pad(m, 1, mode='edge')
        m = p[1:-1, 1:-1] | p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:]
    return m


def s2_mosaic(lon0: float, lon1: float, lat0: float, lat1: float, w: int, h: int) -> np.ndarray:
    """the Sentinel-2 cloudless tiles over the box, averaged (Lanczos) to the (w, h) grid; sRGB uint8"""
    td = 180 / 2 ** S2_LEVEL
    rows = range(int((90 - lat1) / td), int((90 - lat0) / td) + 1)
    cols = range(int((lon0 + 180) / td), int((lon1 + 180) / td) + 1)
    m = np.zeros((len(rows) * 256, len(cols) * 256, 3), np.uint8)
    for i, r in enumerate(rows):
        for j, c in enumerate(cols):
            # (open sea comes as a one-colour palette PNG, land as JPEG: both read as RGB)
            m[i * 256:(i + 1) * 256, j * 256:(j + 1) * 256] = np.asarray(Image.open(RAW / 's2cloudless' / f'{S2_LEVEL}_{r}_{c}.img').convert('RGB'))
    px = td / 256
    box = ((lon0 + 180) / px - cols.start * 256, (90 - lat1) / px - rows.start * 256, (lon1 + 180) / px - cols.start * 256, (90 - lat0) / px - rows.start * 256)
    return np.asarray(Image.fromarray(m, 'RGB').resize((w, h), Image.LANCZOS, box=box))


def hillshade(e: np.ndarray, lat0: float, lat1: float, dlon: float, dlat: float, az: float, el: float) -> np.ndarray:
    """cos of the Sun's incidence on the terrain e (m; rows north to south) for a Sun at azimuth az (deg from north,
    clockwise) and elevation el (deg)"""
    lat = np.linspace(lat1, lat0, e.shape[0])[:, None]
    dx = dlon * 111320 * np.cos(np.radians(lat))
    dy = dlat * 110574
    gx = np.gradient(e, axis=1) / dx            # dz / d east
    gy = -np.gradient(e, axis=0) / dy           # dz / d north (rows run south)
    a, b = np.radians(az), np.radians(el)
    s = np.array([np.sin(a) * np.cos(b), np.cos(a) * np.cos(b), np.sin(b)], np.float32)
    return ((-gx * s[0] - gy * s[1] + s[2]) / np.sqrt(gx * gx + gy * gy + 1)).astype(np.float32)


def layers(a: np.ndarray) -> np.ndarray:
    """the bake's (h, 10000, ...) grid cut to the two layers, stacked: layer 0 above layer 1 (the texture
    array's own order: each layer's rows north to south)"""
    return np.ascontiguousarray(np.concatenate([a[:, c:c + INSET_LAYER_W] for c in INSET_LAYERS], 0))


def inset() -> None:
    lon0, _, lat0, lat1 = INSET
    lon1, w, h = INSET_BAKE_LON1, INSET_BAKE_W, INSET_H
    assert INSET_LAYERS[-1] + INSET_LAYER_W == INSET_W <= w
    dlon, dlat = (lon1 - lon0) / w, (lat1 - lat0) / h
    # the Blue Marble on its own grid over the box (what the near level draws there) and its water
    bw, bh = round((lon1 - lon0) * 240), round((lat1 - lat0) * 240)
    bm = tile_crop(BM_TILES, NEAR_STEP, lon0, lon1, lat0, lat1, read_bm_full)
    assert bm.shape[:2] == (bh, bw), bm.shape
    bm_water = water_mask(bm)
    bml = to_lin(bm)
    del bm
    s2 = s2_mosaic(lon0, lon1, lat0, lat1, w, h)
    print('inset: sentinel-2 mosaic', s2.shape)

    # ELEVATION: the terrain tiles at zoom 11 (EU-DEM there, ~54 m at 45 deg N), 2 x 2 samples a texel. (Three texels
    # in the Ortler–Bernina void fill come out at ~5200 m: clipped to Mont Blanc's 4810)
    elev = np.minimum(elevation(11, lon0, lon1, lat0, lat1, w, h, ss=2), 4810)
    # and zoom 9 for the sea floor, on the Blue Marble's grid: at zoom 11 the sea and the lagoons are EU-DEM's water,
    # exactly 0 m
    floor_bm = elevation(9, lon0, lon1, lat0, lat1, bw, bh, ss=2)
    floor = fresize(floor_bm, w, h)
    print('inset: elevation', elev.shape, float(elev.min()), float(elev.max()))

    # WATER, from the measured terrain rather than the colour (the Blue Marble's line is 460 m and misses the turbid
    # Adriatic; Sentinel's water ranges from navy to the lagoon's grey-green, which no colour test tells from wet
    # fields): EU-DEM leaves the sea and the lagoons at exactly 0 m (land at sea level is never exactly 0: the tiles
    # carry 1/256 m), and its lakes as flat surfaces (Garda at 61.0 m) — those taken where they are also dark, within
    # a few texels of the Blue Marble's water. Lone texels at 0 m inland (a few flat fields) are dropped: only water
    # within ~8 km of the Blue Marble's or the sea floor's is kept
    up = lambda m: np.asarray(Image.fromarray(m.astype(np.uint8) * 255, 'L').resize((w, h), Image.NEAREST)) > 127
    coarse_bm = bm_water | (floor_bm < -10)
    coarse = up(coarse_bm)
    sea = ((np.abs(elev) < 0.05) & up(grow(coarse_bm, 18))) | (coarse & (elev <= 0.05))
    p = np.pad(elev, 1, mode='edge')
    nb = np.stack([p[1:-1, 1:-1], p[:-2, 1:-1], p[2:, 1:-1], p[1:-1, :-2], p[1:-1, 2:]])
    flat = nb.max(0) - nb.min(0) < 0.02
    r, g, b = (s2[..., i].astype(np.int16) for i in range(3))
    lake = flat & ((r * 2 + g * 7 + b) / 10 < 70) & up(grow(bm_water, 3)) & (elev > 0.05)
    water = sea | lake | up(~grow(~coarse_bm, 1))
    # two texels of open-close: no lone speckles, no pinholes
    water = ~grow(~grow(water, 2), 2)
    water = grow(~grow(~water, 2), 2)
    print('inset: water', f'{water.mean():.3f} (blue marble {bm_water.mean():.3f}; sea {sea.mean():.3f}, lakes {lake.mean():.4f})')
    # the sea floor under the water (the shader's shallow shelves), the lakes at their surface
    elev = np.where(water & (np.abs(elev) < 0.05), np.minimum(floor, 0), elev).astype(np.float32)
    del r, g, b, nb, p, flat, sea, lake, coarse, floor, floor_bm, coarse_bm

    # THE SCENES' OWN SHADING. Sentinel's ground is sunlit from the south-east at mid-morning: every slope in the Alps
    # carries its light and shadow, and the film lights it again from the elevation (earth.ts) with its own Sun. The
    # Blue Marble is a composite of many passes and much coarser: no such shading at its scale. So the scenes' shading
    # is taken out: the hillshade of the measured terrain under the scenes' Sun, its azimuth and elevation fitted to
    # Sentinel's own relative brightness on land, divided out by the fitted strength
    sl = to_lin(s2)
    lum = sl[..., 0] * 0.2126 + sl[..., 1] * 0.7152 + sl[..., 2] * 0.0722
    low = lambda a: fresize(blur(fresize(a, bw, bh, Image.BOX), 1.0), w, h)
    land = ~grow(water, 3) & (lum > 0.004) & (lum < 0.25) & (elev > 1)  # (no water, no snow)
    pick = land[::4, ::4]
    rs = np.log(np.maximum(lum, 1e-4) / np.maximum(low(lum), 1e-4))[::4, ::4][pick]
    best = (0.0, None)
    for az in S2_SUN_AZ:
        for el in S2_SUN_EL:
            hs = np.maximum(hillshade(elev, lat0, lat1, dlon, dlat, az, el), 0.05)
            rh = np.log(hs / np.maximum(low(hs), 1e-3))[::4, ::4][pick]
            c = float(np.corrcoef(rs, rh)[0, 1])
            if c > best[0]:
                k = float((rs * rh).sum() / (rh * rh).sum())
                best = (c, (az, el, k, hs))
    c, fit = best
    if fit is not None and c > 0.3:
        az, el, k, hs = fit
        shade = np.log(hs / np.maximum(low(hs), 1e-3))
        rh = shade[::4, ::4][pick]
        # each channel's own strength: a slope turned from the Sun is lit by the blue sky instead, so its blue darkens
        # less than its red (divided out with one strength, shaded snow came out as blue patches)
        ks = []
        for ch in range(3):
            rc = np.log(np.maximum(sl[..., ch], 1e-4) / np.maximum(low(sl[..., ch]), 1e-4))[::4, ::4][pick]
            ks.append(min(float((rc * rh).sum() / (rh * rh).sum()), 1.0))
        print(f'inset: the scenes\' Sun fitted at azimuth {az}, elevation {el}: correlation {c:.2f}, strength r g b {ks[0]:.2f} {ks[1]:.2f} {ks[2]:.2f}: divided out')
        # (at most 2x brighter: the deepest shadows are noisy, and lifting them further turned them into specks)
        for ch in range(3):
            sl[..., ch] /= np.maximum(np.exp(shade * ks[ch]), 0.5)
        del hs, shade
    else:
        print(f'inset: no clear scene shading (correlation {c:.2f}): left as it is')
    del lum, fit, best

    # COLOUR: Sentinel's ground is bluer than the Blue Marble's (its blue twice as bright on vegetation), and its year
    # and season differ: 2016's summer composite has far less snow on the Alps than July 2004. Tried first: Sentinel
    # scaled channel by channel by the ratio of the two at the Blue Marble's 460 m, so that above it the inset IS the
    # Blue Marble — it painted 2004's snow over 2016's bare rock (rock texture whitened 3-4x, its meadows bright
    # yellow-green in a halo round every snowfield). The two years' snow does not correspond, so no per-place ratio
    # can carry one into the other. Instead, two corrections that move colour, not content:
    #   1. each channel's distribution over the land matched to the Blue Marble's (one curve for the whole inset:
    #      Sentinel's vegetation takes the Blue Marble's colours, its snow stays white: the brightest of each
    #      channel maps to the brightest);
    #   2. what regional cast is left (the plain's fields in another month) evened out over ~7 km, snow left out of
    #      both sides, by at most 1.5x either way.
    # What still differs is real (2016's snow line, fields and towns): it fades into the near level over the inset's
    # last 0.35 deg (earthMaps.ts)
    wb = np.asarray(Image.fromarray(water.astype(np.uint8) * 255, 'L').resize((bw, bh), Image.BOX)) > 0
    keep = ~grow(bm_water | wb, 1)
    s2b = fresize(sl, bw, bh, Image.BOX)
    q = np.linspace(0, 100, 1025)
    for c in range(3):
        src = np.percentile(s2b[..., c][keep], q)
        dst = np.percentile(bml[..., c][keep], q)
        src = np.maximum.accumulate(src + np.arange(len(src)) * 1e-9)  # (strictly increasing for interp)
        sl[..., c] = np.interp(sl[..., c], src, dst, right=None).astype(np.float32)
        s2b[..., c] = np.interp(s2b[..., c], src, dst).astype(np.float32)
    lum = lambda a: a[..., 0] * 0.2126 + a[..., 1] * 0.7152 + a[..., 2] * 0.0722
    m = (keep & (lum(bml) < 0.3) & (lum(s2b) < 0.3)).astype(np.float32)
    def ratio(sigma: float, most: float) -> np.ndarray:
        wgt = np.maximum(blur(m, sigma), 1e-6)[..., None]
        g = (blur(bml * m[..., None], sigma) / wgt) / np.maximum(blur(s2b * m[..., None], sigma) / wgt, 1e-4)
        return np.where(wgt > 0.05, np.clip(g, 1 / most, most), 1.0).astype(np.float32)
    #   3. and toward the box's edge, where earthMaps.ts fades it into the near level, held to the Blue Marble more
    #      closely (~2 km, by at most 2x) — so the two agree where they cross (measured over 0.25 deg cells along the
    #      edge: ±15% in red and green, -43..+36% in blue without it)
    yy, xx = np.mgrid[0:bh, 0:bw]
    edge = np.minimum(np.minimum(xx + 0.5, bw - xx - 0.5), np.minimum(yy + 0.5, bh - yy - 0.5)) / 240  # deg
    t = np.clip(1 - edge / 0.5, 0, 1)[..., None]
    gain = np.exp(np.log(ratio(16.0, 1.5)) * (1 - t) + np.log(ratio(4.0, 2.0)) * t).astype(np.float32)
    print('inset: regional gain r g b (p5, p50, p95)', np.round(np.percentile(gain.reshape(-1, 3), [5, 50, 95], 0), 3).tolist())
    sl *= fresize(gain, w, h)
    del s2b, gain, m, t, edge, yy, xx
    # what blue is left in the shade of the snowfields (where the lift is held at 2x): land is never bluer than it is
    # green or red but there (blue ice is pale), so a blue excess over the other two is cut to a third
    top = np.maximum(sl[..., 0], sl[..., 1])
    over = sl[..., 2] > top
    print('inset: blue-dominant land texels', f'{(over & ~water).mean():.4f}')
    sl[..., 2] = np.where(over, top + (sl[..., 2] - top) / 3, sl[..., 2])
    albedo = to_srgb(sl)
    del sl, top, over
    # (every map as its two layers stacked: 5120 x 9800)
    Image.fromarray(layers(albedo), 'RGB').save(OUT / 'inset-albedo.jpg', quality=92)
    print(OUT / 'inset-albedo.jpg', layers(albedo).shape)
    # the water as an 8-bit grey PNG (earth.ts reads it into a one-channel texture)
    Image.fromarray(layers(water.astype(np.uint8) * 255), 'L').save(OUT / 'inset-water.png', optimize=True)
    print(OUT / 'inset-water.png')
    layers(land_sea(elev, water)).tofile(OUT / 'inset-elevation.f16')
    print(OUT / 'inset-elevation.f16', (2 * h, INSET_LAYER_W))


if __name__ == '__main__':
    for level, build in (('region', region), ('global', global_), ('near', near), ('inset', inset)):
        if level in LEVELS:
            build()
