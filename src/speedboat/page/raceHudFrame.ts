/**
 * THE HUD'S PER-FRAME INPUT (§T.191): fills `RaceUiFrame` (raceUi.ts) from what the page holds — the race session's
 * state and drained events, the player's crash machine, the drawn player view, the rivals' interpolated render poses,
 * the controls' assist state (Governor, rpm proxy, trim) and the camera. RENDER side only (§V3): reads, never writes
 * sim state. Allocates nothing per frame except the event arrays the session hands over.
 *
 * rpm ×3: the §T.189 engine model's per-drive rpm (`HullWater.driveRpm`), the same number thrust and the Governor use.
 */
import type { PerspectiveCamera } from 'three/webgpu';
import { Vector3 } from 'three/webgpu';
import type { OceanParams } from '../../params/ocean';
import type { Rigid6State } from '../../sea-physics/rigidBody';
import { CRASH_TIMINGS } from '../crash';
import type { RaceControls } from '../controls';
import type { NpcFleet } from './npcFleet';
import { PLAYER_RACER_ID, type RaceSession } from './raceSession';
import type { RaceUiFrame } from './raceUi';

const MPS_TO_KN = 3600 / 1852;

const yawOf = (q: ArrayLike<number>): number => Math.atan2(2 * (q[0] * q[2] + q[3] * q[1]), 1 - 2 * (q[0] * q[0] + q[1] * q[1]));

export interface RaceHudFrameDeps {
  session: RaceSession;
  npcs: NpcFleet;
  controls: RaceControls;
  camera: PerspectiveCamera;
  cameraMode(): string;
  /** the interpolated player view (frame.view) and the live sim state */
  view: Readonly<Rigid6State>;
  boat: Readonly<Rigid6State>;
  wettedArea(): number;
  /** per-drive rpm from the §T.189 engine model (HullWater.driveRpm) */
  driveRpm: ArrayLike<number>;
  oceanParams: Readonly<OceanParams>;
  seaLabel(): string;
  /** §T.202 the drawn pace boat (page/paceBoat `display`), for the HUD's pace marker */
  pace?: Readonly<{ visible: boolean; x: number; z: number }>;
}

export function createRaceHudFrame(d: RaceHudFrameDeps): { fill(dt: number): RaceUiFrame } {
  const racers = d.npcs.boats + 1;
  const racerX = new Float32Array(8);
  const racerZ = new Float32Array(8);
  const racerYaw = new Float32Array(8);
  const rpm = new Float32Array(3);
  const pose: Rigid6State = { position: [0, 0, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] };
  const v = new Vector3();
  const player: RaceUiFrame['player'] = { racerId: 0, phase: 'racing', crashKind: null, phaseTime: 0, speedBeforeCrash: 0, ghostTotal: CRASH_TIMINGS.ghost, fadeOut: CRASH_TIMINGS.fadeOut };
  const sea: RaceUiFrame['sea'] = { label: '', windKn: 0, windFromRad: 0, swellM: 0, swellDirRad: 0 };
  const frame: RaceUiFrame = {
    dt: 0, state: null, events: [], crashEvents: [], player, speedMps: 0, rpm, trimDeg: 0, pitchDeg: 0, airborne: false,
    governor: 'air', cameraMode: 'chase', racerX, racerZ, racerYaw, playerX: 0, playerZ: 0, playerYaw: 0,
    project: (x, y, z, out) => {
      v.set(x, y, z).project(d.camera);
      out.x = v.x;
      out.y = v.y;
      out.z = v.z;
    },
    sea,
    pace: d.pace ?? null,
  };
  return {
    fill(dt) {
      const s = d.session;
      const drained = s.drain();
      frame.dt = dt;
      frame.state = s.state;
      frame.events = drained.events;
      frame.crashEvents = drained.crashEvents;
      const m = s.machines[PLAYER_RACER_ID];
      player.phase = m.phase;
      player.crashKind = m.kind;
      player.phaseTime = m.phaseTime;
      player.speedBeforeCrash = m.speedBeforeCrash;
      const b = d.boat;
      frame.speedMps = Math.hypot(b.velocity[0], b.velocity[2]);
      for (let k = 0; k < 3; k++) rpm[k] = d.driveRpm[k] ?? 0;
      frame.trimDeg = (d.controls.command.trimRad * 180) / Math.PI;
      const q = b.quaternion;
      frame.pitchDeg = (Math.asin(Math.max(-1, Math.min(1, 2 * (q[1] * q[2] - q[3] * q[0])))) * 180) / Math.PI;
      frame.airborne = d.wettedArea() < 0.5;
      frame.governor = d.controls.settings.governor.toLowerCase() as RaceUiFrame['governor'];
      const cm = d.cameraMode();
      frame.cameraMode = cm === 'near' || cm === 'cockpit' ? cm : 'chase';
      frame.playerX = d.view.position[0];
      frame.playerZ = d.view.position[2];
      frame.playerYaw = yawOf(d.view.quaternion);
      racerX[PLAYER_RACER_ID] = frame.playerX;
      racerZ[PLAYER_RACER_ID] = frame.playerZ;
      racerYaw[PLAYER_RACER_ID] = frame.playerYaw;
      for (let id = 1; id < racers && id < 8; id++) {
        d.npcs.renderPose(id - 1, 1, pose);
        racerX[id] = pose.position[0];
        racerZ[id] = pose.position[2];
        racerYaw[id] = yawOf(pose.quaternion);
      }
      const op = d.oceanParams;
      sea.label = d.seaLabel();
      sea.windKn = op.windSpeed * MPS_TO_KN;
      // ocean params bearings are atan2(z, x); physics yaw is atan2(x, z)
      sea.windFromRad = Math.PI / 2 - op.windDirection + Math.PI;
      sea.swellDirRad = Math.PI / 2 - op.swellDirection;
      sea.swellM = op.swellAmplitude;
      return frame;
    },
  };
}
