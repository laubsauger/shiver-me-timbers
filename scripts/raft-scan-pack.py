"""
The raft's scanned surfaces (src/ship/raftScans.ts): Poly Haven CC0 scans, downloaded by scripts/drift-pbr-fetch.py
into public/drift/pbr/<scan>/ (gitignored), packed for the game into TWO RGBA textures each, the beach's layout
(scripts/drift-pbr-pack.py):

  public/textures/raft/<scan>_albedo_rough.webp   RGB colour (sRGB, as scanned), A roughness
  public/textures/raft/<scan>_normal_ao_h.webp    RG the OpenGL normal's x, y, B ambient occlusion, A height

The colour at 1024² (a scan tile is half a metre to 2.5 m: 0.5–2.4 mm a texel, finer than the raft is ever seen
close), lossy; the relief at 512², lossless (the height is differentiated for the relief: lossy blocks would
emboss). ~1 MB a scan. CC0, so they ship with the game.
Also writes src/ship/raftScanMeta.ts: each scan's mean colour (linear) and roughness, which the materials divide
out to put a scan on their own palette, and its size on the ground (m).

  out/drift/data/.venv/bin/python -I scripts/raft-scan-pack.py public/drift/pbr public/textures/raft src/ship/raftScanMeta.ts
"""

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

SRC = Path(sys.argv[1])
OUT = Path(sys.argv[2])
META = Path(sys.argv[3])
OUT.mkdir(parents=True, exist_ok=True)
SIZE = 1024
RELIEF = 512
# scan -> its tile on the ground, m (Poly Haven's own dimensions)
SCANS = {'rough_wood': 0.5, 'bamboo_wall': 2.0, 'reed_roof_04': 2.5}


def load(path: Path, mode: str, size: int = SIZE) -> np.ndarray:
    return np.asarray(Image.open(path).convert(mode).resize((size, size), Image.LANCZOS))


def srgb_to_linear(c: np.ndarray) -> np.ndarray:
    c = c / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


meta = {}
for scan, metres in SCANS.items():
    d = SRC / scan
    colour = load(d / f'{scan}_diff_2k.jpg', 'RGB')
    arm = load(d / f'{scan}_arm_2k.jpg', 'RGB')  # R ambient occlusion, G roughness, B metal
    normal = load(d / f'{scan}_nor_gl_2k.jpg', 'RGB', RELIEF)
    ao = load(d / f'{scan}_arm_2k.jpg', 'RGB', RELIEF)[..., 0]
    height = load(d / f'{scan}_disp_2k.jpg', 'L', RELIEF)
    a = np.dstack([colour, arm[..., 1]]).astype(np.uint8)
    b = np.dstack([normal[..., 0], normal[..., 1], ao, height]).astype(np.uint8)
    Image.fromarray(a, 'RGBA').save(OUT / f'{scan}_albedo_rough.webp', quality=92, alpha_quality=100, method=6)
    Image.fromarray(b, 'RGBA').save(OUT / f'{scan}_normal_ao_h.webp', lossless=True, method=6)
    lin = srgb_to_linear(colour.astype(np.float64)).reshape(-1, 3).mean(0)
    meta[scan] = {'metres': metres, 'mean': [round(float(x), 5) for x in lin], 'roughMean': round(float(arm[..., 1].mean() / 255), 4)}
    print(scan, 'mean linear', meta[scan]['mean'], 'rough', meta[scan]['roughMean'])
META.write_text(
    '// written by scripts/raft-scan-pack.py — the packed scans in public/textures/raft/ (raftScans.ts)\n'
    f'export const RAFT_SCAN_META = {json.dumps(meta, indent=2)} as const;\n'
)
for f in sorted(OUT.iterdir()):
    print(f.name, round(f.stat().st_size / 1e6, 2), 'MB')
