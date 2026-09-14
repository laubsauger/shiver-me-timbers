#!/usr/bin/env python3
"""
Quick H.264 review render of a timeline through Resolve's render queue.

    python3 scripts/resolve/render_review.py <out.mp4> [--timeline "<name>"] [--lock <dir>] [--max-min 10]

--lock: a shared GPU lock directory (mkdir-atomic, see the agents' GPU-LOCK-RULES.md). The render waits until it can
create it, writes an owner line, and removes it when done or on failure; --max-min stops a render that overruns.
"""
import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from resolve_common import PROJECT, connect, fail, find_timeline, log  # noqa: E402

TAG = "render_review"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--project", default=PROJECT)
    ap.add_argument("--timeline", default="★ sb-trailer-v2 — MAIN (Reef Runner EX)")
    ap.add_argument("--lock")
    ap.add_argument("--max-min", type=float, default=10.0)
    a = ap.parse_args()

    out = os.path.abspath(a.out)
    resolve, pm, project = connect(a.project, TAG)
    tl = find_timeline(project, a.timeline) or fail(TAG, f"no timeline '{a.timeline}'")
    project.SetCurrentTimeline(tl)
    resolve.OpenPage("deliver")
    if not project.SetCurrentRenderFormatAndCodec("mp4", "H264"):
        fail(TAG, "mp4/H264 not available")
    project.SetCurrentRenderMode(1)
    settings = {"SelectAllFrames": True, "TargetDir": os.path.dirname(out),
                "CustomName": os.path.splitext(os.path.basename(out))[0], "FormatWidth": 1920, "FormatHeight": 1080,
                "FrameRate": float(tl.GetSetting("timelineFrameRate") or 30), "ExportVideo": True, "ExportAudio": True,
                "VideoQuality": "High", "AudioCodec": "aac"}
    essential = {"SelectAllFrames", "TargetDir", "CustomName", "FormatWidth", "FormatHeight"}
    for k, v in settings.items():  # one by one: Resolve refuses a whole dict for one unsupported key
        if not project.SetRenderSettings({k: v}):
            (fail if k in essential else lambda t, m: log(t, "warning: " + m))(TAG, f"render setting {k}={v!r} refused")

    locked = False
    try:
        if a.lock:
            while True:
                try:
                    os.mkdir(a.lock)
                    break
                except FileExistsError:
                    log(TAG, "GPU lock busy, waiting 20 s")
                    time.sleep(20)
            locked = True
            with open(os.path.join(a.lock, "owner"), "w") as f:
                f.write(f"resolve-review-render {int(time.time())} Resolve H.264 review of '{a.timeline}'\n")
        project.DeleteAllRenderJobs()
        job = project.AddRenderJob() or fail(TAG, "AddRenderJob failed")
        t0 = time.time()
        if not project.StartRendering([job], isInteractiveMode=False):
            fail(TAG, "StartRendering failed")
        while project.IsRenderingInProgress():
            if time.time() - t0 > a.max_min * 60:
                project.StopRendering()
                fail(TAG, f"render overran {a.max_min} min, stopped")
            time.sleep(5)
        st = project.GetRenderJobStatus(job)
        log(TAG, f"{st} in {time.time() - t0:.0f} s → {out}")
        if st.get("JobStatus") != "Complete":
            fail(TAG, f"render did not complete: {st}")
    finally:
        if locked:
            for n in os.listdir(a.lock):
                os.remove(os.path.join(a.lock, n))
            os.rmdir(a.lock)
        resolve.OpenPage("edit")


if __name__ == "__main__":
    main()
