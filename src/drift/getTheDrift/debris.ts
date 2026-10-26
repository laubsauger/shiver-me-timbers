/**
 * Drift-2 (direction-part-b.md, B5; the storyboard's shot 07): what the flood lifted — wood, wrack, relics,
 * the silt of drowned fields — floating on the new sea, gathered into a galaxy of debris: Act 2's own spiral
 * arms on the water (debrisField.ts lays out the pieces; this is how the sea's colour carries them from afar,
 * where a piece is far below a pixel). The film's one shape again: Drift-1's pair spirals, the galaxies, now
 * the sea.
 *
 * Coordinates: the tangent plane at the gathering point, east and north there.
 */
import * as THREE from 'three/webgpu';
import { atan, cos, exp, float, floor, int, length, log, mix, pow, sin, smoothstep, uint, vec2 } from 'three/tsl';
import { ARM_COUNT, ARM_PHASE, ARM_SHARP, ARM_WIND, CLUMP_BIG, CLUMP_SMALL, CORE, DEBRIS_RADIUS, DEBRIS_SPIN, DISK } from './debrisField';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

export interface DriftUniforms {
  /** s since the flood lifted the matter */
  time: F;
  /** 0..1 how much has floated free */
  presence: F;
  /** unit: the gathering point's outward normal, and two tangents spanning its plane */
  up: V3;
  east: V3;
  north: V3;
}

/**
 * The field as the sea's own colour carries it from afar (unit surface normal n): the floating matter's
 * density (`turbid`, 0..1: the water browned by wood, wrack and silt along the arms, densest in the core) and
 * the SLICKS (`slick`, 0..1: thin lines on the arms' inner edges where the matter calms the small ripples, so
 * the glint runs bright along them). The same pattern as the pieces (debrisField.ts: Act 2's galaxy arms, the
 * same clumps from the same hash), turning with them. `fp` is the pixel's footprint on the unit sphere, `R` the
 * planet's radius (Mm).
 */
export function driftMatter(n: V3, U: DriftUniforms, fp: F, R: number): { turbid: F; slick: F } {
  const flat = n.sub(U.up.mul(n.dot(U.up)));
  // metres east and north of the field's centre (debrisField.ts: x, z), turned back by the field's own slow turn
  const xe = flat.dot(U.east).mul(R * 1e6);
  const zs = flat.dot(U.north).mul(R * 1e6);
  // (the pieces' group turns by +spin·t about y: undo it)
  const turn = U.time.mul(DEBRIS_SPIN);
  const x = xe.mul(cos(turn)).sub(zs.mul(sin(turn)));
  const z = xe.mul(sin(turn)).add(zs.mul(cos(turn)));
  const fpm = fp.mul(R * 1e6);
  const r = length(vec2(x, z)).div(DEBRIS_RADIUS);
  const theta = atan(z.negate(), x);
  const arm = (lag: number, sharp: number): F =>
    pow(cos(theta.sub(log(r.max(0.02)).mul(ARM_WIND)).mul(ARM_COUNT).add(ARM_PHASE + lag)).mul(0.5).add(0.5), float(sharp)) as F;
  // the clumps (fine scale faded where it is finer than the pixel)
  const fine = float(1).sub(smoothstep(CLUMP_SMALL * 0.5, CLUMP_SMALL, fpm));
  const big = valueNoiseNode(x.div(CLUMP_BIG), z.div(CLUMP_BIG), 31);
  const small = mix(float(0.5), valueNoiseNode(x.div(CLUMP_SMALL), z.div(CLUMP_SMALL), 83), fine);
  const clump = pow(big.mul(0.6).add(small.mul(0.4)), float(1.6));
  const core = exp(r.div(-CORE)).mul(2.2);
  const disk = exp(r.div(-DISK));
  const rim = float(1).sub(smoothstep(0.9, 1.15, r));
  const density = core.add(disk.mul(arm(0, ARM_SHARP).mul(smoothstep(0.05, 0.16, r)).mul(clump.mul(1.4).add(0.2)).mul(1.6).add(0.12))).mul(rim);
  const turbid = smoothstep(0.15, 0.9, density).mul(U.presence) as F;
  const slick = arm(-0.7, 14).mul(smoothstep(0.08, 0.22, r)).mul(rim).mul(disk.mul(1.5).min(1)).mul(U.presence) as F;
  return { turbid, slick };
}

/** debrisField.ts valueNoise in the shader: the same integer hash, so the same clumps */
function hashNode(i: THREE.Node<'int'>, j: THREE.Node<'int'>, seed: number): F {
  let h = uint(i).mul(uint(73856093)).bitXor(uint(j).mul(uint(19349663))).bitXor(uint(seed));
  h = h.bitXor(h.shiftRight(uint(13))).mul(uint(1274126177));
  h = h.bitXor(h.shiftRight(uint(16)));
  return float(h).div(4294967295) as F;
}

function valueNoiseNode(x: F, y: F, seed: number): F {
  const xf = floor(x);
  const yf = floor(y);
  const xi = int(xf);
  const yi = int(yf);
  const u = x.sub(xf);
  const v = y.sub(yf);
  const su = u.mul(u).mul(float(3).sub(u.mul(2)));
  const sv = v.mul(v).mul(float(3).sub(v.mul(2)));
  const h00 = hashNode(xi, yi, seed);
  const h10 = hashNode(xi.add(1), yi, seed);
  const h01 = hashNode(xi, yi.add(1), seed);
  const h11 = hashNode(xi.add(1), yi.add(1), seed);
  const a = mix(h00, h10, su);
  const b = mix(h01, h11, su);
  return mix(a, b, sv) as F;
}
