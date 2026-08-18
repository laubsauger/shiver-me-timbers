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

/**
 * ONE storm cell, resolved. `stormAt` needs this to answer "how strong is the
 * weather here"; the CLOUD layer needs the same thing to answer "where do I
 * put the cloud" (§V.63) — a squall you can sail into has to have its cloud
 * mass ON its cell, not on an unrelated ring. Both therefore walk `cellAt`.
 *
 * Positions are in whichever frame the producer says: `cellAt` reports the
 * FIELD frame (drift already subtracted from the query), `stormCellsNear`
 * adds the drift back and reports WORLD.
 */
export interface StormCell {
  /** lattice coordinates — the cell's stable IDENTITY across drift and time.
   *  Anything that must not reshuffle as a cell breathes keys off these. */
  i: number;
  j: number;
  x: number;
  z: number;
  radius: number;
  /**
   * The field value at this cell's OWN centre, overlap aside: lifecycle
   * amplitude × intensity. A ship parked on the centre of an isolated cell
   * reads exactly this from `stormAt`, which is what makes "cloud where the
   * rain is" checkable rather than a matter of taste (see tests/clouds).
   */
  amp: number;
}

export function makeStormCell(): StormCell {
  return { i: 0, j: 0, x: 0, z: 0, radius: 0, amp: 0 };
}

/**
 * Geometry and strength of the cell hosted by lattice square (i, j), written
 * into a caller-owned `out`. Returns false when the square hosts no cell.
 *
 * THE SINGLE DEFINITION of where a cell is and how strong it is. `stormAt`
 * walks it over its 3×3 neighbourhood and `stormCellsNear` over a wider one;
 * duplicating the salts here is exactly how the cloud layer would end up
 * drawing its anvil half a kilometre off the rain.
 *
 * `cfg` must already be sanitized (both callers do it once, before looping).
 */
export function cellAt(
  cfg: StormFieldConfig,
  i: number,
  j: number,
  time: number,
  out: StormCell,
): boolean {
  if (hashCell(cfg.seed, i, j, 0) >= cfg.coverage) return false;
  const size = cfg.cellSize;
  const radiusMax = size * 0.5;

  // centre jittered inside its own square (bounded by `jitter`)
  const jx = (hashCell(cfg.seed, i, j, 1) - 0.5) * cfg.jitter;
  const jz = (hashCell(cfg.seed, i, j, 2) - 0.5) * cfg.jitter;

  // radius spread around the mean, re-clamped: variance must not be able to
  // push a cell past the containment bound the 3×3 walk assumes
  const spread = (hashCell(cfg.seed, i, j, 3) - 0.5) * cfg.radiusVariance;
  const radius = Math.min(cfg.cellRadius * (1 + spread), radiusMax);
  if (radius <= 0) return false;

  // per-cell lifecycle phase — hashed, never shared, or every storm in the
  // world would breathe in unison (§B4)
  let amp = 1;
  if (cfg.lifecycleSeconds > 0 && cfg.lifecycleDepth > 0) {
    const phase = hashCell(cfg.seed, i, j, 4);
    const s =
      Math.sin(2 * Math.PI * (fin(time, 0) / cfg.lifecycleSeconds + phase)) * 0.5 + 0.5;
    amp = 1 - cfg.lifecycleDepth + cfg.lifecycleDepth * s;
  }

  out.i = i;
  out.j = j;
  out.x = (i + 0.5 + jx) * size;
  out.z = (j + 0.5 + jz) * size;
  out.radius = radius;
  out.amp = clamp01(amp);
  return true;
}

/**
 * Scratch for `stormAt`'s inner loop. Module-level so the hot path allocates
 * nothing; safe because `cellAt` fully overwrites it and `stormAt` reads it
 * before the next call. NOT re-entrant — nothing may call `stormAt` from
 * inside `stormAt`, which nothing does (samplers are called by consumers, not
 * by the field).
 */
const scratchCell = makeStormCell();

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
      // does this lattice square host a cell at all? — cellAt is the one
      // place that answers, so the cloud layer cannot disagree with the rain
      if (!cellAt(cfg, ci + di, cj + dj, t, scratchCell)) continue;

      const dx = px - scratchCell.x;
      const dz = pz - scratchCell.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist >= scratchCell.radius) continue; // outside the rim: exactly zero

      // 1 in the core, smoothly to 0 at the rim (§V23 functional form)
      const inner = scratchCell.radius * (1 - cfg.edgeSoftness);
      const w = 1 - smoothstep(inner, scratchCell.radius, dist);

      miss *= 1 - clamp01(w * scratchCell.amp);
      if (miss <= 0) return cfg.intensity; // fully inside overlapping cores
    }
  }
  return (1 - miss) * cfg.intensity;
}

/**
 * Every storm cell whose lattice square lies within `radiusCells` of (x, z),
 * in WORLD coordinates, nearest first. Fills and returns a caller-owned pool
 * (§V.46's sampler discipline: this runs per frame, a fresh array each call
 * would be pure GC churn).
 *
 * WHY THE CLOUD LAYER NEEDS THIS AND NOT `stormAt`. `stormAt` answers "how
 * stormy is it HERE" — a scalar, enough to drive rain density or a sea state.
 * A cloud is an OBJECT: to stand over a squall it needs the squall's CENTRE
 * and EXTENT, which a point sample cannot report. Sampling `stormAt` on a ring
 * of guessed sites and hoping one lands on a cell is what the layer used to do,
 * and it measured out at r = 0.00 between rain and cloud along a sail track.
 *
 * `radiusCells` is a lattice radius: 2 walks 5×5 squares, i.e. ±2.5·cellSize.
 * Nearest-first ordering is what makes "the closest N" a stable, deterministic
 * choice for the shaft slots.
 */
export function stormCellsNear(
  x: number,
  z: number,
  drift: StormFieldDrift,
  time: number,
  rawConfig: StormFieldConfig,
  radiusCells: number,
  pool: StormCell[],
): StormCell[] {
  const cfg = sanitizeFieldConfig(rawConfig);
  let n = 0;
  const write = (): StormCell => {
    let cell = pool[n];
    if (!cell) cell = pool[n] = makeStormCell();
    n++;
    return cell;
  };

  if (cfg.intensity > 0 && cfg.coverage > 0 && cfg.cellRadius > 0) {
    const size = cfg.cellSize;
    const dx = fin(drift.x, 0);
    const dz = fin(drift.z, 0);
    const px = fin(x, 0) - dx;
    const pz = fin(z, 0) - dz;
    const ci = Math.floor(px / size);
    const cj = Math.floor(pz / size);
    const t = fin(time, 0);
    // §V28: an unsanitized radius would size the walk, so it is floored to a
    // small int rather than trusted — a NaN here is an infinite loop
    const r = Math.min(Math.max(Math.floor(fin(radiusCells, 1)) || 0, 0), 8);

    for (let di = -r; di <= r; di++) {
      for (let dj = -r; dj <= r; dj++) {
        const out = write();
        if (!cellAt(cfg, ci + di, cj + dj, t, out)) {
          n--; // square hosts nothing — hand the slot back
          continue;
        }
        // FIELD frame → WORLD. The cloud that stands on this cell is placed in
        // world space and must drift with it, not with the camera.
        out.x += dx;
        out.z += dz;
        out.amp *= cfg.intensity;
      }
    }
  }

  pool.length = n;
  // nearest first — deterministic given (seed, drift, time), so the shaft
  // slots do not swap between frames for no reason
  pool.sort(
    (a, b) =>
      (a.x - x) * (a.x - x) +
      (a.z - z) * (a.z - z) -
      ((b.x - x) * (b.x - x) + (b.z - z) * (b.z - z)),
  );
  return pool;
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
