/**
 * §T.181 S0 hooks — `HullWaterStations`, the contact's per-station views for render-side consumers.
 *
 * WHY each block:
 *  - BURIAL RATE: the sim churn (§T.70) lays foam where the hull's waterplane drives under, at the
 *    rate it does. A view that reported the hull's own vertical speed (not immersion change) would
 *    lay heave foam on a boat riding a swell perfectly (no relative motion, no churn) and none on a
 *    boat sitting still while a crest buries her. A rate that survives a teleport would fire one
 *    tick of 100 m/s churn at every respawn (V108).
 *  - PITCH IS A PLANE: `flowfoam.fitBurialPlane` turns the stations into w = a + b·x + c·z; stations
 *    in the wrong place, or on one side only, give a wrong or degenerate slope.
 *  - WATERLINE: the wetline paints the hull below the ship-local height the sea reached. It must be
 *    the SAME water the contact clipped (V101/V77): checked against the contact's own clipped
 *    waterline segments, and the low side of a heeled hull must be wetter than the high side.
 *  - NO SIDE EFFECTS: the patch's `outside` counter is telemetry the sim worker hashes (B.PATCH_OUTSIDE);
 *    a view that bumped it would make a render consumer change the V2 hash.
 */
import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../src/core/loop';
import { quatFromAxisAngle, quatMul } from '../src/core/quat';
import { fitBurialPlane, type HullBurialInput } from '../src/flowfoam/simFoam';
import { HullWater, HullWaterStations, HULL_WATER_STATION_MAX_RATE, planingSubsteps } from '../src/sea-physics/hullWater';
import { createRigid6Memory, stepRigid6, type Rigid6Load, type Rigid6State } from '../src/sea-physics/rigidBody';
import { buildDeepVHull } from '../src/speedboat/hullMesh';

const hull = buildDeepVHull();

function pose(y = 0.197, q: number[] = [0, 0, 0, 1]): Rigid6State {
  return { position: [3, y, -7], quaternion: q as Rigid6State['quaternion'], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] };
}

/** body point → world (the same rotation the view and the patch use) */
function toWorld(s: Rigid6State, b: { x: number; y: number; z: number }): [number, number, number] {
  const [qx, qy, qz, qw] = s.quaternion;
  const tx = 2 * (qy * b.z - qz * b.y);
  const ty = 2 * (qz * b.x - qx * b.z);
  const tz = 2 * (qx * b.y - qy * b.x);
  return [
    s.position[0] + b.x + qw * tx + (qy * tz - qz * ty),
    s.position[1] + b.y + qw * ty + (qz * tx - qx * tz),
    s.position[2] + b.z + qw * tz + (qx * ty - qy * tx),
  ];
}

describe('HullWaterStations: burial rate is the change of immersion, not the hull speed', () => {
  it('a crest rising 5 cm in a tick under a still hull buries every station at 0.05/dt; the view stays a HullBurialInput', () => {
    const hw = new HullWater(hull);
    const v = new HullWaterStations(hull);
    const s = pose();
    expect(v.stations.length).toBe(2 * hull.strips.count);
    expect(v.stations.filter((p) => p.x < 0).length).toBe(hull.strips.count); // both sides present
    hw.samplePatch(() => 0, s, SIM_DT);
    v.update(hw, s, SIM_DT);
    expect(Array.from(v.rate).every((r) => r === 0)).toBe(true); // first update: no history, no burial
    for (let k = 0; k < v.stations.length; k++) expect(v.depth[k]).toBeCloseTo(-toWorld(s, v.stations[k])[1], 12);
    hw.samplePatch(() => 0.05, s, SIM_DT);
    v.update(hw, s, SIM_DT);
    for (const r of v.rate) expect(r).toBeCloseTo(0.05 / SIM_DT, 9);
    const input: HullBurialInput = v; // structural: flowfoam reads it with no adapter
    v.inContact = true;
    const plane = fitBurialPlane(input);
    expect(plane.a).toBeCloseTo(0.05 / SIM_DT, 9);
    expect(Math.abs(plane.b) + Math.abs(plane.c)).toBeLessThan(1e-9);
    expect(plane.rimLength).toBeGreaterThan(0.3);
  });

  it('a hull riding the swell exactly (sea and hull rise together) has zero burial; a hull rising out of still water emerges', () => {
    const hw = new HullWater(hull);
    const v = new HullWaterStations(hull);
    hw.samplePatch(() => 0.1, pose(0.3), SIM_DT);
    v.update(hw, pose(0.3), SIM_DT);
    hw.samplePatch(() => 0.2, pose(0.4), SIM_DT);
    v.update(hw, pose(0.4), SIM_DT);
    for (const r of v.rate) expect(Math.abs(r)).toBeLessThan(1e-9);
    hw.samplePatch(() => 0.2, pose(0.43), SIM_DT);
    v.update(hw, pose(0.43), SIM_DT);
    for (const r of v.rate) expect(r).toBeCloseTo(-0.03 / SIM_DT, 9);
  });

  it('bow-down pitch about the CG buries the bow and lifts the stern: the fitted plane slopes along the hull', () => {
    const hw = new HullWater(hull);
    const v = new HullWaterStations(hull);
    const level = pose();
    // body +z forward = world +z at identity; a rotation about +x by +θ tips +z toward −y (bow down)
    const pitched = pose(0.197, quatFromAxisAngle([1, 0, 0], 0.01));
    hw.samplePatch(() => 0, level, SIM_DT);
    v.update(hw, level, SIM_DT);
    hw.samplePatch(() => 0, pitched, SIM_DT);
    v.update(hw, pitched, SIM_DT);
    v.inContact = true;
    const plane = fitBurialPlane(v);
    const bow = v.stations.reduce((a, p, k) => (p.z > v.stations[a].z ? k : a), 0);
    const stern = v.stations.reduce((a, p, k) => (p.z < v.stations[a].z ? k : a), 0);
    expect(v.rate[bow]).toBeGreaterThan(0);
    expect(v.rate[stern]).toBeLessThan(0);
    // w(z) ≈ θ̇·(z − z_cg): the plane's world-z slope is the pitch rate
    expect(plane.c).toBeCloseTo(0.01 / SIM_DT, 2);
  });

  it('V108: a teleport reports no data off the old patch, and reset() then a fresh patch gives rate 0 — never a 100 m/s spike', () => {
    const hw = new HullWater(hull);
    const v = new HullWaterStations(hull);
    const s = pose();
    hw.samplePatch(() => 0, s, SIM_DT);
    v.update(hw, s, SIM_DT);
    const far = pose(5);
    far.position[0] += 120;
    v.update(hw, far, SIM_DT); // the hull was placed, the patch is last tick's
    expect(Array.from(v.rate).every(Number.isNaN)).toBe(true);
    expect(Array.from(v.waterlineY).every(Number.isNaN)).toBe(true);
    v.reset();
    hw.samplePatch(() => 0, far, SIM_DT);
    v.update(hw, far, SIM_DT);
    expect(Array.from(v.rate).every((r) => r === 0)).toBe(true);
    // and a real burial is clamped to the contact model's bound, not passed through
    hw.samplePatch(() => 50, far, SIM_DT);
    v.update(hw, far, SIM_DT);
    for (const r of v.rate) expect(r).toBe(HULL_WATER_STATION_MAX_RATE);
  });

  it('reading the view leaves the patch telemetry exactly as the contact left it', () => {
    const hw = new HullWater(hull);
    const v = new HullWaterStations(hull);
    const s = pose();
    hw.samplePatch(() => 0, s, SIM_DT);
    hw.patch.outside = 7;
    const off = pose();
    off.position[2] += 3; // stations partly off the patch: heightAt would count misses
    v.update(hw, off, SIM_DT);
    expect(hw.patch.outside).toBe(7);
  });
});

describe('HullWaterStations: the waterline is the contact\'s own water', () => {
  it('settled at rest on flat water, the station waterline matches the clipped waterline segments (≤ 1 cm) on both sides', () => {
    const hw = new HullWater(hull);
    const v = new HullWaterStations(hull);
    const s = pose(0.25);
    const memory = createRigid6Memory();
    const force = (st: Readonly<Rigid6State>, h: number, out: Rigid6Load): void => hw.evaluate(st, h, out);
    for (let k = 0; k < 360; k++) {
      hw.samplePatch(() => 0, s, SIM_DT);
      stepRigid6(s, hull, SIM_DT, planingSubsteps(hw, s, SIM_DT), force, memory);
    }
    // one more patch + evaluate AT the final pose, so the segments and the view see one pose
    hw.samplePatch(() => 0, s, SIM_DT);
    hw.evaluate(s, SIM_DT / 2, { force: [0, 0, 0], torque: [0, 0, 0], addedMass: [0, 0, 0], addedInertia: [0, 0, 0] });
    v.update(hw, s, SIM_DT);
    expect(v.inContact).toBe(true);
    // segments → body frame (inverse rotation)
    const [qx, qy, qz, qw] = s.quaternion;
    const inv = { position: [0, 0, 0], quaternion: [-qx, -qy, -qz, qw] } as unknown as Rigid6State;
    const seg: { a: [number, number, number]; b: [number, number, number] }[] = [];
    const W = hw.waterline;
    for (let j = 0; j < W.count; j++) {
      const rel = (o: number) => ({ x: W.a[o] - s.position[0], y: W.a[o + 1] - s.position[1], z: W.a[o + 2] - s.position[2] });
      const relB = (o: number) => ({ x: W.b[o] - s.position[0], y: W.b[o + 1] - s.position[1], z: W.b[o + 2] - s.position[2] });
      seg.push({ a: toWorld(inv, rel(j * 3)), b: toWorld(inv, relB(j * 3)) });
    }
    let compared = 0;
    for (let k = 0; k < v.stations.length; k++) {
      const st = v.stations[k];
      let best = -Infinity;
      for (const { a, b } of seg) {
        if (Math.sign(a[0] + b[0]) !== Math.sign(st.x) || Math.abs(b[2] - a[2]) < 1e-6) continue;
        const t = (st.z - a[2]) / (b[2] - a[2]);
        if (t < 0 || t > 1) continue;
        best = Math.max(best, a[1] + t * (b[1] - a[1]));
      }
      if (!Number.isFinite(best)) continue;
      compared++;
      expect(Math.abs(v.waterlineY[k] - best), `station ${k} z ${st.z.toFixed(2)}`).toBeLessThan(0.01);
    }
    expect(compared).toBeGreaterThanOrEqual(hull.strips.count); // most of the hull is wet at rest
  });

  it('on a sloping sea under a heeled hull the waterline follows the LEANING body-vertical line (bisection reference, ≤ 1 mm)', () => {
    const hw = new HullWater(hull);
    const v = new HullWaterStations(hull);
    const heel = 0.3;
    const s = pose(0.1, quatFromAxisAngle([0, 0, 1], heel));
    const sea = (x: number): number => 0.25 * (x - s.position[0]); // a plane: the bilinear patch is exact on it
    hw.samplePatch((x) => sea(x), s, SIM_DT);
    v.update(hw, s, SIM_DT);
    for (let k = 0; k < v.stations.length; k++) {
      const st = v.stations[k];
      const gap = (y: number): number => {
        const w = toWorld(s, { x: st.x, y, z: st.z });
        return sea(w[0]) - w[1];
      };
      let lo = -3;
      let hi = 3;
      for (let it = 0; it < 80; it++) {
        const mid = (lo + hi) / 2;
        if (gap(lo) * gap(mid) <= 0) hi = mid;
        else lo = mid;
      }
      expect(Math.abs(v.waterlineY[k] - (lo + hi) / 2), `station ${k}`).toBeLessThan(1e-3);
    }
  });

  it('heeled to port, the port (low) side reads a higher ship-local waterline than starboard, by ≈ beam·sin(heel)', () => {
    const hw = new HullWater(hull);
    const v = new HullWaterStations(hull);
    const heel = 0.08;
    // rotation about +z by +heel carries +x up, so the −x side is the low one
    const s = pose(0.197, quatMul(quatFromAxisAngle([0, 0, 1], heel), [0, 0, 0, 1]));
    hw.samplePatch(() => 0, s, SIM_DT);
    v.update(hw, s, SIM_DT);
    const tipLow = toWorld(s, { x: -1, y: 0, z: 0 })[1];
    expect(tipLow).toBeLessThan(s.position[1]); // −x is indeed the low side
    for (let st = 0; st < hull.strips.count; st++) {
      const lo = v.waterlineY[2 * st];
      const hi = v.waterlineY[2 * st + 1];
      const dx = v.stations[2 * st + 1].x - v.stations[2 * st].x;
      expect(lo - hi).toBeCloseTo(dx * Math.tan(heel), 3);
    }
  });
});
