/**
 * A blue-noise tile for the sky's marches (clouds.ts, cloudAir.ts): the per-pixel offset each ray starts its
 * samples at. Interleaved gradient noise, the screen-coordinate hash the marches had used, is a regular lattice: in
 * one frame (no motion blur, a review still or a preview) its errors drew a fine diagonal checker through every
 * cloud, the user at the v11 review. Blue noise spreads the same error as grain with no pattern in it, and still
 * evens out over the motion blur's sub-frames as each adds its own offset (a golden-ratio sequence on the clock).
 *
 * Void-and-cluster (Ulichney 1993) on a TILE² torus, computed once at load (a few tens of ms) — deterministic, so
 * every frame of every lane draws the same tile. Channels are the tile read at toroidal shifts, independent enough
 * for the two marches of one ray.
 */
import * as THREE from 'three/webgpu';
import { fract, screenCoordinate, texture, vec2 } from 'three/tsl';

type F = THREE.Node<'float'>;

const TILE = 64;
/** px: the energy's Gaussian (Ulichney's 1.5) */
const SIGMA = 1.5;

function voidAndCluster(n: number): Uint8Array {
  const size = n * n;
  // the Gaussian over toroidal offsets
  const kernel = new Float32Array(size);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = Math.min(x, n - x);
      const dy = Math.min(y, n - y);
      kernel[y * n + x] = Math.exp(-(dx * dx + dy * dy) / (2 * SIGMA * SIGMA));
    }
  }
  const energy = new Float32Array(size);
  const on = new Uint8Array(size);
  const toggle = (i: number, s: number): void => {
    on[i] = s > 0 ? 1 : 0;
    const ix = i % n;
    const iy = (i / n) | 0;
    for (let y = 0; y < n; y++) {
      const ky = ((y - iy + n) % n) * n;
      for (let x = 0; x < n; x++) energy[y * n + x] += s * kernel[ky + ((x - ix + n) % n)];
    }
  };
  const extreme = (want: number, most: boolean): number => {
    let best = -1;
    let e = most ? -Infinity : Infinity;
    for (let i = 0; i < size; i++) {
      if (on[i] !== want) continue;
      if (most ? energy[i] > e : energy[i] < e) {
        e = energy[i];
        best = i;
      }
    }
    return best;
  };
  // a seeded start (a fixed LCG: the same tile every load), ~10% on, relaxed until the tightest cluster is the
  // largest void
  let seed = 22695477;
  const rand = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const ones = Math.round(size * 0.1);
  for (let k = 0; k < ones; ) {
    const i = Math.floor(rand() * size);
    if (!on[i]) {
      toggle(i, 1);
      k++;
    }
  }
  for (let guard = 0; guard < size * 4; guard++) {
    const t = extreme(1, true);
    toggle(t, -1);
    const v = extreme(0, false);
    if (v === t) {
      toggle(t, 1);
      break;
    }
    toggle(v, 1);
  }
  const rank = new Float32Array(size);
  const start = on.slice();
  const startEnergy = energy.slice();
  // ranks below the start: take the tightest cluster away, one by one
  for (let r = ones - 1; r >= 0; r--) {
    const t = extreme(1, true);
    toggle(t, -1);
    rank[t] = r;
  }
  on.set(start);
  energy.set(startEnergy);
  // and above it: fill the largest void, one by one
  for (let r = ones; r < size; r++) {
    const v = extreme(0, false);
    toggle(v, 1);
    rank[v] = r;
  }
  // (8 bits: an unsigned-normalised texture filters and samples everywhere; 256 levels are fine for an offset)
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = Math.floor((rank[i] * 256) / size);
  return out;
}

let tile: THREE.DataTexture | null = null;

/** blue noise in [0, 1) at this pixel; `channel` reads the tile at another toroidal shift */
export function blueNoise(channel = 0): F {
  if (!tile) {
    tile = new THREE.DataTexture(voidAndCluster(TILE), TILE, TILE, THREE.RedFormat, THREE.UnsignedByteType);
    tile.wrapS = tile.wrapT = THREE.RepeatWrapping;
    tile.minFilter = tile.magFilter = THREE.NearestFilter;
    tile.generateMipmaps = false;
    tile.needsUpdate = true;
  }
  const shift = [0, 0.5, 0.25, 0.75][channel % 4];
  // (the level's centre: 0..255 → [0, 1) evenly)
  return texture(tile, fract(screenCoordinate.xy.div(TILE).add(vec2(shift, shift * 1.5)))).r.mul(255 / 256).add(0.5 / 256) as unknown as F;
}
