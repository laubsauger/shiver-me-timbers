/**
 * Audio system facade (T21). One entry point for main.ts: create it, hand it
 * a frame of render-side state every rAF, and forget about it.
 *
 *   assets/audio/sfx  ──lazy, sequential, silent-fail──┐
 *                                                      ▼
 *   bed.ts      layered ambience (ocean/wind/sailing) → ambience bus ┐
 *   shipAudio   panners: bow, stern, hull, rigging, 3 masts ─────────┼→ master
 *   events      sampled cannon/splinter/splash pools ─→ sfx bus ────┤
 *   oneshots    procedural hull-hit + cannon fallback ─→ sfx bus ────┘
 *
 * §V3: every value read here comes from SimState or the render transforms
 * derived from it; audio writes nothing back and cannot affect determinism.
 * §V17: per frame this is a handful of AudioParam writes and pure math — all
 * decoding happens off the main thread inside decodeAudioData.
 *
 * Failure policy: audio may never take the renderer down. No context, no
 * gesture yet, a 404 on a sample, a decode error — every one of those paths
 * ends in a silent no-op, and if the samples never arrive the old procedural
 * ambience takes over so the world is not dead quiet.
 */
import { createAmbience, type Ambience, type AmbienceEnv } from './ambience';
import { attachGestureResume, createEngine, type EngineBuses, type Volumes } from './engine';
import { cannonBoom, creak, hullHit, splash } from './oneshots';
import { createSampleLoader, type SampleLoader } from './assets';
import { createBed, type AmbienceBed } from './bed';
import { applyListenerPose, listenerPoseFromMatrix, type HasWorldMatrix } from './emitters';
import { createShipAudio, type ShipAudio, type ShipAudioInput } from './shipAudio';
import { createEventPlayer, type CombatEvent, type EventPlayer } from './events';
import { createMusicPlayer, type MusicInfo, type MusicPlayer } from './music';
import { musicStateFor } from './musicPlaylist';
import { hullWorking, type Weather } from './mix';
import { audioParams } from '../params/audio';
import { createRng, type Rng } from '../state/rng';

export type { AmbienceEnv } from './ambience';
export type { Volumes } from './engine';
export type { ShipAudioInput } from './shipAudio';
export type { ContactInput } from './mix';
export type { CombatEvent, CombatEventKind } from './events';
export type { MusicInfo } from './music';
export type { MusicState, MusicTrackRef } from './musicAssets';
export type { HasWorldMatrix } from './emitters';
export { attachAudioSettings } from './settingsBridge';

export type OneShotName = 'cannonBoom' | 'splash' | 'creak' | 'hullHit';

export interface PlayOpts {
  /** seeded rng for randomized one-shots (creak); defaults to an internal stream */
  rng?: Rng;
}

/** everything the audio system wants from one render frame */
export interface AudioFrame {
  /** render frame dt in seconds (clamped internally) */
  dt: number;
  /** the render camera — drives the listener, so turning it turns the field */
  camera?: HasWorldMatrix | null;
  wind: { speed: number; direction: number };
  weather: Weather;
  /** player ship pose/state; null before the ship exists */
  ship?: ShipAudioInput | null;
  /**
   * Metres to the nearest land (archipelago seabed sampler). Optional and
   * unused until music tagging is wired — pass it whenever it is cheap.
   */
  landDistance?: number;
}

/**
 * §V95 — HOW A MODE-SPECIFIC SOURCE JOINS THE ONE GRAPH.
 *
 * The facade builds its own arms (bed, ship, combat, music) because every mode
 * has them. The raft's radio does not belong in that list — `src/audio/` has no
 * business knowing what a station is — but it absolutely must share the
 * AudioContext, the listener and the three buses, or it is a second audio path
 * and §V95 is the invariant that says there is exactly one.
 *
 * So the facade offers a seam instead of a slot: hand `attach` a factory and it
 * is called with the live context and buses the moment they exist (which may be
 * BEFORE or AFTER the gesture unlock — attaching early is the normal case, so
 * the pending makers are kept and run inside `resume`). The returned handle is
 * ticked with every frame's dt and disposed with the system. `src/radio/` never
 * sees an AudioContext it made itself.
 */
export interface AudioAttachment {
  update(dt: number): void;
  dispose(): void;
}

export type AudioAttach = (ctx: BaseAudioContext, buses: EngineBuses) => AudioAttachment;

export interface AudioSystem {
  /** create/resume the AudioContext (also fired by the auto gesture unlock) */
  resume(): Promise<void>;
  /**
   * Add an extra source graph on the SAME context and buses (§V95). Returns a
   * detach function. Safe to call before the context exists.
   */
  attach(make: AudioAttach): () => void;
  /** per render frame */
  update(frame: AudioFrame): void;
  /** legacy shape kept alive so existing wiring keeps working */
  update(env: AmbienceEnv, dt: number): void;
  play(name: OneShotName, opts?: PlayOpts): void;
  /** discrete combat/destruction event, positional when `world` is given */
  event(e: CombatEvent): void;
  /** playlist status (debug/HUD): track count, current track, duck level */
  musicInfo(): MusicInfo;
  setVolumes(v: Partial<Volumes>): void;
  dispose(): void;
}

const DEFAULT_RNG_SEED = 0xc0ffee;
const MAX_DT = 0.25;

function isFrame(a: AudioFrame | AmbienceEnv): a is AudioFrame {
  return (a as AudioFrame).wind !== undefined;
}

export function createAudio(initialVolumes?: Partial<Volumes>): AudioSystem {
  const engine = createEngine(initialVolumes);
  const fallbackRng = createRng(DEFAULT_RNG_SEED);
  let bed: AmbienceBed | null = null;
  let ship: ShipAudio | null = null;
  let combat: EventPlayer | null = null;
  let music: MusicPlayer | null = null;
  let loader: SampleLoader | null = null;
  /** procedural bed — only built if the samples never showed up */
  let synth: Ambience | null = null;
  /** §V95 seam: makers waiting for a context, and the graphs they became */
  const pending = new Set<AudioAttach>();
  const attached = new Map<AudioAttach, AudioAttachment>();
  const buildAttachments = (ctx: BaseAudioContext, buses: EngineBuses): void => {
    for (const make of pending) attached.set(make, make(ctx, buses));
    pending.clear();
  };
  const resume = async (): Promise<void> => {
    await engine.resume();
    const ctx = engine.getContext();
    const buses = engine.getBuses();
    if (!ctx || !buses) return;
    buildAttachments(ctx, buses);
    if (bed) return;
    bed = createBed(ctx, buses.ambience);
    ship = createShipAudio(ctx, buses);
    combat = createEventPlayer(ctx, buses.sfx);
    // streamed, so nothing is fetched here beyond what the first track needs
    music = createMusicPlayer(ctx, buses.music);
    loader = createSampleLoader(ctx, (name, buffer) => {
      bed?.onSample(name, buffer);
      ship?.onSample(name, buffer);
      combat?.onSample(name, buffer);
    });
    void loader.loadAll().then(() => {
      // nothing decoded at all (offline build, blocked fetch…) → keep the
      // world alive with the synthesized bed rather than going silent
      if (!bed?.active() && !synth) synth = createAmbience(ctx, buses.ambience);
    });
  };

  // MUST be `resume`, not `engine` — engine.resume() only unlocks the
  // AudioContext, leaving bed/ship/loader null forever, which is silent and
  // errorless. Declared after resume() so the closure exists to hand over.
  const detachGesture =
    typeof window !== 'undefined' ? attachGestureResume({ resume }) : () => undefined;

  return {
    resume,
    attach(make: AudioAttach): () => void {
      const ctx = engine.getContext();
      const buses = engine.getBuses();
      if (ctx && buses) attached.set(make, make(ctx, buses));
      else pending.add(make);
      return (): void => {
        pending.delete(make);
        attached.get(make)?.dispose();
        attached.delete(make);
      };
    },
    update(a: AudioFrame | AmbienceEnv, legacyDt?: number): void {
      const frame: AudioFrame = isFrame(a)
        ? a
        : { dt: legacyDt ?? 1 / 60, wind: { speed: a.windSpeed, direction: 0 }, weather: a.weather };
      const ctx = engine.getContext();
      if (!ctx || ctx.state !== 'running') return; // pre-gesture: no-op
      const dt = Math.min(MAX_DT, Math.max(0, Number.isFinite(frame.dt) ? frame.dt : 0));
      const shipSpeed = frame.ship
        ? Math.hypot(frame.ship.velocity[0], frame.ship.velocity[2])
        : 0;

      if (frame.camera) {
        applyListenerPose(ctx.listener, listenerPoseFromMatrix(frame.camera.matrixWorld.elements));
      }
      // how hard the hull is working drives BOTH the ambience creak layer and
      // the positional rig creak/groans — one signal, one behaviour
      const working = frame.ship
        ? hullWorking(
            frame.ship.angularVelocity[0],
            frame.ship.angularVelocity[2],
            frame.ship.contact,
            audioParams,
          )
        : 0;
      bed?.update(
        { windSpeed: frame.wind.speed, weather: frame.weather, shipSpeed, working },
        dt,
      );
      if (frame.ship) {
        ship?.update(
          frame.ship,
          { windSpeed: frame.wind.speed, windDirection: frame.wind.direction, working },
          dt,
        );
      }
      synth?.update({ windSpeed: frame.wind.speed, weather: frame.weather }, dt);
      // tag seam: the situation is computed here so wiring real inputs later
      // (storm cells, distance to land) is a change of arguments, not shape
      music?.update(
        dt,
        musicStateFor({
          weather: frame.weather,
          landDistance: frame.landDistance,
          combatHeat: 0,
        }),
      );
      for (const a of attached.values()) a.update(dt);
    },
    play(name, opts) {
      const ctx = engine.getContext();
      const buses = engine.getBuses();
      if (!ctx || !buses || ctx.state !== 'running') return;
      switch (name) {
        case 'cannonBoom':
          cannonBoom(ctx, buses.sfx);
          break;
        case 'splash':
          splash(ctx, buses.sfx);
          break;
        case 'creak':
          creak(ctx, buses.sfx, opts?.rng ?? fallbackRng);
          break;
        case 'hullHit':
          hullHit(ctx, buses.sfx);
          break;
      }
    },
    event(e) {
      const ctx = engine.getContext();
      if (!ctx || ctx.state !== 'running') return;
      combat?.play(e);
      music?.duck(); // guns out → music steps back until the smoke clears
    },
    musicInfo: () =>
      music?.info() ?? { tracks: 0, current: null, state: 'calm' as const, duck: 1 },
    setVolumes(v) {
      engine.setVolumes(v);
    },
    dispose() {
      detachGesture();
      bed?.dispose();
      ship?.dispose();
      combat?.dispose();
      music?.dispose();
      synth?.dispose();
      for (const a of attached.values()) a.dispose();
      attached.clear();
      pending.clear();
      bed = null;
      ship = null;
      combat = null;
      music = null;
      synth = null;
      loader = null;
      engine.dispose();
    },
  };
}
