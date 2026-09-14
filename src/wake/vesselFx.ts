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
 * The spray reads the camera for PRIORITY only; nothing here feeds a force (§V8a: the wake is visual-only until §T.170,
 * so §V108 — a hull never reads its own same-tick wake — holds trivially).
 */
import type * as THREE from 'three/webgpu';
import { createBowSprayFleet, type BowFleetEmitter } from '../foam/bowSpray';
import { createPropBubbles, createRoosterTail } from '../foam/roosterTail';
import type { WakeLoadSamples } from '../sea-physics/hullWater';
import type { Rigid6State } from '../sea-physics/rigidBody';
import type { BoatEffects } from '../sim-worker/fleet';
import { FX_LEN, createBoatFx, readBoatFx, writeBoatFx, type BoatFx, type BoatFxSource } from '../sim-worker/fx';
import type { PropWashInput } from './propWash';
import { hullWaterSamples } from './stationSources';
import { WAKE_MAX_VESSELS, type VesselWakeInput, type WakeSim } from './wakeSim';
import type { HydroSample } from './wakeSolverMath';
import { ChineContactHistory, type ChineSheetEmitter } from './chineContact';

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
}

export function createVesselFx(d: VesselFxDeps) {
  const bow = createBowSprayFleet();
  // §T.199 4096 per pool: the plume's drops live ≈ 2.4 s, so 2048 turned over ≈ 630/s for the whole fleet (sparse balls)
  const rooster = createRoosterTail({ maxJets: VESSEL_FX_JETS, count: 4096 });
  const bubbles = createPropBubbles({ maxJets: VESSEL_FX_JETS });
  /** bow sheet, rooster drops, prop bubbles, rooster mist (§T.199: the mist pool appended last) */
  const meshes = [bow.mesh, rooster.meshes[0], bubbles.mesh, rooster.meshes[1]];
  d.scene.add(...meshes);
  for (const m of meshes) d.reflection?.excludeFromReflection(m);

  const heroRecord = new Float64Array(FX_LEN);
  const heroFx: BoatFx = createBoatFx();
  const heroSamples: HydroSample[] = [];
  const others: VesselWakeInput[] = [];
  const jets: PropWashInput[] = [];
  const emitters: BowFleetEmitter[] = [];
  const sheets: ChineSheetEmitter[] = [];
  const contact = new ChineContactHistory();
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
    }
  };
  const last: VesselFxTick = { rivals: 0, wakeVessels: 0, culled: 0, overflowed: 0, sources: 0, bow: 0, rooster: 0, bubbles: 0 };

  return {
    meshes,
    /** the hero's decoded record of the last tick (jets, waterline spray) */
    heroFx,
    /** this tick's rival wake inputs and every jet (hero first) — debug/tests */
    others,
    /** §T.199 the emitters (debug readback / tests) */
    pools: { bow, rooster, bubbles },
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
      const hx = hero.state.position[0];
      const hz = hero.state.position[2];

      // rivals of their last collected step, nearest the hero first (ties by index)
      effects.length = 0;
      ids.length = 0;
      tick++;
      order.length = 0;
      const n = rivals ? rivals.spec.boats : 0;
      for (let i = 0; i < n; i++) {
        const e = rivals!.effects(i);
        if (e.tick < 0) { contact.remove(i + 1); continue; }
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
      for (const k of order) {
        const e = effects[k];
        const p = e.pose;
        others.push({ samples: e.wake, jets: e.fx.jets, x: p.position[0], z: p.position[2], vx: p.velocity[0], vz: p.velocity[2] });
        for (const j of e.fx.jets) jets.push(j);
        sheets.push(contact.update(ids[k], e.tick, e.fx.bow, p.velocity[0], p.velocity[2], dt));
      }

      emitters.push(...sheets);
      d.flowFoam.setPropWash(jets);
      d.flowFoam.setChineSheets?.(sheets);
      const sim = d.flowFoam.wakeSim;
      sim?.tick(hero.state, heroSamples, hero.bowAhead, dt, heroFx.jets, others);

      last.rivals = others.length;
      last.wakeVessels = sim ? sim.vesselCount : 0;
      last.culled = sim ? sim.vesselsCulled : 0;
      last.overflowed = sim ? sim.vesselsOverflowed : 0;
      last.sources = sim ? sim.sources.count + sim.sources.jetCount : 0;
      last.bow = visible ? bow.update(renderer, emitters, viewer) : 0;
      if (visible) sun();
      last.rooster = visible ? rooster.update(renderer, jets, viewer) : 0;
      last.bubbles = visible ? bubbles.update(renderer, jets, viewer) : 0;
      return last;
    },

    /** A player teleport starts a new contact source without deleting old foam. */
    resetContact(): void { contact.remove(0); },

    /** the page's spray toggle (graphics settings): hidden pools are not stepped */
    setVisible(on: boolean): void {
      visible = on;
      for (const m of meshes) m.visible = on;
    },

    dispose(): void {
      bow.dispose();
      rooster.dispose();
      bubbles.dispose();
    },
  };
}

export type VesselFx = ReturnType<typeof createVesselFx>;
