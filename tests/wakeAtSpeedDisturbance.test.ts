/**
 * W9 AT-SPEED DISTURBANCE (docs/wake/w9-at-speed-disturbance.md). USER (1080p trailer): 'at high speed the hull and
 * engines barely disturb the water'; 'chasing behind a rival, the boats read as floating' — heavy visible water thrown
 * sideways and aft at speed, a contact line, a prop-wash mound; the same for every boat (§V110).
 *
 * WHY these tests:
 *  - The whitewater of EVERY boat is built from her pose, the shared deep-V strips and her effects record — not from
 *    the hero's `HullWater`. If that reconstruction drifts from the physics' own contact (wetted keel, transom
 *    immersion, Wagner spray root), the spray is drawn where the hull is not wet, and a rival's differs from the hero's.
 *  - The disturbance must SCALE with the physics: heavier and faster with speed, physically bounded launches (a sheet
 *    off a 24° V at 35 m/s rises a fraction of a metre, not metres), and nothing from a boat at displacement speed —
 *    the W8 lesson (white water "as soon as the engine runs") must not come back.
 *  - The rooster hump must LIFT the drawn surface where the hollow closes, and only there.
 *  - The pool is shared by the pack: bounded slots and turnover, nearest boat first.
 */
import { describe, expect, it } from 'vitest';
import { createHullSpray, HULL_SPRAY_LOOK, HULL_SPRAY_SLOTS, type HullSprayEmitter } from '../src/foam/hullSpray';
import { roosterTailEmission } from '../src/foam/roosterTail';
import { sprayParams } from '../src/params/spray';
import type { HullWater } from '../src/sea-physics/hullWater';
import { createBoatFx, readBoatFx, writeBoatFx, FX_LEN, type BoatFx } from '../src/sim-worker/fx';
import { GRAVITY } from '../src/ocean/oceanMath';
import { BOIL_LAUNCH_SHARE, PLANING_CONTACT_MIN_SPEED, createPlaningContact, planingContact, planingSprayEmitters, sheetLaunch, type PlaningPose } from '../src/wake/planingContact';
import { SpeedboatTow } from '../src/wake/speedboatTow';
import { HOLLOW_DEPTHS, HUMP_HEIGHT_SHARE, dryTransomShare, hollowSamples, humpSamples } from '../src/wake/transomHollow';
import { WAKE_RHO, WakeSourceBuffer } from '../src/wake/wakeSolverMath';

interface Towed {
  U: number;
  hw: HullWater;
  pose: PlaningPose;
  fx: BoatFx;
}

const towCache = new Map<number, Towed>();
function towed(U: number): Towed {
  const hit = towCache.get(U);
  if (hit) return hit;
  const tow = new SpeedboatTow(U);
  tow.advanceTo(U * 6);
  const hw = (tow as unknown as { hw: HullWater }).hw;
  const rec = new Float64Array(FX_LEN);
  writeBoatFx(hw, tow.pose as never, rec, 0);
  const t = { U, hw, pose: tow.pose, fx: readBoatFx(rec, 0, createBoatFx()) };
  towCache.set(U, t);
  return t;
}

function emittersOf(t: Towed, pose: PlaningPose = t.pose, fx: BoatFx = t.fx): HullSprayEmitter[] {
  const c = planingContact(t.hw.mesh, pose, fx.bow, fx.jets, createPlaningContact());
  const out: HullSprayEmitter[] = [];
  planingSprayEmitters(c, fx.bow, fx.jets, fx.hollow, [], out);
  return out;
}

describe('W9 the planing contact, from pose + shared hull + record, is the physics\' contact', () => {
  it.each([20, 25, 30, 35])('%d m/s: forward wetted keel point, transom immersion and spray root match HullWater.sections', (U) => {
    const t = towed(U);
    const c = planingContact(t.hw.mesh, t.pose, t.fx.bow, t.fx.jets, createPlaningContact());
    expect(c.wet).toBe(true);
    const S = t.hw.sections;
    const Z = t.hw.mesh.strips.zCentre;
    const dz = Math.abs(Z[1] - Z[0]);
    let front = -Infinity;
    for (let i = 0; i < S.count; i++) if (S.wetArea[i] > 0) front = Math.max(front, Z[i]);
    // the forward wetted point lies within one strip of the physics' forward-most wet strip
    expect(Math.abs(c.frontBodyZ - front)).toBeLessThan(dz);
    // transom immersion: the aft strip's keel immersion carried to the transom (≤ 5 cm)
    const dAft = S.d[0] + ((S.d[0] - S.d[1]) * (Z[0] - t.hw.mesh.transomZ)) / (Z[1] - Z[0]);
    expect(Math.abs(c.transomDepth - dAft)).toBeLessThan(0.05);
    // the Wagner root half-beam at the transom: the physics' own sprayRoot, capped at the chine (≤ 15 cm)
    const physRoot = Math.min(t.hw.mesh.strips.chineHalfBeam[0], S.sprayRoot[0]);
    expect(Math.abs(c.rootHalfBeam - physRoot)).toBeLessThan(0.15);
    // planing: the chines run dry at the transom's forward end, the root inside the chine
    expect(c.rootHalfBeam).toBeLessThanOrEqual(c.chineHalfBeam + 1e-9);
  });

  it('a rival gets exactly the hero\'s whitewater (§V110): the emitters depend only on her pose and her record', () => {
    const t = towed(30);
    const base = emittersOf(t);
    expect(base.length).toBe(3);
    // the same boat 120 m east and 45 m south: pose and every world point of her record move, nothing else
    const ox = 120;
    const oz = -45;
    const pose = { position: [t.pose.position[0] + ox, t.pose.position[1], t.pose.position[2] + oz], quaternion: t.pose.quaternion, velocity: t.pose.velocity };
    const fx = createBoatFx();
    const rec = new Float64Array(FX_LEN);
    writeBoatFx(t.hw, t.pose as never, rec, 0);
    readBoatFx(rec, 0, fx);
    fx.bow.x += ox;
    fx.bow.z += oz;
    for (const j of fx.jets) {
      j.x += ox;
      j.z += oz;
    }
    fx.hollow.x += ox;
    fx.hollow.z += oz;
    const moved = emittersOf(t, pose, fx);
    expect(moved.length).toBe(base.length);
    for (let k = 0; k < base.length; k++) {
      expect(moved[k].x - base[k].x).toBeCloseTo(ox, 6);
      expect(moved[k].z - base[k].z).toBeCloseTo(oz, 6);
      for (const key of ['y', 'axisX', 'axisZ', 'length', 'width0', 'width1', 'fill', 'out', 'up', 'along', 'size', 'rate'] as const) {
        expect(moved[k][key]).toBeCloseTo(base[k][key], 6);
      }
    }
  });
});

describe('W9 the disturbance is heavy at race speed, grows with speed, and is physically bounded', () => {
  it('nothing from a boat at displacement speed (the W8 "white as soon as the engine runs" must not return)', () => {
    const t = towed(3);
    expect(t.U).toBeLessThan(PLANING_CONTACT_MIN_SPEED);
    expect(emittersOf(t)).toEqual([]);
  });

  it('the spray-root sheet: thrown outboard and up off the V at the root line\'s reflection, faster and heavier with speed', () => {
    const rows = [20, 25, 30, 35].map((U) => {
      const t = towed(U);
      const c = planingContact(t.hw.mesh, t.pose, t.fx.bow, t.fx.jets, createPlaningContact());
      const l = sheetLaunch(c);
      const sheet = emittersOf(t)[0];
      return { U, l, c, sheet };
    });
    for (const { l, c, sheet } of rows) {
      // the V's geometry: the jet runs up the bottom at the deadrise, so up/out = tan β
      expect(l.up / l.out).toBeCloseTo(Math.tan(c.deadrise), 6);
      // visible (an apex of ≥ 0.2 m) but a sheet, not a plume (≤ 1 m, ≤ 10 m/s outboard)
      const apex = (l.up * l.up) / (2 * GRAVITY);
      expect(apex).toBeGreaterThan(0.2);
      expect(apex).toBeLessThan(1);
      expect(l.out).toBeLessThan(10);
      // left behind in the world: it barely moves forward (U·(1 − cos 2θ) ≪ U)
      expect(l.forward).toBeLessThan(0.1 * rows[0].U);
      // born on the root line: from the keel at the forward wetted point to the root half-beam at the transom
      expect(sheet.width0).toBe(0);
      expect(sheet.width1).toBeCloseTo(c.rootHalfBeam, 9);
      expect(sheet.fill).toBe(0);
    }
    for (let k = 1; k < rows.length; k++) expect(rows[k].l.out).toBeGreaterThan(rows[k - 1].l.out);
    // heavier: the lifted flux (physics) grows from 20 to 35 m/s
    expect(rows[3].sheet.rate).toBeGreaterThan(rows[0].sheet.rate);
  });

  it('the transom boil: the drives throw the hollow\'s water up at the rooster tail\'s heavy fraction, across the hollow, harder with speed', () => {
    const boil = (U: number) => {
      const t = towed(U);
      const e = emittersOf(t)[1];
      const launch = t.fx.jets.reduce((a, j) => a + roosterTailEmission(j, sprayParams).launch, 0) / t.fx.jets.length;
      return { t, e, launch };
    };
    const lo = boil(20);
    const hi = boil(35);
    for (const { t, e, launch } of [lo, hi]) {
      expect(e.fill).toBe(1);
      expect(e.width1).toBeCloseTo(t.fx.hollow.width / 2, 9);
      expect(e.up).toBeCloseTo(Math.max(BOIL_LAUNCH_SHARE * launch, Math.sqrt(2 * GRAVITY * planingContact(t.hw.mesh, t.pose, t.fx.bow, t.fx.jets, createPlaningContact()).transomDepth)), 6);
      // a mound (0.4–2 m), not a second rooster tail
      const apex = (e.up * e.up) / (2 * GRAVITY);
      expect(apex).toBeGreaterThan(0.4);
      expect(apex).toBeLessThan(2);
      expect(e.rate).toBeGreaterThan(0);
    }
    expect(hi.e.up).toBeGreaterThan(lo.e.up);
    expect(hi.e.rate).toBeGreaterThan(lo.e.rate);
  });

  it('the hump: where the hollow closes, its refill plunging at √(2g·d_max) with the plunge entrainment share', () => {
    const t = towed(25);
    const e = emittersOf(t)[2];
    const h = t.fx.hollow;
    const along = (e.x - h.x) * -h.fwdX + (e.z - h.z) * -h.fwdZ;
    expect(along).toBeCloseTo(0.8 * h.length, 6);
    let dMax = 0;
    for (let k = 0; k < HOLLOW_DEPTHS; k++) dMax = Math.max(dMax, h.depths[k]);
    expect(e.up).toBeCloseTo(Math.sqrt(2 * GRAVITY * dMax), 6);
    expect(e.rate).toBeGreaterThan(0);
  });
});

describe('W9 the rooster hump lifts the drawn surface where the hollow closes', () => {
  it('signed jet-type samples centred on the closure, peak lift HUMP_HEIGHT_SHARE of the hollow depth; none without a hollow', () => {
    const t = towed(30);
    const h = t.fx.hollow;
    expect(h.length).toBeGreaterThan(0);
    const lifts = humpSamples(h, 30, []);
    const hollow = hollowSamples(h, []);
    expect(lifts).toBe(3);
    const out: Parameters<typeof humpSamples>[2] = [];
    humpSamples(h, 30, out);
    const dip: Parameters<typeof hollowSamples>[1] = [];
    hollowSamples(h, dip);
    expect(hollow).toBeGreaterThan(0);
    // every hump sample LIFTS (negative load) and lies at/after the closure; the hollow's press (positive) lies before it
    for (const s of out) {
      expect(s.fy).toBeLessThan(0);
      const aft = (s.x - h.x) * -h.fwdX + (s.z - h.z) * -h.fwdZ;
      expect(aft).toBeGreaterThan(0.8 * h.length);
    }
    for (const s of dip) expect(s.fy).toBeGreaterThan(0);
    // the centre sample's head (fy / ρg·dx·w) is the share of the deepest hollow point
    let dMax = 0;
    for (let k = 0; k < HOLLOW_DEPTHS; k++) dMax = Math.max(dMax, h.depths[k]);
    const centre = out[1];
    expect(dryTransomShare(30, h.depths[0])).toBe(1);
    expect(-centre.fy / (WAKE_RHO * GRAVITY * 0.15 * h.length * h.width)).toBeCloseTo(HUMP_HEIGHT_SHARE * dMax, 6);
    // the source buffer keeps the sign of a jet-type sample (a hull sample would clamp it to 0)
    const buf = new WakeSourceBuffer(8);
    buf.pushJet(centre.x, centre.z, centre.fy, centre.footprint, centre.depth);
    expect(buf.jetData[2]).toBeLessThan(0);
    // a wet transom (displacement / semi-planing, Fn_T < 3) makes its stern wave in the solver: no lift
    const slow = towed(5);
    expect(slow.fx.hollow.length).toBeGreaterThan(0);
    expect(humpSamples(slow.fx.hollow, 5, [])).toBe(0);
    expect(humpSamples(towed(3).fx.hollow, 3, [])).toBe(0);
  });
});

describe('W9 the shared whitewater pool: bounded, nearest boat first', () => {
  function recorder() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = { compute: () => {}, render: () => {} };
    return r;
  }
  it('eight boats × three emitters fit the slots; a pool that cannot sustain them all grants the nearest', () => {
    const hs = createHullSpray({ count: 2048 });
    expect(hs.slots).toBe(HULL_SPRAY_SLOTS);
    const t = towed(30);
    const one = emittersOf(t);
    const pack: HullSprayEmitter[] = [];
    for (let b = 0; b < 8; b++) for (const e of one) pack.push({ ...e, x: e.x + 40 * b });
    const total = hs.update(recorder(), pack, { x: t.pose.position[0], y: 2, z: t.pose.position[2] });
    expect(hs.granted.index.length).toBeLessThanOrEqual(HULL_SPRAY_SLOTS);
    expect(total).toBeLessThanOrEqual(2048 / HULL_SPRAY_LOOK.life + 1e-6);
    // the nearest boat's three emitters are granted in full
    const near = hs.granted.index.slice(0, 3).map((i) => pack[i].x).every((x) => Math.abs(x - one[0].x) < 20 || Math.abs(x - one[1].x) < 20);
    expect(near).toBe(true);
    // a non-finite emitter takes no slot
    const bad = { ...one[0], x: Number.NaN };
    hs.update(recorder(), [bad], { x: 0, y: 0, z: 0 });
    expect(hs.granted.index.length).toBe(0);
  });
});
