"""
The Drift, Act 3 (W4, drift-narrative/wandering-on/direction.md): the sandpipers that take off as one
vortex, with no leader — a flocking simulation baked to keyframes, so the show's frames stay pure functions
of time (the shader interpolates between the keys).

THE BIRDS follow local rules only (Reynolds' boids, with the topological neighbourhood real flocks use: each
bird heeds its ~7 nearest): keep apart, match heading, stay together; and they ride a slow wind that turns
about a point above the beach (the air, not a leader). Takeoff is a startle wave: the birds at one end of the
waterline lift first and the wave runs along the flock at ~15 m/s. They rise, wheel as one shape across the
sky over the audience, tighten and open, and settle far down the beach.

World (metres): the audience's eye at the origin, 1.6 m up, on the beach; +x right, +y up, −z ahead (the
front of the dome, down the beach). The waterline runs along the view 8 m to the LEFT (x = −8): the sea beyond
it, the sand to the right (wandering/beats.ts COAST, w4).

Second bake (2026-10-27, the v8 notes: "too organized", "bounce off the ground", "frozen in midair"): 75 s,
the whole of w4 and w5 — the birds start along OUR waterline; each carries its own slow turbulence and
heeds its neighbours more loosely; no hard floor (a soft lift keeps them off the sand while they fly); and
after the wheeling over the front and the zenith the air carries them away down the beach, where every one
of them comes down on the sand ~200 m ahead and stays (nothing hangs in the air when the bake ends).

  out/drift/data/.venv/bin/python -I scripts/drift-flock-bake.py public/drift/flock
"""

import sys
from pathlib import Path

import numpy as np

OUT = Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)

N = 2400
DURATION = 75.0  # s
DT = 1 / 60
KEY_HZ = 15
SEED = 2100

rng = np.random.default_rng(SEED)

# on the wet sand and in the swash along the waterline (x −8): a band 40 m long, 20–60 m ahead
pos = np.stack([rng.uniform(-11, -5, N), np.zeros(N), -rng.uniform(20, 60, N)], -1).astype(np.float64)
vel = np.zeros((N, 3))
# the startle wave runs from the far end toward us
takeoff = 1.2 + (pos[:, 2] + 60) / 12 + rng.normal(0, 0.15, N)
landed_at = np.full(N, np.inf)
# each bird's own turbulence: three slow sines at its own rates and phases (m/s²)
NOISE = 3.2
nf = rng.uniform(0.25, 0.9, (N, 3))
nph = rng.uniform(0, 2 * np.pi, (N, 3))
# where they come down: the waterline far ahead
LAND = np.array([-8.0, 0.0, -205.0])


def wind_centre(t: float) -> np.ndarray:
    """where the air carries the flock: up off the waterline, a big loop over the front, across the zenith and
    round, then away down the beach and down to the sand (the body follows it as one; nothing pulls a bird to a
    radius, so no ring forms)"""
    w = 2 * np.pi / 22
    # (third bake, the v9 review: the loop kept 12–45 m out in front, a cloud low over the beach; the direction
    # wants it "wheeling up over the audience, across the zenith" — now it swings up in front, over our heads
    # at ~17 m at t ≈ 15 s, and round to the front again)
    loop = np.array([-3 + np.sin(w * (t - 4)) * 22, 17 + np.sin(w * 2 * (t - 4)) * 5, -14 - np.cos(w * (t - 4)) * 20])
    start = np.array([-8.0, 5.0, -40.0])
    rise = np.clip((t - 1.5) / 4, 0, 1)
    rise = rise * rise * (3 - 2 * rise)
    away = np.clip((t - 30) / 14, 0, 1)
    away = away * away * (3 - 2 * away)
    down = np.clip((t - 42) / 10, 0, 1)
    far = np.array([-8.0, 9.0 * (1 - down) + 0.5 * down, -200.0])
    return (start * (1 - rise) + loop * rise) * (1 - away) + far * away


def wind_axis(t: float) -> np.ndarray:
    """the axis the body turns about inside itself, leaning slowly (the flock folds over)"""
    a = np.array([np.sin(t * 0.37) * 0.8, 1.0, np.cos(t * 0.29) * 0.6])
    return a / np.linalg.norm(a)


keys = []
n_steps = int(DURATION / DT)
key_every = int(round(1 / (KEY_HZ * DT)))
for step in range(n_steps + 1):
    t = step * DT
    if step % key_every == 0:
        keys.append(pos.astype(np.float32).copy())
    flying = (t >= takeoff) & (t < landed_at)
    idx = np.nonzero(flying)[0]
    if len(idx):
        p = pos[idx]
        v = vel[idx]
        # topological neighbours: the 7 nearest flying birds
        d = p[:, None, :] - p[None, :, :]
        d2 = (d * d).sum(-1)
        np.fill_diagonal(d2, np.inf)
        k = min(7, len(idx) - 1)
        acc = np.zeros_like(p)
        if k > 0:
            nn = np.argpartition(d2, k, axis=1)[:, :k]
            nd = d[np.arange(len(idx))[:, None], nn]  # self − neighbour
            nd2 = d2[np.arange(len(idx))[:, None], nn]
            sep = (nd / np.maximum(nd2, 0.04)[..., None] * (nd2 < 2.6)[..., None]).sum(1) * 2.4
            ali = (v[nn].mean(1) - v) * 1.4
            coh = (p[nn].mean(1) - p) * 0.32
            acc += sep + ali + coh
        # the air: carries the body toward where the loop is now; the body turns slowly within itself about
        # its own centre (a fold, not an orbit)
        c = wind_centre(t)
        to = c - p
        dist = np.linalg.norm(to, axis=1, keepdims=True) + 1e-6
        acc += to / dist * np.minimum(dist * 0.35, 9.5)
        mid = p.mean(0)
        r = p - mid
        rl = np.linalg.norm(r, axis=1, keepdims=True) + 1e-6
        # the fold, capped (a straggler far out must not be flung), and a faint pull to the body's centre so
        # it never comes apart into separate flocks
        acc += np.cross(wind_axis(t), r) / rl * np.minimum(rl * 0.35, 2.5)
        acc += -r / rl * np.clip(rl - 18, 0, 20) * 0.05
        # each its own turbulence (the body is never one rigid shape)
        acc += NOISE * np.sin(nf[idx] * t * 2 * np.pi + nph[idx]) * np.array([1.0, 0.45, 1.0])
        # lift off the sand for the first seconds of flight; then a soft lift, rising as they near the sand
        # (no floor to bounce off), until the landing: near the landing ground they let themselves down
        since = (t - takeoff[idx])[:, None]
        landing = (t > 44) & (np.linalg.norm(p - LAND, axis=1, keepdims=True) < 40)
        acc[:, 1:2] += np.where(since < 1.2, 5.0, 0.0) + np.where(landing, -1.5, np.maximum(0, 3 - p[:, 1:2]) * 3.0)
        v = v + acc * DT
        sp = np.linalg.norm(v, axis=1, keepdims=True) + 1e-6
        # sandpipers fly ~10–14 m/s; slower in the first wingbeats and coming in to land
        lo = np.where(since < 1.0, 2.0, np.where(landing, 3.0, 9.0))
        hi = np.where(landing, 7.0, 14.0)
        v = v / sp * np.clip(sp, lo, hi)
        vel[idx] = v
        pos[idx] = p + v * DT
        # down on the sand: they stay
        low = idx[(pos[idx, 1] < 0.25) & landing[:, 0]]
        landed_at[low] = t
        pos[low, 1] = 0
        vel[low] = 0
        pos[idx, 1] = np.maximum(pos[idx, 1], 0.0)
keys = np.stack(keys)  # (frames, birds, 3)
print('keys', keys.shape, 'altitude range', keys[..., 1].min(), keys[..., 1].max())
# float16 RGBA rows: one row per key, one texel per bird (xyz, w = 1 while flying, 0 on the sand)
flyingK = (keys[..., 1] > 0.05).astype(np.float32)
data = np.concatenate([keys, flyingK[..., None]], -1).astype('<f2')
data.tofile(OUT / 'flock-keys.f16')
(OUT / 'flock-keys.json').write_text(f'{{"birds": {N}, "keys": {keys.shape[0]}, "hz": {KEY_HZ}, "duration": {DURATION}}}')
print(OUT / 'flock-keys.f16', data.nbytes / 1e6, 'MB')

# a CPU preview in dome space: equidistant fisheye, zenith at the centre, the front at the bottom
from PIL import Image, ImageDraw  # noqa: E402

eye = np.array([0, 1.6, 0])
S = 360
frames = []
for t in (2, 5, 9, 13, 18, 24, 30, 36, 42, 50, 60, 74):
    f = keys[min(len(keys) - 1, int(t * KEY_HZ))] - eye
    d = f / (np.linalg.norm(f, axis=1, keepdims=True) + 1e-9)
    el = np.degrees(np.arcsin(np.clip(d[:, 1], -1, 1)))
    az = np.arctan2(d[:, 0], -d[:, 2])
    rr = (90 - el) / 90 * (S / 2)
    x = S / 2 + np.sin(az) * rr
    y = S / 2 + np.cos(az) * rr
    im = Image.new('L', (S, S), 0)
    g = ImageDraw.Draw(im)
    g.ellipse((0, 0, S - 1, S - 1), outline=60)
    for xi, yi, e in zip(x, y, el):
        if e > -5:
            g.point((xi, yi), fill=255)
    g.text((6, 6), f'{t}s', fill=200)
    frames.append(im)
sheet = Image.new('L', (S * 6, S * 2))
for i, im in enumerate(frames):
    sheet.paste(im, ((i % 6) * S, (i // 6) * S))
sheet.save(OUT / 'flock-preview.png')
