/**
 * "Warfish / Alan Watts" — the timeline, as data.
 *
 * Every number here traces to a frame in the reference; the reasoning lives in
 * docs/cine/warfish-alan-watts-camera-script.md and is not repeated. Distances
 * are the reference framing scaled x2.3 (13 m trawler -> 30 m brigantine) so
 * the subject holds the same fraction of frame width.
 *
 * Ship-local axes, repo convention (src/combat/battery.ts:42):
 *   +Z forward   +Y up   +X starboard
 *
 * THE BRIGANTINE, MEASURED (params/ship.ts:brigantineParams) — every deck rig
 * below is placed against these and not against the reference boat scaled by
 * eye, which is what put the first pass inside the hull:
 *
 *   hull        30 m long, z -15 (transom) .. +15 (stem)
 *   beam        7.2 m, x -3.6 (port) .. +3.6 (starboard)
 *   main deck   y +1.8 (freeboard); rail cap y +2.7 (railHeight 0.9)
 *   standing eye y +3.4  (deck + 1.6)
 *   foremast    z +7.5, 19 m;  mainmast z -3, 23 m
 *   bowsprit    7 m beyond the stem, pitched up 0.28 rad
 *
 * So a camera at y 1.5 is BELOW THE DECK and inside her, and z +13 with the
 * lens pointed forward is inside the bow. Both were in the first take.
 */
import type { Shot, WorldPatch } from './types';

/**
 * Per-shot world defaults.
 *
 * THE GRADE IS NOT HERE. It is a named mode (src/grade), applied once when a
 * shoot starts and put back when it ends, so the shooting look is a thing you
 * can switch on and off in the game rather than something only a render has.
 * What remains here is what every shot needs from the WEATHER, and it is all
 * about holding it still — see `weatherLock` in main.ts for why a drifting
 * storm field pops clouds in and out mid-take.
 */
export const GLOBAL_WORLD: WorldPatch = {};

/** drone-like low-frequency motion — the default for every aerial */
const DRONE = { yaw: 0.5, pitch: 0.3, roll: 0.4, alt: 0.3, hz: 0.08 };
/** a hull-mounted rig inherits the ship's roll; this is only lens breathing */
const RIG = { yaw: 0.15, pitch: 0.12, roll: 0.1, alt: 0.02, hz: 0.06 };

export const SHOTS: readonly Shot[] = [
  {
    id: 'A',
    slug: 'sunstar, locked',
    in: 0.0,
    out: 7.22,
    transition: 'cut',
    // 'ship' with a big offset, not 'world' at the origin: the origin is where
    // the hull is, and the first take of this shot was the inside of her deck
    // planking. 300 m ahead and to port puts her behind the lens entirely.
    frame: 'ship',
    preroll: 4,
    aimSun: { yaw: -7, pitch: -6 },
    keys: [{ t: 0, pos: [-120, 2.4, 300], aim: [-120, 2.4, 400], fov: 20 }],
    wobble: { yaw: 0.4, pitch: 0.4, hz: 0.06 },
    world: {
      sunElevationDeg: 0.9, sunSide: 'morning',
      weather: 'glass',
      shipAnchored: true,
      sky: {
        // THE SUN HAS TO BE A POINT, NOT A REGION. Our first take blew the
        // whole upper frame to pale pink and left no disc at all, against a
        // reference whose sky is nearly black two degrees off the sun. Three
        // things do it, and the exposure is the one that matters most:
        //   exposure    — live per frame (sky/lighting.ts), so a shot can
        //                 stop down. 1.1 is a game exposure; a sun in frame
        //                 wants two and a half stops less.
        //   disc        — smaller and much hotter: a small very bright source
        //                 reads as a point, a large moderate one as haze.
        //   glow/halo   — pulled right in, or the surround swamps the disc.
        exposure: 0.32,
        sunDiscSize: 0.55,
        sunDiscSoftness: 0.12,
        sunDiscIntensity: 46,
        sunGlowPower: 900,
        sunGlowStrength: 0.45,
        sunHaloPower: 14,
        sunHaloStrength: 0.05,
        hazeStrength: 0.14,
      },
      clouds: { coverage: 0.06 },
      post: {
        // long, dense rays out of a small hot source — the nearest this
        // engine gets to a star filter without a dedicated flare pass
        godRayIntensity: 2.2,
        godRayLength: 0.85,
        godRayDecay: 0.985,
        godRayFalloff: 0.18,
        godRayTaps: 96,
        godRayThreshold: 1.4,
        bloomThreshold: 1.1,
        bloomStrength: 0.7,
        bloomRadius: 0.5,
        dofFocus: 200,
        dofRange: 400,
      },
    },
    note: 'One held image. The disc sits upper-right third; water is a blackened OOF wedge lower-left.',
  },

  {
    id: 'B',
    slug: 'she crosses the frame',
    in: 7.22,
    out: 29.65,
    transition: 'cut',
    // ONE CONTINUOUS CROSSING, not two clips of the same idea. B and C used to
    // be two locked aerials a few metres apart doing the same thing twice; the
    // reference holds ONE camera for the whole 22 s and lets her drive from
    // the bottom-right corner to the top-left. The only camera move is a creep
    // in and down, slow enough to read as drift rather than as a push.
    frame: 'locked',
    preroll: 25,
    keys: [
      { t: 0, pos: [168, 88, -150], aim: [-40, 0, 210], fov: 40 },
      { t: 22.43, pos: [128, 70, -70], aim: [-30, 0, 165], fov: 42 },
    ],
    wobble: DRONE,
    world: {
      sunElevationDeg: -13,
      sunSide: 'morning',
      weather: 'calm',
      shipKnots: 8,
      sky: { exposure: 0.78, starBrightness: 0.9, moonIntensity: 0.1, moonPhase: 0.15 },
      lanterns: { intensity: 10 },
    },
    note: 'Title card sits in the back half of this. The wake is the composition; she is a light on it.',
  },
  {
    id: 'C',
    slug: 'dawn waterline, her reflection',
    in: 29.65,
    out: 46.25,
    transition: 'cut',
    // THE SHOT THE FIRST THIRD WAS MISSING. Everything before this is her at a
    // distance in the dark; there was nothing with the sky in the water. Lens
    // just above the surface, abeam and a little ahead, the whole hull lit
    // along one side with her reflection running back toward the lens and the
    // dawn band behind her. Damped follow so it holds station without
    // inheriting her yaw.
    frame: 'ship',
    preroll: 30,
    rideSwell: 1.6,
    follow: { halfLife: 3 },
    keys: [
      { t: 0, pos: [46, 0, -26], aim: [0, 4, 2], fov: 40 },
      { t: 16.6, pos: [34, 0, 10], aim: [0, 4, 4] },
    ],
    wobble: { yaw: 0.25, pitch: 0.2, roll: 0.9, hz: 0.05 },
    world: {
      sunElevationDeg: 0.6,
      sunSide: 'morning',
      weather: 'glass',
      shipKnots: 7,
      sky: { exposure: 0.62, sunDiscSize: 0.7, sunDiscIntensity: 34, sunGlowStrength: 0.6 },
      ocean: { swellPeriod: 15, swellAmplitude: 0.3, amplitude: 0.12, choppiness: 0.45 },
      post: { bloomStrength: 1.0, godRayIntensity: 1.4, dofFocus: 60, dofRange: 120 },
    },
    note: 'Low sun BEHIND her so the water between lens and hull is a sheet of glitter, and the hull reads as a dark shape on it.',
  },
  {
    id: 'D',
    slug: 'stern chase - the money shot',
    in: 46.25,
    out: 62.85,
    transition: 'cut',
    frame: 'ship',
    preroll: 40,
    follow: { halfLife: 2.5 },
    keys: [
      // FILLS FRAME WITH WAKE FIRST, and holds there. The previous pass aimed
      // 84 m ahead at t=0, which already had her in shot — the reveal has to
      // be a reveal. The lens starts pitched steeply DOWN at the water 30 m
      // ahead, so there is nothing in frame but the wake running away, holds
      // that for a third of the shot, and only then tilts up to find her.
      { t: 0, pos: [0, 30, -180], aim: [0, 0, -150], fov: 45 },
      { t: 5.5, pos: [0, 30, -172], aim: [0, 0, -142] },
      { t: 11.5, pos: [0, 30, -158], aim: [0, 3, -70] },
      { t: 16.6, pos: [0, 30, -140], aim: [0, 8, 0] },
    ],
    wobble: DRONE,
    world: {
      sunElevationDeg: -13, sunSide: 'morning',
      weather: 'calm',
      shipKnots: 9,
      // the KEY at night is the MOON, not a dimmed sun (sky/index.ts) — so the
      // darkness of a night shot is set here, not by going later
      sky: { exposure: 0.85, moonIntensity: 0.14, moonPhase: 0.2 },
      ocean: { swellPeriod: 13, swellAmplitude: 0.28, amplitude: 0.14 },
    },
    note: 'Dead astern on the centreline. Wake V fills the lower two thirds and converges on the vertical centreline. Eased in, NOT eased out - the cut lands mid-move.',
  },

  {
    id: 'E',
    slug: 'sunrise parallel track',
    in: 62.85,
    out: 73.1,
    transition: 'dissolve',
    transitionSeconds: 1.2,
    frame: 'ship',
    preroll: 35,
    follow: { halfLife: 3.0 },
    keys: [
      { t: 0, pos: [150, 36, 16], aim: [0, 6, 0], fov: 38 },
      { t: 10.25, pos: [138, 33, -6], aim: [0, 6, 0] },
    ],
    // LONG and SLOW, not fine. A 0.08 Hz drone jitter reads as noise; a 0.03 Hz
    // roll reads as the sea under her, and it is what lets the eye see the bow
    // lift and drop against the horizon instead of a hull sliding along a line.
    wobble: { yaw: 0.35, pitch: 0.3, roll: 1.1, alt: 0.5, hz: 0.03 },
    world: {
      sunElevationDeg: 1.5, sunSide: 'morning',
      weather: 'glass',
      shipKnots: 8,
      // a longer, taller ground swell than 'glass' alone gives: the point of
      // this shot is her working against the sea, and glass has none
      ocean: { swellPeriod: 15, swellAmplitude: 0.5, amplitude: 0.16, choppiness: 0.5 },
      sky: { exposure: 0.85, hazeStrength: 0.42 },
      post: { bloomStrength: 0.95 },
    },
    note: 'First warmth. Ship drifts frame-left because the rig runs ~0.3 m/s slower than she does. Flat mauve->peach sky, NO cloud detail.',
  },

  {
    id: 'F1',
    slug: 'helm, sun through the rigging',
    in: 73.1,
    out: 78.6,
    transition: 'dissolve',
    transitionSeconds: 1,
    frame: 'hull',
    preroll: 20,
    // abaft the mainmast (z -3) at standing eye height, looking forward along
    // the centreline so the fore rigging cuts the disc
    // ACROSS her, not along her. Aimed down the centreline the frame was deck
    // planking and mast, with no sun and no sea in it at all — three deck
    // shots in a row of the same brown nothing. This looks OUTBOARD over the
    // weather rail toward the low sun, so the frame is rigging in silhouette,
    // the rail, and lit water past it.
    keys: [
      { t: 0, pos: [-2.2, 3.5, -4.5], aim: [7.5, 1.2, 9], fov: 44 },
      { t: 5.5, pos: [-2.2, 3.5, -2.0], aim: [7.5, 1.4, 10] },
    ],
    wobble: RIG,
    world: {
      sky: { exposure: 0.7 },
      sunElevationDeg: 2.5, sunSide: 'morning',
      weather: 'glass',
      shipKnots: 8,
      post: { godRayIntensity: 1.5, bloomStrength: 1.1, dofFocus: 22, dofRange: 40 },
    },
    note: 'Shrouds and ratlines cut the disc into slices.',
  },

  {
    id: 'F2',
    slug: 'deck dolly forward',
    in: 78.6,
    out: 82.6,
    transition: 'dissolve',
    transitionSeconds: 1,
    frame: 'hull',
    preroll: 20,
    // A DOLLY NEEDS SOMETHING TO PASS. Running up the centreline nothing
    // changed in frame but the mast getting nearer, which is why it read as
    // silly. This one tracks forward just inboard of the starboard rail with
    // the aim held OUT to sea and slightly aft, so the shrouds, channels and
    // rail posts sweep through the foreground against a lit horizon while the
    // background barely moves — parallax, which is the whole point of a dolly.
    keys: [
      { t: 0, pos: [2.6, 3.2, -8], aim: [11, 1.0, -2], fov: 46 },
      { t: 4, pos: [2.6, 3.2, 2.5], aim: [11, 1.0, 7] },
    ],
    wobble: RIG,
    world: {
      sky: { exposure: 0.7 },
      sunElevationDeg: 3.5, sunSide: 'morning',
      weather: 'glass',
      shipKnots: 8,
      post: { godRayIntensity: 1.6, bloomStrength: 1.2, dofFocus: 25, dofRange: 45 },
    },
    note: '0.8 m/s along the centreline, helm toward the foot of the foremast.',
  },

  {
    id: 'F3',
    slug: 'flare blowout',
    in: 82.6,
    out: 88.34,
    transition: 'cut',
    frame: 'hull',
    preroll: 20,
    // the disc sits just off the shrouds and the sea is under it — the flare
    // has to have somewhere to happen and something to happen against
    keys: [{ t: 0, pos: [-1.6, 3.4, 1.5], aim: [9, 1.6, 11], fov: 40 }],
    wobble: RIG,
    world: {
      sunElevationDeg: 4.5, sunSide: 'morning',
      weather: 'glass',
      shipKnots: 8,
      sky: { exposure: 0.55, sunDiscSize: 0.7, sunDiscIntensity: 30, sunGlowStrength: 0.7 },
      post: {
        godRayIntensity: 2.0,
        godRayLength: 0.7,
        godRayTaps: 80,
        bloomStrength: 1.0,
        bloomThreshold: 0.9,
      },
    },
    note: 'Sun clears a shroud and blows out ~60% of the frame. End of the dissolve chain - hard cut out.',
  },

  {
    id: 'G1',
    slug: 'the bow, held',
    in: 88.34,
    out: 97.81,
    transition: 'cut',
    frame: 'ship',
    preroll: 25,
    follow: { halfLife: 2.5 },
    rideSwell: 0.9,
    // ONE SHOT, 9.5 s, instead of three cuts of the same bow at three
    // different sea states. Cutting between near-identical angles is only
    // "looking harder" when the angles are chosen; three of them a few seconds
    // apart just reads as hectic. This holds, rides the swell, and lets her
    // come up and down through the frame on her own.
    keys: [
      { t: 0, pos: [8.5, 0, 26], aim: [0.5, 2.2, 14], fov: 44 },
      { t: 9.47, pos: [6.2, 0, 20], aim: [0.5, 2.0, 13.5] },
    ],
    wobble: { yaw: 0.3, pitch: 0.25, roll: 1.4, hz: 0.045 },
    world: {
      sunElevationDeg: 5,
      sunSide: 'morning',
      sky: { exposure: 0.6, sunDiscSize: 0.7, sunDiscIntensity: 30, sunGlowStrength: 0.6 },
      weather: 'calm',
      shipKnots: 10,
      ocean: { swellPeriod: 12, swellAmplitude: 0.55, amplitude: 0.22 },
      post: { dofFocus: 18, dofRange: 30, dofBokeh: 4, bloomStrength: 1.0 },
    },
    note: 'Backlit: foam translucent, water behind it dark. She has to be at 10 kn or the bow wave is not a bow wave.',
  },
  {
    id: 'G2',
    slug: "snell's window, up at the sun",
    in: 97.81,
    out: 102.14,
    transition: 'cut',
    // LOOKING UP THROUGH THE SURFACE. The ocean material already draws a
    // Snell's window and the sun's transmitted term (surfaceMaterial.ts's
    // `skySunTerm` note: the disc is deliberately kept out of the REFLECTED
    // sky but belongs in the path looking up THROUGH the water). This is the
    // one place in the piece that can use it: the whole sky compressed into a
    // 97-degree cone with the sun in it and god rays coming down.
    frame: 'ship',
    preroll: 18,
    follow: { halfLife: 3 },
    aimSun: { yaw: 0, pitch: 22 },
    keys: [
      { t: 0, pos: [26, -3.2, 40], aim: [26, 4, 40], fov: 60 },
      { t: 4.33, pos: [26, -1.6, 40], aim: [26, 4, 40] },
    ],
    wobble: { yaw: 0.8, pitch: 0.6, roll: 1.6, hz: 0.07 },
    world: {
      sunElevationDeg: 34,
      sunSide: 'morning',
      weather: 'calm',
      shipAnchored: true,
      sky: { exposure: 0.7, sunDiscSize: 0.9, sunDiscIntensity: 34 },
      ocean: { swellPeriod: 11, swellAmplitude: 0.4, amplitude: 0.2 },
      post: { godRayIntensity: 2.2, godRayLength: 0.8, godRayTaps: 80, bloomStrength: 1.2 },
    },
    note: 'Rising toward the surface, sun high enough to be well inside the window. Needs the underwater volume — verify it engages at this depth.',
  },
  {
    id: 'H1',
    slug: 'waterline sunstar',
    in: 102.14,
    out: 106.47,
    transition: 'cut',
    frame: 'ship',
    preroll: 15,
    rideSwell: 0.3,
    aimSun: { yaw: 3, pitch: -9 },
    follow: { halfLife: 3.0 },
    keys: [{ t: 0, pos: [60, 0, 260], aim: [60, 0, 360], fov: 42 }],
    world: {
      sunElevationDeg: 1, sunSide: 'morning',
      weather: 'calm',
      shipAnchored: true,
      ocean: { swellPeriod: 12, swellAmplitude: 0.35, amplitude: 0.18 },
      sky: { exposure: 0.42, sunDiscSize: 0.6, sunDiscIntensity: 40, sunGlowStrength: 0.5, sunHaloStrength: 0.06 },
      post: { godRayIntensity: 2.0, godRayLength: 0.75, godRayTaps: 80, vignetteStrength: 0.55, dofFocus: 120, dofRange: 300 },
    },
    note: 'No ship in frame for 12.7 s. Horizon at 40% from the top. The bob comes free from rideSwell.',
  },

  {
    id: 'H2',
    slug: 'waterline sunstar, wider',
    in: 106.47,
    out: 114.86,
    transition: 'cut',
    frame: 'ship',
    preroll: 15,
    rideSwell: 0.15,
    aimSun: { yaw: -2, pitch: -8 },
    follow: { halfLife: 3.0 },
    keys: [{ t: 0, pos: [-40, 0, 280], aim: [-40, 0, 380], fov: 46 }],
    world: {
      sunElevationDeg: 1.2, sunSide: 'morning',
      weather: 'calm',
      shipAnchored: true,
      ocean: { swellPeriod: 12, swellAmplitude: 0.35, amplitude: 0.18 },
      sky: { exposure: 0.42, sunDiscSize: 0.6, sunDiscIntensity: 40, sunGlowStrength: 0.5, sunHaloStrength: 0.06 },
      post: { godRayIntensity: 2.0, godRayLength: 0.75, godRayTaps: 80, vignetteStrength: 0.55, dofFocus: 120, dofRange: 300 },
    },
    note: 'Cut to the same setup 0.15 m lower and 4 deg wider.',
  },

  {
    id: 'I1',
    slug: 'rail silhouette, dusk',
    in: 114.86,
    out: 120.53,
    transition: 'cut',
    frame: 'hull',
    preroll: 20,
    // inboard of the port rail at standing eye height, looking across her and
    // forward so the starboard rail cap (y 2.7) runs the lower-right diagonal
    // OVER the rail and out. Aimed across the deck the frame was a black hull
    // interior; from just inboard, looking out and slightly down, the rail cap
    // runs the lower third as a hard diagonal and everything above it is the
    // dusk band on water.
    keys: [{ t: 0, pos: [-2.4, 3.2, -2], aim: [10, 0.9, 6], fov: 44 }],
    wobble: RIG,
    world: {
      sky: { exposure: 0.7 },
      sunElevationDeg: -1.2, sunSide: 'evening',
      weather: 'calm',
      shipKnots: 4,
      lanterns: { intensity: 14, flickerDepth: 0.22 },
      post: { bloomStrength: 0.9, dofFocus: 12, dofRange: 30 },
    },
    note: 'Rail crosses the lower-left as a hard diagonal, horizon at 45%. Static - the only motion is her roll.',
  },

  {
    id: 'I2',
    slug: 'rail silhouette, reverse',
    in: 120.53,
    out: 125.74,
    transition: 'cut',
    frame: 'hull',
    preroll: 20,
    keys: [{ t: 0, pos: [2.6, 3.2, 4], aim: [-10, 0.9, -4], fov: 44 }],
    wobble: RIG,
    world: {
      sky: { exposure: 0.7 },
      sunElevationDeg: -1.6, sunSide: 'evening',
      weather: 'calm',
      shipKnots: 4,
      lanterns: { intensity: 14, flickerDepth: 0.22 },
      post: { bloomStrength: 0.9, dofFocus: 12, dofRange: 30 },
    },
    note: 'Matched reverse.',
  },

  {
    id: 'J',
    slug: 'glitter macro',
    in: 125.74,
    out: 134.93,
    transition: 'cut',
    frame: 'ship',
    preroll: 15,
    rideSwell: 0.4,
    aimSun: { yaw: 1, pitch: -4.5 },
    follow: { halfLife: 3.0 },
    keys: [
      { t: 0, pos: [30, 0, 240], aim: [30, 0, 300], fov: 26 },
      { t: 9.19, pos: [35.8, 0, 240], aim: [35.8, 0, 300] },
    ],
    world: {
      sunElevationDeg: 1, sunSide: 'evening',
      weather: 'calm',
      shipAnchored: true,
      sky: { exposure: 0.5, sunDiscSize: 0.6, sunDiscIntensity: 34, sunGlowStrength: 0.6 },
      post: { dofFocus: 22, dofRange: 18, dofBokeh: 6, bloomStrength: 1.0, bloomThreshold: 1.0, godRayIntensity: 1.2 },
    },
    note: 'Pure abstraction. Long lens wide open on the sun path; foreground chop is a field of bokeh discs.',
  },

  {
    id: 'K',
    slug: 'night aerial, her own light on the water',
    // 114.0, not 116.4: measured off the reference at one-second spacing, the
    // aerial is up for a full seven seconds. It was cut short by two and a
    // half, which is a third of it.
    in: 134.93,
    out: 141.97,
    transition: 'cut',
    frame: 'ship',
    preroll: 12,
    follow: { halfLife: 2.5 },
    // NO HORIZON IN FRAME. The previous pass sat 46 m up and 78 m out — about
    // 30 degrees down, which puts the horizon across the top and turns the shot
    // into a seascape with a boat in it. The reference is looking almost DOWN:
    // nothing in frame but water, her, and the pool of her own deck lights
    // running out of the bottom of frame toward the lens. She sits above centre
    // and left, small, and the light road is the biggest thing in the picture.
    keys: [
      { t: 0, pos: [-30, 76, -54], aim: [2, 0.5, 10], fov: 38 },
      { t: 7.04, pos: [-34, 73, -49], aim: [2, 0.5, 10] },
    ],
    // barely: this is a held drone frame, not a move
    wobble: { yaw: 0.25, pitch: 0.2, roll: 0.3, alt: 0.25, hz: 0.05 },
    world: {
      sunElevationDeg: -30,
      sunSide: 'evening',
      weather: 'glass',
      shipAnchored: true,
      shipKnots: 0,
      // THE POOL UNDER HER IS HER OWN LAMPS, not the moon — that is what the
      // reference frame actually shows, and it is why she reads as a lit thing
      // on dark water rather than as a silhouette on a moonlit sheet. Moon
      // kept low so it gives the sea its fine texture and no second road.
      sky: { exposure: 0.62, moonPhase: 0.35, moonIntensity: 0.16, starBrightness: 0.5 },
      clouds: { coverage: 0.12 },
      // flat, fine-textured water: no whitecaps anywhere in this frame
      ocean: { swellPeriod: 13, swellAmplitude: 0.18, amplitude: 0.07, choppiness: 0.5 },
      lanterns: { intensity: 34, range: 34 },
      post: { bloomStrength: 1.1, bloomThreshold: 0.5 },
    },
    note: 'Almost straight down, no horizon. Her lamps make the road; the moon only gives the sea its grain.',
  },
  {
    id: 'L',
    slug: 'under her, looking up',
    in: 141.97,
    out: 164.74,
    transition: 'cut',
    // The old version crawled from a split-level down and aft over 22 s and
    // was ugly the whole way: half a frame of black water, half a frame of
    // hull, nothing to look at. This sits UNDER her and looks UP — the lit
    // waterline from below, the keel a black shape across it, her lamps
    // smeared through the surface. Slow rise, no crawl.
    frame: 'ship',
    preroll: 15,
    follow: { halfLife: 3 },
    keys: [
      { t: 0, pos: [7, -7.5, -2], aim: [0, 1.5, 3], fov: 52 },
      { t: 22.77, pos: [4.5, -2.6, 1], aim: [0, 1.2, 4] },
    ],
    wobble: { yaw: 0.7, pitch: 0.5, roll: 1.2, hz: 0.05 },
    world: {
      sunElevationDeg: -35,
      sunSide: 'evening',
      sky: { exposure: 0.85, moonIntensity: 0.18, moonPhase: 0.35 },
      weather: 'calm',
      shipAnchored: true,
      shipKnots: 0,
      lanterns: { intensity: 30, range: 30 },
      post: { grainAmount: 0.016, dofFocus: 9, dofRange: 16, dofBokeh: 4, bloomStrength: 1.2 },
    },
    note: 'Needs the underwater volume to engage — check __game.underwater.blend at this depth. No creatures.',
  },
  {
    id: 'M',
    slug: 'extreme high - the thematic shot',
    in: 164.74,
    out: 175.25,
    transition: 'cut',
    frame: 'ship',
    preroll: 12,
    keys: [
      { t: 0, pos: [40, 600, 30], aim: [0, 0, 0], fov: 35 },
      { t: 10.51, pos: [22, 588, 16], aim: [0, 0, 0] },
    ],
    world: {
      sunElevationDeg: -40, sunSide: 'evening',
      weather: 'calm',
      shipAnchored: true,
      shipKnots: 0,
      sky: {
        // THE SEA HAS TO BE BLACK HERE. At the first pass's moon the water came
        // back a flat navy field with a speck on it — the shot is supposed to
        // be nothing at all except one point of light, and a lit ocean is the
        // opposite of that. Exposure down two stops from the night rungs and
        // the moon almost out.
        // Dark, not black. Two passes overshot: at 0.22 the frame quantised to
        // literally identical bytes take after take, which is a dead shot and
        // (before the tolerance was raised) enough to trip the duplicate-frame
        // guard. The sea has to be READABLE as sea — a faint sheen with one
        // light on it — or there is no scale for the light to be small against,
        // which is the entire point of the shot.
        exposure: 0.62,
        starBrightness: 1.0,
        moonIntensity: 0.14,
        moonPhase: 0.1,
        moonDiscIntensity: 0,
      },
      clouds: { coverage: 0 },
      lanterns: { intensity: 40, range: 30 },
      post: { bloomThreshold: 0.25, bloomStrength: 1.8, bloomRadius: 0.9, vignetteStrength: 0.7 },
    },
    note: 'The image the piece is built around. No horizon, no sea texture. At 600 m the lamp is sub-pixel and its BLOOM is the entire shot - see gap #2.',
  },

  {
    id: 'N1',
    slug: 'binnacle glow',
    in: 175.25,
    out: 178.93,
    transition: 'cut',
    frame: 'hull',
    preroll: 10,
    // the lantern posts stand on the main deck at the transom (params/ship:
    // lanternPostHeight 1.6 above deck y 1.8), so the practical is at y ~3.4,
    // z ~-14. Sit just forward of it and look aft into the lamp.
    // OFF THE STERN QUARTER, outside her. On deck the lens kept ending up
    // under the rig with the transom rail across it; from outside and abaft
    // there is nothing between the camera and the lantern.
    keys: [{ t: 0, pos: [6.5, 4.6, -21], aim: [0.4, 3.4, -14.5], fov: 36 }],
    wobble: RIG,
    world: {
      sunElevationDeg: -41, sunSide: 'evening',
      weather: 'calm',
      shipAnchored: true,
      sky: { exposure: 0.85, moonIntensity: 0.12, moonPhase: 0.2 },
      lanterns: { intensity: 18 },
      post: { dofFocus: 3.2, dofRange: 3, dofBokeh: 5, bloomStrength: 1.3, bloomThreshold: 0.4 },
    },
    note: "The reference's chartplotter beat. The radio set is the thematically right substitute given the VO.",
  },

  {
    id: 'N2',
    slug: 'the dark alongside',
    in: 178.93,
    out: 201.19,
    transition: 'cut',
    frame: 'ship',
    preroll: 18,
    rideSwell: 0.8,
    // DAMPED FOLLOW over 22 s: bolted to her frame the rig inherited every
    // yaw she made and the whole shot wallowed with the hull.
    follow: { halfLife: 3.5 },
    keys: [
      { t: 0, pos: [30, 0, -10], aim: [0, 3.5, 2], fov: 44 },
      { t: 22.26, pos: [20, 0, 8], aim: [0, 3.5, 6] },
    ],
    wobble: { yaw: 0.4, pitch: 0.3, roll: 1.2, hz: 0.1 },
    world: {
      sunElevationDeg: -45, sunSide: 'evening',
      weather: 'calm',
      shipKnots: 2,
      sky: { exposure: 0.8, moonIntensity: 0.18, moonPhase: 0.3 },
      lanterns: { intensity: 20, range: 24 },
      post: { grainAmount: 0.015, bloomStrength: 1.1 },
    },
    note: 'Lantern spill on black water, foam curling past. Resolve an island silhouette out of the dark over the last 8 s if we want the reference’s "something is out there" turn.',
  },

  {
    id: 'O',
    slug: 'bow in fog',
    in: 201.19,
    out: 211.79,
    transition: 'cut',
    frame: 'ship',
    preroll: 20,
    rideSwell: 1.0,
    follow: { halfLife: 2.5 },
    keys: [
      { t: 0, pos: [-34, 0, 30], aim: [-2, 14, 16], fov: 45 },
      { t: 10.6, pos: [-31, 0, 27], aim: [-2, 14, 15] },
    ],
    wobble: { yaw: 0.5, pitch: 0.4, roll: 1.5, hz: 0.11 },
    world: {
      sunElevationDeg: 1.6, sunSide: 'morning',
      weather: 'glass',
      shipKnots: 1.5,
      sky: {
        // A FOG BANK IS NOT `scene.fog`, and it is not a night either.
        //
        // Linear scene fog only touches MESHES — the sky is drawn at infinity
        // and the sea carries its own haze — so fogNear/fogFar alone fogs the
        // hull and leaves it under a clear sky. That was the first take.
        //
        // The second take flattened the palette to grey and still came back
        // blue, because `skyPalette` applies the NIGHT TINT on top of whatever
        // colours it is given: a grey sky at -48 degrees is a blue-grey sky.
        // So the bank is shot just after sunrise instead — the sun is up, the
        // palette is flat grey, haze is pinned at 1 and the cloud layer is
        // switched off. The reference's fog is lit by the boat's own work
        // light against a colourless ground, which is what this gives; the
        // clock behind it is not in the picture.
        hazeStrength: 1,
        fogNear: 2,
        fogFar: 70,
        zenithColor: 0x8d949b,
        midColor: 0x969ca2,
        horizonColor: 0x9aa0a6,
        sunsetStrength: 0,
        horizonWarmStrength: 0,
        starBrightness: 0,
        moonIntensity: 0.08,
        moonDiscIntensity: 0,
        sunDiscIntensity: 0,
      },
      clouds: { coverage: 0 },
      // THE WATER'S HALF OF THE BANK. `sky.fogNear/fogFar` is scene fog and the
      // ocean opts out of it, so without this the sea stays clear to the
      // horizon under a grey sky with a ghost of a ship in the middle. The
      // melt target is the sky dome along each pixel's own ray, so a grey sky
      // gives a grey sea for free.
      oceanSurface: { hazeStart: 40, hazeEnd: 240, hazeCurve: 1 },
      lanterns: { intensity: 40, range: 60, color: 0xfff0e0, flickerDepth: 0.05 },
      post: { bloomThreshold: 0.4, bloomStrength: 1.6, bloomRadius: 0.9, godRayIntensity: 1.2 },
    },
    note: 'NOT a preset - fog is built by hand here. Looking slightly UP at her. The work light is blown white and its beam is a visible volume.',
  },

  {
    id: 'P',
    slug: 'bow tight, then gone',
    in: 211.79,
    out: 216.93,
    transition: 'cut',
    frame: 'ship',
    preroll: 20,
    rideSwell: 0.6,
    follow: { halfLife: 2.0 },
    keys: [
      { t: 0, pos: [-14, 0, 20], aim: [-1, 11, 15], fov: 45 },
      { t: 5.14, pos: [-6, 0, 26], aim: [-1, 11, 12] },
    ],
    wobble: { yaw: 0.5, pitch: 0.4, roll: 1.5, hz: 0.11 },
    world: {
      sunElevationDeg: 1.4, sunSide: 'morning',
      weather: 'glass',
      shipKnots: 1.5,
      sky: {
        // A FOG BANK IS NOT `scene.fog`, and it is not a night either.
        //
        // Linear scene fog only touches MESHES — the sky is drawn at infinity
        // and the sea carries its own haze — so fogNear/fogFar alone fogs the
        // hull and leaves it under a clear sky. That was the first take.
        //
        // The second take flattened the palette to grey and still came back
        // blue, because `skyPalette` applies the NIGHT TINT on top of whatever
        // colours it is given: a grey sky at -48 degrees is a blue-grey sky.
        // So the bank is shot just after sunrise instead — the sun is up, the
        // palette is flat grey, haze is pinned at 1 and the cloud layer is
        // switched off. The reference's fog is lit by the boat's own work
        // light against a colourless ground, which is what this gives; the
        // clock behind it is not in the picture.
        hazeStrength: 1,
        fogNear: 2,
        fogFar: 45,
        zenithColor: 0x8d949b,
        midColor: 0x969ca2,
        horizonColor: 0x9aa0a6,
        sunsetStrength: 0,
        horizonWarmStrength: 0,
        starBrightness: 0,
        moonIntensity: 0.08,
        moonDiscIntensity: 0,
        sunDiscIntensity: 0,
      },
      clouds: { coverage: 0 },
      // THE WATER'S HALF OF THE BANK. `sky.fogNear/fogFar` is scene fog and the
      // ocean opts out of it, so without this the sea stays clear to the
      // horizon under a grey sky with a ghost of a ship in the middle. The
      // melt target is the sky dome along each pixel's own ray, so a grey sky
      // gives a grey sea for free.
      oceanSurface: { hazeStart: 40, hazeEnd: 240, hazeCurve: 1 },
      lanterns: { intensity: 40, range: 60, color: 0xfff0e0, flickerDepth: 0.05 },
      post: { bloomThreshold: 0.4, bloomStrength: 1.6, bloomRadius: 0.9 },
    },
    note: 'End state: no ship. The bow exits lower-left and there is nothing left but fog.',
  },

  {
    id: 'Q',
    slug: 'fog',
    in: 216.93,
    out: 245.93,
    transition: 'fade',
    transitionSeconds: 3,
    frame: 'world',
    preroll: 10,
    keys: [
      { t: 0, pos: [0, 240, 0], aim: [90, 232, 40], fov: 50 },
      { t: 29, pos: [-70, 246, 22], aim: [20, 238, 62] },
    ],
    wobble: { yaw: 0.8, pitch: 0.5, roll: 0.6, hz: 0.04 },
    world: {
      sunElevationDeg: 1.2, sunSide: 'morning',
      weather: 'glass',
      shipAnchored: true,
      sky: {
        // A FOG BANK IS NOT `scene.fog`, and it is not a night either.
        //
        // Linear scene fog only touches MESHES — the sky is drawn at infinity
        // and the sea carries its own haze — so fogNear/fogFar alone fogs the
        // hull and leaves it under a clear sky. That was the first take.
        //
        // The second take flattened the palette to grey and still came back
        // blue, because `skyPalette` applies the NIGHT TINT on top of whatever
        // colours it is given: a grey sky at -48 degrees is a blue-grey sky.
        // So the bank is shot just after sunrise instead — the sun is up, the
        // palette is flat grey, haze is pinned at 1 and the cloud layer is
        // switched off. The reference's fog is lit by the boat's own work
        // light against a colourless ground, which is what this gives; the
        // clock behind it is not in the picture.
        hazeStrength: 1,
        fogNear: 2,
        fogFar: 25,
        zenithColor: 0x9298a0,
        midColor: 0x969ca2,
        horizonColor: 0x9aa0a6,
        sunsetStrength: 0,
        horizonWarmStrength: 0,
        starBrightness: 0,
        moonIntensity: 0.08,
        moonDiscIntensity: 0,
        sunDiscIntensity: 0,
      },
      clouds: { coverage: 0 },
      oceanSurface: { hazeStart: 20, hazeEnd: 120, hazeCurve: 1 },
      post: { vignetteStrength: 0.35, grainAmount: 0.014, bloomStrength: 0.4 },
    },
    note: '29 s of nothing, drifting at ~3 m/s inside the cloud layer. Needs internal structure or it renders flat grey - see gap #3.',
  },
];

/**
 * SUN ELEVATIONS, NOT CLOCK TIMES — and the night rungs are much lower than
 * the reference's clock would suggest. Measured on this sky: -6.5 degrees
 * still renders as broad daylight with lit cumulus, so the "blue hour" shots
 * sit at -8 to -11 and the night block runs -30 to -50. These are a first
 * calibration against rendered frames, not a physical claim; the numbers to
 * trust are the ones a look at the output confirms.
 */
export const TIMELINE_END = 245.93;

export const shotById = (id: string): Shot | undefined =>
  SHOTS.find((s) => s.id === id);
