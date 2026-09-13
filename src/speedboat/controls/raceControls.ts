/**
 * THE PAGE'S CONTROL SOURCE (§T.182 → §T.181 seam `ControlSource`, src/speedboat/page/seams.ts): devices → BoatInput
 * → assists → the seam's shaped `BoatControls`. Runs in the FIXED tick, before the player's physics step (§V2).
 *
 * main-speedboat.ts swaps ONE line (the camera rig must be constructed first, as today):
 *   const controls = createRaceControls({ player, camera, enabled: () => !camera.capturesInput() }); // §T.182
 *
 * Mapping onto the seam: steer = drive angle / the drives' lock (the page multiplies back, so the drives get the
 * assisted angle exactly); throttle = the governed −0.3…1; trim = drive trim angle normalised to −1…1 over
 * −6°…+8° (carried, not read by the physics yet); surge = held or tapped.
 * The assists read the PREVIOUS tick's contact (`player.hw` holds its last substep when `sample` runs).
 */
import type { HullWater } from '../../sea-physics/hullWater';
import type { Rigid6State } from '../../sea-physics/rigidBody';
import {
  assistPreset,
  createAssistState,
  emptySimSample,
  readBoatSim,
  resetAssistState,
  stepAssists,
  TRIM_MAX,
  TRIM_MIN,
  type AssistSettings,
  type AssistState,
  type DriveCommand,
} from '../assists';
import type { BoatControls, ControlSource } from '../page/seams';
import { neutralBoatInput, type BoatInput } from './boatInput';
import { BoatInputDevices } from './inputDevices';

/** what the camera rig takes from the tick (look back, camera cycle, slam), see raceCam.ts `createRaceCameraRig` */
export interface PilotInputSink {
  pilotInput(input: Readonly<Pick<BoatInput, 'lookBack' | 'cameraCycle'>>, slamDeltaV: number): void;
}

export interface RaceControlsOptions {
  player: { readonly hw: HullWater; readonly hull: { readonly mass: number; readonly drives: readonly { readonly maxSteerRad: number }[] } };
  settings?: AssistSettings;
  devices?: BoatInputDevices;
  /** where key events are heard (default `window`); ignored when `devices` is given */
  target?: EventTarget;
  enabled?: () => boolean;
  camera?: PilotInputSink;
}

export interface RaceControls extends ControlSource {
  readonly devices: BoatInputDevices;
  /** live assist settings (mutate or replace fields; read every tick) */
  settings: AssistSettings;
  readonly assist: AssistState;
  /** this tick's raw BoatInput (the input log records this) and the drive command it produced */
  readonly input: Readonly<BoatInput>;
  readonly command: Readonly<DriveCommand>;
  /** respawn/teleport: forget helm, trim and governor memory (V108) */
  reset(): void;
}

export function createRaceControls(o: RaceControlsOptions): RaceControls {
  const devices = o.devices ?? new BoatInputDevices();
  if (!o.devices) devices.attach(o.target ?? (globalThis as unknown as { window: EventTarget }).window);
  const assist = createAssistState();
  const sim = emptySimSample();
  const idle = neutralBoatInput();
  const command: DriveCommand = { steerRad: 0, throttle: 0, trimRad: 0 };
  const out: BoatControls = { steer: 0, throttle: 0, trim: 0, surge: false };
  let input: Readonly<BoatInput> = idle;
  const rc: RaceControls = {
    devices,
    settings: o.settings ?? assistPreset('default'),
    assist,
    get input() {
      return input;
    },
    command,
    sample(dt: number, boat: Readonly<Rigid6State>): Readonly<BoatControls> {
      const live = devices.sample(dt);
      input = !o.enabled || o.enabled() ? live : idle;
      const hw = o.player.hw;
      const lock = o.player.hull.drives[0]?.maxSteerRad ?? 0;
      readBoatSim(hw, boat, sim);
      stepAssists(input, sim, rc.settings, assist, dt, lock, command);
      out.steer = lock > 0 ? command.steerRad / lock : 0;
      out.throttle = command.throttle;
      out.trim = command.trimRad >= 0 ? command.trimRad / TRIM_MAX : -command.trimRad / TRIM_MIN;
      out.surge = input.surge;
      o.camera?.pilotInput(live, hw.slamImpulse / o.player.hull.mass);
      return out;
    },
    reset() {
      resetAssistState(assist);
    },
    dispose() {
      if (!o.devices) devices.detach();
    },
  };
  return rc;
}
