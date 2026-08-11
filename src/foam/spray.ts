/**
 * Crest spray particles (§V6 jacobian trigger, §V7 storm density, §V4
 * spirit: ALL per-particle work is GPU compute — CPU never touches one).
 * Pool/physics/render live in sprayPool.ts; this file adds the crest spawn:
 *
 * Spawn pass, per dead particle (age ≥ life) each tick: hash a candidate XZ
 * inside the spawn square around `centerUniform`; sample every cascade
 * displacement texture there and combine the jacobian like the surface
 * material (Σw − (n−1)). Three gates must ALL pass (sprayMath.crestBreaking /
 * spawnAccepted): jacobian below the CEILED threshold that tracks the foam
 * bias (sprayJacobianThreshold — surface genuinely folding, and no weather
 * preset can raise it onto flat water), height above the sea-state-scaled
 * crest gate (crestHeightThreshold — a crest TOP, not a trough, and equally
 * selective in calm and storm) and the per-candidate lottery. Then respawn at the DISPLACED surface point
 * (candidate + Σ(λDx, λDz), height Σh) with an upward hash-jittered +
 * wind-carried velocity. Candidates that miss a breaking crest stay dead, so
 * emission density scales with breaking area — storms spray hard (§V7), calm
 * seas stay clean instead of stippling white dots everywhere (user critique).
 * CPU mirrors: sprayMath goldenSeed / respawnCandidate / launchVelocity.
 *
 *   createSpray(cascades: {displacement, domain}[], resolution) =>
 *     { update(renderer, windDir): void; mesh; centerUniform; dispose() }
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  float,
  instanceIndex,
  int,
  ivec2,
  textureLoad,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { SIM_DT } from '../core/loop';
import { hash2 } from '../terrain/noise';
import { sprayParams } from '../params/spray';
import { oceanParams } from '../params/ocean';
import type { FoamCascadeInput } from './index';
import { createSprayPool } from './sprayPool';
import {
  H_CAND_X,
  H_CAND_Z,
  H_CHANCE,
  H_MAG,
  H_UP,
  H_YAW,
  PHI,
  T_OFF_CHANCE,
  T_OFF_MAG,
  T_OFF_UP,
  T_OFF_YAW,
  T_OFF_Z,
  crestHeightThreshold,
  sprayJacobianThreshold,
} from './sprayMath';

export { createBowSpray } from './bowSpray';

export function createSpray(cascades: FoamCascadeInput[], resolution: number) {
  // fail loud at construction: a zero/NaN domain would put Inf/NaN into the
  // texel math; a bad resolution would bake a garbage dispatch count
  for (const c of cascades) {
    if (!Number.isFinite(c.domain) || c.domain <= 0) {
      throw new Error(`spray: invalid cascade domain ${c.domain}`);
    }
  }
  if (!Number.isInteger(resolution) || resolution < 1) {
    throw new Error(`spray: invalid resolution ${resolution}`);
  }
  const pool = createSprayPool(sprayParams.count); // build-time pool size
  const count = pool.count; // sanitized — sizes the spawn dispatch too
  const n = resolution;

  // absolute spawn thresholds, recomputed CPU-side per tick from the live
  // foam bias + sea state (sprayMath.sprayJacobianThreshold /
  // crestHeightThreshold) — the shader just compares
  const uJacThreshold = uniform(0);
  const uCrestHeight = uniform(0);
  const uChance = uniform(sprayParams.spawnChance);
  const uSpawnLift = uniform(sprayParams.spawnLift);
  const uLaunchSpeed = uniform(sprayParams.launchSpeed);
  const uLateral = uniform(sprayParams.lateralSpread);
  const uWindCarry = uniform(sprayParams.windCarry);
  const uExtent = uniform(sprayParams.spawnExtent);
  const uWind = uniform(new THREE.Vector2());
  const uTime = uniform(0);
  /** spray region center (world XZ) — main thread snaps this to the camera */
  const centerUniform = uniform(new THREE.Vector2());
  // sea height RMS: bootstrap value only, replaced the first tick a caller
  // supplies one (and warned about loudly if none ever does)
  let rms = 0.7;
  let rmsSupplied = false;
  let warnedNoRms = false;

  const spawnPass = Fn(() => {
    const pa = pool.posAge.element(instanceIndex);
    If(pa.w.greaterThanEqual(pool.uLife), () => {
      // golden-ratio per-particle seed (sprayMath.goldenSeed — no Math.random)
      const s = float(instanceIndex).add(1).mul(PHI).fract().toVar();
      const rx = hash2(vec2(s.mul(H_CAND_X), uTime));
      const rz = hash2(vec2(s.mul(H_CAND_Z), uTime.add(T_OFF_Z)));
      const cand = centerUniform
        .add(vec2(rx.sub(0.5), rz.sub(0.5)).mul(uExtent))
        .toVar();

      // combined cascade sample at the candidate (like surfaceMaterial:
      // jacobian = Σw − (n−1) ≈ 1 at rest, displacement/height = Σxyz)
      let jac: any = float(1 - cascades.length);
      let disp: any = vec3(0);
      for (const c of cascades) {
        const tuv = cand.div(c.domain).fract();
        const texel = ivec2(
          int(tuv.x.mul(n)).clamp(0, n - 1),
          int(tuv.y.mul(n)).clamp(0, n - 1),
        );
        const d = textureLoad(c.displacement, texel);
        jac = jac.add(d.w);
        disp = disp.add(d.xyz);
      }

      // CPU mirrors: sprayMath.crestBreaking / spawnAccepted. The height gate
      // keeps spray on crest TOPS and the lottery thins each breaking band —
      // together they are what stops the whole ocean fizzing (§V6).
      const breaking = jac
        .lessThan(uJacThreshold)
        .and(disp.y.greaterThan(uCrestHeight));
      const roll = hash2(vec2(s.mul(H_CHANCE), uTime.add(T_OFF_CHANCE)));
      If(breaking.and(roll.lessThan(uChance)), () => {
        // CPU mirror: sprayMath.launchVelocity
        const rUp = hash2(vec2(s.mul(H_UP), uTime.add(T_OFF_UP)));
        const rYaw = hash2(vec2(s.mul(H_YAW), uTime.add(T_OFF_YAW)));
        const rMag = hash2(vec2(s.mul(H_MAG), uTime.add(T_OFF_MAG)));
        const vy = uLaunchSpeed.mul(rUp.mul(0.5).add(0.5));
        const angle = rYaw.mul(Math.PI * 2);
        const mag = uLaunchSpeed.mul(uLateral).mul(rMag);
        const wind = uWind.mul(uWindCarry);
        const vel = vec3(
          angle.cos().mul(mag).add(wind.x),
          vy,
          angle.sin().mul(mag).add(wind.y),
        );
        // Burst from the displaced surface point of the breaking crest,
        // LIFTED clear of it. The ocean surface writes depth now, so a sprite
        // spawned exactly ON the surface z-fights it and is depth-rejected at
        // the grazing angles this camera lives at — spray must be born in the
        // air above the crest, not coplanar with it.
        const pos = vec3(
          cand.x.add(disp.x),
          disp.y.add(uSpawnLift),
          cand.y.add(disp.z),
        );
        pool.posAge.element(instanceIndex).assign(vec4(pos, 0));
        // w = size multiplier: crest mist is one size class (the bow emitter
        // is the one that varies it, sheet vs cruise)
        pool.velSize.element(instanceIndex).assign(vec4(vel, 1));
      });
    });
  })().compute(count);

  return {
    mesh: pool.mesh,
    centerUniform,

    /** run once per fixed sim tick (§V2), after the ocean cascade update;
     *  windDir = horizontal wind vector (m/s), seaRms = ocean.heightRms */
    update(
      renderer: THREE.WebGPURenderer,
      windDir: THREE.Vector2,
      /** sea height RMS σ (ocean.heightRms) — drives the §V36 crest gate */
      seaRms?: number,
    ): void {
      // storms spray harder (§V7) via the foam bias, but ceiled so a storm
      // preset can't drag the trigger onto near-flat water
      uJacThreshold.value = sprayJacobianThreshold(
        oceanParams.jacobianFoamBias,
        sprayParams.sprayBiasOffset,
        sprayParams.sprayThresholdMax,
      );
      // §V36: crest gate is a multiple of the sea's height RMS, never metres
      if (seaRms !== undefined && Number.isFinite(seaRms)) {
        rms = seaRms;
        rmsSupplied = true;
      } else if (!rmsSupplied && !warnedNoRms) {
        // fail loud rather than silently gating on a bootstrap constant — the
        // exact class of bug §V36 exists to prevent
        warnedNoRms = true;
        console.warn(
          'spray: no seaRms supplied to update() — crest gate is running on a ' +
            'bootstrap σ and will not track weather. Pass ocean.heightRms.',
        );
      }
      uCrestHeight.value = crestHeightThreshold(sprayParams.crestHeightSigma, rms);
      uChance.value = sprayParams.spawnChance;
      uSpawnLift.value = sprayParams.spawnLift;
      uLaunchSpeed.value = sprayParams.launchSpeed;
      uLateral.value = sprayParams.lateralSpread;
      uWindCarry.value = sprayParams.windCarry;
      uExtent.value = sprayParams.spawnExtent;
      // NaN wind would be written into velocity buffers at spawn and persist
      // for a full particle lifetime — zero it instead
      (uWind.value as THREE.Vector2).set(
        Number.isFinite(windDir.x) ? windDir.x : 0,
        Number.isFinite(windDir.y) ? windDir.y : 0,
      );
      uTime.value += SIM_DT;
      pool.step(renderer);
      pool.run(renderer, spawnPass);
    },

    dispose(): void {
      pool.dispose();
    },
  };
}

export type Spray = ReturnType<typeof createSpray>;
