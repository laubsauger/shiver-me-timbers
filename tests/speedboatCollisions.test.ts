/**
 * §T.191 COLLISIONS ARE LIVE ON THE PAGE PATH (user playtest 2026-09-13: "missing collision between boats and the
 * terrain, and collision between boats is also not really a thing").
 *
 * WHY: boatCollide is tested on its own (tests/boatCollide*.test.ts); what can silently break is the WIRING — the
 * player's collide call in the race session, the snapshot the player collides against, the player's pose in the
 * rivals' WORLD, the colliders and bed handed to the worker core, the contact-off mask. Each test drives the page's
 * own modules (createRaceSession + createNpcFleetDriver + createPlayerBoat, main transport) and requires impulses on
 * BOTH sides of the contact:
 *  - player into a stationary rival: the player's report shows a CONTACT_BOAT hit and she slows; the rival's step
 *    trace shows the same contact (computed by the core from the player's WORLD pose) and it is pushed ahead;
 *  - rival into a rock (a page/course.ts rock collider on the worker): its trace shows CONTACT_SOLID and it stops;
 *  - player into the same rock: the session's report shows CONTACT_SOLID and she stops short of passing through;
 *  - §T.197 Main Street's drowned roofs: every roof capsule `circuit/courseColliders` builds for a building that breaks
 *    the surface is in the list the page's course hook hands to BOTH the player and the workers, and a hull driven at a
 *    roof ridge is stopped by it on both sides (a roof you can drive through reads as a render bug, a rival that
 *    drives through one races a different course).
 */
import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../src/core/loop';
import { oceanParams } from '../src/params/ocean';
import { buildTowerReach } from '../src/circuit';
import { roofColliders } from '../src/circuit/courseColliders';
import { generateRockPlacements } from '../src/island/rocks';
import { createSeabedField } from '../src/island/seabed';
import { CONTACT_BOAT, CONTACT_SOLID, type StaticCollider } from '../src/sea-physics/boatCollide';
import { towerReachCourse, TOWER_REACH_SEED } from '../src/speedboat/page/course';
import { CpuOcean } from '../src/sea-physics/cpuOcean';
import type { Rigid6State } from '../src/sea-physics/rigidBody';
import { TR } from '../src/sim-worker/layout';
import { buildDeepVHull } from '../src/speedboat/hullMesh';
import { createNpcFleetDriver } from '../src/speedboat/page/npcFleet';
import { createPlayerBoat } from '../src/speedboat/page/playerBoat';
import { createRaceSession, RACE_DELAY_TICKS } from '../src/speedboat/page/raceSession';
import { speedboatSeaParams } from '../src/speedboat/page/seaParams';
import type { BoatControls } from '../src/speedboat/page/seams';
import type { ShipState } from '../src/state/simState';
import { weatherPresets } from '../src/weather/presets';

const pose = (x: number, z: number, vz: number): Rigid6State => ({ position: [x, 0.2, z], quaternion: [0, 0, 0, 1], velocity: [0, 0, vz], angularVelocity: [0, 0, 0] });

async function scene(o: { player: Rigid6State; npcs: Rigid6State[]; npcThrottle: number; playerThrottle: number; colliders: StaticCollider[] }) {
  const hull = buildDeepVHull();
  const ocean = structuredClone(oceanParams);
  Object.assign(ocean, structuredClone(weatherPresets.glass.ocean));
  const seaParams = speedboatSeaParams(hull);
  const mirror = new CpuOcean(7, ocean, seaParams);
  const state = { ...pose(0, 0, 0) } as unknown as ShipState;
  const player = createPlayerBoat({ hull, pressureHeadAt: (x, z, t) => mirror.pressureHeadAt(x, z, t) }, state);
  player.place(o.player);
  const warn = console.warn;
  console.warn = () => {};
  const npcs = await createNpcFleetDriver({
    seed: 7, boats: o.npcs.length, oceanParams: ocean, seaParams, spawn: (i) => o.npcs[i],
    controls: () => ({ throttle: o.npcThrottle, steer: 0 }),
    caps: { crossOriginIsolated: false, sharedArrayBuffer: false, worker: false }, budgetMs: 1e6,
    contacts: { boats: true, colliders: o.colliders }, player: true,
  });
  console.warn = warn;
  const ctl: BoatControls = { steer: 0, throttle: o.playerThrottle, trim: 0, surge: false };
  const session = createRaceSession({
    course: { id: 'x', name: 'x', elements: [], startGateId: 'S', laps: 1, referenceLine: [], paceLine: [], bounds: { min: [0, 0], max: [0, 0] } },
    hull, player, npcs, controls: { sample: () => ctl, dispose() {} },
    resetPressed: () => false, surgePressed: () => false, autoReset: () => true,
    colliders: o.colliders, bed: () => -30, waterAt: () => 0,
  });
  let time = 0;
  let tick = 0;
  const step = (): void => {
    tick++;
    time += SIM_DT;
    mirror.update(time);
    session.tick(tick, time, SIM_DT);
    npcs.pump(tick);
  };
  return { session, npcs, player, state, step, get tick() { return tick; } };
}

describe('§T.191 collisions through the page modules', () => {
  it('player ↔ rival: both sides see the contact and exchange momentum', async () => {
    const s = await scene({ player: pose(0, 0, 14), npcs: [pose(0, 40, 0), pose(500, 0, 0)], npcThrottle: 0, playerThrottle: 0.6, colliders: [] });
    let playerHit = 0;
    let playerDv = 0;
    let npcHit = 0;
    let npcDv = 0;
    try {
      for (let k = 0; k < 360; k++) {
        s.step();
        const r = s.session.playerContact;
        if (r.source === CONTACT_BOAT && r.other === 0) {
          playerHit++;
          playerDv = Math.max(playerDv, r.maxDeltaV);
        }
        const t = s.tick - RACE_DELAY_TICKS + 1;
        if (t >= 1 && s.npcs.collectedTick >= t && s.npcs.trace(t, 0, TR.CONTACT_SRC) === CONTACT_BOAT) {
          npcHit++;
          npcDv = Math.max(npcDv, s.npcs.trace(t, 0, TR.CONTACT_DV));
        }
      }
      console.log(`[collide] player hits ${playerHit} (max Δv ${playerDv.toFixed(2)} m/s), rival hits ${npcHit} (max Δv ${npcDv.toFixed(2)} m/s), rival vz ${s.npcs.pose(0).velocity[2].toFixed(2)}`);
      expect(playerHit).toBeGreaterThan(0);
      expect(npcHit).toBeGreaterThan(0);
      expect(playerDv).toBeGreaterThan(0.5);
      expect(npcDv).toBeGreaterThan(0.5);
      // no pass-through: the player never ended up ahead of the rival it hit
      expect(s.state.position[2]).toBeLessThan(s.npcs.pose(0).position[2]);
    } finally {
      s.npcs.dispose();
    }
  }, 300_000);

  it('rocks are solid for the rival on the worker core and for the player on the page', async () => {
    const rock: StaticCollider = { a: [0, -3, 60], b: [0, 2, 60], radius: 4 };
    const s = await scene({ player: pose(-30, 20, 14), npcs: [pose(30, 20, 14)], npcThrottle: 0.6, playerThrottle: 0.6, colliders: [rock, { a: [-30, -3, 60], b: [-30, 2, 60], radius: 4 }, { a: [30, -3, 60], b: [30, 2, 60], radius: 4 }] });
    let playerSolid = 0;
    let npcSolid = 0;
    try {
      for (let k = 0; k < 420; k++) {
        s.step();
        if (s.session.playerContact.source === CONTACT_SOLID) playerSolid++;
        const t = s.tick - RACE_DELAY_TICKS + 1;
        if (t >= 1 && s.npcs.collectedTick >= t && s.npcs.trace(t, 0, TR.CONTACT_SRC) === CONTACT_SOLID) npcSolid++;
      }
      console.log(`[collide] rock contacts: player ${playerSolid}, rival ${npcSolid}; player z ${s.state.position[2].toFixed(1)}, rival z ${s.npcs.pose(0).position[2].toFixed(1)}`);
      expect(playerSolid).toBeGreaterThan(0);
      expect(npcSolid).toBeGreaterThan(0);
      // neither hull passed through its rock (centre at z 60, radius 4)
      expect(s.state.position[2]).toBeLessThan(60);
      expect(s.npcs.pose(0).position[2]).toBeLessThan(60);
    } finally {
      s.npcs.dispose();
    }
  }, 300_000);

  it('§T.197 roofs: the page course hook hands every surface-breaking roof capsule to player and workers, and a ridge stops both', async () => {
    const world = buildTowerReach(TOWER_REACH_SEED);
    const seabed = createSeabedField(world.heightmaps.map((hm, i) => ({ heightmap: hm, center: world.sites[i].position })));
    const islands = world.sites.map((site, i) => ({ center: site.position, heightmap: world.heightmaps[i], rocks: { placements: generateRockPlacements(site.seed + 1013, world.heightmaps[i]) } }));
    const warn = console.warn;
    console.warn = () => {};
    let page: ReturnType<ReturnType<typeof towerReachCourse>['attach']>;
    try {
      page = towerReachCourse().attach({ archipelago: { islands, seabed }, cpuOcean: { setSeabed() {} } });
    } finally {
      console.warn = warn;
    }
    const key = (c: StaticCollider): string => [...c.a, ...c.b, c.radius].map((v) => v.toFixed(3)).join(',');
    const pageKeys = new Set(page.colliders.map(key));
    const roofs = page.world.furniture.roofs.map((r) => ({ r, caps: roofColliders(r) })).filter((q) => q.caps.length > 0);
    console.log(`[collide] roofs ${page.world.furniture.roofs.length}, breaking the surface ${roofs.length}, capsules ${roofs.reduce((n, q) => n + q.caps.length, 0)} of ${page.colliders.length} page colliders`);
    expect(roofs.length).toBeGreaterThan(0);
    for (const q of roofs) for (const c of q.caps) expect(pageKeys.has(key(c)), `${q.r.kind} roof at ${q.r.at} capsule ${key(c)}`).toBe(true);

    // §T.198: drive a hull at a whole GABLE (the class the live page let a hull ride up and over: its §T.197 waterline
    // ridge capsule was a ramp), moved to the origin: a glass sea and a deep bed, only the roof
    const gable = roofs.find((q) => q.r.kind === 'gable')!;
    const ridge = gable.caps[0];
    const cx = gable.r.at[0];
    const cz = gable.r.at[1];
    // turned so its ridge runs across the hulls' +z path (broadside: the long wall, not a rounded end they glance off)
    const rx = Math.sin(gable.r.yaw);
    const rz = Math.cos(gable.r.yaw);
    const place = (p: readonly number[], dx: number): [number, number, number] => [(p[0] - cx) * rx + (p[2] - cz) * rz + dx, p[1], -(p[0] - cx) * rz + (p[2] - cz) * rx + 60];
    const moveAll = (dx: number): StaticCollider[] => gable.caps.map((c) => ({ a: place(c.a, dx), b: place(c.b, dx), radius: c.radius }));
    const s = await scene({ player: pose(0, 20, 14), npcs: [pose(60, 20, 14)], npcThrottle: 0.6, playerThrottle: 0.6, colliders: [...moveAll(0), ...moveAll(60)] });
    let playerSolid = 0;
    let npcSolid = 0;
    let playerMaxY = -Infinity;
    try {
      for (let k = 0; k < 420; k++) {
        s.step();
        playerMaxY = Math.max(playerMaxY, s.state.position[1]);
        if (s.session.playerContact.source === CONTACT_SOLID) playerSolid++;
        const t = s.tick - RACE_DELAY_TICKS + 1;
        if (t >= 1 && s.npcs.collectedTick >= t && s.npcs.trace(t, 0, TR.CONTACT_SRC) === CONTACT_SOLID) npcSolid++;
      }
      console.log(`[collide] gable (${gable.caps.length} capsules, wall r ${ridge.radius.toFixed(2)}): player contacts ${playerSolid}, rival ${npcSolid}; player z ${s.state.position[2].toFixed(1)} max y ${playerMaxY.toFixed(2)}, rival z ${s.npcs.pose(0).position[2].toFixed(1)}`);
      expect(playerSolid).toBeGreaterThan(0);
      expect(playerMaxY, 'not ramped up over the roof').toBeLessThan(1.8);
      expect(npcSolid).toBeGreaterThan(0);
      expect(s.state.position[2]).toBeLessThan(60);
      expect(s.npcs.pose(0).position[2]).toBeLessThan(60);
    } finally {
      s.npcs.dispose();
    }
  }, 300_000);
});
