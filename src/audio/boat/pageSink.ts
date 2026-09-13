/**
 * §T.183 adapter onto the speedboat page's `BoatAudioSink` seam (src/speedboat/page/seams.ts, §T.181).
 * Structural types only — this file does not import the page, so boat audio stays self-contained (§V109)
 * and the page swaps `createSilentAudio()` for `createSpeedboatAudioSink(...)` with no other change.
 *
 * What the seam's `BoatAudioFrame` carries today and what it does not (docs/speedboat/audio.md, "hooks"):
 *  - player drive advance/immersion per drive are OPTIONAL extras here; absent ⟹ ground speed and the
 *    scalar `propImmersion` stand in;
 *  - `slamImpulse` is written per tick by the page; a frame covering two ticks sees only the last one;
 *  - NPCs are not in the frame: pass the fleet (`pose(i)`) and, when it exists, their contact summary.
 */
import { createEngine, type AudioEngine } from '../engine';
import type { HasWorldMatrix } from '../emitters';
import { attachAudioSettings, type SettingsSource } from '../settingsBridge';
import { rotateVec } from '../../core/quat';
import type { Quat, Vec3 } from '../../state/simState';
import { createBoatAudio, type BoatAudio } from './boatAudio';
import type { BoatFrameTelemetry } from './mixMath';
import { boatAudioParams, type BoatAudioParams } from './params';
import type { VoiceKind } from './engineModel';

/** the seam's BoatAudioFrame, structurally */
export interface BoatAudioFrameLike {
  frameDt: number;
  view: { position: ArrayLike<number>; quaternion: ArrayLike<number> };
  boat: { velocity: ArrayLike<number> };
  controls: { throttle: number };
  contact: {
    wettedArea: number;
    slamImpulse: number;
    propImmersion: number;
    driveThrust: ArrayLike<number>;
    /** optional extras: hullWater `driveAdvance` / `driveImmersion` */
    driveAdvance?: ArrayLike<number>;
    driveImmersion?: ArrayLike<number>;
  };
}

/** the page's NpcFleet, structurally */
export interface NpcSourceLike {
  readonly boats: number;
  pose(i: number): Readonly<{ position: ArrayLike<number>; quaternion: ArrayLike<number>; velocity: ArrayLike<number> }>;
}

export interface NpcContactLike {
  wettedArea: number;
  slamImpulse: number;
  propImmersion: number;
}

export interface SpeedboatAudioSinkOptions {
  /** the render camera (its matrixWorld is the listener) */
  camera: HasWorldMatrix;
  npcs?: NpcSourceLike;
  /** per-NPC throttle, if the race AI exposes it (default 0.8) */
  npcThrottle?: (i: number) => number;
  /** per-NPC contact summary, if the fleet exposes it (default: planing, props mostly in) */
  npcContact?: (i: number) => NpcContactLike | null;
  playerVoice?: VoiceKind;
  /** design doc §4/§7: most rivals V8, Shine turbine, Flat Jack two-stroke, Spark electric */
  npcVoices?: readonly VoiceKind[];
  settings?: SettingsSource;
  engine?: AudioEngine;
  params?: BoatAudioParams;
}

export const DEFAULT_NPC_VOICES: readonly VoiceKind[] = ['v8', 'turbine', 'v8', 'twoStroke', 'v8', 'electric', 'v8'];
export const PLAYER_BOAT_ID = 0;

/** engine cluster world position: the transom offset rotated by the drawn hull */
export function enginePositionOf(position: ArrayLike<number>, quaternion: ArrayLike<number>, p: Pick<BoatAudioParams, 'engineEmitterY' | 'engineOffsetZ'>): Vec3 {
  const q: Quat = [quaternion[0], quaternion[1], quaternion[2], quaternion[3]];
  const r = rotateVec(q, [0, p.engineEmitterY, p.engineOffsetZ]);
  return [position[0] + r[0], position[1] + r[1], position[2] + r[2]];
}

/** seam frame → player telemetry (pure; tested) */
export function playerTelemetry(f: Readonly<BoatAudioFrameLike>, voice: VoiceKind, p: Pick<BoatAudioParams, 'engineEmitterY' | 'engineOffsetZ'>): BoatFrameTelemetry {
  return {
    id: PLAYER_BOAT_ID,
    isPlayer: true,
    voice,
    position: f.view.position,
    velocity: f.boat.velocity,
    enginePosition: enginePositionOf(f.view.position, f.view.quaternion, p),
    throttle: f.controls.throttle,
    driveAdvance: f.contact.driveAdvance,
    driveImmersion: f.contact.driveImmersion,
    driveThrust: f.contact.driveThrust,
    propImmersion: f.contact.propImmersion,
    wettedArea: f.contact.wettedArea,
    slamImpulse: f.contact.slamImpulse,
  };
}

export function createSpeedboatAudioSink(o: SpeedboatAudioSinkOptions): {
  unlock(): void;
  update(frame: Readonly<BoatAudioFrameLike>): void;
  dispose(): void;
  readonly boatAudio: BoatAudio;
  readonly engine: AudioEngine;
} {
  const p = o.params ?? boatAudioParams;
  const engine = o.engine ?? createEngine();
  const boatAudio = createBoatAudio(engine, { params: p });
  const detach = o.settings ? attachAudioSettings(engine, o.settings) : null;
  const voices = o.npcVoices ?? DEFAULT_NPC_VOICES;
  const frames: BoatFrameTelemetry[] = [];
  return {
    boatAudio,
    engine,
    unlock() {
      void engine.resume();
    },
    update(frame) {
      frames.length = 0;
      frames.push(playerTelemetry(frame, o.playerVoice ?? 'v8', p));
      const npcs = o.npcs;
      if (npcs) {
        for (let i = 0; i < npcs.boats; i++) {
          const pose = npcs.pose(i);
          const c = o.npcContact?.(i) ?? null;
          frames.push({
            id: PLAYER_BOAT_ID + 1 + i,
            voice: voices[i % voices.length],
            position: pose.position,
            velocity: pose.velocity,
            enginePosition: enginePositionOf(pose.position, pose.quaternion, p),
            throttle: o.npcThrottle ? o.npcThrottle(i) : 0.8,
            propImmersion: c ? c.propImmersion : 0.85,
            wettedArea: c ? c.wettedArea : 5,
            slamImpulse: c ? c.slamImpulse : 0,
          });
        }
      }
      boatAudio.update(frames, frame.frameDt, o.camera);
    },
    dispose() {
      detach?.();
      boatAudio.dispose();
      if (!o.engine) engine.dispose();
    },
  };
}
