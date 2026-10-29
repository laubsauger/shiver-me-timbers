/**
 * The Drift — fulldome origin story (drift.html). Act 1 "Undertime" tunables.
 *
 * Content and treatment: /Users/flo/work/code/drift-narrative/undertime/treatment.md.
 * Direction: drift-narrative/undertime/direction.md. The beats run in this order; each value is that
 * beat's length in seconds:
 *
 *   first   black; one hero pair overhead, its light shell sweeps the dome (the first light)
 *   arise   pairs ignite, a few then everywhere, until the dome boils
 *   cool    time slows: fewer, slower, longer pairs; the field turns; text windows
 *   wave    an annihilation front sweeps front → zenith → back; nothing is born behind it
 *   remain  darkness; one warm grain in front, then a few more; text
 *   zoom    pull back through orders of magnitude; the grains are seen to lie on a web
 *   gather  the web's knots ignite as the first stars; the signature
 *
 * Colour script: matter is warm amber-gold, antimatter cool cyan-violet, their light neutral gold-white. What
 * remains is matter, so it stays amber (`grainWarmth` tints it a little toward starlight) — the warm thing on
 * the dome is the thing that will become us; the first stars light amber to white and blue-white.
 *
 * Reload-scoped: `pairSlots`, `grainCount` (instance counts, baked into the draw).
 */
import { registerParams } from './registry';

export interface DriftParams {
  first: number;
  arise: number;
  cool: number;
  wave: number;
  remain: number;
  zoom: number;
  gather: number;
  /** field-s per act-s once cooled: how far "time slows" */
  slowRate: number;
  /** 0..1 pair density at the end of the cooling (what the wave front finds) */
  coolDensity: number;
  /** deg, field lean at the end of the cooling (it turns from `fieldTilt`) */
  fieldTiltEnd: number;
  /** m/s, top speed of the forward drift through the field (arise → cool) */
  driftSpeed: number;
  /** m, the slow approach toward the hero grain in the remain beat */
  approach: number;
  /** s, act time the hero pair is born (after the black) */
  heroBirth: number;
  /** m/s, hero pair launch speed (its spirals' size) */
  heroSpeed: number;
  /** m/s, speed of the hero's light shells (they pass the audience) */
  heroShellSpeed: number;
  heroShellRadiance: number;
  /** deg / m, where the hero grain sits in front (the zoom's pivot) */
  heroGrainEl: number;
  heroGrainDist: number;
  /** 0..1, grains' colour from matter toward starlight */
  grainWarmth: number;
  starRadiance: number;
  /** linear radiance of the wave front's band of light (U3) */
  waveRadiance: number;
  /** linear radiance of the wave front's sparks (U3) */
  sparkRadiance: number;
  /** 1: the event grammar (photon collisions, looping pairs, plasma); 0: the spiral tracks (look-dev A/B) */
  grammar: number;
  /** concurrent pair slots; each draws two tracks and seven light sprites */
  pairSlots: number;
  /** quads per track ribbon */
  trackSegments: number;
  /** s of history a track shows behind its head */
  trackTail: number;
  /** m, track ribbon half-width at the head */
  trackWidth: number;
  /** m/s, launch speed of a pair's particles */
  trackSpeed: number;
  /** rad/s, how fast tracks curl around the field */
  trackCurl: number;
  /** 1/s, energy loss: how fast a track spirals in */
  trackDrag: number;
  /** deg, the field leans this far from the zenith toward the front */
  fieldTilt: number;
  /** linear radiance of a track at its head */
  trackRadiance: number;
  /** m, annihilation core sprite size */
  coreSize: number;
  coreRadiance: number;
  /** m/s, how fast an annihilation's light shell expands */
  shellSpeed: number;
  shellRadiance: number;
  /** m, size of the lingering haze an annihilation leaves */
  hazeSize: number;
  hazeRadiance: number;
  /** bloom on the finished frame (master or flat view) */
  bloomStrength: number;
  bloomRadius: number;
  bloomThreshold: number;
  /** leftover grains of matter, over all zoom levels */
  grainCount: number;
  /** m — pairs are scattered in a shell around the camera, this is its outer radius */
  fieldRadius: number;
  /** m — sprite size of one particle */
  particleSize: number;
  /** s — one pair's life, birth to flash (jittered ±30 % per slot) */
  pairLife: number;
  /** orders of magnitude the zoom beat pulls back through */
  zoomDecades: number;
  /** the web (webVolume.ts): box units the eye ends from the hero knot; deg the flight line turns through;
   * the gas's radiance */
  webReach: number;
  webTurn: number;
  webRadiance: number;
  matterColor: number;
  antimatterColor: number;
  /** annihilation light, the flashes and the dome-wide glow */
  lightColor: number;
  /** first starlight */
  starColor: number;
  /** linear exposure into the ACES tone map */
  exposure: number;
  /** linear radiance of matter/antimatter sprites (HDR, before the tone map) */
  particleRadiance: number;
  /** deg, elevation of a text phrase's first line as it appears (keep text at 25–40° in front) */
  crawlElTop: number;
  /** deg, how far a phrase sinks while it is read */
  crawlSink: number;
  /** deg, where "the Drift" settles and holds */
  crawlHoldEl: number;
  /** text height as a fraction of the master width (0.033 ≈ a 3° x-height) */
  crawlSize: number;
  /** rad, the widest a line may span in azimuth (±50° safe zone ≈ 1.75) */
  crawlMaxArc: number;
  /** linear radiance the crawl is composited at (before the tone map) */
  crawlRadiance: number;
  /** 0..1, how strongly the field stays out of the sky the crawl is passing through */
  crawlPocket: number;
  /** deg, azimuth half-width of that pocket (the crawl spans at most ±crawlMaxArc/2) */
  crawlPocketAz: number;
  /** deg — tilt of the dome's zenith toward the front (Horizon 18: 15) */
  domeTilt: number;
  /** px — cube face resolution for dome capture */
  domeFace: number;
  /** 0..1 — the sea acts' ambient occlusion (cine/domeAo.ts): how much of it their indirect light takes (0: off) */
  seaAo: number;
  /** m — how far an occluder reaches in the sea acts (contact and crevice scale: a log's girth, a trunk's foot) */
  seaAoRadius: number;
}

export const driftParams: DriftParams = registerParams(
  'drift',
  {
    first: 7,
    arise: 11,
    cool: 20,
    wave: 7,
    remain: 10,
    zoom: 18,
    gather: 13,
    slowRate: 0.4,
    coolDensity: 0.3,
    fieldTiltEnd: 70,
    driftSpeed: 0.35,
    approach: 1.2,
    heroBirth: 1.4,
    heroSpeed: 12,
    heroShellSpeed: 7,
    heroShellRadiance: 3,
    heroGrainEl: 52,
    heroGrainDist: 7,
    grainWarmth: 0.3,
    starRadiance: 40,
    waveRadiance: 0.6,
    sparkRadiance: 8,
    grammar: 1,
    pairSlots: 2600,
    trackSegments: 40,
    trackTail: 2,
    trackWidth: 0.016,
    trackSpeed: 4.5,
    trackCurl: 3.4,
    trackDrag: 0.4,
    fieldTilt: 25,
    trackRadiance: 5,
    coreSize: 0.22,
    coreRadiance: 14,
    shellSpeed: 12,
    shellRadiance: 0,
    hazeSize: 3,
    hazeRadiance: 0.01,
    bloomStrength: 0.12,
    bloomRadius: 0.25,
    bloomThreshold: 1.4,
    grainCount: 6000,
    fieldRadius: 30,
    particleSize: 0.22,
    pairLife: 3.2,
    zoomDecades: 2,
    webReach: 0.3,
    webTurn: 20,
    webRadiance: 3,
    matterColor: 0xffb44c,
    antimatterColor: 0x6e9cff,
    lightColor: 0xfff0d8,
    starColor: 0xffd394,
    exposure: 1,
    particleRadiance: 2.4,
    crawlElTop: 37,
    crawlSink: 5,
    crawlHoldEl: 30,
    crawlSize: 0.033,
    crawlMaxArc: 1.6,
    crawlRadiance: 1.4,
    crawlPocket: 1,
    crawlPocketAz: 40,
    domeTilt: 15,
    domeFace: 1024,
    seaAo: 1,
    // (1.8 m, not the 1 m it was built at: at 1 m it darkened by at most 20/255, and the trees and the raft still
    // read "pasted on" — the reach of a crown's or a cabin's shade is metres, 2026-10-29)
    seaAoRadius: 1.8,
  },
  {
    first: { min: 0, max: 60, step: 0.5 },
    arise: { min: 0, max: 60, step: 0.5 },
    cool: { min: 0, max: 60, step: 0.5 },
    wave: { min: 0.5, max: 60, step: 0.5 },
    remain: { min: 0, max: 60, step: 0.5 },
    zoom: { min: 0, max: 60, step: 0.5 },
    gather: { min: 0, max: 60, step: 0.5 },
    slowRate: { min: 0.05, max: 1, step: 0.01 },
    coolDensity: { min: 0, max: 1, step: 0.01 },
    fieldTiltEnd: { min: 0, max: 90, step: 1 },
    driftSpeed: { min: 0, max: 2, step: 0.01 },
    approach: { min: 0, max: 5, step: 0.05 },
    heroBirth: { min: 0, max: 6, step: 0.05 },
    heroSpeed: { min: 0.5, max: 30, step: 0.25 },
    heroShellSpeed: { min: 0.5, max: 30, step: 0.25 },
    heroShellRadiance: { min: 0, max: 10, step: 0.05 },
    heroGrainEl: { min: 10, max: 80, step: 1 },
    heroGrainDist: { min: 2, max: 30, step: 0.25 },
    grainWarmth: { min: 0, max: 1, step: 0.01 },
    starRadiance: { min: 0, max: 100, step: 0.5 },
    waveRadiance: { min: 0, max: 10, step: 0.05 },
    sparkRadiance: { min: 0, max: 60, step: 0.5 },
    fieldRadius: { min: 2, max: 200, step: 1 },
    particleSize: { min: 0.01, max: 1, step: 0.01 },
    pairLife: { min: 0.3, max: 10, step: 0.1 },
    zoomDecades: { min: 0, max: 6, step: 0.25 },
    webReach: { min: 0.01, max: 0.6, step: 0.005 },
    webTurn: { min: 0, max: 60, step: 1 },
    webRadiance: { min: 0, max: 20, step: 0.05 },
    exposure: { min: 0.05, max: 8, step: 0.05 },
    particleRadiance: { min: 0, max: 40, step: 0.1 },
    trackTail: { min: 0.05, max: 4, step: 0.05 },
    trackWidth: { min: 0.002, max: 0.2, step: 0.001 },
    trackSpeed: { min: 0.1, max: 20, step: 0.1 },
    trackCurl: { min: 0, max: 12, step: 0.05 },
    trackDrag: { min: 0.05, max: 5, step: 0.05 },
    fieldTilt: { min: 0, max: 90, step: 1 },
    trackRadiance: { min: 0, max: 30, step: 0.1 },
    coreSize: { min: 0.01, max: 3, step: 0.01 },
    coreRadiance: { min: 0, max: 100, step: 0.5 },
    shellSpeed: { min: 0, max: 40, step: 0.25 },
    shellRadiance: { min: 0, max: 20, step: 0.05 },
    hazeSize: { min: 0, max: 40, step: 0.25 },
    hazeRadiance: { min: 0, max: 2, step: 0.005 },
    bloomStrength: { min: 0, max: 3, step: 0.01 },
    bloomRadius: { min: 0, max: 1, step: 0.01 },
    bloomThreshold: { min: 0, max: 4, step: 0.01 },
    crawlElTop: { min: 10, max: 60, step: 1 },
    crawlSink: { min: 0, max: 20, step: 0.5 },
    crawlHoldEl: { min: 0, max: 60, step: 1 },
    crawlSize: { min: 0.005, max: 0.1, step: 0.001 },
    crawlMaxArc: { min: 0.3, max: 3.1, step: 0.05 },
    crawlRadiance: { min: 0, max: 10, step: 0.05 },
    crawlPocket: { min: 0, max: 1, step: 0.01 },
    crawlPocketAz: { min: 10, max: 120, step: 1 },
    domeTilt: { min: 0, max: 30, step: 0.5 },
    seaAo: { min: 0, max: 1, step: 0.01 },
    seaAoRadius: { min: 0.1, max: 4, step: 0.05 },
  },
);
