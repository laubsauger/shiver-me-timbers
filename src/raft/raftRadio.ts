/**
 * §T.150 / §T.103 — THE DIAL, WIRED. This is the only file that knows both
 * what a raft is and what a radio is; `src/radio/` is pure and knows neither.
 *
 * PER TICK it does four things, in this order, and the order is the point:
 *
 *  1. reads `radio.tune` — the SAME store `applyRaftAction` writes from the
 *     hold-turn station and the debug `tune` key write to, so a keyboard and a
 *     hand on the knob cannot disagree (§V62);
 *  2. steps the pure tuner with the raft's live position and heading;
 *  3. TURNS THE NEEDLES — `radio-needle` and `radio-meter-needle` are real
 *     pieces, so the control the player is holding moves something he can see
 *     (§T.136c, and §B100 twice over: the oar and the guaras were both wired
 *     to nothing and nobody noticed for weeks);
 *  4. hands the snapshot to the audio adapter, which is attached to the ONE
 *     audio graph through the facade's `attach` seam (§V95).
 *
 * §V71 — THE STATIONS ARE RESOLVED AGAINST THE LIVE ARCHIPELAGO, never against
 * a table of coordinates that happened to match one seed. The manifest names
 * an island by its place in the Sierra's visiting order and this asks
 * `sierra.sites` where that island actually is. §T.104 moves the aerial from
 * the island's centre to its summit POI, which is one line here and no change
 * anywhere else — but it costs a heightmap bake, so it waits until the
 * archipelago's own baked POIs can be read instead of re-baking (§V37).
 */
import type { AudioSystem } from '../audio';
import { createRadioAudio } from '../radio/radioAudio';
import { bindStations, createRadioRuntime, RADIO_STATIONS, type RadioRuntime, type RadioSnapshot } from '../radio';
import type { RadioAudioInput } from '../radio/radioAudio';
import type { ShipAssembly } from '../ship/shipAssembly';
import type { SierraWorld } from '../island/sierraSites';
import type { ShipState } from '../state/simState';
import { radio } from './raftActions';
import { yawOf } from './raftShip';

/**
 * Dusk to dawn, in the day clock's hours. Shortwave propagates further at
 * night (§V86's `nightRangeMult`), and the design doc hangs the callbacks off
 * the same boundary — "after dusk, locked stations … open their night pool".
 */
const NIGHT_FROM = 19.5;
const NIGHT_TO = 6.5;

export function isRadioNight(hour: number): boolean {
  if (!Number.isFinite(hour)) return false;
  const h = ((hour % 24) + 24) % 24;
  return h >= NIGHT_FROM || h < NIGHT_TO;
}

export interface RaftRadioDeps {
  audio: AudioSystem;
  assembly: ShipAssembly;
  sierra: SierraWorld;
  /**
   * §T.156 — IS A HAND ON THE KNOB. Read at step time, so it is the walker's
   * live grip and not a boot-time snapshot; absent = the set is always live,
   * which is what the preview harness and the pure tests want.
   */
  power?: () => boolean;
}

/**
 * §T.156 — A FIX, AS A BEARING TO STEER. The world direction from where the
 * raft IS NOW to a station's aerial, in degrees clockwise from north — the
 * HUD compass's own units. Recomputed per frame from the fix's stored (x, z),
 * never from a bearing saved at lock time: the raft is what moves, so a saved
 * bearing would point at where the island was an hour ago (§V71).
 */
export interface RadioBearing {
  id: string;
  /** the manifest's own name for the station */
  label: string;
  bearingDeg: number;
}

/**
 * Pure: fixes + a position → what the compass draws. Exported and free of
 * three.js and the DOM so the "does the marker point at the island" test needs
 * neither (§V80).
 */
export function radioBearings(
  snapshot: RadioSnapshot,
  x: number,
  z: number,
  defs: readonly { id: string; title: string }[] = RADIO_STATIONS,
): RadioBearing[] {
  const px = Number.isFinite(x) ? x : 0;
  const pz = Number.isFinite(z) ? z : 0;
  const out: RadioBearing[] = [];
  for (const f of snapshot.fixes) {
    const deg = (Math.atan2(f.x - px, f.z - pz) * 180) / Math.PI;
    out.push({
      id: f.id,
      label: defs.find((d) => d.id === f.id)?.title ?? f.id,
      bearingDeg: ((deg % 360) + 360) % 360,
    });
  }
  return out;
}

/**
 * §T.156 — WHAT THE SET IS DOING, in one line for its own plaque.
 *
 * Lives here rather than in `main-raft` (§T.98 keeps the entry to boot) and
 * beside the runtime rather than in the prompt (§V95 — the tuner owns the
 * arithmetic; a plaque must not learn what a megahertz is). Off says so: a
 * silent radio and a broken radio are the same thing from the outside, which
 * is the half of USER's complaint that a mute button alone would have created.
 */
export function radioStatusLine(
  s: RadioSnapshot,
  on: boolean,
  defs: readonly { id: string; title: string }[] = RADIO_STATIONS,
): string {
  if (!on) {
    return s.fixes.length === 0
      ? 'off — take the knob to listen'
      : `off — ${s.fixes.length} bearing${s.fixes.length === 1 ? '' : 's'} on the compass`;
  }
  const band = `${s.freqMHz.toFixed(2)} MHz`;
  const strength = `signal ${Math.round(s.signal * 100)}%`;
  if (s.locked !== null) {
    return `${band} · ${strength} · LOCK — ${defs.find((d) => d.id === s.locked)?.title ?? s.locked}`;
  }
  // the dwell is §V86's two seconds; saying it is what turns "nearly there"
  // into a thing worth holding still for
  return s.dwell > 0 ? `${band} · ${strength} · holding…` : `${band} · ${strength}`;
}

export interface RaftRadio {
  step(dt: number, raft: ShipState, hour: number): RadioSnapshot;
  snapshot(): RadioSnapshot;
  runtime: RadioRuntime;
  dispose(): void;
}

export function createRaftRadio(d: RaftRadioDeps): RaftRadio {
  const runtime = createRadioRuntime();
  runtime.setStations(bindStations((orderIndex) => {
    const site = d.sierra.sites[d.sierra.order[orderIndex] ?? -1];
    return site === undefined ? null : { x: site.position[0], z: site.position[1] };
  }));

  // the speaker, not the kneel spot: `emitter-radio` is the grille on the set
  // itself, 0.9 m up and inside the cabin (§T.123 — `station-radio` is a place
  // on the FLOOR). Resolved live every frame, because the raft is moving.
  let feed: RadioAudioInput | null = null;
  const detach = d.audio.attach((ctx, buses) => {
    const adapter = createRadioAudio(ctx, buses);
    return {
      update: (dt) => adapter.update(feed, dt),
      dispose: () => adapter.dispose(),
    };
  });

  // the two needle nodes, looked up once: `ShipAssembly` exposes setters for
  // the parts the SHIP owns (rudder, guaras, yards) and these belong to the
  // radio, so the runtime that owns them addresses them directly rather than
  // growing the shared assembly a method only one mode will ever call
  const nodeOf = (id: string): { rotation: { z: number } } | null =>
    (d.assembly.group.getObjectByName(id) as { rotation: { z: number } } | undefined) ?? null;
  const needle = nodeOf('radio-needle');
  const meter = nodeOf('radio-meter-needle');
  const emitterAt = (): [number, number, number] | null => {
    try {
      return d.assembly.socketWorldPosition('emitter-radio') as [number, number, number];
    } catch {
      return null;
    }
  };

  return {
    runtime,
    snapshot: () => runtime.snapshot(),
    step(dt: number, raft: ShipState, hour: number): RadioSnapshot {
      if (d.power !== undefined) radio.on = d.power();
      const s = runtime.step({
        channel: radio.tune,
        // §T.156 — the switch: alive while a hand is on the knob, dead the
        // moment it is let go. USER: "it should only make sound when we
        // interact with it." The store is written HERE, so `radio.on` is the
        // one answer everything downstream reads (§V62).
        on: radio.on,
        x: raft.position[0],
        z: raft.position[2],
        headingRad: yawOf(raft.quaternion),
        night: isRadioNight(hour),
        dt,
      });
      if (needle !== null) needle.rotation.z = s.dialAngle;
      if (meter !== null) meter.rotation.z = s.meterAngle;
      const world = emitterAt();
      feed = world === null ? null : { snapshot: s, world };
      return s;
    },
    dispose(): void {
      feed = null;
      detach();
    },
  };
}
