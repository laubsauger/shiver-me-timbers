# The Drift: working notes

How we work on The Drift, and why. These are lessons from the reviews of October 2026, written for whoever picks the
film up on another machine, a person or an AI coding session. `CLAUDE.md` in the repo root is the short version;
`docs/drift/RENDER-NODE.md` sets up a render machine.

The Drift is a fulldome film: it plays on the inside of a planetarium dome, and what we render is a square "dome
master", a fisheye image of the whole hemisphere. Every frame is a pure function of show time, so a frame can be
rendered on its own, in any order, on any machine.

## Don't render big until asked

Full-resolution renders (2048² dome masters and up, ProRes, motion blur) and long renders happen only when the
project owner asks for a production render or a preview. Long renders tie a machine up for hours, and an overnight render
has already failed once. Everything else is small and quick:

- **Stills** for looks, any time.
- **Short clips** for motion and flicker: about 30 seconds at most, up to 1280×720. A 960×540 clip was found "very
  low resolution, a shame": a clip that is too small hides exactly what is being judged, such as cloud flicker.
- Anything longer, larger, or a dome master beyond a few frames: ask first.

Several people or coding sessions often work on one machine at once, and each headless render is heavy (a GPU
process holding gigabytes of textures, a CPU-bound sea). Past two at a time the whole machine crawls, so there are
never more than two heavy render jobs running on it, counted across everyone. `scripts/drift-slot.mjs` hands out
the two slots: wrap any browser job in it (`node scripts/drift-slot.mjs -- <command>`, `--weight 2` for a two-lane
render); the render queue and the GPU test take their slots themselves. A dedicated render machine may allow more
(`DRIFT_SLOTS`).

## Review in 16:9, not in the fisheye

Nobody can judge a detail through a fisheye. As the review put it: "If I have to dewarp the dome projection in
my head all the time, it isn't really super helpful." So stills and clips for review are ordinary 16:9 rectilinear
views (a normal camera) of the zone the audience looks at, drawn through the real film pipeline: the same cube
faces, ambient occlusion, bloom and grade as the master. The dome capture has a switch for this,
`dome.setFlat({ fov, yaw, pitch })`, and two scripts use it: `scripts/drift-review-stills.mjs` and
`scripts/drift-review-clip.mjs`. Aim where the audience looks: ahead, 20–40° up. Use a whole dome master only when
the point is to see the entire scene at once. The next preview render, when one is asked for, should also be 16:9.

## Check at the size it will be seen

Small stills hide resolution problems. The near-star field looked fine in 512 and 768 pixel stills but nearly
vanished in the 2160 rough cuts: each star was drawn a fixed number of pixels wide at a fixed brightness per pixel,
so its light fell with the square of the resolution. Anything point-like (stars, flares, glints, particles, distant
birds) must be checked in one frame rendered at the cut's real size before drawing conclusions from a small still.
New sprite code keeps its total light constant across resolutions: a fixed angular size, with a pixel minimum and a
brightness payback when it is clamped.

## Long renders: plug in, and cut them into chunks

On 28 October an overnight 4K render ran on battery. The GPU readback stalled at 76 %, the renderer kept nothing of
the partial clip, and 80 minutes were gone. The retry then ran the laptop down to 1 %, it went to sleep, and the
night was lost. It also ran about a quarter slower on battery.

So, before any render longer than about 20 minutes:

- **Check the power.** On macOS `pmset -g batt` must say "AC Power". The render queue refuses to start on battery.
- **Cut it into chunks** of about 25 minutes, each its own file, so a failure costs one chunk and a rerun skips
  everything already done. `scripts/drift-queue.mjs` does exactly this, and keeps the machine awake while it runs.

## Render with the installed Google Chrome

The renders run in a headless browser. Playwright's bundled Chromium fails to compile some of the sea's shaders
(the error mentions a "swizzle view instruction"), so everything from the sea on (about 314 s into the show) comes
out broken in it. The installed Google Chrome compiles them. Pass `--channel chrome` to `drift-render.mjs` and
`drift-stills.mjs`; the review scripts and the render queue use Chrome by default. The first two acts render
identically in either. If Playwright's Chromium is updated, re-check before dropping the flag.

## Verify a master with the Mac's own decoder

A master is checked twice before it is handed over: its frame count, and a full decode with macOS's own decoder
(AVFoundation, which is what DaVinci and QuickTime use). A clean decode in ffmpeg proves nothing on its own.

What happened: the v11 4K master passed every ffmpeg check (frame count, timestamps, a full decode, a glitch scan),
and DaVinci still showed "media offline" for eleven seconds of it. macOS's H.264 decoder refuses vertical motion
vectors beyond ±512 pixels; a 4096² video is allowed ±2048, and the fast streaks of the opening used them. The
encoder now limits them (`-x264-params mvrange=511` in `scripts/cine-sink.mjs`). The check that catches this decodes
the file in windows of about 250 frames through AVFoundation and treats any window that fails as a broken master.

## The dome: Horizon 18, tilted 15°

The film is made for one dome, Horizon 18, which is tilted 15° (its zenith leans toward the front). Masters render
with `driftParams.domeTilt = 15`. To judge framing, preview in the studio-world virtual dome set up as Horizon 18
(`dome-h18`) from a seat in the middle; its fisheye mapping is the exact inverse of our capture. Level domes would
show the world tilted by 15°, and no level version is wanted.

The tilt also hides the bottom edge. A point at distance z ahead of the eye and d below eye level is on the dome
only while d ≤ z × tan 15°, about 0.27 z. Beside or behind the eye, nothing below eye level shows at all. A dolphin
that flipped 7 m ahead with the eye 2.3 m up fell off the rim, so the case it threw "came from nowhere at the
bottom"; moving the flip about 10 m ahead fixed it. Before staging action close to the water or the ground, check
d ≤ 0.27 z, with some margin for waves, and prefer action further ahead or higher.

## No crossfades inside continuous action

Where the shot is continuous (same raft, same sea), don't dissolve between two versions of the scene. A crossfade
between two skies showed two suns and two rafts at once; the review asked why we were fading from one sky to the
other instead of staying in place and scripting the environment and the sunset. Keep one world and animate the sun,
clouds and light continuously, as a time-lapse if hours pass. Keep dissolves for real changes of place.

The same goes for the cuts between story beats that are not dissolves: anything that steps there is seen as a jump.
A sun 2° off between two beats read as "the sun just jumps suddenly". When adding a beat, make the sun, the poses
and the sky continuous across its edges (a test checks the sun).

## Keep the sky moving, gently

On a dome a completely still sky reads as a frozen frame. An early rough cut was flagged as "everything standing
still, feels like a static image" for 45 seconds, although the content was fine. Every beat needs at least a
subtle motion: parallax through near stars, a slow turn of the sky (about 1° a second or less), a drift. Keep it
comfortable: move the viewer forward rather than spinning them.

Two related lessons: quick handovers read as a hiccup (a 2-second swap of suns looked like a flash), so hand over
over several seconds; and don't dim the picture at a beat boundary. Any darkening must have a visible cause, such
as a sunlit planet growing in view.

## Motion before geometry

Distant and silhouetted things (the dolphin, the birds) are judged by their outline and their movement, not by
close-up detail. "We barely see it in that silhouette, so shape and movement is important … motion curves and the
speed and timing are much more impactful than the absolute best geometry at close distance." Build a correct
silhouette (procedurally or from a free asset), then put the effort into physically plausible motion: real speeds,
ballistic arcs, the body following its path. Judge it in a moving clip, not in stills.

No paid assets: no subscriptions, no paid BlenderKit models. Free, CC0 or procedural only.

## Build realism from references, not by eye

When something must look real (the Earth from orbit, the Milky Way, galaxies, the cosmic web), start from real
imagery and measured data, not from procedural noise tuned by eye. Procedural city lights and clouds once read as
"MS Paint blotches with gradient spheres"; switching to NASA's Blue Marble, Black Marble, VIIRS clouds and real
elevation fixed it in one pass. One low-resolution reference is not enough: gather several per subject.

The reference library is `../drift-narrative/references/`, one folder per subject, with a README that lists each
image's source, credit and licence and, per subject, what to match (measured colours, brightness, structure).
Check renders against it before showing them.

## Licences

- The palms and some wood come from BlenderKit (`public/drift/pbr/blenderkit/`). They are royalty-free: fine in our
  renders, but the models themselves may not be passed on. They are gitignored, and the asset bundle that carries
  them to other machines (`scripts/drift-bundle.mjs`) is private: own machines only, never in git, never on a
  public share.
- The other scans and models are CC0 (Poly Haven, ambientCG) and can be downloaded again with
  `scripts/drift-pbr-fetch.py`.
- The references are mostly Wikimedia Commons (CC BY, CC BY-SA, public domain) and NASA (public domain). Their
  credits travel with them in `references/README.md`. They are for matching, not for putting on the dome; if an
  image itself ever goes on screen, re-check its licence first.
- `../drift-narrative/` (the treatments, direction, review notes and references) never goes into git.

## Still to do early: a seat in the virtual dome

Once a rough cut is decent, render a few chunks from an audience seat inside the studio-world Horizon 18 dome: the
master mapped onto the dome, the camera in the best rows looking at the focus zone with gentle head movement. Only
from a real seat can horizon lines, the Earth's limb, text, the scale of stars and galaxies, and comfort be judged.
The project owner asked for this to happen early, after the current rough-cut fixes.
