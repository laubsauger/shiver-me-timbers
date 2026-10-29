"""
The raft's close-range scanned surfaces (src/ship/raftLook.ts — the game's raft and the film's): Poly Haven CC0
scans fetched by scripts/drift-pbr-fetch.py into public/drift/pbr/<scan>/ (gitignored), packed as the game's raft
scans are (scripts/raft-scan-pack.py) into TWO RGBA maps each, into public/textures/raft/ (they ship, CC0):

  raft_<scan>_albedo_rough.webp   RGB colour (sRGB, as scanned), A roughness
  raft_<scan>_normal_ao_h.webp    RG the OpenGL normal's x, y, B ambient occlusion, A height

— but the relief at the colour's own 1024² (the game's is 512²: the film's raft is seen from 5 m, and its relief is
MARCHED, parallax occlusion: a texel of height is a step the eye sees past), and the height STRETCHED to the full
0..1 (each scan's displacement uses a different slice of the range; raftLook.ts gives each its depth in metres).
Prints each scan's mean colour (linear) and roughness, which raftLook.ts's SCANS carries.

  out/drift/data/.venv/bin/python -I scripts/drift-raft-pack.py public/drift/pbr public/textures/raft
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image

SRC = Path(sys.argv[1])
OUT = Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)
SIZE = 1024
SCANS = ['bamboo_wall_03', 'thatch_roof_angled', 'weathered_planks', 'bamboo_wall']


def load(path: Path, mode: str) -> np.ndarray:
    return np.asarray(Image.open(path).convert(mode).resize((SIZE, SIZE), Image.LANCZOS))


def srgb_to_linear(c: np.ndarray) -> np.ndarray:
    c = c / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


for scan in SCANS:
    d = SRC / scan
    colour = load(d / f'{scan}_diff_2k.jpg', 'RGB')
    arm = load(d / f'{scan}_arm_2k.jpg', 'RGB')  # R ambient occlusion, G roughness, B metal
    normal = load(d / f'{scan}_nor_gl_2k.jpg', 'RGB')
    h = np.asarray(Image.open(d / f'{scan}_disp_2k.jpg').convert('F').resize((SIZE, SIZE), Image.LANCZOS))
    lo, hi = np.percentile(h, 0.2), np.percentile(h, 99.8)
    height = np.clip((h - lo) / max(1e-6, hi - lo) * 255, 0, 255).astype(np.uint8)
    a = np.dstack([colour, arm[..., 1]]).astype(np.uint8)
    b = np.dstack([normal[..., 0], normal[..., 1], arm[..., 0], height]).astype(np.uint8)
    Image.fromarray(a, 'RGBA').save(OUT / f'raft_{scan}_albedo_rough.webp', quality=92, alpha_quality=100, method=6)
    Image.fromarray(b, 'RGBA').save(OUT / f'raft_{scan}_normal_ao_h.webp', lossless=True, method=6)
    lin = srgb_to_linear(colour.astype(np.float64)).reshape(-1, 3).mean(0)
    print(scan, 'mean', [round(float(x), 4) for x in lin], 'rough', round(float(arm[..., 1].mean() / 255), 3), 'height', round(float(height.mean() / 255), 3), flush=True)
