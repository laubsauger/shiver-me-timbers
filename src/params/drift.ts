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
  /** concurrent pair slots; each draws matter + antimatter + flash */
  pairSlots: number;
  /** leftover grains of matter */
  grainCount: number;
  /** m — pairs are scattered in a shell around the camera, this is its outer radius */
  fieldRadius: number;
  /** m — sprite size of one particle */
  particleSize: number;
  /** m — the most a pair separates before it rejoins */
  pairSeparation: number;
  /** s — one pair's life, birth to flash (jittered ±30 % per slot) */
  pairLife: number;
  /** how many times its own size a flash grows */
  flashGrow: number;
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
  /** linear radiance of a flash at full strength */
  flashRadiance: number;
  /** linear radiance of the dome-wide light fill at glow = 1 */
  glowRadiance: number;
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
    pairSlots: 20000,
    grainCount: 900,
    fieldRadius: 30,
    particleSize: 0.22,
    pairSeparation: 0.9,
    pairLife: 2.2,
    flashGrow: 6,
    zoomDecades: 3,
    clusters: 7,
    matterColor: 0x8fb4ff,
    antimatterColor: 0xff4d7a,
    lightColor: 0xfff1dc,
    starColor: 0xffd394,
    exposure: 1,
    particleRadiance: 1.6,
    flashRadiance: 3,
    glowRadiance: 0.22,
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
    pairSeparation: { min: 0, max: 5, step: 0.05 },
    pairLife: { min: 0.3, max: 10, step: 0.1 },
    flashGrow: { min: 1, max: 40, step: 0.5 },
    zoomDecades: { min: 0, max: 6, step: 0.25 },
    clusters: { min: 1, max: 24, step: 1 },
    exposure: { min: 0.05, max: 8, step: 0.05 },
    particleRadiance: { min: 0, max: 40, step: 0.1 },
    flashRadiance: { min: 0, max: 60, step: 0.1 },
    glowRadiance: { min: 0, max: 4, step: 0.01 },
    domeTilt: { min: 0, max: 30, step: 0.5 },
  },
);
