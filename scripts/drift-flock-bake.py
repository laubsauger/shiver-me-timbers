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
of them comes down on the sand ~90 m ahead and stays (nothing hangs in the air when the bake ends; fifth bake,
the v10 review: nearer, and a pull-up out of every dive near the sand).

Fourth bake (2026-10-27, the v9 review: the vortex "was supposed to be that, at least for a while", one that
"resembles the debris vortex we've seen earlier"): from VORTEX[0] to VORTEX[1] the air turns the flock into a
vortex over the audience, the debris galaxy's own shape (getTheDrift/debrisField.ts: two trailing logarithmic
arms at a 13° pitch, turning clockwise seen from above). Each bird is given a radius on an arm and flies its own
place on an arm (or in the core) and the arms turn as one, as a galaxy's pattern does: the rim at the birds'
airspeed, the inner birds slower, wheeling (each at its own airspeed, the inner ones lapped the outer and wound
the arms flat into a ring within seconds: tried). It tightens, then opens, and the air takes the flock on as
before. Inside the vortex the birds still keep apart and still carry their own turbulence; alignment and
cohesion give way to it.

Sixth bake (2026-10-28, the client's references — sandpiper murmurations at Ocean Shores and the Bay of Fundy —
and the v11 review: the flock read as thin, scattered specks, never one body): a murmuration's own model.
Ten thousand birds, a metre apart, each heeding its 7 nearest (StarDisplay: Hildenbrandt, Carere & Hemelrijk
2010), the border birds holding in hardest, so the body has an edge; turning by the inertial spin model
(Cavagna et al. 2015), so a turn runs through the body as a wave, and the white bellies flash across it with
the turn; nothing steers them but an area of air that wanders over the beach (free within it, drawn back from
beyond). The vortex comes once, for ~10 s; before and after it the shapes are the flock's own.

Eighth bake, an ALTERNATE (2026-11-02, the next-level review, move 5: "the flock rises in the score's silence"):
`--silence` writes flock-keys-silence.* beside the seventh bake's keys, which it leaves as they are; the film reads it
under `flockSilence` (params/drift.ts, default off). The score's one real hole is ~650–677 s (the show's WAV at
offset 0, 0.5 s RMS: down from ~−20 dBFS to −28 at 650 s, its deepest −36 at 652 s, −25…−34 to 676.5 s, and the
music back at 677.0 s at −15). The flock's clock starts at w4 + 2 s (show 637 s, sea.ts), so: the seventh bake's way
in over the forest and its low pass across the front, quicker (over the trees by ~639 s, across the front ~642 s:
the 2026-11-03 note, "too much downtime before the birds come out"); then it wheels low in front, held together, and
at SILENCE_LIFT (14.5 s: show 651.5 s, the start of the silence's deepest 2 s) the whole of it lifts
AT ONCE — every bird climbs in the same second, no wave along it — and is routed up and round to the FRONT RIGHT, the
darker east sky out of the low Sun's glare (the Sun ~4° up, 68° left of the front: in the seventh bake the flock
wheeled over the sea right under it, where it read as a smudge), wheels there, ~45° up and ~50 m off, for ~10 s, and
gathers into the vortex there, whose axis then climbs slowly over the audience to the dome's zenith (the H18 dome's
zenith is 15° ahead of true up) as the music comes back (~676 s), and holds it there for the vortex's last seconds:
the crossing of the top of the dome takes ~10 s, not the ~3 s a flock flying straight over at 40 m would (11 m/s
over 40 m is 16°/s). After it, the seventh bake's way out down the beach and over the trees, later by 8 s.

  out/drift/data/.venv/bin/python -I scripts/drift-flock-bake.py public/drift/flock
  out/drift/data/.venv/bin/python -I scripts/drift-flock-bake.py public/drift/flock --silence
"""

import os
import sys
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

OUT = Path([a for a in sys.argv[1:] if not a.startswith('--')][0])
OUT.mkdir(parents=True, exist_ok=True)
# (the eighth bake, an alternate beside the seventh's keys: see the header)
SILENCE = '--silence' in sys.argv
SUFFIX = '-silence' if SILENCE else ''

# (FLOCK_N: a smaller flock for a quick look while tuning)
N = int(os.environ.get('FLOCK_N', 10000))
DURATION = 75.0  # s
DT = 1 / 60
KEY_HZ = 15
SEED = 2100
# the key texture: a flock wider than a GPU texture may be (8192 texels) is laid out over several rows per key,
# split evenly (no padding to speak of)
ROWS = -(-N // 8192)
TEX_W = -(-N // ROWS)

rng = np.random.default_rng(SEED)

# Seventh bake (2026-10-29, the review of v11: the birds "appear so weirdly in the far, far back and sit on the
# water in this strange way … either they keep flying or they fly away"; "a little closer to the camera so that we
# see the shapes every once in a while"; "we will have a forest where we can have them appear in and out"): the
# flock is never on the ground. It comes in FLYING over the forest on our right (hidden behind the canopy until it
# clears it), sweeps low past us along the waterline, close enough for the birds' shapes to read, wheels out over
# the sea, forms the vortex overhead, and leaves down the beach ahead and over the forest there, gone behind the
# trees — where the wanderers walk on after it (w5).
pos = np.stack([rng.uniform(55, 85, N), rng.uniform(12, 18, N), -rng.uniform(30, 70, N)], -1).astype(np.float64)
# (--silence, the 2026-11-03 note on the 56e951c master: "I think we have too much downtime before the birds come out.
# That can probably be tightened a little" — the seventh bake's flock stayed behind the forest until ~642 s, 7 s into
# w4. Here it starts just behind the canopy's edge on the right, nearer, so it is over the trees within ~2 s of its
# clock's start (show 637 s); it is never drawn before 636 s, and at its clock's start it must still be hidden: the
# first key is held while the clock is below 0)
if '--silence' in sys.argv:
    pos = np.stack([rng.uniform(46, 66, N), rng.uniform(14, 20, N), -rng.uniform(36, 62, N)], -1).astype(np.float64)
e0 = np.stack([-0.85 + rng.normal(0, 0.05, N), rng.normal(0, 0.03, N), 0.25 + rng.normal(0, 0.05, N)], -1)
vel = e0 / np.linalg.norm(e0, axis=1, keepdims=True) * 10.0
# each bird's spin (the inertial spin model: a turn is a quantity the bird carries and hands on, so a turn runs
# through the flock as a wave instead of spreading out and dying, as measured in starlings: Attanasi et al. 2014)
spin = np.zeros((N, 3))
# (all aloft from the start: no startle, no takeoff)
takeoff = np.full(N, -5.0)
landed_at = np.full(N, np.inf)
# each bird's own cruising speed (sandpipers fly ~10–14 m/s) and its own turbulence: three slow sines (m/s²)
CRUISE = rng.normal(11.0, 0.8, N)
NOISE = 0.9
nf = rng.uniform(0.25, 0.9, (N, 3))
nph = rng.uniform(0, 2 * np.pi, (N, 3))
# where they come down: the waterline ahead — near enough to see them settle (at ~200 m, the flock shrank to nothing
# and was gone: "they disappear in a strange way", the v10 review)
LAND = np.array([-8.0, 0.0, -90.0])
# m: below this a flying bird pulls up out of its dive, the harder the nearer the sand and the steeper the dive (a
# soft lift under 3 m let the dives reach the sand at full speed: "smashing on the ground quite hard", v10)
PULL_UP = 7.0
# deg: the lowest the flock flies as seen from the audience's eye — seen from 1.6 m up, a body skimming 2–5 m
# over the sea 50 m off sat on the horizon and read as crashing into the water (the 2026-10-29 review of the
# seventh bake)
SEEN_ABOVE = 7.0
# m: the band over which the floor's lift eases in and out
FLOOR_SOFT = 6.0
# m: the nearest a bird comes to the audience's eye
EYE_CLEAR = 14.0
# THE RULES (StarDisplay, Hildenbrandt, Carere & Hemelrijk 2010, with the inertial spin model's turning):
# m: closer than this a bird moves off its neighbour (a sandpiper spans ~0.4 m; the flock's own spacing comes out
# near a metre), and how hard
R_SEP = 0.8
K_SEP = 40.0
# cohesion toward the 7 neighbours' centre, much stronger for a bird on the border (its neighbours all lie to one
# side): what gives a murmuration its sharp edge
K_COH = 1.2
# the spin: alignment's pull on it (1/s²), its friction (1/s): underdamped, so a turn overshoots a little and
# travels; the most a bird turns (rad/s, ~3 g at cruise)
J_ALIGN = 7.0
ETA = 2.0
MAX_TURN = 3.2
# THE AREA the flock keeps to (where the air and the shore hold it, not a leader): a centre that wanders, a
# radius it may roam freely within, and a band of height about the centre's
R_AREA = 18.0
K_AREA = 0.6
BAND = 6.0
K_ALT = 1.6
# THE VORTEX, once, briefly (the v11 review: "this vortex showing up once briefly, and before or after have
# them be organic"): s it holds (eased in and out over V_EASE), its axis (vertical, through this point: just ahead
# of the audience, overhead), the arms' reach (m), their pitch, the rim's airspeed (m/s), the core's share of the
# birds and its reach (m), and the funnel: the height at the arms' inner end (m) and its rise per metre out
VORTEX = (34.0, 46.0) if SILENCE else (28.0, 38.0)
V_EASE = 3.0
V_AXIS = np.array([-2.0, 0.0, -8.0])
# THE SILENCE (eighth bake): s of the lift, how long its climb pushes, and how hard (m/s², up and to the right); the
# vortex axis's climb from the front right to the zenith (s, from where to where: x, z m), over V_AXIS at its end
SILENCE_LIFT = 14.5
SILENCE_PUSH = 1.6
SILENCE_UP = 16.0
SILENCE_RIGHT = 8.0
V_CLIMB = (VORTEX[0], VORTEX[0] + 6.0)
V_FROM = np.array([16.0, 0.0, -30.0])
V_R = (13.0, 30.0)
V_CORE = 0.12
V_CORE_R = (3.0, 11.0)
V_WIND = 1 / np.tan(np.radians(13))
V_SPEED = 11.0
V_BASE = 24.0
V_RISE = 0.55


def smooth(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def vortex_axis(t: float) -> np.ndarray:
    """the vortex's axis at t: fixed (V_AXIS), or under --silence climbing from the front right to the zenith"""
    if not SILENCE:
        return V_AXIS
    k = smooth((t - V_CLIMB[0]) / (V_CLIMB[1] - V_CLIMB[0]))
    return V_FROM * (1 - k) + V_AXIS * k


def vortex_weight(t: float) -> float:
    return float(smooth((t - VORTEX[0]) / V_EASE) * smooth((VORTEX[1] - t) / V_EASE))


def vortex_squeeze(t: float) -> float:
    """the radii's scale: it tightens to its narrowest mid-way, then opens past where it began"""
    u = np.clip((t - VORTEX[0]) / (VORTEX[1] - VORTEX[0]), 0, 1)
    return float(1 - 0.3 * np.sin(np.pi * min(1, u * 1.4)) + 0.12 * max(0, u - 0.7) / 0.3)


def arm_angle(r: np.ndarray, arm: np.ndarray) -> np.ndarray:
    """rad (from +x toward −z): where arm 0 or 1 passes at radius r — trailing, as the debris' arms"""
    return np.log(r / V_R[0]) * V_WIND + arm * np.pi


# each bird's place in the vortex, given as it enters (its radius by its rank in distance from the axis, so the
# body is not torn across; its arm)
v_r = None
v_theta0 = None
# ∫ dt / squeeze since the vortex began: the pattern turns at the rim's airspeed over the rim's CURRENT radius
v_phase = 0.0


def area_centre(t: float) -> np.ndarray:
    """the centre of the air the flock keeps to (seventh bake): in over the forest on the right, a low sweep past
    us along the waterline (the shapes read: ~6–15 m off), out over the sea to wheel there (~90 m off, one body,
    the flashes of its turns), in over the audience for the vortex, held on its own axis; then a second, higher pass
    along the surf and away down the beach ahead and over the forest there, behind the trees"""
    keys_ = [
        (0.0, (62.0, 15.0, -45.0)),
        # (across the front, never at us: the pass crosses the view ~30 m ahead and 10 m up, left to right of the
        # line of sight — straight in at the eye read as birds flying into the audience, "scary and spooky", the
        # 2026-10-29 review)
        (5.0, (22.0, 19.0, -40.0)),
        (9.0, (0.0, 18.5, -30.0)),
        (13.0, (-26.0, 21.0, -34.0)),
        (17.0, (-55.0, 26.0, -80.0)),
    ]
    w = 2 * np.pi / 18
    wheel = np.array([-50 - np.sin(w * (t - 17)) * 18, 28 + np.sin(w * 2 * (t - 17) + 1) * 8, -85 - np.cos(w * (t - 17)) * 16])
    over = np.array([V_AXIS[0], V_BASE + 4, V_AXIS[2]])
    after = [
        (VORTEX[1] + 2, (-16.0, 23.0, -20.0)),
        (VORTEX[1] + 9, (-14.0, 20.0, -55.0)),
        (VORTEX[1] + 17, (6.0, 20.0, -110.0)),
        (VORTEX[1] + 26, (70.0, 18.0, -160.0)),
        (DURATION, (120.0, 18.0, -200.0)),
    ]

    def path(ks, t):
        if t <= ks[0][0]:
            return np.array(ks[0][1])
        for (t0, a), (t1, b) in zip(ks, ks[1:]):
            if t <= t1:
                k = smooth((t - t0) / (t1 - t0))
                return np.array(a) * (1 - k) + np.array(b) * k
        return np.array(ks[-1][1])

    if SILENCE:
        # (the eighth bake: in over the trees on the right and the low pass across the front, then it wheels in view
        # ahead and hangs low there until the lift, then up and round to the front right, a wheel there against the east
        # sky, and into the vortex where it forms; the way out as before, 8 s later)
        # (NO DOWNTIME BEFORE IT, the 2026-11-03 note on the 56e951c master: "too much downtime before the birds come
        # out". The way in is quicker — over the treetops by ~639 s, across the front ~642 s, not 642 and 645 s — and
        # out of the pass it no longer drifts out left toward the Sun to thin there, but turns back and wheels low in
        # front, ~20–25 m up and 45–50 m off, held together (r_area), until the lift; and the lift goes UP the front,
        # not off to the right — out of a hang that drifted right, the climb carried the flock 70–80 m off behind the
        # palms for 653–661 s, the silence's first seconds, the 630–690 clip of 2026-11-03)
        keys_ = [
            (0.0, (50.0, 18.0, -48.0)),
            (2.5, (28.0, 21.0, -44.0)),
            (5.5, (4.0, 20.0, -34.0)),
            (8.5, (-10.0, 26.0, -36.0)),
            (11.5, (-8.0, 27.0, -44.0)),
            (SILENCE_LIFT, (-2.0, 20.0, -46.0)),
            (SILENCE_LIFT + 2, (0.0, 28.0, -48.0)),
            (SILENCE_LIFT + 6, (2.0, 40.0, -42.0)),
            (SILENCE_LIFT + 9, (6.0, 46.0, -40.0)),
        ]
        # (the wheel ~50 m off, ~45° up and 20–35° right: the open sky between the Sun's side and the forest. At ~100 m
        # and 25–35° up, 45–55° right — the first silence bake — it sank behind the palms on the right and thinned to the
        # same faint smudge it had been in the glare: the 2048 dome clip of 2026-11-02; and held ~6 m higher than the
        # second try's, whose sag after the climb dropped it behind the palms again for ~3 s at 659–662 s)
        w = 2 * np.pi / 14
        u = t - (SILENCE_LIFT + 9)
        wheel = np.array([6 + np.sin(w * u) * 8, 38 + np.sin(w * 2 * u + 1) * 3, -38 - np.cos(w * u) * 6])
        ax = vortex_axis(t)
        over = np.array([ax[0], V_BASE + 4, ax[2]])
        after = [(VORTEX[1] + 2, (-16.0, 23.0, -20.0)), (VORTEX[1] + 8, (-14.0, 20.0, -55.0)), (VORTEX[1] + 14, (6.0, 20.0, -110.0)),
                 (VORTEX[1] + 21, (70.0, 18.0, -160.0)), (DURATION, (120.0, 18.0, -200.0))]
        c = path(keys_, t) if t < SILENCE_LIFT + 9 else wheel
        c = c * (1 - smooth((t - VORTEX[0] + 4) / 5)) + over * smooth((t - VORTEX[0] + 4) / 5)
        return c * (1 - smooth((t - VORTEX[1]) / 3)) + path(after, t) * smooth((t - VORTEX[1]) / 3)
    c = path(keys_, t) if t < 17 else wheel
    c = c * (1 - smooth((t - VORTEX[0] + 9) / 6)) + over * smooth((t - VORTEX[0] + 9) / 6)
    return c * (1 - smooth((t - VORTEX[1]) / 3)) + path(after, t) * smooth((t - VORTEX[1]) / 3)


def rotate(e: np.ndarray, w: np.ndarray) -> np.ndarray:
    """turn unit vectors e by the rotation vectors w (rad), renormalised"""
    a = np.linalg.norm(w, axis=1, keepdims=True)
    k = w / np.maximum(a, 1e-9)
    c, s = np.cos(a), np.sin(a)
    r = e * c + np.cross(k, e) * s + k * (k * e).sum(1, keepdims=True) * (1 - c)
    return r / np.linalg.norm(r, axis=1, keepdims=True)


keys = []
n_steps = int(DURATION / DT)
key_every = int(round(1 / (KEY_HZ * DT)))
for step in range(n_steps + 1):
    t = step * DT
    if step % key_every == 0:
        keys.append(pos.astype(np.float32).copy())
    flying = (t >= takeoff) & (t < landed_at)
    # the first wingbeats (none in the seventh bake: aloft from the start)
    born = flying & (np.linalg.norm(vel, axis=1) == 0)
    if born.any():
        e0 = np.stack([-0.35 + rng.normal(0, 0.2, born.sum()), np.full(born.sum(), 0.85), -0.3 + rng.normal(0, 0.2, born.sum())], -1)
        vel[born] = e0 / np.linalg.norm(e0, axis=1, keepdims=True) * 3.0
    idx = np.nonzero(flying)[0]
    vw = vortex_weight(t)
    if v_r is None and t >= VORTEX[0]:
        rel = pos - vortex_axis(t)
        dist0 = np.hypot(rel[:, 0], rel[:, 2])
        rank = np.argsort(np.argsort(dist0)) / (N - 1)
        core = rank < V_CORE
        q = np.where(core, rank / V_CORE, (rank - V_CORE) / (1 - V_CORE))
        lo, hi = np.where(core, V_CORE_R[0], V_R[0]), np.where(core, V_CORE_R[1], V_R[1])
        v_r = np.sqrt(lo ** 2 + (hi ** 2 - lo ** 2) * q)
        phi = np.arctan2(-rel[:, 2], rel[:, 0])
        # (half to each arm, whichever is nearer: the body comes in from one side, so by nearness alone nearly
        # all of it took one arm — tried; the other half streams round to the far arm as the vortex forms)
        near = [np.angle(np.exp(1j * (phi - arm_angle(v_r, np.full(N, k))))) for k in (0, 1)]
        pref = np.abs(near[1]) - np.abs(near[0])
        arm = (np.argsort(np.argsort(pref)) < N // 2).astype(np.float64)
        # (the core has no arms: each keeps the bearing it came in at)
        v_theta0 = np.where(core, phi, arm_angle(v_r, arm) + rng.normal(0, 0.1, N))
    if len(idx):
        p = pos[idx]
        v = vel[idx]
        sp = np.linalg.norm(v, axis=1, keepdims=True) + 1e-9
        e = v / sp
        F = np.zeros_like(p)
        k = min(7, len(idx) - 1)
        e_nb = e
        if k > 0:
            # topological neighbours: the 7 nearest flying birds, wherever they are
            dd, nn = cKDTree(p).query(p, k=k + 1)
            dd, nn = dd[:, 1:], nn[:, 1:]
            off = p[:, None, :] - p[nn]  # self − neighbour
            close = np.clip(1 - dd / R_SEP, 0, None)[..., None]
            F += (off / np.maximum(dd, 0.05)[..., None] * close).sum(1) * K_SEP
            unit = -off / np.maximum(dd, 1e-6)[..., None]
            border = np.linalg.norm(unit.mean(1), axis=1, keepdims=True)
            F += (p[nn].mean(1) - p) * K_COH * (0.25 + 3 * border * border) * (1 - 0.7 * vw)
            e_nb = e[nn].mean(1)
        # the area: free within R_AREA of its centre, drawn back beyond it; a band of height about the centre's
        c = area_centre(t)
        to = c - p
        hd = np.hypot(to[:, 0], to[:, 2])[:, None] + 1e-6
        # (held tighter through the pass across the front, so the body comes by as one, not spread toward us)
        r_area = R_AREA - 11.0 * smooth((t - 4) / 2) * smooth((12 - t) / 2)
        if SILENCE:
            # (--silence: held as one from its quicker pass on, through the wheel in front and the lift (7 m), then a
            # little looser through the wheel at the front right until the vortex (10 m). Loosened over the lift — to
            # 18 m, from 1 s after it — the climb ran out 70–80 m and behind the palms on the right for 657–660 s (the
            # second 630–690 clip of 2026-11-03); held at 7 m on into the vortex, the flock came into it off its axis
            # and the vortex wheeled lopsided, 20–30° off the zenith instead of over it)
            r_area = R_AREA - 11.0 * smooth((t - 2.5) / 2) * smooth((SILENCE_LIFT + 4 - t) / 2) - 8.0 * smooth((t - SILENCE_LIFT - 2) / 3) * smooth((VORTEX[0] - t) / 2)

        pull = np.minimum((hd - r_area).clip(0) * K_AREA * (1 + 1.5 * (R_AREA - r_area) / 11.0), 6.0) * (1 - vw)
        F[:, [0, 2]] += to[:, [0, 2]] / hd * pull
        dy = to[:, 1:2]
        F[:, 1:2] += np.clip(np.sign(dy) * (np.abs(dy) - BAND).clip(0) * K_ALT, -5, 5) * (1 - vw)
        # the vortex: each bird toward its own place on its arm, turning with the pattern (clockwise from
        # above: the angle falls)
        if vw > 0:
            rad = v_r[idx] * vortex_squeeze(t)
            th = v_theta0[idx] - V_SPEED / V_R[1] * v_phase
            ax = vortex_axis(t)
            goal = np.stack([ax[0] + rad * np.cos(th), V_BASE + (rad - V_R[0]) * V_RISE, ax[2] - rad * np.sin(th)], -1)
            # d(goal)/dθ · dθ/dt: the tangent, at the pattern's speed there (and the axis's own drift, --silence)
            gvel = np.stack([np.sin(th), np.zeros_like(th), np.cos(th)], -1) * (V_SPEED * v_r[idx] / V_R[1])[:, None]
            gvel += (vortex_axis(t + 0.05) - vortex_axis(t - 0.05)) / 0.1
            F += ((goal - p) * 1.1 + (gvel - v) * 1.6) * vw
        # KEEP OFF THE AUDIENCE: within EYE_CLEAR of the eye a bird is pushed away from it, hard (a flock that came
        # at the eye was the review's complaint, and in the vortex overhead the core's lowest birds came near)
        to_eye = p - np.array([0.0, 1.6, 0.0])
        de = np.linalg.norm(to_eye, axis=1, keepdims=True) + 1e-6
        F += to_eye / de * (np.clip(EYE_CLEAR - de, 0, None) * 14.0)
        # THE LIFT (--silence): every bird at once, up and to the right, for SILENCE_PUSH s — no startle wave along the
        # body: the move asks for the whole flock lifting in the same second of the silence
        if SILENCE:
            push = smooth((t - SILENCE_LIFT) / 0.25) * smooth((SILENCE_LIFT + SILENCE_PUSH - t) / 0.5)
            F[:, 1] += SILENCE_UP * push
            F[:, 0] += SILENCE_RIGHT * push
        # each its own turbulence (small: a murmuration is very nearly all one heading)
        F += NOISE * np.sin(nf[idx] * t * 2 * np.pi + nph[idx]) * np.array([1.0, 0.45, 1.0])
        # lift off the sand for the first seconds of flight; then a soft lift, rising as they near the sand
        # (no floor to bounce off), until the landing: near the landing ground they let themselves down
        since = (t - takeoff[idx])[:, None]
        # (never down: the seventh bake's flock leaves over the trees)
        landing = np.zeros((len(idx), 1), bool)
        # (the floor rises with distance from the audience, so the flock never sits lower than SEEN_ABOVE over the
        # horizon as seen from the eye: a body a few metres over the sea 50 m off reads as down on the water)
        hd_eye = np.hypot(p[:, 0:1], p[:, 2:3])
        floor = np.maximum(PULL_UP, 1.6 + np.tan(np.radians(SEEN_ABOVE)) * hd_eye)
        # a SOFT floor: the lift eases in from FLOOR_SOFT m above it and grows smoothly below, so the flock is steered
        # off the water as one body and no edge forms (a clamp, and a stiff floor, both flattened its underside into a
        # ruled line along the floor — "a super sharp line they never pass below", the 2026-10-29 review)
        near = np.clip((floor + FLOOR_SOFT - p[:, 1:2]) / (2 * FLOOR_SOFT), 0, None)
        near = np.minimum(near * near, 4.0)
        lift = near * 16.0 + np.maximum(0, -v[:, 1:2]) * near * 4.0
        F[:, 1:2] += np.where(since < 1.2, 5.0, 0.0) + np.where(landing, -1.5, lift)
        # the turn: the spin gains from the neighbours' heading and from what pushes the bird sideways, and
        # loses to friction; it turns the heading (the steady turn under a sideways push is F/speed, as flight's)
        torque = np.cross(e, e_nb) * J_ALIGN * (1 - 0.85 * vw) + np.cross(e, F) / sp * ETA
        s = spin[idx] + (torque - ETA * spin[idx]) * DT
        s -= e * (s * e).sum(1, keepdims=True)
        sl = np.linalg.norm(s, axis=1, keepdims=True)
        s *= np.minimum(1, MAX_TURN / np.maximum(sl, 1e-9))
        spin[idx] = s
        e = rotate(e, s * DT)
        # the speed: back toward its own cruise, and what pushes it along its heading
        # (slower in the first wingbeats and coming in to land; in the vortex the inner birds wheel slower)
        sp = sp + ((F * e).sum(1, keepdims=True) * 0.6 + (CRUISE[idx, None] - sp) * 0.8) * DT
        lo = np.where(since < 1.0, 2.0, np.where(landing, 3.0, 7.0 - 3.0 * vw))
        hi = np.where(landing, 7.0, 15.0)
        v = e * np.clip(sp, lo, hi)
        if v_r is not None:
            v_phase += DT / vortex_squeeze(t)
        vel[idx] = v
        pos[idx] = p + v * DT
        # down on the sand: they stay
        low = idx[(pos[idx, 1] < 0.25) & landing[:, 0]]
        landed_at[low] = t
        pos[low, 1] = 0
        vel[low] = 0
        # (never on the ground: a bird drawn at the sand's height would read as landed, and the key's `flying`
        # flag would hide it — the seventh bake's flock stays aloft)
        pos[idx, 1] = np.maximum(pos[idx, 1], 1.2)
    if step % 300 == 0 and len(idx) > 8:
        q = pos[idx]
        nnd = cKDTree(q).query(q, k=2)[0][:, 1]
        ev = vel[idx] / (np.linalg.norm(vel[idx], axis=1, keepdims=True) + 1e-9)
        ext = np.sqrt(np.linalg.eigvalsh(np.cov((q - q.mean(0)).T)))[::-1] * 2
        print(f't {t:5.1f}  flying {len(idx):5d}  nnd {np.median(nnd):.2f} m  polar {np.linalg.norm(ev.mean(0)):.2f}  '
              f'extent {ext.round(1)} m  centre {q.mean(0).round(1)}', flush=True)
keys = np.stack(keys)  # (frames, birds, 3)
print('keys', keys.shape, 'altitude range', keys[..., 1].min(), keys[..., 1].max(), 'landed', np.isfinite(landed_at).sum(), 'of', N)
# float16 RGBA: per key, ⌈N / TEX_W⌉ rows of TEX_W texels, one per bird (xyz, w = 1 while flying, 0 on the sand)
flyingK = (keys[..., 1] > 0.05).astype(np.float32)
rows = ROWS
data = np.zeros((keys.shape[0], rows * TEX_W, 4), np.float32)
data[:, :N] = np.concatenate([keys, flyingK[..., None]], -1)
data = data.astype('<f2')
data.tofile(OUT / f'flock-keys{SUFFIX}.f16')
(OUT / f'flock-keys{SUFFIX}.json').write_text(f'{{"birds": {N}, "keys": {keys.shape[0]}, "hz": {KEY_HZ}, "duration": {DURATION}, "width": {TEX_W}, "rows": {rows}}}')
print(OUT / f'flock-keys{SUFFIX}.f16', data.nbytes / 1e6, 'MB')

# a CPU preview in dome space: equidistant fisheye, zenith at the centre, the front at the bottom
from PIL import Image, ImageDraw  # noqa: E402

eye = np.array([0, 1.6, 0])
S = 360
frames = []
for t in ((2, 9, 14, 16, 20, 26, 32, 36, 40, 45, 55, 74) if SILENCE else (2, 5, 9, 13, 18, 24, 30, 36, 42, 50, 60, 74)):
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
sheet.save(OUT / f'flock-preview{SUFFIX}.png')
