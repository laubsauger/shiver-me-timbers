/**
 * BOAT LED LIGHT POOLS ON THE WATER (§T.209). The ocean is a `MeshBasicNodeMaterial` whose `colorNode` owns all of
 * its lighting (surfaceMaterial.ts, §V20), so scene lights never reach it: a boat's LEDs light the sea here or nowhere.
 *
 * One pool per boat, ≤ BOAT_LIGHT_POOL_MAX, bounded by an ellipse hugging the hull's plan (along the boat's heading).
 * The strip is lit as a LINE source (the nearest point of the strip on the boat's near side, the representative-point
 * trick §V92 uses for the sun): a DIFFUSE term on N·L, so ripples facing the strip light and troughs stay dark —
 * brighter on foam, where the wake and spray catch it — plus tight Blinn glints that string out into the strip's
 * reflection near the hull. A flat unlit ellipse read as glowing fog (user review of the first night frames). Two uniform ARRAYS (position+yaw, colour) and two small
 * uniforms: NO texture and NO sampler (§V40, tests/oceanBindingBudget.test.ts is unaffected).
 *
 * OPT-IN AT BUILD TIME, the `setActiveCaustics` convention: `setActiveBoatLightPool(pool)` BEFORE `buildSea`. With no
 * active pool `buildOceanSurfaceMaterial` adds no node at all, so the raft and pirate oceans are bit-identical.
 *
 * Colours arrive LINEAR and already multiplied by the LED level (0 = off). Uniform zero-colour slots skip
 * their lighting arithmetic; daylight and unused fleet slots contribute exactly 0.
 */
import * as THREE from 'three/webgpu';
import { If, Loop, cos, float, normalize, pow, sin, sign, uniform, uniformArray, vec3 } from 'three/tsl';
import { boatLightParams, type BoatLightParams } from '../params/boatLights';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node union (surfaceMaterial.ts convention)
type TslNode = any;

export const BOAT_LIGHT_POOL_MAX = 8;
/** the LED source height above each boat's reference point for the glint direction (m) */
const GLINT_SOURCE_Y = 0.15;

export interface BoatLightPool {
  readonly max: number;
  /** world x/y/z of the boat and its physics yaw = atan2(fwd.x, fwd.z) */
  readonly positions: readonly THREE.Vector4[];
  /** linear rgb × level; w unused */
  readonly colors: readonly THREE.Vector4[];
  set(i: number, x: number, y: number, z: number, yaw: number, color: THREE.Color, level: number): void;
  /** zero every slot from `from` on (a boat that is not drawn throws no light) */
  clearFrom(from: number): void;
  updateFromParams(p?: BoatLightParams): void;
  readonly nodes: { positions: TslNode; colors: TslNode; shape: TslNode; spec: TslNode };
}

export function createBoatLightPool(max = BOAT_LIGHT_POOL_MAX): BoatLightPool {
  const n = Math.max(1, Math.min(BOAT_LIGHT_POOL_MAX, Math.floor(max)));
  const positions = Array.from({ length: n }, () => new THREE.Vector4());
  const colors = Array.from({ length: n }, () => new THREE.Vector4());
  const shape = uniform(new THREE.Vector4());
  const spec = uniform(new THREE.Vector4());
  const pool: BoatLightPool = {
    max: n,
    positions,
    colors,
    set(i, x, y, z, yaw, color, level) {
      if (i < 0 || i >= n) return;
      const k = Number.isFinite(level) ? Math.max(0, level) : 0;
      positions[i].set(x, y, z, yaw);
      colors[i].set(color.r * k, color.g * k, color.b * k, 0);
    },
    clearFrom(from) {
      for (let i = Math.max(0, from); i < n; i++) colors[i].set(0, 0, 0, 0);
    },
    updateFromParams(p = boatLightParams) {
      (shape.value as THREE.Vector4).set(Math.max(0.1, p.poolLength), Math.max(0.1, p.poolWidth), p.poolIntensity, p.poolFoamGain);
      (spec.value as THREE.Vector4).set(p.poolSpecPower, p.poolSpecIntensity, Math.max(0, p.poolStripHalfLength), Math.max(0, p.poolStripHalfBeam));
    },
    nodes: { positions: uniformArray(positions, 'vec4'), colors: uniformArray(colors, 'vec4'), shape, spec },
  };
  pool.updateFromParams();
  return pool;
}

let active: BoatLightPool | undefined;
export function setActiveBoatLightPool(p: BoatLightPool | undefined): void {
  active = p;
}
export function activeBoatLightPool(): BoatLightPool | undefined {
  return active;
}

/**
 * The pools' radiance at one water fragment (call inside the ocean's colorNode Fn).
 * @param surfacePos world position of the displaced surface
 * @param normal     the live wave normal (unit)
 * @param viewDir    surface → eye (unit)
 * @param foam       0..1 foam coverage at this fragment
 */
export function boatLightPoolNode(pool: BoatLightPool, surfacePos: TslNode, normal: TslNode, viewDir: TslNode, foam: TslNode): TslNode {
  const { positions, colors, shape, spec } = pool.nodes;
  const acc = vec3(0).toVar();
  const foamBoost = float(1).add(foam.mul(shape.w));
  Loop(pool.max, ({ i }: { i: TslNode }) => {
    const pc = colors.element(i);
    If(pc.x.notEqual(0).or(pc.y.notEqual(0)).or(pc.z.notEqual(0)), () => {
      const pp = positions.element(i);
      const rel = surfacePos.sub(pp.xyz);
      const c = cos(pp.w);
      const s = sin(pp.w);
      // body frame: forward (sin yaw, 0, cos yaw), right (cos yaw, 0, −sin yaw); metres
      const alongM = rel.x.mul(s).add(rel.z.mul(c));
      const acrossM = rel.x.mul(c).sub(rel.z.mul(s));
      const along = alongM.div(shape.x);
      const across = acrossM.div(shape.y);
      const e2 = along.mul(along).add(across.mul(across));
      // windowed (reaches exactly 0 at the ellipse) with a bright core near the hull
      const win = float(1).sub(e2).max(0);
      const fall = win.mul(win);
      // the strip's nearest point on this fragment's side of the boat
      const a = alongM.clamp(spec.z.negate(), spec.z);
      const b = sign(acrossM).mul(spec.w);
      const strip = vec3(pp.xyz.x.add(s.mul(a)).add(c.mul(b)), pp.xyz.y.add(GLINT_SOURCE_Y), pp.xyz.z.add(c.mul(a)).sub(s.mul(b)));
      const L = normalize(strip.sub(surfacePos));
      const diffuse = normal.dot(L).max(0);
      const body = fall.div(e2.mul(5).add(1)).mul(shape.z).mul(diffuse.mul(1.6).add(0.12)).mul(foamBoost);
      const H = normalize(L.add(viewDir));
      const glint = pow(normal.dot(H).max(0), spec.x).mul(spec.y).mul(fall);
      acc.addAssign(pc.xyz.mul(body.add(glint)));
    });
  });
  return acc;
}
