#!/usr/bin/env python3
"""
Build DaVinci Resolve bins and timelines from a cine edit plan (docs/cine/trailer-edit-plan.md).

Usage (Resolve Studio running, Preferences → System → General → External scripting using: Local):

    python3 scripts/resolve/trailer_import.py <out>/edit-plan.json \
        [--project "Shiver - Speedboat Trailer - MCP"] [--format 1920x1080] [--settle 60] [--no-coverage] [--tier A|B|C]

Re-run it whenever the render agent lands new takes: it is idempotent.

- Only COMPLETE takes are used: `_FAILED` / `.part` files, files modified less than --settle seconds ago and files ffprobe
  cannot read are skipped (and listed). A shot whose video is not ready is left out; its sfx/stems likewise.
- Media is imported once, found again by file path; a clip already in the pool is moved to the bin its role says.
- Timelines are generated: each is rebuilt only when the clips it should hold differ from what it holds (a new take
  landed), never duplicated. Hand edits belong in a duplicate of a generated timeline.

Timeline format: --format (default 1920x1080 = the delivery), NOT the plan's width/height, which is the render size of
whatever pass is on disk (640×360 look-pass stand-ins, later the 1080p masters under the same clip names — see
relink_final.py). The frame rate is the plan's.

Bins, under `<plan name>/`:
  Coverage/<setup>_<setupName>/[<time>/]   every lens of a setup (sub-bins when the setup has several times of day)
  Inserts/<setup>_<setupName>/[<time>/]    the `insert-*` coverage cameras
  ToD variants/<setup>_<setupName>/        the main lens at a setup's non-primary time of day (shot alternates)
  SFX mix/                                 one mix per setup
  SFX stems/                               engine / water / amb stems

Assembly timeline "ZZ old assembly" (--assembly-name; the plan's default 60 s order): V1 video, A1 SFX mix, A2 SFX extra, A3 MUSIC (user),
stems from A4 on ("SFX engine", "SFX water", "SFX amb") with those tracks disabled (= muted: the mix already contains
them). Time-of-day alternates on disabled video tracks above V1 ("ToD: night", …). Slots: an `intro` slot with a
negative recordInS shifts the assembly right by its length; `intro`/`end` become cream range markers.

Coverage (plan.coverage): every clip gets Start TC 01:00:00:00 + (sourceStartS − the setup's earliest), so every lens
of a setup shares one clock; camera / kind / tier / time go into the clip comments. One stacked timeline per setup,
`<plan name> — cov <setup> <setupName>` (in the Coverage bin): each camera × time on its own video track ("<camera> · <time>") at the same
record frame, only the main lens at the primary time enabled, the setup's SFX mix on A1, a purple marker on a `cutS`
(06c: the lever push-start frame). Resolve's scripting API cannot create multicam clips: for one, select a setup's bin
clips and use Create Multicam Clip Using Selected Clips (sync by Start TC).

API facts (Resolve Studio 21.0.0.47, checked live): AppendToTimeline's endFrame is EXCLUSIVE; there is no SetTrackMute
(SetTrackEnable('audio', i, False) mutes the track); Start TC and comments are settable clip properties.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from resolve_common import (PROJECT, PoolIndex, connect, fail, find_timeline, frames_to_tc, log,  # noqa: E402
                            ready, sub_folder)

TAG = "trailer_import"
TIERS = ["A", "B", "C"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("plan")
    ap.add_argument("--project", default=PROJECT)
    ap.add_argument("--format", default="1920x1080", help="timeline WxH (the delivery, not the render size)")
    ap.add_argument("--settle", type=float, default=60.0, help="seconds a file must be unmodified to count as done")
    ap.add_argument("--no-coverage", action="store_true")
    ap.add_argument("--tier", choices=TIERS, default="C")
    ap.add_argument("--assembly-name", default="ZZ old assembly", help="name of the plan's default-order timeline")
    a = ap.parse_args()

    plan_path = os.path.abspath(a.plan)
    base = os.path.dirname(plan_path)
    with open(plan_path, encoding="utf-8") as f:
        plan = json.load(f)
    fps = float(plan["fps"])
    width, height = (int(x) for x in a.format.lower().split("x"))

    resolve, pm, project = connect(a.project, TAG)
    fps_s = str(int(fps)) if fps.is_integer() else str(fps)
    for k, v in (("timelineFrameRate", fps_s), ("timelineResolutionWidth", str(width)),
                 ("timelineResolutionHeight", str(height))):
        cur = project.GetSetting(k)
        if cur not in (v, f"{v}.0") and not project.SetSetting(k, v):
            fail(TAG, f"could not set {k}={v} (is {cur}; the frame rate is locked once a timeline exists)")

    pool = project.GetMediaPool()
    ix = PoolIndex(pool)
    root = sub_folder(pool, pool.GetRootFolder(), plan["name"])

    skipped = []
    ok_cache = {}

    def usable(rel):
        if not rel:
            return None
        path = os.path.join(base, rel)
        if path not in ok_cache:
            ok_cache[path] = ready(path, a.settle)
            if not ok_cache[path]:
                skipped.append(rel)
        return path if ok_cache[path] else None

    roles = clip_roles(plan)
    start_tc = clip_start_tcs(plan, fps)
    moved = imported = 0

    def pool_item(rel, bin_names):
        nonlocal moved, imported
        path = usable(rel)
        if not path:
            return None
        folder = root
        for n in bin_names:
            folder = sub_folder(pool, folder, n)
        item, fresh = ix.import_into(folder, path, TAG)
        if not item:
            return None
        imported += fresh
        # Start TC before the clip is placed anywhere: a TC change under placed timeline items unlinks them
        tc = start_tc.get(rel, frames_to_tc(round(3600 * fps), fps))
        if item.GetClipProperty("Start TC") != tc and not item.SetClipProperty("Start TC", tc):
            log(TAG, f"warning: could not set Start TC {tc} on {rel}")
        have = ix.folder_of.get(item.GetUniqueId())
        if not fresh and have is not None and have.GetUniqueId() != folder.GetUniqueId():
            if pool.MoveClips([item], folder):
                ix.folder_of[item.GetUniqueId()] = folder
                moved += 1
        return item

    def video_item(rel):
        return pool_item(rel, roles.get(rel, ["Coverage", "unsorted"]))

    def sfx_item(rel):
        return pool_item(rel, ["SFX mix"])

    def stem_item(rel):
        return pool_item(rel, ["SFX stems"])

    timelines_bin = sub_folder(pool, root, "Timelines")

    # ------------------------------------------------------------------ assembly
    lead = max([0.0] + [-s["recordInS"] for s in plan.get("slots", []) if "recordInS" in s])
    variants = []
    for shot in plan["shots"]:
        for alt in shot.get("alternates", []):
            if alt["variant"] not in variants:
                variants.append(alt["variant"])
    stem_order = [k for k in ("engine", "water", "amb") if any(k in (sh.get("sfxStems") or {}) for sh in plan["shots"])]

    video_tracks = ["V1"] + [f"ToD: {v}" for v in variants]
    audio_tracks = ["SFX mix", "SFX extra", "MUSIC (user)"] + [f"SFX {k}" for k in stem_order]
    placements = []  # (trackType, trackIndex, item, srcIn, srcOutExcl, recordOffset)
    placed = []
    for shot in sorted(plan["shots"], key=lambda s: s["recordInS"]):
        video = video_item(shot["video"])
        if not video:
            continue
        frames = round((shot["recordOutS"] - shot["recordInS"]) * fps)
        src_in = round(shot.get("handleS", 0.0) * fps)
        rec = round((shot["recordInS"] + lead) * fps)
        placements.append(("video", 1, video, src_in, src_in + frames, rec))
        sfx = sfx_item(shot.get("sfx"))
        if sfx:
            placements.append(("audio", 1, sfx, src_in, src_in + frames, rec))
        for k, rel in (shot.get("sfxStems") or {}).items():
            stem = stem_item(rel)
            if stem:
                placements.append(("audio", 4 + stem_order.index(k), stem, src_in, src_in + frames, rec))
        for alt in shot.get("alternates", []):
            item = video_item(alt["video"])
            if item:
                placements.append(("video", 2 + variants.index(alt["variant"]), item, src_in, src_in + frames, rec))
        placed.append(shot["id"])

    markers = [(round((m["atS"] + lead) * fps), m.get("color", "Blue"), m["name"], m.get("note", ""), 1)
               for m in plan.get("markers", [])]
    for s in plan.get("slots", []):
        if "recordInS" in s:
            d = max(1, round((s["recordOutS"] - s["recordInS"]) * fps))
            color = {"intro": "Cream", "end": "Cream"}.get(s["kind"], "Yellow")
            markers.append((round((s["recordInS"] + lead) * fps), color, s["name"], f"slot: {s['kind']}", d))

    pool.SetCurrentFolder(timelines_bin)
    state = build_timeline(project, pool, a.assembly_name, video_tracks, audio_tracks, placements, markers,
                           disabled_video=list(range(2, 2 + len(variants))),
                           disabled_audio=list(range(4, 4 + len(stem_order))))
    log(TAG, f"assembly '{a.assembly_name}' {state} @ {fps_s} fps {width}x{height}: {len(placed)}/{len(plan['shots'])} "
             f"shots ({', '.join(placed)}), {len(markers)} markers, {len(variants)} ToD track(s), "
             f"{len(stem_order)} muted stem track(s)")

    if not a.no_coverage and plan.get("coverage"):
        import_coverage(project, pool, plan, fps, a, video_item, sfx_item, usable, timelines_bin)

    pool.SetCurrentFolder(root)
    log(TAG, f"media: {imported} imported, {moved} moved to their bin, {len(ix.by_path)} file clips in the pool")
    if skipped:
        log(TAG, f"skipped {len(skipped)} file(s) not ready (FAILED/.part/growing/unreadable): "
                 + ", ".join(sorted(set(os.path.basename(s) for s in skipped))))


def clip_start_tcs(plan, fps):
    """plan-relative path → Start TC: 01:00:00:00 + (sourceStartS − the setup's earliest) for every clip of a setup
    (its video and its sfx/stems), so all lenses of a setup share one clock"""
    base_tc = round(3600 * fps)
    out = {}
    cov = plan.get("coverage") or []
    for setup in dict.fromkeys(c["setup"] for c in cov):
        mine = [c for c in cov if c["setup"] == setup]
        t0 = min(c.get("sourceStartS", 0.0) for c in mine)
        for c in mine:
            tc = frames_to_tc(base_tc + round((c.get("sourceStartS", 0.0) - t0) * fps), fps)
            out[c["video"]] = tc
            if c.get("sfx"):
                out.setdefault(c["sfx"], tc)
    return out


def clip_roles(plan):
    """video path (plan-relative) → bin names under the plan folder"""
    roles = {}
    cov = plan.get("coverage") or []
    for setup in dict.fromkeys(c["setup"] for c in cov):
        mine = [c for c in cov if c["setup"] == setup]
        label = f"{setup}_{mine[0].get('setupName', '')}"
        times = list(dict.fromkeys(c["timeOfDay"] for c in mine))
        primary = next((c["timeOfDay"] for c in mine if c.get("onAssembly")), None) \
            or next((c["timeOfDay"] for c in mine if c["camera"] == "main"), times[0])
        for c in mine:
            tod = [c["timeOfDay"]] if len(times) > 1 else []
            if c["camera"] == "main" and c["timeOfDay"] != primary:
                roles[c["video"]] = ["ToD variants", label]
            elif c["camera"].startswith("insert"):
                roles[c["video"]] = ["Inserts", label] + tod
            else:
                roles[c["video"]] = ["Coverage", label] + tod
    for shot in plan["shots"]:
        label = f"{shot['id']}_{shot['name']}"
        roles.setdefault(shot["video"], ["Coverage", label])
        for alt in shot.get("alternates", []):
            roles.setdefault(alt["video"], ["ToD variants", label])
    return roles


MARKER_COLORS = {"Blue", "Cyan", "Green", "Yellow", "Red", "Pink", "Purple", "Fuchsia", "Rose", "Lavender", "Sky",
                 "Mint", "Lemon", "Sand", "Cocoa", "Cream"}
MARKER_ALIASES = {"Orange": "Sand", "White": "Cream", "Magenta": "Fuchsia"}


def add_markers(tl, markers, name):
    """Resolve refuses unknown colours (the plan's 'Orange') and a second marker on an occupied frame"""
    used = set()
    for frame, color, mname, note, dur in sorted(markers, key=lambda m: m[0]):
        color = color if color in MARKER_COLORS else MARKER_ALIASES.get(color, "Sand")
        while frame in used:
            frame += 1
        used.add(frame)
        if not tl.AddMarker(frame, color, mname, note, dur):
            log(TAG, f"warning: marker '{mname}' not placed at frame {frame} on '{name}'")


def build_timeline(project, pool, name, video_tracks, audio_tracks, placements, markers,
                   disabled_video=(), disabled_audio=(), enabled_video_only=None):
    """create or rebuild a generated timeline; returns 'unchanged' / 'built' / 'rebuilt' / 'empty'"""
    if not placements:
        return "empty"
    project.SetCurrentTimeline(find_timeline(project, name) or project.GetCurrentTimeline())
    want = sorted((t, i, it.GetName(), s, e, rec) for t, i, it, s, e, rec in placements)
    tl = find_timeline(project, name)
    state = "built"
    if tl:
        start = int(tl.GetStartFrame())
        have = []
        for t in ("video", "audio"):
            for i in range(1, tl.GetTrackCount(t) + 1):
                for x in tl.GetItemListInTrack(t, i) or []:
                    mpi = x.GetMediaPoolItem()
                    src = x.GetSourceStartFrame()
                    have.append((t, i, mpi.GetName() if mpi else x.GetName(), src,
                                 None if src is None else src + x.GetDuration(), x.GetStart() - start))
        if sorted(have) == want:
            return "unchanged"
        if not pool.DeleteTimelines([tl]):
            fail(TAG, f"could not delete timeline '{name}' to rebuild it")
        state = "rebuilt"
    tl = pool.CreateEmptyTimeline(name) or fail(TAG, f"could not create timeline {name}")
    project.SetCurrentTimeline(tl)
    while tl.GetTrackCount("video") < len(video_tracks):
        tl.AddTrack("video")
    while tl.GetTrackCount("audio") < len(audio_tracks):
        tl.AddTrack("audio", "stereo")
    for i, n in enumerate(video_tracks):
        tl.SetTrackName("video", i + 1, n)
    for i, n in enumerate(audio_tracks):
        tl.SetTrackName("audio", i + 1, n)
    start = int(tl.GetStartFrame())
    clips = [{"mediaPoolItem": it, "startFrame": s, "endFrame": e, "recordFrame": start + rec, "trackIndex": i,
              "mediaType": 1 if t == "video" else 2} for t, i, it, s, e, rec in placements]
    got = pool.AppendToTimeline(clips)
    if not got or len(got) != len(clips):
        fail(TAG, f"AppendToTimeline placed {len(got or [])}/{len(clips)} clips on '{name}'")
    for i in disabled_video:
        tl.SetTrackEnable("video", i, False)
    for i in disabled_audio:
        tl.SetTrackEnable("audio", i, False)
    add_markers(tl, markers, name)
    return state


def import_coverage(project, pool, plan, fps, a, video_item, sfx_item, usable, timelines_bin):
    max_tier = TIERS.index(a.tier)
    cov = [c for c in plan["coverage"] if TIERS.index(c.get("tier", "C")) <= max_tier]
    if not cov:
        log(TAG, f"coverage: nothing at tier <= {a.tier}")
        return
    total = 0
    setups = list(dict.fromkeys(c["setup"] for c in cov))
    for setup in setups:
        mine = [c for c in cov if c["setup"] == setup]
        name = mine[0].get("setupName", "")
        times = list(dict.fromkeys(c["timeOfDay"] for c in mine))
        primary = next((c["timeOfDay"] for c in mine if c.get("onAssembly")), None) \
            or next((c["timeOfDay"] for c in mine if c["camera"] == "main"), times[0])
        t0 = min(c.get("sourceStartS", 0.0) for c in mine)
        items = []
        for c in mine:
            item = video_item(c["video"])
            if not item:
                continue
            note = (f"setup {setup} {name} · camera {c['camera']} ({c.get('kind', '')}) · tier {c.get('tier', '')} · "
                    f"{c['timeOfDay']}. {c.get('notes', '')}").strip()
            if item.GetClipProperty("Comments") != note:
                item.SetClipProperty("Comments", note)
            items.append((c, item))
        if not items:
            continue
        order = sorted(items, key=lambda ci: (ci[0]["camera"] != "main", ci[0]["timeOfDay"] != primary))
        placements, vtracks, disabled = [], [], []
        for k, (c, item) in enumerate(order):
            frames = min(round(c.get("durationS", 0.0) * fps), int(item.GetClipProperty("Frames") or 10 ** 9))
            rec = round((c.get("sourceStartS", 0.0) - t0) * fps)
            placements.append(("video", k + 1, item, 0, frames, rec))
            vtracks.append(f"{c['camera']} · {c['timeOfDay']}")
            if not (c["camera"] == "main" and c["timeOfDay"] == primary):
                disabled.append(k + 1)
        mix = next((c.get("sfx") for c, _ in order if c.get("sfx") and usable(c.get("sfx"))), None)
        if mix:
            sfx = sfx_item(mix)
            c0 = order[0][0]
            if sfx:
                frames = round(c0.get("durationS", 0.0) * fps)
                placements.append(("audio", 1, sfx, 0, frames, round((c0.get("sourceStartS", 0.0) - t0) * fps)))
        markers = []
        cut = next((c.get("cutS") for c, _ in order if c.get("cutS") is not None), None)
        if cut is not None:
            c0 = order[0][0]
            markers.append((round((c0.get("sourceStartS", 0.0) - t0 + cut) * fps), "Purple", "cut: time of day",
                            f"push-start frame (source {cut:.3f} s): cut or centre the dissolve here", 1))
        tl_name = f"{plan['name']} — cov {setup} {name}"
        pool.SetCurrentFolder(sub_folder(pool, sub_folder(pool, pool.GetRootFolder(), plan["name"]), "Coverage"))
        state = build_timeline(project, pool, tl_name, vtracks, ["SFX mix"], placements, markers,
                               disabled_video=disabled)
        total += len(items)
        log(TAG, f"coverage '{tl_name}' {state}: {len(items)}/{len(mine)} clip(s), times {', '.join(times)}"
                 + (f", cut marker at source {cut:.3f} s" if cut is not None else ""))
    log(TAG, f"coverage: {total} clips in {len(setups)} setup(s), tier <= {a.tier}")


if __name__ == "__main__":
    main()
