# Audio provenance

Every file under `assets/audio/` and where it came from. The repo's convention
is that provenance lives in the **filename** (`<source>-<slug>[-<id>]`), and
this file is the long form of the same information.

Two sources so far: recordings from Freesound, and sound effects generated with
ElevenLabs. They have different licence conditions — see each section.

---

## Generated — ElevenLabs text-to-sound-effects

Produced by `scripts/generate-sfx.mjs` (hand-run dev tool; the game never needs
an API key). Regenerating any file is `node scripts/generate-sfx.mjs --only <id>
--force`; the exact prompts live in that script's `MANIFEST` and are the
authoritative copy.

- **Generated:** 2026-08-18
- **Model:** `eleven_text_to_sound_v2`
- **Endpoint:** `POST https://api.elevenlabs.io/v1/sound-generation`
- **Output format:** `mp3_44100_128`

### Licence — READ THIS BEFORE SHIPPING COMMERCIALLY

ElevenLabs' Terms of Use grant **the account that generated the audio all
rights in the output** (§4(c)(ii): "you retain all rights in and to your
Output"), and impose **no attribution requirement**.

But commercial use depends on the **plan the key was on at generation time**
(§1(c)): a free-tier account "may only use the Services for non-commercial
purposes", while a paid subscription "may use the Services for commercial
purposes".

**This was not verified.** The API key used carried `sound_generation` but not
`user_read`, so the subscription tier could not be queried. If this project is
ever distributed commercially, confirm the generating account was on a paid
plan — and if it was not, regenerate these thirteen files from a paid account.
The prompts are preserved above precisely so that is a cheap operation.

### Files

| File | Sample name | Length | Used for |
|---|---|---|---|
| `elevenlabs-cannon-fire-a.mp3` | `cannonFireA` | 3.0 s | cannon report, round-robin take 1 |
| `elevenlabs-cannon-fire-b.mp3` | `cannonFireB` | 3.0 s | cannon report, round-robin take 2 |
| `elevenlabs-cannon-fire-c.mp3` | `cannonFireC` | 3.0 s | cannon report, round-robin take 3 |
| `elevenlabs-wood-splinter-a.mp3` | `woodSplinterA` | 0.5 s | splintering timber (head trimmed, see below) |
| `elevenlabs-wood-splinter-b.mp3` | `woodSplinterB` | 1.2 s | splintering timber |
| `elevenlabs-mast-break.mp3` | `mastBreakCrack` | 3.5 s | a mast letting go |
| `elevenlabs-ball-splash-a.mp3` | `ballSplashA` | 2.0 s | shot into the sea |
| `elevenlabs-ball-splash-b.mp3` | `ballSplashB` | 2.0 s | shot into the sea |
| `elevenlabs-canvas-crack-a.mp3` | `canvasCrackA` | 1.5 s | haul rustle texture (sustained luffing) |
| `elevenlabs-canvas-crack-b.mp3` | `canvasCrackB` | 1.5 s | sail snap, joins the dropcloth takes |
| `elevenlabs-ball-whoosh-a.mp3` | `ballWhooshA` | 1.2 s | shot passing overhead |
| `elevenlabs-ball-whoosh-b.mp3` | `ballWhooshB` | 1.2 s | shot passing overhead |
| `elevenlabs-rope-block.mp3` | `ropeBlock` | 1.5 s | haul rustle texture |

Total ≈ 400 KB, against ~30 MB of recordings — they are deliberately late in
`LOAD_ORDER` relative to the bed but ahead of the two multi-MB loops.

### Post-processing applied (all in `generate-sfx.mjs`)

The model's raw output was not directly usable in two ways, both of which
matter and neither of which is audible as a "bad sample" until it is in the mix:

1. **Level-matching within each round-robin group** (`--normalize`). The three
   cannon takes came back spread over **10 dB** (RMS −22.0 / −31.8 / −23.0).
   Rotating between takes of different loudness does not read as variation, it
   reads as the gun misfiring every third shot — reintroducing the exact defect
   the variations exist to remove. Each group is scaled by **pure gain** (no
   compression, no limiting: these are impacts, and the transient *is* the
   sound) to a common RMS that every member can reach with its peak still under
   −1 dBFS. Levels *between* groups are deliberately untouched — a rope block
   must not be as loud as a cannon, and that balance belongs to
   `src/params/audio.ts`.
2. **Head trim on `wood-splinter-a`** (`trimStart: 0.7`). The take arrived as a
   small tick, ~650 ms of near-silence, then the actual splinter at 710 ms.
   Fired at the moment a ball lands, that arrives as a separate unrelated event
   three quarters of a second late. Trimmed to the real onset; the tail was
   fine, only the lead-in was dead.

---

## Recorded — Freesound

Filenames carry the uploader and the Freesound sound ID, e.g.
`freesound_community-canvas-dropcloth-snap-1-98862.mp3` is sound **98862**.
Each is viewable at `https://freesound.org/s/<id>/`.

| File | Freesound ID | Used for |
|---|---|---|
| `rmultimediaeu-ocean-waves-250310.mp3` | 250310 | ocean bed layer |
| `freesound_community-sailboat-cockpit-at-12kn-wind-speed-17465.mp3` | 17465 | wind bed layer (captured at 12 kn — its neutral playback rate) |
| `freesound_community-pope-sailing-wake-26126.mp3` | 26126 | wake + bow rush loops, bow splash and slam slices |
| `freesound_community-water-under-boat-gurgling-waves-manitoulin-05-55844.mp3` | 55844 | hull gurgle at the waterline |
| `freesound_community-canvas-dropcloth-snap-1-98862.mp3` | 98862 | canvas snap take 1 |
| `freesound_community-canvas-dropcloth-snap-2-98861.mp3` | 98861 | canvas snap take 2 |
| `freesound_community-saildeploy-99393.mp3` | 99393 | sail deploy + haul rustle slices |
| `joelfazhari-wooden-ship-interior-ambience-3min-loop-361505.mp3` | 361505 | wooden creak bed, rig creak loop, groans, sink/mast-break tail |
| `dammafra-sailing-435998.mp3` | 435998 | general sailing bed layer |

**Licences not verified.** Freesound hosts sounds under a range of Creative
Commons licences (CC0, CC-BY, CC-BY-NC), and which one applies is per-sound.
Some of these require attribution and at least one licence in common use on the
platform forbids commercial use. Before any commercial release, check each ID
above and record the actual licence here.

`freesound_community-water-under-boat-gurgling-waves-manitoulin-05-55844 (1).mp3`
is a byte-identical duplicate of 55844 and is referenced by nothing — a test in
`tests/audio.test.ts` asserts the manifest never points at it.

---

## Music

`assets/audio/music/` is discovered by glob at build time, not by manifest —
drop a file in and it is in the game (`src/audio/musicAssets.ts`). Provenance
for those tracks is not recorded here yet.

---

## Radio (§T.150 / §V87) — placeholder, generated

`assets/audio/radio/` holds the shortwave content the cabin set plays. It is
declared in `src/radio/stations.ts`, **not** in `src/audio/assets.ts`: a station,
a frequency or a clip is a manifest edit plus a file drop, and no code path
branches on which teaching it is (§V87).

Every file here is a **synthesised placeholder** standing in for the Watts
fragments, made with ffmpeg — no third-party audio, no licence question. They
are warbling formant tones at speech rate: unintelligible on purpose, so nobody
mistakes them for content, but they carry through the static the way a voice
does and they behave correctly under the tuner's gain and HRTF.

| file | stands in for |
|---|---|
| `wiggle-a.mp3`, `wiggle-b.mp3` | The Wiggle — fragments |
| `wiggle-night.mp3` | …and its night callback |
| `treetops-a.mp3`, `treetops-b.mp3`, `treetops-night.mp3` | Treetops |
| `lagoon-a.mp3`, `lagoon-b.mp3`, `lagoon-night.mp3` | The Still Lagoon |
| `lock-chime.mp3` | the soft chime a station lock makes (design doc §05) |

Regenerated with, e.g.:

```sh
ffmpeg -nostdin -y -f lavfi \
  -i "aevalsrc=0.33*sin(2*PI*t*(196+34*sin(2*PI*2.7*t)))*(0.35+0.65*abs(sin(2*PI*2.1*t)))*exp(-0.18*t):s=32000:d=3.4" \
  -ac 1 -c:a libmp3lame -b:a 48k assets/audio/radio/wiggle-a.mp3
```

**To swap in real clips:** drop the mp3s in this directory and point
`RADIO_STATIONS` at them. Nothing else changes — `tests/radio.test.ts` proves a
fourth station is a data edit.
