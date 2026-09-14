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
  sfx/<clip>.wav          # engine / wake / spray stem, same length as the video clip
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
      "sfx": "sfx/sb-trailer-v1_07_rear-chase_take01.wav",       // optional
      "handleS": 1.0,                 // seconds of extra footage before AND after the used range
      "recordInS": 15.0,              // where the used range starts on the timeline
      "recordOutS": 19.0,             // where it ends (exclusive)
      "notes": "Hard cut to rear chase. Music drops hard."
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
- Video goes on V1, SFX stems on A1 at the same record position; A2 is left for extra SFX, A3 for music.
- Paths are relative to the plan file.
