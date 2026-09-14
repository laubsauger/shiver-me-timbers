# Speedboat trailer: post-production notes (DaVinci Resolve)

Notes from the user (2026-09-14), recorded now so the edit can pick them up later. The in-engine side only renders
clips and stems; everything here happens in Resolve on top of the edit plan (`docs/cine/trailer-edit-plan.md`).

## Structure

- **Intro, dramatic build before the boat.** Don't open on the first frame of a boat. Fade in from black and build
  tension first, then fade/cut into the boat.
  - Candidate material (in-engine takes): an empty sunset horizon, the drowned radio tower in silhouette, the low sun
    on glassy water, with engine sound approaching from a distance on the stems before the boat appears.
- **End screen with credits.** Short and tasteful, nothing excessive; it should make the piece feel finished.
  - Title card, then credits including: **Laub** (the user); made with **Claude Fable** and **Claude Opus**.
    Add further credits as decided at edit time.
  - Candidate background: the night moon road after the pack has passed, LED glow fading, or black.
- **Day → night transition.** A match-cut or dissolve on the second throttle-grab insert (06c). The sunset and night
  takes are frame-identical and stacked on V1/V2; the cut point is the lever push-start frame marked in the edit plan.
  No frame-flicker between time-of-day variants.
- **The cut is timed to the user's music** (beat grid from the song analysis; the music arrives later).

## Look / finishing

- **Film grain** over the whole piece.
- **Colour grade** in Resolve to pull the shots together and reduce the CGI feel: match sunset shots to each other,
  match night shots, and give the two acts a consistent contrast/black level.
- **Optional 80s homage:** a VHS/analog treatment (chroma bleed, slight tracking wobble, tape noise, softened
  highlights, 4:3 or letterbox choices), used selectively or as a stylistic layer. Decide in the edit.
- Consider halation/bloom on LEDs and sun glints, a subtle gate weave, and lens distortion/vignette to sell a
  physical camera.

## Audio

- Music: supplied by the user.
- Mix: engine and water SFX stems (per clip, lossless) are blended with the music at dramatic moments. A2+/stem
  tracks start muted.
- An ambience/wind pass is still to be added in-engine (currently no ambience stem).
