"""
The Drift's beach terrain layers (src/drift/wandering/beachMaterial.ts), packed from the downloaded CC0 scans
(scripts/drift-pbr-fetch.py) into TWO RGBA textures per layer, so five layers fit the 16 sampled textures a
WebGPU fragment stage may bind with room for the terrain's own:

  <layer>_albedo_rough.png   RGB colour (sRGB, as scanned), A roughness
  <layer>_normal_ao_h.png    RG the OpenGL normal's x, y (z is rebuilt), B ambient occlusion, A height

A RELIEF layer is the second map alone: `sand_relief` is the dry sand's shape (Poly Haven aerial_beach_02, a 20 m
scan of a smooth beach: low broad undulations, a few soft wind-ripple patches and pits), drawn under the colour of
sand_dry in place of that scan's own normals — Ground027's trampled lumps, median slope 21°, which under the w3–w5
Sun (1–6° up) covered the beach in lit crests and sky-lit pits (the 2026-10-29 reviews: "very gritty and regular").

  out/drift/data/.venv/bin/python -I scripts/drift-pbr-pack.py public/drift/pbr [layer ...]
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
ROOT = Path(sys.argv[1])
OUT = ROOT / 'packed'
OUT.mkdir(exist_ok=True)


def grey(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert('L'))


def rgb(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert('RGB'))


def acg(asset: str) -> dict:
    d = ROOT / asset
    p = f'{asset}_4K-JPG_'
    return {
        'colour': rgb(d / f'{p}Color.jpg'),
        'rough': grey(d / f'{p}Roughness.jpg'),
        'normal': rgb(d / f'{p}NormalGL.jpg'),
        'ao': grey(d / f'{p}AmbientOcclusion.jpg'),
        'height': grey(d / f'{p}Displacement.jpg'),
    }


def ph(asset: str) -> dict:
    d = ROOT / asset
    arm = rgb(d / f'{asset}_arm_4k.jpg')
    return {
        'colour': rgb(d / f'{asset}_diff_4k.jpg'),
        'rough': arm[..., 1],
        'normal': rgb(d / f'{asset}_nor_gl_4k.jpg'),
        'ao': arm[..., 0],
        'height': grey(d / f'{asset}_disp_4k.jpg'),
    }


LAYERS = {
    'sand_dry': lambda: acg('Ground027'),
    'sand_wet': lambda: acg('Ground061'),
    'rock': lambda: ph('rock_boulder_dry'),
    'forest_floor': lambda: ph('forest_floor'),
    'grass': lambda: ph('sparse_grass'),
}

def ph_relief(asset: str) -> dict:
    d = ROOT / asset
    return {
        'normal': rgb(d / f'{asset}_nor_gl_4k.jpg'),
        'ao': grey(d / f'{asset}_ao_4k.jpg'),
        'height': grey(d / f'{asset}_disp_4k.jpg'),
    }


RELIEF = {
    'sand_relief': lambda: ph_relief('aerial_beach_02'),
}

# (layer names after the root: pack only those)
ONLY = set(sys.argv[2:])
for name, load in RELIEF.items():
    if ONLY and name not in ONLY:
        continue
    m = load()
    h, w = m['normal'].shape[:2]
    fit = lambda a: a if a.shape[:2] == (h, w) else np.asarray(Image.fromarray(a).resize((w, h), Image.LANCZOS))
    b = np.dstack([m['normal'][..., 0], m['normal'][..., 1], fit(m['ao']), fit(m['height'])]).astype(np.uint8)
    Image.fromarray(b, 'RGBA').save(OUT / f'{name}_normal_ao_h.png', optimize=False, compress_level=6)
    print(name, f'{w}x{h}', 'relief only')

for name, load in LAYERS.items():
    if ONLY and name not in ONLY:
        continue
    m = load()
    h, w = m['colour'].shape[:2]
    fit = lambda a: a if a.shape[:2] == (h, w) else np.asarray(Image.fromarray(a).resize((w, h), Image.LANCZOS))
    a = np.dstack([m['colour'], fit(m['rough'])]).astype(np.uint8)
    b = np.dstack([fit(m['normal'])[..., 0], fit(m['normal'])[..., 1], fit(m['ao']), fit(m['height'])]).astype(np.uint8)
    Image.fromarray(a, 'RGBA').save(OUT / f'{name}_albedo_rough.png', optimize=False, compress_level=6)
    Image.fromarray(b, 'RGBA').save(OUT / f'{name}_normal_ao_h.png', optimize=False, compress_level=6)
    lum = (0.2126 * (m['colour'][..., 0] / 255) ** 2.2 + 0.7152 * (m['colour'][..., 1] / 255) ** 2.2 + 0.0722 * (m['colour'][..., 2] / 255) ** 2.2).mean()
    print(name, f'{w}x{h}', 'albedo Y', round(float(lum), 3), 'rough', round(float(m['rough'].mean() / 255), 2))
