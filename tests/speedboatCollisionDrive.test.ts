/**
 * §T.198 DRIVE INTO EVERY OBSTACLE CLASS ON TOWER REACH AT 20 AND 45 m/s, THROUGH THE PAGE'S OWN TICK.
 *
 * WHY (§Rule 6): the user drove through rocks, buildings and rivals in the live page while boatCollide's unit tests
 * passed. The unit tests drove into hand-placed capsules; the page handed the physics a collider list with no rocks in it
 * (kit islands: rockCount 0, granite drawn by circuit/kitDecor). So these runs take their targets from the list the
 * page builds for the real course (tests/speedboatCollisionWorld.ts → page/course.ts attach, the drawn kit decor
 * included) and step the page's modules (createRaceSession → collide → createPlayerBoat, rivals on createNpcFleetDriver),
 * aimed dead at the obstacle from open water. Each class must: make contact (the session's report), cost speed, and
 * not let the hull pass the obstacle; a solid hit at racing speed must be big enough to be an impact crash
 * (CRASH_THRESHOLDS.impactDeltaV, crash/detect.ts). A gate pole flexes: −10% once, and the boat goes on.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { SIM_DT } from '../src/core/loop';
import { TR } from '../src/sim-worker/layout';
import { courseColliders } from '../src/circuit/courseColliders';
import { oceanParams } from '../src/params/ocean';
import { buildCollisionHull, CONTACT_BED, CONTACT_BOAT, CONTACT_FLEXIBLE, CONTACT_SOLID, type CollisionHull, type StaticCollider } from '../src/sea-physics/boatCollide';
import { CpuOcean } from '../src/sea-physics/cpuOcean';
import type { Rigid6State } from '../src/sea-physics/rigidBody';
import { CRASH_THRESHOLDS, createCrashDetectMemory, createCrashSensors, crashCondition } from '../src/speedboat/crash';
import { buildDeepVHull } from '../src/speedboat/hullMesh';
import { createNpcFleetDriver } from '../src/speedboat/page/npcFleet';
import { createPlayerBoat } from '../src/speedboat/page/playerBoat';
import { createRaceSession } from '../src/speedboat/page/raceSession';
import { speedboatSeaParams } from '../src/speedboat/page/seaParams';
import type { BoatControls } from '../src/speedboat/page/seams';
import type { ShipState } from '../src/state/simState';
import { weatherPresets } from '../src/weather/presets';
import { collisionWorld, type CollisionWorld } from './speedboatCollisionWorld';

const SPEEDS = [20, 45] as const;
const PARK: Rigid6State = { position: [-2500, 0.2, -2500], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] };

interface Target {
  cls: string;
  x: number;
  z: number;
  /** how far past the target point the CG may get (the obstacle's own half-depth) */
  radius: number;
  heading: number;
  /** the rival is parked here for this run */
  rival?: boolean;
  /** low enough that a hull may jump it (contact, speed loss and an impact still required) */
  vault?: boolean;
}

let W: CollisionWorld;
let colliders: StaticCollider[];
let bed: (x: number, z: number) => number;
const mid = (c: StaticCollider): [number, number] => [(c.a[0] + c.b[0]) / 2, (c.a[2] + c.b[2]) / 2];

// ── independent geometry (not the module's sweep): how deep the hull ever got into the obstacle ──────────────
type Seg = { a: number[]; b: number[]; r: number };
function rot(q: ArrayLike<number>, v: ArrayLike<number>): number[] {
  const tx = 2 * (q[1] * v[2] - q[2] * v[1]);
  const ty = 2 * (q[2] * v[0] - q[0] * v[2]);
  const tz = 2 * (q[0] * v[1] - q[1] * v[0]);
  return [v[0] + q[3] * tx + (q[1] * tz - q[2] * ty), v[1] + q[3] * ty + (q[2] * tx - q[0] * tz), v[2] + q[3] * tz + (q[0] * ty - q[1] * tx)];
}
function chain(p: ArrayLike<number>, q: ArrayLike<number>, h: CollisionHull): Seg[] {
  const out: Seg[] = [];
  for (let k = 0; k < h.capsuleCount; k++) {
    const c = h.capsules.subarray(k * 7, k * 7 + 7);
    const a = rot(q, [c[0], c[1], c[2]]);
    const b = rot(q, [c[3], c[4], c[5]]);
    out.push({ a: a.map((x, i) => x + p[i]), b: b.map((x, i) => x + p[i]), r: c[6] });
  }
  return out;
}
/** sampled signed surface distance between two capsules (N = 10 per segment) */
function gap(u: Seg, v: Seg): number {
  let best = Infinity;
  for (let i = 0; i <= 10; i++) {
    const x = u.a.map((q, k) => q + (u.b[k] - q) * (i / 10));
    for (let j = 0; j <= 10; j++) {
      const y = v.a.map((q, k) => q + (v.b[k] - q) * (j / 10));
      best = Math.min(best, Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]));
    }
  }
  return best - u.r - v.r;
}

/** open water and no other collider within a hull's half-beam + 2 m of the run-up (`from`…`to` metres before the target) */
function clearApproach(t: { x: number; z: number }, heading: number, from: number, to: number, ignore: (c: StaticCollider) => boolean): boolean {
  const hx = Math.sin(heading);
  const hz = Math.cos(heading);
  for (let d = from; d <= to; d += 2) if (bed(t.x - hx * d, t.z - hz * d) > -2.5) return false;
  for (const c of colliders) {
    if (ignore(c)) continue;
    const [cx, cz] = mid(c);
    const along = (t.x - cx) * hx + (t.z - cz) * hz;
    const lat = Math.abs((cx - t.x) * hz - (cz - t.z) * hx);
    if (along > -2 && along < to && lat < c.radius + 0.5 * Math.hypot(c.a[0] - c.b[0], c.a[2] - c.b[2]) + 3.5) return false;
  }
  return true;
}

function aim(cls: string, x: number, z: number, radius: number, ignore: (c: StaticCollider) => boolean): Target {
  for (let k = 0; k < 72; k++) {
    const heading = (k / 72) * Math.PI * 2;
    if (clearApproach({ x, z }, heading, radius + 3, radius + 90, ignore)) return { cls, x, z, radius, heading };
  }
  throw new Error(`no clear approach to the ${cls} at ${x.toFixed(0)}, ${z.toFixed(0)}`);
}

function targets(): Target[] {
  const f = W.world.furniture;
  const nCourse = courseColliders(W.world).length;
  const near = (x: number, z: number, r: number) => (c: StaticCollider) => Math.hypot(mid(c)[0] - x, mid(c)[1] - z) < r;
  const out: Target[] = [];
  // island props (drawn kit granite): a TALL one (top ≥ 2.5 m: must stop a hull like a wall) and a LOW one (top ≤ 1.5 m:
  // a 12 m hull may vault it — its capsule's rounded top is a ramp at the waterline, as the rock is — but not unscathed)
  const top = (c: StaticCollider): number => Math.max(c.a[1], c.b[1]) + c.radius;
  const props = colliders.slice(nCourse).filter((c) => Math.min(c.a[1], c.b[1]) - c.radius < 0 && bed(...mid(c)) < -0.5).sort((a, b) => b.radius - a.radius);
  const pick = (cls: string, ok: (c: StaticCollider) => boolean, vault: boolean): void => {
    for (const c of props.filter(ok)) {
      try {
        out.push({ ...aim(cls, ...mid(c), c.radius, near(...mid(c), c.radius + 4)), vault });
        return;
      } catch {
        /* next */
      }
    }
    throw new Error(`no ${cls} with open water in front of it`);
  };
  pick('tall island prop (kit granite)', (c) => top(c) >= 2.5, false);
  pick('low island prop (kit block)', (c) => top(c) <= 1.5 && c.radius > 0.4, true);
  // a stone (r ≤ 0.4 m, ≤ 1 m tall): live, before its waterline wall, it threw a 45 m/s hull 10 m into the air
  pick('stone (kit rubble)', (c) => top(c) <= 1 && c.radius <= 0.4 && c.radius >= 0.25 && Math.abs(c.a[1] - c.b[1]) < 0.9 * Math.hypot(c.a[0] - c.b[0], c.a[2] - c.b[2]) + 0.5, true);
  // island terrain: the steepest shore (bed −2.5 → +2 m within 8 m) with a clear run-up
  let shore: Target | null = null;
  let best = Infinity;
  for (let s = 0; s < W.world.sites.length; s++) {
    const [cx, cz] = W.world.sites[s].position;
    const R = W.world.heightmaps[s].worldRadius;
    for (let k = 0; k < 180; k++) {
      const a = (k / 180) * Math.PI * 2;
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      let deep = -1;
      for (let r = R + 80; r > 0; r -= 1) {
        const h = bed(cx + dx * r, cz + dz * r);
        if (h < -2.5) deep = r;
        if (h > 2) {
          const run = deep - r;
          const x = cx + dx * r;
          const z = cz + dz * r;
          const heading = Math.atan2(-dx, -dz);
          if (deep > 0 && run < best && clearApproach({ x, z }, heading, run + 2, run + 90, () => false)) {
            best = run;
            shore = { cls: 'island terrain (shore/cliff)', x, z, radius: 0, heading };
          }
          break;
        }
      }
    }
  }
  expect(shore, 'a shore with open water in front of it').not.toBeNull();
  out.push(shore!);
  // drowned buildings: a gable roof, the water tower
  for (const kind of ['gable', 'waterTower'] as const) {
    const r = f.roofs.find((q) => q.kind === kind)!;
    out.push(aim(`drowned ${kind}`, r.at[0], r.at[1], kind === 'waterTower' ? 4.4 : 5, near(r.at[0], r.at[1], 14)));
  }
  const p = f.pylons[0];
  out.push(aim('pylon', p.at[0], p.at[1], 2.9, near(p.at[0], p.at[1], 4)));
  const b = f.buoys[0];
  out.push(aim('turn buoy', b.at[0], b.at[1], 1.35, near(b.at[0], b.at[1], 3)));
  const foot = W.world.seabedAt(f.tower.at[0], f.tower.at[1]);
  const lx = f.tower.at[0] + Math.cos(f.tower.leanDir) * Math.sin(f.tower.lean) * -foot;
  const lz = f.tower.at[1] + Math.sin(f.tower.leanDir) * Math.sin(f.tower.lean) * -foot;
  out.push(aim('tower mast', lx, lz, 1.6, near(lx, lz, 12)));
  const g = f.tower.anchors[0];
  out.push(aim('guy anchor', g[0], g[1], 0.7, near(g[0], g[1], 2)));
  const pole = f.poles[0];
  out.push({ ...aim('gate pole (flexible)', pole.at[0], pole.at[1], 0.6, near(pole.at[0], pole.at[1], 2)) });
  out.push({ cls: 'rival boat', x: 0, z: 0, radius: 2.4, heading: 0, rival: true });
  return out;
}

async function drive(t: Target, speed: number) {
  const hull = buildDeepVHull();
  const ocean = structuredClone(oceanParams);
  Object.assign(ocean, structuredClone(weatherPresets.glass.ocean));
  const seaParams = speedboatSeaParams(hull);
  const mirror = new CpuOcean(7, ocean, seaParams);
  const hx = Math.sin(t.heading);
  const hz = Math.cos(t.heading);
  const lead = t.radius + 8 + speed * 0.7;
  const yaw = (h: number): [number, number, number, number] => [0, Math.sin(h / 2), 0, Math.cos(h / 2)];
  // the rival sits across the player's path (T-bone) 30 m out in open water beyond the parked world
  const rivalAt: Rigid6State = { position: [t.x, 0.2, t.z], quaternion: yaw(t.heading + Math.PI / 2), velocity: [0, 0, 0], angularVelocity: [0, 0, 0] };
  const start: Rigid6State = { position: [t.x - hx * lead, 0.2, t.z - hz * lead], quaternion: yaw(t.heading), velocity: [hx * speed, 0, hz * speed], angularVelocity: [0, 0, 0] };
  const state = { position: [0, 0, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] } as unknown as ShipState;
  const player = createPlayerBoat({ hull, pressureHeadAt: (x, z, tt) => mirror.pressureHeadAt(x, z, tt) }, state);
  player.place(start);
  const warn = console.warn;
  console.warn = () => {};
  const npcs = await createNpcFleetDriver({
    seed: 7, boats: 1, oceanParams: ocean, seaParams, spawn: () => (t.rival ? rivalAt : PARK),
    controls: () => ({ throttle: 0, steer: 0 }),
    caps: { crossOriginIsolated: false, sharedArrayBuffer: false, worker: false }, budgetMs: 1e6,
    contacts: { boats: true, colliders }, player: true,
  });
  console.warn = warn;
  const ctl: BoatControls = { steer: 0, throttle: 1, trim: 0, surge: false };
  const session = createRaceSession({
    course: { id: 'x', name: 'x', elements: [], startGateId: 'S', laps: 1, referenceLine: [], paceLine: [], bounds: { min: [0, 0], max: [0, 0] } },
    hull, player, npcs, controls: { sample: () => ctl, dispose() {} },
    resetPressed: () => false, surgePressed: () => false, autoReset: () => true,
    colliders: t.rival ? [] : colliders, bed: t.rival ? () => -30 : bed, waterAt: () => 0,
  });
  let time = 0;
  const ticks = Math.round((lead / speed) * 60) + 60;
  let first = -1;
  let source = 0;
  let maxDv = 0;
  let maxDvSource = 0;
  let impact = false;
  let maxAlong = -Infinity;
  let minGap = Infinity;
  let preSpeed = 0;
  const speeds: number[] = [];
  const track: number[] = [];
  const poses: number[][] = [];
  const ch = buildCollisionHull(hull);
  // the obstacle: its colliders near the aim point (statics), or the rival's hull at the same tick (below)
  const obstacle: Seg[] = t.rival ? [] : colliders.filter((c) => !c.flexible && Math.hypot(mid(c)[0] - t.x, mid(c)[1] - t.z) < t.radius + 8).map((c) => ({ a: c.a, b: c.b, r: c.radius }));
  let maxY = 0;
  let peakY = -Infinity;
  const sensors = createCrashSensors();
  const memory = createCrashDetectMemory();
  try {
    for (let tick = 1; tick <= ticks; tick++) {
      time += SIM_DT;
      mirror.update(time);
      const before = Math.hypot(state.velocity[0], state.velocity[2]);
      session.tick(tick, time, SIM_DT);
      npcs.pump(tick);
      const r = session.playerContact;
      if (r.count > 0 && first < 0) {
        first = tick;
        source = r.source;
        preSpeed = before;
      }
      if (r.maxDeltaV > maxDv) {
        maxDv = r.maxDeltaV;
        maxDvSource = r.source;
      }
      sensors.contactDeltaV = r.maxDeltaV;
      sensors.contactSource = r.source;
      if (crashCondition('impact', sensors, memory)) impact = true;
      speeds.push(Math.hypot(state.velocity[0], state.velocity[2]));
      track.push(state.position[0], state.position[2]);
      poses.push([...state.position, ...state.quaternion]);
      // a ride-over is height gained OVER the obstacle's footprint (a hull tumbling in the air after a 45 m/s bow hit,
      // short of the obstacle, is the crash that follows an impact — hull↔water physics, not the collider)
      if (!t.rival && Math.hypot(state.position[0] - t.x, state.position[2] - t.z) < t.radius + 1) maxY = Math.max(maxY, state.position[1]);
      peakY = Math.max(peakY, state.position[1]);
    }
    // the target moves only for the rival (it is pushed): measure against its trace pose at the same tick
    for (let k = 3; k < 40 && npcs.collectedTick < ticks; k++) npcs.pump(ticks);
    for (let tick = 1; tick <= ticks; tick++) {
      const ox = t.rival ? npcs.trace(tick, 0, TR.POSE) : t.x;
      const oz = t.rival ? npcs.trace(tick, 0, TR.POSE + 2) : t.z;
      maxAlong = Math.max(maxAlong, (track[(tick - 1) * 2] - ox) * hx + (track[(tick - 1) * 2 + 1] - oz) * hz);
      const P = poses[tick - 1];
      const mine = chain(P.slice(0, 3), P.slice(3, 7), ch);
      const other = t.rival ? chain([0, 1, 2].map((k) => npcs.trace(tick, 0, TR.POSE + k)), [3, 4, 5, 6].map((k) => npcs.trace(tick, 0, TR.POSE + k)), ch) : obstacle;
      for (const u of mine) for (const v of other) minGap = Math.min(minGap, gap(u, v));
    }
  } finally {
    npcs.dispose();
  }
  const after = first > 0 ? speeds[Math.min(speeds.length - 1, first - 1 + 30)] : NaN;
  return { cls: t.cls, radius: t.radius, vault: !!t.vault, speed, first, source, maxDv: +maxDv.toFixed(2), maxDvSource, impact, preSpeed: +preSpeed.toFixed(1), speed30: +after.toFixed(1), end: +speeds[speeds.length - 1].toFixed(1), maxAlong: +maxAlong.toFixed(2), minGap: +minGap.toFixed(2), maxY: +maxY.toFixed(2), peakY: +peakY.toFixed(2), finite: [...state.position, ...state.velocity].every(Number.isFinite) };
}

beforeAll(() => {
  W = collisionWorld();
  colliders = W.page.colliders;
  bed = W.page.bed;
}, 300_000);

describe('§T.198 every obstacle class on Tower Reach stops a hull through the page tick', () => {
  it('20 and 45 m/s into kit granite, a shore, a drowned roof and the water tower, pylon, buoy, mast, guy anchor, a rival; a gate pole flexes', async () => {
    const list = targets();
    const rows: Awaited<ReturnType<typeof drive>>[] = [];
    for (const t of list) for (const v of SPEEDS) rows.push(await drive(t, v));
    console.log('[drive]\n' + rows.map((r) => JSON.stringify(r)).join('\n'));
    for (const r of rows) {
      const tag = `${r.cls} @ ${r.speed} m/s`;
      expect(r.finite, tag).toBe(true);
      expect(r.first, `${tag}: contact`).toBeGreaterThan(0);
      expect(r.preSpeed, `${tag}: arrived at speed`).toBeGreaterThan(r.speed * 0.8);
      if (r.cls.startsWith('gate pole')) {
        expect(r.source, tag).toBe(CONTACT_FLEXIBLE);
        expect(r.speed30, `${tag}: −10% once, then on`).toBeGreaterThan(r.preSpeed * 0.8);
        expect(r.impact, `${tag}: a pole is never an impact crash`).toBe(false);
        continue;
      }
      expect([CONTACT_SOLID, CONTACT_BED, CONTACT_BOAT], tag).toContain(r.source);
      if (r.vault) {
        // measured: a 3 m block costs 15–30 % and lifts ≤ 2.1 m; a 0.4 m stone costs 10–40 % and hops the hull 2.8 / 4.2 m
        // (the hop after the kick is hull↔water on a pitched hull, not the collider — capping the static lift changed nothing)
        expect(r.speed30, `${tag}: a vault costs speed`).toBeLessThan(r.preSpeed * 0.95);
        expect(r.maxDv, `${tag}: a vault is a hit`).toBeGreaterThan(3);
        expect(r.peakY, `${tag}: a kick, not a launch`).toBeLessThan(6);
        continue;
      }
      // SOLID: the hull never gets into the obstacle (a sweep's early bounce allows a few cm; a glancing hull slides round
      // a long building, so "past its centre" is not the measure — overlap is), it is not ramped up over it, and a
      // straight hit costs speed (a rival of the same mass is shoved, not a wall: the player shares her momentum)
      // allowance: one tick of travel at the arrival speed (+0.3 m) — V110 caps a stop at 150 g, so a 45 m/s head-on
      // needs two ticks and the hull runs on up to (v − 24.5 m/s)·dt into a cluster of blocks before it is out again
      expect(r.minGap, `${tag}: no pass-through (deepest overlap with the obstacle)`).toBeGreaterThan(-(0.3 + r.speed / 60));
      // a statics hit must not ramp the hull up over its footprint; a T-boned RIVAL may be ridden over (bow onto its gunwale)
      if (!r.cls.startsWith('island terrain') && !r.cls.startsWith('rival')) expect(r.maxY, `${tag}: not ramped over`).toBeLessThan(1.8);
      expect(r.speed30, `${tag}: speed lost within 0.5 s of contact`).toBeLessThan(r.preSpeed * (r.cls.startsWith('rival') || r.cls.startsWith('drowned gable') ? 0.85 : 0.6));
      // a head-on solid hit at racing speed is an impact crash (T188: one collision |Δv| ≥ 8 m/s); a rival is pushed away
      if (!r.cls.startsWith('rival') && r.speed >= 45) expect(r.impact, `${tag}: impact crash (max |Δv| ${r.maxDv})`).toBe(true);
      if (r.cls.startsWith('rival') && r.speed >= 45) expect(r.maxDv, `${tag}: impact-sized`).toBeGreaterThanOrEqual(CRASH_THRESHOLDS.impactDeltaV);
    }
  }, 900_000);
});
