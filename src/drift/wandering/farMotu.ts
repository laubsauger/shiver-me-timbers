/**
 * A FAR MOTU — a low treed island seen at kilometres, for the Rose's stations on the open sea's horizon (props.ts).
 *
 * WHY. The stations' islands were flattened domes, 33–77 m high and smooth, an unlit horizon colour × 0.55 by night
 * and, once the radio towers stood on them, lit pale by the low Sun by day: the user, 2026-10-30, on a c2–c3 frame —
 * "What exactly is this weird white thing in the back? Is this supposed to be a super ugly island with the tower on
 * it? … That doesn't make sense." From sea level a motu is a wide, low band: a few metres of land, a canopy of 15–25 m,
 * its top ragged with crowns and palm heads standing out of it, a thin pale beach at the waterline (the coast's far
 * motus, coast.ts; references §12.5–6: "from sea level, islands are low slivers"; "island greens are dark and olive,
 * and turn blue with distance").
 *
 * WHAT IT IS. A heightfield over the island's own frame (`along` its length, `across` it), seeded: an outline that
 * wanders (and on some, a channel splitting it in two), a spine that bends, a sand rim rising to the land's 2.5 m, the
 * canopy rising over the next ~25 m inland to its height, crowns as low-frequency bumps (fbm at ~14 m), and emergent
 * palms as narrow spikes along the island — along it only, since from 7 km the silhouette is the highest point across
 * each line of sight. At 7 km a 20 m canopy is ~4 px of a 4K master and the island ~100 px wide: its outline and its
 * ragged top are what read. Lit by the scene's own Sun and sky (dark leaf albedos, as forest.ts's), seen through the
 * high island's air (farAir.ts: what 7 km of marine air scatters in front of it): a grey-green silhouette a little
 * darker and bluer than the sky behind it, never self-lit.
 *
 * Pure: the same seed, the same island (and its tower's site, `site`).
 */
import * as THREE from 'three/webgpu';
import { mix, positionWorld, smoothstep, vec3 } from 'three/tsl';
import { fbm2Cpu, hash2Cpu } from '../../terrain/noiseCpu';
import type { MastAir } from '../../radio/mast';

type F = THREE.Node<'float'>;

/** m: the land's height over the sea behind the beach, and the beach's own rise (its pale rim) */
const LAND = 2.5;
const BEACH = 1.6;
/** m inland the canopy starts and reaches its height; m apart the palms' cells along the island */
const CANOPY_IN: [number, number] = [14, 38];
const PALM_CELL = 22;
/** m: the grid's step along the island (the silhouette's resolution), and its rows across */
const STEP = 2.5;
const ROWS = 24;

const smooth = (a: number, b: number, x: number): number => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

export interface FarMotu {
  /** the island in its own frame (along x, across z, the sea at y = 0): place and turn it */
  readonly mesh: THREE.Mesh;
  /** m: its length */
  readonly length: number;
  /** the land's height (m over the sea; under it off the island) at (along, across) — not the canopy's */
  land(along: number, across: number): number;
  /** (along, across) of a tower on its spine, near its middle */
  readonly site: [number, number];
}

/** the shape of island `seed`: its size, canopy, outline and spine */
function shapeOf(seed: number): {
  length: number;
  half: (a: number) => number;
  spine: (a: number) => number;
  inland: (a: number, c: number) => number;
  top: (a: number, c: number) => number;
} {
  const h = (k: number): number => hash2Cpu(seed * 3.17 + k * 11.3, seed * 0.71 - k * 5.9);
  const length = 380 + 520 * h(1);
  const width = 90 + 120 * h(2);
  const canopy = 15 + 10 * h(3);
  // (some are two islets: a channel across, a third of the way along)
  const gap = h(4) < 0.35 ? (h(5) - 0.5) * 0.6 * length : null;
  const bend = (h(6) - 0.5) * 0.12 * length;
  const spine = (a: number): number => bend * Math.sin((a / length) * Math.PI + h(7) * 3);
  const half = (a: number): number => {
    const e = Math.sqrt(Math.max(0, 1 - ((2 * a) / length) ** 2));
    const wander = 0.75 + 0.5 * fbm2Cpu(a / 120 + seed * 7.1, 0.37, 3);
    const channel = gap === null ? 1 : smooth(14, 34, Math.abs(a - gap));
    return (width / 2) * e * wander * channel;
  };
  const inland = (a: number, c: number): number => half(a) - Math.abs(c - spine(a));
  const top = (a: number, c: number): number => {
    const crowns = 0.8 + 0.4 * fbm2Cpu(a / 14 + seed * 2.3, c / 14, 3);
    // an emergent palm in some cells along the island: a narrow head over the canopy
    const i = Math.floor(a / PALM_CELL);
    const hp = (k: number): number => hash2Cpu(i * 1.37 + k * 7.7 + seed * 13.1, k * 3.1 - i * 0.29 + seed);
    const palm = hp(0) < 0.4 ? (5 + 4 * hp(1)) * Math.max(0, 1 - ((a - (i + 0.2 + 0.6 * hp(2)) * PALM_CELL) / 3.5) ** 2) : 0;
    return canopy * crowns + palm;
  };
  return { length, half, spine, inland, top };
}

/** a far motu for `seed`, its ground drawn with `material` */
export function createFarMotu(seed: number, material: THREE.Material): FarMotu {
  const s = shapeOf(seed);
  const land = (a: number, c: number): number => {
    const k = s.inland(a, c);
    return k < 0 ? -3 + 3 * smooth(-20, 0, k) : BEACH * smooth(0, 12, k) + (LAND - BEACH) * smooth(12, 40, k);
  };
  const height = (a: number, c: number): number => land(a, c) + (s.inland(a, c) > 0 ? smooth(CANOPY_IN[0], CANOPY_IN[1], s.inland(a, c)) * s.top(a, c) : 0);
  // the grid: along the island at STEP, across its widest span in ROWS (the canopy's top is what is seen)
  const halfL = s.length / 2 + 20;
  let wide = 0;
  for (let a = -halfL; a <= halfL; a += STEP) wide = Math.max(wide, s.half(a) + Math.abs(s.spine(a)));
  const halfW = wide + 20;
  const nu = Math.ceil((2 * halfL) / STEP) + 1;
  const nv = ROWS + 1;
  const pos = new Float32Array(nu * nv * 3);
  for (let j = 0; j < nv; j++) {
    const c = -halfW + (2 * halfW * j) / ROWS;
    for (let i = 0; i < nu; i++) {
      const a = -halfL + i * STEP;
      pos.set([a, height(a, c), c], (j * nu + i) * 3);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < nv - 1; j++) {
    for (let i = 0; i < nu - 1; i++) {
      const p = j * nu + i;
      idx.push(p, p + nu, p + 1, p + 1, p + nu, p + nu + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // (faces up whichever way the grid winds)
  const n = g.getAttribute('normal');
  if (n.getY(((nv >> 1) * nu + (nu >> 1)) | 0) < 0) {
    for (let t = 0; t < idx.length; t += 3) [idx[t + 1], idx[t + 2]] = [idx[t + 2], idx[t + 1]];
    g.setIndex(idx);
    g.computeVertexNormals();
  }
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, material);
  mesh.name = 'drift-far-motu';
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  const h = hash2Cpu(seed * 5.3, 1.9);
  const a0 = (h - 0.5) * 0.2 * s.length;
  return { mesh, length: s.length, land, site: [a0, s.spine(a0)] };
}

/**
 * The far motus' ground: the beach's pale sand at the waterline, dark olive canopy over the land (forest.ts's leaf
 * greens, varied in large patches), lit by the scene, seen through `air` (farAir.ts's).
 */
export function farMotuMaterial(air: MastAir): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
  const y = positionWorld.y;
  const patch = positionWorld.xz.div(90).sin().dot(vec3(1, 1, 0).xy).mul(0.25).add(0.5) as F;
  const leaf = mix(vec3(0.045, 0.062, 0.03), vec3(0.07, 0.08, 0.035), patch);
  const sand = vec3(0.55, 0.5, 0.42);
  m.colorNode = mix(sand, leaf, smoothstep(1.4, 3.2, y));
  m.fog = false;
  air.output(m);
  return m;
}
