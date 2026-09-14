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
  `SFX engine` / `SFX water` / `SFX amb`, at the mix's record position and source range, and those tracks are MUTED —
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
- Untested against a running Resolve: `SetClipProperty('Start TC')`, `SetMetadata` and `SetTrackEnable` are guarded and
  print a warning instead of failing when the installed version refuses them.

A plan without `coverage` imports exactly as before.
