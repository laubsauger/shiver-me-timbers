/**
 * WESTERN JUNIPER (§T.112e, §V94) — the second sierra canopy species.
 *
 * WHY IT IS NOT A SMALL PINE. `buildPineGeometry(seed, 'juniper')` made a
 * juniper by squashing a pine to 42% and giving it two fat tiers: still a
 * cone, still radially symmetric, still upright. A juniper on a granite knob
 * is the opposite shape — a SHORT, THICK, LEANING bole that forks low into two
 * or three gnarled limbs, each carrying a broad flattened cushion of scale
 * foliage, wider than the plant is tall. That silhouette is what tells the
 * player they are on the bare windward convexity rather than in the moist
 * hollow with the pines (the density maps in sierraScatter.ts put it there;
 * this is what has to LOOK like it belongs there).
 *
 * BUDGET ≤ 300 triangles, same as the pine (tests/sierraVegetation.test.ts):
 * a 5-sided bole (2 rings) + `juniperLimbs` 4-sided limbs + one leaf lobe per
 * limb plus a central one, each an apex-fanned half-dome. At the defaults that
 * is ~130 triangles — junipers outnumber pines on a dome island, so the
 * cheaper of the two is the right one to be numerous.
 *
 * Deterministic per seed (createRng only), geometry only — no renderer.
 * Attributes are the shared contract (pineGeometry.ts): windWeight,
 * phaseOffset, role, and the baked cluster normals every lobe gets from
 * `pushLobe`.
 */
import * as THREE from 'three/webgpu';
import { createRng } from '../state/rng';
import { sierraParams, type SierraParams } from '../params/sierra';
import { PINE_ROLE, finishGeometry, lerp, newGeoBuilder, pushLobe, pushTube } from './pineGeometry';

const BOLE_SIDES = 5;
const BOLE_RINGS = 2;
const LIMB_SIDES = 4;
const LOBE_RINGS = 2;
const LOBE_SEGMENTS = 6;

/**
 * One juniper. Same (seed, params) → byte-identical buffers.
 *
 * The bole leans on a seeded bearing and every limb is measured from THAT
 * lean, so the whole plant reads as one thing that grew away from the wind
 * rather than as a trunk with decorations bolted on.
 */
export function buildJuniperGeometry(seed: number, p: SierraParams = sierraParams): THREE.BufferGeometry {
  const rng = createRng(seed);
  const b = newGeoBuilder();

  const h = p.juniperHeight * lerp(0.8, 1.25, rng());
  const spread = h * p.juniperSpread;
  const boleTop = h * lerp(0.26, 0.4, rng());
  const boleR = h * p.juniperBoleRadius;
  // the lean: a bearing and a horizontal displacement at the bole's top
  const leanAz = rng() * Math.PI * 2;
  const leanMag = boleTop * p.juniperLean * lerp(0.5, 1, rng());
  const lx = Math.cos(leanAz) * leanMag;
  const lz = Math.sin(leanAz) * leanMag;

  // wind: a juniper is stiff and low — the crown moves, the bole does not
  const windTop = p.juniperWindWeight * 0.5 + 0.2;
  pushTube(b, 0, 0, 0, boleTop, boleR, boleR * 0.72, BOLE_SIDES, BOLE_RINGS, h, PINE_ROLE.trunk, 0, windTop * 0.35, [lx, lz]);

  const limbs = Math.max(1, Math.floor(p.juniperLimbs));
  for (let i = 0; i < limbs; i++) {
    // golden angle so no two junipers fork on the same bearing pattern
    const a = leanAz + i * 2.39996 + rng() * 0.7;
    const reach = spread * lerp(0.55, 1, rng());
    const rise = h - boleTop;
    const tipY = boleTop + rise * lerp(0.35, 0.8, rng());
    const dx = lx + Math.cos(a) * reach;
    const dz = lz + Math.sin(a) * reach;
    const phase = rng() * Math.PI * 2;
    pushTube(
      b,
      lx, lz,
      boleTop * 0.85, tipY,
      boleR * 0.55, boleR * 0.28,
      LIMB_SIDES, 1,
      h,
      PINE_ROLE.trunk, phase, windTop * 0.6,
      [dx - lx, dz - lz],
    );
    // the cushion this limb carries: broad, flattened, sitting on the tip
    pushLobe(
      b,
      dx, tipY, dz,
      spread * p.juniperLobeRadius * lerp(0.85, 1.2, rng()),
      p.juniperLobeSquash,
      LOBE_RINGS, LOBE_SEGMENTS,
      h,
      PINE_ROLE.juniper, phase, windTop,
    );
  }
  // the central mass over the fork, so the plant is not a ring of pads
  pushLobe(
    b,
    lx * 0.6, boleTop + (h - boleTop) * 0.45, lz * 0.6,
    spread * p.juniperLobeRadius * 1.15,
    p.juniperLobeSquash * 1.15,
    LOBE_RINGS, LOBE_SEGMENTS,
    h,
    PINE_ROLE.juniper, rng() * Math.PI * 2, windTop * 0.85,
  );

  return finishGeometry(b, p.foliageClusterBlend);
}
