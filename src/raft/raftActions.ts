/**
 * RaftAction → RaftControls (§T.98, §V.84). The stations (`player/stations`)
 * publish a named channel through `player.applyAction(name, value)`; this is
 * the ONE table that turns those names into sailing controls. The same table
 * serves the dev-layer debug keys (`player/debugKeys`), which arrive as signed
 * deltas on a coarser channel set — so a key and a station can never disagree
 * about which field they drive (§V.62).
 *
 *   tiller        → oarAngle      −1..1
 *   guara-N       → guaraDepth[N] 0..1
 *   sheet-p/s     → sheet         0..1 (both sheets drive the one square sail)
 *   halyard       → sailUp        value > 0.5
 *   radio         → radio.tune    0..1 (stub store until §T.103)
 *   sleep         → sinks.skipToDawn()
 *   chart         → no-op (§T.104)
 *   push-off      → sinks.pushOff() when the beaching wiring provides it (§T.100)
 *   ladder, gangway-* → no-op here: interact.ts owns the perch and the step-off
 *
 * `raftControls` is the module-level object the sim tick hands to
 * `stepRaftShip`; the handlers mutate it in place, which is why it is not
 * recreated per tick.
 */
import { neutralRaftControls, type RaftControls } from '../sailing/raftKinematics';
import { RAFT_ACTIONS, type RaftAction } from '../player/stations';
import type { DebugChannel } from '../player/debugKeys';

export interface RaftActionSinks {
  /** the sleeping mat: advance the day clock to dawn */
  skipToDawn(): void;
  /** §T.100 push-off from a beach; absent until the beaching state is wired (raftBeaching.ts) */
  pushOff?(): void;
}

/** radio stub — the knob's value, read by nothing yet (§T.103 wires the tuner) */
export const radio = { tune: 0 };

/**
 * Boot controls, matching the stations' own starting channel values
 * (`interact.ts` DEFAULTS: guaras half down, sheet half in, halyard up) —
 * the first grab must not jump the raft to a different trim than the one
 * she was already sailing at.
 */
export function initialRaftControls(): RaftControls {
  const c = neutralRaftControls();
  c.sheet = 0.5;
  c.guaraDepth = [0.5, 0.5, 0.5, 0.5, 0.5];
  return c;
}

export const raftControls: RaftControls = initialRaftControls();

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

const GUARA: Partial<Record<RaftAction, number>> = {
  'guara-1': 0,
  'guara-2': 1,
  'guara-3': 2,
  'guara-4': 3,
  'guara-5': 4,
};

/**
 * Apply one station value. Returns false for a name this table does not
 * know — the §V.62 "silent no-op" shape a test can assert on. A hold channel
 * handed a non-number leaves the control where it was and still returns true:
 * the action IS handled, the value was bad.
 */
export function applyRaftAction(
  c: RaftControls,
  name: string,
  value: unknown,
  sinks: RaftActionSinks,
): boolean {
  const v = num(value);
  const g = GUARA[name as RaftAction];
  if (g !== undefined) {
    if (v !== null) c.guaraDepth[g] = clamp(v, 0, 1);
    return true;
  }
  switch (name as RaftAction) {
    case 'tiller':
      if (v !== null) c.oarAngle = clamp(v, -1, 1);
      return true;
    case 'sheet-p':
    case 'sheet-s':
      if (v !== null) c.sheet = clamp(v, 0, 1);
      return true;
    case 'halyard':
      if (v !== null) c.sailUp = v > 0.5;
      return true;
    case 'radio':
      if (v !== null) radio.tune = clamp(v, 0, 1);
      return true;
    case 'sleep':
      sinks.skipToDawn();
      return true;
    case 'push-off':
      sinks.pushOff?.();
      return true;
    case 'chart':
    case 'ladder':
    case 'gangway-bow':
    case 'gangway-port':
    case 'gangway-starboard':
    case 'gangway-stern':
      return true;
    default:
      return false;
  }
}

/** dev-layer hotkey deltas (§V.84: never required for play) */
export function applyDebugChannel(
  c: RaftControls,
  channel: DebugChannel,
  delta: number,
  sinks: RaftActionSinks,
): void {
  const d = Number.isFinite(delta) ? delta : 0;
  switch (channel) {
    case 'oar':
      c.oarAngle = clamp(c.oarAngle + d, -1, 1);
      return;
    case 'guara-fwd':
      for (const i of [0, 1]) c.guaraDepth[i] = clamp(c.guaraDepth[i] + d, 0, 1);
      return;
    case 'guara-aft':
      for (const i of [3, 4]) c.guaraDepth[i] = clamp(c.guaraDepth[i] + d, 0, 1);
      return;
    case 'sheet':
      c.sheet = clamp(c.sheet + d, 0, 1);
      return;
    case 'tune':
      radio.tune = clamp(radio.tune + d, 0, 1);
      return;
    case 'dawn':
      sinks.skipToDawn();
      return;
  }
}

export interface ActionHost {
  onAction(name: string, handler: (value: unknown) => void): () => void;
}

/** register a handler for EVERY RaftAction on the player; returns the detach */
export function bindRaftActions(host: ActionHost, c: RaftControls, sinks: RaftActionSinks): () => void {
  const offs = RAFT_ACTIONS.map((a) => host.onAction(a, (v) => applyRaftAction(c, a, v, sinks)));
  return () => {
    for (const off of offs) off();
  };
}
