#!/usr/bin/env python3
"""
Build the trailer's rough-cut timeline in DaVinci Resolve from a cut list, on whatever takes are in the pool.

    python3 scripts/resolve/trailer_import.py <out>/edit-plan.json        # media, bins, assembly + coverage first
    python3 scripts/resolve/trailer_edit.py <out>/edit-plan.json \
        [--cut scripts/resolve/sb-trailer-v2.cut.json] [--look scripts/resolve/sb-trailer-v2.look.json] [--look-only]

The timeline (cut.timeline) is GENERATED from the cut list (re-run after new takes land: stand-ins are swapped for the
wanted clips). The new build is imported as "<name> (candidate)" and compared item by item with the existing timeline;
if they differ (a hand edit in Resolve, or a changed cut list) the run stops and lists the differences — put hand edits
into the cut list, or pass --accept-overwrite.

How it is built (the only API route that gives all of it — Resolve Studio 21.0.0.47):
1. a Resolve-flavoured .otio written to --work and imported with ImportTimelineFromFile, linked to the EXISTING pool
   clips (importSourceClips False): picture, the 06c night switch, fades, the LOOK / VHS adjustment clips at full
   length, SFX mix + stems. No media is imported by this script.
2. API: track names, stem tracks muted (disabled), markers (MUSIC / STAND-IN / PENDING / day→night).
3. Titles: Text+ via InsertFusionTitleIntoTimeline (5 s each; it inserts at the playhead on the track of the last
   appended clip, so a throwaway clip steers it to TITLES), text/font/fade keyframes set in the Text+ comp.
4. Look (--look): an ASC CDL per time of day on node 1 of every picture clip + Sunset/Night colour groups; the
   finishing chain (halation, glint glow, vignette, film grain) as a Fusion comp on the LOOK adjustment clip; the VHS
   homage on the disabled VHS adjustment clip. The timeline node graph cannot be given nodes via the API.

Tracks: V1 PICTURE · V2 06c NIGHT · V3 TITLES · V4 LOOK · V5 VHS 80s (off) ·
        A1 SFX mix · A2 SFX extra · A3 MUSIC (user) · A4 SFX engine (muted) · A5 SFX water (muted)
"""
import argparse
import json
import os
import re
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from resolve_common import (PROJECT, PoolIndex, connect, fail, find_timeline, frames_to_tc, log,  # noqa: E402
                            otio_dissolve, otio_gap, otio_generator, otio_media_clip, otio_timeline, otio_track,
                            otio_volume, probe, ready, sequence, sub_folder, tc_to_frames)

TAG = "trailer_edit"
HERE = os.path.dirname(os.path.abspath(__file__))
V_PICTURE, V_SWITCH, V_TITLES, V_LOOK, V_VHS, V_LETTERBOX = 1, 2, 3, 4, 5, 6
A_MIX, A_EXTRA, A_MUSIC, A_ENGINE, A_WATER = 1, 2, 3, 4, 5
VIDEO_TRACKS = ["PICTURE", "06c NIGHT", "TITLES", "LOOK", "VHS 80s", "LETTERBOX 2.39 (off)"]
AUDIO_TRACKS = ["SFX mix", "SFX extra", "MUSIC (user)", "SFX engine", "SFX water"]
TIMES = ("sunset", "dusk", "night")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("plan", help="edit-plan.json of the pass on disk (sfx mapping, time of day)")
    ap.add_argument("--project", default=PROJECT)
    ap.add_argument("--cut", default=os.path.join(HERE, "sb-trailer-v2.cut.json"))
    ap.add_argument("--look", default=os.path.join(HERE, "sb-trailer-v2.look.json"))
    ap.add_argument("--no-look", action="store_true", help="build the cut without the grade/finishing")
    ap.add_argument("--look-only", action="store_true", help="re-apply the look to the existing edit timeline")
    ap.add_argument("--settle", type=float, default=60.0)
    ap.add_argument("--accept-overwrite", action="store_true",
                    help="replace the timeline even when it differs from what the cut list builds (hand edits are lost)")
    ap.add_argument("--work", default=tempfile.gettempdir(), help="where the generated .otio is written")
    a = ap.parse_args()

    with open(a.cut, encoding="utf-8") as f:
        cut = json.load(f)
    if cut.get("base"):  # a variant of another cut list: its keys override the base's (music merged one level)
        with open(os.path.join(os.path.dirname(os.path.abspath(a.cut)), cut["base"]), encoding="utf-8") as f:
            base = json.load(f)
        music_over = cut.pop("music", None)
        base.update({k: v for k, v in cut.items() if k != "base"})
        if music_over is not None and base.get("music"):
            base["music"] = dict(base["music"], **music_over)
        cut = base
    with open(os.path.abspath(a.plan), encoding="utf-8") as f:
        plan = json.load(f)
    look = None
    if not a.no_look:
        with open(a.look, encoding="utf-8") as f:
            look = json.load(f)
    fps = float(plan["fps"])
    resolve, pm, project = connect(a.project, TAG)
    pool = project.GetMediaPool()

    if a.look_only:
        tl = find_timeline(project, cut["timeline"]) or fail(TAG, f"no timeline '{cut['timeline']}'")
        project.SetCurrentTimeline(tl)
        apply_look(resolve, project, tl, look, clip_times(pool, plan, tl))
        pm.SaveProject()
        return

    ix = PoolIndex(pool)
    res = Resolver(ix, plan, fps, a.settle)
    fr = lambda s: int(round(s * fps))  # noqa: E731

    # ------------------------------------------------------------------ music grid (optional)
    music = cut.get("music")
    scored = bool(music and music.get("place", True))  # place false: the song's grid times the cut, no song, no ducking
    grid = None
    if music:
        with open(music["beats"], encoding="utf-8") as f:
            grid = json.load(f)
        if music.get("segments"):  # the song re-arranged on bar boundaries (music_beats.arrange)
            from music_beats import arrange
            grid = arrange(grid, music["segments"])
        m_off = music.get("offsetS", 0.0)

    def at(ref):
        """[bar, beat] on the song (1-based bar = its downbeat, + beats) → timeline seconds"""
        bar, beat = ref
        beats = grid["beats"]
        i0 = min(range(len(beats)), key=lambda i: abs(beats[i] - grid["downbeats"][bar - 1]))
        return m_off + beats[min(len(beats) - 1, i0 + beat)]

    def length(ev, rec_f):
        if "until" in ev:
            if not grid:
                fail(TAG, f"{ev['id']}: 'until' needs cut.music.beats")
            return fr(at(ev["until"])) - rec_f
        return fr(ev["dur"])

    # ------------------------------------------------------------------ resolve the cut
    rec = 0
    picture, switch, mix, engine, water = [], [], [], [], []
    markers, titles, shots = [], [], []
    standins = pending = 0
    dissolves, dissolve_prev = {}, {}  # record frame → half length; record end frame → (clip, source end)
    vhs_spans = []  # (record frame, frames) of events flagged "vhs"
    ducks, extra = [], []  # music dips [(from, to, dB)] in timeline frames; A2 engine accents
    for ev in cut["events"]:
        dur = length(ev, rec)
        if dur <= 0:
            fail(TAG, f"{ev['id']}: ends at or before its start ({dur} frames)")
        if ev.get("music"):
            markers.append((rec, "Pink", f"MUSIC: {ev['music']}", f"cut event {ev['id']}", 1))
        for spec in ([ev["title"]] if ev.get("title") else []) + ev.get("titles", []):
            titles.append((rec + fr(spec.get("atS", 0.0)), spec, ev["id"]))
        if ev.get("vhs"):  # the VHS treatment over this event only (user: selective, the intro + title)
            vhs_spans.append((rec, dur))
        if ev.get("kind") == "black":
            rec += dur
            continue
        wanted = [ev] + [dict(ev, **fb) for fb in ev.get("fallback", [])]
        chosen, got = None, None
        for k, cand in enumerate(wanted):
            got = res.clip(cand["clip"])
            sw = res.clip(cand["switch"]["clip"]) if cand.get("switch") else None
            if got and (not cand.get("switch") or sw):
                chosen = (k, cand, got, sw)
                break
        if not chosen:
            picture.append((rec, otio_generator("Solid Color", dur, fps, name=f"PENDING {ev['clip']}"), dur))
            markers.append((rec, "Red", f"PENDING {ev['id']}", f"not rendered yet: {ev['clip']}", dur))
            pending += 1
            shots.append(f"{ev['id']}(pending)")
            rec += dur
            continue
        k, cand, item, sw = chosen
        if k:
            standins += 1
            markers.append((rec, "Yellow", f"STAND-IN {ev['id']}",
                            f"wanted {ev['clip']}, using {cand['clip']} until it is rendered", dur))
        src = fr(cand.get("src", 0.0))
        if cand.get("align"):  # this source second lands on a song position (a blend's full night on a hit)
            src = fr(cand["align"]["atSrc"]) - (fr(at(cand["align"]["on"])) - rec)
            if src < 0:
                fail(TAG, f"{ev['id']}: aligning source {cand['align']['atSrc']} s needs {-src} frames before the clip")
        for d in [ev["duck"]] if ev.get("duck") else []:  # the music dips from a source frame and snaps back on another
            ducks.append((rec + fr(d["fromSrc"]) - src, rec + fr(d["toSrc"]) - src, d.get("db", -14.0)))
        if cand.get("switch") and "on" in cand["switch"]:  # the day→night frame lands on a song position
            src = fr(cand["switch"]["atSrc"]) - (fr(at(cand["switch"]["on"])) - rec)
            if src < 0:
                fail(TAG, f"{ev['id']}: the switch clip needs {-src} frames more head before its push frame")
        if src < 0 or src + dur > item.frames:  # no stretching, no silent slide: pick another angle in the cut list
            fail(TAG, f"{ev['id']}: {item.name} has {item.frames} frames, the cut wants source {src}..{src + dur}")
        picture.append((rec, item.otio(src, dur), dur))
        if ev.get("dissolveS"):  # a dissolve centred on this event's head cut: both sides need half of it as handle
            half = fr(ev["dissolveS"]) // 2
            prev = dissolve_prev.get(rec)
            if not prev:
                fail(TAG, f"{ev['id']}: dissolveS needs a picture clip right before it")
            p_item, p_end = prev
            if src - half < 0 or p_end + half > p_item.frames:
                fail(TAG, f"{ev['id']}: a {2 * half}-frame dissolve needs {half} frames of handle on both sides "
                          f"(in: {src}, out: {p_item.frames - p_end})")
            dissolves[rec] = half
        dissolve_prev[rec + dur] = (item, src + dur)
        shots.append(ev["id"] + ("*" if k else ""))
        if cand.get("sfxFrom"):  # a blend clip has no mix of its own: the source take's (same clock, same audio)
            donor = res.clip(cand["sfxFrom"])
            item.sfx, item.stems = (donor.sfx, donor.stems) if donor else (None, {})
        if item.sfx:
            clip = item.sfx.otio(src, dur, audio=True)
            db = ev.get("sfxDb", cut.get("sfxDb")) if scored else None
            mix.append((rec, otio_volume(clip, db) if db is not None else clip, dur))
            for stem, lst in (("engine", engine), ("water", water)):
                if stem in item.stems:
                    lst.append((rec, item.stems[stem].otio(src, dur, audio=True), dur))
        else:
            log(TAG, f"warning: {ev['id']}: no SFX mix found for {item.name}")
        acc = ev.get("engineAccent")
        if acc and "engine" in item.stems:  # the engine stem, unmuted on SFX extra, from a source frame to the event end
            a_src = max(src, fr(acc.get("fromSrc", cand.get("src", 0.0))) if "fromSrc" in acc else src)
            n = src + dur - a_src
            if n > 0:
                extra.append((rec + a_src - src, otio_volume(item.stems["engine"].otio(a_src, n, audio=True),
                                                             acc.get("db", 0.0)), n))
        if cand.get("switch"):
            at_f = fr(cand["switch"]["atSrc"])
            off = at_f - src
            if not 0 < off < dur:
                fail(TAG, f"{ev['id']}: switch frame {at_f} is outside the event's source range {src}..{src + dur}")
            switch.append((rec + off, sw.otio(at_f, dur - off), dur - off))
            markers.append((rec + off, "Purple", "day→night: lever push",
                            f"{cand['clip']} → {cand['switch']['clip']} at source {cand['switch']['atSrc']:.3f} s "
                            "(push-start frame). Hard cut; for a dissolve extend V2's head and add one here.", 1))
        rec += dur
    total = rec

    # ------------------------------------------------------------------ OTIO
    fade_in, fade_out = fr(cut.get("fadeInS", 0)), fr(cut.get("fadeOutS", 0))
    v1, end = sequence(picture, fps)
    if dissolves:  # insert the transitions between the clips they join
        out, pos = [], 0
        for child in v1:
            if child["OTIO_SCHEMA"].startswith("Clip") and pos in dissolves and out \
                    and out[-1]["OTIO_SCHEMA"].startswith("Clip"):
                out.append(otio_dissolve(dissolves[pos], dissolves[pos], fps))
            out.append(child)
            pos += int(child["source_range"]["duration"]["value"])
        v1 = out
    if picture and picture[0][0] == 0 and fade_in:
        v1.insert(0, otio_dissolve(0, fade_in, fps))
    if end == total and fade_out:
        v1.append(otio_dissolve(fade_out, 0, fps))
    a1, a1_end = sequence(mix, fps)
    if mix and mix[0][0] == 0 and fade_in:
        a1.insert(0, otio_dissolve(0, fade_in, fps))
    if a1_end == total and fade_out:
        a1.append(otio_dissolve(fade_out, 0, fps))
    tracks = [
        otio_track(VIDEO_TRACKS[0], "Video", v1),
        otio_track(VIDEO_TRACKS[1], "Video", sequence(switch, fps)[0] or [otio_gap(total, fps)]),
        otio_track(VIDEO_TRACKS[2], "Video", [otio_gap(total, fps)]),
        otio_track(VIDEO_TRACKS[3], "Video", [otio_generator("Adjustment Clip", total, fps, name="LOOK")]),
        otio_track(VIDEO_TRACKS[4], "Video", vhs_track([(0, total)] if cut.get("vhs") == "all" else vhs_spans, total, fps)),
        otio_track(VIDEO_TRACKS[5], "Video", [otio_generator("Adjustment Clip", total, fps, enabled=False,
                                                              name="LETTERBOX 2.39")]),
        otio_track(AUDIO_TRACKS[0], "Audio", a1),
        otio_track(AUDIO_TRACKS[1], "Audio", sequence(extra, fps)[0] or [otio_gap(total, fps)]),
        otio_track(AUDIO_TRACKS[2], "Audio", music_track(music, grid, pool, plan, ix, fps, total, fr, ducks) if scored
                   else [otio_gap(total, fps)]),
        otio_track(AUDIO_TRACKS[3], "Audio", sequence(engine, fps)[0] or [otio_gap(total, fps)]),
        otio_track(AUDIO_TRACKS[4], "Audio", sequence(water, fps)[0] or [otio_gap(total, fps)]),
    ]
    start_frame = round(3600 * fps)
    otio_path = os.path.join(a.work, f"{re.sub(r'[ /]', '_', cut['timeline'])}.otio")
    with open(otio_path, "w") as f:
        json.dump(otio_timeline(cut["timeline"], tracks, fps, start_frame), f)

    # ------------------------------------------------------------------ import
    plan_root = sub_folder(pool, pool.GetRootFolder(), cut.get("plan", plan["name"]))
    search = all_folders(plan_root)
    if "/" in cut["timeline"]:
        fail(TAG, f"Resolve refuses '/' in a timeline name (SetName fails): {cut['timeline']}")
    old = find_timeline(project, cut["timeline"])
    candidate_name = f"{cut['timeline']} (candidate)"
    stale = find_timeline(project, candidate_name)
    if stale:
        pool.DeleteTimelines([stale])
    pool.SetCurrentFolder(sub_folder(pool, plan_root, "Timelines"))
    n_before = len(ix.by_path)
    tl = pool.ImportTimelineFromFile(otio_path, {"timelineName": candidate_name, "importSourceClips": False,
                                                 "sourceClipsFolders": search})
    if not tl:
        fail(TAG, f"ImportTimelineFromFile refused {otio_path}")
    if old:  # never replace a timeline that differs from what this cut list builds without being told to
        diff = layout_diff(layout(old), layout(tl))
        if diff and not a.accept_overwrite:
            pool.DeleteTimelines([tl])
            for line in diff[:40]:
                log(TAG, "  " + line)
            fail(TAG, f"'{cut['timeline']}' differs from the cut list in {len(diff)} item(s) (a hand edit, or a cut-list "
                      f"change): put hand edits into the cut list, or re-run with --accept-overwrite to replace it")
        if diff:
            log(TAG, f"replacing '{cut['timeline']}': {len(diff)} item(s) differ from the previous build (accepted)")
        if not pool.DeleteTimelines([old]):
            fail(TAG, f"could not delete the previous '{cut['timeline']}'")
    if not tl.SetName(cut["timeline"]):
        pool.DeleteTimelines([tl])
        fail(TAG, f"could not rename the candidate to '{cut['timeline']}'")
    project.SetCurrentTimeline(tl)
    if len(PoolIndex(pool).by_path) != n_before:
        log(TAG, "warning: the OTIO import added media to the pool (expected none)")
    unlinked = [x.GetName() for x in tl.GetItemListInTrack("video", V_PICTURE) or []
                if x.GetName() and not x.GetMediaPoolItem() and not x.GetName().startswith(("PENDING", "Cross"))]
    if unlinked:
        fail(TAG, f"picture items not linked to pool clips: {unlinked}")
    for i, n in enumerate(VIDEO_TRACKS):
        tl.SetTrackName("video", i + 1, n)
    for i, n in enumerate(AUDIO_TRACKS):
        tl.SetTrackName("audio", i + 1, n)
    tl.SetTrackEnable("audio", A_ENGINE, False)
    tl.SetTrackEnable("audio", A_WATER, False)
    used = set()
    for frame, color, name, note, d in sorted(markers, key=lambda m: m[0]):
        while frame in used:
            frame += 1
        used.add(frame)
        if not tl.AddMarker(frame, color, name, note, d):
            log(TAG, f"warning: marker '{name}' not placed at frame {frame}")

    add_titles(tl, pool, ix, titles, fps)
    if look:
        apply_look(resolve, project, tl, look, clip_times(pool, plan, tl))
    pm.SaveProject()
    log(TAG, f"'{cut['timeline']}': {total / fps:.1f} s, {len(shots)} picture events ({' '.join(shots)}; *=stand-in), "
             f"{standins} stand-in(s), {pending} pending, {len(titles)} title(s), otio {otio_path}")


def vhs_track(spans, total, fps):
    """enabled VHS adjustment clips over the flagged events (merged when they touch); none flagged: one full-length
    disabled clip to switch on by hand"""
    if not spans:
        return [otio_generator("Adjustment Clip", total, fps, enabled=False, name="VHS 80s")]
    merged = []
    for rec, n in sorted(spans):
        if merged and rec <= merged[-1][0] + merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], rec + n - merged[-1][0])
        else:
            merged.append([rec, n])
    return sequence([(rec, otio_generator("Adjustment Clip", n, fps, name="VHS 80s"), n) for rec, n in merged], fps)[0]


def music_track(music, grid, pool, plan, ix, fps, total, fr, ducks=()):
    """the song on MUSIC (user) at music.offsetS, imported once into <plan>/Music; with music.segments, one clip per
    arranged piece, joined by short crossfades (music.xfadeS) on the bar lines"""
    path = os.path.abspath(music["file"])
    folder = sub_folder(pool, sub_folder(pool, pool.GetRootFolder(), plan["name"]), "Music")
    item, _ = ix.import_into(folder, path, TAG)
    if not item:
        fail(TAG, f"could not import the music {path}")
    info = probe(path) or {}
    frames = int(float(info.get("duration") or 0) * fps)
    start = tc_to_frames(item.GetClipProperty("Start TC") or "00:00:00:00", fps)
    off = fr(music.get("offsetS", 0.0))
    pieces = grid.get("pieces") or [(0.0, frames / fps, 0.0)]
    half = max(1, fr(music.get("xfadeS", 0.1)) // 2)
    events = []
    for i, (s0, s1, t0) in enumerate(pieces):
        rec, src = off + fr(t0), fr(s0)
        # a piece's length is its timeline span (next piece's start − its own), so rounding never overlaps or gaps
        span = fr(pieces[i + 1][2]) - fr(t0) if i + 1 < len(pieces) else fr(s1) - src
        n = min(span, total - rec)
        if n > 0:
            clip = otio_volume(otio_media_clip(path, start, frames, src, n, fps, audio=True), music.get("db", 0.0))
            keys = {}
            for f0, f1, db in ducks:  # keyframes relative to this clip's first frame: ramp down 4 f, snap back on f1
                if rec <= f0 and f1 <= rec + n:
                    base = music.get("db", 0.0)
                    for k, v in ((f0 - rec, base), (f0 - rec + 4, db), (f1 - rec - 1, db), (f1 - rec, base)):  # 4 f = 133 ms in
                        keys[str(int(k))] = {"Value": float(v), "Variant Type": "Double"}
            if keys:
                clip["effects"][0]["metadata"]["Resolve_OTIO"]["Parameters"][0]["Key Frames"] = keys
            events.append((rec, clip, n))
    children, _ = sequence(events, fps)
    if music.get("fadeOutS") and events:  # the song fades with the picture instead of being cut off
        children.append(otio_dissolve(fr(music["fadeOutS"]), 0, fps))
    if len(events) > 1:  # a crossfade on every join between two pieces
        out = []
        for c in children:
            if out and out[-1]["OTIO_SCHEMA"].startswith("Clip") and c["OTIO_SCHEMA"].startswith("Clip"):
                out.append(otio_dissolve(half, half, fps))
            out.append(c)
        children = out
    return children


# ---------------------------------------------------------------------- clip resolution

class Clip:
    def __init__(self, item, fps):
        self.item = item
        self.name = item.GetName()
        self.path = item.GetClipProperty("File Path")
        self.start = tc_to_frames(item.GetClipProperty("Start TC") or "00:00:00:00", fps)
        frames = item.GetClipProperty("Frames")
        self.frames = int(frames) if frames else int(round(duration_s(item) * fps))
        self.fps = fps
        self.sfx = None
        self.stems = {}

    def otio(self, src, frames, audio=False):
        return otio_media_clip(self.path, self.start, self.frames, src, frames, self.fps, audio=audio)


def duration_s(item):
    h, m, s, f = (int(x) for x in (item.GetClipProperty("Duration") or "00:00:00:00").split(":"))
    return h * 3600 + m * 60 + s + f / 30.0


class Resolver:
    """cut-list clip names (no take) → the newest READY take in the pool, with its SFX mix and stems"""

    def __init__(self, ix, plan, fps, settle):
        self.ix, self.plan, self.fps, self.settle = ix, plan, fps, settle
        self.sfx_of = {}
        for c in plan.get("coverage") or []:
            if c.get("sfx"):
                self.sfx_of[strip_ext(c["video"])] = os.path.basename(c["sfx"])
        for sh in plan["shots"]:
            if sh.get("sfx"):
                self.sfx_of[strip_ext(sh["video"])] = os.path.basename(sh["sfx"])
                for alt in sh.get("alternates", []):
                    self.sfx_of.setdefault(strip_ext(alt["video"]), os.path.basename(sh["sfx"]))

    def clip(self, base):
        rx = re.compile(re.escape(base) + r"_take(\d+)\.mov$")
        takes = sorted(((int(m.group(1)), it) for n, it in self.ix.by_name.items() if (m := rx.match(n))),
                       key=lambda t: -t[0])
        for take, item in takes:
            path = item.GetClipProperty("File Path")
            if path and ready(path, 0 if "_blend-" in base else self.settle):  # blends are ours, written whole
                c = Clip(item, self.fps)
                self._audio(c, base, take)
                return c
        return None

    def _audio(self, c, base, take):
        stem_name = strip_ext(c.name)
        wav = self.sfx_of.get(stem_name)
        mix = self.ix.by_name.get(wav) if wav else None
        if not mix:  # a take the plan no longer lists: the setup's mix of the same take
            setup = re.match(r"(.+?_(?:\d+[a-z]?|R\d+)_[a-z0-9-]+)", base)
            prefix = setup.group(1) if setup else base
            rx = re.compile(re.escape(prefix) + r"(_(?:sunset|dusk|night))?" + rf"_take{take:02d}\.wav$")
            mix = next((it for n, it in self.ix.by_name.items() if rx.match(n)), None)
        if mix:
            c.sfx = Clip(mix, self.fps)
            for stem in ("engine", "water"):
                s = self.ix.by_name.get(strip_ext(mix.GetName()) + f"_{stem}.wav")
                if s:
                    c.stems[stem] = Clip(s, self.fps)


def strip_ext(p):
    return os.path.splitext(os.path.basename(p))[0]


def all_folders(folder):
    out = [folder]
    for s in folder.GetSubFolderList() or []:
        out += all_folders(s)
    return out


def clip_times(pool, plan, tl):
    """picture timeline items → time of day (plan coverage first, then the clip name)"""
    tod_of = {strip_ext(c["video"]): c["timeOfDay"] for c in plan.get("coverage") or []}
    out = []
    for track in (V_PICTURE, V_SWITCH):
        for x in tl.GetItemListInTrack("video", track) or []:
            mpi = x.GetMediaPoolItem()
            if not mpi:
                continue
            n = strip_ext(mpi.GetName())
            tod = tod_of.get(n) or next((t for t in TIMES if f"_{t}_" in n), None)
            if not tod:  # take the newest-take-agnostic name
                tod = next((v for k, v in tod_of.items() if re.sub(r"_take\d+$", "", k) == re.sub(r"_take\d+$", "", n)),
                           None)
            out.append((x, tod or "sunset"))
    return out


# ---------------------------------------------------------------------- titles

def add_titles(tl, pool, ix, titles, fps):
    if not titles:
        return
    start = int(tl.GetStartFrame())
    before = signature(tl)
    anchor = next((it for n, it in ix.by_name.items() if n.endswith(".mov")), None) or fail(TAG, "no clip in pool")
    far = start + int(tl.GetEndFrame() - start) + 10 * int(round(fps))
    dummy = pool.AppendToTimeline([{"mediaPoolItem": anchor, "startFrame": 0, "endFrame": 1, "recordFrame": far,
                                    "trackIndex": V_TITLES, "mediaType": 1}])
    if not dummy or not tl.DeleteClips(dummy, False):
        fail(TAG, "could not steer the title insert to the TITLES track")
    # the insert is a ripple INSERT on every unlocked track (it split the full-length LOOK clip): lock all but TITLES
    locks = [(t, i) for t in ("video", "audio") for i in range(1, tl.GetTrackCount(t) + 1)
             if not (t == "video" and i == V_TITLES)]
    for t, i in locks:
        tl.SetTrackLock(t, i, True)
    for rec, spec, ev in sorted(titles, key=lambda t: t[0]):
        tl.SetCurrentTimecode(frames_to_tc(start + rec, fps))
        item = tl.InsertFusionTitleIntoTimeline("Text+")
        if not item or item.GetTrackTypeAndIndex() != ["video", V_TITLES] or int(item.GetStart()) != start + rec:
            fail(TAG, f"title for {ev} landed wrong: {item and (item.GetTrackTypeAndIndex(), item.GetStart())}")
        build_card(item.GetFusionCompByIndex(1), spec, int(item.GetDuration()), fps)
        item.SetName(f"TITLE {ev}")
    for t, i in locks:
        tl.SetTrackLock(t, i, False)
    if signature(tl) != before:
        fail(TAG, "a title insert rippled the picture/audio tracks; the timeline is not trustworthy, re-run")


# Title cards in the speedboat type system: the wordmark "speedboat" in Saira Stencil One (the boot splash's letterform,
# tracking −0.045em → CharacterSpacing 1 − 0.045/1.93) and credits in Saira Condensed, both bone #EDE6D6 with a faint soft
# halo, under the LOOK clip so grain and halation sit on them (user: just the text, no wave, no teal). Needs the fonts
# installed for Fusion (assets/fonts/speedboat/*.woff2 → TTF in ~/Library/Fonts, OFL). SPLASH keeps the splash palette.
SPLASH = {"ground": (0x0c, 0x15, 0x15), "ink": (0xe5, 0xec, 0xe9), "water": (0x31, 0x58, 0x5d), "kicker": (0xf2, 0x8b, 0x50)}
EM_PER_SIZE = 971.5 / 1080.0  # Text+ Size 1.0 → an em of 971.5 px on a 1920×1080 comp (measured: Size 0.2, glyph ink)
TRACK_EM_PER_UNIT = 1.93      # Text+ CharacterSpacing: 1.0 normal, each 0.01 adds 0.0193 em per gap (measured)


def rgb(c):
    return tuple(v / 255.0 for v in c)


def text_tool(comp, tool, text, font, style, size, center, color, spacing=1.0):
    tool.SetInput("StyledText", text)
    tool.SetInput("Font", font)
    tool.SetInput("Style", style)
    tool.SetInput("Size", size)
    tool.SetInput("CharacterSpacing", spacing)
    tool.SetInput("Center", {1: center[0], 2: center[1]})
    for k, v in zip(("Red1", "Green1", "Blue1"), rgb(color)):
        tool.SetInput(k, v)
    return tool


def merge(comp, bg, fg, x):
    m = comp.AddTool("Merge", x, 0)
    m.ConnectInput("Background", bg)
    m.ConnectInput("Foreground", fg)
    return m


BONE = (0xED, 0xE6, 0xD6)  # warm off-white (user: just the text, no wave, no teal)


def shadowed(comp, text, x):
    """the text over a soft, faint dark halo for legibility on bright water"""
    blur = comp.AddTool("Blur", x, 4)
    blur.ConnectInput("Input", text)
    blur.SetInput("XBlurSize", 14.0)
    dark = comp.AddTool("BrightnessContrast", x, 5)
    dark.ConnectInput("Input", blur)
    dark.SetInput("Gain", 0.0)
    dark.SetInput("Alpha", 0)
    dim = comp.AddTool("BrightnessContrast", x, 6)  # scale the halo's alpha down: a hint, not a drop shadow
    dim.ConnectInput("Input", dark)
    dim.SetInput("Red", 0)
    dim.SetInput("Green", 0)
    dim.SetInput("Blue", 0)
    dim.SetInput("Alpha", 1)
    dim.SetInput("Gain", 0.35)
    return merge(comp, dim, text, x)


def build_card(comp, spec, frames, fps):
    """spec.kind 'wordmark' (title card on the splash ground) or 'credits' (lines over picture); both fade in/out"""
    comp.Lock()
    tools = {t.GetAttrs()["TOOLS_RegID"]: t for t in comp.GetToolList().values()}
    out, first = tools["MediaOut"], tools["TextPlus"]
    if spec.get("kind") == "wordmark":  # plain "speedboat" in Saira Stencil One, bone, a soft shadow, a slow track-in
        em = spec.get("emPx", 200.0)
        word = text_tool(comp, first, spec.get("text", "speedboat"), "Saira Stencil One", "Regular",
                         em / (EM_PER_SIZE * 1080.0), (0.5, spec.get("centerY", 0.52)), BONE, spec.get("spacing", 0.9767))
        if word.AddModifier("CharacterSpacing", "BezierSpline"):  # tracking-in: a touch wide → the splash's −0.045em
            word.SetInput("CharacterSpacing", spec.get("spacing", 0.9767) + 0.03, 0)
            word.SetInput("CharacterSpacing", spec.get("spacing", 0.9767), frames - 1)
        top = shadowed(comp, word, 1)
        if spec.get("underline"):  # optional hero-orange hairline (off by default)
            bar = comp.AddTool("Background", 2, 2)
            for k, v in zip(("TopLeftRed", "TopLeftGreen", "TopLeftBlue"), rgb((0xff, 0x7a, 0x1a))):
                bar.SetInput(k, v)
            m = comp.AddTool("RectangleMask", 2, 3)
            m.SetInput("Width", 4.3 * em / 1920.0)
            m.SetInput("Height", 3.0 / 1080.0)
            m.SetInput("Center", {1: 0.5, 2: spec.get("centerY", 0.52) - 0.3 * em / 1080.0})
            bar.ConnectInput("EffectMask", m)
            top = merge(comp, top, bar, 3)
    else:
        lines = spec.get("lines", [])
        top, y = None, spec.get("topY", 0.5)
        for i, ln in enumerate(lines):
            tool = first if i == 0 else comp.AddTool("TextPlus", i, 3)
            if ln.get("style") == "kicker":
                text_tool(comp, tool, ln["text"], "Menlo", "Regular", 26.0 / (EM_PER_SIZE * 1080), (0.5, y),
                          SPLASH["kicker"], 1.365)
                y -= 0.06
            else:
                text_tool(comp, tool, ln["text"], "Saira Condensed", ln.get("weight", "SemiBold"),
                          ln.get("emPx", 80.0) / (EM_PER_SIZE * 1080), (0.5, y), BONE, 1.04)
                y -= 0.085
            tool = shadowed(comp, tool, 10 + i)
            top = tool if top is None else merge(comp, top, tool, i + 1)
    fade = comp.AddTool("BrightnessContrast", 6, 0)
    fade.ConnectInput("Input", top)
    fade.SetInput("Alpha", 1)
    n, f = frames - 1, int(round(spec.get("fadeS", 0.5) * fps))
    if fade.AddModifier("Gain", "BezierSpline"):
        for t, v in ((0, 0.0), (f, 1.0), (n - f, 1.0), (n, 0.0)):
            fade.SetInput("Gain", v, t)
    out.ConnectInput("Input", fade)
    comp.Unlock()


def layout(tl):
    """every item except titles (added after the import): track, name, start/duration/source-in relative to the
    timeline start — what a hand edit in Resolve changes"""
    s0 = int(tl.GetStartFrame())
    out = []
    for t in ("video", "audio"):
        for i in range(1, tl.GetTrackCount(t) + 1):
            if t == "video" and i == V_TITLES:
                continue
            for x in tl.GetItemListInTrack(t, i) or []:
                src = x.GetSourceStartFrame() if x.GetMediaPoolItem() else None
                out.append((f"{t[0].upper()}{i}", x.GetName(), int(x.GetStart()) - s0, int(x.GetDuration()), src))
    return out


def layout_diff(old, new):
    if old == new:
        return []
    rows = [f"timeline has {len(old)} items, the cut list builds {len(new)}"] if len(old) != len(new) else []
    for a, b in zip(old, new):
        if a != b:
            rows.append(f"{a[0]} {a[1]}: start {a[2]} dur {a[3]} src {a[4]}  →  {b[0]} {b[1]}: start {b[2]} dur {b[3]} "
                        f"src {b[4]}")
    return rows


def signature(tl):
    return [(t, i, x.GetStart(), x.GetDuration()) for t in ("video", "audio")
            for i in range(1, tl.GetTrackCount(t) + 1) if not (t == "video" and i == V_TITLES)
            for x in tl.GetItemListInTrack(t, i) or []]


# ---------------------------------------------------------------------- look

def apply_look(resolve, project, tl, look, items):
    groups = {g.GetName(): g for g in project.GetColorGroupsList() or []}
    graded = 0
    for x, tod in items:
        g = look["grade"].get(tod)
        if not g:
            continue
        ok = x.SetCDL({"NodeIndex": "1", "Slope": " ".join(map(str, g["slope"])),
                       "Offset": " ".join(map(str, g["offset"])), "Power": " ".join(map(str, g["power"])),
                       "Saturation": str(g["saturation"])})
        gname = tod.capitalize()
        if gname not in groups:
            groups[gname] = project.AddColorGroup(gname)
        if groups.get(gname):
            x.AssignToColorGroup(groups[gname])
        graded += bool(ok)
    log(TAG, f"look: CDL on {graded}/{len(items)} picture clips "
             f"({', '.join(sorted(set(t for _, t in items)))}), colour groups {sorted(groups)}")
    for track, chain, label in ((V_LOOK, look.get("finishing") or [], "LOOK"), (V_VHS, look.get("vhs") or [], "VHS"),
                                (V_LETTERBOX, [], "LETTERBOX")):
        clips = [x for x in tl.GetItemListInTrack("video", track) or [] if not x.GetMediaPoolItem()]
        if not clips:
            log(TAG, f"warning: no adjustment clip on V{track} for {label}")
        for adj in clips:
            build_adjustment(adj, chain, label, look)
        log(TAG, f"look: {label} on {len(clips)} adjustment clip(s) ← {' → '.join(s['name'] for s in chain) or 'bars'}"
                 f" ({sum(bool(x.GetClipEnabled()) for x in clips)} enabled)")


def build_adjustment(adj, chain, label, look):
    # DeleteFusionCompByName returns False and deletes nothing (Resolve 21.0.0.47), so adding a comp per run piled them
    # up: reuse comp 1 and clear its tools instead
    comp = adj.GetFusionCompByIndex(1) if adj.GetFusionCompCount() else adj.AddFusionComp()
    comp or fail(TAG, f"could not add a Fusion comp to {label}")
    # no comp.Lock() here: a Lock()ed new comp on an adjustment clip neither renders nor saves (Resolve 21.0.0.47)
    for t in list(comp.GetToolList().values()):
        if t.GetAttrs()["TOOLS_RegID"] not in ("MediaIn", "MediaOut"):
            t.Delete()
    tools = {t.GetAttrs()["TOOLS_RegID"]: t for t in comp.GetToolList().values()}
    prev = tools["MediaIn"]
    if label == "LETTERBOX":  # black bars for a 2.39:1 frame over the 16:9 picture (enable the clip to see it)
        aspect = (look.get("letterbox") or {}).get("aspect", 2.39)
        bars = comp.AddTool("Background", 1, 1)
        bars.SetInput("TopLeftAlpha", 1.0)
        mask = comp.AddTool("RectangleMask", 1, 2)
        mask.SetInput("Width", 1.0)
        mask.SetInput("Height", (1920.0 / aspect) / 1080.0)
        mask.SetInput("Invert", 1)
        bars.ConnectInput("EffectMask", mask)
        prev = merge(comp, prev, bars, 2)
    named = {}
    for i, step in enumerate(chain):
        t = comp.AddTool(step["tool"], i + 1, 0) or fail(TAG, f"{label}: Fusion has no tool {step['tool']}")
        t.SetAttrs({"TOOLS_Name": step["name"]})
        for k, v in step.get("inputs", {}).items():
            t.SetInput(k, v)
            got = t.GetInput(k)
            if isinstance(v, (int, float)) and (got is None or abs(float(got) - v) > 1e-4):
                log(TAG, f"warning: {label}/{step['name']}.{k} = {got}, wanted {v}")
        ins = {x.GetAttrs()["INPS_ID"] for x in t.GetInputList().values()}
        # ResolveFX: Source; most Fusion tools: Input; Custom: Image1
        t.ConnectInput(next(k for k in ("Source", "Input", "Image1") if k in ins), prev)
        named[step["name"]] = t
        prev = t
    ramp = (look.get("vhsRamp") or {}) if label == "VHS" else {}
    if ramp:  # a quick tracking glitch in and out: blur + fringe spike while the treatment mixes over the clean picture
        n = int(adj.GetDuration())
        fin, fout = int(ramp.get("inFrames", 5)), int(ramp.get("outFrames", 7))
        mix = merge(comp, tools["MediaIn"], prev, len(chain) + 1)
        if mix.AddModifier("Blend", "BezierSpline"):
            for t, v in ((0, 0.0), (fin, 1.0), (n - 1 - fout, 1.0), (n - 1, 0.0)):
                mix.SetInput("Blend", v, t)
        for name, key, peak in ramp.get("spikes", []):
            t = named.get(name)
            if t is None or not t.AddModifier(key, "BezierSpline"):
                log(TAG, f"warning: VHS ramp cannot animate {name}.{key}")
                continue
            base = float(next(s for s in chain if s["name"] == name)["inputs"].get(key, 0.0))
            for f, v in ((0, peak), (fin, base), (n - 1 - fout, base), (n - 1, peak)):
                t.SetInput(key, v, f)
        prev = mix
    tools["MediaOut"].ConnectInput("Input", prev)


if __name__ == "__main__":
    main()
