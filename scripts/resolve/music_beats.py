#!/usr/bin/env python3
"""
Beat grid for the user's trailer music, and cut-point nudges onto it.

librosa is not in the system python: make a venv once (any dir; the trailer work used scratchpad/edit/.venv)

    uv venv -p python3.12 .venv && VIRTUAL_ENV=$PWD/.venv uv pip install librosa soundfile

    .venv/bin/python scripts/resolve/music_beats.py <song> [--out beats.json] [--offset 0] [--no-resolve]
    .venv/bin/python scripts/resolve/music_beats.py <song> --snap [--max-nudge 0.25] [--grid downbeats|beats|onsets]
    .venv/bin/python scripts/resolve/music_beats.py --clear          # remove the markers this tool added

Analysis → beats.json (seconds from the song's start):
  tempo, beats, downbeats (4/4 assumed: the beat phase whose beats carry the most low-band onset energy — librosa has
  no downbeat tracker; check it against the song), onsets, sections (agglomerative segmentation on beat-synced chroma +
  MFCC, each with its mean energy), drops (the largest rises of smoothed energy, on the beat they land on), energy (RMS, 10 Hz, 0..1).

Resolve (unless --no-resolve), timeline --timeline (default the MAIN edit): markers tagged customData
"music_beats" (a re-run replaces them), aligned to the song clip on the "MUSIC (user)" track when there is one
(its record position and source in; re-run after moving it), otherwise at --offset + t. Downbeats Sky, section starts Lemon (with duration), drops Red.
Resolve has no per-track markers.

--snap: for every cut on the PICTURE track, the nearest grid time within --max-nudge; a nudge moves the cut, so the
outgoing clip needs that many frames of right handle (later cut) or the incoming one left handle (earlier cut) —
checked with TimelineItem.GetRightOffset/GetLeftOffset. Proposals go to snap.json next to --out (and are printed);
with --cut, a copy of the cut list with the nudges applied (<cut>.snapped.json) that trailer_edit.py --cut can build.
The timeline itself is not changed.
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TAG = "music_beats"
MARK = "music_beats"


def log(msg):
    print(f"[{TAG}] {msg}", flush=True)


def analyse(song, sections_k=None):
    import librosa
    import numpy as np

    y, sr = librosa.load(song, sr=22050, mono=True)
    dur = len(y) / sr
    hop = 512
    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
    tempo, beat_frames = librosa.beat.beat_track(onset_envelope=onset_env, sr=sr, hop_length=hop, trim=False)
    tempo = float(np.atleast_1d(tempo)[0])
    beats = librosa.frames_to_time(beat_frames, sr=sr, hop_length=hop)
    onsets = librosa.onset.onset_detect(onset_envelope=onset_env, sr=sr, hop_length=hop, units="time")

    # downbeats: the 4/4 phase with the most low-band (kick/bass) onset energy on its beats
    S = np.abs(librosa.stft(y, hop_length=hop))
    freqs = librosa.fft_frequencies(sr=sr)
    low = librosa.onset.onset_strength(S=librosa.amplitude_to_db(S[freqs < 200]), sr=sr, hop_length=hop)
    phase_score = [float(low[beat_frames[p::4]].sum()) if len(beat_frames[p::4]) else 0.0 for p in range(4)]
    phase = int(np.argmax(phase_score))
    downbeats = beats[phase::4]

    rms = librosa.feature.rms(y=y, hop_length=hop)[0]
    t_rms = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=hop)
    norm = (rms - rms.min()) / max(1e-9, rms.max() - rms.min())
    grid = np.arange(0, dur, 0.1)
    energy = np.interp(grid, t_rms, norm)

    # sections on beat-synced chroma + mfcc
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop)
    mfcc = librosa.feature.mfcc(y=y, sr=sr, hop_length=hop, n_mfcc=13)
    feats = np.vstack([librosa.util.normalize(chroma, axis=1), librosa.util.normalize(mfcc, axis=1)])
    synced = librosa.util.sync(feats, beat_frames) if len(beat_frames) > 2 else feats
    k = sections_k or int(min(10, max(3, round(dur / 15))))
    k = max(2, min(k, synced.shape[1] - 1))
    bounds = librosa.segment.agglomerative(synced, k)
    bound_frames = beat_frames[np.clip(bounds - 1, 0, len(beat_frames) - 1)] if len(beat_frames) > 2 else bounds
    starts = sorted(set([0.0] + [float(t) for t in librosa.frames_to_time(bound_frames, sr=sr, hop_length=hop) if t > 0.5]))
    sections = []
    for i, s in enumerate(starts):
        e = starts[i + 1] if i + 1 < len(starts) else dur
        sel = (grid >= s) & (grid < e)
        sections.append({"startS": round(s, 3), "endS": round(e, 3),
                         "energy": round(float(energy[sel].mean()) if sel.any() else 0.0, 3)})

    # drops: biggest rises of 2 s-smoothed energy (1 s before vs 1 s after), at least 4 s apart, snapped to a downbeat
    win = 10
    sm = np.convolve(energy, np.ones(win) / win, mode="same")
    short = np.convolve(energy, np.ones(3) / 3, mode="same")
    rise = np.zeros_like(sm)
    rise[win:-win] = sm[2 * win:] - sm[:-2 * win]
    drops = []
    for idx in np.argsort(-rise):
        if rise[idx] < 0.15 or len(drops) >= 6:
            break
        # the rise's own onset: where energy first crosses half-way between the levels 1 s before and 1 s after
        lo, hi = sm[max(0, idx - win)], sm[min(len(sm) - 1, idx + win)]
        seg = np.arange(max(0, idx - win), min(len(sm), idx + win + 1))
        above = short[seg] >= (lo + hi) / 2  # 0.3 s smoothing: single transients do not count as the rise
        cross = seg[np.argmax(above)] if above.any() else idx
        t = float(grid[cross])
        if len(beats):  # the beat the rise lands on (a rise can start off the bar: a pickup, a beat-2 break)
            t = float(beats[np.argmin(np.abs(beats - t - 0.05))])
        if all(abs(t - d["atS"]) >= 4.0 for d in drops):
            drops.append({"atS": round(t, 3), "rise": round(float(rise[idx]), 3)})
    drops.sort(key=lambda d: d["atS"])

    r3 = lambda a: [round(float(x), 3) for x in a]  # noqa: E731
    return {"song": os.path.abspath(song), "durationS": round(dur, 3), "tempo": round(tempo, 2),
            "downbeatPhase": phase, "beats": r3(beats), "downbeats": r3(downbeats), "onsets": r3(onsets),
            "sections": sections, "drops": drops, "energyHz": 10, "energy": r3(energy)}


def arrange(beats, segments):
    """an arrangement of the song on bar boundaries: segments = [[fromBar, toBar], ...] (bar 0 = the song's first
    sample, 'end' = its last; bar k = its k-th downbeat), played in order. Returns the timeline grid (beats, downbeats,
    drops re-timed; bars renumbered in playing order) and the pieces [(songStartS, songEndS, timelineStartS)]."""
    db = beats["downbeats"]

    def t(bar):
        if bar == "end":
            return beats["durationS"]
        return 0.0 if bar == 0 else db[bar - 1]

    pieces, T = [], 0.0
    for a, b in segments or [[0, "end"]]:
        s0, s1 = t(a), t(b)
        if s1 <= s0:
            raise ValueError(f"segment {a}..{b} is empty")
        pieces.append((s0, s1, T))
        T += s1 - s0
    eps = 1e-6

    def remap(times):
        return [round(T0 + x - s0, 3) for s0, s1, T0 in pieces for x in times if s0 - eps <= x < s1 - eps]
    return {"durationS": round(T, 3), "beats": remap(beats["beats"]), "downbeats": remap(db),
            "drops": [{"atS": x, "rise": 0.0} for x in remap([d["atS"] for d in beats["drops"]])],
            "sections": [{"startS": x, "endS": x, "energy": 0.0} for x in remap([s["startS"] for s in beats["sections"]])],
            "pieces": pieces, "tempo": beats["tempo"]}


def resolve_timeline(project_name, name):
    sys.path.insert(0, HERE)
    from resolve_common import connect, find_timeline  # noqa: E402
    resolve, pm, project = connect(project_name, TAG)
    tl = find_timeline(project, name)
    if not tl:
        log(f"ERROR: no timeline '{name}'")
        sys.exit(1)
    project.SetCurrentTimeline(tl)
    return pm, project, tl


def music_item(tl):
    for i in range(1, tl.GetTrackCount("audio") + 1):
        if tl.GetTrackName("audio", i).lower().startswith("music"):
            items = tl.GetItemListInTrack("audio", i) or []
            return items[0] if items else None
    return None


def clear_markers(target):
    n = 0
    while target.DeleteMarkerByCustomData(MARK):
        n += 1
    return n


def place_markers(tl, beats, fps, offset):
    item = music_item(tl)
    target = tl
    cleared = clear_markers(tl)
    if item:
        # the song's t = 0 on the timeline, from where its clip sits and which source frame it starts on (timeline
        # markers: TimelineItem marker frames are ambiguous in the API — re-run after moving the song)
        base = int(item.GetStart()) - int(tl.GetStartFrame()) - int(item.GetSourceStartFrame() or 0)
        where = f"timeline markers aligned to '{item.GetName()}' on the MUSIC track (song t=0 at frame {base})"
    else:
        base = int(round(offset * fps))
        where = f"timeline markers at offset {offset:.3f} s (no clip on the MUSIC track yet)"
    placed = 0
    fr = lambda t: base + int(round(t * fps))  # noqa: E731
    rows = [(fr(t), "Sky", f"bar {i + 1}", "", 1) for i, t in enumerate(beats["downbeats"])]
    rows += [(fr(s["startS"]), "Lemon", f"section {i + 1} (energy {s['energy']:.2f})", "",
              max(1, int(round((s["endS"] - s["startS"]) * fps)))) for i, s in enumerate(beats["sections"])]
    rows += [(fr(d["atS"]), "Red", "DROP", f"energy rise {d['rise']:.2f}", 1) for d in beats["drops"]]
    used = set(int(f) for f in (target.GetMarkers() or {}))
    for frame, color, name, note, d in sorted(rows):
        if frame < 0:
            continue
        while frame in used:
            frame += 1
        used.add(frame)
        placed += bool(target.AddMarker(frame, color, name, note, d, MARK))
    log(f"markers: {placed}/{len(rows)} placed as {where} ({cleared} old removed)")


def snap(tl, beats, fps, offset, grid_name, max_nudge, cut_path, out_dir):
    grid = [offset + t for t in beats[grid_name]]
    start = int(tl.GetStartFrame())
    track = next((i for i in range(1, tl.GetTrackCount("video") + 1)
                  if tl.GetTrackName("video", i) in ("PICTURE", "V1")), 1)
    items = [x for x in tl.GetItemListInTrack("video", track) or [] if x.GetMediaPoolItem()]
    proposals = []
    for a, b in zip(items, items[1:]):
        if a.GetEnd() != b.GetStart():
            continue  # a gap (title on black) or a transition: not a straight cut
        cut_f = int(a.GetEnd()) - start
        t = cut_f / fps
        near = min(grid, key=lambda g: abs(g - t)) if grid else None
        if near is None or abs(near - t) > max_nudge:
            continue
        d = int(round(near * fps)) - cut_f
        if d == 0:
            continue
        room = int(a.GetRightOffset() or 0) if d > 0 else int(b.GetLeftOffset() or 0)
        ok = abs(d) <= room and (b.GetDuration() - d > 1 if d > 0 else a.GetDuration() + d > 1)
        proposals.append({"cutS": round(t, 3), "toS": round(near, 3), "nudgeFrames": d, "handleFrames": room,
                          "ok": ok, "out": a.GetName(), "in": b.GetName()})
    path = os.path.join(out_dir, "snap.json")
    with open(path, "w") as f:
        json.dump({"grid": grid_name, "maxNudgeS": max_nudge, "proposals": proposals}, f, indent=1)
    good = [p for p in proposals if p["ok"]]
    log(f"snap: {len(items) - 1} cuts, {len(proposals)} within ±{max_nudge} s of a {grid_name[:-1]}, "
        f"{len(good)} with the handles for it → {path}")
    for p in proposals:
        log(f"  {p['cutS']:7.3f} → {p['toS']:7.3f} s ({p['nudgeFrames']:+d} f, handle {p['handleFrames']} f)"
            f"{'' if p['ok'] else '  NO HANDLE'}  {p['out']} | {p['in']}")
    if cut_path and good:
        with open(cut_path, encoding="utf-8") as f:
            cut = json.load(f)
        rec, bounds = 0.0, []
        for i, ev in enumerate(cut["events"]):
            rec += ev["dur"]
            bounds.append((round(rec * fps), i))
        applied = 0
        for p in good:
            hit = next((i for f, i in bounds if f == int(round(p["cutS"] * fps))), None)
            if hit is None or hit + 1 >= len(cut["events"]):
                continue
            ds = p["nudgeFrames"] / fps
            a_ev, b_ev = cut["events"][hit], cut["events"][hit + 1]
            a_ev["dur"] = round(a_ev["dur"] + ds, 4)
            b_ev["dur"] = round(b_ev["dur"] - ds, 4)
            b_ev["src"] = round(b_ev.get("src", 0) + ds, 4)
            for fb in b_ev.get("fallback", []):
                fb["src"] = round(fb.get("src", 0) + ds, 4)
            applied += 1
        out = os.path.splitext(cut_path)[0] + ".snapped.json"
        if os.path.dirname(os.path.abspath(out)) == HERE:
            out = os.path.join(out_dir, os.path.basename(out))
        with open(out, "w", encoding="utf-8") as f:
            json.dump(cut, f, indent=1, ensure_ascii=False)
        log(f"snap: {applied} nudges applied to a copy of the cut list → {out}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("song", nargs="?")
    ap.add_argument("--out", help="beats.json path (default: next to the song)")
    ap.add_argument("--project", default="Shiver - Speedboat Trailer - MCP")
    ap.add_argument("--timeline", default="★ sb-trailer-v2 — MAIN (Reef Runner EX)")
    ap.add_argument("--offset", type=float, default=0.0, help="timeline seconds where the song starts")
    ap.add_argument("--fps", type=float, default=30.0)
    ap.add_argument("--sections", type=int)
    ap.add_argument("--no-resolve", action="store_true")
    ap.add_argument("--snap", action="store_true")
    ap.add_argument("--grid", choices=["downbeats", "beats", "onsets"], default="downbeats")
    ap.add_argument("--max-nudge", type=float, default=0.25)
    ap.add_argument("--cut", default=os.path.join(HERE, "sb-trailer-v2.cut.json"))
    ap.add_argument("--clear", action="store_true", help="remove this tool's markers and exit")
    ap.add_argument("--arrange", help='JSON segments, e.g. [[0,5],[2,5],[2,19],[17,"end"]]: markers and --snap use '
                                      "the arranged song; --no-resolve prints its bar table")
    a = ap.parse_args()

    if a.clear:
        pm, project, tl = resolve_timeline(a.project, a.timeline)
        log(f"removed {clear_markers(tl)} marker(s)")
        pm.SaveProject()
        return
    if not a.song:
        ap.error("a song is required")
    out = a.out or os.path.join(os.path.dirname(os.path.abspath(a.song)), "beats.json")
    beats = analyse(a.song, a.sections)
    with open(out, "w") as f:
        json.dump(beats, f)
    log(f"{os.path.basename(a.song)}: {beats['durationS']:.1f} s, {beats['tempo']:.1f} BPM, {len(beats['beats'])} beats, "
        f"{len(beats['downbeats'])} downbeats (phase {beats['downbeatPhase']}), {len(beats['onsets'])} onsets, "
        f"{len(beats['sections'])} sections, drops at {[d['atS'] for d in beats['drops']]} → {out}")
    if a.arrange:
        beats = arrange(beats, json.loads(a.arrange))
        log(f"arranged: {beats['durationS']:.2f} s, pieces {[(round(x, 2), round(y, 2), round(z, 2)) for x, y, z in beats['pieces']]}, "
            f"drops at {[d['atS'] for d in beats['drops']]}")
        if a.no_resolve:
            for i, d in enumerate(beats["downbeats"]):
                nxt = [b for b in beats["beats"] if d - 1e-3 <= b][:4]
                print(f"bar {i + 1:2d}: " + " ".join(f"{x:6.2f}" for x in nxt))
    if a.no_resolve:
        return
    pm, project, tl = resolve_timeline(a.project, a.timeline)
    place_markers(tl, beats, a.fps, a.offset)
    if a.snap:
        snap(tl, beats, a.fps, a.offset, a.grid, a.max_nudge, a.cut, os.path.dirname(os.path.abspath(out)))
    pm.SaveProject()


if __name__ == "__main__":
    main()
