/**
 * §T.103 (first slice) — THE RADIO RUNTIME: the one object that turns a dial
 * position into a signal, a lock, a mix and a clip to play.
 *
 * It owns exactly three pieces of state — the lock's dwell, the fragment
 * timer, and the last snapshot — and every decision it makes comes out of
 * `tuner.ts` and `radioMix.ts`, which are pure. That split is the whole design:
 * `step()` can be driven a thousand times in a test with no context, no camera
 * and no clock, and what it returns is the same thing the audio adapter and
 * the needles are handed (§B100: assert what the WORLD does, not that a
 * handler exists — so there has to be a world-facing value to assert).
 */
import { radioParams, type RadioParams } from '../params/radio';
import {
  dialFrequency,
  NO_LOCK,
  readTuner,
  stepLock,
  type LockState,
  type RadioStation,
  type StationSignal,
} from './tuner';
import { NO_FRAGMENT, radioMix, stepFragments, type FragmentState, type RadioMix } from './radioMix';
import { RADIO_STATIONS, type RadioStationDef } from './stations';

/**
 * §T.156 — A LOCK YOU KEEP. A station that has once held its dwell is
 * REMEMBERED: its id, the frequency it sits on, and the world (x, z)
 * `bindStations` resolved for it. The bearing is NOT stored — it is recomputed
 * from the raft's live position every frame, because a frozen bearing is a
 * lie the moment the raft moves (§V71, and the whole reason the radio is a
 * direction finder rather than a quest marker).
 *
 * This is what lets the set be switched off: the hiss is a thing you choose to
 * hear while you hunt, and the fix is what you sail on afterwards.
 */
export interface RadioFix {
  id: string;
  /** the station's own frequency, so the dial can be sent back to it */
  freqMHz: number;
  /** the aerial, world metres */
  x: number;
  z: number;
}

export interface RadioSnapshot {
  /** the dial's own 0..1 channel, as the hold-turn station left it */
  channel: number;
  freqMHz: number;
  /** clarity × strength of the best station in earshot */
  signal: number;
  best: StationSignal | null;
  locked: string | null;
  /** seconds of dwell accumulated toward a lock (0…lockDwellSec) */
  dwell: number;
  mix: RadioMix;
  /** a clip to start on THIS step, or null */
  play: { station: string; clip: number; night: boolean } | null;
  /** the soft chime, on the step a station locks */
  chime: boolean;
  /**
   * The two needles, as the piece's `shape` wants them: the tuning needle
   * follows the dial across its sweep, the meter needle follows the signal.
   * §V62 — the dial the player turns has to MOVE something, and this is the
   * something. `raftRadio.ts` writes them onto `radio-set` every frame.
   */
  dialAngle: number;
  meterAngle: number;
  /**
   * §T.156 — every station locked so far, in the order they were found. It
   * SURVIVES the set being switched off and the signal being lost; the HUD
   * compass marks these.
   */
  fixes: readonly RadioFix[];
}

export interface RadioStep {
  channel: number;
  /**
   * §T.156 — IS THE SET POWERED. A radio nobody has switched on makes no
   * sound, holds no lock and speaks no fragment: `on: false` is silence, not
   * a quiet hiss. Absent = on, so the pure tests that predate the switch (and
   * anything driving the runtime without a player) keep their meaning.
   */
  on?: boolean;
  x: number;
  z: number;
  headingRad: number;
  night: boolean;
  dt: number;
}

export interface RadioRuntime {
  step(input: RadioStep): RadioSnapshot;
  snapshot(): RadioSnapshot;
  /** the manifest, bound to the world (see `bindStations`) */
  setStations(stations: readonly RadioStation[]): void;
  stations(): readonly RadioStation[];
  /** the clip pool a snapshot's `play` names, resolved through the manifest */
  clipOf(station: string, index: number, night: boolean): string | null;
}

/** the needles' travel, radians, matching `buildRadioGeometry`'s rest poses */
const DIAL_SWEEP = 2.4;
const METER_SWEEP = 1.1;

function emptySnapshot(p: RadioParams): RadioSnapshot {
  return {
    channel: 0.5,
    freqMHz: dialFrequency(0.5, p),
    signal: 0,
    best: null,
    locked: null,
    dwell: 0,
    // the set boots OFF (§T.156): the empty snapshot is what `snapshot()`
    // answers before the first step, and it must not be a hiss
    mix: radioMix(0, false, p),
    play: null,
    chime: false,
    dialAngle: 0,
    meterAngle: -METER_SWEEP / 2,
    fixes: [],
  };
}

export function createRadioRuntime(
  defs: readonly RadioStationDef[] = RADIO_STATIONS,
  p: RadioParams = radioParams,
): RadioRuntime {
  let stations: readonly RadioStation[] = [];
  let lock: LockState = NO_LOCK;
  let frag: FragmentState = NO_FRAGMENT;
  let last = emptySnapshot(p);
  // §T.156: the fixes outlive the lock, the power switch and the station's
  // signal — they are what the player has LEARNED, not what he is hearing
  let fixes: RadioFix[] = [];
  const pool = new Map(defs.map((d) => [d.id, d]));

  return {
    setStations(next: readonly RadioStation[]): void {
      stations = next;
    },
    stations(): readonly RadioStation[] {
      return stations;
    },
    clipOf(station: string, index: number, night: boolean): string | null {
      const def = pool.get(station);
      if (def === undefined) return null;
      const list = night ? def.night : def.fragments;
      if (list.length === 0) return null;
      const clip = list[((index % list.length) + list.length) % list.length];
      return clip.src;
    },
    snapshot(): RadioSnapshot {
      return last;
    },
    step(input: RadioStep): RadioSnapshot {
      const channel = Number.isFinite(input.channel) ? Math.min(1, Math.max(0, input.channel)) : 0;
      const freqMHz = dialFrequency(channel, p);
      const on = input.on !== false;
      // OFF IS OFF (§T.156). The dial needle still follows the knob — it is a
      // string and a pulley, and it moves whether the valves are warm — but
      // nothing else survives: no signal, no dwell, no lock, no fragment. The
      // lock state is CLEARED rather than frozen, so switching the set back on
      // makes the player re-earn the dwell instead of inheriting a lock from
      // whatever the raft was pointing at minutes ago.
      if (!on) {
        lock = NO_LOCK;
        frag = NO_FRAGMENT;
        last = {
          ...emptySnapshot(p),
          channel,
          freqMHz,
          mix: radioMix(0, false, p),
          dialAngle: (channel - 0.5) * DIAL_SWEEP,
          fixes,
        };
        return last;
      }
      const reading = readTuner(stations, {
        freqMHz,
        x: input.x,
        z: input.z,
        headingRad: input.headingRad,
        night: input.night === true,
      }, p);
      const step = stepLock(lock, reading.best, input.dt, p);
      lock = step.state;
      // A NEW STATION IS A NEW FIX, once. `stations` is the bound manifest, so
      // the position recorded is the archipelago's own answer (§V71) rather
      // than a bearing snapshot that would rot as the raft sails.
      if (step.gained !== null && !fixes.some((f) => f.id === step.gained)) {
        const home = stations.find((st) => st.id === step.gained);
        if (home !== undefined) {
          fixes = [...fixes, { id: home.id, freqMHz: home.freqMHz, x: home.x, z: home.z }];
        }
      }
      // NIGHT POOL: after dusk a locked station plays its callback instead of
      // its fragments (design doc §05). §T.104 adds the "and its island has
      // been walked" half of the gate — there are no clues to have found yet,
      // and gating on a store that does not exist is how a control ends up
      // driving nothing (§V62).
      const night = input.night === true;
      const def = lock.locked === null ? undefined : pool.get(lock.locked);
      const poolSize = def === undefined ? 0 : (night ? def.night : def.fragments).length;
      const fragStep = stepFragments(frag, lock.locked, poolSize, input.dt, p);
      frag = fragStep.state;

      last = {
        channel,
        freqMHz,
        signal: reading.signal,
        best: reading.best,
        locked: lock.locked,
        dwell: lock.dwell,
        mix: radioMix(reading.signal, on, p),
        play: fragStep.play === null || lock.locked === null
          ? null
          : { station: lock.locked, clip: fragStep.play, night },
        chime: step.gained !== null,
        dialAngle: (channel - 0.5) * DIAL_SWEEP,
        meterAngle: (reading.signal - 0.5) * METER_SWEEP,
        fixes,
      };
      return last;
    },
  };
}

export { bindStations, LOCK_CHIME, RADIO_STATIONS, radioClips } from './stations';
export type { AudioRef, RadioStationDef } from './stations';
export { radioMix, stepFragments } from './radioMix';
export type { RadioMix } from './radioMix';
export * from './tuner';
