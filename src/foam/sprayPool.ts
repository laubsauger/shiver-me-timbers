/**
 * Shared GPU particle pool for the spray emitters (§V6/§V7 crest spray in
 * spray.ts, bow spray in bowSpray.ts). Owns what both emitters have in
 * common: the two vec4 storage buffers, the init pass (whole pool dead),
 * the physics update pass (gravity, exponential drag, Euler, age — CPU
 * mirror: sprayMath.stepParticle) and the camera-facing soft-sprite render
 * (SpriteNodeMaterial: white, radial falloff, alpha fades with age,
 * additive blend, §V23 functional mix). Emitters add only their spawn pass.
 *
 * Buffers: posAge [xyz = world pos, w = age], velSeed [xyz = vel, w = seed].
 * Dead = age ≥ life (init writes DEAD_AGE, far beyond any life slider).
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  float,
  instanceIndex,
  instancedArray,
  mix,
  select,
  uniform,
  uv,
  vec3,
  vec4,
} from 'three/tsl';
import { SIM_DT } from '../core/loop';
import { sprayParams } from '../params/spray';
import { DEAD_AGE, sanitizePoolCount } from './sprayMath';

export function createSprayPool(rawCount: number) {
  // counts feed buffer sizes + dispatch counts at construction — sanitize
  const count = sanitizePoolCount(rawCount, 1024);
  const posAge = instancedArray(count, 'vec4');
  const velSeed = instancedArray(count, 'vec4');

  const uLife = uniform(sprayParams.life);
  const uGravity = uniform(sprayParams.gravity);
  const uDragFactor = uniform(1);
  const uSizeMin = uniform(sprayParams.sizeMin);
  const uSizeMax = uniform(sprayParams.sizeMax);
  const uOpacity = uniform(sprayParams.opacity);

  // whole pool starts dead far below the surface
  const initPass = Fn(() => {
    posAge.element(instanceIndex).assign(vec4(0, -1000, 0, DEAD_AGE));
    velSeed.element(instanceIndex).assign(vec4(0, 0, 0, 0));
  })().compute(count);

  // physics update — CPU mirror: sprayMath.stepParticle
  const updatePass = Fn(() => {
    const pa = posAge.element(instanceIndex);
    const vs = velSeed.element(instanceIndex);
    If(pa.w.lessThan(uLife), () => {
      const vel = vec3(vs.x, vs.y.sub(uGravity.mul(SIM_DT)), vs.z)
        .mul(uDragFactor)
        .toVar();
      velSeed.element(instanceIndex).assign(vec4(vel, vs.w));
      posAge
        .element(instanceIndex)
        .assign(vec4(pa.xyz.add(vel.mul(SIM_DT)), pa.w.add(SIM_DT)));
    });
  })().compute(count);

  // render: instanced camera-facing sprites; dead → ageN = 1 → alpha 0
  const material = new THREE.SpriteNodeMaterial();
  const el = posAge.toReadOnly().element(instanceIndex);
  // divisor floor: uLife is CPU-clamped too, but 0/0 here would be a NaN
  // scale → screen-covering quad × pool size = fill-rate wedge. Never risk it.
  const ageN = el.w.div(uLife.max(1e-6)).clamp(0, 1);
  material.positionNode = el.xyz;
  // dead particles collapse to zero size: a degenerate quad rasterizes no
  // fragments, so the idle pool costs no fill rate (alpha-0 quads still would)
  const size = mix(uSizeMin, uSizeMax, ageN); // puffs grow as they fly
  material.scaleNode = select(ageN.greaterThanEqual(1), float(0), size);
  const q = uv().mul(2).sub(1);
  const shape = q.dot(q).oneMinus().max(0); // soft round falloff
  material.colorNode = vec3(1);
  material.opacityNode = shape.pow(1.5).mul(ageN.oneMinus()).mul(uOpacity);
  material.transparent = true;
  material.blending = THREE.AdditiveBlending;
  material.depthWrite = false;
  material.fog = false;

  const mesh = new THREE.Sprite(material as unknown as THREE.SpriteMaterial);
  mesh.count = count;
  mesh.frustumCulled = false; // positions live GPU-side, CPU knows no bounds

  let initialized = false;
  const run = (renderer: THREE.WebGPURenderer, pass: unknown) =>
    renderer.compute(pass as Parameters<THREE.WebGPURenderer['compute']>[0]);

  return {
    posAge,
    velSeed,
    mesh,

    /** refresh shared uniforms from live params, then init (once) + physics */
    step(renderer: THREE.WebGPURenderer): void {
      uLife.value = sprayParams.life;
      uGravity.value = sprayParams.gravity;
      uDragFactor.value = Math.exp(-sprayParams.drag * SIM_DT);
      uSizeMin.value = sprayParams.sizeMin;
      uSizeMax.value = sprayParams.sizeMax;
      uOpacity.value = sprayParams.opacity;
      if (!initialized) {
        run(renderer, initPass);
        initialized = true;
      }
      run(renderer, updatePass);
    },

    /** run an emitter's spawn pass (after step) */
    run,
    uLife,

    dispose(): void {
      material.dispose();
    },
  };
}

export type SprayPool = ReturnType<typeof createSprayPool>;
