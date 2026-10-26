"""
The Drift's cosmic web (src/drift/undertime/webVolume.ts), built the way the structure itself forms.

The ZEL'DOVICH APPROXIMATION: a Gaussian random density field (the early universe's tiny ripples, a
power-law spectrum) gives every bit of matter a displacement, the gradient of its potential; moving the
matter along those displacements by a growth factor D collapses it first into sheets, where the flows
cross into filaments, and where filaments cross into knots — the cosmic web of the simulations
(drift-narrative/references/cosmic-web). TRUNCATED: the initial field is smoothed at the scale where the
collapse would go fully non-linear, which keeps the filaments sharp instead of smeared past each other.

Matter on a lattice of N³ particles is moved, deposited back onto an N³ grid (cloud-in-cell) and stored as a
log-stretched 8-bit volume — the stretch every simulation image uses (voids just above black, knots
saturated). The box is periodic, so the volume tiles.

The knots are the density peaks: the brightest local maxima, written out with their strengths for the
first stars (U6) and the galaxies that open at them (Get the Drift).

  out/drift/data/.venv/bin/python -I scripts/drift-web-volume.py public/drift/web
"""

import json
import os
import sys
from pathlib import Path

import numpy as np

OUT = Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)

N = 256  # grid (and particle lattice) per side
SEED = 2100
SLOPE = float(os.environ.get('WEB_SLOPE', -2.3))  # spectral index of the initial power: steeper = bigger voids, less hair
TRUNCATE = float(os.environ.get('WEB_TRUNCATE', 1.6))  # smoothing of the initial field, in cells (sharpness of the filaments)
DISPLACE = float(os.environ.get('WEB_DISPLACE', 9.0))  # rms displacement, in cells (how far the collapse has gone)
KNOTS = 160

rng = np.random.default_rng(SEED)
k1 = np.fft.fftfreq(N) * 2 * np.pi  # rad per cell
kx, ky, kz = np.meshgrid(k1, k1, np.fft.rfftfreq(N) * 2 * np.pi, indexing='ij')
k2 = kx * kx + ky * ky + kz * kz
k2[0, 0, 0] = 1
amp = np.power(k2, SLOPE / 4) * np.exp(-k2 * TRUNCATE * TRUNCATE / 2)
amp[0, 0, 0] = 0
delta_k = (rng.standard_normal(k2.shape) + 1j * rng.standard_normal(k2.shape)) * amp
del amp

# displacement ψ = ∇(∇⁻² δ): ψ_k = i k δ_k / k²
psi = []
for kc in (kx, ky, kz):
    psi.append(np.fft.irfftn(1j * kc * delta_k / k2, s=(N, N, N)).astype(np.float32))
del delta_k, kx, ky, kz, k2
rms = np.sqrt(np.mean(psi[0] ** 2 + psi[1] ** 2 + psi[2] ** 2))
scale = DISPLACE / rms
print(f'rms displacement {rms:.4g} → scaled by {scale:.4g}')

# move the lattice, deposit cloud-in-cell (8 neighbours, periodic): a chunk of lattice planes at a time,
# one bincount per chunk (bounded memory, few passes over the grid)
q = np.arange(N, dtype=np.float32)
rho = np.zeros(N * N * N, np.float64)
CHUNK = 16
jrng = np.random.default_rng(SEED + 1)
for i0 in range(0, N, CHUNK):
    sl = slice(i0, i0 + CHUNK)
    # each particle starts at a random point of its lattice cell: a regular lattice leaves moiré in the voids
    jx, jy, jz = (jrng.random((3, CHUNK, N, N), dtype=np.float32) - 0.5)
    x = (np.arange(i0, i0 + CHUNK, dtype=np.float32)[:, None, None] + 0.5 + jx + psi[0][sl] * scale) % N
    y = (q[None, :, None] + 0.5 + jy + psi[1][sl] * scale) % N
    z = (q[None, None, :] + 0.5 + jz + psi[2][sl] * scale) % N
    x0, y0, z0 = np.floor(x - 0.5), np.floor(y - 0.5), np.floor(z - 0.5)
    fx, fy, fz = x - 0.5 - x0, y - 0.5 - y0, z - 0.5 - z0
    idxs, ws = [], []
    for dx, wx in ((0, 1 - fx), (1, fx)):
        for dy, wy in ((0, 1 - fy), (1, fy)):
            for dz, wz in ((0, 1 - fz), (1, fz)):
                idxs.append(((((x0 + dx) % N) * N + (y0 + dy) % N) * N + (z0 + dz) % N).astype(np.int64).ravel())
                ws.append((wx * wy * wz).ravel())
    rho += np.bincount(np.concatenate(idxs), np.concatenate(ws), N * N * N)
rho = rho.reshape(N, N, N).astype(np.float32)
print('density: mean', rho.mean(), 'max', rho.max(), 'empty cells', (rho < 0.05).mean())

def smooth(a: np.ndarray, s: float) -> np.ndarray:
    """periodic gaussian blur of the grid, σ = s cells"""
    f = np.fft.rfftn(a)
    k = np.fft.fftfreq(N) * 2 * np.pi
    kk = k[:, None, None] ** 2 + k[None, :, None] ** 2 + (np.fft.rfftfreq(N) * 2 * np.pi)[None, None, :] ** 2
    return np.fft.irfftn(f * np.exp(-kk * s * s / 2), s=a.shape).astype(np.float32)


# about one particle per cell is shot noise in the voids: a light blur before anything reads the density
rho = np.maximum(smooth(rho, 0.8), 0)

# the log stretch: 1 + ρ/ρ̄ from voids (~0.1) to knots (~100s); 0..255 over log10 of [0.15, 300]
lo, hi = np.log10(0.15), np.log10(300)
v = (np.log10(np.maximum(rho, 1e-3)) - lo) / (hi - lo)
vol = np.clip(np.round(v * 255), 0, 255).astype(np.uint8)
vol.tofile(OUT / 'web-256.u8')  # x-major (index = (x·N + y)·N + z): the shader's 3D texture

# THE PARTICLES themselves (webParticles.ts): what makes the simulations' images crisp at any distance. The
# same displaced lattice again (same jitter), each particle kept with a probability rising with the density
# where it landed — every particle on the filaments and knots, a thin sprinkle in the voids — stored as
# uint16 (u, v, w, log density) in the texture's axis order (u = array z, v = y, w = x)
prng = np.random.default_rng(SEED + 1)
krng = np.random.default_rng(SEED + 2)
parts = []
for i0 in range(0, N, CHUNK):
    sl = slice(i0, i0 + CHUNK)
    jx, jy, jz = (prng.random((3, CHUNK, N, N), dtype=np.float32) - 0.5)
    x = (np.arange(i0, i0 + CHUNK, dtype=np.float32)[:, None, None] + 0.5 + jx + psi[0][sl] * scale) % N
    y = (q[None, :, None] + 0.5 + jy + psi[1][sl] * scale) % N
    z = (q[None, None, :] + 0.5 + jz + psi[2][sl] * scale) % N
    cell = vol[x.astype(np.int32) % N, y.astype(np.int32) % N, z.astype(np.int32) % N]
    keep = krng.random(cell.shape) < np.clip((cell.astype(np.float32) / 255 - 0.3) / 0.25, 0.004, 1) ** 2
    parts.append(np.stack([z[keep] / N, y[keep] / N, x[keep] / N, cell[keep] / 255], -1))
del psi
P = np.concatenate(parts)
krng.shuffle(P)  # any prefix is a fair subsample (the shader may draw fewer)
(np.clip(P, 0, 0.99999) * 65536).astype('<u2').tofile(OUT / 'web-particles.u16')
print(f'{len(P)} particles ({len(P) * 8 / 1e6:.1f} MB)')
# the far steps' level: the density averaged over 4³ cells (then stretched: averaging the log would not be)
r64 = rho.reshape(N // 4, 4, N // 4, 4, N // 4, 4).mean(axis=(1, 3, 5))
v64 = (np.log10(np.maximum(r64, 1e-3)) - lo) / (hi - lo)
np.clip(np.round(v64 * 255), 0, 255).astype(np.uint8).tofile(OUT / 'web-64.u8')

# knots: local maxima of the density smoothed over ~1.5 cells, the strongest first, not too close together
sm = smooth(rho, 1.5)
peak = np.ones_like(sm, dtype=bool)
for ax in range(3):
    for sh in (-1, 1):
        peak &= sm >= np.roll(sm, sh, axis=ax)
cand = np.argwhere(peak & (sm > np.percentile(sm, 99.5)))
order = np.argsort(-sm[tuple(cand.T)])
knots: list[dict] = []
for c in cand[order]:
    p = (c + 0.5) / N
    # periodic distance to every knot kept so far
    if all(np.linalg.norm((p - np.array(k['pos']) + 0.5) % 1 - 0.5) > 6 / N for k in knots):
        knots.append({'pos': [round(float(a), 5) for a in p], 'density': round(float(sm[tuple(c)]), 2)})
    if len(knots) >= KNOTS:
        break
(OUT / 'web-knots.json').write_text(json.dumps({'n': N, 'knots': knots}, indent=0))
print(f'{len(knots)} knots, densest {knots[0]["density"]}, faintest {knots[-1]["density"]}')

# a quick look: a thin slice and a full projection, log-stretched like the shader
from PIL import Image  # noqa: E402

proj = np.log10(rho.mean(axis=2) + 1e-3)
for name, img in (('slice', vol[:, :, N // 2].astype(np.float32) / 255), ('projection', (proj - proj.min()) / (proj.max() - proj.min()))):
    Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8), 'L').resize((768, 768)).save(OUT / f'web-preview-{name}.png')
