/**
 * Localised storm field (§T.38, §V46) — PURE MATH, no three, no state.
 *
 * Weather is not one scalar applied to the whole world. Storm cells occupy
 * world regions with soft edges: you sail INTO and OUT OF a squall, and can
 * see clear sun on the horizon while rain falls overhead.
 *
 * MODEL: an infinite lattice of `cellSize` squares. Each square deterministically
 * either hosts one storm cell or does not (`hashCell(seed,i,j,·)` — pure integer
 * mixing, never the sequential Rng, so any cell can be evaluated without
 * evaluating its neighbours). Cell centre, radius and lifecycle phase are hashed
 * the same way. A lattice is used rather than a stored list because the ship
 * sails UNBOUNDED (§V30/§B10): any finite list of cells eventually runs out and
 * the world edge shows.
 *
 * DRIFT: cells travel downwind. Rather than moving every cell, the query point
 * is moved into the field's own frame (`p - drift`) — an exact rigid translation
 * with nothing to accumulate per cell. `drift` is INTEGRATED per sim tick
 * (weatherField.advance) instead of computed as wind·t, because wind direction
 * changes and `wind(t)·t` would teleport the whole weather map when it does.
 *
 * CONTINUITY IS A CONSTRUCTION, NOT A TUNING (the reason for the clamps below):
 * the sampler only visits the 3×3 lattice neighbourhood of the query point, so
 * every cell's influence MUST vanish before it could be reached from outside
 * that neighbourhood. A cell's reach from its own square centre is
 * `jitter·size/2 + radius`; clamping `jitter ≤ 1` and `radius ≤ size/2` bounds
 * that by `size`, while the nearest excluded square sits `1.5·size` away. Break
 * either clamp and cells pop on and off as you cross a lattice edge.
 *
 * BOUNDEDNESS AT SOURCE (§V44 discipline): contributions combine as a soft
 * union `1 − Π(1 − wᵢ)` with every `wᵢ ∈ [0,1]`, so the result is in [0,1] by
 * construction — no post-hoc clamp carrying the invariant, and overlapping
 * cells saturate smoothly instead of summing past 1.
 */

/** functional smoothstep (§V23: never the chained 3-arg forms) */
export function smoothstep(e0: number, e1: number, x: number): number {
  // divisor floor (§V28 discipline, CPU side): e1 === e0 is a legal param
  // combination (edgeSoftness = 0 with radius 0) and 0/0 would poison the
  // whole field with NaN for the rest of the session
  const t = clamp01((x - e0) / Math.max(e1 - e0, 1e-6));
  return t * t * (3 - 2 * t);
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Deterministic 0..1 hash of (seed, lattice i, lattice j, salt) (§V2).
 * Integer mixing only — the same inputs give the same number on every machine
 * and in any order, which is what lets a cell be evaluated in isolation.
 */
export function hashCell(
  seed: number,
  i: number,
  j: number,
  salt: number,
): number {
  // SEQUENTIAL mixing, not an XOR of three independent products: combining
  // imul(i,C1) ^ imul(j,C2) by xor leaves whole families of (i,j) pairs
  // mapping onto the same word (measured: 1409 distinct values over a 41×41
  // lattice instead of ~1681), which shows up as storm cells repeating on a
  // diagonal. Each term must go through the avalanche before the next enters.
  let h = seed | 0;
  h = Math.imul(h ^ (i | 0), 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h ^ (j | 0), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h ^ (salt | 0), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** field shape — a sanitized snapshot of the weather params (§V16) */
export interface StormFieldConfig {
  seed: number;
  cellSize: number;
  cellRadius: number;
  radiusVariance: number;
  jitter: number;
  edgeSoftness: number;
  coverage: number;
  /** master 0..1 — 0 disables the field (globally uniform weather) */
  intensity: number;
  lifecycleSeconds: number;
  lifecycleDepth: number;
}

/** where the field pattern currently sits — plain data, JSON-safe (§V2) */
export interface StormFieldDrift {
  x: number;
  z: number;
}

const fin = (v: number, fallback: number): number =>
  Number.isFinite(v) ? v : fallback;

/**
 * Clamp a raw config into the range the continuity proof above assumes.
 * Called on every sample: these are LIVE panel values (§V16) and a slider
 * drag must never be able to tear the field.
 */
export function sanitizeFieldConfig(cfg: StormFieldConfig): StormFieldConfig {
  const cellSize = Math.max(fin(cfg.cellSize, 2600), 1); // divisor (§V28)
  const radiusMax = cellSize * 0.5; // continuity clamp — see file header
  return {
    seed: cfg.seed | 0,
    cellSize,
    cellRadius: Math.min(Math.max(fin(cfg.cellRadius, 0), 0), radiusMax),
    radiusVariance: clamp01(fin(cfg.radiusVariance, 0)),
    jitter: clamp01(fin(cfg.jitter, 0)),
    edgeSoftness: clamp01(fin(cfg.edgeSoftness, 0)),
    coverage: clamp01(fin(cfg.coverage, 0)),
    intensity: clamp01(fin(cfg.intensity, 0)),
    lifecycleSeconds: Math.max(fin(cfg.lifecycleSeconds, 0), 0),
    lifecycleDepth: clamp01(fin(cfg.lifecycleDepth, 0)),
  };
}

/**
 * Storm strength at world (x, z), in [0,1]. Pure: same
 * (seed, drift, time, config) always gives the same number (§V2).
 *
 * `time` only drives the per-cell lifecycle; `drift` carries all the motion.
 */
export function stormAt(
  x: number,
  z: number,
  drift: StormFieldDrift,
  time: number,
  rawConfig: StormFieldConfig,
): number {
  const cfg = sanitizeFieldConfig(rawConfig);
  if (cfg.intensity <= 0 || cfg.coverage <= 0 || cfg.cellRadius <= 0) return 0;

  const size = cfg.cellSize;
  const radiusMax = size * 0.5;
  // into the field's own (drifting) frame
  const px = fin(x, 0) - fin(drift.x, 0);
  const pz = fin(z, 0) - fin(drift.z, 0);
  const ci = Math.floor(px / size);
  const cj = Math.floor(pz / size);
  const t = fin(time, 0);

  // soft union: accumulate the probability of being MISSED by every cell
  let miss = 1;
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const i = ci + di;
      const j = cj + dj;
      // does this lattice square host a cell at all?
      if (hashCell(cfg.seed, i, j, 0) >= cfg.coverage) continue;

      // centre jittered inside its own square (bounded by `jitter`)
      const jx = (hashCell(cfg.seed, i, j, 1) - 0.5) * cfg.jitter;
      const jz = (hashCell(cfg.seed, i, j, 2) - 0.5) * cfg.jitter;
      const cx = (i + 0.5 + jx) * size;
      const cz = (j + 0.5 + jz) * size;

      // radius spread around the mean, re-clamped: variance must not be able
      // to push a cell past the containment bound the 3×3 walk assumes
      const spread = (hashCell(cfg.seed, i, j, 3) - 0.5) * cfg.radiusVariance;
      const radius = Math.min(cfg.cellRadius * (1 + spread), radiusMax);
      if (radius <= 0) continue;

      const dx = px - cx;
      const dz = pz - cz;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist >= radius) continue; // outside the rim: exactly zero, no epsilon

      // 1 in the core, smoothly to 0 at the rim (§V23 functional form)
      const inner = radius * (1 - cfg.edgeSoftness);
      const w = 1 - smoothstep(inner, radius, dist);

      // per-cell lifecycle phase — hashed, never shared, or every storm in
      // the world would breathe in unison (§B4)
      let amp = 1;
      if (cfg.lifecycleSeconds > 0 && cfg.lifecycleDepth > 0) {
        const phase = hashCell(cfg.seed, i, j, 4);
        const s =
          Math.sin(2 * Math.PI * (t / cfg.lifecycleSeconds + phase)) * 0.5 + 0.5;
        amp = 1 - cfg.lifecycleDepth + cfg.lifecycleDepth * s;
      }

      miss *= 1 - clamp01(w * amp);
      if (miss <= 0) return cfg.intensity; // fully inside overlapping cores
    }
  }
  return (1 - miss) * cfg.intensity;
}

/**
 * Advance the field's drift by one sim tick (§V2 fixed dt). Cells travel
 * DOWNWIND at `driftFraction` of the wind speed. Wind vector convention
 * matches the sea and the sails exactly: (cos θ, sin θ) → (x, z).
 */
export function advanceDrift(
  drift: StormFieldDrift,
  windDirection: number,
  windSpeed: number,
  driftFraction: number,
  dt: number,
): void {
  const dir = fin(windDirection, 0);
  const speed = Math.max(fin(windSpeed, 0), 0);
  const frac = Math.max(fin(driftFraction, 0), 0);
  const step = speed * frac * Math.max(fin(dt, 0), 0);
  drift.x += Math.cos(dir) * step;
  drift.z += Math.sin(dir) * step;
}
