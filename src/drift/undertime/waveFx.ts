/**
 * THE LIGHT WAVE'S OPTICS — what the front does to everything it passes, as TSL every layer of the field shares
 * (loops.ts trails and sprites, products.ts, mist.ts, dust.ts, burst.ts; the sky draws the front itself).
 *
 * The 2026-10-30 review asked for "a total collapse of space and time" where the wave had been a bright band with
 * pairs dying on it. Two things make it a collapse rather than a band, both pure functions of act time and of the
 * world position of a vertex (so the six cube faces agree and any frame renders on its own):
 *
 *   SPACE   waveWarp. The front pulls the field toward its own line: a point at angle x ahead of it (or behind it) is
 *           turned toward it by lens·x·e^(−|x|/width) — nothing at the line itself, most a width away, nothing far
 *           off. Ahead of the front the sky's contents crowd onto it (the field folding into the oncoming light);
 *           once it has passed they are dragged after it and spring back — a ripple of space crossing the dome.
 *           The displacement is a rotation about the eye, so distances (and parallax) are kept; at most
 *           `waveLens` (6°) at the defaults.
 *   TIME    frontTime / afterglow. When the front reaches a point of a trail, that point's clock STOPS: the trail
 *           keeps the brightness and shape it had at that instant (a long exposure of the field's last moment)
 *           instead of fading on its own schedule, flashes as the front's light goes through it, then cools — white,
 *           gold, amber, ember red, out — over `afterglow` s (e-fold, 0.35): the field's final instant burning out
 *           just behind the line, and then the dome there is SPENT (`spent`).
 *
 * The front's position for a direction is front.ts's (the CPU kills pairs on the same edge).
 */
import * as THREE from 'three/webgpu';
import { PI, acos, exp, float, int, ivec2, mix, mx_noise_vec3, normalize, sin, smoothstep, textureLoad, vec3 } from 'three/tsl';
import { RAG, RAG_AMP, RAG_DIRS, RAG_K, RAG_PHASE } from './front';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

export interface WaveFxUniforms {
  /** act s now */
  time: F;
  /** world point the front is measured from (the eye; it stands still through the wave) */
  eye: V3;
  /** unit, the dome front */
  front: V3;
  /** 0..1 the front's progress now (timeline.ts state.wave) */
  sweep: F;
  /** rad, the most it displaces anything right now (state.lens); 0 turns the warp off */
  lens: F;
  /** rad, the pinch's e-fold either side of the line */
  width: F;
  /** act s the wave starts, and its length */
  start: F;
  length: F;
  /** s, e-fold of the afterglow */
  afterglow: F;
  /** the sweep's inverse (timeline.ts sweepInverseTable): wave progress k for frac i/(n − 1), one texel each, R */
  sweepInverse: THREE.DataTexture;
}

/** texels in the sweep's inverse table */
export const SWEEP_LUT = 512;

/** front.ts frontRagCpu on the GPU */
export function frontRag(d: V3): F {
  let s: F = float(0);
  for (let i = 0; i < 3; i++) {
    const a = RAG_DIRS[i];
    s = s.add(sin(d.dot(vec3(a[0], a[1], a[2])).mul(RAG_K[i]).add(RAG_PHASE[i])).mul(RAG_AMP[i]));
  }
  return s.mul(RAG / 1.85);
}

/** 0..1 the front's progress when it reaches unit direction d (front.ts frontFracCpu) */
export function frontFrac(d: V3, U: Pick<WaveFxUniforms, 'front'>): F {
  return acos(d.dot(U.front).clamp(-1, 1)).div(PI).add(frontRag(d)).clamp(0, 1);
}

/** act s the front reaches world point `pos`: the inverse of the sweep (timeline.ts waveTimeAt), read from its table
 * and interpolated by hand (two loads: a float texture is not filterable everywhere WebGPU runs) */
export function frontTime(pos: V3, U: WaveFxUniforms): F {
  const f = frontFrac(normalize(pos.sub(U.eye)), U);
  const x = f.mul(SWEEP_LUT - 1);
  const i0 = x.floor().min(SWEEP_LUT - 2);
  const a = textureLoad(U.sweepInverse, ivec2(int(i0), int(0))).r;
  const b = textureLoad(U.sweepInverse, ivec2(int(i0.add(1)), int(0))).r;
  return U.start.add(mix(a, b, x.sub(i0).clamp(0, 1)).mul(U.length));
}

/**
 * SPENT: 0..1 what the front leaves of a light it has passed — all of it for `grace` s (the front's own events play
 * out on its line), then gone with an e-fold of 0.2 s (the 2026-10-30 story note: "while the wave is going, suddenly
 * stuff flares up again at the bottom" — once the front has passed, that part of the dome stays spent; only the
 * survivors, survivors.ts, are left there).
 */
export function spent(tFront: F, U: Pick<WaveFxUniforms, 'time'>, grace = 0.3): F {
  // (e-fold 0.2 s: at 0.3 the thousand flashes just behind the line still glittered a band ~1.5 s deep — 50° of dome
  // once the front speeds away after its stall. 0.12 s, and the callers' graces halved, on 2026-11-01: the brief's
  // "real darkness and quiet left behind" — at 0.2 a field of white flashes still filled the 30° behind the line at
  // 41 s; the front's own events now die ON the line, field.ts frontEvents, so there is nothing to play out)
  // …and then OUT: an e-fold alone never reaches black, and these are HDR lights (a flash at 14, a bead at a few) —
  // 3 % of a flash a second behind the line still bloomed into a white dot (the layer-by-layer check at 41 s,
  // 2026-11-01: every trail, sprite and head was still there 0.5–1 s behind the line). Zero by grace + 0.35 s.
  const since = U.time.sub(tFront).sub(grace);
  return exp(since.max(0).div(0.1).negate()).mul(smoothstep(0.35, 0.15, since));
}

/**
 * The world position `pos` as the front's pull displaces it (see SPACE above). Off (exactly `pos`) when lens is 0.
 *
 * THE SNOWPLOW (the 2026-11-01 brief: "particles ahead of the front get pushed and compressed and ignite; the leading
 * edge is the brightest"). Until then the pull was x → x − a·x·e^(−|x|/w): both sides folded symmetrically onto the
 * line itself, and the front read as a lens passing over the field. Now every point within a width of the line is
 * drawn toward a layer `PILE` just AHEAD of it: x → x + s·(PILE − x)·e^(−|x|/w). Ahead, the field crowds toward the
 * oncoming front (compressed: the map's slope at the line is s·PILE/w, ~1/12 at the defaults); what the line has
 * reached is not left behind at once but CARRIED, piled into that thin layer riding just in front of the light, and
 * released a width later. Those carried points are the ones the front has just passed — the ones its heat lights
 * white (dust.ts sheet, afterglow below) — so the leading edge is made of the field's own matter, swept up and
 * burning. Behind them, nothing: they are released into the spent dome (`spent`), dark within 0.2 s.
 * `s` is lens/(width/e), so `waveLens` keeps its meaning (the largest displacement, a width from the line); the old
 * symmetric fold is this with PILE = 0.
 *
 * THE SHIMMER (the same brief: "a subtle heat-shimmer refraction warp at the front"): within ~3° of the line every
 * direction is jittered by a small, fast-moving noise — ~0.12° at most, churning at ~5 Hz — as the air over a hot road
 * bends what is behind it. Pure in act time (the noise's phase is `time`), so any frame renders on its own. The sky
 * bends its own light by the same jitter (`shimmer`), so the front's line ripples with what it passes.
 */
/** rad, how far ahead of the line the swept-up layer rides */
const PILE = 0.014;
/** rad, the shimmer's half-width either side of the line, and its largest jitter */
const SHIMMER_W = 0.05;
const SHIMMER_A = 0.0021;

/** the heat shimmer's angular jitter (a vector square to `d`, rad) for unit direction d, `x` rad from the line */
export function shimmer(d: V3, x: F, U: Pick<WaveFxUniforms, 'time' | 'sweep'>): V3 {
  const xs = x.div(SHIMMER_W);
  const on = exp(xs.mul(xs).negate()).mul(smoothstep(0.01, 0.04, U.sweep)).mul(smoothstep(1, 0.9, U.sweep));
  const n = mx_noise_vec3(d.mul(38).add(vec3(U.time.mul(4.7), U.time.mul(-3.9), U.time.mul(5.3))));
  const t = n.sub(d.mul(n.dot(d)));
  return t.mul(on.mul(SHIMMER_A));
}

export function waveWarp(pos: V3, U: WaveFxUniforms): V3 {
  const v = pos.sub(U.eye);
  const r = v.length().max(1e-4);
  const d = v.div(r);
  // rad ahead of the front (> 0) or behind it (< 0)
  const x = frontFrac(d, U).sub(U.sweep).mul(PI);
  const w = U.width.max(1e-3);
  // the strength that makes `lens` the largest displacement of the old fold (x·e^(−|x|/w) peaks at w/e)
  const s = U.lens.mul(Math.E).div(w).min(1.2);
  // positive turns away from the front's origin (onward, the way it travels)
  const turn = s.mul(float(PILE).sub(x)).mul(exp(x.abs().div(w).negate()));
  // rotate d about front × d by `turn`; k × d = d·cosθ − front
  const away = d.mul(d.dot(U.front)).sub(U.front);
  const awayN = away.div(away.length().max(1e-4));
  const d2 = d.mul(turn.cos()).add(awayN.mul(turn.sin()));
  return U.eye.add(normalize(d2.add(shimmer(d2, x, U))).mul(r));
}

/**
 * What the front leaves of a light it froze, `since` s after it passed (≤ 0: not yet, gain 1 and no heat):
 * `gain` multiplies the light (a flare as the front's heat goes through, then the e-fold), `heat` 1 → 0 drives
 * the colour (afterglowColour).
 */
export function afterglow(since: F, U: Pick<WaveFxUniforms, 'afterglow'>): { gain: F; heat: F; on: F } {
  const s = since.max(0);
  // IGNITION AHEAD (the 2026-11-01 brief: "particles ahead of the front … ignite"): in the last ~0.15 s before the
  // front reaches it a light heats — brighter, whiter — so the line is preceded by a rim of the field catching fire
  // rather than met cold. (it hands over to the flash on the line over its first 0.03 s: no step)
  const pre = exp(since.min(0).div(0.12));
  const lit = smoothstep(0, 0.03, since);
  const on = lit.max(pre);
  // (a flash ON the line as the front's light goes through, then only down: the first rounds flared to 3× and burned
  // for seconds behind the line, which read as the spent dome lighting up again)
  const after = float(1).add(exp(s.div(0.08).negate()).mul(0.6)).mul(exp(s.div(U.afterglow).negate()));
  const gain = mix(pre.mul(0.9).add(1), after, lit);
  const heat = mix(pre.mul(0.85), exp(s.div(U.afterglow.mul(0.55)).negate()), lit);
  return { gain, heat, on };
}

/** a light cooling as it burns out: `heat` 1 white-hot → gold → amber → ember red at 0, from colour `c` */
export function afterglowColour(c: V3, heat: F, on: F): V3 {
  const white = vec3(1, 0.96, 0.9);
  const gold = vec3(1, 0.74, 0.36);
  const ember = vec3(0.9, 0.22, 0.06);
  const ramp = mix(mix(ember, gold, smoothstep(0.08, 0.45, heat)), white, smoothstep(0.55, 0.95, heat));
  // the light keeps its brightness and a little of its own hue as it heats (a violet trail goes white-violet, then
  // amber): the ramp takes over the colour, not the energy
  const lum = c.dot(vec3(0.3, 0.5, 0.2));
  const hue = c.div(lum.max(1e-4)).min(3);
  const cooled = ramp.mul(mix(vec3(1), hue, float(0.2))).mul(lum);
  return mix(c, cooled, on);
}
