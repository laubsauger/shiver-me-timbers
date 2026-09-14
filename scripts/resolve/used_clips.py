#!/usr/bin/env python3
"""
Which rendered clips an edit actually uses — so a full-res record can render only those.

    python3 scripts/resolve/used_clips.py <render out dir> --out used_clips.json \
        [--main "★ sb-trailer-v2 — MAIN (Reef Runner EX)"] [--alt "ZZ alt — temp music (Dead Channel)" --alt ...]
        [--blends scripts/resolve/sb-trailer-v2.blends.json]

For every picture item on the video tracks of the timelines (titles/generators ignored): the clip base name (take
stripped, the name the recorder renders under), the take, the used source frame range [in, out) and the clip's full
length (the record renders whole clips, handles included). A pre-composited blend clip (<plan>_blend-<name>_takeNN) is
expanded into its source layers from the blends spec, same frame range. `alternate_only` lists what only the
--alt timelines use. Total available = the plan template's coverage entries (every planned clip, all times of day).
"""
import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from resolve_common import PROJECT, connect, fail, find_timeline, log  # noqa: E402

TAG = "used_clips"
HERE = os.path.dirname(os.path.abspath(__file__))


def scan(tl, blends):
    used = {}
    for i in range(1, tl.GetTrackCount("video") + 1):
        for x in tl.GetItemListInTrack("video", i) or []:
            mpi = x.GetMediaPoolItem()
            if not mpi or not (mpi.GetClipProperty("File Path") or "").endswith(".mov"):
                continue
            name = os.path.splitext(mpi.GetName())[0]
            m = re.match(r"(.+)_take(\d+)$", name)
            base, take = (m.group(1), int(m.group(2))) if m else (name, 0)
            a = int(x.GetSourceStartFrame())
            b = a + int(x.GetDuration())
            total = int(mpi.GetClipProperty("Frames") or 0)
            bm = re.match(r".+?_blend-(.+)$", base)
            sources = [base]
            if bm and bm.group(1) in blends:
                sources = [l["clip"] for l in blends[bm.group(1)]["layers"]]
            for src in sources:
                e = used.setdefault(src, {"clip": src, "takes": set(), "ranges": [], "frames": total,
                                          "viaBlend": set()})
                e["takes"].add(take)
                e["ranges"].append([a, b])
                if bm:
                    e["viaBlend"].add(base)
    return used


def merge(ranges):
    out = []
    for a, b in sorted(ranges):
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root")
    ap.add_argument("--out", required=True)
    ap.add_argument("--project", default=PROJECT)
    ap.add_argument("--main", default="★ sb-trailer-v2 — MAIN (Reef Runner EX)")
    ap.add_argument("--alt", action="append", default=[])
    ap.add_argument("--blends", default=os.path.join(HERE, "sb-trailer-v2.blends.json"))
    ap.add_argument("--fps", type=float, default=30.0)
    a = ap.parse_args()

    with open(a.blends, encoding="utf-8") as f:
        blends = {b["name"]: b for b in json.load(f)["blends"]}
    resolve, pm, project = connect(a.project, TAG)
    main_tl = find_timeline(project, a.main) or fail(TAG, f"no timeline '{a.main}'")
    used = scan(main_tl, blends)
    alt = {}
    for name in a.alt:
        tl = find_timeline(project, name) or fail(TAG, f"no timeline '{name}'")
        for k, v in scan(tl, blends).items():
            if k not in used:
                alt.setdefault(k, v)["ranges"] += [] if alt[k] is v else v["ranges"]

    def rows(d):
        out = []
        for k in sorted(d):
            v = d[k]
            out.append({"clip": v["clip"], "takesInEdit": sorted(v["takes"]), "usedFrames": merge(v["ranges"]),
                        "clipFrames": v["frames"], "viaBlend": sorted(v["viaBlend"])})
        return out

    template = os.path.join(a.root, "plan.template.json")
    total = None
    if os.path.exists(template):
        with open(template, encoding="utf-8") as f:
            t = json.load(f)
        total = len(t.get("coverage") or [])
    used_rows, alt_rows = rows(used), rows(alt)
    used_s = sum(sum(b - a for a, b in r["usedFrames"]) for r in used_rows) / a.fps
    clip_s = sum(r["clipFrames"] for r in used_rows) / a.fps
    doc = {"timeline": a.main, "alternates": a.alt, "fps": a.fps,
           "summary": {"usedClips": len(used_rows), "availableClips": total, "usedSourceSeconds": round(used_s, 1),
                       "renderSecondsWholeClips": round(clip_s, 1), "alternateOnlyClips": len(alt_rows)},
           "used": used_rows, "alternate_only": alt_rows}
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=1, ensure_ascii=False)
    log(TAG, f"{len(used_rows)} used clips / {total} planned; {used_s:.1f} s of used source, {clip_s:.1f} s as whole "
             f"clips with handles; {len(alt_rows)} alternate-only → {a.out}")


if __name__ == "__main__":
    main()
