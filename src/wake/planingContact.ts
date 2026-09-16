/**
 * W9 WHERE A PLANING HULL TOUCHES THE WATER, AND WHAT IT THROWS (docs/wake/w9-at-speed-disturbance.md).
 *
 * THE CONTACT, per boat per tick, from her POSE, the SHARED hull strips (§V110: every boat runs the deep-V) and the local
 * surface her effects record already carries (the waterline centroid's y and the drives' `surfaceY`) — one code path for
 * the hero and every rival, no new record fields:
 *
 *   keel immersion   d_i = y_surface(z_i) − y_keel,i            per strip, surface a line along the hull through the
 *                                                                waterline centroid and the drives
 *   spray root       c_i = min((π/2)·d_i / tan β_i, b_chine,i)  Wagner's wetted half-beam (the physics' `sprayRoot`)
 *   wetted run       from the forward point where d crosses 0 to the transom (d extrapolated there)
 *
 * Checked against `HullWater.sections` on the CPU tow (tests/wakeAtSpeedDisturbance.test.ts): keel wetted to z ≈ 4.9 m
 * and c_t ≈ 1.0–1.1 m at 25–35 m/s, the chines dry.
 *
 * WHAT IT THROWS (`hullSpray.ts` emitters):
 *
 *   SHEET  The spray-root jet leaves the stagnation line reflected by 2θ, θ the root line's angle to the flow,
 *          tan θ = c_t / run. In the hull frame it runs at U along the V's bottom (deadrise β) and separates at the
 *          chine; in the world frame (add U):  outboard U·sin 2θ·cos β,  up U·sin 2θ·sin β,  forward U·(1 − cos 2θ).
 *          25 m/s: θ ≈ 7°, 5.9 m/s out, 2.6 m/s up (a 0.35 m apex, landing ~3 m out); 35 m/s: 6.9 / 3.0 m/s.
 *          Flux: the waterline's lifted flux (`WaterlineSpray.flux`, physics).
 *   BOIL   The surface-piercing drives in the transom hollow throw their slipstream up as white water: spawned across
 *          the hollow's width from the props aft, up at BOIL_LAUNCH_SHARE of the rooster tail's launch (the sheet's
 *          heavy fraction; the hollow's plunge speed √(2g·d_t) when the props throw none), outboard at half of it, aft
 *          at the jet's excess ΔV. Flux: the drives' surface air Σ ventAirSpeed·A (physics, `propWash`) × the dry-transom
 *          share (`transomHollow.dryTransomShare`).
 *   HUMP   The hollow closes L_h aft of the transom: the refill flux w·d̄·U plunges at √(2g·d_max) and heaps up; its
 *          whitewater share is the plunge entrainment law (`chineEmissions.sheetAirShare`) × the dry-transom share
 *          (`transomHollow.dryTransomShare`, Fn_T 3 → 5).
 */
import { GRAVITY } from '../ocean/oceanMath';
import { HULL_SPRAY_LOOK, createHullSprayEmitter, type HullSprayEmitter } from '../foam/hullSpray';
import type { WaterlineSpray } from '../foam/sprayMath';
import { sheetAirShare } from './chineEmissions';
import { jetExcessSpeed, type PropWashInput } from './propWash';
import { HOLLOW_DEPTHS, dryTransomShare, type HollowRecord } from './transomHollow';
import { roosterTailEmission } from '../foam/roosterTail';
import { sprayParams } from '../params/spray';

/**
 * W9 LOOK CALIBRATION, stated: the boil's clumps leave at this share of the props' rooster-tail launch (V_s·√e,
 * `roosterTailEmission`). A breaking sheet sheds its thick rim and ligaments slowest (Villermaux 2007: fragment speeds
 * spread well below the sheet's); the fine drops keep the full launch (the rooster tail), the heavy water is the mound.
 */
export const BOIL_LAUNCH_SHARE = 0.3;

/** the shared hull the contact reads (`HullWaterMesh`'s strips, body frame: +z forward, y up) */
export interface PlaningHull {
  transomZ: number;
  strips: {
    count: number;
    zCentre: ArrayLike<number>;
    keelY: ArrayLike<number>;
    chineHalfBeam: ArrayLike<number>;
    /** deadrise at the strip centre (rad); absent ⇒ DEFAULT_DEADRISE */
    deadrise?: ArrayLike<number>;
  };
}

/** the deep-V's prismatic deadrise (24°) when a hull publishes none */
export const DEFAULT_DEADRISE = (24 * Math.PI) / 180;
/** below this speed over the water (m/s) a hull is not planing: no sheet, boil or hump from this model */
export const PLANING_CONTACT_MIN_SPEED = 6;
/** Visual transition to the full planing spray budget; avoids a hard switch at 6 m/s. */
export const PLANING_CONTACT_FULL_SPEED = 10;

export interface PlaningContact {
  wet: boolean;
  speed: number;
  /** unit heading, world XZ */
  fwdX: number;
  fwdZ: number;
  /** forward wetted keel point, world (y on the surface) and its body z */
  frontX: number;
  frontY: number;
  frontZ: number;
  frontBodyZ: number;
  /** transom point on the centreline, world, and its surface y */
  transomX: number;
  transomY: number;
  transomZ: number;
  /** keel immersion and spray-root half-beam at the transom (m), chine half-beam there, deadrise there (rad) */
  transomDepth: number;
  rootHalfBeam: number;
  chineHalfBeam: number;
  deadrise: number;
}

export function createPlaningContact(): PlaningContact {
  return { wet: false, speed: 0, fwdX: 0, fwdZ: 1, frontX: 0, frontY: 0, frontZ: 0, frontBodyZ: 0, transomX: 0, transomY: 0, transomZ: 0, transomDepth: 0, rootHalfBeam: 0, chineHalfBeam: 0, deadrise: DEFAULT_DEADRISE };
}

export interface PlaningPose {
  position: ArrayLike<number>;
  quaternion: ArrayLike<number>;
  velocity: ArrayLike<number>;
}

const dScratch: number[] = [];

/** the contact (header) from her pose, the shared hull and her record's surface points. §V28: anything non-finite → dry */
export function planingContact(hull: PlaningHull, pose: PlaningPose, bow: Readonly<WaterlineSpray>, jets: readonly PropWashInput[], out: PlaningContact): PlaningContact {
  out.wet = false;
  const [px, py, pz] = [pose.position[0], pose.position[1], pose.position[2]];
  const [qx, qy, qz, qw] = [pose.quaternion[0], pose.quaternion[1], pose.quaternion[2], pose.quaternion[3]];
  if (![px, py, pz, qx, qy, qz, qw, pose.velocity[0], pose.velocity[2]].every(Number.isFinite)) return out;
  const fx = 2 * (qx * qz + qw * qy);
  const fz = 1 - 2 * (qx * qx + qy * qy);
  const fl = Math.hypot(fx, fz);
  if (!(fl > 1e-6)) return out;
  out.fwdX = fx / fl;
  out.fwdZ = fz / fl;
  out.speed = Math.abs(pose.velocity[0] * out.fwdX + pose.velocity[2] * out.fwdZ);
  // body point (0, y, z) → world (v' = v + 2w(u×v) + 2u×(u×v))
  const world = (y: number, z: number, o: number[]): void => {
    const cx = qy * z - qz * y;
    const cy = -qx * z;
    const cz = qx * y;
    o[0] = px + 2 * (qw * cx + (qy * cz - qz * cy));
    o[1] = py + y + 2 * (qw * cy + (qz * cx - qx * cz));
    o[2] = pz + z + 2 * (qw * cz + (qx * cy - qy * cx));
  };
  const bodyZ = (x: number, z: number): number => (x - px) * out.fwdX + (z - pz) * out.fwdZ;
  // the surface along her: a line through the waterline centroid and the drives' mean surface (either alone: level)
  let jy = 0;
  let jz = 0;
  let jn = 0;
  for (const j of jets) {
    if (j.surfaceY === undefined || ![j.surfaceY, j.x, j.z].every(Number.isFinite)) continue;
    jy += j.surfaceY;
    jz += bodyZ(j.x, j.z);
    jn++;
  }
  const bowOk = bow.inContact && [bow.x, bow.y, bow.z].every(Number.isFinite);
  if (jn === 0 && !bowOk) return out;
  const zb = bowOk ? bodyZ(bow.x, bow.z) : 0;
  const zj = jn > 0 ? jz / jn : 0;
  const yb = bowOk ? bow.y : jy / jn;
  const yj = jn > 0 ? jy / jn : bow.y;
  const slope = bowOk && jn > 0 && Math.abs(zb - zj) > 1 ? (yb - yj) / (zb - zj) : 0;
  const surfaceAt = (z: number): number => (jn > 0 ? yj + slope * (z - zj) : yb);
  const S = hull.strips;
  const n = S.count;
  if (!(n >= 2)) return out;
  const p: number[] = [0, 0, 0];
  dScratch.length = n;
  let front = -1;
  for (let i = 0; i < n; i++) {
    world(S.keelY[i], S.zCentre[i], p);
    const d = surfaceAt(S.zCentre[i]) - p[1];
    dScratch[i] = Number.isFinite(d) ? d : -1;
    if (dScratch[i] > 0 && (front < 0 || S.zCentre[i] > S.zCentre[front])) front = i;
  }
  if (front < 0) return out;
  // forward point: where d crosses 0 toward the next strip forward (strips ordered by z; else half a strip ahead)
  let zf = S.zCentre[front];
  const next = front + 1 < n && S.zCentre[front + 1] > zf ? front + 1 : -1;
  if (next >= 0 && dScratch[next] <= 0) zf += ((S.zCentre[next] - zf) * dScratch[front]) / (dScratch[front] - dScratch[next]);
  else if (next < 0 && n >= 2) zf += 0.5 * Math.abs(S.zCentre[1] - S.zCentre[0]);
  // transom: the aft two strips' immersion extrapolated to transomZ
  const a0 = S.zCentre[0] < S.zCentre[n - 1] ? 0 : n - 1;
  const a1 = a0 === 0 ? 1 : n - 2;
  const dz = S.zCentre[a1] - S.zCentre[a0];
  const dt = Math.abs(dz) > 1e-6 ? dScratch[a0] + ((dScratch[a0] - dScratch[a1]) * (S.zCentre[a0] - hull.transomZ)) / dz : dScratch[a0];
  const beta = S.deadrise && Number.isFinite(S.deadrise[a0]) && S.deadrise[a0] > 0.05 ? S.deadrise[a0] : DEFAULT_DEADRISE;
  const chine = S.chineHalfBeam[a0];
  if (!(dt > 0) || !(zf > hull.transomZ) || !Number.isFinite(chine)) return out;
  out.transomDepth = dt;
  out.deadrise = beta;
  out.chineHalfBeam = chine;
  out.rootHalfBeam = Math.min(chine, ((Math.PI / 2) * dt) / Math.tan(beta));
  out.frontBodyZ = zf;
  world(S.keelY[front], zf, p);
  out.frontX = p[0];
  out.frontZ = p[2];
  out.frontY = surfaceAt(zf);
  world(S.keelY[a0], hull.transomZ, p);
  out.transomX = p[0];
  out.transomZ = p[2];
  out.transomY = surfaceAt(hull.transomZ);
  out.wet = [out.frontX, out.frontY, out.frontZ, out.transomX, out.transomY, out.transomZ, out.rootHalfBeam].every(Number.isFinite);
  return out;
}

/** the spray-root sheet launch (header SHEET): world m/s outboard, up, forward */
export function sheetLaunch(c: Readonly<PlaningContact>): { out: number; up: number; forward: number; theta: number } {
  const length = Math.hypot(c.frontX - c.transomX, c.frontZ - c.transomZ);
  const theta = Math.atan2(c.rootHalfBeam, Math.max(1, length));
  const s2 = Math.sin(2 * theta);
  const U = c.speed;
  return { out: U * s2 * Math.cos(c.deadrise), up: U * s2 * Math.sin(c.deadrise), forward: U * (1 - Math.cos(2 * theta)), theta };
}

/**
 * This boat's three emitters appended to `out` from reusable `pool` objects (header). Returns how many were added.
 * Nothing below PLANING_CONTACT_MIN_SPEED or when dry.
 */
export function planingSprayEmitters(
  c: Readonly<PlaningContact>,
  bow: Readonly<WaterlineSpray>,
  jets: readonly PropWashInput[],
  hollow: Readonly<HollowRecord> | null,
  pool: HullSprayEmitter[],
  out: HullSprayEmitter[],
): number {
  if (!c.wet || !(c.speed > PLANING_CONTACT_MIN_SPEED)) return 0;
  const onset = Math.min(1, (c.speed - PLANING_CONTACT_MIN_SPEED) / (PLANING_CONTACT_FULL_SPEED - PLANING_CONTACT_MIN_SPEED));
  const planingShare = onset * onset * (3 - 2 * onset);
  const L = HULL_SPRAY_LOOK;
  let added = 0;
  const take = (): HullSprayEmitter => {
    const e = (pool[out.length] ??= createHullSprayEmitter());
    // Slots are reused between emitter kinds as hull contact changes.
    e.rise = 0;
    out.push(e);
    added++;
    return e;
  };
  const aftX = -c.fwdX;
  const aftZ = -c.fwdZ;
  // SHEET: forward wetted keel point → transom along the root line (width 0 → c_t)
  const flux = bow.inContact && Number.isFinite(bow.flux) ? Math.max(0, bow.flux) : 0;
  if (flux > 0) {
    const l = sheetLaunch(c);
    const e = take();
    e.x = c.frontX;
    e.y = c.frontY;
    e.z = c.frontZ;
    e.axisX = aftX;
    e.axisZ = aftZ;
    e.length = Math.hypot(c.frontX - c.transomX, c.frontZ - c.transomZ);
    e.rise = c.transomY - c.frontY;
    e.width0 = 0;
    e.width1 = c.rootHalfBeam;
    e.fill = 0;
    e.out = l.out;
    e.up = l.up;
    e.along = -l.forward;
    e.size = L.sheetSize;
    e.rate = L.sheetDensity * flux * planingShare;
  }
  // BOIL: the drives' surface air, across the hollow from the props aft
  let air = 0;
  let excess = 0;
  let launch = 0;
  let cx = 0;
  let cz = 0;
  let cy = 0;
  let nj = 0;
  for (const j of jets) {
    if (j.surfaceY === undefined || ![j.x, j.z, j.surfaceY, j.discArea, j.immersion].every(Number.isFinite) || !(j.immersion > 0)) continue;
    const v = Math.max(0, Number.isFinite(j.ventAirSpeed) ? (j.ventAirSpeed as number) : 0);
    air += v * j.discArea;
    excess += jetExcessSpeed(j.advance, j.thrust, j.discArea);
    launch += roosterTailEmission(j, sprayParams).launch;
    cx += j.x;
    cz += j.z;
    cy += j.surfaceY;
    nj++;
  }
  const halfHollow = hollow && hollow.width > 0 ? hollow.width / 2 : c.rootHalfBeam;
  const plunge = Math.sqrt(2 * GRAVITY * c.transomDepth);
  // the drives run IN the hollow only once the transom is dry (a wet stern buries them: their air leaves as the ribbon)
  const dry = hollow ? dryTransomShare(c.speed, hollow.depths[0]) : 0;
  if (nj > 0 && air > 0 && dry > 0) {
    const e = take();
    e.x = cx / nj;
    e.y = cy / nj;
    e.z = cz / nj;
    e.axisX = aftX;
    e.axisZ = aftZ;
    e.length = 3;
    e.width0 = 0.7 * halfHollow;
    e.width1 = halfHollow;
    e.fill = 1;
    const up = launch > 0 && Number.isFinite(launch) ? Math.max(plunge, (BOIL_LAUNCH_SHARE * launch) / nj) : plunge;
    e.out = 0.5 * up;
    e.up = up;
    e.along = Number.isFinite(excess) ? excess / nj : 0;
    e.size = L.boilSize;
    e.rate = L.boilDensity * air * dry * planingShare;
  }
  // HUMP: where the hollow closes
  if (hollow && hollow.length > 0 && hollow.width > 0) {
    let dMax = 0;
    let dSum = 0;
    for (let k = 0; k < HOLLOW_DEPTHS; k++) {
      const d = hollow.depths[k];
      if (Number.isFinite(d) && d > 0) {
        dMax = Math.max(dMax, d);
        dSum += d;
      }
    }
    const v = Math.sqrt(2 * GRAVITY * dMax);
    const refill = hollow.width * (dSum / HOLLOW_DEPTHS) * c.speed;
    // the plunge entrainment share, only once the transom runs dry (`dryTransomShare`: a wet stern makes a wave, not a hump)
    const share = sheetAirShare(v) * dry;
    if (share > 0 && refill > 0) {
      const e = take();
      e.x = hollow.x - hollow.fwdX * 0.8 * hollow.length;
      e.y = c.transomY;
      e.z = hollow.z - hollow.fwdZ * 0.8 * hollow.length;
      e.axisX = -hollow.fwdX;
      e.axisZ = -hollow.fwdZ;
      e.length = 0.4 * hollow.length;
      e.width0 = hollow.width / 2;
      e.width1 = 0.7 * hollow.width;
      e.fill = 1;
      e.out = 0.4 * v;
      e.up = v;
      e.along = 0;
      e.size = L.humpSize;
      e.rate = L.humpDensity * refill * share * planingShare;
    }
  }
  return added;
}
