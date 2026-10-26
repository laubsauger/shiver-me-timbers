"""
The Drift's cloud noise (src/drift/wandering/clouds.ts): tileable 3D noise for a ray-marched cumulus layer,
after Schneider's Nubis (the cloud system of Horizon Zero Dawn): a SHAPE volume (128³: R = Perlin–Worley, the
billowing body; G, B, A = Worley fbm at three frequencies, what erodes it) and a DETAIL volume (32³: R, G, B =
Worley fbm at three higher frequencies, the wisps at the edges). Every channel tiles in all three axes, and
every channel is rank-transformed to a uniform distribution: a threshold at 1 − c then covers a share c of
space, so the shader's coverage is a direct dial (raw, the Perlin–Worley spanned only 0.59–0.77).

  out/drift/data/.venv/bin/python -I scripts/drift-cloud-noise.py public/drift/clouds
"""

import sys
from pathlib import Path

import numpy as np

OUT = Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)
rng = np.random.default_rng(2100)


def grid(n: int) -> np.ndarray:
    a = (np.arange(n, dtype=np.float32) + 0.5) / n
    z, y, x = np.meshgrid(a, a, a, indexing='ij')
    return np.stack([x, y, z], -1).reshape(-1, 3)


def worley(p: np.ndarray, cells: int) -> np.ndarray:
    """1 − distance to the nearest feature point (one per cell, wrapped), in [0, 1]"""
    pts = rng.random((cells, cells, cells, 3), dtype=np.float32)
    q = p * cells
    base = np.floor(q).astype(np.int32)
    best = np.full(len(p), 9.0, np.float32)
    for dz in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                c = base + np.array([dx, dy, dz], np.int32)
                w = c % cells
                f = pts[w[:, 2], w[:, 1], w[:, 0]] + c
                d = np.sqrt(((f - q) ** 2).sum(-1))
                np.minimum(best, d, out=best)
    return np.clip(1 - best, 0, 1)


def worley_fbm(p: np.ndarray, cells: int) -> np.ndarray:
    return worley(p, cells) * 0.625 + worley(p, cells * 2) * 0.25 + worley(p, cells * 4) * 0.125


def perlin(p: np.ndarray, period: int) -> np.ndarray:
    """tileable gradient noise, in about [-1, 1]"""
    g = rng.normal(size=(period, period, period, 3)).astype(np.float32)
    g /= np.linalg.norm(g, axis=-1, keepdims=True)
    q = p * period
    i0 = np.floor(q).astype(np.int32)
    f = q - i0
    u = f * f * f * (f * (f * 6 - 15) + 10)
    out = np.zeros(len(p), np.float32)
    for c in range(8):
        o = np.array([c & 1, (c >> 1) & 1, (c >> 2) & 1], np.int32)
        w = (i0 + o) % period
        dot = (g[w[:, 2], w[:, 1], w[:, 0]] * (f - o)).sum(-1)
        weight = np.prod(np.where(o == 1, u, 1 - u), -1)
        out += weight * dot
    return out


def perlin_fbm(p: np.ndarray, period: int, octaves: int) -> np.ndarray:
    s = np.zeros(len(p), np.float32)
    a, tot = 1.0, 0.0
    for k in range(octaves):
        s += perlin(p, period * 2 ** k) * a
        tot += a
        a *= 0.5
    return s / tot


def remap(x, a, b, c, d):
    return c + (x - a) / np.maximum(b - a, 1e-6) * (d - c)


def uniform(x: np.ndarray) -> np.ndarray:
    """rank-transform to a uniform distribution on [0, 1] (same order, even spread)"""
    r = np.empty(len(x), np.float32)
    r[np.argsort(x, kind='stable')] = np.linspace(0, 1, len(x), dtype=np.float32)
    return r


def u8(x: np.ndarray) -> np.ndarray:
    return np.clip(np.round(x * 255), 0, 255).astype(np.uint8)


N = 128
p = grid(N)
pf = np.clip(perlin_fbm(p, 4, 4) * 0.7 + 0.5, 0, 1)
w1 = worley_fbm(p, 4)
# Perlin–Worley: the Perlin body, its low values carved into Worley's round billows
pw = np.clip(remap(pf, w1 - 1, 1, 0, 1), 0, 1)
shape = np.stack([uniform(pw), uniform(w1), uniform(worley_fbm(p, 8)), uniform(worley_fbm(p, 16))], -1)
u8(shape).tofile(OUT / 'cloud-shape-128.u8')
print('shape', shape.shape, [round(float(shape[:, k].mean()), 3) for k in range(4)])

M = 32
q = grid(M)
detail = np.stack([uniform(worley_fbm(q, 2)), uniform(worley_fbm(q, 4)), uniform(worley_fbm(q, 8)), np.ones(M ** 3, np.float32)], -1)
u8(detail).tofile(OUT / 'cloud-detail-32.u8')
print('detail', detail.shape, [round(float(detail[:, k].mean()), 3) for k in range(3)])
