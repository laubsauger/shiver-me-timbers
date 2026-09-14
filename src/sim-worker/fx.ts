/**
 * §T.195 EVERY BOAT MARKS THE WATER — the per-boat EFFECTS record a stepper publishes next to its pose, so the page
 * can draw a rival's wake, prop wash, rooster tail, bubbles and spray from the SAME step as her pose (§V101: one
 * contact result, many consumers; §V2: a function of that tick's inputs only, bit-identical on every transport).
 *
 * Lives in the boat block at `B.FX` (layout.ts), FX_LEN f64, between the contact summary and the wake samples:
 *
 *   DRIVE_COUNT            1                       live drives (≤ FX_DRIVES)
 *   DRIVE k                FX_DRIVE_LEN each       one `PropWashInput`, flattened (propWashHullWater's adapter)
 *   BOW                    FX_BOW_LEN              one `WaterlineSpray` (sprayMath.waterlineSprayEmission) — param-free
 *
 * PARAM-FREE ON PURPOSE. A worker holds its own copy of the module params; the page's live panels move the page's.
 * So only PHYSICS crosses (thrust, lost power, lifted flux, slam inputs); every look knob (bowLiftRate, dose rates)
 * is applied on the page from its live params — a panel drag reaches a rival's spray on the same frame as the
 * player's.
 *
 * ONE WRITER (`writeBoatFx`): the stepper calls it after each boat's step; the page calls it for the player's own
 * `HullWater` into a local record — both read back through `readBoatFx`, so the two cannot drift (§V77).
 */
import type { HullWater } from '../sea-physics/hullWater';
import type { Rigid6State } from '../sea-physics/rigidBody';
import { createWaterlineSpray, waterlineSprayEmission, type WaterlineSpray } from '../foam/sprayMath';
import type { PropWashInput } from '../wake/propWash';
import { propWashFromHullWater } from '../wake/propWashHullWater';
import { HOLLOW_DEPTHS, createHollowRecord, measureHollow, type HollowRecord } from '../wake/transomHollow';

/** drives one record carries (the speedboat has 3) */
export const FX_DRIVES = 4;
/** per drive: x, z, dirX, dirZ, thrust, discArea, depth, advance, immersion, surfaceY, lossPower, ventAirSpeed, propRps */
export const FX_DRIVE_LEN = 13;
export const FX_DRIVE = {
  X: 0, Z: 1, DIR_X: 2, DIR_Z: 3, THRUST: 4, DISC_AREA: 5, DEPTH: 6, ADVANCE: 7, IMMERSION: 8, SURFACE_Y: 9, LOSS_POWER: 10, VENT_AIR: 11, PROP_RPS: 12,
} as const;
/** bow record: inContact, flux, lift, launch, x, y, z, halfWidth, fwdX, fwdZ, burialRate, cutwaterDepth */
export const FX_BOW_LEN = 12;
export const FX = {
  DRIVE_COUNT: 0,
  DRIVE: 1,
  BOW: 1 + FX_DRIVES * FX_DRIVE_LEN,
} as const;
/** W8 round 5: the transom hollow — x, z, fwdX, fwdZ, length, width, HOLLOW_DEPTHS depths (wake/transomHollow.ts) */
export const FX_HOLLOW_LEN = 6 + HOLLOW_DEPTHS;
export const FX_HOLLOW = FX.BOW + FX_BOW_LEN;
export const FX_LEN = FX_HOLLOW + FX_HOLLOW_LEN;

/** one boat's decoded effects record */
export interface BoatFx {
  /** live entries of `jets` */
  jets: PropWashInput[];
  bow: WaterlineSpray;
  /** W8 round 5: the transom hollow (length 0 = none) */
  hollow: HollowRecord;
}

export function createBoatFx(): BoatFx {
  return { jets: [], bow: createWaterlineSpray(), hollow: createHollowRecord() };
}

const jetScratch: PropWashInput[] = [];
const bowScratch = createWaterlineSpray();
const hollowScratch = createHollowRecord();

/** the `HullWater` read by the writer: the drive publications, the waterline and the strips (after `evaluate`) */
export type BoatFxSource = Pick<
  HullWater,
  'mesh' | 'driveThrust' | 'driveProp' | 'driveDir' | 'driveAdvance' | 'driveImmersion' | 'patch' | 'engines' | 'params' | 'waterline' | 'sections'
>;

/** write boat `hw`'s effects of its last evaluate into f[o .. o + FX_LEN) — the ONE writer (header) */
export function writeBoatFx(hw: BoatFxSource, state: Readonly<Rigid6State>, f: Float64Array, o: number): void {
  const n = Math.min(FX_DRIVES, propWashFromHullWater(hw, state, jetScratch));
  f[o + FX.DRIVE_COUNT] = n;
  for (let k = 0; k < FX_DRIVES; k++) {
    const q = o + FX.DRIVE + k * FX_DRIVE_LEN;
    const j = k < n ? jetScratch[k] : null;
    f[q + FX_DRIVE.X] = j ? j.x : 0;
    f[q + FX_DRIVE.Z] = j ? j.z : 0;
    f[q + FX_DRIVE.DIR_X] = j ? j.dirX : 0;
    f[q + FX_DRIVE.DIR_Z] = j ? j.dirZ : 0;
    f[q + FX_DRIVE.THRUST] = j ? j.thrust : 0;
    f[q + FX_DRIVE.DISC_AREA] = j ? j.discArea : 0;
    f[q + FX_DRIVE.DEPTH] = j ? j.depth : 0;
    f[q + FX_DRIVE.ADVANCE] = j ? j.advance : 0;
    f[q + FX_DRIVE.IMMERSION] = j ? j.immersion : 0;
    f[q + FX_DRIVE.SURFACE_Y] = j ? (j.surfaceY ?? Number.NaN) : 0;
    f[q + FX_DRIVE.LOSS_POWER] = j ? (j.lossPower ?? 0) : 0;
    f[q + FX_DRIVE.VENT_AIR] = j ? (j.ventAirSpeed ?? 0) : 0;
    // §T.199: the blade tip speed the rooster throw needs — rivals published it instead of estimating it
    f[q + FX_DRIVE.PROP_RPS] = j ? (j.propRps ?? Number.NaN) : 0;
  }
  const b = waterlineSprayEmission({ waterline: hw.waterline, sections: hw.sections, stripZ: hw.mesh.strips.zCentre }, state.quaternion, bowScratch);
  const w = o + FX.BOW;
  f[w] = b.inContact ? 1 : 0;
  f[w + 1] = b.flux;
  f[w + 2] = b.lift;
  f[w + 3] = b.launch;
  f[w + 4] = b.x;
  f[w + 5] = b.y;
  f[w + 6] = b.z;
  f[w + 7] = b.halfWidth;
  f[w + 8] = b.fwdX;
  f[w + 9] = b.fwdZ;
  f[w + 10] = b.burialRate;
  f[w + 11] = b.cutwaterDepth;
  // W8 round 5: the transom hollow from the physics' own depth field (a HullWater without it publishes none)
  const h = o + FX_HOLLOW;
  const depthAt = (hw as { transomWakeDepthAt?: (x: number, z: number) => number }).transomWakeDepthAt;
  if (depthAt) {
    const q = state.quaternion;
    const tz = hw.mesh.transomZ;
    // body (0, 0, z) → world: R·(0,0,1) = (2(xz + wy), 2(yz − wx), 1 − 2(x² + y²))
    const fwX = 2 * (q[0] * q[2] + q[3] * q[1]);
    const fwZ = 1 - 2 * (q[0] * q[0] + q[1] * q[1]);
    let beam = 0;
    const cb = hw.mesh.strips.chineHalfBeam;
    for (let i = 0; i < cb.length; i++) beam = Math.max(beam, 2 * cb[i]);
    measureHollow((x, z) => depthAt.call(hw, x, z), state.position[0] + fwX * tz, state.position[2] + fwZ * tz, fwX, fwZ, beam, hollowScratch);
  } else {
    hollowScratch.length = 0;
    hollowScratch.depths.fill(0);
  }
  f[h] = hollowScratch.x;
  f[h + 1] = hollowScratch.z;
  f[h + 2] = hollowScratch.fwdX;
  f[h + 3] = hollowScratch.fwdZ;
  f[h + 4] = hollowScratch.length;
  f[h + 5] = hollowScratch.width;
  for (let c = 0; c < HOLLOW_DEPTHS; c++) f[h + 6 + c] = hollowScratch.depths[c];
}

/** decode f[o .. o + FX_LEN) into `out` (reuses its objects) */
export function readBoatFx(f: ArrayLike<number>, o: number, out: BoatFx): BoatFx {
  const count = f[o + FX.DRIVE_COUNT];
  const n = Number.isInteger(count) && count >= 0 ? Math.min(FX_DRIVES, count) : 0;
  for (let k = 0; k < n; k++) {
    const q = o + FX.DRIVE + k * FX_DRIVE_LEN;
    const j = (out.jets[k] ??= { x: 0, z: 0, dirX: 0, dirZ: 1, thrust: 0, discArea: 0, depth: 0, advance: 0, immersion: 0 });
    j.x = f[q + FX_DRIVE.X];
    j.z = f[q + FX_DRIVE.Z];
    j.dirX = f[q + FX_DRIVE.DIR_X];
    j.dirZ = f[q + FX_DRIVE.DIR_Z];
    j.thrust = f[q + FX_DRIVE.THRUST];
    j.discArea = f[q + FX_DRIVE.DISC_AREA];
    j.depth = f[q + FX_DRIVE.DEPTH];
    j.advance = f[q + FX_DRIVE.ADVANCE];
    j.immersion = f[q + FX_DRIVE.IMMERSION];
    j.surfaceY = f[q + FX_DRIVE.SURFACE_Y];
    j.lossPower = f[q + FX_DRIVE.LOSS_POWER];
    j.ventAirSpeed = f[q + FX_DRIVE.VENT_AIR];
    j.propRps = f[q + FX_DRIVE.PROP_RPS];
  }
  out.jets.length = n;
  const w = o + FX.BOW;
  const b = out.bow;
  b.inContact = f[w] === 1;
  b.flux = f[w + 1];
  b.lift = f[w + 2];
  b.launch = f[w + 3];
  b.x = f[w + 4];
  b.y = f[w + 5];
  b.z = f[w + 6];
  b.halfWidth = f[w + 7];
  b.fwdX = f[w + 8];
  b.fwdZ = f[w + 9];
  b.burialRate = f[w + 10];
  b.cutwaterDepth = f[w + 11];
  const h = o + FX_HOLLOW;
  const r = (out.hollow ??= createHollowRecord());
  r.x = f[h];
  r.z = f[h + 1];
  r.fwdX = f[h + 2];
  r.fwdZ = f[h + 3];
  r.length = f[h + 4];
  r.width = f[h + 5];
  for (let c = 0; c < HOLLOW_DEPTHS; c++) r.depths[c] = f[h + 6 + c];
  return out;
}
