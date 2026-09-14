"""
Shared plumbing for the scripts/resolve/ tools (DaVinci Resolve Studio external scripting, Preferences → System →
General → External scripting using: Local).

- connect(): reach a running Resolve (launches it with `open -a` and waits when it is not up) and load the project
- ready(): is a render agent's output file complete (not _FAILED/.part, mtime settled, ffprobe reads it)
- PoolIndex: every media pool item by file path and by clip name (idempotent imports, relinks)
- bins, timelines, frame/TC helpers
- OTIO builders: a timeline built as a Resolve-flavoured .otio and imported with ImportTimelineFromFile links to the
  EXISTING pool items (importSourceClips False) and is the only API path that gives adjustment clips of any length,
  transitions (fades, dissolves) and disabled clips in one go (verified on Resolve Studio 21.0.0.47).
"""
import json
import os
import subprocess
import sys
import time

API = "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting"
LIB = "/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so"
os.environ.setdefault("RESOLVE_SCRIPT_API", API)
os.environ.setdefault("RESOLVE_SCRIPT_LIB", LIB)
sys.path.append(os.path.join(os.environ["RESOLVE_SCRIPT_API"], "Modules"))

import DaVinciResolveScript as dvr  # noqa: E402

PROJECT = "Shiver - Speedboat Trailer - MCP"


def log(tag, msg):
    print(f"[{tag}] {msg}", flush=True)


def fail(tag, msg):
    print(f"[{tag}] ERROR: {msg}", file=sys.stderr, flush=True)
    sys.exit(1)


def connect(project_name=PROJECT, tag="resolve", launch_wait_s=120):
    resolve = dvr.scriptapp("Resolve")
    if not resolve:
        log(tag, "Resolve not reachable, launching it")
        subprocess.run(["open", "-a", "DaVinci Resolve"], check=False)
        t0 = time.time()
        while not resolve and time.time() - t0 < launch_wait_s:
            time.sleep(5)
            resolve = dvr.scriptapp("Resolve")
        if not resolve:
            fail(tag, "Resolve did not come up (external scripting set to Local?)")
    pm = resolve.GetProjectManager()
    cur = pm.GetCurrentProject()
    project = cur if cur and cur.GetName() == project_name else pm.LoadProject(project_name)
    if not project:
        fail(tag, f"project not found: {project_name} (it is not created by these scripts)")
    return resolve, pm, project


# ---------------------------------------------------------------- render-agent output

def probe(path):
    """ffprobe summary of the first video or audio stream, or None when ffprobe cannot read the file"""
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                              "stream=codec_type,width,height,r_frame_rate,nb_frames,duration,sample_rate",
                              "-of", "json", path], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if out.returncode != 0:
        return None
    streams = json.loads(out.stdout or "{}").get("streams") or []
    return streams[0] if streams else None


def ready(path, settle_s=60):
    """a take another agent is still writing is NOT ready: _FAILED / .part names, mtime younger than settle_s, or a
    file ffprobe cannot read"""
    name = os.path.basename(path)
    if "_FAILED" in name or name.endswith(".part") or not os.path.isfile(path):
        return False
    if time.time() - os.path.getmtime(path) < settle_s:
        return False
    return probe(path) is not None


# ---------------------------------------------------------------- media pool

class PoolIndex:
    """every clip in the pool (recursive) by absolute file path and by clip name"""

    def __init__(self, pool):
        self.pool = pool
        self.by_path = {}
        self.by_name = {}
        self.folder_of = {}
        self._walk(pool.GetRootFolder())

    def _walk(self, folder):
        for c in folder.GetClipList() or []:
            path = c.GetClipProperty("File Path") or ""
            if path:
                self.by_path[os.path.realpath(path)] = c
            self.by_name.setdefault(c.GetName(), c)
            self.folder_of[c.GetUniqueId()] = folder
        for s in folder.GetSubFolderList() or []:
            self._walk(s)

    def get(self, path):
        return self.by_path.get(os.path.realpath(path))

    def import_into(self, folder, path, tag="resolve"):
        """the existing item for this file, or a fresh import into `folder`; never a duplicate"""
        item = self.get(path)
        if item:
            return item, False
        self.pool.SetCurrentFolder(folder)
        got = self.pool.ImportMedia([path])
        if not got:
            log(tag, f"warning: Resolve refused to import {path}")
            return None, False
        item = got[0]
        self.by_path[os.path.realpath(path)] = item
        self.by_name.setdefault(item.GetName(), item)
        self.folder_of[item.GetUniqueId()] = folder
        return item, True


def sub_folder(pool, parent, name):
    return next((s for s in parent.GetSubFolderList() if s.GetName() == name), None) or pool.AddSubFolder(parent, name)


def folder_path(pool, *names):
    f = pool.GetRootFolder()
    for n in names:
        f = sub_folder(pool, f, n)
    return f


# ---------------------------------------------------------------- timelines

def timelines(project):
    return [project.GetTimelineByIndex(i + 1) for i in range(project.GetTimelineCount())]


def find_timeline(project, name):
    return next((t for t in timelines(project) if t.GetName() == name), None)


def clip_name(path):
    """media pool clip name = the file name (Resolve keeps the extension); the edit refers to clips without it"""
    return os.path.splitext(os.path.basename(path))[0]


def tc_to_frames(tc, fps):
    h, m, s, f = (int(x) for x in tc.replace(";", ":").split(":"))
    r = int(round(fps))
    return ((h * 60 + m) * 60 + s) * r + f


def frames_to_tc(frames, fps):
    """non-drop-frame HH:MM:SS:FF at an integer-rounded rate (the trailer renders 30 or 60)"""
    r = int(round(fps))
    ff = frames % r
    s = frames // r
    return f"{s // 3600:02d}:{(s // 60) % 60:02d}:{s % 60:02d}:{ff:02d}"


# ---------------------------------------------------------------- OTIO (Resolve flavour)

def _rt(v, fps):
    return {"OTIO_SCHEMA": "RationalTime.1", "rate": float(fps), "value": float(v)}


def _tr(start, dur, fps):
    return {"OTIO_SCHEMA": "TimeRange.1", "start_time": _rt(start, fps), "duration": _rt(dur, fps)}


def otio_gap(frames, fps):
    return {"OTIO_SCHEMA": "Gap.1", "metadata": {}, "name": "", "source_range": _tr(0, frames, fps),
            "effects": [], "markers": [], "enabled": True}


def otio_media_clip(path, media_start_frame, media_frames, src_in, frames, fps, enabled=True, audio=False):
    """src_in: frames from the file's first frame; media_start_frame: the pool item's Start TC in frames"""
    meta = {"Resolve_OTIO": {}}
    if audio:
        meta = {"Resolve_OTIO": {"Channels": [{"Source Channel ID": 0, "Source Track ID": 0},
                                             {"Source Channel ID": 1, "Source Track ID": 0}]}}
    return {"OTIO_SCHEMA": "Clip.2", "metadata": meta, "name": os.path.basename(path),
            "source_range": _tr(media_start_frame + src_in, frames, fps), "effects": [], "markers": [],
            "enabled": enabled,
            "media_references": {"DEFAULT_MEDIA": {
                "OTIO_SCHEMA": "ExternalReference.1", "metadata": {}, "name": os.path.basename(path),
                "available_range": _tr(media_start_frame, media_frames, fps), "available_image_bounds": None,
                "target_url": path}},
            "active_media_reference_key": "DEFAULT_MEDIA"}


def otio_volume(clip, db):
    """clip level in dB (Resolve's Fairlight clip volume; format read back from an FCPXML adjust-volume import)"""
    clip["effects"] = [{"OTIO_SCHEMA": "Effect.1", "name": "", "effect_name": "Resolve Effect", "metadata": {"Resolve_OTIO": {
        "Display Type": 1, "Effect Name": "Fairlight Clip Volume and Fades", "Enabled": True, "Name": "Volume",
        "Parameters": [{"Default Parameter Value": 0.0, "Key Frames": {}, "Parameter ID": "volume",
                        "Parameter Value": float(db), "Variant Type": "Double", "maxValue": 30.0, "minValue": -100.0}],
        "Type": 62}}}]
    return clip


def otio_generator(kind, frames, fps, enabled=True, name=None):
    """kind: 'Adjustment Clip' or 'Solid Color' (Text+ does NOT survive OTIO: it imports as an offline placeholder)"""
    return {"OTIO_SCHEMA": "Clip.2", "metadata": {"Resolve_OTIO": {}}, "name": name or kind,
            "source_range": _tr(0, frames, fps), "effects": [], "markers": [], "enabled": enabled,
            "media_references": {"DEFAULT_MEDIA": {
                "OTIO_SCHEMA": "GeneratorReference.1", "metadata": {"Resolve_OTIO": {"Generator Type": kind}},
                "name": kind, "available_range": None, "available_image_bounds": None, "generator_kind": kind,
                "parameters": {"Resolve_OTIO": []}}},
            "active_media_reference_key": "DEFAULT_MEDIA"}


def otio_dissolve(in_frames, out_frames, fps):
    """a cross dissolve centred on the cut between its neighbours; at a track's head/tail (gap neighbour) a fade"""
    return {"OTIO_SCHEMA": "Transition.1", "metadata": {}, "name": "Cross Dissolve",
            "transition_type": "SMPTE_Dissolve", "in_offset": _rt(in_frames, fps), "out_offset": _rt(out_frames, fps)}


def otio_track(name, kind, children, audio_type="Stereo"):
    meta = {"Resolve_OTIO": {"Locked": False}}
    if kind == "Audio":
        meta = {"Resolve_OTIO": {"Audio Type": audio_type, "Locked": False, "SoloOn": False}}
    return {"OTIO_SCHEMA": "Track.1", "metadata": meta, "name": name, "source_range": None, "effects": [],
            "markers": [], "enabled": True, "children": children, "kind": kind}


def otio_timeline(name, tracks, fps, start_frame):
    return {"OTIO_SCHEMA": "Timeline.1", "metadata": {"Resolve_OTIO": {"Resolve OTIO Meta Version": "1.0"}},
            "name": name, "global_start_time": _rt(start_frame, fps),
            "tracks": {"OTIO_SCHEMA": "Stack.1", "metadata": {}, "name": "", "source_range": None, "effects": [],
                       "markers": [], "enabled": True, "children": tracks}}


def sequence(events, fps):
    """[(record_frame, item)] sorted, non-overlapping → OTIO children with gaps (items carry their own duration)"""
    out, cursor = [], 0
    for rec, item, frames in sorted(events, key=lambda e: e[0]):
        if rec < cursor:
            raise ValueError(f"overlap at record frame {rec} (< {cursor}) on one track: {item.get('name')}")
        if rec > cursor:
            out.append(otio_gap(rec - cursor, fps))
        out.append(item)
        cursor = rec + frames
    return out, cursor
