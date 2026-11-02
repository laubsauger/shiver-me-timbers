/**
 * The Drift, Act 2 "Get the Drift", part A: from the first stars to Earth (drift.html, after Undertime).
 * Direction: /Users/flo/work/code/drift-narrative/get-the-drift/direction.md. Beat lengths in seconds:
 *
 *   galaxies  the dive through the web (from diveLead s before the act): its knots open into galaxies in the
 *             distance, the groups along the way resolve into clusters, ours comes up ahead
 *   ours      that one is ours: we glide down onto its disk
 *   band      inside: the Milky Way arcs over the dome
 *   sun       one star ahead brightens into the Sun
 *   earth     a blue point becomes Earth at dawn, seen from high above
 *
 * Distances are in Undertime's world units (the galaxies sit where its web's knots ended).
 */
import { registerParams } from './registry';

export interface GetTheDriftParams {
  /** s the act overlaps the end of Undertime (the knots open while the signature fades) */
  overlap: number;
  galaxies: number;
  ours: number;
  band: number;
  sun: number;
  earth: number;
  /** part B beats (direction-part-b.md) */
  timewave: number;
  lights: number;
  overshoot: number;
  flood: number;
  drift2: number;
  /** s, C1: the descent from over the spiral down to the raft, levelling out (wandering-on/direction.md) */
  landing: number;
  /** deg, the limb's elevation through the flood and Drift-2's glide down; Mm, the height it ends at over
   * the debris spiral */
  floodLimbEl: number;
  /** deg the eye looks further down through Drift-2, onto the spiral from high up (the landing levels it out). 0 since
   * the descent's track of 2026-10-31 (timeline.ts landingTrack): it brings the spiral to the middle of the view itself,
   * and a look down first made the levelling a turn down and back up */
  driftLook: number;
  driftAltitude: number;
  /** deg, dome elevation (straight ahead) of the point the floating matter gathers round, at Drift-2's end */
  gatherEl: number;
  /** deg, where on Earth that point is (latitude, longitude), and the compass heading straight ahead */
  gatherLat: number;
  gatherLon: number;
  heading: number;
  /** m, typical galaxy radius in the field */
  galaxySize: number;
  /** m, radius of our galaxy */
  ourRadius: number;
  /** m, how far ahead our galaxy's Sun point is when the act starts */
  ourDistance: number;
  /** deg, dome elevation / azimuth we approach the Sun point along */
  approachEl: number;
  approachAz: number;
  /** deg, lean of our galaxy's plane from the dome's meridian (its band arcs front → zenith → back) */
  bandLean: number;
  /** deg, dome elevation of the galactic centre seen from inside */
  centreEl: number;
  /** fraction of the radius the Sun sits from the centre */
  sunRadius: number;
  /**
   * THE DIVE INTO THE WEB (webDive.ts; the 2026-10-30 review: "fly into it … realise the vastness of this filament
   * network, then have the galaxies pop in in the distance, then OUR galaxy, and then start this whole zoom in"):
   * s before the act's start the dive begins (69 s: under Undertime's pull-back as it eases out, so the one move
   * hands over to the other without a stop — the 2026-11-01 note, "zoom all the way out, then stagnate a bit, and
   * then zoom all the way back in"; it began at 74 s, from rest, where the pull-back had come to rest), and the e-folds of distance it adds to the approach before the galaxies beat ends — the approach
   * then starts e^diveEfolds times further out, among the filaments, and is the same curve as before from `ours` on
   */
  diveLead: number;
  diveEfolds: number;
  /** fraction of the starting distance left at the end of the galaxies beat / of ours (inside the disk) */
  driftKeep: number;
  insideKeep: number;
  /** s of the earth beat the approach takes (the rest is the dawn) */
  earthApproach: number;
  /** how many times its final distance Earth starts at (a blue point beside the Sun) */
  earthFar: number;
  /** Mm (1000 km), the final height above the surface */
  orbitAltitude: number;
  /** deg, dome elevation of Earth's limb straight ahead once we have arrived */
  limbEl: number;
  /** deg the limb sinks through the dawn (the Sun climbing clear of it) */
  dawnSink: number;
  /**
   * deg the eye looks UP as it arrives over the planet (timeline.ts orbitLook): the whole view — planet, Sun and
   * stars together — turns down the dome by this much, so the limb lies low and curves round the front like an
   * orbit's horizon instead of standing across the dome as an arch; given back through the flood
   */
  orbitLook: number;
  /** deg the Sun climbs through the dawn (a time-lapse: the terminator sweeps toward the audience) */
  sunRise: number;
  /**
   * LIGHTS OUT (the 2026-11-02 next-level review, move 2, "the flood as Act 1's wave"; lifeLayers.ts floodFront,
   * lamp.ts): 1 = on, 0 = the approved flood as it was. ON by default since the 2026-11-02 spine review (it was off
   * until the user had seen it in seat-view clips; the spine "everything lost, a few remain, they find each other" was
   * approved that day with it in); `drift.html?lightsOut=0` turns it off for a page, the approved flood for an A/B (the
   * review scripts and drift-render.mjs pass it with `--query lightsOut=0`). On: the overshoot pushes on into the
   * front, a ragged front of water crosses the lit night
   * side toward the audience and the cities go out behind it in clusters, 4–5 s of near-black sit in the score's dip,
   * one warm lamp stays lit, blinking slowly, low in front — and only then does the Sun rise, `loSunLate` s later.
   */
  lightsOut: number;
  /** s from the flood's start the front leaves the far limb (on the score's last hit before its dip, 235.1 s of the
   * show), and the s it takes to cross everything in view (the last cluster is out `LO_CLUSTER` s after) */
  loFront: number;
  loFrontLen: number;
  /** deg, where on Earth the front starts from (latitude, longitude): east of the limb ahead, so it comes over it */
  loOriginLat: number;
  loOriginLon: number;
  /** deg, where the surviving lamp is (latitude, longitude): on the drowned Po delta's new sea, ~33 km from the raft,
   * 40° left of the landing's front as seen from it — where c4's answering lamp is (wandering/props.ts STATIONS'
   * −40°; the 2026-11-02 review, round 2: "it ties into Act 3"). Through the black it holds still ~0.5° left of
   * straight ahead, 20° up; it swings out with the lit ground to ~−40° as the eye comes down (lamp.ts) */
  loLampLat: number;
  loLampLon: number;
  /** s, one slow blink of the lamp where the score sets none (lamp.ts: before its first pulse, after the dawn's hit) */
  loBlink: number;
  /** s the Sun rises later than the approved flood's (timeline.ts sunDay) */
  loSunLate: number;
  /** s from the flood's start of the score's hit that starts the dawn (252.3 s of the show), and how far (deg) the
   * Sun is behind the limb then: the limb's glow comes up out of nothing from it (timeline.ts sunDay; the 2026-11-02
   * review, round 2: "let the 252.3 s hit start the limb's dawn glow growing"). Measured on the first Lights Out clip
   * (2048² dome): the glow first lifts off the black with the Sun ~6° behind the limb (at 9° nothing; 4.6° faint; at
   * the limb bright). Checked from row 8 (the round-2 seat clips, 250–255 s): at 6.5° on the hit a thin arc starts
   * on it (none at 250.5 s, a faint line at 252.3 s, clear by 254 s); at 5.5° it was already there at 250.5 s, 2 s
   * before the hit. So 6.5° */
  loDawnAt: number;
  loDawnDepth: number;
  /** s from the flood's start the Sun clears the limb: on the score's next hit (262.8 s of the show) */
  loRiseAt: number;
  /** 0..1 how much of the night side's moonlight the black takes (earth.ts; life.ts moon): the ground goes black
   * behind the front with the cities, so the lamp is the one thing left — given back from the dawn's hit to the rise */
  loMoonDim: number;
  /** how much further the overshoot pushes past its balance (1 = its full overshoot again) while the front comes */
  loPush: number;
  galaxyRadiance: number;
  volumeRadiance: number;
  /** ray-march steps through our galaxy */
  marchSteps: number;
  exposure: number;
}

export const getTheDriftParams: GetTheDriftParams = registerParams(
  'getTheDrift',
  {
    overlap: 5,
    galaxies: 18,
    ours: 24,
    band: 10,
    sun: 12,
    earth: 42,
    timewave: 22,
    lights: 22,
    overshoot: 10,
    flood: 24,
    drift2: 20,
    landing: 50,
    floodLimbEl: 38,
    driftLook: 0,
    driftAltitude: 0.03,
    gatherEl: -1.5,
    gatherLat: 45.05,
    gatherLon: 11.9,
    heading: 90,
    galaxySize: 0.45,
    ourRadius: 1.6,
    ourDistance: 14,
    approachEl: 48,
    approachAz: -45,
    bandLean: 20,
    centreEl: 14,
    sunRadius: 0.55,
    diveLead: 12,
    diveEfolds: 3,
    driftKeep: 0.72,
    insideKeep: 6e-3,
    earthApproach: 25,
    earthFar: 700,
    orbitAltitude: 0.45,
    limbEl: 42,
    dawnSink: 5,
    orbitLook: 16,
    sunRise: 38,
    // (?lightsOut=0: the review switch, read once at load — as wandering/raft.ts reads ?raftplain; the lamp is built
    // only when it is on, act.ts. A bare ?lightsOut, the switch while it was off by default, still means on)
    lightsOut: typeof location !== 'undefined' && new URLSearchParams(location.search).get('lightsOut') === '0' ? 0 : 1,
    loFront: -5.9,
    loFrontLen: 4.3,
    loOriginLat: 45,
    loOriginLon: 30,
    loLampLat: 45.22,
    loLampLon: 12.24,
    loBlink: 3.2,
    loSunLate: 15,
    loDawnAt: 11.3,
    loDawnDepth: 6.5,
    loRiseAt: 21.8,
    loMoonDim: 0.75,
    loPush: 0.4,
    galaxyRadiance: 1.2,
    volumeRadiance: 0.2,
    marchSteps: 72,
    exposure: 1,
  },
  {
    overlap: { min: 0, max: 15, step: 0.5 },
    galaxies: { min: 1, max: 60, step: 0.5 },
    ours: { min: 1, max: 60, step: 0.5 },
    band: { min: 0, max: 60, step: 0.5 },
    sun: { min: 0, max: 60, step: 0.5 },
    earth: { min: 0, max: 60, step: 0.5 },
    timewave: { min: 0, max: 60, step: 0.5 },
    lights: { min: 0, max: 60, step: 0.5 },
    overshoot: { min: 0, max: 60, step: 0.5 },
    flood: { min: 1, max: 60, step: 0.5 },
    drift2: { min: 0, max: 60, step: 0.5 },
    landing: { min: 10, max: 120, step: 1 },
    floodLimbEl: { min: 0, max: 60, step: 1 },
    driftLook: { min: 0, max: 40, step: 1 },
    driftAltitude: { min: 0.001, max: 1, step: 0.001 },
    gatherEl: { min: -30, max: 50, step: 0.5 },
    gatherLat: { min: 19, max: 67, step: 0.05 },
    gatherLon: { min: -24, max: 44, step: 0.05 },
    heading: { min: 0, max: 359, step: 1 },
    galaxySize: { min: 0.1, max: 5, step: 0.05 },
    ourRadius: { min: 0.2, max: 6, step: 0.05 },
    ourDistance: { min: 2, max: 60, step: 0.5 },
    approachEl: { min: 0, max: 80, step: 1 },
    approachAz: { min: -90, max: 90, step: 1 },
    bandLean: { min: -60, max: 60, step: 1 },
    centreEl: { min: 0, max: 60, step: 1 },
    sunRadius: { min: 0.1, max: 0.9, step: 0.01 },
    diveLead: { min: 0, max: 20, step: 0.5 },
    diveEfolds: { min: 0, max: 4, step: 0.05 },
    driftKeep: { min: 0.1, max: 1, step: 0.01 },
    insideKeep: { min: 1e-5, max: 0.01, step: 1e-5 },
    earthApproach: { min: 4, max: 60, step: 0.5 },
    earthFar: { min: 10, max: 10000, step: 10 },
    orbitAltitude: { min: 0.2, max: 20, step: 0.05 },
    limbEl: { min: 0, max: 50, step: 1 },
    dawnSink: { min: 0, max: 20, step: 0.5 },
    orbitLook: { min: 0, max: 30, step: 0.5 },
    sunRise: { min: 0, max: 80, step: 1 },
    lightsOut: { min: 0, max: 1, step: 1 },
    loFront: { min: -10, max: 0, step: 0.1 },
    loFrontLen: { min: 1, max: 10, step: 0.1 },
    loOriginLat: { min: -90, max: 90, step: 0.5 },
    loOriginLon: { min: -180, max: 180, step: 0.5 },
    loLampLat: { min: 44, max: 46, step: 0.01 },
    loLampLon: { min: 11, max: 14, step: 0.01 },
    loBlink: { min: 1.5, max: 8, step: 0.1 },
    loSunLate: { min: 0, max: 30, step: 0.5 },
    loDawnAt: { min: 0, max: 25, step: 0.1 },
    loDawnDepth: { min: 0, max: 30, step: 0.5 },
    loRiseAt: { min: 0, max: 30, step: 0.1 },
    loMoonDim: { min: 0, max: 1, step: 0.05 },
    loPush: { min: 0, max: 1, step: 0.05 },
    galaxyRadiance: { min: 0, max: 10, step: 0.05 },
    volumeRadiance: { min: 0, max: 10, step: 0.05 },
    marchSteps: { min: 8, max: 256, step: 1 },
    exposure: { min: 0.05, max: 8, step: 0.05 },
  },
);
