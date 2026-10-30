/**
 * THE GLOW PROFILE of Undertime's lights — a trail across its width, a bead, a flash — as a sharp CORE plus a soft
 * HALO, the way a point of light reaches a camera through its lens (a point-spread function: a narrow peak in a
 * wide, low skirt), shared by loops.ts and products.ts.
 *
 * Why (the 2026-10-30 note on the intro particles: "the particles' bloom falloff … can still end up a little bit
 * thick and doesn't have a smooth enough falloff, so we still see it … too thick in the inner and outer parts, just a
 * smidge"). The old profiles were single Gaussians cut off by a smoothstep where their quad ended, while still at a
 * few percent (a bead's halo at 5 %, a flash's broad term at ~3 linear where the cut began): an edge, a ring, a
 * "blob" where there should be only a fade. Now:
 *
 *   - both terms are Gaussians, the halo multiplied by the WINDOW (1 − r²)², which is 1 at the centre and reaches 0
 *     with zero slope at the quad's edge — nothing ends, and the halo's own Gaussian is already under 1 % there;
 *   - the quad is larger (×1.5–1.6) so the wider halo fits inside it;
 *   - each term keeps its ENERGY as its width changes (a Gaussian's integral goes as its width, in 1D for a ribbon's
 *     cross-section, squared in 2D for a sprite): the core ~10 % thinner is brighter at its centre, the same light;
 *     the halo ~25 % wider is lower, ~0.9 of its old light.
 *
 * Widths are in the quad's own units (u or r from 0 at the centre to 1 at the edge). `GlowProfile` scales them
 * (params glowCore, glowHalo, glowHaloGain; 1 is the default above).
 */
import * as THREE from 'three/webgpu';
import { cameraPosition, exp, float, normalize, smoothstep } from 'three/tsl';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

export interface GlowProfile {
  /** × the core's width */
  core: F;
  /** × the halo's width */
  halo: F;
  /** × the halo's energy */
  haloGain: F;
}

/** (1 − r²)²: 1 at the centre, 0 with zero slope at r = 1 (r² clamped) */
export const glowWindow = (r2: F): F => {
  const k = float(1).sub(r2.min(1));
  return k.mul(k);
};

/**
 * A RIBBON's cross-profile at u ∈ [−1, 1] (u = ±1 its edges), for a ribbon drawn `spread` times wider than before,
 * whose old core was e^(−u²/(2·σc²)) and old halo e^(−u²/(2·σh²)) (σ in the OLD ribbon's units, both at peak 1).
 * Returns each term with its energy kept relative to that old one (multiply by the old peak gains as before).
 */
export function ribbonGlow(u: F, spread: F, G: GlowProfile, old: { sigmaCore: number; sigmaHalo: number }): { core: F; halo: F } {
  const u2 = u.mul(u);
  // in the widened ribbon's units: the core 10 % thinner × glowCore, the halo 25 % wider × glowHalo
  const sc = G.core.mul(old.sigmaCore * 0.9).div(spread);
  const sh = G.halo.mul(old.sigmaHalo * 1.25).div(spread);
  // energy kept (1D: peak × width): the old σ in the new ribbon's units is σ/spread, so the peak goes as 1/width-factor
  const ac = float(1).div(G.core.mul(0.9));
  const ah = float(0.9).mul(G.haloGain).div(G.halo.mul(1.25));
  return {
    core: exp(u2.div(sc.mul(sc).mul(2)).negate()).mul(ac),
    halo: exp(u2.div(sh.mul(sh).mul(2)).negate()).mul(glowWindow(u2)).mul(ah),
  };
}

/**
 * A SPRITE's radial profile at r² (r = 0 centre, 1 the quad's edge) for a quad drawn `spread` times larger than
 * before, whose old core was e^(−kc·r_old²) at peak `coreGain` and old halo e^(−kh·r_old²) at `haloGain`
 * (r_old = r · spread). Returns { core, halo } separately (a bead colours them differently).
 */
export function spriteGlow(r2: F, spread: F, G: GlowProfile, old: { kCore: number; coreGain: number; kHalo: number; haloGain: number }): { core: F; halo: F } {
  const rOld2 = r2.mul(spread.mul(spread));
  const wc = G.core.mul(0.9);
  const wh = G.halo.mul(1.25);
  // a width w scales the exponent by 1/w² and (energy kept, 2D) the peak by 1/w²
  const core = exp(rOld2.mul(old.kCore).div(wc.mul(wc)).negate()).mul(old.coreGain).div(wc.mul(wc));
  const halo = exp(rOld2.mul(old.kHalo).div(wh.mul(wh)).negate()).mul(glowWindow(r2)).mul(old.haloGain * 0.9).mul(G.haloGain).div(wh.mul(wh));
  return { core, halo };
}

/**
 * A ribbon's ACROSS vector at a vertex (tangent `t`, the eye's direction `view`, unit): tangent × view, scaled down to
 * nothing where the path points at the eye (the 2026-10-30 close look at the particles: zigzags where a trail runs
 * end-on). Normalised, tangent × view flips sign between neighbouring vertices of a run that is nearly end-on and
 * the ribbon folds into a row of bowties; scaled by smoothstep(0.04, 0.3, |t × view|) it narrows to nothing there,
 * where the path is a dot on the screen anyway.
 */
export function ribbonAcross(t: V3, view: V3): V3 {
  const c = t.cross(view);
  const l = c.length();
  return c.div(l.max(1e-5)).mul(smoothstep(0.04, 0.3, l));
}

/**
 * m: the radius of curvature of the path AS SEEN from the eye at a vertex `at`, from its neighbours `a` and `b` (the
 * circumradius of the three directions, an angle, times the distance). A ribbon wider than this folds over itself on
 * the screen: a loop seen obliquely is an ellipse whose ends bend far tighter than the loop does, and the folded
 * quads added up into fans of fine radial lines there (the same close look). Huge where the path is straight.
 */
export function screenBend(a: V3, at: V3, b: V3): F {
  const va = normalize(a.sub(cameraPosition));
  const v0 = normalize(at.sub(cameraPosition));
  const vb = normalize(b.sub(cameraPosition));
  const ea = va.sub(v0);
  const eb = vb.sub(v0);
  const area2 = ea.cross(eb).length();
  const r = ea.length().mul(eb.length()).mul(va.sub(vb).length()).div(area2.mul(2).max(1e-9));
  return r.mul(at.sub(cameraPosition).length());
}
