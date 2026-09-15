/**
 * W9 THE HULL'S WHITEWATER AT SPEED (docs/wake/w9-at-speed-disturbance.md). USER (1080p trailer): 'at high speed the
 * hull and engines barely disturb the water'; 'chasing behind a rival, the boats read as floating'. Measured before
 * W9 (cine R1, 25–30 m/s): the only airborne water at a planing hull was the rooster tail's 2.5 cm motion-blur drops
 * (sub-pixel past ~10 m) and the bow whisker drops — no sheet off the chines, nothing at the transom, no contact.
 *
 * ONE POOL, EVERY BOAT, THREE EMITTER KINDS per hull, each a spawn RUN (a segment in the water plane with a lateral
 * half-width that may taper along it) and a launch (outboard ±, up, along the run):
 *
 *   SHEET   the spray-root sheet (`wake/planingContact.sheetEmitter`): from the forward wetted keel point aft along the
 *           Wagner spray root line to the transom, launched outboard/up at the root line's reflection angle
 *   BOIL    the churned water the surface-piercing drives throw up in the transom hollow (`boilEmitter`)
 *   HUMP    the hollow's closure, where the flows from both quarters meet and heap up (`humpEmitter`)
 *
 * Sprites are soft torn CLUMPS (`SprayPoolOptions.clumps`) that grow with age, normal-blended (whitewater OCCLUDES) and
 * lit exactly as the rooster plume (`roosterTail.dropRadianceNode`: HG sun, sky fill, the boat LEDs), killed where
 * they fall back into the water. Priority by camera distance within the pool's turnover (`prioritiseEmitters`), so a
 * pack spends the budget on the boats in shot. §V28: non-finite emitters are dropped whole; uniforms finite-guarded.
 */
import * as THREE from 'three/webgpu';
import { Fn, If, float, instanceIndex, int, select, uniform, uniformArray, varying, vec2, vec4 } from 'three/tsl';
import { SIM_DT } from '../core/loop';
import { hash2 } from '../terrain/noise';
import { dropRadianceNode } from './roosterTail';
import { SPRAY_OVER_WATER_ORDER, createSprayPool } from './sprayPool';
import { PHI, advanceBurstCursor, prioritiseEmitters } from './sprayMath';
import type { SprayViewer } from './roosterTail';

/** emitter slots (8 boats × 3 kinds) — literal shader bound */
export const HULL_SPRAY_SLOTS = 24;

/**
 * W9 LOOK CALIBRATION (stated; browser-tuned against the cine R1 duel at sunset and the R3 night pack): particles per
 * m³/s of each source's physical flux, the pool, sprite sizes (× sprayParams-free absolute metres), life and drag.
 */
export const HULL_SPRAY_LOOK = {
  /** clumps per m³/s of the spray-root sheet flux (`WaterlineSpray.flux`, both sides) */
  sheetDensity: 7000,
  /** clumps per m³/s of the drives' surface air (Σ ventAirSpeed·A) */
  boilDensity: 500,
  /** clumps per m³/s of the hollow's refill flux × its plunge air share */
  humpDensity: 100,
  /** per-kind sprite size multipliers (of sizeDeath) */
  sheetSize: 0.7,
  boilSize: 1,
  humpSize: 0.8,
  /** sprite diameter at death (m); born at 60 % of it (`SprayPoolOptions.clumps`) */
  sizeDeath: 0.65,
  opacity: 1,
  /**
   * the clump's share of the sun (Lambert-ish radiance, like the lane's foam film: a clump is lit on its sun-facing half
   * and self-shadowed on the rest) and of the sky fill — measured (R1 sunset chase): gains 1 drew clumps at sRGB
   * (207, 98, 38) against the sky's (160, 96, 64) and the lace's (134, 88, 59) peak, a glowing orange carpet
   */
  keyGain: 0.6,
  ambientGain: 1.5,
  /** opacity × (1 − age)^ageFalloff: dense at the hull, thinning astern (contrast, not a uniform carpet) */
  ageFalloff: 2.5,
  life: 0.8,
  drag: 1.4,
  pool: 32768,
};

/** one emitter this tick (world frame) — `planingContact` builds them */
export interface HullSprayEmitter {
  /** spawn run origin, world (y on the water) */
  x: number;
  y: number;
  z: number;
  /** unit run axis, world XZ */
  axisX: number;
  axisZ: number;
  /** run length along the axis (m) */
  length: number;
  /** lateral half-width at the origin / at the run's end (m) */
  width0: number;
  width1: number;
  /** 0 = born ON the ±width line (a sheet root), 1 = anywhere across ±width (a boil) */
  fill: number;
  /** launch (m/s): outboard (signed by the side the particle is born on), up, along the axis */
  out: number;
  up: number;
  along: number;
  /** sprite size multiplier (0..1] */
  size: number;
  /** particles per second requested */
  rate: number;
}

export function createHullSprayEmitter(): HullSprayEmitter {
  return { x: 0, y: 0, z: 0, axisX: 0, axisZ: 1, length: 0, width0: 0, width1: 0, fill: 0, out: 0, up: 0, along: 0, size: 1, rate: 0 };
}

/** W9 multiply-scattered share of the key light on a whitewater clump (the rooster's thin plume: 0.5) */
export const HULL_SPRAY_MULTIPLE_SCATTER = 0.85;

const H_EMIT = 733.1;
const T_EMIT = 1.7;

export interface HullSprayOptions {
  slots?: number;
  count?: number;
}

export function createHullSpray(opts: HullSprayOptions = {}) {
  const slots = Math.max(1, Math.min(32, Math.floor(opts.slots ?? HULL_SPRAY_SLOTS)));
  const L = HULL_SPRAY_LOOK;
  let killY = -1e6;
  const uSun = uniform(new THREE.Vector3(0.3, 0.8, 0.5).normalize());
  // whitewater clumps are optically THICK (bubbles + drops, many scatterings): mostly isotropic, a weak forward lobe —
  // unlike the rooster's thin drop plume, which glows backlit
  const uKeyGain = uniform(L.keyGain);
  const uAmbientGain = uniform(L.ambientGain);
  const lit = dropRadianceNode(uSun, { multiple: HULL_SPRAY_MULTIPLE_SCATTER, cap: 2, keyGain: uKeyGain, ambientGain: uAmbientGain });
  const pool = createSprayPool(opts.count ?? L.pool, {
    clumps: true,
    // the clump size law is mix(0.6, 1, age)·sprayParams.sizeMax (0.32 m)·sizeScale
    sizeScale: () => L.sizeDeath / 0.32,
    life: () => L.life,
    drag: () => L.drag,
    opacity: () => L.opacity,
    clumpAgeFalloff: () => L.ageFalloff,
    killBelow: () => killY,
    // a boat-attached effect seen from a chase/tracking camera: visible to ~250 m, gone by 400 m
    fadeNear: () => 250,
    fadeFar: () => 400,
    streak: () => 2.5,
    // per VERTEX (a varying): a clump is a few pixels to a few dozen across and its light (sun lobe, sky, eight LED
    // pools) is smooth over it — per fragment it cost the pack's overdraw × the LED loop
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node
    colorNode: (light) => varying(lit(light) as any),
    blending: THREE.NormalBlending,
    renderOrder: SPRAY_OVER_WATER_ORDER,
  });
  const count = pool.count;
  /** per slot: (x, y, z, CDF upper bound), (axisX, axisZ, length, fill), (width0, width1, size, 0), (out, up, along, 0) */
  const posV = Array.from({ length: slots }, () => new THREE.Vector4(0, -1000, 0, 1));
  const axisV = Array.from({ length: slots }, () => new THREE.Vector4(0, 1, 0, 0));
  const widthV = Array.from({ length: slots }, () => new THREE.Vector4());
  const launchV = Array.from({ length: slots }, () => new THREE.Vector4());
  const uPos = uniformArray(posV);
  const uAxis = uniformArray(axisV);
  const uWidth = uniformArray(widthV);
  const uLaunch = uniformArray(launchV);
  const uCursor = uniform(0);
  const uBudget = uniform(0);
  const uTime = uniform(0);

  const spawnPass = Fn(() => {
    const pa = pool.posAge.element(instanceIndex);
    const rel = float(instanceIndex).sub(uCursor).add(count).mod(count);
    If(pa.w.greaterThanEqual(pool.lifeNode()).and(rel.lessThan(uBudget)), () => {
      // @band-limited-elsewhere: fract of the particle INDEX (a seed), not a spatial coordinate
      const s = float(instanceIndex).add(1).mul(PHI).fract().toVar();
      const r = (salt: number) => hash2(vec2(s.mul(H_EMIT + salt * 17.3), uTime.add(T_EMIT + salt * 3.1)));
      const rEmit = r(0);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node
      let P: any = uPos.element(int(slots - 1));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node
      let A: any = uAxis.element(int(slots - 1));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node
      let W: any = uWidth.element(int(slots - 1));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node
      let V: any = uLaunch.element(int(slots - 1));
      for (let k = slots - 2; k >= 0; k--) {
        const take = rEmit.lessThan(uPos.element(int(k)).w);
        P = select(take, uPos.element(int(k)), P);
        A = select(take, uAxis.element(int(k)), A);
        W = select(take, uWidth.element(int(k)), W);
        V = select(take, uLaunch.element(int(k)), V);
      }
      const axis = vec2(A.x, A.y).toVar();
      const side = vec2(axis.y.negate(), axis.x).toVar();
      const rAlong = r(1);
      const rSide = r(2);
      const rFill = r(3);
      const rUp = r(4);
      const rMag = r(5);
      const rJit = r(6);
      const rSize = r(7);
      const sign = select(rSide.lessThan(0.5), float(-1), float(1));
      const halfW = W.x.add(W.y.sub(W.x).mul(rAlong));
      // on the line (fill 0) or anywhere across it (fill 1); ±5 cm of jitter so a root line is not a ruled edge
      const lateral = sign.mul(halfW.mul(float(1).sub(A.w.mul(float(1).sub(rFill))))).add(rJit.sub(0.5).mul(0.1));
      const xz = vec2(P.x, P.z).add(axis.mul(A.z.mul(rAlong))).add(side.mul(lateral));
      pool.posAge.element(instanceIndex).assign(vec4(xz.x, P.y, xz.y, 0));
      // outboard in proportion to where across the run it was born (a sheet root: ±1; a boil: a self-similar fan that
      // stays filled at its centre instead of emptying into two lanes)
      const across = lateral.div(halfW.max(0.05)).clamp(-1, 1);
      const velXZ = side.mul(across.mul(V.x).mul(rMag.mul(0.45).add(0.55))).add(axis.mul(V.z.mul(rMag.mul(0.5).add(0.5))));
      const vy = V.y.mul(rUp.mul(0.55).add(0.45));
      // size multiplier: the emitter's, jittered (the pool grows each sprite over its life, HULL_SPRAY_LOOK sizes)
      pool.velSize.element(instanceIndex).assign(vec4(velXZ.x, vy, velXZ.y, W.z.mul(rSize.mul(0.5).add(0.5))));
    });
  })().compute(count);

  let cursorState = { cursor: 0, acc: 0 };
  const rates: number[] = [];
  const dists: number[] = [];
  const pick: number[] = [];
  const grant: number[] = [];
  const fin = (v: number): boolean => Number.isFinite(v);

  return {
    mesh: pool.mesh,
    pool,
    slots,
    count,
    /** the last tick's granted (emitter index, rate) pairs, priority order (tests / debug) */
    granted: { index: pick, rate: grant },
    setSun(x: number, y: number, z: number): void {
      const l = Math.hypot(x, y, z);
      if (Number.isFinite(l) && l > 1e-6) uSun.value.set(x / l, y / l, z / l);
    },
    /** FIXED TICK: every boat's emitters (any order) and the viewer; returns the granted particles/s */
    update(renderer: THREE.WebGPURenderer, emitters: readonly HullSprayEmitter[], viewer: SprayViewer): number {
      uTime.value += SIM_DT;
      uKeyGain.value = L.keyGain;
      uAmbientGain.value = L.ambientGain;
      rates.length = 0;
      dists.length = 0;
      for (const e of emitters) {
        const ok = [e.x, e.y, e.z, e.axisX, e.axisZ, e.length, e.width0, e.width1, e.fill, e.out, e.up, e.along, e.size, e.rate].every(fin) && e.rate > 0;
        rates.push(ok ? e.rate : 0);
        dists.push(ok ? Math.hypot(e.x - viewer.x, e.y - viewer.y, e.z - viewer.z) : Infinity);
      }
      prioritiseEmitters(rates, dists, slots, count / Math.max(1e-3, L.life), pick, grant);
      let total = 0;
      let ySum = 0;
      for (let k = 0; k < slots; k++) {
        if (k >= pick.length) {
          posV[k].set(0, -1000, 0, 1);
          axisV[k].set(0, 1, 0, 0);
          widthV[k].set(0, 0, 0, 0);
          launchV[k].set(0, 0, 0, 0);
          continue;
        }
        const e = emitters[pick[k]];
        const len = Math.hypot(e.axisX, e.axisZ) || 1;
        posV[k].set(e.x, e.y, e.z, 0);
        axisV[k].set(e.axisX / len, e.axisZ / len, Math.max(0, e.length), Math.min(1, Math.max(0, e.fill)));
        widthV[k].set(Math.max(0, e.width0), Math.max(0, e.width1), Math.min(1, Math.max(0, e.size)), 0);
        launchV[k].set(e.out, e.up, e.along, 0);
        total += grant[k];
        ySum += e.y;
      }
      let acc = 0;
      for (let k = 0; k < slots; k++) {
        if (k < pick.length) acc += grant[k];
        posV[k].w = total > 0 ? (k >= pick.length - 1 ? 1 : acc / total) : 1;
      }
      // W8 round 4 rule: a falling clump dies at the water (the emitters' mean surface, 5 cm below)
      if (pick.length > 0) killY = ySum / pick.length - 0.05;
      // @band-limited-elsewhere: a pool method named step, not a shader edge
      pool.step(renderer);
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

export type HullSpray = ReturnType<typeof createHullSpray>;
