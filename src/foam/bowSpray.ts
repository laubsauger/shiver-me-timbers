/**
 * Bow spray emitter (§V6 spray family, §V8 data source): bursts where the
 * hull punches through a wave. Uses its OWN small pool (sprayParams.bowCount)
 * rather than sharing the crest pool: crest spawning is continuous and
 * jacobian-driven while bow bursts are per-ship events — separate pools keep
 * the emitters from starving each other, and a second ship can own its own.
 *
 * CPU side per tick (Rule: code answers — two scalars per emitter, no GPU
 * round-trip): sprayMath.bowEmission returns {rate, sheet} from speed,
 * immersion and the BURIAL RATE (d immersion/dt, tracked here). Two regimes
 * on one path — a constant cutwater mist whenever the ship is making way, and
 * an impact burst on top scaled by how hard the stem just buried. A rotating
 * cursor window releases rate·dt dead particles per tick (advanceBurstCursor /
 * inSpawnWindow) so density is rate-bound, not pool-bound.
 * GPU spawn per windowed dead particle: respawn ON THE WATERLINE along the
 * cutwater line (bowSpawnOffset — stem run + outboard flank, not one point),
 * thrown FORWARD past the bow (bowForwardThrow × speed), outboard on that
 * same flank, and up by rise × sheet (CPU mirror: sprayMath.bowLaunchVelocity).
 * `sheet` also rides in velSize.w as the per-particle size multiplier.
 * Physics/render: sprayPool.ts.
 *
 *   createBowSpray() => {
 *     update(renderer, bow: { bowWorldPos: Vector3;   // stem point on the hull
 *                             shipVelocity: Vector3;  // world m/s
 *                             immersionDepth: number; // bow submersion (m),
 *                                                     //   from buoyancy §V8
 *                             shipForward?: Vector3;  // unit heading, OPTIONAL
 *                           }): void;                 //   (falls back to vel)
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
  vec3,
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
  bowEmission,
} from './sprayMath';

export interface BowState {
  bowWorldPos: THREE.Vector3;
  shipVelocity: THREE.Vector3;
  /** how far the bow waterline point is submerged this frame (m, ≥ 0) */
  immersionDepth: number;
  /**
   * Unit heading of the hull in world XZ (optional). PREFERRED over the
   * velocity direction: a ship making leeway crabs, and basing the ejection
   * frame on its track then throws spray off at an angle to its own stem
   * (user: "flows in a little bit of a weird angle"). Falls back to the
   * normalised velocity when the caller does not supply it.
   */
  shipForward?: THREE.Vector3;
}

export function createBowSpray() {
  // bow sheets are coarser than crest mist — same pool code, bigger sprites
  const pool = createSprayPool(sprayParams.bowCount, {
    sizeScale: sprayParams.bowSizeScale,
  });
  const count = pool.count; // sanitized — sizes the spawn dispatch too

  const uBowPos = uniform(new THREE.Vector3()); // waterline point at the stem
  const uSpeed = uniform(0); // hull speed over ground (m/s)
  const uForward = uniform(new THREE.Vector2(0, 1)); // unit heading, XZ
  const uSpread = uniform(sprayParams.bowLaunchSpread);
  const uForwardThrow = uniform(sprayParams.bowForwardThrow);
  const uRise = uniform(sprayParams.bowRise);
  const uSideOffset = uniform(sprayParams.bowSideOffset);
  const uStemLength = uniform(sprayParams.bowStemLength);
  /** 0..1 how much of a full sheet this tick throws (size + rise) */
  const uSheet = uniform(0);
  const uCursor = uniform(0);
  const uBudget = uniform(0);
  const uTime = uniform(0);

  const spawnPass = Fn(() => {
    const pa = pool.posAge.element(instanceIndex);
    // rotating window (sprayMath.inSpawnWindow): only budgeted slots respawn
    const rel = float(instanceIndex).sub(uCursor).add(count).mod(count);
    If(pa.w.greaterThanEqual(pool.uLife).and(rel.lessThan(uBudget)), () => {
      const s = float(instanceIndex).add(1).mul(PHI).fract().toVar();
      // ejection basis = the HULL's frame (heading + its perpendicular), not
      // a world axis and not the ship's track — see BowState.shipForward
      const forward = uForward.toVar();
      const side = vec2(forward.y.negate(), forward.x).toVar();

      const rUp = hash2(vec2(s.mul(H_BOW_UP), uTime.add(T_BOW_UP)));
      const rSide = hash2(vec2(s.mul(H_BOW_SIDE), uTime.add(T_BOW_SIDE)));
      const rMag = hash2(vec2(s.mul(H_BOW_MAG), uTime.add(T_BOW_MAG)));
      const sideSign = select(rSide.lessThan(0.5), float(-1), float(1));

      // CPU mirror: sprayMath.bowSpawnOffset — seed along the cutwater LINE
      // (stem run ahead of the bow point + outboard flank), not one point
      const lateral = uSideOffset
        .mul(rSide.mul(2).sub(1).abs().mul(0.65).add(0.35))
        .mul(sideSign);
      const stem = uStemLength.mul(rMag);
      const offXZ = side.mul(lateral).add(forward.mul(stem));

      // CPU mirror: sprayMath.bowLaunchVelocity — shoved FORWARD past the bow
      // (throw > 1 outruns the hull) and OUTBOARD on the flank it was seeded
      // on, fanning away from the centreline. Horizontal throw follows ship
      // speed alone; only the RISE scales with the sheet, so a cruising stem
      // throws water flat and forward while a burial launches it high.
      const out = uSpeed.mul(uSpread).mul(rMag).mul(sideSign);
      const fwd = uSpeed.mul(uForwardThrow).mul(rMag.mul(0.4).add(0.6));
      const velXZ = side.mul(out).add(forward.mul(fwd));
      const vy = uSpeed.mul(uRise).mul(rUp.mul(0.5).add(0.5)).mul(uSheet);

      const pos = uBowPos.add(vec3(offXZ.x, 0, offXZ.y));
      pool.posAge.element(instanceIndex).assign(vec4(pos, 0));
      // w = per-particle size multiplier: this tick's sheet fraction
      pool.velSize.element(instanceIndex).assign(vec4(velXZ.x, vy, velXZ.y, uSheet));
    });
  })().compute(count);

  let cursorState = { cursor: 0, acc: 0 };
  let prevImmersion: number | null = null;

  return {
    mesh: pool.mesh,

    /** run once per fixed sim tick (§V2); bow state from buoyancy probes */
    update(renderer: THREE.WebGPURenderer, bow: BowState): void {
      uSpread.value = sprayParams.bowLaunchSpread;
      uForwardThrow.value = sprayParams.bowForwardThrow;
      uRise.value = sprayParams.bowRise;
      uSideOffset.value = sprayParams.bowSideOffset;
      uStemLength.value = sprayParams.bowStemLength;
      // NaN from a broken buoyancy frame must not reach the spawn buffers —
      // it would persist in pos/vel for a full particle lifetime
      const fin = (v: number) => (Number.isFinite(v) ? v : 0);
      const immersion = Math.max(0, fin(bow.immersionDepth));
      // the caller's bow point sits on the HULL, and immersion is how far the
      // water surface is above it — spray must leave the WATERLINE or it
      // fountains out of the planking / fires from mid-air (user: "the
      // piercing effect is disconnected from the bow"). The extra lift keeps
      // the sprite out of the surface's depth buffer: the ocean writes depth
      // now, so a sheet born coplanar with the water is depth-rejected.
      (uBowPos.value as THREE.Vector3).set(
        fin(bow.bowWorldPos.x),
        fin(bow.bowWorldPos.y) + immersion + Math.max(0, sprayParams.bowSpawnLift),
        fin(bow.bowWorldPos.z),
      );
      uTime.value += SIM_DT;
      pool.step(renderer); // physics always runs — airborne spray keeps falling

      const velX = fin(bow.shipVelocity.x);
      const velZ = fin(bow.shipVelocity.z);
      const speed = Math.hypot(velX, velZ);
      uSpeed.value = speed;
      // heading if the caller has one, else the track; both floored so a
      // dead-in-the-water frame can't normalise a zero vector (§V28)
      const fwd = bow.shipForward;
      const hx = fwd && Number.isFinite(fwd.x) ? fwd.x : velX;
      const hz = fwd && Number.isFinite(fwd.z) ? fwd.z : velZ;
      const hLen = Math.hypot(hx, hz);
      if (hLen > 1e-6) {
        (uForward.value as THREE.Vector2).set(hx / hLen, hz / hLen);
      }

      // burial rate = how fast the stem is diving INTO the water this tick.
      // It is what separates "shouldering water aside at cruise" from
      // "slamming a swell", and it is derivable here — no new main-thread
      // signal needed. First frame has no history → no impact.
      const burialRate =
        prevImmersion === null ? 0 : Math.max(0, (immersion - prevImmersion) / SIM_DT);
      prevImmersion = immersion;

      const { rate, sheet } = bowEmission(immersion, speed, burialRate, sprayParams);
      if (rate <= 0) return;
      uSheet.value = sheet;
      const next = advanceBurstCursor(cursorState, rate, SIM_DT, count);
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
