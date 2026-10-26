/**
 * The Drift — fulldome origin story (drift.html). Act 1 "Undertime" tunables.
 *
 * Content and treatment: /Users/flo/work/code/drift-narrative/undertime/treatment.md.
 * The beats run in this order; each value is that beat's length in seconds:
 *
 *   boil        pairs arise and cancel so densely the dome is near white
 *   cool        the rate drops; single pairs become readable, each flash spreads light
 *   annihilate  a final wave of cancellations floods the dome with light
 *   remain      the light fades to an even glow; the leftover grains drift
 *   zoom        pull back through orders of magnitude; the grains become a sparse field
 *   gather      the grains drift together into the first points of starlight
 *
 * Two colours only (treatment §Visual grammar): matter and antimatter. A leftover grain keeps the
 * MATTER colour; there is no third colour for it. The flash and the dome-wide glow are light.
 *
 * Reload-scoped: `pairSlots`, `grainCount` (instance counts, baked into the draw).
 */
import { registerParams } from './registry';

export interface DriftParams {
  boil: number;
  cool: number;
  annihilate: number;
  remain: number;
  zoom: number;
  gather: number;
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
  /** leftover grains of matter */
  grainCount: number;
  /** m — pairs are scattered in a shell around the camera, this is its outer radius */
  fieldRadius: number;
  /** m — sprite size of one particle */
  particleSize: number;
  /** s — one pair's life, birth to flash (jittered ±30 % per slot) */
  pairLife: number;
  /** orders of magnitude the zoom beat pulls back through */
  zoomDecades: number;
  /** clusters the grains gather into */
  clusters: number;
  matterColor: number;
  antimatterColor: number;
  /** annihilation light, the flashes and the dome-wide glow */
  lightColor: number;
  /** first starlight in the gather beat */
  starColor: number;
  /** linear exposure into the ACES tone map */
  exposure: number;
  /** linear radiance of matter/antimatter sprites (HDR, before the tone map) */
  particleRadiance: number;
  /** s, act time the first crawl line appears (the treatment starts it as the boil cools) */
  crawlStart: number;
  /** s between crawl line starts */
  crawlGap: number;
  /** s a line takes from mid-heaven to the horizon */
  crawlTravel: number;
  /** deg, crawl lines appear / leave at these elevations (front safe zone: 10–60°) */
  crawlElTop: number;
  crawlElBottom: number;
  /** deg, where "the Drift" stops and holds */
  crawlHoldEl: number;
  /** text height as a fraction of the master width, at the top and at the bottom */
  crawlSizeTop: number;
  crawlSizeBottom: number;
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
}

export const driftParams: DriftParams = registerParams(
  'drift',
  {
    boil: 8,
    cool: 14,
    annihilate: 6,
    remain: 10,
    zoom: 12,
    gather: 14,
    pairSlots: 3000,
    trackSegments: 40,
    trackTail: 1.4,
    trackWidth: 0.016,
    trackSpeed: 4.5,
    trackCurl: 2.6,
    trackDrag: 0.9,
    fieldTilt: 25,
    trackRadiance: 6,
    coreSize: 0.35,
    coreRadiance: 14,
    shellSpeed: 12,
    shellRadiance: 0.3,
    hazeSize: 5,
    hazeRadiance: 0.02,
    bloomStrength: 0.35,
    bloomRadius: 0.25,
    bloomThreshold: 1.4,
    grainCount: 900,
    fieldRadius: 30,
    particleSize: 0.22,
    pairLife: 2.2,
    zoomDecades: 3,
    clusters: 7,
    matterColor: 0x7fd4ff,
    antimatterColor: 0xff3f8e,
    lightColor: 0xfff1dc,
    starColor: 0xffd394,
    exposure: 1,
    particleRadiance: 1.6,
    crawlStart: 9,
    crawlGap: 6,
    crawlTravel: 12,
    crawlElTop: 58,
    crawlElBottom: 12,
    crawlHoldEl: 32,
    crawlSizeTop: 0.036,
    crawlSizeBottom: 0.015,
    crawlMaxArc: 1.6,
    crawlRadiance: 1.4,
    crawlPocket: 0.85,
    crawlPocketAz: 40,
    domeTilt: 15,
    domeFace: 1024,
  },
  {
    boil: { min: 0, max: 60, step: 0.5 },
    cool: { min: 0, max: 60, step: 0.5 },
    annihilate: { min: 0, max: 60, step: 0.5 },
    remain: { min: 0, max: 60, step: 0.5 },
    zoom: { min: 0, max: 60, step: 0.5 },
    gather: { min: 0, max: 60, step: 0.5 },
    fieldRadius: { min: 2, max: 200, step: 1 },
    particleSize: { min: 0.01, max: 1, step: 0.01 },
    pairLife: { min: 0.3, max: 10, step: 0.1 },
    zoomDecades: { min: 0, max: 6, step: 0.25 },
    clusters: { min: 1, max: 24, step: 1 },
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
    crawlStart: { min: 0, max: 60, step: 0.5 },
    crawlGap: { min: 0.5, max: 20, step: 0.25 },
    crawlTravel: { min: 1, max: 40, step: 0.5 },
    crawlElTop: { min: 10, max: 89, step: 1 },
    crawlElBottom: { min: 0, max: 60, step: 1 },
    crawlHoldEl: { min: 0, max: 89, step: 1 },
    crawlSizeTop: { min: 0.002, max: 0.1, step: 0.001 },
    crawlSizeBottom: { min: 0.002, max: 0.1, step: 0.001 },
    crawlMaxArc: { min: 0.3, max: 3.1, step: 0.05 },
    crawlRadiance: { min: 0, max: 10, step: 0.05 },
    crawlPocket: { min: 0, max: 1, step: 0.01 },
    crawlPocketAz: { min: 10, max: 120, step: 1 },
    domeTilt: { min: 0, max: 30, step: 0.5 },
  },
);
