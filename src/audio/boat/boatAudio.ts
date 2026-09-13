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
  dispose(): void;
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
      numberOfOutputs: SLOT_COUNT,
      outputChannelCount: new Array(SLOT_COUNT).fill(1),
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
  return { node, bus, comp, playerEngine, playerWater, npc, created };
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
        const info = s.boat >= 0 ? npcInfo.get(s.boat) : undefined;
        const o = (2 + i) * SLOT_STRIDE;
        if (s.boat < 0 || !info) {
          n.steal.gain.setTargetAtTime(0, now, 0.01);
          continue;
        }
        let tr = tracks.get(s.boat);
        if (!tr) tracks.set(s.boat, (tr = new DopplerTrack()));
        const delayTime = n.delay.delayTime;
        if (s.switched || n.boat !== s.boat) {
          tr.reset(info.d, p.maxDelay);
          delayTime.cancelScheduledValues(now);
          delayTime.setValueAtTime(tr.delay, now);
          n.boat = s.boat;
        } else {
          const v = tr.step(info.d, h, p.dopplerTau, p.maxDelay);
          delayTime.linearRampToValueAtTime(v, n.clock.next(now, h));
        }
        placePanner(n.panner, info.x, info.y, info.z);
        n.steal.gain.setTargetAtTime(s.phase === 'playing' ? 1 : 0, now, s.phase === 'playing' ? 0.015 : p.stealFade / 3);
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
      }
      graph = null;
      detectors.clear();
      tracks.clear();
      reports.clear();
    },
  };
}
