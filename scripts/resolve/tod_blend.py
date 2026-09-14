#!/usr/bin/env python3
"""
Pre-composited time-of-day blends: frame-identical ToD takes of one shot mixed into ONE clip with smooth S-curve
crossfades, so the edit never depends on transitions/opacity in the Edit page (06c day→night, the setup-10 time-lapse).

    .venv/bin/python scripts/resolve/tod_blend.py <render out dir> [--spec scripts/resolve/sb-trailer-v2.blends.json]
        [--out <dir>] [--only 06c] [--no-resolve] [--force]

(numpy is needed: the venv from music_beats.py.)

Spec (JSON): {"plan": "sb-trailer-v2", "blends": [{"name": "06c-R5", "layers": [{"clip": "<base, no take>"}, ...],
"stops": [{"centerS": 2.35, "durS": 1.0}, ...]}]} — stop k fades layer k+1 in over layer k (source seconds from the
clip's first frame; a smoothstep from centerS − durS/2 to centerS + durS/2). A layer with "optional": true (e.g. noon,
golden) is used only when rendered; its stop is dropped with it.

- Takes: the HIGHEST take number that exists and is complete for every required layer is used for all of them (the
  looks of one take are frame-identical; two takes are not). Output: <plan>_blend-<name>_take<NN>.mov — a new take of
  the sources gives a new blend clip name, so trailer_edit.py's newest-take resolution picks it up.
- Frame-exact: every layer is decoded in full (same frame index = same simulated instant) and mixed per frame in
  approximately linear light (BT.709 decode → ^2.4 → mix → ^1/2.4), encoded ProRes 422 HQ 10-bit at the source size,
  frame count and rate. Skipped when the output exists and is newer than all its inputs (--force re-renders).
- Verification: <out>/<clip>_strip.png, 9 frames stepping across each stop, and the largest frame-to-frame change inside
  a blend vs the largest outside it, printed per clip (a pop shows as a ratio well above 1).
- Resolve (unless --no-resolve): the blend clips go into <plan>/Blends in the pool (idempotent). relink_final.py <final
  dir> --blends re-runs this on the final renders.
"""
import argparse
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from resolve_common import PROJECT, PoolIndex, connect, log, probe, ready, sub_folder  # noqa: E402

TAG = "tod_blend"
GAMMA = 2.4


def find_video(root, base, take):
    p = os.path.join(root, "video", f"{base}_take{take:02d}.mov")
    return p if ready(p) else None


def takes_of(root, base):
    rx = re.compile(re.escape(base) + r"_take(\d+)\.mov$")
    d = os.path.join(root, "video")
    return {int(m.group(1)) for f in os.listdir(d) if (m := rx.match(f))}


def choose(root, blend):
    required = [l for l in blend["layers"] if not l.get("optional")]
    common = None
    for l in required:
        t = takes_of(root, l["clip"])
        common = t if common is None else common & t
    for take in sorted(common or [], reverse=True):
        if not all(find_video(root, l["clip"], take) for l in required):
            continue
        layers, stops = [], []
        for i, l in enumerate(blend["layers"]):
            path = find_video(root, l["clip"], take)
            if not path:
                continue  # an optional layer not rendered: its stop goes with it
            if layers:
                stops.append(blend["stops"][i - 1])
            layers.append(path)
        return take, layers, stops
    return None, [], []


def smooth(x):
    x = min(1.0, max(0.0, x))
    return x * x * (3 - 2 * x)


def render(layers, stops, out, np):
    info = probe(layers[0])
    w, h = int(info["width"]), int(info["height"])
    num, _, den = info["r_frame_rate"].partition("/")
    fps = float(num) / float(den or 1)
    n = int(info["nb_frames"])
    for p in layers[1:]:
        o = probe(p)
        if (int(o["width"]), int(o["height"]), int(o["nb_frames"]), o["r_frame_rate"]) != (w, h, n, info["r_frame_rate"]):
            raise SystemExit(f"[{TAG}] ERROR: {p} does not match {layers[0]} (size/frames/rate)")
    dec = [subprocess.Popen(["ffmpeg", "-v", "error", "-i", p, "-vf",
                             "scale=in_color_matrix=bt709:out_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb48le",
                             "-f", "rawvideo", "-"], stdout=subprocess.PIPE) for p in layers]
    tmp = out + ".part.mov"
    enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb48le", "-s", f"{w}x{h}",
                            "-r", info["r_frame_rate"], "-i", "-", "-vf",
                            "scale=in_color_matrix=bt709:out_color_matrix=bt709:in_range=pc:out_range=tv,format=yuv422p10le",
                            "-c:v", "prores_ks", "-profile:v", "3", "-color_primaries", "bt709", "-color_trc", "bt709",
                            "-colorspace", "bt709", tmp], stdin=subprocess.PIPE)
    size = w * h * 3 * 2
    prev, jumps_in, jumps_out = None, [], []
    windows = [(s["centerS"] - s["durS"] / 2, s["centerS"] + s["durS"] / 2) for s in stops]
    strip_frames = {}
    strip_idx = set()
    for c in (s["centerS"] for s in stops):
        strip_idx |= {int(round(c * fps)) + k for k in range(-8, 9, 2)}
    for i in range(n):
        t = i / fps
        frames = []
        for d in dec:
            buf = d.stdout.read(size)
            if len(buf) != size:
                raise SystemExit(f"[{TAG}] ERROR: short read at frame {i}")
            frames.append((np.frombuffer(buf, dtype="<u2").reshape(h, w, 3).astype(np.float32) / 65535.0) ** GAMMA)
        mix = frames[0]
        for k, s in enumerate(stops):
            a = smooth((t - windows[k][0]) / max(1e-6, s["durS"]))
            if a > 0:
                mix = mix * (1 - a) + frames[k + 1] * a
        out8 = np.clip(mix, 0, 1) ** (1 / GAMMA)
        enc.stdin.write((out8 * 65535.0 + 0.5).astype("<u2").tobytes())
        if prev is not None:
            jump = float(np.abs(out8 - prev).mean())
            (jumps_in if any(a0 <= t <= a1 for a0, a1 in windows) else jumps_out).append(jump)
        prev = out8
        if i in strip_idx:
            strip_frames[i] = (out8[:: max(1, h // 144), :: max(1, w // 256)] * 255).astype(np.uint8)
    enc.stdin.close()
    if enc.wait() != 0 or any(d.wait() != 0 for d in dec):
        raise SystemExit(f"[{TAG}] ERROR: ffmpeg failed for {out}")
    os.replace(tmp, out)
    if strip_frames:
        rows = [np.concatenate([strip_frames[k] for k in sorted(strip_frames)[j:j + 9]], axis=1)
                for j in range(0, len(strip_frames), 9)]
        widest = max(r.shape[1] for r in rows)
        rows = [np.pad(r, ((0, 0), (0, widest - r.shape[1]), (0, 0))) for r in rows]
        strip = np.concatenate(rows, axis=0)
        sp = subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s",
                             f"{strip.shape[1]}x{strip.shape[0]}", "-i", "-", os.path.splitext(out)[0] + "_strip.png"],
                            input=strip.tobytes())
        if sp.returncode:
            log(TAG, "warning: strip PNG not written")
    return max(jumps_in or [0.0]), max(jumps_out or [1e-9]), n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root", help="render out dir (video/ inside)")
    ap.add_argument("--spec", default=os.path.join(HERE, "sb-trailer-v2.blends.json"))
    ap.add_argument("--out", help="where blend clips go (default: <root>/../../edit/blends is NOT assumed; required)")
    ap.add_argument("--only")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--no-resolve", action="store_true")
    ap.add_argument("--project", default=PROJECT)
    a = ap.parse_args()
    if not a.out:
        ap.error("--out is required (keep blends out of the render agent's directory)")
    import numpy as np

    with open(a.spec, encoding="utf-8") as f:
        spec = json.load(f)
    os.makedirs(a.out, exist_ok=True)
    made = []
    for blend in spec["blends"]:
        if a.only and a.only not in blend["name"]:
            continue
        take, layers, stops = choose(a.root, blend)
        if not take:
            log(TAG, f"{blend['name']}: no take with every required layer rendered yet, skipped")
            continue
        out = os.path.join(a.out, f"{spec['plan']}_blend-{blend['name']}_take{take:02d}.mov")
        fresh = os.path.exists(out) and all(os.path.getmtime(out) > os.path.getmtime(p) for p in layers)
        if fresh and not a.force:
            log(TAG, f"{os.path.basename(out)}: up to date")
            made.append(out)
            continue
        jin, jout, n = render(layers, stops, out, np)
        log(TAG, f"{os.path.basename(out)}: {n} frames, {len(layers)} layers "
                 f"({', '.join(re.sub(r'.*_(\\w+)_take.*', r'\\1', os.path.basename(p)) for p in layers)}), "
                 f"stops {[(s['centerS'], s['durS']) for s in stops]}; max frame change in blends {jin:.4f} vs "
                 f"outside {jout:.4f} (ratio {jin / jout:.2f})")
        made.append(out)
    if a.no_resolve or not made:
        return
    resolve, pm, project = connect(a.project, TAG)
    pool = project.GetMediaPool()
    ix = PoolIndex(pool)
    folder = sub_folder(pool, sub_folder(pool, pool.GetRootFolder(), spec["plan"]), "Blends")
    new = sum(ix.import_into(folder, p, TAG)[1] for p in made)
    for p in made:  # a clip re-rendered in place: point Resolve at the new file
        item = ix.get(p)
        if item and not new:
            pool.RelinkClips([item], os.path.dirname(p))
    pm.SaveProject()
    log(TAG, f"pool: {new} new blend clip(s) in {spec['plan']}/Blends")


if __name__ == "__main__":
    main()
