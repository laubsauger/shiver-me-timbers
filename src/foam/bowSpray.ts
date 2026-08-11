/**
 * Bow spray emitter (§V6 spray family, §V8 data source): bursts where the
 * hull punches through a wave. Uses its OWN small pool (sprayParams.bowCount)
 * rather than sharing the crest pool: crest spawning is continuous and
 * jacobian-driven while bow bursts are per-ship events — separate pools keep
 * the emitters from starving each other, and a second ship can own its own.
 *
 * CPU side per tick (Rule: code answers — one scalar per emitter, no GPU
 * round-trip): gate = immersionDepth > threshold AND |shipVel.xz| > threshold
 * (sprayMath.burstGate). While gated, a rotating cursor window releases
 * bowBurstRate·dt dead particles per tick (sprayMath.advanceBurstCursor /
 * inSpawnWindow) so burst density is rate-bound, not pool-bound.
 * GPU spawn per windowed dead particle: respawn at the bow waterline with
 * the ship's speed reflected up + outboard (hash-chosen flank) + forwardKeep
 * momentum — the sheet arcs outward/backward relative to the ship
 * (CPU mirror: sprayMath.bowLaunchVelocity). Physics/render: sprayPool.ts.
 *
 *   createBowSpray() => {
 *     update(renderer, bow: { bowWorldPos: Vector3;   // waterline point
 *                             shipVelocity: Vector3;  // world m/s
 *                             immersionDepth: number  // bow submersion (m),
 *                           }): void;                 //   from buoyancy §V8
 *     mesh; dispose();
 *   }
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  float,
  instanceIndex,
  select,
  uniform,
  vec2,
  vec4,
} from 'three/tsl';
import { SIM_DT } from '../core/loop';
import { hash2 } from '../terrain/noise';
import { sprayParams } from '../params/spray';
import { createSprayPool } from './sprayPool';
import {
  H_BOW_MAG,
  H_BOW_SIDE,
  H_BOW_UP,
  PHI,
  T_BOW_MAG,
  T_BOW_SIDE,
  T_BOW_UP,
  advanceBurstCursor,
  burstGate,
} from './sprayMath';

export interface BowState {
  bowWorldPos: THREE.Vector3;
  shipVelocity: THREE.Vector3;
  /** how far the bow waterline point is submerged this frame (m, ≥ 0) */
  immersionDepth: number;
}

export function createBowSpray() {
  const pool = createSprayPool(sprayParams.bowCount); // build-time pool size
  const count = pool.count; // sanitized — sizes the spawn dispatch too

  const uBowPos = uniform(new THREE.Vector3());
  const uShipVel = uniform(new THREE.Vector3());
  const uSpread = uniform(sprayParams.bowLaunchSpread);
  const uForwardKeep = uniform(sprayParams.bowForwardKeep);
  const uCursor = uniform(0);
  const uBudget = uniform(0);
  const uTime = uniform(0);

  const spawnPass = Fn(() => {
    const pa = pool.posAge.element(instanceIndex);
    // rotating window (sprayMath.inSpawnWindow): only budgeted slots respawn
    const rel = float(instanceIndex).sub(uCursor).add(count).mod(count);
    If(pa.w.greaterThanEqual(pool.uLife).and(rel.lessThan(uBudget)), () => {
      const s = float(instanceIndex).add(1).mul(PHI).fract().toVar();
      const speed = uShipVel.xz.length().toVar();
      const forward = uShipVel.xz.div(speed.max(1e-6)).toVar();
      const side = vec2(forward.y.negate(), forward.x);

      // CPU mirror: sprayMath.bowLaunchVelocity
      const rUp = hash2(vec2(s.mul(H_BOW_UP), uTime.add(T_BOW_UP)));
      const rSide = hash2(vec2(s.mul(H_BOW_SIDE), uTime.add(T_BOW_SIDE)));
      const rMag = hash2(vec2(s.mul(H_BOW_MAG), uTime.add(T_BOW_MAG)));
      const sideSign = select(rSide.lessThan(0.5), float(-1), float(1));
      const out = speed.mul(uSpread).mul(rMag).mul(sideSign);
      const velXZ = side.mul(out).add(forward.mul(speed).mul(uForwardKeep));
      const vy = speed.mul(rUp.mul(0.5).add(0.5));

      pool.posAge.element(instanceIndex).assign(vec4(uBowPos.xyz, 0));
      pool.velSeed.element(instanceIndex).assign(vec4(velXZ.x, vy, velXZ.y, s));
    });
  })().compute(count);

  let cursorState = { cursor: 0, acc: 0 };

  return {
    mesh: pool.mesh,

    /** run once per fixed sim tick (§V2); bow state from buoyancy probes */
    update(renderer: THREE.WebGPURenderer, bow: BowState): void {
      uSpread.value = sprayParams.bowLaunchSpread;
      uForwardKeep.value = sprayParams.bowForwardKeep;
      // NaN from a broken buoyancy frame must not reach the spawn buffers —
      // it would persist in pos/vel for a full particle lifetime
      const fin = (v: number) => (Number.isFinite(v) ? v : 0);
      (uBowPos.value as THREE.Vector3).set(
        fin(bow.bowWorldPos.x), fin(bow.bowWorldPos.y), fin(bow.bowWorldPos.z),
      );
      (uShipVel.value as THREE.Vector3).set(
        fin(bow.shipVelocity.x), fin(bow.shipVelocity.y), fin(bow.shipVelocity.z),
      );
      uTime.value += SIM_DT;
      pool.step(renderer); // physics always runs — airborne spray keeps falling

      const speed = Math.hypot(fin(bow.shipVelocity.x), fin(bow.shipVelocity.z));
      if (!burstGate(fin(bow.immersionDepth), speed, sprayParams)) return;
      const next = advanceBurstCursor(
        cursorState,
        sprayParams.bowBurstRate,
        SIM_DT,
        count,
      );
      cursorState = { cursor: next.cursor, acc: next.acc };
      if (next.budget === 0) return;
      uCursor.value = (next.cursor - next.budget + count) % count;
      uBudget.value = next.budget;
      pool.run(renderer, spawnPass);
    },

    dispose(): void {
      pool.dispose();
    },
  };
}

export type BowSpray = ReturnType<typeof createBowSpray>;
