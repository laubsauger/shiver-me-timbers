#!/usr/bin/env python3
"""
Build a DaVinci Resolve timeline from a cine edit plan (docs/cine/trailer-edit-plan.md).

Usage (Resolve Studio running, Preferences → General → External scripting using: Local):

    python3 scripts/resolve/trailer_import.py out/cine/sb-trailer-v1/edit-plan.json \
        [--project "Shiver - Speedboat Trailer - MCP"] [--proxy] [--replace]

--proxy    link the proxy files (plan.shots[].proxy) to the imported masters
--replace  delete an existing timeline with the plan's name first (otherwise a suffix is added)

Slots: an `intro` slot with a negative recordInS shifts the assembly (shots, markers, slots) right by its length; an
`end` slot past `durationS` extends the timeline. Both become cream range markers.

Time-of-day alternates (plan.shots[].alternates, optional): the same take at other times of day. Each variant name
gets its own video track above V1 ("ToD: night", "ToD: dusk", in first-seen order), the alternate is placed at the
primary's record position with the same handles, the track is disabled (V1 stays the picture; blade and enable to cut a
flicker), and the clips also go into a "ToD variants" bin. A plan without alternates adds no tracks and no bin.

Split SFX stems (plan.shots[].sfxStems, optional): A1 carries the SFX MIX (`sfx`); each stem the plan names gets its own
stereo track from A4 on ("SFX engine", "SFX water", "SFX amb"), laid at the same record position and source range as the
mix and MUTED, so a stem is there to push against the music without doubling the mix. No stems, no extra tracks.

Coverage (plan.coverage, optional): every lens of every setup (docs/cine/trailer-edit-plan.md §Coverage). After the
assembly timeline, each setup gets a bin `<plan name>/Coverage/<setup>_<setupName>/` (sub-bins per time of day when the
setup has more than one), every clip imported there with its Start TC set from the setup clock (01:00:00:00 + the clip's
sourceStartS relative to the setup's earliest clip, so every camera of a setup shares one TC) and its camera / kind /
tier / time in the clip comments; then ONE timeline per setup, "<plan name> — cov <setup> <setupName>", with each
camera × time on its own video track ("<camera> · <time>") at the same record frame, only the main lens of the primary
time enabled, and the setup's SFX stem on A1. Resolve's scripting API cannot create multicam clips: these stacked-track
timelines are the substitute — or select a setup's bin clips and "Create Multicam Clip Using Selected Clips" by Start TC.

--no-coverage   skip the coverage bins and timelines
--tier A|B|C    coverage clips up to this tier (A ⊂ B ⊂ C; default C = all)
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
    ap.add_argument("--no-coverage", action="store_true")
    ap.add_argument("--tier", choices=["A", "B", "C"], default="C")
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
    tl.SetTrackName("audio", 1, "SFX mix")
    tl.SetTrackName("audio", 2, "SFX extra")
    tl.SetTrackName("audio", 3, "Music (user)")
    start = int(tl.GetStartFrame())
    # an INTRO slot before 0 s (a fade from black before the first shot) shifts the whole assembly right by its length,
    # so the plan's record seconds stay the trailer's own clock; the end slot simply extends past 60 s
    lead = max([0.0] + [-s["recordInS"] for s in plan.get("slots", []) if "recordInS" in s])

    # time-of-day alternates: one disabled video track per variant, above V1, in first-seen order
    variants = []
    for shot in plan["shots"]:
        for alt in shot.get("alternates", []):
            if alt["variant"] not in variants:
                variants.append(alt["variant"])
    alt_track = {}
    tod_bin = None
    if variants:
        tod_bin = next((s for s in folder.GetSubFolderList() if s.GetName() == "ToD variants"), None) \
            or pool.AddSubFolder(folder, "ToD variants")
        for v in variants:
            tl.AddTrack("video")
            idx = tl.GetTrackCount("video")
            tl.SetTrackName("video", idx, f"ToD: {v}")
            alt_track[v] = idx

    # split stems: one muted stereo track per stem name, A4 on, in a fixed order
    stem_order = [k for k in ("engine", "water", "amb") if any(k in (sh.get("sfxStems") or {}) for sh in plan["shots"])]
    stem_track = {}
    for k in stem_order:
        tl.AddTrack("audio", "stereo")
        idx = tl.GetTrackCount("audio")
        tl.SetTrackName("audio", idx, f"SFX {k}")
        stem_track[k] = idx

    placed = []
    alternates = 0
    stems = 0
    for shot in sorted(plan["shots"], key=lambda s: s["recordInS"]):
        dur = shot["recordOutS"] - shot["recordInS"]
        src_in = round(shot.get("handleS", 0.0) * fps)
        src_out = src_in + round(dur * fps) - 1
        rec = start + round((shot["recordInS"] + lead) * fps)
        video = import_one(shot["video"])
        if a.proxy and shot.get("proxy"):
            video.LinkProxyMedia(os.path.join(base, shot["proxy"]))
        clips = [{"mediaPoolItem": video, "startFrame": src_in, "endFrame": src_out,
                  "recordFrame": rec, "trackIndex": 1, "mediaType": 1}]
        if shot.get("sfx"):
            clips.append({"mediaPoolItem": import_one(shot["sfx"]), "startFrame": src_in, "endFrame": src_out,
                          "recordFrame": rec, "trackIndex": 1, "mediaType": 2})
        for k, rel in (shot.get("sfxStems") or {}).items():
            clips.append({"mediaPoolItem": import_one(rel), "startFrame": src_in, "endFrame": src_out,
                          "recordFrame": rec, "trackIndex": stem_track[k], "mediaType": 2})
            stems += 1
        if not pool.AppendToTimeline(clips):
            fail(f"AppendToTimeline failed for shot {shot['id']}")
        placed.append(shot["id"])
        if shot.get("alternates"):
            pool.SetCurrentFolder(tod_bin)
            for alt in shot["alternates"]:
                item = import_one(alt["video"])
                if a.proxy and alt.get("proxy"):
                    item.LinkProxyMedia(os.path.join(base, alt["proxy"]))
                if not pool.AppendToTimeline([{"mediaPoolItem": item, "startFrame": src_in, "endFrame": src_out,
                                               "recordFrame": rec, "trackIndex": alt_track[alt["variant"]],
                                               "mediaType": 1}]):
                    fail(f"AppendToTimeline failed for shot {shot['id']} alternate {alt['variant']}")
                alternates += 1
            pool.SetCurrentFolder(folder)

    # the stems are there to push against the music, not to double the mix: muted until the editor wants one
    for idx in stem_track.values():
        if hasattr(tl, "SetTrackMute"):
            tl.SetTrackMute("audio", idx, True)
        else:
            print(f"[trailer_import] warning: this Resolve has no SetTrackMute; mute audio track {idx} by hand")

    # the alternates are there to blade into, not to be seen: V1 stays the picture
    for idx in alt_track.values():
        if hasattr(tl, "SetTrackEnable"):
            tl.SetTrackEnable("video", idx, False)
        else:
            print(f"[trailer_import] warning: this Resolve has no SetTrackEnable; disable video track {idx} by hand")

    for m in plan.get("markers", []):
        tl.AddMarker(round((m["atS"] + lead) * fps), m.get("color", "Blue"), m["name"], m.get("note", ""), 1)
    for s in plan.get("slots", []):
        if "recordInS" in s:
            d = max(1, round((s["recordOutS"] - s["recordInS"]) * fps))
            color = {"intro": "Cream", "end": "Cream"}.get(s["kind"], "Yellow")
            tl.AddMarker(round((s["recordInS"] + lead) * fps), color, s["name"], f"slot: {s['kind']}", d)

    print(f"[trailer_import] timeline '{name}' @ {fps_s} fps {plan['width']}x{plan['height']}: "
          f"{len(placed)} shots ({', '.join(placed)}), {len(plan.get('markers', []))} markers, "
          f"{alternates} time-of-day alternates on {len(alt_track)} track(s), "
          f"{stems} split SFX stems on {len(stem_track)} muted track(s)")

    if not a.no_coverage and plan.get("coverage"):
        import_coverage(project, pool, folder, plan, base, fps, a, existing_names={t.GetName() for t in existing})


TIERS = ["A", "B", "C"]


def frames_to_tc(frames, fps):
    """non-drop-frame HH:MM:SS:FF at an integer-rounded rate (the trailer renders 30 or 60)"""
    r = int(round(fps))
    ff = frames % r
    s = frames // r
    return f"{s // 3600:02d}:{(s // 60) % 60:02d}:{s % 60:02d}:{ff:02d}"


def sub_folder(pool, parent, name):
    return next((s for s in parent.GetSubFolderList() if s.GetName() == name), None) or pool.AddSubFolder(parent, name)


def import_coverage(project, pool, folder, plan, base, fps, a, existing_names):
    max_tier = TIERS.index(a.tier)
    cov = [c for c in plan["coverage"] if TIERS.index(c.get("tier", "C")) <= max_tier]
    if not cov:
        print(f"[trailer_import] coverage: nothing at tier <= {a.tier}")
        return
    cov_root = sub_folder(pool, folder, "Coverage")
    setups = []
    for c in cov:
        if c["setup"] not in setups:
            setups.append(c["setup"])
    base_tc = round(3600 * fps)  # 01:00:00:00
    clips_total = 0
    for setup in setups:
        mine = [c for c in cov if c["setup"] == setup]
        name = mine[0].get("setupName", "")
        times = []
        for c in mine:
            if c["timeOfDay"] not in times:
                times.append(c["timeOfDay"])
        # the primary time is the one the main lens renders first (on the assembly, or the first listed)
        primary = next((c["timeOfDay"] for c in mine if c.get("onAssembly")), None) \
            or next((c["timeOfDay"] for c in mine if c["camera"] == "main"), times[0])
        setup_bin = sub_folder(pool, cov_root, f"{setup}_{name}")
        t0 = min(c.get("sourceStartS", 0.0) for c in mine)

        items = []
        for c in mine:
            path = os.path.join(base, c["video"])
            if not os.path.exists(path):
                print(f"[trailer_import] warning: coverage clip missing, skipped: {path}")
                continue
            pool.SetCurrentFolder(sub_folder(pool, setup_bin, c["timeOfDay"]) if len(times) > 1 else setup_bin)
            got = pool.ImportMedia([path])
            if not got:
                print(f"[trailer_import] warning: Resolve refused to import: {path}")
                continue
            item = got[0]
            if a.proxy and c.get("proxy"):
                item.LinkProxyMedia(os.path.join(base, c["proxy"]))
            tc = frames_to_tc(base_tc + round((c.get("sourceStartS", 0.0) - t0) * fps), fps)
            try:
                if not item.SetClipProperty("Start TC", tc):
                    print(f"[trailer_import] warning: could not set Start TC {tc} on {c['video']}")
            except Exception as e:  # noqa: BLE001 — an optional nicety must not stop the import
                print(f"[trailer_import] warning: Start TC on {c['video']}: {e}")
            note = f"setup {setup} {name} · camera {c['camera']} ({c.get('kind', '')}) · tier {c.get('tier', '')} · {c['timeOfDay']}"
            try:
                item.SetClipProperty("Comments", f"{note}. {c.get('notes', '')}".strip())
                if hasattr(item, "SetMetadata"):
                    item.SetMetadata("Camera #", c["camera"])
            except Exception as e:  # noqa: BLE001
                print(f"[trailer_import] warning: clip metadata on {c['video']}: {e}")
            items.append((c, item))
        pool.SetCurrentFolder(setup_bin)
        if not items:
            continue

        tl_name = f"{plan['name']} — cov {setup} {name}"
        if tl_name in existing_names:
            clash = next((project.GetTimelineByIndex(i + 1) for i in range(project.GetTimelineCount())
                          if project.GetTimelineByIndex(i + 1).GetName() == tl_name), None)
            if clash is not None and a.replace:
                pool.DeleteTimelines([clash])
            else:
                tl_name = f"{tl_name} ({project.GetTimelineCount() + 1})"
        tl = pool.CreateEmptyTimeline(tl_name)
        if not tl:
            print(f"[trailer_import] warning: could not create coverage timeline {tl_name}")
            continue
        project.SetCurrentTimeline(tl)
        start = int(tl.GetStartFrame())
        # main first, then the cameras in plan order; the primary time before the others
        order = sorted(items, key=lambda ci: (ci[0]["camera"] != "main", ci[0]["timeOfDay"] != primary))
        placed = 0
        for k, (c, item) in enumerate(order):
            idx = k + 1
            while tl.GetTrackCount("video") < idx:
                tl.AddTrack("video")
            tl.SetTrackName("video", idx, f"{c['camera']} · {c['timeOfDay']}")
            frames = max(1, round(c.get("durationS", 0.0) * fps))
            rec = start + round((c.get("sourceStartS", 0.0) - t0) * fps)
            if not pool.AppendToTimeline([{"mediaPoolItem": item, "startFrame": 0, "endFrame": frames - 1,
                                           "recordFrame": rec, "trackIndex": idx, "mediaType": 1}]):
                print(f"[trailer_import] warning: AppendToTimeline failed: setup {setup} {c['camera']} {c['timeOfDay']}")
                continue
            placed += 1
            enabled = c["camera"] == "main" and c["timeOfDay"] == primary
            if not enabled:
                if hasattr(tl, "SetTrackEnable"):
                    tl.SetTrackEnable("video", idx, False)
                else:
                    print(f"[trailer_import] warning: no SetTrackEnable; disable video track {idx} of '{tl_name}' by hand")
        stem = next((c.get("sfx") for c, _ in order if c.get("sfx")), None)
        if stem and os.path.exists(os.path.join(base, stem)):
            got = pool.ImportMedia([os.path.join(base, stem)])
            c0 = order[0][0]
            frames = max(1, round(c0.get("durationS", 0.0) * fps))
            if not got or not pool.AppendToTimeline([{"mediaPoolItem": got[0], "startFrame": 0, "endFrame": frames - 1,
                                                      "recordFrame": start + round((c0.get("sourceStartS", 0.0) - t0) * fps),
                                                      "trackIndex": 1, "mediaType": 2}]):
                print(f"[trailer_import] warning: setup {setup}: SFX stem not placed")
            else:
                tl.SetTrackName("audio", 1, "SFX mix")
        # a marked cut between the setup's time-of-day takes (06c: the lever's push-start frame) — a marker on the timeline
        cut = next((c.get("cutS") for c, _ in order if c.get("cutS") is not None), None)
        if cut is not None:
            c0 = order[0][0]
            cut_frame = round((c0.get("sourceStartS", 0.0) - t0 + cut) * fps)
            if not tl.AddMarker(cut_frame, "Purple", "cut: time of day",
                                f"push-start frame (source {cut:.3f} s): cut or centre the dissolve here", 1):
                print(f"[trailer_import] warning: setup {setup}: cut marker not placed at frame {cut_frame}")
        clips_total += placed
        print(f"[trailer_import] coverage '{tl_name}': {placed} clip(s) on {len(order)} track(s), times {', '.join(times)}"
              + (f", cut marker at source {cut:.3f} s" if cut is not None else ""))
    pool.SetCurrentFolder(folder)
    print(f"[trailer_import] coverage: {clips_total} clips in {len(setups)} setup timeline(s), tier <= {a.tier}")


if __name__ == "__main__":
    main()
