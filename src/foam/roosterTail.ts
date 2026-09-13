/**
 * ROOSTER TAIL — spray thrown by a SURFACE-PIERCING prop (§T.180 c, docs/wake/w5b.md §3).
 *
 * THE INPUT is the drive's own `PropWashInput` (src/wake/propWash.ts), the same
 * record the sim source and the foam ribbon read (§V101: one drive result, many
 * consumers). THE MODEL, per prop, from quantities the drive already has:
 *
 *   exposure  e = 4·imm·(1 − imm)          the blade arc crossing the surface —
 *                                           0 fully submerged (a buried prop
 *                                           throws a boil, not spray) and 0
 *                                           clear of the water, 1 half-in
 *   jet       ΔV = √(U_a² + 2T/ρA) − U_a    actuator-disc excess (`jetExcessSpeed`)
 *   flux      q = e·ΔV·A                     water the exposed arc carries through
 *                                           the surface (m³/s)
 *   rate      bowLiftRate·q                  particles per m³/s — the SAME density
 *                                           the bow sheet uses, no new knob
 *   launch    along the jet at ΔV·(0.6..1), UP at ΔV·(0.5..1), fanned ±ΔV·bowLaunchSpread
 *
 * In the world frame the water leaves the prop at ≈ ΔV (the boat takes U_a away
 * with her), so the plume stands behind the boat as she runs off — the rooster
 * tail's shape — and its apex is ≤ ΔV²/2g, the jet's own head (Bernoulli, not a
 * look number). Consequence, stated: with the stand-in thrust curve a planing
 * boat at 40 m/s has ΔV ≈ 0.9 m/s (a 4 cm skirt) and one at 15 m/s ≈ 5.5 m/s (a
 * 1.5 m tail) — momentum theory puts the tall tail at mid speeds with slip.
 *
 * GPU: one `sprayPool` (the bow's sprite, sizes and drag), a spawn pass picking a
 * jet per particle from a CDF over up to MAX_PROP_JETS uniform slots. Lifetime
 * is stretched to the tallest arc's flight time so the plume can come down.
 * §V28: non-finite jets are dropped whole; every uniform finite-guarded; dead
 * particles are the pool's zero-size quads.
 *
 * NOT WIRED to a page: no sea page carries the speedboat yet. The hook, where one
 * does: each tick after `HullWater.evaluate`, `propWashFromHullWater(hw, state, jets)` (src/wake/propWashHullWater.ts),
 * then `roosterTail.update(renderer, jets, boatVelocity)` in the render step.
 */
import * as THREE from 'three/webgpu';
import { Fn, If, float, instanceIndex, int, select, uniform, uniformArray, vec2, vec3, vec4 } from 'three/tsl';
import { SIM_DT } from '../core/loop';
import { GRAVITY } from '../ocean/oceanMath';
import { sprayParams, type SprayParams } from '../params/spray';
import { hash2 } from '../terrain/noise';
import { jetExcessSpeed, propWashValid, type PropWashInput } from '../wake/propWash';
import { createSprayPool } from './sprayPool';
import { H_BOW_MAG, H_BOW_SIDE, H_BOW_UP, H_SIZE, PHI, T_BOW_MAG, T_BOW_SIDE, T_BOW_UP, T_SIZE, advanceBurstCursor } from './sprayMath';

/** props one rooster-tail emitter carries (the speedboat has 3) — literal shader bound */
export const ROOSTER_MAX_JETS = 4;
/** hash salt picking the jet a particle leaves */
const H_JET = 377.3;
const T_JET = 5.9;

export interface RoosterJetEmission {
  /** particles per second */
  rate: number;
  /** jet excess speed ΔV (m/s) — the launch speed scale */
  launch: number;
  /** blade-arc exposure 4·imm·(1 − imm) */
  exposure: number;
  /** thrown flux e·ΔV·A (m³/s) */
  flux: number;
}

/** one prop's rooster tail (header). §V28: anything non-finite throws nothing. */
export function roosterTailEmission(j: PropWashInput, p: Pick<SprayParams, 'bowLiftRate'>): RoosterJetEmission {
  const none = { rate: 0, launch: 0, exposure: 0, flux: 0 };
  if (!propWashValid(j) || !Number.isFinite(p.bowLiftRate)) return none;
  const imm = Math.min(1, Math.max(0, j.immersion));
  const exposure = 4 * imm * (1 - imm);
  const launch = jetExcessSpeed(j.advance, j.thrust, j.discArea);
  const flux = exposure * launch * j.discArea;
  if (!(flux > 0)) return { ...none, exposure, launch };
  return { rate: Math.max(0, p.bowLiftRate) * flux, launch, exposure, flux };
}

/** apex (m) of the tallest particle a launch speed can throw — ΔV²/2g */
export function roosterApex(launch: number): number {
  return Number.isFinite(launch) && launch > 0 ? (launch * launch) / (2 * GRAVITY) : 0;
}

export function createRoosterTail() {
  let life = sprayParams.bowLife;
  const pool = createSprayPool(sprayParams.bowCount, {
    sizeScale: () => sprayParams.bowSizeScale,
    life: () => life,
    drag: () => sprayParams.bowDrag,
    fadeNear: () => sprayParams.bowContactFadeNear,
    fadeFar: () => sprayParams.bowContactFadeFar,
  });
  const count = pool.count;
  /** per jet: (x, surfaceY, z, ΔV) and (dirX, dirZ, CDF upper bound, 0) */
  const jetPos = Array.from({ length: ROOSTER_MAX_JETS }, () => new THREE.Vector4());
  const jetDir = Array.from({ length: ROOSTER_MAX_JETS }, () => new THREE.Vector4(0, 1, 0, 0));
  const uJetPos = uniformArray(jetPos);
  const uJetDir = uniformArray(jetDir);
  const uSpread = uniform(sprayParams.bowLaunchSpread);
  const uSizeVar = uniform(sprayParams.sizeVariation);
  const uCursor = uniform(0);
  const uBudget = uniform(0);
  const uTime = uniform(0);

  const spawnPass = Fn(() => {
    const pa = pool.posAge.element(instanceIndex);
    const rel = float(instanceIndex).sub(uCursor).add(count).mod(count);
    If(pa.w.greaterThanEqual(pool.lifeNode()).and(rel.lessThan(uBudget)), () => {
      // @band-limited-elsewhere: fract of the particle INDEX (a seed), not a spatial coordinate
      const s = float(instanceIndex).add(1).mul(PHI).fract().toVar();
      const rJet = hash2(vec2(s.mul(H_JET), uTime.add(T_JET)));
      const rUp = hash2(vec2(s.mul(H_BOW_UP), uTime.add(T_BOW_UP)));
      const rSide = hash2(vec2(s.mul(H_BOW_SIDE), uTime.add(T_BOW_SIDE)));
      const rMag = hash2(vec2(s.mul(H_BOW_MAG), uTime.add(T_BOW_MAG)));
      // pick the jet whose CDF interval holds rJet (slots past the live ones have CDF 1 and never win first)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node
      let pos: any = uJetPos.element(int(ROOSTER_MAX_JETS - 1));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node
      let dir: any = uJetDir.element(int(ROOSTER_MAX_JETS - 1));
      for (let j = ROOSTER_MAX_JETS - 2; j >= 0; j--) {
        const take = rJet.lessThan(uJetDir.element(int(j)).z);
        pos = select(take, uJetPos.element(int(j)), pos);
        dir = select(take, uJetDir.element(int(j)), dir);
      }
      const aft = vec2(dir.x, dir.y).toVar();
      const side = vec2(aft.y.negate(), aft.x);
      const sideSign = select(rSide.lessThan(0.5), float(-1), float(1));
      const dv = pos.w;
      const velXZ = aft.mul(dv.mul(rMag.mul(0.4).add(0.6))).add(side.mul(dv.mul(uSpread).mul(rMag).mul(sideSign).mul(0.3)));
      const vy = dv.mul(rUp.mul(0.5).add(0.5));
      pool.posAge.element(instanceIndex).assign(vec4(vec3(pos.x, pos.y, pos.z), 0));
      const rSize = hash2(vec2(s.mul(H_SIZE), uTime.add(T_SIZE)));
      pool.velSize.element(instanceIndex).assign(vec4(velXZ.x, vy, velXZ.y, uSizeVar.mul(rSize).oneMinus()));
    });
  })().compute(count);

  let cursorState = { cursor: 0, acc: 0 };

  return {
    mesh: pool.mesh,
    /**
     * One fixed tick (§V2): this tick's props. Returns the total particle rate
     * (particles/s) it budgeted — 0 when no prop is surface-piercing.
     */
    update(renderer: THREE.WebGPURenderer, jets: readonly PropWashInput[]): number {
      uSpread.value = Number.isFinite(sprayParams.bowLaunchSpread) ? Math.max(0, sprayParams.bowLaunchSpread) : 0;
      uSizeVar.value = Math.min(1, Math.max(0, Number.isFinite(sprayParams.sizeVariation) ? sprayParams.sizeVariation : 0));
      uTime.value += SIM_DT;
      let total = 0;
      let maxLaunch = 0;
      const rates: number[] = [];
      for (let j = 0; j < ROOSTER_MAX_JETS; j++) {
        const jet = jets[j];
        const e = jet ? roosterTailEmission(jet, sprayParams) : null;
        const y = jet && Number.isFinite(jet.surfaceY) ? (jet.surfaceY as number) : NaN;
        const ok = !!e && e.rate > 0 && Number.isFinite(y);
        rates.push(ok ? e!.rate : 0);
        if (ok) {
          total += e!.rate;
          maxLaunch = Math.max(maxLaunch, e!.launch);
          const len = Math.hypot(jet!.dirX, jet!.dirZ);
          jetPos[j].set(jet!.x, y, jet!.z, e!.launch);
          jetDir[j].set(jet!.dirX / len, jet!.dirZ / len, 0, 0);
        } else {
          jetPos[j].set(0, -1000, 0, 0);
          jetDir[j].set(0, 1, 0, 0);
        }
      }
      // the particle's jet CDF, and a lifetime long enough for the tallest arc to fall back
      let acc = 0;
      for (let j = 0; j < ROOSTER_MAX_JETS; j++) {
        acc += rates[j];
        jetDir[j].z = total > 0 ? (j === ROOSTER_MAX_JETS - 1 ? 1 : acc / total) : 1;
      }
      life = Math.max(sprayParams.bowLife, (2 * maxLaunch) / GRAVITY);
      // @band-limited-elsewhere: a pool method named step, not a shader edge
      pool.step(renderer); // physics always runs — airborne spray keeps falling
      if (!(total > 0)) return 0;
      const next = advanceBurstCursor(cursorState, total, SIM_DT, count);
      cursorState = { cursor: next.cursor, acc: next.acc };
      if (next.budget === 0) return total;
      uCursor.value = (next.cursor - next.budget + count) % count;
      uBudget.value = next.budget;
      pool.run(renderer, spawnPass);
      return total;
    },
    dispose(): void {
      pool.dispose();
    },
  };
}

export type RoosterTail = ReturnType<typeof createRoosterTail>;
