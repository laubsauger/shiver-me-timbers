/**
 * Shared GPU particle pool for the spray emitters (§V6/§V7 crest spray in
 * spray.ts, bow spray in bowSpray.ts). Owns what both emitters have in
 * common: the two vec4 storage buffers, the init pass (whole pool dead),
 * the physics update pass (gravity, exponential drag, Euler, age — CPU
 * mirror: sprayMath.stepParticle) and the camera-facing soft-sprite render
 * (SpriteNodeMaterial: white, radial falloff, alpha fades with age,
 * additive blend, §V23 functional mix). Emitters add only their spawn pass.
 *
 * Buffers: posAge [xyz = world pos, w = age], velSize [xyz = vel, w = size
 * multiplier 0..1 chosen at spawn — how big a puff this particle is, e.g. a
 * bow slamming a swell throws a full sheet while cruising throws mist].
 * Dead = age ≥ THIS particle's life (`lifeNode`, jittered per slot — init
 * writes DEAD_AGE, far beyond any life slider × any jitter).
 * (The per-particle hash seed is NOT stored: it is fract((i+1)·φ), pure in
 * instanceIndex, so any pass that needs it recomputes it — sprayMath.goldenSeed.)
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  cameraPosition,
  cameraViewMatrix,
  float,
  instanceIndex,
  instancedArray,
  mix,
  select,
  smoothstep,
  storage,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { SIM_DT } from '../core/loop';
import { sprayParams } from '../params/spray';
import { hash2 } from '../terrain/noise';
import { foamTintNode } from './foamShading';
import { DEAD_AGE, H_LIFE, PHI, T_LIFE, sanitizePoolCount } from './sprayMath';

export interface SprayPoolOptions {
  /** multiplies sizeMin/sizeMax for this pool (bow sheets > crest mist) */
  sizeScale?: () => number;
  /** per-pool lifetime override — bow sheets must fall away far sooner than
   *  crest mist, or they stream the length of the hull and over the deck */
  life?: () => number;
  /** per-pool drag override — heavier drag drops sheets out of the air fast */
  drag?: () => number;
}

export function createSprayPool(rawCount: number, options: SprayPoolOptions = {}) {
  // counts feed buffer sizes + dispatch counts at construction — sanitize
  const count = sanitizePoolCount(rawCount, 1024);
  const posAge = instancedArray(count, 'vec4');
  const velSize = instancedArray(count, 'vec4');
  // separate read-only VIEWS for the sprite vertex stage: posAge.toReadOnly()
  // would mutate the shared node and silently drop every compute write to it
  // (init + physics), freezing the whole pool at buffer-zero — see §B.8
  const posAgeRead = storage(posAge.value, 'vec4', count).toReadOnly();
  const velSizeRead = storage(velSize.value, 'vec4', count).toReadOnly();

  const uLife = uniform(sprayParams.life);
  const uLifeVar = uniform(sprayParams.lifeVariation);
  const uGravity = uniform(sprayParams.gravity);
  const uDragFactor = uniform(1);
  const uSizeMin = uniform(sprayParams.sizeMin);
  const uSizeMax = uniform(sprayParams.sizeMax);
  const uOpacity = uniform(sprayParams.opacity);
  const uSoftness = uniform(sprayParams.softness);
  const uStreak = uniform(sprayParams.streak);
  const uStreakRef = uniform(sprayParams.streakRefSpeed);
  const uFadeNear = uniform(sprayParams.fadeNear);
  const uFadeFar = uniform(sprayParams.fadeFar);
  const uSizeScale = uniform(
    Number.isFinite(options.sizeScale?.() ?? 1) ? Math.max(0, options.sizeScale?.() ?? 1) : 1,
  );

  /**
   * Per-particle lifetime (CPU mirror: sprayMath.particleLife). EVERY test of
   * "is this particle dead" must use this node and not `uLife`, or a slot
   * respawns before it has faded (spawn gate too loose) or never fades out
   * (integrator too generous). Pure in instanceIndex on purpose: the physics
   * pass has no spawn time to hash against, and the value has to agree across
   * three passes that never talk to each other.
   */
  const lifeNode = () => {
    // @band-limited-elsewhere: fract of the particle INDEX, not of a spatial
    // coordinate — it never varies across a pixel, so it has no footprint
    const s = float(instanceIndex).add(1).mul(PHI).fract();
    const r = hash2(vec2(s.mul(H_LIFE), float(T_LIFE)));
    return uLife.mul(uLifeVar.oneMinus().add(uLifeVar.mul(2).mul(r))).max(1e-3);
  };

  // whole pool starts dead far below the surface
  const initPass = Fn(() => {
    posAge.element(instanceIndex).assign(vec4(0, -1000, 0, DEAD_AGE));
    velSize.element(instanceIndex).assign(vec4(0, 0, 0, 0));
  })().compute(count);

  // physics update — CPU mirror: sprayMath.stepParticle
  const updatePass = Fn(() => {
    const pa = posAge.element(instanceIndex);
    const vs = velSize.element(instanceIndex);
    If(pa.w.lessThan(lifeNode()), () => {
      const vel = vec3(vs.x, vs.y.sub(uGravity.mul(SIM_DT)), vs.z)
        .mul(uDragFactor)
        .toVar();
      velSize.element(instanceIndex).assign(vec4(vel, vs.w));
      posAge
        .element(instanceIndex)
        .assign(vec4(pa.xyz.add(vel.mul(SIM_DT)), pa.w.add(SIM_DT)));
    });
  })().compute(count);

  // render: instanced camera-facing sprites; dead → ageN = 1 → zero size
  const material = new THREE.SpriteNodeMaterial();
  const el = posAgeRead.element(instanceIndex);
  const vel = velSizeRead.element(instanceIndex).xyz;
  // divisor floor: uLife is CPU-clamped too, but 0/0 here would be a NaN
  // scale → screen-covering quad × pool size = fill-rate wedge. Never risk it.
  const ageN = el.w.div(lifeNode().max(1e-6)).clamp(0, 1);
  material.positionNode = el.xyz;

  // distance falloff (user critique: dots stippled out to the horizon).
  // Particles are a NEAR-FIELD effect — far crests carry painted foam, not
  // sprites. Inverted smoothstep, functional form only (§V23).
  const camDist = el.xyz.sub(cameraPosition).length();
  const distFade = smoothstep(uFadeNear, uFadeFar.max(uFadeNear.add(1)), camDist)
    .oneMinus();

  // dead OR fully faded particles collapse to zero size: a degenerate quad
  // rasterizes no fragments, so the idle pool costs no fill rate (alpha-0
  // quads still would — §V28/§B.5)
  // per-particle size multiplier chosen at spawn (bow sheet vs cruise mist),
  // clamped so a garbage buffer value can never inflate a quad (§V28)
  const sizeMul = velSizeRead.element(instanceIndex).w.clamp(0, 1);
  const size = mix(uSizeMin, uSizeMax, ageN).mul(uSizeScale).mul(sizeMul);
  const hidden = ageN.greaterThanEqual(1).or(distFade.lessThan(0.01));
  material.scaleNode = select(hidden, float(0), size);

  // motion streak: squash the radial falloff ACROSS the screen-space velocity
  // so fast droplets read as short dashes of mist, not bouncy balls. The
  // sprite quad is built in view space, so the view-space velocity direction
  // is the quad's own axis frame.
  const q = uv().mul(2).sub(1);
  const viewVel = cameraViewMatrix.mul(vec4(vel, 0)).xy;
  const viewSpeed = viewVel.length().toVar();
  // a zero-length direction would make BOTH quad axes read 0 → shape = 1 over
  // the whole quad → a hard bright SQUARE at additive blend (the §B.5 class
  // of failure). Fall back to a fixed axis; the streak factor is ~0 there.
  const dir = select(
    viewSpeed.greaterThan(1e-4),
    viewVel.div(viewSpeed.max(1e-4)), // floored divisor (§V28)
    vec2(1, 0),
  );
  const along = q.dot(dir);
  const across = q.dot(vec2(dir.y.negate(), dir.x));
  const streakN = smoothstep(float(0), uStreakRef.max(1e-3), vel.length());
  const squash = mix(float(1), uStreak.max(1), streakN);
  const r2 = along.mul(along).add(across.mul(squash).pow(2));
  // pow of a clamped-non-negative base: softness ≥ 1 gives a mist-soft edge
  const shape = r2.oneMinus().max(0).pow(uSoftness.max(1));

  // birth fade-in kills the pop of a sprite appearing at full size/alpha
  const born = smoothstep(float(0), float(0.12), ageN);
  const decayN = ageN.oneMinus().pow(1.4);
  material.colorNode = foamTintNode(); // warm-white, shared with sea foam
  material.opacityNode = shape
    .mul(born)
    .mul(decayN)
    .mul(distFade)
    .mul(uOpacity)
    .clamp(0, 1);
  material.transparent = true;
  material.blending = THREE.AdditiveBlending;
  material.depthWrite = false;
  // explicit, not defaulted: spray must be depth-TESTED against the hull or
  // particles behind the ship would draw over it and read as the deck being
  // covered in speckle rather than spray passing in front of it. depthWrite
  // stays off so particles don't occlude each other.
  material.depthTest = true;
  material.fog = false;

  const mesh = new THREE.Sprite(material as unknown as THREE.SpriteMaterial);
  mesh.count = count;
  mesh.frustumCulled = false; // positions live GPU-side, CPU knows no bounds

  let initialized = false;
  const run = (renderer: THREE.WebGPURenderer, pass: unknown) =>
    renderer.compute(pass as Parameters<THREE.WebGPURenderer['compute']>[0]);

  // non-finite params must never reach uniforms: NaN reaching the position
  // or scale path renders garbage quads (fill-rate hazard), and it would
  // persist in the storage buffers until every particle respawned.
  const fin = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);

  return {
    posAge,
    velSize,
    mesh,
    /** sanitized pool size — emitters must size their spawn passes with THIS */
    count,

    /** refresh shared uniforms from live params, then init (once) + physics */
    step(renderer: THREE.WebGPURenderer): void {
      // life floor: ageN divides by life; drag floor: negative drag would be
      // exponential velocity GROWTH → positions at Infinity within seconds
      uLife.value = Math.max(fin(options.life?.() ?? sprayParams.life, 1), 1e-3);
      // clamped < 1 so the shortest-lived slot keeps a positive lifetime
      uLifeVar.value = Math.min(0.9, Math.max(0, fin(sprayParams.lifeVariation, 0)));
      uGravity.value = fin(sprayParams.gravity, 0);
      uDragFactor.value = Math.exp(
        -Math.max(0, fin(options.drag?.() ?? sprayParams.drag, 0)) * SIM_DT,
      );
      uSizeScale.value = Math.max(0, fin(options.sizeScale?.() ?? 1, 1));
      uSizeMin.value = fin(sprayParams.sizeMin, 0);
      uSizeMax.value = fin(sprayParams.sizeMax, 0);
      uOpacity.value = fin(sprayParams.opacity, 0);
      uSoftness.value = Math.max(1, fin(sprayParams.softness, 1));
      uStreak.value = Math.max(1, fin(sprayParams.streak, 1));
      uStreakRef.value = Math.max(1e-3, fin(sprayParams.streakRefSpeed, 1));
      uFadeNear.value = Math.max(0, fin(sprayParams.fadeNear, 40));
      uFadeFar.value = Math.max(
        uFadeNear.value + 1,
        fin(sprayParams.fadeFar, 90),
      );
      if (!initialized) {
        run(renderer, initPass);
        initialized = true;
      }
      run(renderer, updatePass);
    },

    /** run an emitter's spawn pass (after step) */
    run,
    /**
     * THIS particle's lifetime, as a node — emitters must gate "is it dead?"
     * on `lifeNode()`, never on `uLife` (see the definition above).
     */
    lifeNode,

    dispose(): void {
      material.dispose();
    },
  };
}

export type SprayPool = ReturnType<typeof createSprayPool>;
