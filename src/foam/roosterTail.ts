/**
 * ROOSTER TAIL — spray thrown by a SURFACE-PIERCING prop (§T.180 c, docs/wake/w5b.md §3; §T.199,
 * docs/wake/w7-speedboat-look.md §1).
 *
 * THE INPUT is the drive's own `PropWashInput` (src/wake/propWash.ts), the same record the sim source and the foam
 * ribbon read (§V101: one drive result, many consumers).
 *
 * §T.199 THE MODEL. USER: 'rooster tails are still pretty weak if visible at all.' Measured: the §T.180 emitter
 * launched at the actuator-disc excess ΔV — 0.9 m/s at race speed, a 4 cm skirt (the pool's tallest particle stood
 * 0.12 m above the water, 0.88 m with every prop forced half-in). ΔV is the jet's AXIAL excess, which is not what
 * throws a rooster tail. A surface-piercing blade leaves the water carrying a film at its own section speed, and at
 * the waterline crossing that speed points UP out of the disc:
 *
 *   exposure  e = 4·imm·(1 − imm)          the blade arc crossing the surface (0 buried, 0 clear, 1 half-in)
 *   tip       V_t = 2π·|n|·R                blade tip speed (n rev/s — `propRps`, or `propRpsEstimate`)
 *   sheet     V_s = ROOSTER_SHEET_FRACTION·V_t   the shed film's speed (≤ V_t: nothing leaves faster than the blade)
 *   launch    UP  V_s·√e·(0.55..1)          at the crossing the section velocity is vertical by c/R = √(1 − (d/R)²),
 *                                           which 4·imm(1 − imm) tracks (both 1 half-in, 0 at either end) — √e stated
 *             OUT ±V_s·√(1 − e)·0.5         the horizontal part of the same section velocity
 *             AFT ΔV·(0.6..1)               the slipstream's own excess, so the plume is left behind as she runs off
 *   flux      q = e·V_s·A                   the arc's swept flux through the surface (m³/s)
 *   rate      bowLiftRate·q                 particles per m³/s — the SAME density the bow sheet uses, no new knob
 *
 * TWO POOLS, ONE EMITTER. The sheet breaks up (Rayleigh–Plateau / aerodynamic breakup) into DROPS — mm-size, air drag
 * k = 3C_d·ρ_a·v/(8ρ_w·r) ≈ 1.2/s at r 2 mm, v 10 m/s, C_d 0.5 — and MIST — 0.3 mm, k ≈ 4/s in still air, taken as 2.5/s in the plume's co-moving
 * air (stated), thrown a little slower off the same sheet and hanging longer. Drops arc to their ballistic apex (with drag) behind the transom; mist blooms
 * round and above them. Both OCCLUDE (normal blend: a dense plume in front of a bright sky must darken/whiten what is
 * behind it, additive white cannot) and are lit as water drops are: Henyey–Greenstein forward scattering (g 0.6 for
 * mm drops, Mie regime) brightens a plume seen AGAINST the sun — backlit — and leaves it grey-white seen down-sun.
 * Both draw after the ocean (`SPRAY_OVER_WATER_ORDER`, sprayPool.ts: before T199 the sea painted over them).
 *
 * LOOK CALIBRATION, STATED: ROOSTER_SHEET_FRACTION 0.22 puts the tallest drops of a half-in prop at 60 rps (0.2 m
 * radius, V_t 75 m/s) ≈ 5 m up, the plume's body at 2–4 m, peaking ~1 s (≈ 25–35 m) astern at race speed — the
 * reference is offshore-racing footage (USER: 'a tall, dense, backlit plume … peaking several metres behind and above
 * the transom'), not a measured sheet speed. The pool sizes, sprite scales and opacities are look numbers too.
 *
 * GPU: two `sprayPool`s (`count` each; the fleet uses 4096), a spawn pass each picking a jet per particle from a CDF over MAX_JETS
 * uniform slots. Lifetime is stretched to the tallest arc's flight time so the plume comes back down.
 * §V28: non-finite jets are dropped whole; every uniform finite-guarded; dead particles are the pool's zero-size quads.
 */
import * as THREE from 'three/webgpu';
import { Fn, If, cameraPosition, float, instanceIndex, int, positionWorld, select, uniform, uniformArray, vec2, vec3, vec4 } from 'three/tsl';
import { SIM_DT } from '../core/loop';
import { GRAVITY } from '../ocean/oceanMath';
import { sprayParams, type SprayParams } from '../params/spray';
import { hash2 } from '../terrain/noise';
import { aerationSpeed, jetExcessSpeed, propRpsEstimate, propWashValid, type PropWashInput } from '../wake/propWash';
import { foamTintNode } from './foamShading';
import { SPRAY_OVER_WATER_ORDER, SPRAY_UNDER_WATER_ORDER, createSprayPool, type SprayPool } from './sprayPool';
import { H_BOW_MAG, H_BOW_SIDE, H_BOW_UP, H_SIZE, PHI, T_BOW_MAG, T_BOW_SIDE, T_BOW_UP, T_SIZE, advanceBurstCursor, prioritiseEmitters } from './sprayMath';

/** props one rooster-tail emitter carries (the speedboat has 3) — literal shader bound */
export const ROOSTER_MAX_JETS = 4;
/** hash salt picking the jet a particle leaves */
const H_JET = 377.3;
const T_JET = 5.9;
const H_MIST = 519.1;
const T_MIST = 3.7;

/** §T.199 shed-sheet speed as a fraction of the blade tip speed — LOOK CALIBRATION (header), physical bound ≤ 1 */
export const ROOSTER_SHEET_FRACTION = 0.22;
/** §T.199 linearised air drag (1/s) of the sheet's drops (r ≈ 2 mm) and its mist (r ≈ 0.3 mm) — header */
export const ROOSTER_DROP_DRAG = 1.2;
export const ROOSTER_MIST_DRAG = 2.5;
/** §T.199 mist leaves at this share of the drops' launch — torn off the same sheet, carried in its air wake */
export const ROOSTER_MIST_SPEED = 0.8;
/** §T.199 Henyey–Greenstein asymmetry of mm water drops (forward-scattering Mie regime) */
export const ROOSTER_PHASE_G = 0.6;
/** §T.199 plume brightness = AMBIENT + GAIN·min(4π·HG, CAP) — look numbers: down-sun ≈ 0.65, backlit ≈ 1.55 */
export const ROOSTER_AMBIENT = 0.6;
export const ROOSTER_SUN_GAIN = 0.12;
export const ROOSTER_PHASE_CAP = 8;

export interface RoosterJetEmission {
  /** particles per second */
  rate: number;
  /** UP launch speed scale (m/s): V_s·√e — `roosterApex` of it is the drag-free apex */
  launch: number;
  /** AFT launch (m/s): the slipstream excess ΔV */
  aft: number;
  /** OUTBOARD launch scale (m/s): V_s·√(1 − e)·0.5 */
  lateral: number;
  /** blade-arc exposure 4·imm·(1 − imm) */
  exposure: number;
  /** blade tip speed V_t (m/s) */
  tip: number;
  /** thrown flux e·V_s·A (m³/s) */
  flux: number;
}

/**
 * One prop's rooster tail (header). `pitch` (m) is only read when the jet publishes no `propRps`
 * (`propRpsEstimate`). §V28: anything non-finite throws nothing.
 */
export function roosterTailEmission(j: PropWashInput, p: Pick<SprayParams, 'bowLiftRate'>, pitch = Number.NaN): RoosterJetEmission {
  const none = { rate: 0, launch: 0, aft: 0, lateral: 0, exposure: 0, tip: 0, flux: 0 };
  if (!propWashValid(j) || !Number.isFinite(p.bowLiftRate)) return none;
  const imm = Math.min(1, Math.max(0, j.immersion));
  const exposure = 4 * imm * (1 - imm);
  const aft = jetExcessSpeed(j.advance, j.thrust, j.discArea);
  const n = j.propRps !== undefined && Number.isFinite(j.propRps) ? Math.abs(j.propRps) : propRpsEstimate(j, pitch);
  const R = Math.sqrt(j.discArea / Math.PI);
  const tip = 2 * Math.PI * n * R;
  const sheet = ROOSTER_SHEET_FRACTION * tip;
  const launch = sheet * Math.sqrt(exposure);
  const lateral = 0.5 * sheet * Math.sqrt(Math.max(0, 1 - exposure));
  const flux = exposure * sheet * j.discArea;
  if (!(flux > 0) || !Number.isFinite(flux)) return { ...none, exposure, tip: Number.isFinite(tip) ? tip : 0, aft };
  return { rate: Math.max(0, p.bowLiftRate) * flux, launch, aft, lateral, exposure, tip, flux };
}

/** apex (m) of the tallest particle a launch speed can throw without drag — V²/2g */
export function roosterApex(launch: number): number {
  return Number.isFinite(launch) && launch > 0 ? (launch * launch) / (2 * GRAVITY) : 0;
}

/**
 * §T.199 apex (m) of a particle launched straight up at `v` against linear drag `k` (1/s):
 * h = v/k − (g/k²)·ln(1 + k·v/g) — the drag-free V²/2g as k → 0.
 */
export function roosterApexWithDrag(v: number, k: number): number {
  if (!Number.isFinite(v) || !(v > 0)) return 0;
  if (!Number.isFinite(k) || !(k > 1e-6)) return roosterApex(v);
  return v / k - (GRAVITY / (k * k)) * Math.log1p((k * v) / GRAVITY);
}

/** §T.199 flight time (s) up and back down to the launch height with linear drag k — bisected, ≤ 2v/g */
export function roosterFlightTime(v: number, k: number): number {
  if (!Number.isFinite(v) || !(v > 0)) return 0;
  const vt = GRAVITY / Math.max(1e-6, k);
  // y(t) = (v + vt)/k·(1 − e^{−kt}) − vt·t
  const y = (t: number): number => ((v + vt) / Math.max(1e-6, k)) * (1 - Math.exp(-k * t)) - vt * t;
  let lo = (v / GRAVITY) * 0.5;
  let hi = (2 * v) / GRAVITY;
  if (!(k > 1e-6)) return hi;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (y(mid) > 0) lo = mid;
    else hi = mid;
  }
  return hi;
}

export interface RoosterTailOptions {
  /** jet slots (default ROOSTER_MAX_JETS; §T.195 the fleet wants 8 boats × 3 drives) — literal shader bound */
  maxJets?: number;
  /** drop pool (default sprayParams.bowCount); the mist pool is the same size */
  count?: number;
}

/** the viewer, for the §T.195 budget priority (visual only) */
export interface SprayViewer {
  x: number;
  y: number;
  z: number;
}

export function createRoosterTail(opts: RoosterTailOptions = {}) {
  const MAX_JETS = Math.max(1, Math.min(64, Math.floor(opts.maxJets ?? ROOSTER_MAX_JETS)));
  let dropLife = sprayParams.bowLife;
  let mistLife = sprayParams.bowLife;
  const uSun = uniform(new THREE.Vector3(0.3, 0.8, 0.5).normalize());
  /** HG forward scattering (header) — the sprite's own world position against the camera */
  const litTint = (): unknown => {
    const view = positionWorld.sub(cameraPosition).normalize();
    const c = view.dot(uSun).clamp(-1, 1);
    const g = ROOSTER_PHASE_G;
    const hg = float(1 - g * g).div(float(1 + g * g).sub(c.mul(2 * g)).max(1e-3).pow(1.5));
    return foamTintNode().mul(hg.min(ROOSTER_PHASE_CAP).mul(ROOSTER_SUN_GAIN).add(ROOSTER_AMBIENT));
  };
  const drops = createSprayPool(opts.count ?? sprayParams.bowCount, {
    sizeScale: () => 4,
    life: () => dropLife,
    drag: () => ROOSTER_DROP_DRAG,
    opacity: () => 0.7,
    fadeNear: () => sprayParams.bowContactFadeNear * 2,
    fadeFar: () => sprayParams.bowContactFadeFar * 2.5,
    colorNode: litTint,
    blending: THREE.NormalBlending,
    renderOrder: SPRAY_OVER_WATER_ORDER,
  });
  const mist = createSprayPool(opts.count ?? sprayParams.bowCount, {
    sizeScale: () => 9,
    life: () => mistLife,
    drag: () => ROOSTER_MIST_DRAG,
    opacity: () => 0.22,
    fadeNear: () => sprayParams.bowContactFadeNear * 2,
    fadeFar: () => sprayParams.bowContactFadeFar * 2.5,
    colorNode: litTint,
    blending: THREE.NormalBlending,
    renderOrder: SPRAY_OVER_WATER_ORDER,
  });
  const count = drops.count;
  /** per jet: (x, surfaceY, z, UP launch) and (dirX, dirZ, CDF upper bound, AFT launch); side: (lateral, 0, 0, 0) */
  const jetPos = Array.from({ length: MAX_JETS }, () => new THREE.Vector4());
  const jetDir = Array.from({ length: MAX_JETS }, () => new THREE.Vector4(0, 1, 0, 0));
  const jetSide = Array.from({ length: MAX_JETS }, () => new THREE.Vector4());
  const uJetPos = uniformArray(jetPos);
  const uJetDir = uniformArray(jetDir);
  const uJetSide = uniformArray(jetSide);
  const uSizeVar = uniform(sprayParams.sizeVariation);
  const uTime = uniform(0);

  const buildSpawn = (pool: SprayPool, speed: number, hSalt: number, tSalt: number) => {
    const uCursor = uniform(0);
    const uBudget = uniform(0);
    const n = pool.count;
    const pass = Fn(() => {
      const pa = pool.posAge.element(instanceIndex);
      const rel = float(instanceIndex).sub(uCursor).add(n).mod(n);
      If(pa.w.greaterThanEqual(pool.lifeNode()).and(rel.lessThan(uBudget)), () => {
        // @band-limited-elsewhere: fract of the particle INDEX (a seed), not a spatial coordinate
        const s = float(instanceIndex).add(1).mul(PHI).fract().toVar();
        const rJet = hash2(vec2(s.mul(H_JET + hSalt), uTime.add(T_JET + tSalt)));
        const rUp = hash2(vec2(s.mul(H_BOW_UP + hSalt), uTime.add(T_BOW_UP + tSalt)));
        const rSide = hash2(vec2(s.mul(H_BOW_SIDE + hSalt), uTime.add(T_BOW_SIDE + tSalt)));
        const rMag = hash2(vec2(s.mul(H_BOW_MAG + hSalt), uTime.add(T_BOW_MAG + tSalt)));
        // pick the jet whose CDF interval holds rJet (slots past the live ones have CDF 1 and never win first)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node
        let pos: any = uJetPos.element(int(MAX_JETS - 1));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node
        let dir: any = uJetDir.element(int(MAX_JETS - 1));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node
        let side: any = uJetSide.element(int(MAX_JETS - 1));
        for (let j = MAX_JETS - 2; j >= 0; j--) {
          const take = rJet.lessThan(uJetDir.element(int(j)).z);
          pos = select(take, uJetPos.element(int(j)), pos);
          dir = select(take, uJetDir.element(int(j)), dir);
          side = select(take, uJetSide.element(int(j)), side);
        }
        const aft = vec2(dir.x, dir.y).toVar();
        const across = vec2(aft.y.negate(), aft.x);
        const sideSign = select(rSide.lessThan(0.5), float(-1), float(1));
        const velXZ = aft.mul(dir.w.mul(rMag.mul(0.4).add(0.6))).add(across.mul(side.x.mul(rMag).mul(sideSign)));
        const vy = pos.w.mul(rUp.mul(0.45).add(0.55));
        pool.posAge.element(instanceIndex).assign(vec4(vec3(pos.x, pos.y, pos.z), 0));
        const rSize = hash2(vec2(s.mul(H_SIZE + hSalt), uTime.add(T_SIZE + tSalt)));
        pool.velSize.element(instanceIndex).assign(vec4(vec3(velXZ.x, vy, velXZ.y).mul(speed), uSizeVar.mul(rSize).oneMinus()));
      });
    })().compute(n);
    let cursorState = { cursor: 0, acc: 0 };
    return {
      run(renderer: THREE.WebGPURenderer, total: number): void {
        // @band-limited-elsewhere: a pool method named step, not a shader edge
        pool.step(renderer); // physics always runs — airborne spray keeps falling
        if (!(total > 0)) return;
        const next = advanceBurstCursor(cursorState, total, SIM_DT, n);
        cursorState = { cursor: next.cursor, acc: next.acc };
        if (next.budget === 0) return;
        uCursor.value = (next.cursor - next.budget + n) % n;
        uBudget.value = next.budget;
        pool.run(renderer, pass);
      },
    };
  };
  const dropSpawn = buildSpawn(drops, 1, 0, 0);
  const mistSpawn = buildSpawn(mist, ROOSTER_MIST_SPEED, H_MIST, T_MIST);
  let pitch = Number.NaN;

  return {
    /** the drop pool's sprites (pre-§T.199 single mesh) */
    mesh: drops.mesh,
    /** §T.199 every sprite mesh: drops, mist */
    meshes: [drops.mesh, mist.mesh],
    /** §T.199 the pools (debug readback / tests) */
    pools: { drops, mist },
    count,
    /** §T.199 the sun direction (unit, toward the sun) the plume is lit by; non-finite keeps the last */
    setSun(x: number, y: number, z: number): void {
      const l = Math.hypot(x, y, z);
      if (Number.isFinite(l) && l > 1e-6) uSun.value.set(x / l, y / l, z / l);
    },
    /** §T.199 prop pitch (m) for jets that publish no rev/s (`propRpsEstimate`) */
    setPitch(p: number): void {
      pitch = Number.isFinite(p) && p > 0 ? p : Number.NaN;
    },
    /**
     * One fixed tick (§V2): this tick's props. Returns the total particle rate
     * (particles/s) it budgeted — 0 when no prop is surface-piercing.
     */
    update(renderer: THREE.WebGPURenderer, jets: readonly PropWashInput[], viewer?: SprayViewer): number {
      uSizeVar.value = Math.min(1, Math.max(0, Number.isFinite(sprayParams.sizeVariation) ? sprayParams.sizeVariation : 0));
      uTime.value += SIM_DT;
      let total = 0;
      let maxLaunch = 0;
      const rates: number[] = [];
      // §T.195: with a viewer, the slots go to the nearest surface-piercing props within the pool's turnover budget
      const sel = viewer ? prioritised(jets, viewer, count, pitch) : null;
      for (let j = 0; j < MAX_JETS; j++) {
        const jet = sel ? (j < sel.index.length ? jets[sel.index[j]] : undefined) : jets[j];
        const e = jet ? roosterTailEmission(jet, sprayParams, pitch) : null;
        const y = jet && Number.isFinite(jet.surfaceY) ? (jet.surfaceY as number) : NaN;
        const ok = !!e && e.rate > 0 && Number.isFinite(y);
        const rate = ok ? (sel ? sel.rate[j] : e!.rate) : 0;
        rates.push(rate);
        if (ok) {
          total += rate;
          maxLaunch = Math.max(maxLaunch, e!.launch);
          const len = Math.hypot(jet!.dirX, jet!.dirZ);
          jetPos[j].set(jet!.x, y, jet!.z, e!.launch);
          jetDir[j].set(jet!.dirX / len, jet!.dirZ / len, 0, e!.aft);
          jetSide[j].set(e!.lateral, 0, 0, 0);
        } else {
          jetPos[j].set(0, -1000, 0, 0);
          jetDir[j].set(0, 1, 0, 0);
          jetSide[j].set(0, 0, 0, 0);
        }
      }
      // the particle's jet CDF, and lifetimes long enough for the tallest arcs to fall back
      let acc = 0;
      for (let j = 0; j < MAX_JETS; j++) {
        acc += rates[j];
        jetDir[j].z = total > 0 ? (j === MAX_JETS - 1 ? 1 : acc / total) : 1;
      }
      dropLife = Math.max(sprayParams.bowLife, roosterFlightTime(maxLaunch, ROOSTER_DROP_DRAG));
      mistLife = Math.max(sprayParams.bowLife, 1.6 * roosterFlightTime(maxLaunch * ROOSTER_MIST_SPEED, ROOSTER_MIST_DRAG));
      dropSpawn.run(renderer, total);
      mistSpawn.run(renderer, total);
      return total;
    },
    dispose(): void {
      drops.dispose();
      mist.dispose();
    },
  };
}

export type RoosterTail = ReturnType<typeof createRoosterTail>;

const pickScratch: number[] = [];
const grantScratch: number[] = [];
const rateScratch: number[] = [];
const distScratch: number[] = [];

/** §T.195 the jets a pool of `count` draws for `viewer`: `prioritiseEmitters` over their rooster rates (budget count/life) */
function prioritised(jets: readonly PropWashInput[], viewer: SprayViewer, count: number, pitch: number): { index: number[]; rate: number[] } {
  rateScratch.length = 0;
  distScratch.length = 0;
  let maxLaunch = 0;
  for (const j of jets) {
    const e = roosterTailEmission(j, sprayParams, pitch);
    const ok = e.rate > 0 && Number.isFinite(j.surfaceY);
    rateScratch.push(ok ? e.rate : 0);
    distScratch.push(ok ? Math.hypot(j.x - viewer.x, (j.surfaceY as number) - viewer.y, j.z - viewer.z) : Infinity);
    if (ok) maxLaunch = Math.max(maxLaunch, e.launch);
  }
  const lifeS = Math.max(sprayParams.bowLife, roosterFlightTime(maxLaunch, ROOSTER_DROP_DRAG)) * (1 + Math.min(0.9, Math.max(0, sprayParams.lifeVariation)));
  prioritiseEmitters(rateScratch, distScratch, jets.length, count / Math.max(1e-3, lifeS), pickScratch, grantScratch);
  return { index: pickScratch, rate: grantScratch };
}

// ---------------------------------------------------------------------------
// §T.195 THE PROP'S BUBBLE TRAIL — aerated water behind every gearcase
// ---------------------------------------------------------------------------

/** jet slots the bubble pool carries (8 boats × 3 drives) — literal shader bound */
export const BUBBLE_MAX_JETS = 24;
/** bubbles emitted per m³ of aerated flux (A·AERATION_SHARE·u_air) — the trail's look density, sized for the chase cam */
export const BUBBLE_PER_M3 = 2000;
/** ribbon share of the aeration speed (the sim foam's AERATION_SHARE, restated here so foam/ does not import flowfoam/) */
export const BUBBLE_AERATION_SHARE = 0.033;
/** bubble life (s), buoyant rise (m/s) and drag (1/s): a milky plume that surfaces and thins within a few boat lengths */
export const BUBBLE_LIFE = 1.6;
export const BUBBLE_RISE = 0.12;
export const BUBBLE_DRAG = 2.2;
const H_BJET = 811.3;
const T_BJET = 4.4;

/** one prop's bubbles per second (§T.195): BUBBLE_PER_M3 · A · share · u_air — 0 in neutral, idle-off, or clear of the water */
export function propBubbleRate(j: PropWashInput): number {
  if (!propWashValid(j)) return 0;
  const r = BUBBLE_PER_M3 * j.discArea * BUBBLE_AERATION_SHARE * aerationSpeed(j);
  return Number.isFinite(r) && r > 0 ? r : 0;
}

export interface PropBubblesOptions {
  maxJets?: number;
  /** particle pool (default 4096) */
  count?: number;
}

/**
 * INSTANCED BUBBLES AT THE PROPS (§T.195), the close-camera half of the prop wash (the far half is the sim foam's
 * aeration ribbon, flowfoam simFoam `AERATION_SHARE`). One pool for the fleet, jet slots by the same camera priority
 * and turnover budget as the rooster tail. A bubble leaves the disc (random radius), is carried aft at ΔV·(0.3..1)
 * spreading outboard at the jet's own slope (0.1·ΔV), starts in a band from 0.4 m under the surface to just at it,
 * rises toward BUBBLE_RISE against heavy drag (buoyancy as a negative gravity) and thins over BUBBLE_LIFE,
 * turquoise-white, fading 25→80 m.
 * Visible from above where it reaches the drawn surface, and from below (src/underwater) everywhere.
 * §V28: finite-guarded uniforms; dead slots are the pool's zero-size quads.
 */
export function createPropBubbles(opts: PropBubblesOptions = {}) {
  const MAX_JETS = Math.max(1, Math.min(64, Math.floor(opts.maxJets ?? BUBBLE_MAX_JETS)));
  const pool = createSprayPool(opts.count ?? 4096, {
    sizeScale: () => 1.4,
    life: () => BUBBLE_LIFE,
    drag: () => BUBBLE_DRAG,
    // buoyancy: an UPWARD acceleration whose drag-limited terminal speed is BUBBLE_RISE (v∞ = −g/k)
    gravity: () => -BUBBLE_RISE * BUBBLE_DRAG,
    opacity: () => 0.3,
    fadeNear: () => 25,
    fadeFar: () => 80,
    colorNode: () => vec3(0.78, 0.97, 0.93),
    // §T.199 under the surface: drawn before the ocean so its refraction carries them (sprayPool.ts)
    renderOrder: SPRAY_UNDER_WATER_ORDER,
  });
  const count = pool.count;
  /** per jet: (x, surfaceY, z, ΔV) and (dirX, dirZ, CDF upper bound, disc radius) */
  const jetPos = Array.from({ length: MAX_JETS }, () => new THREE.Vector4(0, -1000, 0, 0));
  const jetDir = Array.from({ length: MAX_JETS }, () => new THREE.Vector4(0, 1, 1, 0));
  const uJetPos = uniformArray(jetPos);
  const uJetDir = uniformArray(jetDir);
  const uCursor = uniform(0);
  const uBudget = uniform(0);
  const uTime = uniform(0);
  const uRise = uniform(BUBBLE_RISE);

  const spawnPass = Fn(() => {
    const pa = pool.posAge.element(instanceIndex);
    const rel = float(instanceIndex).sub(uCursor).add(count).mod(count);
    If(pa.w.greaterThanEqual(pool.lifeNode()).and(rel.lessThan(uBudget)), () => {
      // @band-limited-elsewhere: fract of the particle INDEX (a seed), not a spatial coordinate
      const s = float(instanceIndex).add(1).mul(PHI).fract().toVar();
      const rJet = hash2(vec2(s.mul(H_BJET), uTime.add(T_BJET)));
      const rUp = hash2(vec2(s.mul(H_BOW_UP), uTime.add(T_BOW_UP)));
      const rSide = hash2(vec2(s.mul(H_BOW_SIDE), uTime.add(T_BOW_SIDE)));
      const rMag = hash2(vec2(s.mul(H_BOW_MAG), uTime.add(T_BOW_MAG)));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node
      let pos: any = uJetPos.element(int(MAX_JETS - 1));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node
      let dir: any = uJetDir.element(int(MAX_JETS - 1));
      for (let j = MAX_JETS - 2; j >= 0; j--) {
        const take = rJet.lessThan(uJetDir.element(int(j)).z);
        pos = select(take, uJetPos.element(int(j)), pos);
        dir = select(take, uJetDir.element(int(j)), dir);
      }
      const aft = vec2(dir.x, dir.y).toVar();
      const side = vec2(aft.y.negate(), aft.x);
      const across = rSide.mul(2).sub(1).mul(dir.w);
      const along = rMag.mul(dir.w);
      const xz = vec2(pos.x, pos.z).add(side.mul(across)).add(aft.mul(along));
      const y = pos.y.add(0.02).sub(rUp.mul(0.4));
      pool.posAge.element(instanceIndex).assign(vec4(xz.x, y, xz.y, 0));
      const spread = rSide.mul(2).sub(1).mul(pos.w.mul(0.1).add(0.3));
      const velXZ = aft.mul(pos.w.mul(rMag.mul(0.7).add(0.3))).add(side.mul(spread));
      const rSize = hash2(vec2(s.mul(H_SIZE), uTime.add(T_SIZE)));
      pool.velSize.element(instanceIndex).assign(vec4(velXZ.x, uRise.mul(rUp.mul(0.5).add(0.5)), velXZ.y, rSize.mul(0.6).add(0.4)));
    });
  })().compute(count);

  let cursorState = { cursor: 0, acc: 0 };
  const rates: number[] = [];
  const dists: number[] = [];
  const pick: number[] = [];
  const grant: number[] = [];

  return {
    mesh: pool.mesh,
    count,
    granted: { index: pick, rate: grant },
    /** FIXED TICK: every boat's props this tick (any order) and the viewer; returns the granted bubbles/s */
    update(renderer: THREE.WebGPURenderer, jets: readonly PropWashInput[], viewer: SprayViewer): number {
      uTime.value += SIM_DT;
      rates.length = 0;
      dists.length = 0;
      for (const j of jets) {
        const ok = Number.isFinite(j.surfaceY);
        rates.push(ok ? propBubbleRate(j) : 0);
        dists.push(ok ? Math.hypot(j.x - viewer.x, (j.surfaceY as number) - viewer.y, j.z - viewer.z) : Infinity);
      }
      prioritiseEmitters(rates, dists, MAX_JETS, count / BUBBLE_LIFE, pick, grant);
      let total = 0;
      for (let k = 0; k < MAX_JETS; k++) {
        if (k >= pick.length) {
          jetPos[k].set(0, -1000, 0, 0);
          jetDir[k].set(0, 1, 1, 0);
          continue;
        }
        const j = jets[pick[k]];
        const len = Math.hypot(j.dirX, j.dirZ);
        jetPos[k].set(j.x, j.surfaceY as number, j.z, jetExcessSpeed(j.advance, j.thrust, j.discArea));
        jetDir[k].set(j.dirX / len, j.dirZ / len, 0, Math.sqrt(j.discArea / Math.PI));
        total += grant[k];
      }
      let acc = 0;
      for (let k = 0; k < MAX_JETS; k++) {
        if (k < pick.length) acc += grant[k];
        jetDir[k].z = total > 0 ? (k >= pick.length - 1 ? 1 : acc / total) : 1;
      }
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

export type PropBubbles = ReturnType<typeof createPropBubbles>;
