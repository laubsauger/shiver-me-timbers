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
import { bindStations, createRadioRuntime, type RadioRuntime, type RadioSnapshot } from '../radio';
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
      const s = runtime.step({
        channel: radio.tune,
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
