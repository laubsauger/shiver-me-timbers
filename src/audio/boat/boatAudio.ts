/**
 * §T.183 SPEEDBOAT ENGINE + HULL AUDIO — the page-facing object.
 *
 *   const boatAudio = createBoatAudio(engine);          // engine = src/audio/engine.ts createEngine()
 *   loop: boatAudio.update(frames, dt, camera);          // every render frame
 *
 * GRAPH (26 nodes with 7 NPC slots; budget ≤ 50, tech-research §6.3):
 *
 *   AudioWorkletNode 'boat-audio' (1 node, 9 mono outputs, all DSP + rpm models inside)
 *     out 0 player engines ─► Panner HRTF ───────────────────────────┐
 *     out 1 player water   ─► Panner HRTF ───────────────────────────┤
 *     out k NPC slot       ─► DelayNode (doppler) ─► Gain (steal) ─► Panner equalpower ─┤
 *                                                                    ▼
 *                                                     bus Gain ─► DynamicsCompressor ─► engine sfx bus
 *
 * Panners do DIRECTION only (distanceModel 'linear', rolloff 0): distance gain and air absorption
 * are applied inside the worklet from `mixMath` (§V96 — the shared `emitterMaxDistance` 350 m
 * plateau would make a rival at 1 km as loud as one at 350 m). `createPanner`/`setPannerPosition`
 * re-apply that shared model every frame, which is why this file positions its own panners.
 * Two HRTF panners only (player); NPCs are equalpower.
 *
 * CINE SFX STEMS (`stemTaps()`, built on first call, never before): parallel sends for the trailer's stem pass.
 * Post-voice (post-panner), pre-bus/compressor/master; nothing in the game path is rerouted, so the mix is unchanged.
 *   worklet out 9+k (slot k's WATER only) ─► Delay ─► Gain ─► Panner   mirrors of slot k's chain, same automation
 *   water  = player-water panner + the 7 water mirrors
 *   engine = player-engine panner + the 7 NPC panners (engine + water) + Gain(−1) ◄─ the 7 water mirrors
 * +22 nodes (48 total, budget ≤ 50).
 */
import type { AudioEngine } from '../engine';
import { applyListenerPose, listenerPoseFromMatrix, type HasWorldMatrix, type ListenerPose } from '../emitters';
import { finite } from './dsp';
import {
  BOAT_STRIDE,
  DEFAULT_VOICE_TUNABLES,
  LAYER_ENGINE,
  LAYER_WATER,
  NPC_SLOTS,
  PLAYER_ENGINE_SLOT,
  PLAYER_WATER_SLOT,
  REPORT_STRIDE,
  RI,
  SI,
  SLOT_COUNT,
  SLOT_STRIDE,
  STEM_WATER_OUTPUT0,
  OUTPUT_COUNT,
  WORKLET_NAME,
  type VoiceTunables,
} from './protocol';
import {
  BoatEventDetector,
  DopplerTrack,
  RampClock,
  airAbsorptionCutoffHz,
  assignNpcSlots,
  audibility,
  createNpcSlots,
  distanceGain,
  packBoat,
  type BoatFrameTelemetry,
  type NpcSlot,
  type VoiceCandidate,
} from './mixMath';
import { boatAudioParams, type BoatAudioParams } from './params';

export type { BoatFrameTelemetry } from './mixMath';

export interface BoatRpmReport {
  rpm: [number, number, number];
  limiterCut: [boolean, boolean, boolean];
  overrun: [boolean, boolean, boolean];
  load: [number, number, number];
}

export interface BoatAudio {
  /** true once the worklet module has loaded and the graph exists */
  ready(): boolean;
  /** per render frame. `camera` drives the WebAudio listener; pass null if the page sets the listener itself */
  update(frames: readonly BoatFrameTelemetry[], dt: number, camera: HasWorldMatrix | null): void;
  /** last worklet report for a boat (~15 Hz), or null */
  rpmOf(id: number): BoatRpmReport | null;
  /** AudioNodes this system created (excludes the engine's own buses) */
  nodeCount(): number;
  /** NPC slot table (harness/debug) */
  slots(): readonly NpcSlot[];
  /** the load error, if the worklet failed to load (fail loud, audio never breaks the page) */
  error(): string | null;
  /**
   * cine stems: split SFX stems as tap nodes (connect each node of a stem into your recorder; never reroute them).
   * engine = every engine voice (player + NPCs), water = hull slap / landing / spray / wake / hiss (player + NPCs).
   * Post-voice, pre-master; the game mix is unchanged. null until the worklet graph exists (audio unlocked).
   */
  stemTaps(): BoatStemTaps | null;
  dispose(): void;
}

export interface BoatStemTaps {
  engine: readonly AudioNode[];
  water: readonly AudioNode[];
}

export interface BoatAudioOptions {
  /** override the bundled worklet URL (tests) */
  workletUrl?: string;
  params?: BoatAudioParams;
}

interface Graph {
  node: AudioWorkletNode;
  bus: GainNode;
  comp: DynamicsCompressorNode;
  playerEngine: PannerNode;
  playerWater: PannerNode;
  npc: { delay: DelayNode; steal: GainNode; panner: PannerNode; clock: RampClock; boat: number }[];
  created: number;
  stems: { taps: BoatStemTaps; water: { delay: DelayNode; steal: GainNode; panner: PannerNode }[]; invert: GainNode } | null;
}

function placePanner(p: PannerNode, x: number, y: number, z: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
  const node = p as PannerNode & { positionX?: AudioParam; setPosition?: (x: number, y: number, z: number) => void };
  if (node.positionX) {
    node.positionX.value = x;
    p.positionY.value = y;
    p.positionZ.value = z;
  } else node.setPosition?.(x, y, z);
}

function directionOnlyPanner(ctx: BaseAudioContext, model: PanningModelType): PannerNode {
  const p = ctx.createPanner();
  p.panningModel = model;
  p.distanceModel = 'linear';
  p.refDistance = 1;
  p.maxDistance = 10000;
  p.rolloffFactor = 0;
  return p;
}

/** build the node graph on a context whose worklet module is loaded; exported for the node-budget test */
export function buildBoatGraph(ctx: BaseAudioContext, out: AudioNode, p: BoatAudioParams): Graph {
  let created = 0;
  const count = <T>(n: T): T => {
    created++;
    return n;
  };
  const node = count(
    new AudioWorkletNode(ctx, WORKLET_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: OUTPUT_COUNT,
      outputChannelCount: new Array(OUTPUT_COUNT).fill(1),
    }),
  );
  const bus = count(ctx.createGain());
  bus.gain.value = p.busGain;
  const comp = count(ctx.createDynamicsCompressor());
  comp.threshold.value = -14;
  comp.knee.value = 8;
  comp.ratio.value = 3.5;
  comp.attack.value = 0.004;
  comp.release.value = 0.18;
  bus.connect(comp);
  comp.connect(out);
  const playerEngine = count(directionOnlyPanner(ctx, 'HRTF'));
  const playerWater = count(directionOnlyPanner(ctx, 'HRTF'));
  node.connect(playerEngine, PLAYER_ENGINE_SLOT);
  node.connect(playerWater, PLAYER_WATER_SLOT);
  playerEngine.connect(bus);
  playerWater.connect(bus);
  const npc: Graph['npc'] = [];
  for (let i = 0; i < NPC_SLOTS; i++) {
    const delay = count(ctx.createDelay(Math.max(0.1, p.maxDelay)));
    const steal = count(ctx.createGain());
    steal.gain.value = 0;
    const panner = count(directionOnlyPanner(ctx, 'equalpower'));
    node.connect(delay, 2 + i);
    delay.connect(steal);
    steal.connect(panner);
    panner.connect(bus);
    npc.push({ delay, steal, panner, clock: new RampClock(), boat: -1 });
  }
  return { node, bus, comp, playerEngine, playerWater, npc, created, stems: null };
}

/** cine stems: the stem mirrors (see header); exported for the node-budget test */
export function buildStemTaps(ctx: BaseAudioContext, g: Graph, p: BoatAudioParams): BoatStemTaps {
  if (g.stems) return g.stems.taps;
  const invert = ctx.createGain();
  invert.gain.value = -1;
  const water: NonNullable<Graph['stems']>['water'] = [];
  for (let i = 0; i < NPC_SLOTS; i++) {
    const src = g.npc[i];
    const delay = ctx.createDelay(Math.max(0.1, p.maxDelay));
    delay.delayTime.value = src.delay.delayTime.value;
    const steal = ctx.createGain();
    steal.gain.value = src.steal.gain.value;
    const panner = directionOnlyPanner(ctx, 'equalpower');
    const sp = src.panner as PannerNode & { positionX?: AudioParam };
    if (sp.positionX) placePanner(panner, sp.positionX.value, src.panner.positionY.value, src.panner.positionZ.value);
    g.node.connect(delay, STEM_WATER_OUTPUT0 + i);
    delay.connect(steal);
    steal.connect(panner);
    panner.connect(invert);
    water.push({ delay, steal, panner });
  }
  g.created += 1 + 3 * NPC_SLOTS;
  const taps: BoatStemTaps = {
    engine: [g.playerEngine, ...g.npc.map((n) => n.panner), invert],
    water: [g.playerWater, ...water.map((w) => w.panner)],
  };
  g.stems = { taps, water, invert };
  g.node.port.postMessage({ t: 'stems', on: true });
  return taps;
}

export function createBoatAudio(engine: Pick<AudioEngine, 'getContext' | 'getBuses'>, opts: BoatAudioOptions = {}): BoatAudio {
  const p = opts.params ?? boatAudioParams;
  let graph: Graph | null = null;
  let building = false;
  let failed: string | null = null;
  const detectors = new Map<number, BoatEventDetector>();
  const tracks = new Map<number, DopplerTrack>();
  const reports = new Map<number, BoatRpmReport>();
  const npcSlots = createNpcSlots(NPC_SLOTS);
  let lastTunables = '';
  let pose: ListenerPose = { px: 0, py: 0, pz: 0, fx: 0, fy: 0, fz: -1, ux: 0, uy: 1, uz: 0 };

  const build = async (ctx: AudioContext, out: AudioNode): Promise<void> => {
    building = true;
    try {
      const url = opts.workletUrl ?? (await import('./workletUrl')).default;
      await ctx.audioWorklet.addModule(url);
      graph = buildBoatGraph(ctx, out, p);
      graph.node.port.onmessage = (e: MessageEvent) => {
        const m = e.data as { t: string; data: Float32Array; count: number; nanResets: number };
        if (m?.t !== 'report') return;
        if (m.nanResets > 0 && !failed) console.warn(`[boatAudio] worklet reset ${m.nanResets} non-finite engine state(s)`);
        for (let b = 0; b < m.count; b++) {
          const o = b * REPORT_STRIDE;
          const d = m.data;
          reports.set(d[o + RI.ID], {
            rpm: [d[o + RI.RPM], d[o + RI.RPM + 1], d[o + RI.RPM + 2]],
            limiterCut: [d[o + RI.CUT] > 0, d[o + RI.CUT + 1] > 0, d[o + RI.CUT + 2] > 0],
            overrun: [d[o + RI.OVERRUN] > 0, d[o + RI.OVERRUN + 1] > 0, d[o + RI.OVERRUN + 2] > 0],
            load: [d[o + RI.LOAD], d[o + RI.LOAD + 1], d[o + RI.LOAD + 2]],
          });
        }
      };
    } catch (err) {
      failed = err instanceof Error ? err.message : String(err);
      console.error(`[boatAudio] worklet failed to load — boat audio is OFF: ${failed}`);
    } finally {
      building = false;
    }
  };

  const sendTunables = (g: Graph): void => {
    const v: Partial<VoiceTunables> = {};
    for (const k of Object.keys(DEFAULT_VOICE_TUNABLES) as (keyof VoiceTunables)[]) v[k] = p[k];
    const key = JSON.stringify(v);
    if (key === lastTunables) return;
    lastTunables = key;
    g.node.port.postMessage({ t: 'tunables', v });
    g.bus.gain.value = p.busGain;
  };

  return {
    ready: () => graph !== null,
    error: () => failed,
    nodeCount: () => graph?.created ?? 0,
    slots: () => npcSlots,
    rpmOf: (id) => reports.get(id) ?? null,
    stemTaps: () => {
      const ctx = engine.getContext();
      return graph && ctx ? buildStemTaps(ctx, graph, p) : null;
    },

    update(frames, dt, camera) {
      const h = Math.min(0.25, Math.max(0, finite(dt)));
      // events are detected even before audio unlocks, so a landing's air time is never lost
      const events = frames.map((f) => {
        let d = detectors.get(f.id);
        if (!d) detectors.set(f.id, (d = new BoatEventDetector()));
        return d.step(f, h, p);
      });
      const ctx = engine.getContext();
      const buses = engine.getBuses();
      if (!ctx || !buses || ctx.state !== 'running' || failed) return;
      if (!graph) {
        if (!building) void build(ctx, buses.sfx);
        return;
      }
      const g = graph;
      sendTunables(g);
      if (camera) {
        pose = listenerPoseFromMatrix(camera.matrixWorld.elements);
        applyListenerPose(ctx.listener, pose);
      }
      const dist = (x: number, y: number, z: number): number => Math.hypot(x - pose.px, y - pose.py, z - pose.pz);

      const boats = new Float32Array(Math.max(1, frames.length) * BOAT_STRIDE);
      const slots = new Float32Array(SLOT_COUNT * SLOT_STRIDE);
      for (let i = 0; i < SLOT_COUNT; i++) slots[i * SLOT_STRIDE + SI.BOAT] = -1;

      const candidates: VoiceCandidate[] = [];
      const npcInfo = new Map<number, { d: number; gain: number; x: number; y: number; z: number }>();
      let nBoats = 0;
      let playerSeen = false;
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        const ex = f.enginePosition ? finite(f.enginePosition[0]) : finite(f.position[0]);
        const ey = f.enginePosition ? finite(f.enginePosition[1]) : finite(f.position[1]) + p.engineEmitterY;
        const ez = f.enginePosition ? finite(f.enginePosition[2]) : finite(f.position[2]);
        const d = dist(ex, ey, ez);
        if (!f.isPlayer && d > p.cullDistance) continue;
        packBoat(f, events[i], boats, nBoats++, (f.id * 2654435761) >>> 0);
        if (f.isPlayer && !playerSeen) {
          playerSeen = true;
          placePanner(g.playerEngine, ex, ey, ez);
          const wx = finite(f.position[0]);
          const wy = finite(f.position[1]);
          const wz = finite(f.position[2]);
          placePanner(g.playerWater, wx, wy, wz);
          const dw = dist(wx, wy, wz);
          const eo = PLAYER_ENGINE_SLOT * SLOT_STRIDE;
          slots[eo + SI.BOAT] = f.id;
          slots[eo + SI.FULL] = 1;
          slots[eo + SI.GAIN] = distanceGain(d, p);
          slots[eo + SI.AIR_HZ] = airAbsorptionCutoffHz(d, p.airAbsorptionScale);
          slots[eo + SI.MASK] = LAYER_ENGINE;
          const wo = PLAYER_WATER_SLOT * SLOT_STRIDE;
          slots[wo + SI.BOAT] = f.id;
          slots[wo + SI.FULL] = 1;
          slots[wo + SI.GAIN] = distanceGain(dw, p);
          slots[wo + SI.AIR_HZ] = airAbsorptionCutoffHz(dw, p.airAbsorptionScale);
          slots[wo + SI.MASK] = LAYER_WATER;
        } else if (!f.isPlayer) {
          const gain = distanceGain(d, p);
          candidates.push({ id: f.id, score: audibility(gain, f.throttle), delay: Math.min(p.maxDelay, d / 343) });
          npcInfo.set(f.id, { d, gain, x: ex, y: ey, z: ez });
        }
      }

      assignNpcSlots(npcSlots, candidates, h, p);
      const now = ctx.currentTime;
      for (let i = 0; i < NPC_SLOTS; i++) {
        const s = npcSlots[i];
        const n = g.npc[i];
        // cine stems: the water stem mirror gets the SAME automation, so engine = NPC panner − mirror cancels the water
        const m = g.stems?.water[i];
        const info = s.boat >= 0 ? npcInfo.get(s.boat) : undefined;
        const o = (2 + i) * SLOT_STRIDE;
        if (s.boat < 0 || !info) {
          n.steal.gain.setTargetAtTime(0, now, 0.01);
          m?.steal.gain.setTargetAtTime(0, now, 0.01);
          continue;
        }
        let tr = tracks.get(s.boat);
        if (!tr) tracks.set(s.boat, (tr = new DopplerTrack()));
        const delayTime = n.delay.delayTime;
        if (s.switched || n.boat !== s.boat) {
          tr.reset(info.d, p.maxDelay);
          delayTime.cancelScheduledValues(now);
          delayTime.setValueAtTime(tr.delay, now);
          m?.delay.delayTime.cancelScheduledValues(now);
          m?.delay.delayTime.setValueAtTime(tr.delay, now);
          n.boat = s.boat;
        } else {
          const v = tr.step(info.d, h, p.dopplerTau, p.maxDelay);
          const at = n.clock.next(now, h);
          delayTime.linearRampToValueAtTime(v, at);
          m?.delay.delayTime.linearRampToValueAtTime(v, at);
        }
        placePanner(n.panner, info.x, info.y, info.z);
        const stealTo = s.phase === 'playing' ? 1 : 0;
        const stealTau = s.phase === 'playing' ? 0.015 : p.stealFade / 3;
        n.steal.gain.setTargetAtTime(stealTo, now, stealTau);
        if (m) {
          placePanner(m.panner, info.x, info.y, info.z);
          m.steal.gain.setTargetAtTime(stealTo, now, stealTau);
        }
        slots[o + SI.BOAT] = s.boat;
        slots[o + SI.FULL] = s.full ? 1 : 0;
        slots[o + SI.GAIN] = info.gain;
        slots[o + SI.AIR_HZ] = airAbsorptionCutoffHz(info.d, p.airAbsorptionScale);
        slots[o + SI.MASK] = LAYER_ENGINE | LAYER_WATER;
      }
      for (const id of tracks.keys()) if (!npcInfo.has(id)) tracks.delete(id);
      for (const id of detectors.keys()) if (!frames.some((f) => f.id === id)) detectors.delete(id);

      g.node.port.postMessage({ t: 'frame', boats, nBoats, slots }, [boats.buffer, slots.buffer]);
    },

    dispose() {
      if (graph) {
        graph.node.port.onmessage = null;
        graph.node.disconnect();
        for (const n of graph.npc) {
          n.delay.disconnect();
          n.steal.disconnect();
          n.panner.disconnect();
        }
        graph.playerEngine.disconnect();
        graph.playerWater.disconnect();
        graph.bus.disconnect();
        graph.comp.disconnect();
        if (graph.stems) {
          for (const w of graph.stems.water) {
            w.delay.disconnect();
            w.steal.disconnect();
            w.panner.disconnect();
          }
          graph.stems.invert.disconnect();
        }
      }
      graph = null;
      detectors.clear();
      tracks.clear();
      reports.clear();
    },
  };
}
