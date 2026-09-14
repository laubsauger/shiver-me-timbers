/**
 * §T.188 CRASHES, RESPAWN, DAMAGE — WHY these tests (docs/speedboat/crash.md):
 *
 *  - A crash call that comes late reads as the game ignoring the wreck; one that comes during a clean lap is the game
 *    stealing a race. So every kind is timed against its PHYSICAL onset — a geometric fact measured independently of
 *    the detector (heel/slip past 45° for a hook, green water on the foredeck, bow-up past 45° in the air, past 90° of
 *    tilt) — and a clean Working-sea run with the Default assists must raise nothing.
 *  - A wreck that can sail on should sail on (recover in place); a capsized or smashed one must come back on the line,
 *    ghosted, and the move must not drag any memory of the crash site with it (V108: no slam from nowhere, no spin,
 *    afloat at once).
 *  - Damage is cosmetic but must land where the hull was hit.
 *
 * All physics runs are REAL: rigid6 + HullWater on deepV12 (+ boatCollide where something is hit).
 */
import { describe, expect, it } from 'vitest';
import { oceanParams } from '../src/params/ocean';
import { seaPhysicsParams } from '../src/params/seaPhysics';
import { CpuOcean } from '../src/sea-physics/cpuOcean';
import {
  beginContactTick,
  buildCollisionHull,
  collideBoatWithWorld,
  createBoatCollideMemory,
  prepareStaticWorld,
  resetBoatCollideMemory,
  type BoatCollideMemory,
  type StaticWorld,
} from '../src/sea-physics/boatCollide';
import { HullWater, type HeightSampler, type HullWaterParams } from '../src/sea-physics/hullWater';
import { createRigid6Memory, resetRigid6Memory, stepRigid6, type Rigid6Memory, type Rigid6State } from '../src/sea-physics/rigidBody';
import { ASSIST_PRESETS, createAssistState, readBoatSim, stepAssists } from '../src/speedboat/assists';
import { neutralBoatInput } from '../src/speedboat/controls/boatInput';
import {
  addContactDamage,
  addCrashDamage,
  assertTeleportFirstTick,
  createCrashDetectMemory,
  createCrashMachine,
  createCrashSensors,
  createDamage,
  CRASH_TIMINGS,
  damageFeatures,
  damageGeometryFor,
  designRespawnSpeed,
  detectCrash,
  measureCrashSensors,
  resetDamage,
  restCgHeight,
  stepCrashMachine,
  teleportBoat,
  updateCrashDetectMemory,
  ZONE,
  type CrashDeps,
  type CrashEvent,
  type CrashKind,
  type CrashMachine,
  type CrashSensors,
} from '../src/speedboat/crash';
import { buildDeepVHull } from '../src/speedboat/hullMesh';
import type { Quat, Vec3 } from '../src/state/simState';

const DT = 1 / 60;
const G = 9.81;
const FLAT: HeightSampler = () => 0;
const hull = buildDeepVHull();
const ch = buildCollisionHull(hull);
const LOCK = hull.drives[0].maxSteerRad;
const BEAM = 2.3;
const DEG = Math.PI / 180;

interface Rig {
  s: Rigid6State;
  hw: HullWater;
  mem: Rigid6Memory;
  cm: BoatCollideMemory;
  sensors: CrashSensors;
  time: number;
}

function rig(s: Rigid6State, params: Partial<HullWaterParams> = {}): Rig {
  return { s, hw: new HullWater(hull, params), mem: createRigid6Memory(), cm: createBoatCollideMemory(ch), sensors: createCrashSensors(), time: 0 };
}

const st = (p: Vec3, q: Quat, v: Vec3, w: Vec3 = [0, 0, 0]): Rigid6State => ({ position: [...p] as Vec3, quaternion: [...q] as Quat, velocity: [...v] as Vec3, angularVelocity: [...w] as Vec3 });
const pitchQ = (bowUpDeg: number): Quat => [Math.sin((-bowUpDeg * DEG) / 2), 0, 0, Math.cos((-bowUpDeg * DEG) / 2)];

/** one fixed tick: contacts → controls → patch → step → sensors (the page's order, crash hook after the step) */
function step(r: Rig, steerRad: number, throttle: number, sea: HeightSampler = FLAT, world: StaticWorld | null = null): CrashSensors {
  beginContactTick(r.cm);
  if (world) collideBoatWithWorld(r.s, ch, world, null, DT, r.cm);
  r.hw.setControls(steerRad, throttle);
  r.hw.samplePatch(sea, r.s, DT);
  stepRigid6(r.s, hull, DT, 2, (ss, h, out) => r.hw.evaluate(ss, h, out), r.mem);
  r.time += DT;
  return measureCrashSensors(
    r.s,
    { bowDeck: ch.bowDeck, wettedArea: r.hw.wettedArea, waterHeightAt: (x, z) => r.hw.patch.heightAt(x, z), contactDeltaV: r.cm.report.maxDeltaV, contactSource: r.cm.report.source },
    r.sensors,
  );
}

/** run a scenario; returns the first detection time and kind, and the first time `onset` held */
function timeline(r: Rig, seconds: number, control: (t: number, s: Rigid6State) => [number, number], onset: (s: CrashSensors, r: Rig) => boolean, opts: { sea?: HeightSampler; world?: StaticWorld; from?: number } = {}): { detectT: number; kind: CrashKind | null; onsetT: number } {
  const dm = createCrashDetectMemory();
  let detectT = -1;
  let kind: CrashKind | null = null;
  let onsetT = -1;
  for (let k = 0; k < seconds * 60; k++) {
    const [steer, thr] = control(r.time, r.s);
    const s = step(r, steer, thr, opts.sea, opts.world ?? null);
    updateCrashDetectMemory(dm, s, DT);
    if (r.time < (opts.from ?? 0)) continue;
    if (onsetT < 0 && onset(s, r)) onsetT = r.time;
    const d = detectCrash(s, dm);
    if (detectT < 0 && d) {
      detectT = r.time;
      kind = d;
    }
    if (detectT >= 0 && onsetT >= 0 && r.time > Math.max(detectT, onsetT) + 0.6) break;
  }
  return { detectT, kind, onsetT };
}

/** the T179 turning harness: speed held 12 s at C_v, then the helm goes over at 30°/s with the throttle frozen */
function turnScenario(cv: number, lockFraction: number): { r: Rig; control: (t: number, s: Rigid6State) => [number, number]; helmAt: number } {
  const U = cv * Math.sqrt(G * BEAM);
  const r = rig(st([0, 0.35, 0], [-Math.sin(0.02), 0, 0, Math.cos(0.02)], [0, 0, U]), { standInDrivePowerW: 4e6 });
  let integ = 0;
  let thrSum = 0;
  let n = 0;
  const T1 = 12;
  return {
    r,
    helmAt: T1,
    control: (t, s) => {
      if (t < T1) {
        const err = U - Math.hypot(s.velocity[0], s.velocity[2]);
        integ += err * DT;
        const thr = Math.max(0, Math.min(1, 0.3 + 0.3 * err + 0.1 * integ));
        if (t > T1 - 3) {
          thrSum += thr;
          n++;
        }
        return [0, thr];
      }
      return [Math.min(lockFraction * LOCK, (t - T1) * 30 * DEG), thrSum / n];
    },
  };
}

describe('§T.188 crash detection: every kind within 0.5 s of its physical onset', () => {
  it('HOOK — full lock at C_v 5 and 8 (onset: heel or slip past 45°, the T179 departure)', () => {
    for (const cv of [5, 8]) {
      const { r, control, helmAt } = turnScenario(cv, 1);
      const tl = timeline(r, helmAt + 6, control, (s) => Math.abs(s.heelDeg) > 45 || s.slipDeg > 45, { from: helmAt });
      expect(tl.onsetT, `C_v ${cv}: she departs`).toBeGreaterThan(0);
      expect(tl.kind, `C_v ${cv}`).toBe('hook');
      // + 1e-9: both times are tick counts × 1/60; exactly 30 ticks apart reads 0.5000000000000249 (T196: C_v 5 on T189)
      expect(Math.abs(tl.detectT - tl.onsetT), `C_v ${cv}: detect ${tl.detectT.toFixed(2)} vs onset ${tl.onsetT.toFixed(2)}`).toBeLessThanOrEqual(0.5 + 1e-9);
    }
  });

  it('…and a steady hard turn is not a hook: half lock at C_v 4 and 6, full lock at C_v 3 (a 12 m/s stumble)', () => {
    for (const [cv, frac] of [[4, 0.5], [6, 0.5], [3, 1]] as const) {
      const { r, control, helmAt } = turnScenario(cv, frac);
      const tl = timeline(r, helmAt + 8, control, () => false, { from: helmAt });
      expect(tl.kind, `C_v ${cv} lock ${frac}`).toBe(null);
    }
  });

  it('STUFF — a 30 m/s bow-down entry pitchpoles (onset: the foredeck under water above 12 m/s)', () => {
    // the bow is still FALLING (0.5 rad/s, off a crest) as it meets the water. T196: a −10° entry with no pitch rate no
    // longer stuffs on the T189 physics — its pitchpole was driven by planing lift on the aft sections of a bottom
    // withdrawing along its normal, a lift with a forward (thrust) component that T189's passivity bound removes; the
    // model now needs the foredeck actually driven under (−15° static, or −10° with this rate; the pre-T189 physics
    // stuffs this entry too, at the same 0.20 s)
    const r = rig(st([0, 0.6, 0], pitchQ(-10), [0, -2, 30], [0.5, 0, 0]));
    const tl = timeline(r, 3, () => [0, 0.5], (s) => s.bowImmersion > 0 && s.speed > 12);
    expect(tl.kind).toBe('stuff');
    expect(tl.detectT - tl.onsetT, `detect ${tl.detectT.toFixed(2)} vs onset ${tl.onsetT.toFixed(2)}`).toBeLessThanOrEqual(0.5);
    expect(tl.detectT).toBeGreaterThanOrEqual(tl.onsetT);
  });

  it('BLOW-OVER — launched bow-up off a crest (onset: bow-up past 45° while airborne)', () => {
    const r = rig(st([0, 2.5, 0], pitchQ(25), [0, 5, 35], [-1.5, 0, 0]));
    const tl = timeline(r, 2, () => [0, 0.8], (s) => s.wettedArea < 0.5 && s.pitchDeg > 45);
    expect(tl.kind).toBe('blowOver');
    expect(Math.abs(tl.detectT - tl.onsetT), `detect ${tl.detectT.toFixed(2)} vs onset ${tl.onsetT.toFixed(2)}`).toBeLessThanOrEqual(0.5);
  });

  it('BARREL ROLL — a roll kick in the air (onset: tilt past 90°)', () => {
    const r = rig(st([0, 2.5, 0], [0, 0, 0, 1], [0, 6, 30], [0, 0, 5]));
    const tl = timeline(r, 2, () => [0, 0.5], (s) => s.tiltDeg > 90);
    expect(tl.kind).toBe('barrelRoll');
    expect(Math.abs(tl.detectT - tl.onsetT), `detect ${tl.detectT.toFixed(2)} vs onset ${tl.onsetT.toFixed(2)}`).toBeLessThanOrEqual(0.5);
  });

  it('IMPACT — into a pylon at 20 m/s on the contact tick; a flexible gate pole and a 3 m/s nudge are not crashes', () => {
    const pylon = prepareStaticWorld([{ a: [0, -4, 30], b: [0, 6, 30], radius: 0.4 }]);
    const r = rig(st([0, 0.2, 0], [0, 0, 0, 1], [0, 0, 20]));
    const tl = timeline(r, 3, () => [0, 0.5], (_s, rr) => rr.cm.report.count > 0, { world: pylon });
    expect(tl.kind).toBe('impact');
    expect(tl.detectT).toBe(tl.onsetT);

    const gate = prepareStaticWorld([{ a: [0.5, -4, 30], b: [0.5, 6, 30], radius: 0.15, flexible: true }]);
    const g = timeline(rig(st([0, 0.2, 0], [0, 0, 0, 1], [0, 0, 20])), 3, () => [0, 0.5], () => false, { world: gate });
    expect(g.kind, 'flexible pole').toBe(null);

    const nudge = timeline(rig(st([0, 0.2, 26], [0, 0, 0, 1], [0, 0, 3])), 3, () => [0, 0], () => false, { world: pylon });
    expect(nudge.kind, '3 m/s nudge').toBe(null);
  });

  it('no false positives: 60 s of Working sea (the default preset), assists Default, throttle 0.6 and a weaving helm', () => {
    // First the run must BE clean by physical standards (else a real crash would be blamed on the detector):
    // never past 60° of tilt, 45° of heel or slip, 45° of pitch. Measured (seed 188): tilt 35.5°, heel 35°, slip 6°,
    // pitch 19°. NOTE (reported, physics/assists): the same helm at throttle 0.8 capsizes at ≈ 50 s (seed 188) and
    // ≈ 21 s (seed 7) — the detector calls those barrelRoll, correctly; they are not clean laps.
    const ocean = new CpuOcean(188, structuredClone(oceanParams), { ...structuredClone(seaPhysicsParams), hullDraft: 0.54 });
    const r = rig(st([0, 0.2, 0], [0, 0, 0, 1], [0, 0, 5]));
    const sea: HeightSampler = (x, z) => ocean.pressureHeadAt(x, z, r.time);
    const assist = createAssistState();
    const input = neutralBoatInput();
    const sim = readBoatSim(r.hw, r.s);
    const dm = createCrashDetectMemory();
    const worst = { tilt: 0, heel: 0, slip: 0, pitch: 0 };
    const fired: string[] = [];
    for (let k = 0; k < 60 * 60; k++) {
      ocean.update(r.time + DT);
      input.throttle = 0.6;
      input.steer = 0.1 * Math.sin(r.time * 0.35);
      readBoatSim(r.hw, r.s, sim);
      const cmd = stepAssists(input, sim, ASSIST_PRESETS.default, assist, DT, LOCK);
      const s = step(r, cmd.steerRad, cmd.throttle, sea);
      updateCrashDetectMemory(dm, s, DT);
      worst.tilt = Math.max(worst.tilt, s.tiltDeg);
      worst.heel = Math.max(worst.heel, Math.abs(s.heelDeg));
      worst.slip = Math.max(worst.slip, s.slipDeg);
      worst.pitch = Math.max(worst.pitch, Math.abs(s.pitchDeg));
      const d = detectCrash(s, dm);
      if (d) fired.push(`${d}@${r.time.toFixed(2)}`);
    }
    // eslint-disable-next-line no-console
    console.info('[crash] clean Working-sea run maxima', Object.fromEntries(Object.entries(worst).map(([k, v]) => [k, v.toFixed(1)])));
    expect(worst.tilt, 'the PHYSICS stayed upright (else this is a real crash, not a false positive)').toBeLessThan(60);
    expect(worst.heel).toBeLessThan(45);
    expect(worst.slip).toBeLessThan(45);
    expect(worst.pitch).toBeLessThan(45);
    expect(fired).toEqual([]);
  }, 60_000);
});

// ── the state machine ────────────────────────────────────────────────────────────────────────

interface Run {
  r: Rig;
  m: CrashMachine;
  events: { t: number; e: CrashEvent }[];
  firstTickSlam: number[];
  teleportPose: Rigid6State | null;
}

const CG_ABOVE_WATER = restCgHeight(hull);

function machineRun(r: Rig, seconds: number, control: (t: number) => [number, number], opts: { world?: StaticWorld; autoReset?: boolean; resetHullWater?: boolean } = {}): Run {
  const m = createCrashMachine();
  const events: { t: number; e: CrashEvent }[] = [];
  const out: Run = { r, m, events, firstTickSlam: [], teleportPose: null };
  let justTeleported = false;
  const deps: CrashDeps = {
    // stand-in for the race logic: 60 m back along the crash heading, at the design respawn speed
    respawn: (q) => ({ x: q.crashPosition[0] - 60 * Math.sin(q.crashHeading), z: q.crashPosition[2] - 60 * Math.cos(q.crashHeading), heading: q.crashHeading, speed: designRespawnSpeed(q.speedBeforeCrash) }),
    teleport: (pose) => {
      teleportBoat({ state: r.s, rigidMemory: r.mem, hullWater: opts.resetHullWater === false ? { resetMemory: () => undefined } : r.hw, extra: [{ resetMemory: () => resetBoatCollideMemory(r.cm) }] }, pose);
      out.teleportPose = st(pose.position as Vec3, pose.quaternion as Quat, pose.velocity as Vec3, pose.angularVelocity as Vec3);
      justTeleported = true;
    },
    waterHeightAt: () => 0,
    cgAboveWater: CG_ABOVE_WATER,
    damageGeometry: damageGeometryFor(ch),
  };
  for (let k = 0; k < seconds * 60; k++) {
    const [steer, thr] = control(r.time);
    const o = m.out;
    beginContactTick(r.cm);
    if (opts.world) collideBoatWithWorld(r.s, ch, opts.world, null, DT, r.cm);
    r.hw.setControls(steer * o.steerScale, thr * o.throttleScale);
    r.hw.samplePatch(FLAT, r.s, DT);
    let first = true;
    stepRigid6(
      r.s,
      hull,
      DT,
      2,
      (ss, h, load) => {
        r.hw.evaluate(ss, h, load);
        if (justTeleported && first) out.firstTickSlam.push(r.hw.slamImpulse);
        first = false;
      },
      r.mem,
    );
    if (justTeleported) {
      out.firstTickSlam.push(r.hw.slamImpulse);
      justTeleported = false;
    }
    r.time += DT;
    const s = measureCrashSensors(r.s, { bowDeck: ch.bowDeck, wettedArea: r.hw.wettedArea, waterHeightAt: (x, z) => r.hw.patch.heightAt(x, z), contactDeltaV: r.cm.report.maxDeltaV, contactSource: r.cm.report.source }, r.sensors);
    const before = events.length;
    const tmp: CrashEvent[] = [];
    stepCrashMachine(m, { dt: DT, state: r.s, sensors: s, contactPoint: r.cm.report.bodyPoint, contactOther: r.cm.report.other, overlapsBoat: false, autoReset: opts.autoReset ?? true, resetRequested: false }, deps, tmp);
    for (const e of tmp) events.push({ t: r.time, e });
    void before;
  }
  return out;
}

const eventTypes = (run: Run): string[] => run.events.map((x) => (x.e.type === 'crash' ? `crash:${x.e.kind}` : x.e.type)).filter((t) => t !== 'impact');
const at = (run: Run, type: string): number => run.events.find((x) => x.e.type === type)?.t ?? -1;

describe('§T.188 crash state machine: recover in place or respawn on the line', () => {
  it('a 5 m/s nose into a pylon leg is a crash she sails away from: recovered in place, never respawned', () => {
    // measured: the bow's |Δv| is ≈ 8.4 m/s (the pitching bow closes faster than the CG) — an impact, below 20 kn.
    // Throttle 0.8 (T196, was 0.3): on the T189 engine model 0.3 no longer accelerates her off 5 m/s through the hump
    // (φ = 0.3^1.6 of WOT torque); she drifted in at 2.3 m/s, |Δv| 2.4, no crash. 0.8 arrives as 0.3 did on the stand-in.
    const pylon = prepareStaticWorld([{ a: [0, -4, 20], b: [0, 6, 20], radius: 0.4 }]);
    const run = machineRun(rig(st([0, 0.2, 0], [0, 0, 0, 1], [0, 0, 5])), 6, () => [0, 0.8], { world: pylon });
    expect(eventTypes(run)).toEqual(['crash:impact', 'recovered']);
    const tRec = at(run, 'recovered') - at(run, 'crash');
    expect(tRec).toBeGreaterThanOrEqual(CRASH_TIMINGS.recoverMinTime + CRASH_TIMINGS.recoverHold - 1e-9);
    expect(tRec).toBeLessThanOrEqual(CRASH_TIMINGS.crashWindow);
    expect(run.m.phase).toBe('racing');
  });

  it('a capsize respawns: 1.2 s upside down → 0.4 s fade → teleport → 2 s ghost → racing, ~4 s in all', () => {
    const run = machineRun(rig(st([0, 2.5, 0], [0, 0, 0, 1], [0, 6, 30], [0, 0, 5])), 8, () => [0, 0.5]);
    expect(eventTypes(run)).toEqual(['crash:barrelRoll', 'respawnStart', 'teleport', 'respawnEnd']);
    const crash = at(run, 'crash');
    const start = at(run, 'respawnStart');
    const tp = at(run, 'teleport');
    const end = at(run, 'respawnEnd');
    expect(start - crash).toBeLessThanOrEqual(CRASH_TIMINGS.crashWindow + DT + 1e-9);
    expect(tp - start).toBeCloseTo(CRASH_TIMINGS.fadeOut, 1);
    expect(end - tp).toBeCloseTo(CRASH_TIMINGS.ghost, 1);
    // design doc: crash → racing again in 4–6 s including the lost ground; the machine's own part stays under that
    expect(end - crash).toBeLessThan(6);
  });

  it('a structure hit above 20 kn respawns after the crash has been shown (1.2 s), even though she floats upright', () => {
    const pylon = prepareStaticWorld([{ a: [0, -4, 30], b: [0, 6, 30], radius: 0.4 }]);
    const run = machineRun(rig(st([0, 0.2, 0], [0, 0, 0, 1], [0, 0, 20])), 4, () => [0, 0.5], { world: pylon });
    expect(eventTypes(run).slice(0, 2)).toEqual(['crash:impact', 'respawnStart']);
    expect(at(run, 'respawnStart') - at(run, 'crash')).toBeCloseTo(CRASH_TIMINGS.structureShowFor, 1);
  });

  it('Pro (autoReset off): a capsized boat stays crashed — nothing teleports without the pilot asking', () => {
    const run = machineRun(rig(st([0, 2.5, 0], [0, 0, 0, 1], [0, 6, 30], [0, 0, 5])), 6, () => [0, 0.5], { autoReset: false });
    expect(eventTypes(run)).toEqual(['crash:barrelRoll']);
    expect(run.m.phase).toBe('crashed');
  });

  it('input is cut while crashed and the engine re-fires 1.5 s after the crash (Governor fuel cut)', () => {
    const buoy = prepareStaticWorld([{ a: [0, -4, 20], b: [0, 6, 20], radius: 0.4 }]);
    const r = rig(st([0, 0.2, 0], [0, 0, 0, 1], [0, 0, 5]));
    const m = createCrashMachine();
    const deps: CrashDeps = { respawn: () => ({ x: 0, z: 0, heading: 0, speed: 13 }), teleport: () => undefined, waterHeightAt: () => 0, cgAboveWater: CG_ABOVE_WATER, damageGeometry: damageGeometryFor(ch) };
    let crashT = -1;
    let refire = -1;
    for (let k = 0; k < 360; k++) {
      beginContactTick(r.cm);
      collideBoatWithWorld(r.s, ch, buoy, null, DT, r.cm);
      r.hw.setControls(0, 0.8 * m.out.throttleScale); // 0.8: the pylon test's approach (T196 note there)
      r.hw.samplePatch(FLAT, r.s, DT);
      stepRigid6(r.s, hull, DT, 2, (ss, h, load) => r.hw.evaluate(ss, h, load), r.mem);
      r.time += DT;
      const s = measureCrashSensors(r.s, { bowDeck: ch.bowDeck, wettedArea: r.hw.wettedArea, waterHeightAt: () => 0, contactDeltaV: r.cm.report.maxDeltaV, contactSource: r.cm.report.source }, r.sensors);
      const ev: CrashEvent[] = [];
      stepCrashMachine(m, { dt: DT, state: r.s, sensors: s, contactPoint: r.cm.report.bodyPoint, contactOther: -1, overlapsBoat: false, autoReset: true, resetRequested: false }, deps, ev);
      if (ev.some((e) => e.type === 'crash')) crashT = r.time;
      if (crashT >= 0 && m.phase === 'crashed') expect(m.out.throttleScale + m.out.steerScale).toBe(0);
      if (crashT >= 0 && refire < 0 && m.out.throttleScale === 1) refire = r.time;
    }
    expect(crashT).toBeGreaterThan(0);
    expect(refire - crashT).toBeGreaterThanOrEqual(CRASH_TIMINGS.stall - 1e-9);
  });

  it('a ghost stays a ghost while it overlaps a boat, and ends as soon as it is clear', () => {
    const m = createCrashMachine();
    m.phase = 'ghost';
    const sensors = createCrashSensors();
    sensors.wettedArea = 10;
    const s = st([0, 0.2, 0], [0, 0, 0, 1], [0, 0, 13]);
    const deps: CrashDeps = { respawn: () => ({ x: 0, z: 0, heading: 0, speed: 13 }), teleport: () => undefined, waterHeightAt: () => 0, cgAboveWater: 0.24, damageGeometry: damageGeometryFor(ch) };
    const ev: CrashEvent[] = [];
    let t = 0;
    for (; t < 3; t += DT) stepCrashMachine(m, { dt: DT, state: s, sensors, contactPoint: [0, 0, 0], contactOther: -1, overlapsBoat: true, autoReset: true, resetRequested: false }, deps, ev);
    expect(m.phase, 'still overlapping after 3 s').toBe('ghost');
    expect(m.out.ghost).toBe(true);
    stepCrashMachine(m, { dt: DT, state: s, sensors, contactPoint: [0, 0, 0], contactOther: -1, overlapsBoat: false, autoReset: true, resetRequested: false }, deps, ev);
    expect(m.phase).toBe('racing');
    expect(ev.map((e) => e.type)).toEqual(['respawnEnd']);
  });
});

describe('§T.188 teleport contract (V108)', () => {
  it('the respawn lands clean: no slam on the first tick, exactly the commanded velocity and no spin, afloat and level within 0.5 s', () => {
    const run = machineRun(rig(st([0, 2.5, 0], [0, 0, 0, 1], [0, 6, 30], [0, 0, 5])), 5, () => [0, 0.5]);
    const tp = run.events.find((x) => x.e.type === 'teleport');
    expect(tp, 'respawned').toBeDefined();
    const pose = run.teleportPose!;
    expect(pose.angularVelocity).toEqual([0, 0, 0]);
    expect(pose.velocity[1]).toBe(0);
    expect(Math.hypot(pose.velocity[0], pose.velocity[2])).toBeCloseTo(designRespawnSpeed(run.m.speedBeforeCrash), 9);
    // first evaluate after the reset exchanges nothing; the whole first tick is within round-off
    expect(run.firstTickSlam[0]).toBe(0);
    expect(() => assertTeleportFirstTick({ slamImpulse: run.firstTickSlam[run.firstTickSlam.length - 1] })).not.toThrow();
  });

  it('afloat within 0.5 s of the move: heave rate < 0.5 m/s, tilt < 5°, CG within 0.3 m of the placement height', () => {
    const r = rig(st([5, 0.4, 3], [0, 0, 1, 0], [1, 0, 2], [0.3, 0.2, -0.4]));
    for (let k = 0; k < 30; k++) step(r, 0, 0); // wallowing upside down: every memory full of the wreck
    const pose = st([200, CG_ABOVE_WATER, -40], [0, Math.sin(0.4), 0, Math.cos(0.4)], [13 * Math.sin(0.8), 0, 13 * Math.cos(0.8)]);
    teleportBoat({ state: r.s, rigidMemory: r.mem, hullWater: r.hw }, pose);
    for (let k = 0; k < 30; k++) step(r, 0, 0.5);
    expect(Math.abs(r.s.velocity[1])).toBeLessThan(0.5);
    expect(r.sensors.tiltDeg).toBeLessThan(5);
    expect(Math.abs(r.s.position[1] - CG_ABOVE_WATER)).toBeLessThan(0.3);
  });

  it('WHY the hull-water reset is in the contract: a boat dropped in without it slams on its very first evaluate', () => {
    // a respawn pose is level and still; this pose drops in at 1.5 m/s so the carried dm_a/dt has something to act on
    const drop = (reset: boolean): number => {
      const r = rig(st([0, 3, 0], [0, 0, 0, 1], [0, 2, 30])); // airborne: the contact remembers a dry hull
      for (let k = 0; k < 20; k++) step(r, 0, 0.5);
      const pose = st([300, 0.1, 0], [0, 0, 0, 1], [0, -1.5, 13]);
      if (reset) teleportBoat({ state: r.s, rigidMemory: r.mem, hullWater: r.hw }, pose);
      else {
        teleportBoat({ state: r.s, rigidMemory: r.mem, hullWater: { resetMemory: () => undefined } }, pose);
      }
      let first = Number.NaN;
      r.hw.samplePatch(FLAT, r.s, DT);
      stepRigid6(r.s, hull, DT, 2, (ss, h, load) => {
        r.hw.evaluate(ss, h, load);
        if (Number.isNaN(first)) first = r.hw.slamImpulse;
      }, r.mem);
      return first;
    };
    expect(drop(true)).toBe(0);
    expect(drop(false)).toBeGreaterThan(100);
  });

  it('restCgHeight is the level hull\'s hydrostatic float: released there she barely heaves', () => {
    const r = rig(st([0, CG_ABOVE_WATER, 0], [0, 0, 0, 1], [0, 0, 0]));
    let maxVy = 0;
    for (let k = 0; k < 30; k++) {
      step(r, 0, 0);
      maxVy = Math.max(maxVy, Math.abs(r.s.velocity[1]));
    }
    expect(maxVy).toBeLessThan(0.15);
    resetRigid6Memory(r.mem);
  });
});

describe('§T.188 cosmetic damage', () => {
  const g = damageGeometryFor(ch);

  it('lands in the zone that was hit, grows with the hit, saturates below 1, and ignores a rub', () => {
    const d = createDamage();
    addContactDamage(d, g, -0.9, -0.2, g.bowZ + 1, 0.5);
    expect(Array.from(d.zones).every((z) => z === 0), 'a 0.5 m/s rub leaves nothing').toBe(true);
    addContactDamage(d, g, -0.9, -0.2, g.bowZ + 1, 6); // starboard (−x) bow
    expect(d.zones[ZONE.BOW_STARBOARD]).toBeGreaterThan(0);
    for (const z of [ZONE.BOW_PORT, ZONE.SIDE_PORT, ZONE.SIDE_STARBOARD, ZONE.STERN, ZONE.COCKPIT]) expect(d.zones[z]).toBe(0);
    const light = createDamage();
    const heavy = createDamage();
    addContactDamage(light, g, 1, 0, 0, 4);
    addContactDamage(heavy, g, 1, 0, 0, 16);
    expect(heavy.zones[ZONE.SIDE_PORT]).toBeGreaterThan(light.zones[ZONE.SIDE_PORT]);
    for (let i = 0; i < 50; i++) addContactDamage(heavy, g, 1, 0, 0, 30);
    expect(heavy.zones[ZONE.SIDE_PORT]).toBeLessThanOrEqual(1);
    addContactDamage(heavy, g, 0, g.deckY + 0.5, 0, 12);
    addContactDamage(heavy, g, 0, -0.5, g.sternZ - 0.5, 12);
    expect(heavy.zones[ZONE.COCKPIT]).toBeGreaterThan(0);
    expect(heavy.zones[ZONE.STERN]).toBeGreaterThan(0);
    const v = heavy.version;
    resetDamage(heavy);
    expect(Array.from(heavy.zones).every((z) => z === 0)).toBe(true);
    expect(heavy.version).toBeGreaterThan(v);
  });

  it('crash kinds leave the design\'s pieces: a roll cracks the windscreen and bends the hoop, a stuff takes the hatch', () => {
    const roll = createDamage();
    addCrashDamage(roll, 'barrelRoll', 0);
    expect(damageFeatures(roll).windscreenCrack, 'one roll cracks the screen').toBe(true);
    expect(damageFeatures(roll).hoopBent, '…but one roll does not bend the hoop').toBe(false);
    addCrashDamage(roll, 'barrelRoll', 0);
    addCrashDamage(roll, 'barrelRoll', 0);
    const f = damageFeatures(roll);
    expect(f.windscreenCrack).toBe(true);
    expect(f.hoopBent).toBe(true);
    const stuff = createDamage();
    addCrashDamage(stuff, 'stuff', 0);
    addCrashDamage(stuff, 'stuff', 0);
    addCrashDamage(stuff, 'stuff', 0);
    expect(damageFeatures(stuff).hatchMissing).toBe(true);
    const hook = createDamage();
    addCrashDamage(hook, 'hook', 30); // heel +30°: body +x (port) up, starboard in the water
    expect(hook.zones[ZONE.SIDE_STARBOARD]).toBeGreaterThan(0);
    expect(hook.zones[ZONE.SIDE_PORT]).toBe(0);
  });
});
