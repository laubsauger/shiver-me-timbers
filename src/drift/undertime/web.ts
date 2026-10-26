/**
 * The seeded generator every Undertime and Get the Drift build uses, so the same sky comes out in every
 * frame, render and lane. (The cosmic web itself is a volume now: webVolume.ts.)
 */

/** mulberry32: small, fast, seedable */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
