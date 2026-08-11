/**
 * Deterministic variation (§V2: seeded — the same ship every run, and the
 * same ship on every client for multiplayer later).
 *
 * WHY this module exists: procedural geometry defaults to perfect repetition,
 * and perfect repetition is the single loudest "this is CG" tell. The user's
 * standing note is "everything is too perfectly shaped and too perfectly
 * aligned ... not so ultra regular everywhere". So every detail generator here
 * jitters its stations, lengths and spacings — but from a HASH of its own
 * indices, never from Math.random(), because a blueprint must stay a pure
 * function of its params (tests/ship.test.ts asserts deep-equality across two
 * builds, and §V18's mesh-swap contract is plain data).
 */

/**
 * Integer bit-mix (xorshift/multiply, the finalizer half of murmur3). Pure,
 * branch-free, and stable across engines because every step is masked back
 * into 32 bits with `>>> 0` — plain float arithmetic on large products would
 * lose the low bits that carry the entropy.
 */
function mix32(x: number): number {
  let h = x >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * 0..1 hash of any list of numbers. Non-integer keys are quantised to 1e-3
 * first so a station derived from float maths (a z in metres, say) hashes
 * consistently rather than flickering on the last mantissa bit.
 */
export function vhash(...keys: number[]): number {
  let h = 0x9e3779b9;
  for (const k of keys) {
    h = mix32(h ^ mix32(Math.round(k * 1000) | 0));
  }
  return mix32(h) / 4294967296;
}

/** hash mapped into [lo, hi) */
export function vrange(lo: number, hi: number, ...keys: number[]): number {
  return lo + (hi - lo) * vhash(...keys);
}

/** hash mapped into [-amount, +amount] — the usual "jitter this station" form */
export function vjitter(amount: number, ...keys: number[]): number {
  return (vhash(...keys) * 2 - 1) * amount;
}

/**
 * Port/starboard asymmetry factor. Real ships are not mirror-symmetric — the
 * two sides were planked and fitted by different hands — so anything built
 * per side takes a slightly different value. Kept small (a few percent) so it
 * reads as craftsmanship, not as a modelling error.
 */
export function vside(sign: number, spread: number, ...keys: number[]): number {
  return 1 + vjitter(spread, sign * 7.31, ...keys);
}
