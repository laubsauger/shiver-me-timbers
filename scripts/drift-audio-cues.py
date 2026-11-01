#!/usr/bin/env python3
"""
THE SOUNDTRACK'S CUES for Act 1, Undertime: where Mark's music hits, swells, peaks and rests over its first 90 s,
baked into src/drift/undertime/audioCues.json so the act's key events can sit on the music (the 2026-11-01 brief:
"big collisions on hits, the wave's start on a swell, its crest at the zenith on the biggest peak, the text entries
on calm moments"). The film reads only the baked table (undertime/audioCues.ts): every frame stays a pure function
of show time t, and nothing listens to audio at run time.

    out/drift/data/.venv/bin/python scripts/drift-audio-cues.py [/Users/flo/Movies/drift_audio.wav] [--to 90]
        [--out src/drift/undertime/audioCues.json]

The soundtrack is locked to the timeline (770.47 s, 48 kHz stereo): this tool never moves a beat, it only says
where inside the beats the music has its moments.

WHAT IT MEASURES, on the mono sum, 2048-sample Hann frames every 512 samples (10.7 ms at 48 kHz):

  RMS        the loudness envelope, in dB, smoothed over 0.4 s (the "level") and over 2 s (the "tide").
  FLUX       spectral flux: the half-wave-rectified rise of log magnitude, bin by bin, summed — what a new note, a
             drum or a cymbal adds that was not there a frame before. Split into LOW (< 200 Hz: the body of a hit)
             and FULL.
  ONSETS     flux peaks above a moving median + k·MAD (0.6 s window), at least 0.12 s apart; strength = how far
             above the threshold, 0..1 over the act's 0–90 s. A "hit" is an onset that also carries low-band energy
             and a level jump (big collisions go there).
  SWELLS     stretches where the 1 s tide rises by at least 3 dB over at least 0.6 s; strength = the rise in dB / 12.
             (A 2 s tide over 1.2 s missed the sharp swell into the wave at 35.5 s.)
  PEAKS      local maxima of the 0.4 s level, at least 1.5 s apart, ranked; strength 0..1 against the loudest.
  CALM       windows of at least 1.5 s where the 1 s level sits in the act's quietest 40 % AND the 1 s flux under its
             median (either alone called the pulsing build at 31–39 s calm). Informative: the film picks its text
             entries from the envelope itself (audioCues.ts calmest).

Every number is in seconds of show time (the soundtrack starts at show 0).
"""
import json
import sys
from pathlib import Path

import numpy as np
from scipy.io import wavfile
from scipy.ndimage import median_filter, uniform_filter1d
from scipy.signal import find_peaks

ROOT = Path(__file__).resolve().parent.parent
args = sys.argv[1:]


def opt(name, default):
    if name in args:
        i = args.index(name)
        v = args[i + 1]
        del args[i : i + 2]
        return v
    return default


TO = float(opt("--to", 90))
OUT = Path(opt("--out", ROOT / "src/drift/undertime/audioCues.json"))
SRC = Path(args[0] if args else "/Users/flo/Movies/drift_audio.wav")

rate, raw = wavfile.read(SRC)
# 24-bit PCM arrives as int32 scaled to the full int32 range; normalise any integer type to ±1
x = raw.astype(np.float64)
if np.issubdtype(raw.dtype, np.integer):
    x /= float(np.iinfo(raw.dtype).max)
full_len = len(x) / rate
if x.ndim > 1:
    x = x.mean(axis=1)
x = x[: int(TO * rate)]

N = 2048
HOP = 512
frames = 1 + (len(x) - N) // HOP
win = np.hanning(N)
idx = np.arange(N)[None, :] + HOP * np.arange(frames)[:, None]
seg = x[idx] * win
spec = np.abs(np.fft.rfft(seg, axis=1))
freqs = np.fft.rfftfreq(N, 1 / rate)
fps = rate / HOP
times = (np.arange(frames) * HOP + N / 2) / rate

rms = np.sqrt((seg**2).mean(axis=1) + 1e-12)
db = 20 * np.log10(rms + 1e-9)
level = uniform_filter1d(db, max(1, int(0.4 * fps)))
tide = uniform_filter1d(db, max(1, int(1.0 * fps)))

logm = np.log1p(1000 * spec)
dlog = np.maximum(0, np.diff(logm, axis=0, prepend=logm[:1]))
flux = dlog.sum(axis=1)
low = dlog[:, freqs < 200].sum(axis=1)


def norm(v):
    lo, hi = np.percentile(v, 2), np.percentile(v, 99.5)
    return np.clip((v - lo) / max(1e-9, hi - lo), 0, 1)


fluxN = norm(uniform_filter1d(flux, 3))
lowN = norm(uniform_filter1d(low, 3))

# ONSETS: adaptive threshold on the flux
med = median_filter(fluxN, size=int(0.6 * fps) | 1)
mad = median_filter(np.abs(fluxN - med), size=int(0.6 * fps) | 1)
thr = med + 2.5 * mad + 0.04
pk, _ = find_peaks(fluxN, height=thr, distance=max(1, int(0.12 * fps)))
over = fluxN[pk] - thr[pk]
ostr = np.clip(over / max(1e-9, np.percentile(over, 98)), 0, 1) if len(pk) else over
# level jump across the onset: 0.25 s after against 0.25 s before (dB)
w = int(0.25 * fps)
jump = np.array([db[min(frames - 1, i + 1) : min(frames, i + w)].mean() - db[max(0, i - w) : max(1, i)].mean() for i in pk]) if len(pk) else np.array([])
onsets = []
for i, s, j in zip(pk, ostr, jump):
    hit = float(np.clip(0.5 * s + 0.3 * lowN[i] + 0.2 * np.clip(j / 9, 0, 1), 0, 1))
    onsets.append({"t": round(float(times[i]), 3), "strength": round(float(s), 3), "low": round(float(lowN[i]), 3), "jump": round(float(j), 2), "hit": round(hit, 3)})

# SWELLS: sustained rises of the tide
dt = np.gradient(tide) * fps  # dB/s
rising = dt > 0.8
swells = []
i = 0
while i < frames:
    if rising[i]:
        j = i
        while j < frames and rising[j]:
            j += 1
        dur = (j - i) / fps
        rise = tide[j - 1] - tide[i]
        if dur >= 0.6 and rise >= 3:
            k = i + int(np.argmax(dt[i:j]))
            swells.append({"t0": round(float(times[i]), 3), "t1": round(float(times[j - 1]), 3), "steepest": round(float(times[k]), 3), "rise": round(float(rise), 2), "strength": round(float(min(1, rise / 12)), 3)})
        i = j
    else:
        i += 1

# PEAKS: local maxima of the level
pp, _ = find_peaks(level, distance=int(1.5 * fps), prominence=1.5)
top = level.max()
peaks = sorted(
    [{"t": round(float(times[i]), 3), "db": round(float(level[i]), 2), "strength": round(float(np.clip(1 - (top - level[i]) / 24, 0, 1)), 3)} for i in pp],
    key=lambda e: -e["db"],
)

# CALM: quiet windows (level and flux both in the act's lower third)
lev1 = uniform_filter1d(db, int(1.0 * fps))
flux1 = uniform_filter1d(fluxN, int(1.0 * fps))
quiet = (lev1 <= np.percentile(lev1, 40)) & (flux1 <= np.percentile(flux1, 55))
calm = []
i = 0
while i < frames:
    if quiet[i]:
        j = i
        while j < frames and quiet[j]:
            j += 1
        if (j - i) / fps >= 1.5:
            calm.append({"t0": round(float(times[i]), 3), "t1": round(float(times[j - 1]), 3), "db": round(float(level[i:j].mean()), 2)})
        i = j
    else:
        i += 1

# the envelope at 20 Hz, for the film's curves (normalised 0..1 over 0–TO)
step = int(fps / 20)
levN = np.clip((level - np.percentile(level, 2)) / max(1e-9, top - np.percentile(level, 2)), 0, 1)
out = {
    "source": SRC.name,
    "duration": round(full_len, 3),
    "sampleRate": int(rate),
    "analysed": [0, TO],
    "hop": HOP,
    "note": "baked by scripts/drift-audio-cues.py; times in show s; read through src/drift/undertime/audioCues.ts",
    "envelopeRate": 20,
    "level": [round(float(v), 3) for v in levN[::step]],
    "flux": [round(float(v), 3) for v in uniform_filter1d(fluxN, step)[::step]],
    "onsets": onsets,
    "swells": swells,
    "peaks": peaks,
    "calm": calm,
}
OUT.write_text(json.dumps(out, separators=(",", ":")) + "\n")
print(f"{SRC.name}: {full_len:.2f} s at {rate} Hz; analysed 0–{TO:g} s -> {OUT.relative_to(ROOT) if OUT.is_relative_to(ROOT) else OUT}")
print(f"  {len(onsets)} onsets, {len(swells)} swells, {len(peaks)} peaks, {len(calm)} calm windows")
for o in sorted(onsets, key=lambda e: -e["hit"])[:16]:
    print(f"  hit {o['t']:7.2f}  {o['hit']:.2f}  (flux {o['strength']:.2f} low {o['low']:.2f} jump {o['jump']:+.1f} dB)")
for s in swells:
    print(f"  swell {s['t0']:6.2f}–{s['t1']:6.2f}  +{s['rise']:.1f} dB  steepest {s['steepest']:.2f}")
for p in peaks[:10]:
    print(f"  peak {p['t']:7.2f}  {p['db']:.1f} dB")
for c in calm:
    print(f"  calm {c['t0']:6.2f}–{c['t1']:6.2f}  {c['db']:.1f} dB")
