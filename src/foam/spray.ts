/**
 * Crest spray particles (§V6 jacobian trigger, §V7 storm density, §V4
 * spirit: ALL per-particle work is GPU compute — CPU never touches one).
 * Pool/physics/render live in sprayPool.ts; this file adds the crest spawn:
 *
 * Spawn pass, per dead particle (age ≥ its own life) each tick: hash a
 * candidate XZ inside the spawn square around `centerUniform`; sample every
 * cascade's displacement AND derivatives there and combine them like the
 * surface material (det J = Σw − (n−1), trace = 2 + λΣ∂D). Three gates must
 * ALL pass (sprayMath.crestBreaking / spawnAccepted): λ− below the gate
 * (sprayEigenGate — §V58's real onset-of-breaking signal, carried from the
 * FOAM gate in σ so the two systems agree about where the sea is breaking and
 * no weather preset can drag it onto flat water), height above the
 * sea-state-scaled crest gate (crestHeightThreshold — a crest TOP, not a
 * trough, and equally selective in calm and storm) and the per-candidate
 * lottery. Then respawn at the DISPLACED surface point (candidate + Σ(λDx,
 * λDz), height Σh) with a gusty upward + wind-carried velocity. Candidates
 * that miss a breaking crest stay dead, so emission density scales with
 * breaking area — storms spray hard (§V7), calm seas stay clean instead of
 * stippling white dots everywhere (user critique).
 * CPU mirrors: sprayMath goldenSeed / respawnCandidate / seaMinEigenvalue /
 * launchVelocity / gustFactor / sizeJitter.
 *
 *   createSpray(cascades: {displacement, derivatives, domain}[], resolution) =>
 *     { update(renderer, wind, moments): void; mesh; centerUniform; dispose() }
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
import { loadCascadeLayer, type CascadeLayer } from '../ocean/oceanTextures';
import { hash2 } from '../terrain/noise';
import { sprayParams } from '../params/spray';
import { oceanParams } from '../params/ocean';
/**
 * Spray reads BOTH ocean textures at a candidate: `displacement` for height
 * and det J, `derivatives` for the jacobian trace (.zw, unscaled) — λ− needs
 * both, and λ− is the gate (§V58). Same two textures the foam inject pass
 * takes, because it is the same physical event.
 */
export interface SprayCascadeInput {
  displacement: THREE.StorageTexture;
  derivatives: CascadeLayer;
  domain: number;
}

/**
 * The live spectral moments the σ-relative gates need (§V36) — the ocean
 * publishes all three. Passing them is not optional in practice: without
 * them the emitter runs on a bootstrap σ and says so.
 */
export interface SpraySeaMoments {
  /** OceanSimulation.heightRms — σ of elevation, drives the crest gate */
  heightRms: number;
  /** OceanSimulation.jacobianRms — the DIRECTION-FREE |k| moment (§V59) */
  jacobianRms: number;
  /** OceanSimulation.effectiveChoppiness() — the fold-capped λ actually sent */
  choppiness: number;
}
import { createSprayPool } from './sprayPool';
import {
  H_CAND_X,
  H_CAND_Z,
  H_CHANCE,
  H_MAG,
  H_SIZE,
  H_UP,
  H_YAW,
  PHI,
  T_OFF_CHANCE,
  T_OFF_MAG,
  T_OFF_UP,
  T_OFF_YAW,
  T_OFF_Z,
  T_SIZE,
  crestHeightThreshold,
  sprayEigenGate,
} from './sprayMath';

export { createBowSpray } from './bowSpray';

export function createSpray(cascades: SprayCascadeInput[], resolution: number) {
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
  // foam bias + sea moments (sprayMath.sprayEigenGate / crestHeightThreshold)
  // — the shader just compares
  const uEigenGate = uniform(0);
  const uChoppiness = uniform(1);
  const uCrestHeight = uniform(0);
  const uChance = uniform(sprayParams.spawnChance);
  const uSpawnLift = uniform(sprayParams.spawnLift);
  const uLaunchSpeed = uniform(sprayParams.launchSpeed);
  const uGust = uniform(sprayParams.gustiness);
  const uSizeVar = uniform(sprayParams.sizeVariation);
  const uLateral = uniform(sprayParams.lateralSpread);
  const uWindCarry = uniform(sprayParams.windCarry);
  const uExtent = uniform(sprayParams.spawnExtent);
  const uWind = uniform(new THREE.Vector2());
  const uTime = uniform(0);
  /** spray region center (world XZ) — main thread snaps this to the camera */
  const centerUniform = uniform(new THREE.Vector2());
  // sea moments: bootstrap values only, replaced the first tick a caller
  // supplies them (and warned about loudly if none ever does)
  let sea: SpraySeaMoments = { heightRms: 0.7, jacobianRms: 0.165, choppiness: 0.95 };
  let seaSupplied = false;
  let warnedNoSea = false;

  const spawnPass = Fn(() => {
    const pa = pool.posAge.element(instanceIndex);
    If(pa.w.greaterThanEqual(pool.lifeNode()), () => {
      // golden-ratio per-particle seed (sprayMath.goldenSeed — no Math.random)
      const s = float(instanceIndex).add(1).mul(PHI).fract().toVar();
      const rx = hash2(vec2(s.mul(H_CAND_X), uTime));
      const rz = hash2(vec2(s.mul(H_CAND_Z), uTime.add(T_OFF_Z)));
      const cand = centerUniform
        .add(vec2(rx.sub(0.5), rz.sub(0.5)).mul(uExtent))
        .toVar();

      // combined cascade sample at the candidate (like surfaceMaterial:
      // det J = Σw − (n−1) ≈ 1 at rest, displacement/height = Σxyz) plus the
      // jacobian TRACE from the derivatives (.zw hold ∂Dx/∂x and ∂Dz/∂z
      // UNSCALED, so λ is re-applied below — same contract as injectPass)
      let det: any = float(1 - cascades.length);
      let traceSum: any = float(0);
      let disp: any = vec3(0);
      for (const c of cascades) {
        const tuv = cand.div(c.domain).fract();
        const texel = ivec2(
          int(tuv.x.mul(n)).clamp(0, n - 1),
          int(tuv.y.mul(n)).clamp(0, n - 1),
        );
        const d = textureLoad(c.displacement, texel);
        det = det.add(d.w);
        disp = disp.add(d.xyz);
        // a LAYER of the ocean's shared derivatives array texture (§V.40)
        const g = loadCascadeLayer(c.derivatives, texel);
        traceSum = traceSum.add(g.z.add(g.w));
      }
      // CPU mirror: sprayMath.seaMinEigenvalue. λ− = ½(tr − √(tr²−4det)) is
      // the onset of BREAKING (§V58); det J alone is area compression and
      // cannot tell a fold from water piling up flat, which is why foam
      // injects from this and spray now agrees with it about where the sea
      // is breaking. max(0) on the discriminant is a float-error floor.
      const trace = float(2).add(uChoppiness.mul(traceSum)).toVar();
      const minEigen = trace
        .sub(trace.mul(trace).sub(det.mul(4)).max(0).sqrt())
        .mul(0.5);

      // CPU mirrors: sprayMath.crestBreaking / spawnAccepted. The height gate
      // keeps spray on crest TOPS and the lottery thins each breaking band —
      // together they are what stops the whole ocean fizzing (§V6).
      const breaking = minEigen
        .lessThan(uEigenGate)
        .and(disp.y.greaterThan(uCrestHeight));
      const roll = hash2(vec2(s.mul(H_CHANCE), uTime.add(T_OFF_CHANCE)));
      If(breaking.and(roll.lessThan(uChance)), () => {
        // CPU mirror: sprayMath.launchVelocity
        const rUp = hash2(vec2(s.mul(H_UP), uTime.add(T_OFF_UP)));
        const rYaw = hash2(vec2(s.mul(H_YAW), uTime.add(T_OFF_YAW)));
        const rMag = hash2(vec2(s.mul(H_MAG), uTime.add(T_OFF_MAG)));
        // CPU mirror: sprayMath.gustFactor — heavy tail, so a few droplets
        // leave far faster than the rest and genuinely detach instead of the
        // whole field hopping on one identical arc
        const gust = rUp
          .mul(0.45)
          .add(0.55)
          .add(uGust.mul(rUp.pow(8)))
          .toVar();
        const vy = uLaunchSpeed.mul(gust);
        const angle = rYaw.mul(Math.PI * 2);
        const mag = uLaunchSpeed.mul(uLateral).mul(rMag).mul(gust);
        // wind VELOCITY (m/s), not a unit direction: detached spray streams
        // downwind and a gale has to look like one
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
        // w = per-particle size multiplier (CPU mirror: sprayMath.sizeJitter).
        // One size class for the whole crest field is half of what made spray
        // read as a uniform stipple; ≤ 1 by construction, so it can only thin
        // a puff, never inflate a quad (§V28).
        const rSize = hash2(vec2(s.mul(H_SIZE), uTime.add(T_SIZE)));
        pool.velSize
          .element(instanceIndex)
          .assign(vec4(vel, uSizeVar.mul(rSize).oneMinus()));
      });
    });
  })().compute(count);

  return {
    mesh: pool.mesh,
    centerUniform,

    /** run once per fixed sim tick (§V2), after the ocean cascade update;
     *  wind = horizontal wind VELOCITY (m/s), sea = the live spectral moments */
    update(
      renderer: THREE.WebGPURenderer,
      wind: THREE.Vector2,
      /** ocean.heightRms / .jacobianRms / .effectiveChoppiness() (§V36/§V59) */
      moments?: SpraySeaMoments,
    ): void {
      if (
        moments &&
        Number.isFinite(moments.heightRms) &&
        Number.isFinite(moments.jacobianRms) &&
        Number.isFinite(moments.choppiness)
      ) {
        sea = moments;
        seaSupplied = true;
      } else if (!seaSupplied && !warnedNoSea) {
        // fail loud rather than silently gating on bootstrap constants — the
        // exact class of bug §V36 exists to prevent
        warnedNoSea = true;
        console.warn(
          'spray: no sea moments supplied to update() — the crest gates are ' +
            'running on bootstrap σ and will not track weather. Pass ' +
            'ocean.heightRms / .jacobianRms / .effectiveChoppiness().',
        );
      }
      // §V36/§V58: the fold gate is foam's own σ-multiple re-expressed against
      // λ−, so spray and foam agree about where the sea is breaking, and
      // storms spray harder for the reason they foam harder (§V7)
      uEigenGate.value = sprayEigenGate(
        oceanParams.jacobianFoamBias,
        sea.jacobianRms,
        sea.choppiness,
        sprayParams.sprayGateSigma,
      );
      uChoppiness.value = sea.choppiness;
      // §V36: crest gate is a multiple of the sea's height RMS, never metres
      uCrestHeight.value = crestHeightThreshold(
        sprayParams.crestHeightSigma,
        sea.heightRms,
      );
      uChance.value = sprayParams.spawnChance;
      uSpawnLift.value = sprayParams.spawnLift;
      uLaunchSpeed.value = sprayParams.launchSpeed;
      uGust.value = Math.max(0, sprayParams.gustiness);
      uSizeVar.value = Math.min(1, Math.max(0, sprayParams.sizeVariation));
      uLateral.value = sprayParams.lateralSpread;
      uWindCarry.value = sprayParams.windCarry;
      uExtent.value = sprayParams.spawnExtent;
      // NaN wind would be written into velocity buffers at spawn and persist
      // for a full particle lifetime — zero it instead
      (uWind.value as THREE.Vector2).set(
        Number.isFinite(wind.x) ? wind.x : 0,
        Number.isFinite(wind.y) ? wind.y : 0,
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
