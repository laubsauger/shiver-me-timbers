/**
 * MANZANITA (§T.112e, §V94, §T.112b's decision) — the shrub layer, and the
 * one piece of vegetation with a JOB beyond looking right.
 *
 * The user's call on the distraction fork was that it runs through a "dense
 * but walkable shrub corridor": the fork must read as a way THROUGH something,
 * not as a line on open ground, and it must do that without a single collider
 * (there is no foliage collision — you push through). Manzanita is what the
 * corridor is made of, so its silhouette has to say "chest-high thicket, and I
 * can see the gaps": multiple bare red stems splaying from one root burl, with
 * the leaf mass held up in separate clumps and daylight between them. A single
 * dome would read as a wall and the corridor would look shut.
 *
 * BUDGET ≤ 150 triangles (tests/sierraVegetation.test.ts). It is the most
 * numerous plant on the island by a wide margin — hundreds per corridor — so
 * it is half a juniper's cost: `manzanitaStems` 3-sided stems (one ring each)
 * and one apex-fanned leaf clump per stem. At the defaults, ~110 triangles.
 *
 * Deterministic per seed (createRng only), geometry only — no renderer.
 * Roles 5 (stem, the red bark) and 4 (leaf); the shared conifer material
 * tints both (pineScatter.ts).
 */
import * as THREE from 'three/webgpu';
import { createRng } from '../state/rng';
import { sierraParams, type SierraParams } from '../params/sierra';
import { PINE_ROLE, finishGeometry, lerp, newGeoBuilder, pushLobe, pushTube } from './pineGeometry';

const STEM_SIDES = 3;
const LOBE_RINGS = 2;
const LOBE_SEGMENTS = 5;

/** One manzanita bush. Same (seed, params) → byte-identical buffers. */
export function buildManzanitaGeometry(seed: number, p: SierraParams = sierraParams): THREE.BufferGeometry {
  const rng = createRng(seed);
  const b = newGeoBuilder();

  const h = p.manzanitaHeight * lerp(0.75, 1.3, rng());
  const spread = h * p.manzanitaSpread;
  const stems = Math.max(1, Math.floor(p.manzanitaStems));
  const stemR = h * p.manzanitaStemRadius;
  // the burl the stems all leave from — a real manzanita has one root crown
  const burlAz = rng() * Math.PI * 2;

  for (let i = 0; i < stems; i++) {
    const a = burlAz + i * 2.39996 + rng() * 0.8;
    // stems splay: the outer ones lean further and end lower, so the mass is a
    // rounded thicket rather than a bundle of parallel sticks
    const t = stems > 1 ? i / (stems - 1) : 0;
    const reach = spread * lerp(0.3, 1, 0.35 + t * 0.65) * lerp(0.8, 1.15, rng());
    const top = h * lerp(0.62, 1, rng());
    const dx = Math.cos(a) * reach;
    const dz = Math.sin(a) * reach;
    const phase = rng() * Math.PI * 2;
    pushTube(b, 0, 0, 0, top, stemR, stemR * 0.5, STEM_SIDES, 1, h, PINE_ROLE.manzanitaStem, phase, 0.55, [dx, dz]);
    pushLobe(
      b,
      dx, top, dz,
      spread * p.manzanitaLobeRadius * lerp(0.8, 1.25, rng()),
      p.manzanitaLobeSquash,
      LOBE_RINGS, LOBE_SEGMENTS,
      h,
      PINE_ROLE.manzanitaLeaf, phase, 1,
    );
  }

  return finishGeometry(b, p.foliageClusterBlend);
}
