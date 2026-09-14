/**
 * NAMED GRADE MODES.
 *
 * Two different jobs want two different images out of the same renderer:
 *
 *   game   — what the game ships with. The player's grade; untouched.
 *   cine   — the shooting grade (docs/cine/warfish-alan-watts-camera-script.md
 *            §2). Crushed blacks, early bloom, a warm/cool split, visible
 *            grain, a heavy vignette, DOF on. It exists to answer a reference
 *            that is 95% black in its first act, and it is deliberately a bad
 *            grade to play the game in.
 *
 * A mode is a batch of writes into the LIVE params objects — the same shape a
 * weather preset is (weather/applyPreset.ts), for the same reason: there is
 * one source of truth for the look and it is the params registry, so a mode
 * and a panel drag cannot disagree.
 *
 * The `game` mode is captured from the params' own defaults at import time
 * rather than written out by hand here. A hand-copy is a second opinion about
 * the shipped look, and it goes stale the first time anyone tunes the real
 * one.
 */
import { gradeParams } from '../params/grade';
import { postParams } from '../params/post';

export type GradeMode = 'game' | 'cine' | 'cine-flat';

type Patch = {
  grade?: Partial<typeof gradeParams>;
  post?: Partial<typeof postParams>;
};

/** the shipped look, snapshotted before anything has had a chance to move it */
const SHIPPED: Patch = {
  grade: { ...gradeParams },
  post: { ...postParams },
};

/**
 * The shooting grade. Only the keys that DIFFER from the shipped look are
 * listed, so switching back to `game` restores those keys and nothing else
 * has to be kept in step.
 */
export const CINE_GRADE: Patch = {
  post: {
    grainEnabled: true,
    // 0.006 is a clean modern digital look; the reference is 16 mm-ish and
    // its grain is part of why the black holds together instead of banding
    grainAmount: 0.012,
    vignetteEnabled: true,
    vignetteStrength: 0.5,
    vignetteStart: 0.38,
    vignetteEnd: 0.8,
    bloomEnabled: true,
    // blooms EARLY on purpose: every hero image in the reference is a blown
    // highlight against a crushed black, and a 1.0 threshold never gets there
    bloomThreshold: 0.65,
    bloomStrength: 0.85,
    bloomRadius: 0.7,
    godRaysEnabled: true,
    dofEnabled: true,
    vibranceEnabled: true,
    vibrance: 0.1,
    flareStrength: 0.8,
    flareThreshold: 0.5,
    flareGhosts: 6,
    flareSpacing: 0.22,
    flareAttenuation: 20,
    flareTintR: 1.0,
    flareTintG: 0.8,
    flareTintB: 0.6,
    streakStrength: 0.55,
  },
  grade: {
    enabled: true,
    // blacks crushed HARDER, and the blue taken out of them. The night in this
    // engine is already moonlit blue — the key light IS the moon — so a blue
    // shadow tint on top of it stacked two blues and drowned the hull in the
    // result. The split now barely tilts, and the lift is deeper: the
    // reference's night reads as near-monochrome dark with one warm lamp in
    // it, not as a blue picture.
    liftR: -0.022,
    liftG: -0.024,
    liftB: -0.03,
    gammaR: 0.94,
    gammaG: 0.94,
    gammaB: 0.96,
    saturation: 0.8,
    splitStrength: 0.14,
    splitPivot: 0.45,
    shadowTintR: 0.47,
    shadowTintG: 0.49,
    shadowTintB: 0.54,
    highlightTintR: 0.6,
    highlightTintG: 0.53,
    highlightTintB: 0.43,
  },
};

/**
 * CLEAN PLATE. Everything that is a COLOUR decision is off; everything that is
 * an OPTICAL one stays on.
 *
 * The distinction is what can be added later and what cannot. Depth of field
 * and bloom happen at the lens and are unrecoverable from a flat render — no
 * grade puts a real defocus back. Contrast, saturation, split-toning, vignette
 * and grain are all trivially better done in a proper grading tool over a
 * clean negative, and baking them in only removes headroom.
 *
 * Grain especially: this engine's grain is a fixed pattern rather than a
 * per-frame one, so at the doubled amount the shooting grade used it reads as
 * repeating fixed-pattern noise sitting still on top of a moving image — which
 * is exactly the artefact it was meant to hide.
 */
export const CINE_FLAT: Patch = {
  post: {
    grainEnabled: false,
    vignetteEnabled: false,
    vibranceEnabled: false,
    bloomEnabled: true,
    bloomThreshold: 0.9,
    bloomStrength: 0.5,
    bloomRadius: 0.6,
    godRaysEnabled: true,
    dofEnabled: true,
    // the flare and the streak STAY: they happen at the lens, and no grade
    // puts a ghost chain back over a clean plate
    flareStrength: 0.8,
    flareThreshold: 0.5,
    flareGhosts: 6,
    flareSpacing: 0.22,
    flareAttenuation: 20,
    flareTintR: 1.0,
    flareTintG: 0.8,
    flareTintB: 0.6,
    streakStrength: 0.5,
  },
  grade: { enabled: false },
};

const MODES: Record<GradeMode, Patch> = {
  game: SHIPPED,
  cine: CINE_GRADE,
  'cine-flat': CINE_FLAT,
};

let current: GradeMode = 'game';

function write(target: Record<string, unknown>, src: Record<string, unknown> | undefined): void {
  if (src === undefined) return;
  for (const k of Object.keys(src)) target[k] = src[k];
}

/**
 * Switch the look. Going back to `game` re-applies the FULL shipped snapshot,
 * not just the keys `cine` touched — a shot's own per-shot post overrides
 * (shotlist.ts) also land in these objects, and leaving one of those behind
 * would quietly change the game's look after a shoot.
 */
export function applyGradeMode(mode: GradeMode): void {
  const patch = MODES[mode];
  if (mode === 'game') {
    write(gradeParams as unknown as Record<string, unknown>, SHIPPED.grade as Record<string, unknown>);
    write(postParams as unknown as Record<string, unknown>, SHIPPED.post as Record<string, unknown>);
  } else {
    write(gradeParams as unknown as Record<string, unknown>, patch.grade as Record<string, unknown>);
    write(postParams as unknown as Record<string, unknown>, patch.post as Record<string, unknown>);
  }
  current = mode;
}

export function gradeMode(): GradeMode {
  return current;
}

export const GRADE_MODES: readonly GradeMode[] = ['game', 'cine', 'cine-flat'];
