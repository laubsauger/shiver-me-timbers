/**
 * DEPTH AND IMMERSION (the 2026-11-01 brief: "three particle depth layers (near large soft bokeh, mid, far fine dust)
 * with parallax from a slow forward camera drift (≤ comfort), using the whole dome (overhead and sides), not only the
 * front"). The event field (loops.ts, products.ts) and the medium's motes (dust.ts, the MID layer: lit only where
 * events light it) sit at 5–25 m; on their own they read as one shell of activity at one distance. Two layers around
 * them give the dome its depth:
 *
 *   NEAR   a few hundred soft discs of out-of-focus light 1–5.5 m from the eye — what a lens sees of a mote it is not
 *          focused on: a flat disc with a faintly brighter rim (the aperture's edge), dim on its own, glowing up as a
 *          collision near it lights it (the same event lights dust.ts sums). At 0.35 m/s of forward drift (timeline.ts
 *          eyePath, the arising and the cooling) a disc 2 m off crosses ~10°/s of sky: the parallax that says "we are
 *          moving through this", where a turn would only say "the dome is rotating". They ride a box around the eye
 *          (wrapped, faded out before its walls and right at the eye), so the drift never empties them.
 *   FAR    tens of thousands of points of fine dust 35–90 m out, pixel-sized and faint, fixed in the world: they barely
 *          move with the drift (a few metres against 60), so they are the still ground the near layer slides over.
 *
 * Both all around the eye — overhead, the sides, behind — at even density on the sphere. Both follow the act's arc
 * (`level`, field.ts): nothing in the cold open's black, up with the arising, a little less in the cooling, and both
 * end with the wave like everything else (waveFx.ts spent: behind the front the dome is dark). They keep out of the
 * text's sky (the pocket) as the field does. Pure in act time: positions are hashes of the index, the wrap is a
 * function of the eye's position, which is a function of t.
 */
import * as THREE from 'three/webgpu';
import { Fn, Loop, cameraPosition, exp, float, hash, instanceIndex, max, mix, normalize, pow, smoothstep, uniformArray, uv, vec3, vec4 } from 'three/tsl';
import { billboardMesh, eyeFacing } from './billboard';
import { pocketMask, randomDir, type PocketUniforms } from './pairModel';
import { DUST_LIGHTS } from './dust';
import { frontTime, spent, waveWarp, type WaveFxUniforms } from './waveFx';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;

/**
 * INDEPENDENT RANDOM DRAWS per layer and per quantity. TSL's `hash` truncates its seed to an unsigned integer
 * (three/src/nodes/math/Hash.js: seed.toUint()), so the idiom hash(i·1.31 + 0.07) is the hash of ⌊1.31·i⌋: two draws
 * hash(i·a) and hash(j·b) hit the SAME integers for many (i, j), and two layers drawn that way share their directions
 * and differ only in radius — the same constellation at two depths (the 2026-11-01 note on the first depth pass:
 * "the identical particle pattern 3 times on top of each other, making it seem cloned"). Here every draw hashes the
 * index plus its own integer offset: layer × 2²¹ + quantity × 2¹⁸ (each layer holds under 2¹⁸ = 262 144 points, and
 * float32 keeps every integer below 2²⁴ exact), so no two draws of any layer ever read the same integer.
 */
const draw = (i: F, layer: number, quantity: number): F => hash(i.add(layer * 2 ** 21 + quantity * 2 ** 18));

export interface DepthUniforms {
  time: F;
  pixelAngle: F;
  eye: V3;
  /** 0..1 the near and far layers' presence now (field.ts: the act's arc) */
  near: F;
  far: F;
  /** linear radiance of a near disc and a far mote, unlit */
  nearRadiance: F;
  farRadiance: F;
  matter: V3;
  anti: V3;
  pocket: PocketUniforms;
  fx: WaveFxUniforms;
}

/** m, half the side of the box the near discs ride in */
const NEAR_BOX = 5.5;

export interface DepthLayers {
  readonly near: THREE.InstancedMesh;
  readonly far: THREE.InstancedMesh;
  setLights(lights: Array<{ pos: [number, number, number]; colour: [number, number, number] }>): void;
  dispose(): void;
}

export function createDepthLayers(nearCount: number, farCount: number, U: DepthUniforms): DepthLayers {
  const lightPos = uniformArray(Array.from({ length: DUST_LIGHTS }, () => new THREE.Vector4()), 'vec4');
  const lightCol = uniformArray(Array.from({ length: DUST_LIGHTS }, () => new THREE.Vector4()), 'vec4');
  /** the event lights at `pos`, plain inverse square (a near disc is a mote seen out of focus: it scatters them) */
  const lit = (pos: V3): V3 => {
    const acc = vec3(0).toVar();
    Loop(DUST_LIGHTS, ({ i: j }) => {
      const L = lightPos.element(j) as unknown as V4;
      const C = lightCol.element(j) as unknown as V4;
      const d = L.xyz.sub(pos);
      acc.addAssign(C.xyz.div(d.dot(d).add(0.3)));
    });
    return acc;
  };
  /** a hue between matter's amber and antimatter's blue-violet, mostly pale (the limited palette, grade notes) */
  const tint = (h: F): V3 => mix(mix(U.matter, U.anti, h.greaterThan(0.5).select(float(1), float(0))), vec3(1, 0.96, 0.9), float(0.55));

  // ---------------------------------------------------------------- NEAR: out-of-focus discs
  const i = float(instanceIndex);
  const base = vec3(draw(i, 1, 0), draw(i, 1, 1), draw(i, 1, 2)).mul(2 * NEAR_BOX).sub(NEAR_BOX);
  // wrapped into the box about the eye: rel ∈ [−B, B)³, fixed in the world between wraps
  const rel = base.sub(U.eye).add(NEAR_BOX).mod(2 * NEAR_BOX).sub(NEAR_BOX);
  const placed = U.eye.add(rel);
  const r = rel.length();
  // gone before the box's walls (where a wrap would pop it) and right at the eye (a disc filling the dome)
  const keep = smoothstep(NEAR_BOX, NEAR_BOX * 0.78, r).mul(smoothstep(1, 1.8, r));
  const pos = waveWarp(placed, U.fx);
  const left = spent(frontTime(placed, U.fx), U.fx, 0.1);
  const pk = float(1).sub(pocketMask(placed.sub(U.eye), U.pocket));
  const size = float(0.07).add(draw(i, 1, 3).mul(0.16));
  const hue = draw(i, 1, 4);
  const nearLight = tint(hue).mul(U.nearRadiance).add(lit(placed).mul(0.6)).mul(U.near).mul(keep).mul(left).mul(pk);
  const nearMat = new THREE.NodeMaterial();
  nearMat.transparent = true;
  nearMat.depthWrite = false;
  nearMat.side = THREE.DoubleSide;
  nearMat.blending = THREE.AdditiveBlending;
  nearMat.positionNode = eyeFacing(pos, size.mul(smoothstep(0.0005, 0.002, U.near.mul(keep).mul(left))));
  nearMat.colorNode = Fn(() => {
    const q = uv().sub(0.5).mul(2);
    const rr = q.dot(q);
    // soft all the way: a Gaussian windowed to zero at the quad's edge (glow.ts) — no flat disc, no rim (the user,
    // 2026-11-01, on the grains: "so blobby"; a defocused disc with an aperture rim is the same complaint, larger)
    const w = float(1).sub(rr.min(1));
    const disc = exp(rr.mul(3).negate()).mul(w.mul(w));
    return vec4(nearLight.mul(disc), 1);
  })();
  nearMat.name = 'undertime-depth-near';
  const near = billboardMesh(nearMat, nearCount, 'undertime-depth-near');
  near.geometry.deleteAttribute('normal');

  // ---------------------------------------------------------------- FAR: fine dust
  const k = float(instanceIndex);
  const dir = randomDir(draw(k, 2, 0), draw(k, 2, 1));
  const R = float(35).add(pow(draw(k, 2, 2), float(0.7)).mul(55));
  const farPlaced = dir.mul(R);
  const toEye = cameraPosition.sub(farPlaced);
  const dist = toEye.length();
  const farSize = float(0.05).mul(draw(k, 2, 3).mul(1.2).add(0.4));
  const drawn = max(farSize, U.pixelAngle.mul(1.4).mul(dist));
  const coverage = farSize.div(drawn).pow(2);
  const farLeft = spent(frontTime(farPlaced, U.fx), U.fx, 0.1);
  const farPk = float(1).sub(pocketMask(farPlaced.sub(U.eye), U.pocket));
  // a few brighter grains among the many (a field of equal points reads as noise)
  const bright = pow(draw(k, 2, 4), float(6)).mul(5).add(0.4);
  const farLight = tint(draw(k, 2, 5)).mul(U.farRadiance).mul(bright).add(lit(farPlaced).mul(0.3)).mul(U.far).mul(farLeft).mul(farPk).mul(coverage);
  const farMat = new THREE.NodeMaterial();
  farMat.transparent = true;
  farMat.depthWrite = false;
  farMat.side = THREE.DoubleSide;
  farMat.blending = THREE.AdditiveBlending;
  farMat.positionNode = eyeFacing(waveWarp(farPlaced, U.fx), drawn.mul(smoothstep(0.0005, 0.002, U.far.mul(farLeft))));
  farMat.colorNode = Fn(() => {
    const q = uv().sub(0.5).mul(2);
    return vec4(farLight.mul(exp(q.dot(q).mul(4).negate()).mul(smoothstep(1, 0.6, q.dot(q)))), 1);
  })();
  farMat.name = 'undertime-depth-far';
  const far = billboardMesh(farMat, farCount, 'undertime-depth-far');
  far.geometry.deleteAttribute('normal');
  void normalize;

  return {
    near,
    far,
    setLights(lights) {
      for (let j = 0; j < DUST_LIGHTS; j++) {
        const l = lights[j];
        (lightPos.array[j] as THREE.Vector4).set(l ? l.pos[0] : 0, l ? l.pos[1] : 0, l ? l.pos[2] : 0, 0);
        (lightCol.array[j] as THREE.Vector4).set(l ? l.colour[0] : 0, l ? l.colour[1] : 0, l ? l.colour[2] : 0, 0);
      }
    },
    dispose() {
      for (const m of [near, far]) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    },
  };
}
