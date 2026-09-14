#!/usr/bin/env python3
"""
Build a DaVinci Resolve timeline from a cine edit plan (docs/cine/trailer-edit-plan.md).

Usage (Resolve Studio running, Preferences → General → External scripting using: Local):

    python3 scripts/resolve/trailer_import.py out/cine/sb-trailer-v1/edit-plan.json \
        [--project "Shiver - Speedboat Trailer - MCP"] [--proxy] [--replace]

--proxy    link the proxy files (plan.shots[].proxy) to the imported masters
--replace  delete an existing timeline with the plan's name first (otherwise a suffix is added)
"""
import argparse
import json
import os
import sys

API = "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting"
LIB = "/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so"
os.environ.setdefault("RESOLVE_SCRIPT_API", API)
os.environ.setdefault("RESOLVE_SCRIPT_LIB", LIB)
sys.path.append(os.path.join(os.environ["RESOLVE_SCRIPT_API"], "Modules"))

import DaVinciResolveScript as dvr  # noqa: E402


def fail(msg):
    print(f"[trailer_import] ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("plan")
    ap.add_argument("--project", default="Shiver - Speedboat Trailer - MCP")
    ap.add_argument("--proxy", action="store_true")
    ap.add_argument("--replace", action="store_true")
    a = ap.parse_args()

    plan_path = os.path.abspath(a.plan)
    base = os.path.dirname(plan_path)
    with open(plan_path) as f:
        plan = json.load(f)
    fps = float(plan["fps"])

    resolve = dvr.scriptapp("Resolve")
    if not resolve:
        fail("Resolve not reachable (running? external scripting Local?)")
    pm = resolve.GetProjectManager()
    project = pm.LoadProject(a.project) or fail(f"project not found: {a.project}")

    # the timeline format must be set before the first timeline exists in a fresh project
    fps_s = str(int(fps)) if fps.is_integer() else str(fps)
    for k, v in (("timelineFrameRate", fps_s), ("timelineResolutionWidth", str(plan["width"])),
                 ("timelineResolutionHeight", str(plan["height"]))):
        if project.GetSetting(k) != v and not project.SetSetting(k, v):
            print(f"[trailer_import] warning: could not set {k}={v} (timelines already exist?)")

    pool = project.GetMediaPool()
    root = pool.GetRootFolder()
    folder = next((s for s in root.GetSubFolderList() if s.GetName() == plan["name"]), None) \
        or pool.AddSubFolder(root, plan["name"])
    pool.SetCurrentFolder(folder)

    def import_one(rel):
        path = os.path.join(base, rel)
        if not os.path.exists(path):
            fail(f"missing file: {path}")
        items = pool.ImportMedia([path])
        if not items:
            fail(f"Resolve refused to import: {path}")
        return items[0]

    # timeline
    existing = [project.GetTimelineByIndex(i + 1) for i in range(project.GetTimelineCount())]
    name = plan["name"]
    clash = next((t for t in existing if t.GetName() == name), None)
    if clash:
        if a.replace:
            pool.DeleteTimelines([clash])
        else:
            name = f"{name} ({len(existing) + 1})"
    tl = pool.CreateEmptyTimeline(name) or fail("could not create timeline")
    project.SetCurrentTimeline(tl)
    while tl.GetTrackCount("audio") < 3:
        tl.AddTrack("audio", "stereo")
    tl.SetTrackName("audio", 1, "SFX stems")
    tl.SetTrackName("audio", 2, "SFX extra")
    tl.SetTrackName("audio", 3, "Music (user)")
    start = int(tl.GetStartFrame())

    placed = []
    for shot in sorted(plan["shots"], key=lambda s: s["recordInS"]):
        dur = shot["recordOutS"] - shot["recordInS"]
        src_in = round(shot.get("handleS", 0.0) * fps)
        src_out = src_in + round(dur * fps) - 1
        rec = start + round(shot["recordInS"] * fps)
        video = import_one(shot["video"])
        if a.proxy and shot.get("proxy"):
            video.LinkProxyMedia(os.path.join(base, shot["proxy"]))
        clips = [{"mediaPoolItem": video, "startFrame": src_in, "endFrame": src_out,
                  "recordFrame": rec, "trackIndex": 1, "mediaType": 1}]
        if shot.get("sfx"):
            clips.append({"mediaPoolItem": import_one(shot["sfx"]), "startFrame": src_in, "endFrame": src_out,
                          "recordFrame": rec, "trackIndex": 1, "mediaType": 2})
        if not pool.AppendToTimeline(clips):
            fail(f"AppendToTimeline failed for shot {shot['id']}")
        placed.append(shot["id"])

    for m in plan.get("markers", []):
        tl.AddMarker(round(m["atS"] * fps), m.get("color", "Blue"), m["name"], m.get("note", ""), 1)
    for s in plan.get("slots", []):
        if "recordInS" in s:
            d = max(1, round((s["recordOutS"] - s["recordInS"]) * fps))
            tl.AddMarker(round(s["recordInS"] * fps), "Yellow", s["name"], f"slot: {s['kind']}", d)

    print(f"[trailer_import] timeline '{name}' @ {fps_s} fps {plan['width']}x{plan['height']}: "
          f"{len(placed)} shots ({', '.join(placed)}), {len(plan.get('markers', []))} markers")


if __name__ == "__main__":
    main()
