"""
The Drift seen from a seat (drift-narrative/production-design.md, "Later: check it in a virtual dome"): a dome
master clip reprojected into what one audience member sees in a Horizon 18 theatre — from a real seat, looking
toward the front sweet spot, with a slow natural drift of the head. It proves horizon lines, the limb, the
stars and comfort from where people actually sit, not from the dome's centre the master is authored for.

Geometry (studio-world scripts/dome_venue.py, preset horizon18): an 18 m dome tilted 15° toward the front,
180° coverage, front spring line 1.2 m above the floor; unidirectional rows 1 m apart on a 20° rake, the
front row 2.25 m ahead of the dome centre. A seated eye is ~1.2 m above its row's platform.

For each output pixel: the ray from the eye meets the dome shell; the shell point's direction from the dome
centre gives its master pixel (IMERSA: equidistant fisheye, zenith at the centre, front at the bottom,
r = (90° − elevation)/90°). Below the spring line is the dark room.

  out/drift/data/.venv/bin/python -I scripts/drift-seat-view.py in.mp4 out.mp4 [--row 5] [--seat 0]
      [--size 1280x720] [--fov 110] [--pitch 30] [--from 0] [--to <s>] [--eye-level] [--crf 20]

--seat is metres to the right of the centre aisle line (negative: left). --eye-level draws a dotted line at
the viewer's true eye level (0° from this seat), to judge where the content's horizons sit.
"""

import argparse
import json
import math
import subprocess
import sys

import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('src')
ap.add_argument('dst')
ap.add_argument('--row', type=int, default=5)
ap.add_argument('--seat', type=float, default=0.0)
ap.add_argument('--size', default='1280x720')
ap.add_argument('--fov', type=float, default=110.0, help='horizontal field of view, deg')
ap.add_argument('--lens', type=float, default=1.0, help='the lens curve k: r = tan(k·θ)/k — 1 rectilinear (straight lines straight), 0.5 stereographic, toward 0 equidistant fisheye')
ap.add_argument('--pitch', type=float, default=30.0, help='mean head pitch above horizontal, deg')
ap.add_argument('--from', dest='t0', type=float, default=0.0)
ap.add_argument('--to', dest='t1', type=float, default=None)
ap.add_argument('--eye-level', action='store_true')
ap.add_argument('--glances', default='', help='curious looks on top of the drift: "t:yaw:pitch:hold,..." (s, deg, deg, s), eased in and out over 2.5 s')
ap.add_argument('--crf', default='20')
ap.add_argument('--seed', type=int, default=7)
ap.add_argument('--maps', action='store_true', help='with --still: write ffmpeg remap tables (xmap.pgm, ymap.pgm) for the seat into the folder `dst` and stop (header of the maps block)')
ap.add_argument('--still', action='store_true', help='no head movement: a fixed seat view at --pitch (the user, 2026-10-30: the sway was disorienting); the mapping is computed once')
a = ap.parse_args()

# ---------------------------------------------------------------- the theatre (metres; x right of the screen
# as one faces it is −x in Blender's frame, so here: x = viewer's right, y = forward, z = up)
D, TILT, SPRING_FRONT, RAKE, PITCH_ROW, Y0 = 18.0, math.radians(15.0), 1.2, math.radians(20.0), 1.0, -(18.0 / 2) * 0.25
R = D / 2
spring_rear = SPRING_FRONT + D * math.sin(TILT)
C = np.array([0.0, 0.0, (SPRING_FRONT + spring_rear) / 2])  # rim_z = 0 for 180° coverage
# dome axis tilted toward the front; the rim plane's front direction; the viewer's right
AXIS = np.array([0.0, math.sin(TILT), math.cos(TILT)])
FRONT = np.array([0.0, math.cos(TILT), -math.sin(TILT)])
RIGHT = np.cross(FRONT, AXIS)  # (+1, 0, 0) here: front x axis = the viewer's right
# the seat: row a's platform top, a seated eye 1.2 m above it; rows run back from Y0 (Blender −Y is front, so
# the row's forward offset is −Y0 − row)
row_y = -(Y0 + a.row * PITCH_ROW)  # forward of the dome centre (negative: behind it)
eye = np.array([a.seat, row_y - 0.15, a.row * PITCH_ROW * math.tan(RAKE) + 1.2])

W, H = (int(v) for v in a.size.split('x'))
# THE LENS (the client, 2026-10-31: "wider … a little bit more curvature", toward the first version's look): a
# point θ off the view's axis lands at r = tan(k·θ)/k. k = 1 is the rectilinear view (straight lines straight, the
# edges stretched — past ~130° wide very much so); k = 0.5 the stereographic one (gentle curves, shapes kept);
# toward 0 the equidistant fisheye. f scales it so --fov spans the frame's width.
K = min(max(a.lens, 1e-3), 1.0)
f = (W / 2) / (math.tan(K * math.radians(a.fov) / 2) / K)
px, py = np.meshgrid(np.arange(W) + 0.5 - W / 2, np.arange(H) + 0.5 - H / 2)
rho = np.hypot(px, py) / f
theta = np.arctan(K * rho) / K
sin_over = np.where(rho > 0, np.sin(theta) / np.maximum(rho, 1e-9), 1.0)
cam_dirs = np.stack([px / f * sin_over, -py / f * sin_over, np.cos(theta)], -1)  # camera space: x right, y up, z forward
cam_dirs /= np.linalg.norm(cam_dirs, axis=-1, keepdims=True)
cam_dirs = cam_dirs.astype(np.float32)  # (float32 through the per-frame maths: half the work of float64)

# ---------------------------------------------------------------- natural head movement: a few slow, small
# sinusoids per axis (periods 6–19 s), seeded, so a re-run gives the same take
rng = np.random.default_rng(a.seed)
waves = {k: [(amp * rng.uniform(0.6, 1.0), rng.uniform(6, 19), rng.uniform(0, 2 * math.pi)) for amp in amps]
         for k, amps in {'yaw': (5.0, 2.5, 1.0), 'pitch': (2.5, 1.2), 'roll': (0.8,)}.items()}


# and the glances: a viewer looks where something is happening, holds, and drifts back to the front
glances = [tuple(float(v) for v in g.split(':')) for g in a.glances.split(',') if g]
if a.still:  # (no drift and no glances: the seat's view held still)
    waves = {k: [] for k in waves}
    glances = []


def bump(t: float, t0: float, hold: float, ease: float = 2.5) -> float:
    x = min(max((t - t0) / ease, 0), 1) - min(max((t - t0 - ease - hold) / ease, 0), 1)
    return x * x * (3 - 2 * x)


def head(t: float) -> np.ndarray:
    """camera-to-world rotation at t: yaw about up, then pitch, then roll"""
    ang = {k: sum(A * math.sin(2 * math.pi * t / P + ph) for A, P, ph in w) for k, w in waves.items()}
    for t0, gy, gp, hold in glances:
        k = bump(t, t0, hold)
        ang['yaw'] += gy * k
        ang['pitch'] += gp * k
    yaw, pitch, roll = (math.radians(ang['yaw']), math.radians(a.pitch + ang['pitch']), math.radians(ang['roll']))
    fwd = np.array([math.sin(yaw) * math.cos(pitch), math.cos(yaw) * math.cos(pitch), math.sin(pitch)])
    rgt = np.array([math.cos(yaw), -math.sin(yaw), 0.0])
    up = np.cross(rgt, fwd)
    cr, sr = math.cos(roll), math.sin(roll)
    rgt, up = rgt * cr + up * sr, up * cr - rgt * sr
    return np.stack([rgt, up, fwd], 1)


def probe(path: str) -> tuple[int, float, float]:
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,r_frame_rate:format=duration',
                          '-of', 'json', path], capture_output=True, text=True, check=True).stdout
    j = json.loads(out)
    num, den = j['streams'][0]['r_frame_rate'].split('/')
    return j['streams'][0]['width'], float(num) / float(den), float(j['format']['duration'])


S, FPS, DUR = probe(a.src)
t1 = a.t1 if a.t1 is not None else DUR
if a.maps:
    # THE STILL SEAT AS FFMPEG REMAP TABLES (the user, 2026-10-30: the per-frame Python gather of a 4K seat view of
    # the whole show measured ~2–4 h on the Mac — "let's make it proper"). With the head held still the master
    # pixel each output pixel reads is the same every frame, so it is worked out once here and ffmpeg's remap
    # filter (C, nearest tap) does the per-frame work. Nearest is blocky where the seat view magnifies the master
    # (~1.4× at 120° on 3840 wide), so the tables are made at --size × 2 and the result is area-scaled down: four
    # nearest taps averaged per output pixel. Rays below the spring line (the dark room) point outside the master
    # (65535) and take remap's fill colour. Writes xmap.pgm and ymap.pgm (16-bit, P5) into `dst`, a folder.
    import os
    w = cam_dirs @ head(a.t0).T.astype(np.float32)
    oc0 = (eye - C).astype(np.float32)
    b = w @ oc0
    hit = -b + np.sqrt(np.maximum(b * b - (oc0 @ oc0 - R * R), 0))
    d = (eye + w * hit[..., None] - C) / R
    el = np.arcsin(np.clip(d @ AXIS, -1, 1))
    az = np.arctan2(d @ RIGHT, d @ FRONT)
    r = (1 - el / (math.pi / 2)) * 0.5
    x = np.clip(np.rint((0.5 + r * np.sin(az)) * S - 0.5), 0, S - 1)
    y = np.clip(np.rint((0.5 + r * np.cos(az)) * S - 0.5), 0, S - 1)
    x[el < 0] = 65535
    y[el < 0] = 65535
    os.makedirs(a.dst, exist_ok=True)
    for name, m in (('xmap', x), ('ymap', y)):
        with open(os.path.join(a.dst, f'{name}.pgm'), 'wb') as fh:
            fh.write(f'P5\n{W} {H}\n65535\n'.encode())
            fh.write(m.astype('>u2').tobytes())
    print(f'{a.dst}: xmap/ymap {W}×{H} for a {S}² master, row {a.row} seat {a.seat:+.1f} m, pitch {a.pitch}°, fov {a.fov}°, lens {a.lens}', file=sys.stderr)
    sys.exit(0)
dec = subprocess.Popen(['ffmpeg', '-v', 'error', '-ss', str(a.t0), '-t', str(t1 - a.t0), '-i', a.src, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
                       stdout=subprocess.PIPE)
# the source's sound (a cut with the score under it), if it has any, cut to the same span
enc = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
                        '-ss', str(a.t0), '-t', str(t1 - a.t0), '-i', a.src, '-map', '0:v', '-map', '1:a?', '-c:a', 'copy', '-shortest',
                        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', a.crf, '-pix_fmt', 'yuv420p', a.dst], stdin=subprocess.PIPE)
room = np.array([6, 6, 7], np.float32)
n = 0
oc = eye - C
cc = oc @ oc - R * R  # < 0: the eye is inside the dome sphere
# (float32 vectors, or every product with the float32 rays is promoted back to float64)
eye, C, AXIS, FRONT, RIGHT, oc = (v.astype(np.float32) for v in (eye, C, AXIS, FRONT, RIGHT, oc))
while True:
    buf = dec.stdout.read(S * S * 3)
    if len(buf) < S * S * 3:
        break
    # (kept 8-bit: only the gathered taps go to float, not all 4096² of the frame)
    master = np.frombuffer(buf, np.uint8).reshape(S, S, 3)
    t = a.t0 + n / FPS
    # (--still: the head never moves, so the rays, their master pixels and the taps' weights are the same every
    # frame — worked out once, and each frame is only the four gathers)
    if not (a.still and n > 0):
        w = cam_dirs @ head(t).T.astype(np.float32)  # world ray directions
        b = w @ oc
        hit = -b + np.sqrt(np.maximum(b * b - cc, 0))
        d = (eye + w * hit[..., None] - C) / R
        el = np.arcsin(np.clip(d @ AXIS, -1, 1))
        az = np.arctan2(d @ RIGHT, d @ FRONT)
        r = (1 - el / (math.pi / 2)) * 0.5
        # master pixel (row 0 at the top; the front at the bottom)
        x = (0.5 + r * np.sin(az)) * S - 0.5
        y = (0.5 + r * np.cos(az)) * S - 0.5
        x0 = np.clip(np.floor(x).astype(int), 0, S - 2)
        y0 = np.clip(np.floor(y).astype(int), 0, S - 2)
        fx = np.clip(x - x0, 0, 1)[..., None]
        fy = np.clip(y - y0, 0, 1)[..., None]
        i00 = y0 * S + x0
        w00, w01, w10, w11 = ((1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy)
        inside = (el >= 0)[..., None]
    # the four taps by flat index (one take each, cheaper than 2-D fancy indexing)
    flat = master.reshape(-1, 3)
    img = (flat.take(i00, 0).astype(np.float32) * w00 + flat.take(i00 + 1, 0) * w01
           + flat.take(i00 + S, 0) * w10 + flat.take(i00 + S + 1, 0) * w11)
    img = np.where(inside, img, room)
    if a.eye_level:
        # the viewer's own horizontal: rays at 0° elevation from this seat, dotted every few degrees
        level = (np.abs(w[..., 2]) < 0.0025) & ((np.degrees(np.arctan2(w[..., 0], w[..., 1])) % 4) < 2)
        img[level] = (255, 80, 60)
    enc.stdin.write(np.clip(img, 0, 255).astype(np.uint8).tobytes())
    n += 1
enc.stdin.close()
enc.wait()
dec.wait()
print(f'{a.dst}: {n} frames, row {a.row} seat {a.seat:+.1f} m, eye {eye.round(2).tolist()} (dome centre {C.round(2).tolist()})', file=sys.stderr)
