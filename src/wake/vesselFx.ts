/**
 * §T.195 EVERY BOAT MARKS THE WATER — the one page-facing object that turns every boat's step into marks on the sea.
 * USER: 'we're missing the wakes and all that from npcs; only our boat shows any kind of reaction on the water in
 * terms of foam or wake or bow displacement or trail.' + 'bubble trail from the engine blades … and rooster tails etc
 * for all boats.' Design + numbers: docs/wake/w6-multivessel.md.
 *
 * PER FIXED TICK, after the player's step (`tick`), from ONE contact result per boat (§V101):
 *   hero      her `HullWater` → the effects record through the SAME writer the worker uses (sim-worker/fx.ts) →
 *             wake samples (`hullWaterSamples`), jets, waterline spray
 *   rivals    `BoatFleet.effects(i)`: pose, wake samples, jets and waterline spray of each rival's last COLLECTED
 *             step, all of one step (§V2: the same bytes on every transport)
 *   WAKE      `wakeSim.tick(hero pose, hero samples, stem, dt, hero jets, rivals)` — ONE source buffer, ONE splat, ONE
 *             compute group (§V104), the domain anchored on the hero's SIM pose (§V105); rivals nearest-first,
 *             faded across the sponge band and dropped whole outside it (`vesselDomainWeight`)
 *   FOAM      `flowFoam.setPropWash(every jet, hero first then nearest boat)` — the ribbon (+ aeration) per drive per
 *             boat; §T.199 `flowFoam.setChineSheets(every waterline spray)` — the V's two sheet lines per hull; the ribbon
 *             boat, laid inside and outside the solver domain (far trail); the churn per vessel reads the domain's
 *             vessel slots (flowfoam simFoam vessel mode)
 *   SPRAY     bow sheet (`createBowSprayFleet`), rooster tail (`createRoosterTail({ maxJets })`) and prop bubbles
 *             (`createPropBubbles`): one pool each, emitter slots by camera distance within the pool's turnover
 *   W9        the planing hull's whitewater (`foam/hullSpray`): spray-root sheets, transom boil and hollow-closure hump
 *             per boat from her pose + the shared hull + her record (`planingContact`)
 * The spray reads the camera for PRIORITY only; nothing here feeds a force (§V8a: the wake is visual-only until §T.170,
 * so §V108 — a hull never reads its own same-tick wake — holds trivially).
 */
import type * as THREE from 'three/webgpu';
import { createBowSprayFleet, type BowFleetEmitter } from '../foam/bowSpray';
import { createPropBubbles, createRoosterTail, strutSheetEmission, type RoosterExtraSource } from '../foam/roosterTail';
import { sprayParams } from '../params/spray';
import type { WakeLoadSamples } from '../sea-physics/hullWater';
import type { Rigid6State } from '../sea-physics/rigidBody';
import type { BoatEffects } from '../sim-worker/fleet';
import { FX_LEN, createBoatFx, readBoatFx, writeBoatFx, type BoatFx, type BoatFxSource } from '../sim-worker/fx';
import type { PropWashInput } from './propWash';
import { hullWaterSamples } from './stationSources';
import { WAKE_MAX_VESSELS, type VesselWakeInput, type WakeSim } from './wakeSim';
import type { HydroSample } from './wakeSolverMath';
import { ChineContactHistory, type ChineSheetEmitter } from './chineContact';
import { appendageSample, strutsFromJets, type AppendageInput } from './appendages';
import { hollowSamples, humpSamples } from './transomHollow';
import { createHullSpray, type HullSprayEmitter } from '../foam/hullSpray';
import { createPlaningContact, planingContact, planingSprayEmitters, type PlaningContact } from './planingContact';

/**
 * W8 round 3 (impacts): time over which a hull's wake LOAD may rise (s). A landing's contact load arrives on one tick,
 * but the water takes the impact over the few hundredths of a second the hull needs to bury (the slamming pressure
 * pulse, ~20–80 ms for a planing hull — Faltinsen 2005 ch. 8); the solver was handed a one-tick delta and the whole
 * splash wave appeared at once. Falling loads pass straight through (an airborne hull pushes nothing).
 */
export const WAKE_LOAD_RISE_SECONDS = 0.08;

/** the rise-limited load share (0..1] of this tick's Σ fy against the running load (`state.load`), and the new state */
export function wakeLoadRamp(state: { load: number }, total: number, dt: number): number {
  if (!Number.isFinite(total) || !(total > 0)) {
    state.load = 0;
    return 1;
  }
  if (total <= state.load) {
    state.load = total;
    return 1;
  }
  const next = Math.max(0, state.load) + (total - Math.max(0, state.load)) * (1 - Math.exp(-Math.max(0, dt) / WAKE_LOAD_RISE_SECONDS));
  state.load = next;
  return next / total;
}

/** jets the fleet's rooster tail and bubbles carry: every drive of every boat the domain can hold */
export const VESSEL_FX_JETS = WAKE_MAX_VESSELS * 3;

export interface VesselFxDeps {
  scene: { add(...objects: THREE.Object3D[]): unknown };
  flowFoam: {
    readonly wakeSim: WakeSim | null;
    setPropWash(jets: readonly PropWashInput[]): void;
    /** §T.199 the chine sheet foam lines (flowfoam vessel mode) — optional so a stub flowfoam needs none */
    setChineSheets?(emitters: readonly ChineSheetEmitter[]): void;
  };
  reflection?: { excludeFromReflection(object: THREE.Object3D): void } | null;
  /**
   * §T.199 unit direction TOWARD the sun (the sky's `sunDirection`) — the rooster plume's forward scattering. Absent:
   * the scene's first DirectionalLight (position − target), found once; neither: a fixed high sun.
   */
  sunDirection?: () => { x: number; y: number; z: number };
}

/** the hero this tick: her contact (after the step that evaluated it), the pose rigid6 just wrote, her stem */
export interface HeroVessel {
  hw: BoatFxSource & { readonly wake: Readonly<WakeLoadSamples> };
  state: Readonly<Pick<Rigid6State, 'position' | 'quaternion' | 'velocity'>>;
  /** body z of the stem (m) — the wake anchor's bow (§V105) */
  bowAhead: number;
}

/** the rivals: `BoatFleet` satisfies it (external boats report tick −1 and are skipped) */
export interface RivalEffects {
  readonly spec: { readonly boats: number };
  effects(i: number): Readonly<BoatEffects>;
}

export interface VesselFxTick {
  /** rivals handed to the wake this tick / taken by the domain / culled outside it / skipped for capacity */
  rivals: number;
  wakeVessels: number;
  culled: number;
  overflowed: number;
  /** wake sources this tick (hull samples + jets) */
  sources: number;
  /** granted particles/s: bow sheet, rooster tail, bubbles */
  bow: number;
  rooster: number;
  bubbles: number;
  /** W9 granted hull whitewater clumps/s */
  hullSpray: number;
}

export function createVesselFx(d: VesselFxDeps) {
  const bow = createBowSprayFleet();
  // §T.199 4096 per pool: the plume's drops live ≈ 2.4 s, so 2048 turned over ≈ 630/s for the whole fleet (sparse balls)
  // W8 round 3: 16384 per pool — small streak sprites, the plume's weight is their count (roosterTail ROOSTER_SPRITE_DENSITY)
  const rooster = createRoosterTail({ maxJets: 2 * VESSEL_FX_JETS, count: 16384 });
  const bubbles = createPropBubbles({ maxJets: VESSEL_FX_JETS });
  // W9: every boat's spray-root sheet, transom boil and closure hump (3 emitters per boat in the domain)
  const hullSpray = createHullSpray({ slots: 3 * WAKE_MAX_VESSELS });
  /** bow sheet, rooster drops, prop bubbles, rooster mist (§T.199: the mist pool appended last), W9 hull whitewater */
  const meshes = [bow.mesh, rooster.meshes[0], bubbles.mesh, rooster.meshes[1], hullSpray.mesh];
  d.scene.add(...meshes);
  for (const m of meshes) d.reflection?.excludeFromReflection(m);

  const heroRecord = new Float64Array(FX_LEN);
  const heroFx: BoatFx = createBoatFx();
  const heroSamples: HydroSample[] = [];
  /** W8 round 3: drive struts (hero + rivals) and the rivals' sample lists with theirs appended, reused */
  const struts: AppendageInput[] = [];
  const strutSamples: HydroSample[] = [];
  const rivalSamples: HydroSample[][] = [];
  /** W9 the rooster hump lifts: the hero's and each rival's (reused) */
  const heroLifts: HydroSample[] = [];
  const rivalLifts: HydroSample[][] = [];
  const heroLoad = { load: 0 };
  // Stable fleet slots, never the nearest-first render order. Worker samples
  // are immutable inputs; the ramp applies only to our pooled copies.
  const rivalLoads: ({ load: number; tick: number } | undefined)[] = [];
  const fxStruts: AppendageInput[] = [];
  const extras: RoosterExtraSource[] = [];
  const extraPool: RoosterExtraSource[] = [];
  const others: VesselWakeInput[] = [];
  const jets: PropWashInput[] = [];
  const emitters: BowFleetEmitter[] = [];
  const sheets: ChineSheetEmitter[] = [];
  const contact = new ChineContactHistory();
  /** W9 per-boat planing contact scratch (hero first, then rivals by order) and the whitewater emitters */
  const planing: PlaningContact[] = [];
  const hullEmitters: HullSprayEmitter[] = [];
  const hullEmitterPool: HullSprayEmitter[] = [];
  const ids: number[] = [];
  let tick = 0;
  const order: number[] = [];
  const effects: Readonly<BoatEffects>[] = [];
  let visible = true;
  // §T.199 the plume's sun: the page's, else the scene's first directional light (header of `sunDirection`)
  let light: THREE.DirectionalLight | null | undefined;
  const sun = (): void => {
    if (d.sunDirection) {
      const v = d.sunDirection();
      rooster.setSun(v.x, v.y, v.z);
      hullSpray.setSun(v.x, v.y, v.z);
      return;
    }
    if (light === undefined) {
      light = null;
      const scene = d.scene as { traverse?(cb: (o: THREE.Object3D) => void): void };
      scene.traverse?.((o) => {
        if (!light && (o as THREE.DirectionalLight).isDirectionalLight) light = o as THREE.DirectionalLight;
      });
    }
    if (light) {
      const p = light.position;
      const t = light.target.position;
      rooster.setSun(p.x - t.x, p.y - t.y, p.z - t.z);
      hullSpray.setSun(p.x - t.x, p.y - t.y, p.z - t.z);
    }
  };
  const last: VesselFxTick = { rivals: 0, wakeVessels: 0, culled: 0, overflowed: 0, sources: 0, bow: 0, rooster: 0, bubbles: 0, hullSpray: 0 };

  return {
    meshes,
    /** the hero's decoded record of the last tick (jets, waterline spray) */
    heroFx,
    /** this tick's rival wake inputs and every jet (hero first) — debug/tests */
    others,
    /** §T.199 the emitters (debug readback / tests) */
    pools: { bow, rooster, bubbles, hullSpray },
    /** W9 this tick's hull whitewater emitters (debug readback / tests) */
    hullEmitters,
    /** W9 this tick's planing contacts, hero first (debug readback / tests) */
    planing,
    jets,
    last,

    /**
     * FIXED TICK, after the player's rigid6 step: every boat's wake, foam and spray (header). REPLACES the page's
     * `flowFoam.setPropWash(jets)`, `wakeSim.tick(…)` and `roosterTail.update(…)` calls.
     */
    tick(renderer: THREE.WebGPURenderer, hero: HeroVessel, rivals: RivalEffects | null, dt: number, viewer: { x: number; y: number; z: number }): VesselFxTick {
      writeBoatFx(hero.hw, hero.state as Rigid6State, heroRecord, 0);
      readBoatFx(heroRecord, 0, heroFx);
      // §T.199 the record carries no rev/s yet (sim-worker/fx.ts, T199 report): the hero's own engines, live; rivals'
      // rooster tails estimate theirs from the jet and the hero's prop pitch (the fleet runs one engine spec)
      for (let k = 0; k < heroFx.jets.length; k++) heroFx.jets[k].propRps = hero.hw.engines?.[k]?.propRps;
      rooster.setPitch(hero.hw.params?.engine?.propPitch ?? Number.NaN);
      hullWaterSamples(hero.hw.wake, heroSamples);
      // W8 round 3: the impact pulse rises over WAKE_LOAD_RISE_SECONDS, not one tick
      let total = 0;
      for (const sm of heroSamples) total += sm.fy;
      const share = wakeLoadRamp(heroLoad, total, dt);
      if (share < 1) for (const sm of heroSamples) sm.fy *= share;
      const pushStruts = (jets: readonly PropWashInput[], into: HydroSample[]): void => {
        const n = strutsFromJets(jets, struts);
        for (let k = 0; k < n; k++) {
          const q = appendageSample(struts[k], (strutSamples[k] ??= { x: 0, z: 0, fy: 0, footprint: 0, depth: 0 }));
          if (q) into.push({ ...q });
        }
      };
      pushStruts(heroFx.jets, heroSamples);
      // Both explicit transom shapes use signed visible heads, separate from positive hull loads.
      heroLifts.length = 0;
      hollowSamples(heroFx.hollow, heroLifts);
      humpSamples(heroFx.hollow, Math.hypot(hero.state.velocity[0], hero.state.velocity[2]), heroLifts);
      const hx = hero.state.position[0];
      const hz = hero.state.position[2];

      // rivals of their last collected step, nearest the hero first (ties by index)
      effects.length = 0;
      ids.length = 0;
      tick++;
      order.length = 0;
      const n = rivals ? rivals.spec.boats : 0;
      rivalLoads.length = n;
      for (let i = 0; i < n; i++) {
        const e = rivals!.effects(i);
        if (e.tick < 0) { contact.remove(i + 1); rivalLoads[i] = undefined; continue; }
        ids.push(i + 1);
        order.push(effects.length);
        effects.push(e);
      }
      const d2 = (k: number): number => {
        const p = effects[k].pose.position;
        const v = (p[0] - hx) ** 2 + (p[2] - hz) ** 2;
        return Number.isFinite(v) ? v : Infinity;
      };
      order.sort((a, b) => d2(a) - d2(b) || a - b);

      others.length = 0;
      jets.length = 0;
      emitters.length = 0;
      sheets.length = 0;
      for (const j of heroFx.jets) jets.push(j);
      const hv = hero.state.velocity;
      sheets.push(contact.update(0, tick, heroFx.bow, hv[0], hv[2], dt));
      // W9: the shared hull (§V110 every boat is the deep-V) — the hero's strips, applied to each boat's own pose
      const hull = hero.hw.mesh;
      hullEmitters.length = 0;
      let planed = 0;
      const planeBoat = (pose: Parameters<typeof planingContact>[1], fx: BoatFx): void => {
        const c = planingContact(hull, pose, fx.bow, fx.jets, (planing[planed] ??= createPlaningContact()));
        planed++;
        planingSprayEmitters(c, fx.bow, fx.jets, fx.hollow, hullEmitterPool, hullEmitters);
      };
      planeBoat(hero.state, heroFx);
      for (const k of order) {
        const e = effects[k];
        const p = e.pose;
        const rs = (rivalSamples[others.length] ??= []);
        const load = (rivalLoads[ids[k] - 1] ??= { load: 0, tick: e.tick });
        if (e.tick < load.tick) load.load = 0;
        load.tick = e.tick;
        let total = 0;
        for (const sm of e.wake) total += sm.fy;
        const share = wakeLoadRamp(load, total, dt);
        for (let i = 0; i < e.wake.length; i++) {
          const sm = e.wake[i];
          const copy = (rs[i] ??= { x: 0, z: 0, fy: 0, footprint: 0, depth: 0 });
          copy.x = sm.x;
          copy.z = sm.z;
          copy.fy = sm.fy * share;
          copy.footprint = sm.footprint;
          copy.depth = sm.depth;
        }
        rs.length = e.wake.length;
        pushStruts(e.fx.jets, rs);
        const rl = (rivalLifts[others.length] ??= []);
        rl.length = 0;
        if (e.fx.hollow) hollowSamples(e.fx.hollow, rl);
        if (e.fx.hollow) humpSamples(e.fx.hollow, Math.hypot(p.velocity[0], p.velocity[2]), rl);
        others.push({ samples: rs, jets: e.fx.jets, lifts: rl, x: p.position[0], z: p.position[2], vx: p.velocity[0], vz: p.velocity[2] });
        for (const j of e.fx.jets) jets.push(j);
        sheets.push(contact.update(ids[k], e.tick, e.fx.bow, p.velocity[0], p.velocity[2], dt));
        if (others.length < WAKE_MAX_VESSELS) planeBoat(p, e.fx);
      }
      planing.length = planed;

      emitters.push(...sheets);
      d.flowFoam.setPropWash(jets);
      d.flowFoam.setChineSheets?.(sheets);
      const sim = d.flowFoam.wakeSim;
      sim?.tick(hero.state, heroSamples, hero.bowAhead, dt, heroFx.jets, others, heroLifts);

      last.rivals = others.length;
      last.wakeVessels = sim ? sim.vesselCount : 0;
      last.culled = sim ? sim.vesselsCulled : 0;
      last.overflowed = sim ? sim.vesselsOverflowed : 0;
      last.sources = sim ? sim.sources.count + sim.sources.jetCount : 0;
      last.bow = visible ? bow.update(renderer, emitters, viewer) : 0;
      if (visible) sun();
      // W8 round 3: every drive strut's leading-edge sheet, nearest first, in the slots the props leave
      extras.length = 0;
      const ns = strutsFromJets(jets, fxStruts);
      for (let k = 0; k < ns; k++) {
        const jet = jets[k];
        const y = jet.surfaceY;
        if (y === undefined || !Number.isFinite(y)) continue;
        const e = strutSheetEmission(fxStruts[k], y, sprayParams, (extraPool[k] ??= { speed: 0, x: 0, surfaceY: 0, z: 0, dirX: 0, dirZ: 1, launch: 0, aft: 0, lateral: 0, rate: 0 }));
        if (e) extras.push(e);
      }
      extras.sort((a, b) => (a.x - viewer.x) ** 2 + (a.z - viewer.z) ** 2 - ((b.x - viewer.x) ** 2 + (b.z - viewer.z) ** 2));
      last.rooster = visible ? rooster.update(renderer, jets, viewer, extras) : 0;
      last.bubbles = visible ? bubbles.update(renderer, jets, viewer) : 0;
      last.hullSpray = visible ? hullSpray.update(renderer, hullEmitters, viewer) : 0;
      return last;
    },

    /** A player teleport starts a new contact source without deleting old foam. */
    resetContact(): void {
      contact.resetContact(0);
      heroLoad.load = 0;
    },

    /** the page's spray toggle (graphics settings): hidden pools are not stepped */
    setVisible(on: boolean): void {
      visible = on;
      for (const m of meshes) m.visible = on;
    },

    dispose(): void {
      bow.dispose();
      rooster.dispose();
      bubbles.dispose();
      hullSpray.dispose();
    },
  };
}

export type VesselFx = ReturnType<typeof createVesselFx>;
