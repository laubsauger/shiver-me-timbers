# Trailer edit plan — the handoff from in-engine capture to DaVinci Resolve

The cine recorder writes one `edit-plan.json` next to the rendered clips. `scripts/resolve/trailer_import.py`
reads it and builds the Resolve timeline through Resolve Studio's external scripting API (no manual import).
The JSON is the source of truth; an `.otio`/EDL may be written as well for humans, but the importer does not
need it.

## Layout

```
out/cine/<plan.name>/
  edit-plan.json
  video/<clip>.mov        # master (e.g. ProRes 422 HQ, 3840×2160)
  proxy/<clip>.mov        # optional 1920×1080 proxy, same name
  sfx/<clip>.wav          # SFX MIX (all SFX + ambience, no music/radio), 48 kHz 24-bit PCM, same length as the clip
  sfx/<clip>_engine.wav   # optional split stems of the same take, same length: engine / water / amb
  sfx/<clip>_water.wav
  sfx/<clip>_amb.wav
```

## Schema (`edit-plan.json`)

```jsonc
{
  "name": "sb-trailer-v1",            // Resolve timeline name
  "fps": 60,                          // timeline + clip frame rate (integer or 29.97 etc.)
  "width": 3840, "height": 2160,      // timeline resolution
  "durationS": 60,                    // target timeline length
  "shots": [
    {
      "id": "07",
      "name": "rear-chase",
      "video": "video/sb-trailer-v1_07_rear-chase_take01.mov",
      "proxy": "proxy/sb-trailer-v1_07_rear-chase_take01.mov",   // optional
      "sfx": "sfx/sb-trailer-v1_07_rear-chase_take01.wav",       // optional: the SFX mix
      "sfxStems": {                   // optional: split stems, any subset (only files that exist are listed)
        "engine": "sfx/sb-trailer-v1_07_rear-chase_take01_engine.wav",
        "water": "sfx/sb-trailer-v1_07_rear-chase_take01_water.wav",
        "amb": "sfx/sb-trailer-v1_07_rear-chase_take01_amb.wav"
      },
      "handleS": 1.0,                 // seconds of extra footage before AND after the used range
      "recordInS": 15.0,              // where the used range starts on the timeline
      "recordOutS": 19.0,             // where it ends (exclusive)
      "notes": "Hard cut to rear chase. Music drops hard.",
      "alternates": [                 // optional: the SAME take at other times of day (speedboat trailer variants)
        { "variant": "sunset", "video": "video/sb-trailer-v2_10_bow-lookback_sunset_take01.mov",
          "proxy": "proxy/sb-trailer-v2_10_bow-lookback_sunset_take01.mov" },    // proxy optional
        { "variant": "night", "video": "video/sb-trailer-v2_10_bow-lookback_night_take01.mov" }
      ]
    }
  ],
  "markers": [                        // rhythm cues from the script (timeline seconds)
    { "atS": 15.0, "name": "music drop", "color": "Red", "note": "hard launch into action" }
  ],
  "slots": [                          // empty placeholders the editor fills in Resolve
    { "kind": "title", "recordInS": 56.0, "recordOutS": 60.0, "name": "17 title on black" },
    { "kind": "music", "track": "A3", "name": "music (user)" }
  ]
}
```

Semantics:

- A clip's file holds `handleS + (recordOutS − recordInS) + handleS` seconds. The importer places the middle
  range (source in = `handleS`) at `recordInS`; the handles stay available for trimming to music.
- Video goes on V1, the SFX mix on A1 at the same record position; A2 is left for extra SFX, A3 for music.
- `sfxStems` (optional, backwards compatible): each named stem goes on its own stereo track from A4 on, named
  `SFX engine` / `SFX water` / `SFX amb`, at the mix's record position and source range, and those tracks are MUTED (disabled) —
  the mix already contains them; unmute a stem to push the engine or the water against the music. Stems are captured
  LOSSLESS in the same real-time pass as the mix (an AudioWorklet tap on the page's buses, float PCM to the sink,
  written as 48 kHz 24-bit WAV) and cut at the same sample, so mix and stems are sample-aligned with each other.
- Paths are relative to the plan file.
- `alternates` (optional, backwards compatible): each is the same take as the shot's `video` — same choreography,
  camera, sea and frame count — rendered at another time of day, so the editor can strobe between them on a beat. The
  importer gives each variant name its own video track above V1, named `ToD: <variant>` (first-seen order), places the
  alternate at the shot's `recordInS` with the same handles, disables those tracks (V1 stays the picture), and puts the
  alternate clips in a `ToD variants` bin. There is ONE sfx stem per shot (the audio is identical across variants). A
  plan with no alternates gets no extra tracks and no bin. The primary of a variant shot carries its own time in its
  name (`…_10_bow-lookback_dusk_take01`).

## Coverage (`coverage[]`, optional)

Coverage shooting renders each choreographed run (a **setup** = one shot's run, or a coverage-only run with no place on
the assembly) through several lenses from the same simulated instant, so every camera of a setup covers the same sim
interval and is fully cuttable. The plan lists every such clip:

```jsonc
"coverage": [
  {
    "setup": "07",                    // the run's shot id
    "setupName": "rear-chase-launch",
    "camera": "windshield-back",      // "main" = the shot's own lens
    "kind": "mount",                  // wide | chase | front | abeam | mount | tele | insert (main: its primitive)
    "tier": "A",                      // A ⊂ B ⊂ C render/import priority
    "timeOfDay": "sunset",
    "video": "video/sb-trailer-v2_07_rear-chase-launch_cam-windshield-back_take01.mov",
    "proxy": "proxy/…",               // optional
    "sfx": "sfx/sb-trailer-v2_07_rear-chase-launch_take01.wav",   // optional: ONE stem per setup, shared by every lens
    "sourceStartS": -1.0,             // the setup's shot time at the clip's first frame (= −handle)
    "durationS": 6.0,                 // handle + shot + handle
    "onAssembly": false,              // true only for the main lens at the primary time of an assembly shot
    "notes": "Windshield/dash mount looking back at the pilot…"
  }
]
```

Clip names: `<plan>_<id>_<slug>_cam-<camera>[_<time>]_take<NN>`; the main lens has no `_cam-` part (so the assembly's
V1 clip is also its setup's `main` coverage clip). The sink keeps each entry on its own newest take on disk and drops
entries whose video is missing (and a missing proxy/sfx key).

What the importer does (after the assembly timeline; `--no-coverage` skips it, `--tier A|B|C` limits it):

- **Bins**: `<plan name>/Coverage/<setup>_<setupName>/`, with a sub-bin per time of day when a setup has more than one.
- **Timecode**: every clip's Start TC = 01:00:00:00 + (its `sourceStartS` − the setup's earliest `sourceStartS`) —
  every lens of a setup shares one TC, so the setup clock lines up. Camera / kind / tier / time go into the clip
  comments (and `Camera #` metadata where the API has it).
- **Per-setup timeline**: `<plan name> — cov <setup> <setupName>`, each camera × time on its own video track named
  `<camera> · <time>`, all at the same record frame; only the main lens at the primary time is enabled; the setup's
  sfx on A1.
- **Multicam**: Resolve's scripting API cannot create multicam clips. The stacked-track timeline is the substitute; for a
  real multicam clip select a setup's bin clips and use *Create Multicam Clip Using Selected Clips* (sync by Start TC).

A plan without `coverage` imports exactly as before.

## Resolve side (run against Resolve Studio 21.0.0.47, 2026-09-14/15)

All under `scripts/resolve/`, project "Shiver - Speedboat Trailer - MCP". Re-run after takes land; everything is
idempotent, only COMPLETE takes are used (no `_FAILED`/`.part`, unmodified for 60 s, ffprobe reads it), and generated
timelines are rebuilt under their own names, never duplicated (hand edits belong in a duplicate or in the cut list).

```bash
python3 scripts/resolve/trailer_import.py <out>/edit-plan.json            # media, bins, "ZZ old assembly", cov timelines
.venv/bin/python scripts/resolve/tod_blend.py <out> --out <blends dir>     # pre-composited time-of-day blends → pool
python3 scripts/resolve/trailer_edit.py <out>/edit-plan.json --cut scripts/resolve/sb-trailer-v2.cut.reef-runner.json --work <scratch>
.venv/bin/python scripts/resolve/music_beats.py <song> [--snap]            # beats.json + markers (+ cut nudges)
python3 scripts/resolve/used_clips.py <out> --out used_clips.json --alt "ZZ alt — …"   # what a full-res record needs
python3 scripts/resolve/relink_final.py <final out> [--blends-out <dir> --python .venv/bin/python]
python3 scripts/resolve/render_review.py <out.mp4> [--timeline …] [--lock <gpu.lock>]
```

- **Timelines**: `★ sb-trailer-v2 — MAIN (Reef Runner EX)` (primary), `ZZ alt — temp music (Dead Channel)`, `ZZ alt —
  unscored` (a `base` variant of the Dead Channel cut without the song), `ZZ old assembly` (the plan's 60 s default
  order); per-setup `sb-trailer-v2 — cov …` timelines live in the Coverage bin.
- **Format**: 1920×1080 at the plan's fps (`--format`), whatever the size of the pass on disk (640×360 stand-ins now).
- **Bins** (`sb-trailer-v2/`): `Coverage/<setup>/[<time>/]`, `Inserts/…`, `ToD variants/…`, `SFX mix/`, `SFX stems/`,
  `Blends/`, `Music/`, `Timelines/`.
- **Cut lists** (`sb-trailer-v2.cut.*.json`): events in story order — clip base name (newest ready take), `src`,
  `dur` or `until: [song bar, beat]` (beats.json of the song, played UNEDITED from 0:00 with `music.fadeOutS` at the
  picture end; the user rejected bar-edited music), `align: {atSrc, on}` (a source second on a song position),
  `dissolveS`, `fallback` stand-ins, `sfxDb` (SFX mix clip level), `duck` (a subtle music dip between two source
  seconds, snapping back on the second), `engineAccent` (the event's engine stem on SFX extra), `sfxFrom` (a blend's
  SFX), `title`/`titles` (wordmark / credits cards), `music` cue markers. A cut that needs more source than a clip has
  fails loudly.
- **Tracks**: V1 PICTURE, V2 06c NIGHT (spare), V3 TITLES, V4 LOOK, V5 VHS 80s (off), V6 LETTERBOX 2.39 (off); A1 SFX mix,
  A2 SFX extra (engine accents), A3 MUSIC (user), A4/A5 engine/water stems (muted).
- **Time-of-day blends** (`tod_blend.py`, `sb-trailer-v2.blends.json`): frame-identical looks of one take mixed per frame
  in ~linear light with smoothstep stops into one ProRes clip (highest take every layer has; strip PNG + a pop metric per
  clip). MAIN uses the hand (R5, sunset→night, starting 0.6 s after the push) and the setup-10 nightfall on bow-aft →
  windshield-back → shoulder (sunset→dusk→night, one shared source-time curve so the light is continuous across cuts;
  the MAIN cut's time of day never steps back — checked per shot). `relink_final.py --blends-out` re-renders them from
  the 1080p masters.
- **Lever frames** (shotlist.ts: the glove finishes its reach 0.1 s before the throttle rises at shot t 0, the lever is
  full at 1.2 s; plus handles, checked on frame strips): 06 (handle 1.5 s) touch f42 / push f45 / full f81; R5 (handle
  2 s) touch f57 / push f60 / full f96. MAIN puts 06's full frame on the main drop (28.05) and R5's on the cut to the
  time-lapse; the music dips −3.5 dB from the touch and snaps back on the full frame (no low-pass: not scriptable).
- **Title / credits**: "speedboat" in Saira Stencil One and "made by @laub69" in Saira Condensed, bone #EDE6D6 with a faint
  halo, Fusion Text+ under the LOOK clip; the repo's OFL woff2 fonts converted to TTF in ~/Library/Fonts (fontTools).
- **Look** (`sb-trailer-v2.look.json`, all light on purpose): CDL per time of day on node 1 + colour groups; on the LOOK
  adjustment clip a Fusion chain: soften, Film Look Creator (contrast/rolloff, toned blacks, split tone, halation,
  bloom, a hint of flicker and gate weave), glint glow, faint anamorphic streak, slight barrel + edge fringe, ~12 %
  vignette, 35 mm grain weighted to the shadows. VHS (blur, AnalogDamage, fringe, scanlines) and the 2.39 letterbox are
  disabled adjustment clips. No master-bus dynamics by API (Fairlight by hand).
- **Beats**: librosa (venv): 4/4 downbeats by low-band phase, sections, energy, drops on the beat they land on;
  synthetic 120 BPM click: phase right, beats ~31 ms late, sections 32.0/48.0/56.0 s, drops 32.02/56.03 s.

API facts learned live (they shaped the scripts):

- `AppendToTimeline` `endFrame` is exclusive (the old importer lost a frame per shot).
- Changing a pool clip's Start TC after it is cut into a timeline unlinks those timeline items: set it before placing.
- `MediaPoolItem.ReplaceClip` resets Start TC to the file's and unlinks every timeline item cut from the clip;
  `ReplaceClipPreserveSubClip` keeps the link but slides the source. `MediaPool.RelinkClips([item], folder)` keeps both
  (a 1080p file relinked under a 640×360 clip framed identically; the clip's `Resolution` attribute stays stale).
- No track mute call: `SetTrackEnable('audio', i, False)`. No clip volume call either, but the OTIO import takes it: an
  `Effect.1` with `effect_name: "Resolve Effect"` and Resolve_OTIO `Fairlight Clip Volume and Fades` / Parameter ID
  `volume` (format read back from an FCPXML `adjust-volume` import; without that `effect_name` it is silently dropped).
- Fusion expressions: `sin()` takes DEGREES. Text+ `Size` 1.0 = a 971.5 px em on a 1080p comp; `CharacterSpacing` adds
  0.0193 em per gap per 0.01 (measured).
- `ImportTimelineFromFile(.otio, importSourceClips=False, sourceClipsFolders=[…])` links to existing pool clips and
  honours gaps, cross dissolves (a dissolve at a track's head/tail is a fade), disabled clips and `Adjustment Clip` /
  `Solid Color` generators of any length. Text+ does not survive OTIO (offline placeholder).
- `InsertFusionTitleIntoTimeline('Text+')` inserts 5 s at the playhead on the track of the last `AppendToTimeline`d clip,
  as a ripple INSERT on every unlocked track: lock the rest first.
- The timeline node graph (`Timeline.GetNodeGraph()`) has 0 nodes and no API adds any; DRX grades are zstd/protobuf
  blobs. So the finishing is a Fusion comp on an adjustment clip and the base grade is a per-clip CDL on node 1.
- Marker colours are Resolve's 16 (the plan's `Orange` maps to `Sand`); one marker per frame.
- `Composite` opacity keyframes also import from OTIO (Parameter ID `opacity`, `Key Frames` {frame: {Value}}); the clip
  volume takes the same `Key Frames` form (used for the music dips).
- Fusion effects on adjustment clips work, but a freshly (re)built Fusion chain can take seconds to show in the viewer:
  `ExportCurrentFrameAsStill` right after a change may grab the unprocessed frame; renders are always processed.
- `SetRenderSettings` refuses the whole dict for one unsupported key (`VideoQuality: "High"` for H.264): set keys one by
  one. A 107 s 1080p review of the 640×360 stand-ins renders in ~12 s.
