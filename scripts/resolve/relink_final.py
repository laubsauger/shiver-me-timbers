#!/usr/bin/env python3
"""
Swap the stand-in media under the trailer edit for the final renders, clip by clip, in place.

    python3 scripts/resolve/relink_final.py <final_dir> [--bin sb-trailer-v2] [--only <name substring>] [--dry-run]
                                            [--force] [--settle 60] [--blends-out <dir> --python .venv/bin/python]

The look-pass renders (640×360) and the final renders (1920×1080) carry the SAME clip names, frame counts and handles,
so every media pool item under --bin whose file name exists in <final_dir> (searched recursively; .mov prefers video/,
.wav prefers sfx/) is relinked to it with MediaPool.RelinkClips([item], <that file's folder>). Timelines, cuts, grades, Fusion comps and markers stay:
they refer to the pool item, not to the file.

Checks before a replace (a mismatch is listed and NOT replaced unless --force):
- the final file is complete (not _FAILED/.part, unmodified for --settle s, ffprobe reads it);
- video: same frame count and frame rate as the item; audio: same duration (±1 ms) and sample rate.
After the relink the new file path and the unchanged Start TC are verified (the importer gives clips 01:00:00:00;
ReplaceClip would reset that and unlink every timeline item cut from the clip — see the note in main()).
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from resolve_common import PROJECT, connect, log, probe, ready  # noqa: E402

TAG = "relink_final"


def walk(folder):
    for c in folder.GetClipList() or []:
        yield c
    for s in folder.GetSubFolderList() or []:
        yield from walk(s)


def index_dir(root):
    found = {}
    for d, _, files in os.walk(root):
        for f in files:
            found.setdefault(f, []).append(os.path.join(d, f))
    return found


def pick(paths, name):
    want = "video" if name.endswith(".mov") else "sfx" if name.endswith(".wav") else ""
    paths = sorted(paths, key=lambda p: (os.path.basename(os.path.dirname(p)) != want, p))
    return paths[0]


def fraction(s):
    if not s or s in ("0/0",):
        return None
    n, _, d = s.partition("/")
    return float(n) / float(d or 1)


def compare(item, path):
    """list of mismatch strings (empty = compatible)"""
    info = probe(path)
    if info is None:
        return ["ffprobe cannot read the final file"]
    out = []
    if info.get("codec_type") == "video":
        frames_have = int(item.GetClipProperty("Frames") or 0)
        frames_new = int(info.get("nb_frames") or 0)
        fps_have = float(item.GetClipProperty("FPS") or 0)
        fps_new = fraction(info.get("r_frame_rate")) or 0
        if frames_have != frames_new:
            out.append(f"frames {frames_have} → {frames_new}")
        if abs(fps_have - fps_new) > 1e-3:
            out.append(f"fps {fps_have} → {fps_new:.3f}")
        out.append(f"(res {item.GetClipProperty('Resolution')} → {info.get('width')}x{info.get('height')})")
    else:
        dur_new = float(info.get("duration") or 0)
        sr_have = item.GetClipProperty("Sample Rate")
        dur_have = old_duration(item)
        if dur_have is not None and abs(dur_have - dur_new) > 1e-3:
            out.append(f"duration {dur_have:.3f} s → {dur_new:.3f} s")
        if sr_have and info.get("sample_rate") and str(sr_have) != str(info["sample_rate"]):
            out.append(f"sample rate {sr_have} → {info['sample_rate']}")
    return out


def old_duration(item):
    p = item.GetClipProperty("File Path")
    info = probe(p) if p and os.path.exists(p) else None
    return float(info["duration"]) if info and info.get("duration") else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("final_dir")
    ap.add_argument("--project", default=PROJECT)
    ap.add_argument("--bin", default="sb-trailer-v2", help="media pool folder (recursive) whose clips are relinked")
    ap.add_argument("--only", help="relink only clips whose name contains this")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true", help="replace despite frame/fps/duration mismatches")
    ap.add_argument("--settle", type=float, default=60.0)
    ap.add_argument("--blends-out", help="after relinking, re-render the ToD blends (tod_blend.py) from <final_dir> into "
                                         "this dir: same clip names, relinked in place")
    ap.add_argument("--python", default=sys.executable, help="a python with numpy for tod_blend.py (the venv)")
    a = ap.parse_args()

    final = index_dir(os.path.abspath(a.final_dir))
    resolve, pm, project = connect(a.project, TAG)
    pool = project.GetMediaPool()
    folder = next((f for f in pool.GetRootFolder().GetSubFolderList() if f.GetName() == a.bin), None)
    if not folder:
        log(TAG, f"ERROR: no media pool folder '{a.bin}'")
        sys.exit(1)

    replaced, same, missing, mismatched, not_ready, failed = [], [], [], [], [], []
    for item in walk(folder):
        path = item.GetClipProperty("File Path")
        name = os.path.basename(path or "")
        if not path or (a.only and a.only not in name):
            continue
        if name not in final:
            missing.append(name)
            continue
        new = pick(final[name], name)
        if os.path.realpath(new) == os.path.realpath(path) and not a.force:
            same.append(name)
            continue
        if not ready(new, a.settle):
            not_ready.append(name)
            continue
        problems = compare(item, new)
        hard = [p for p in problems if not p.startswith("(")]
        if hard and not a.force:
            mismatched.append(f"{name}: {', '.join(problems)}")
            continue
        if a.dry_run:
            replaced.append(f"{name} {' '.join(problems)} (dry run)")
            continue
        tc = item.GetClipProperty("Start TC")
        # RelinkClips (by folder, same file name) keeps the pool item's Start TC and every timeline item's link.
        # NOT ReplaceClip / ReplaceClipPreserveSubClip: on Resolve 21.0.0.47 both reset Start TC to the file's, which
        # unlinks (ReplaceClip) or slides (PreserveSubClip) every timeline item cut from the clip. Checked live.
        if not pool.RelinkClips([item], os.path.dirname(new)):
            failed.append(f"{name}: RelinkClips refused")
            continue
        now = item.GetClipProperty("File Path")
        if os.path.realpath(now) != os.path.realpath(new) or item.GetClipProperty("Start TC") != tc:
            failed.append(f"{name}: after replace path={now} Start TC={item.GetClipProperty('Start TC')} (want {tc})")
            continue
        replaced.append(f"{name} {' '.join(problems)}".strip())

    if replaced and not a.dry_run:
        pm.SaveProject()
    log(TAG, f"{len(replaced)} replaced{' (dry run)' if a.dry_run else ''}, {len(same)} already there, "
             f"{len(missing)} not in {a.final_dir}, {len(not_ready)} not ready, {len(mismatched)} mismatched, "
             f"{len(failed)} failed")
    for title, rows in (("replaced", replaced), ("MISMATCH (not replaced; --force to override)", mismatched),
                        ("NOT READY", not_ready), ("FAILED", failed), ("not in final dir", missing)):
        for r in rows:
            log(TAG, f"  {title}: {r}")
    if a.blends_out and not a.dry_run:
        import subprocess
        rc = subprocess.run([a.python, os.path.join(os.path.dirname(os.path.abspath(__file__)), "tod_blend.py"),
                             os.path.abspath(a.final_dir), "--out", a.blends_out, "--force"]).returncode
        if rc:
            log(TAG, f"ERROR: tod_blend.py failed ({rc})")
            failed.append("blends")
    sys.exit(1 if failed or mismatched else 0)


if __name__ == "__main__":
    main()
