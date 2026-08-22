/**
 * Raft stations (§T.95, §V84): every play action has a diegetic place on the
 * raft — a socket in the blueprint (§T.89) — and this table is the ONLY map
 * from action to socket. Pure data: `interact.ts` reads it, the §V84 test
 * resolves every socket on the real assembly so a renamed socket fails loud.
 *
 * Kinds:
 *  - hold-turn   hands on a lever/knob; mouse-x drives the channel while held
 *  - hold-slide  hands on a line/board; mouse-y drives the channel while held
 *  - toggle      one press, one event (sleep request)
 *  - press       one press, a look (chart)
 *  - climb       ladder: up to `station-lookout`, second use comes back down
 *  - step-off    gangway: leave the raft onto ground, if there is any
 *  - press       push-off (§T.100): shove a BEACHED raft off the sand. Done
 *                from the SAND (`frame: 'world'`) — the crew push from the
 *                beach and clamber aboard — so it shares the bow gangway's
 *                socket without contesting it (the gangway is ship-frame
 *                only). The raft wiring gates it on the beaching state
 *                (`Interact`'s `enabled` filter hides it otherwise).
 *
 * `dir` is the sign that makes the natural gesture positive: push a guara
 * DOWN (mouse down) to lower it, haul a halyard/sheet UP/in (mouse up) to
 * hoist/sheet home, tiller to the RIGHT for a starboard turn.
 * `out` is the ship-local outboard direction for a step-off (+x starboard,
 * +z bow).
 */

export type RaftAction =
  | 'tiller'
  | 'guara-1'
  | 'guara-2'
  | 'guara-3'
  | 'guara-4'
  | 'guara-5'
  | 'sheet-p'
  | 'sheet-s'
  | 'halyard'
  | 'radio'
  | 'chart'
  | 'sleep'
  | 'ladder'
  | 'gangway-bow'
  | 'gangway-port'
  | 'gangway-starboard'
  | 'gangway-stern'
  | 'push-off';

export type StationKind = 'hold-turn' | 'hold-slide' | 'toggle' | 'press' | 'climb' | 'step-off';
export type StationAxis = 'mouse-x' | 'mouse-y' | 'forward';

export interface RaftStation {
  socket: string;
  kind: StationKind;
  axis?: StationAxis;
  /** channel range for hold-* stations */
  min?: number;
  max?: number;
  /** +1 if the natural gesture (see header) increases the channel */
  dir?: 1 | -1;
  /** step-off only: ship-local outboard direction, unit, horizontal */
  out?: readonly [number, number];
  /** the player frame this station is usable from; absent = aboard ('ship'); step-off is always 'ship' */
  frame?: 'ship' | 'world' | 'swim';
}

const guara = (n: 1 | 2 | 3 | 4 | 5): RaftStation => ({
  socket: `station-guara-${n}`,
  kind: 'hold-slide',
  axis: 'mouse-y',
  min: 0,
  max: 1,
  dir: -1, // mouse DOWN (pitchDelta < 0) pushes the board deeper
});

export const RAFT_STATIONS: Record<RaftAction, RaftStation> = {
  tiller: { socket: 'station-tiller', kind: 'hold-turn', axis: 'mouse-x', min: -1, max: 1, dir: 1 },
  'guara-1': guara(1),
  'guara-2': guara(2),
  'guara-3': guara(3),
  'guara-4': guara(4),
  'guara-5': guara(5),
  'sheet-p': { socket: 'station-sheet-p', kind: 'hold-slide', axis: 'mouse-y', min: 0, max: 1, dir: 1 },
  'sheet-s': { socket: 'station-sheet-s', kind: 'hold-slide', axis: 'mouse-y', min: 0, max: 1, dir: 1 },
  halyard: { socket: 'station-halyard', kind: 'hold-slide', axis: 'mouse-y', min: 0, max: 1, dir: 1 },
  radio: { socket: 'station-radio', kind: 'hold-turn', axis: 'mouse-x', min: 0, max: 1, dir: 1 },
  chart: { socket: 'station-chart', kind: 'press' },
  sleep: { socket: 'station-mat', kind: 'toggle' },
  ladder: { socket: 'station-ladder', kind: 'climb' },
  'gangway-bow': { socket: 'station-gangway-bow', kind: 'step-off', out: [0, 1] },
  'gangway-port': { socket: 'station-gangway-port', kind: 'step-off', out: [-1, 0] },
  'gangway-starboard': { socket: 'station-gangway-starboard', kind: 'step-off', out: [1, 0] },
  'gangway-stern': { socket: 'station-gangway-stern', kind: 'step-off', out: [0, -1] },
  'push-off': { socket: 'station-gangway-bow', kind: 'press', frame: 'world' },
};

export const RAFT_ACTIONS = Object.keys(RAFT_STATIONS) as RaftAction[];

/** the lookout the ladder climbs to; not an action, a destination */
export const LOOKOUT_SOCKET = 'station-lookout';

export function isHold(kind: StationKind): boolean {
  return kind === 'hold-turn' || kind === 'hold-slide';
}

/**
 * WHAT THE PLAYER IS TOLD A STATION IS (§T.116). Beside the table above on
 * purpose: a second module naming the same eighteen actions would be a second
 * source of truth (§V95), and `Record<RaftAction, …>` makes an unlabelled new
 * action a COMPILE error here rather than a station that walks up silent.
 *
 * COPY RULE, the same one the HUD and the quick-controls card follow: name
 * the THING the player is looking at, in the words the raft itself carries —
 * 'Guara', not 'centreboard'; 'Halyard', not 'raise sail'. Two actions have
 * no object to name ('Sleeping mat' is the object of `sleep`; pushing her off
 * the sand and stepping ashore are gestures), and those read as the gesture.
 *
 * `verb` is what the MOUSE does once the station is held, and it exists only
 * for the hold-* kinds — the prompt swaps the name and the [E] for it while
 * the hands are busy, because at that moment the player already knows what
 * they grabbed and does not know which way to pull.
 */
export interface StationLabel {
  /** short human name, shown beside the key */
  name: string;
  /** hold-* only: what the drag does while it is held */
  verb?: string;
  /**
   * §T.136a — WHAT MORE OF THE CHANNEL IS CALLED, and what less is called.
   * USER, at a guara: "it says raise or lower, but then I don't know how to
   * actually raise or lower this. What do we do? Do we click?" — the verb
   * named the effect and never the gesture. These two words are the effect;
   * `dragHint` below pairs them with the MOUSE DIRECTION, which it derives
   * from the station's own `axis`/`dir` rather than from a third authored
   * string that is free to point the wrong way (§V62).
   *
   * Required for every hold-* station; `tests/raftPrompt.test.ts` is
   * exhaustive over the union, so a new lever cannot ship without them.
   */
  more?: string;
  less?: string;
}

const guaraLabel = (where: string): StationLabel => ({
  name: `Guara — ${where}`,
  verb: 'raise / lower',
  // the channel IS depth: 1 is the board driven down through the chink
  more: 'lower',
  less: 'raise',
});

export const RAFT_LABELS: Record<RaftAction, StationLabel> = {
  tiller: { name: 'Tiller', verb: 'turn', more: 'starboard', less: 'port' },
  // the five boards in the order buildLogs sockets them (raftPartsLayout.guaraStations)
  'guara-1': guaraLabel('bow port'),
  'guara-2': guaraLabel('bow starboard'),
  'guara-3': guaraLabel('midships'),
  'guara-4': guaraLabel('stern port'),
  'guara-5': guaraLabel('stern starboard'),
  'sheet-p': { name: 'Port sheet', verb: 'haul', more: 'haul in', less: 'ease' },
  'sheet-s': { name: 'Starboard sheet', verb: 'haul', more: 'haul in', less: 'ease' },
  halyard: { name: 'Halyard', verb: 'hoist / lower', more: 'hoist', less: 'lower' },
  radio: { name: 'Radio', verb: 'tune', more: 'tune up', less: 'tune down' },
  chart: { name: 'Chart' },
  sleep: { name: 'Sleeping mat' },
  ladder: { name: 'Ladder' },
  // one wording for all four edges: the player is standing on the one they
  // are being offered, so naming the side is noise they can already see
  'gangway-bow': { name: 'Step ashore' },
  'gangway-port': { name: 'Step ashore' },
  'gangway-starboard': { name: 'Step ashore' },
  'gangway-stern': { name: 'Step ashore' },
  'push-off': { name: 'Push her off' },
};

/**
 * §T.136a — THE GESTURE, DERIVED FROM THE STATION ITSELF.
 *
 * Which way the mouse goes is not authored anywhere: it is read off the two
 * fields `interact.step` reads to move the channel. `axis` picks the pair of
 * words, and `dir` picks which of them is MORE — so the hint and the code that
 * answers the mouse are the same statement twice, and a station whose `dir`
 * flips gets a hint that flips with it. Authoring a third string here is
 * exactly the §V62 shape: a label that is free to disagree with the control.
 *
 * `interact.step` reads `-yawDelta` for mouse-x and `+pitchDelta` for mouse-y,
 * and `pointerLock.lookFromMouse` makes mouse-right a NEGATIVE yaw and
 * mouse-up a POSITIVE pitch (mouse down is negative). So on both axes a
 * positive `dir` means right / up increases the channel.
 */
const AXIS_WORDS: Record<StationAxis, readonly [string, string]> = {
  'mouse-x': ['right', 'left'],
  'mouse-y': ['up', 'down'],
  forward: ['forward', 'back'],
};

export interface DragHint {
  /** e.g. 'mouse right' — the direction that increases the channel */
  moreWay: string;
  moreDoes: string;
  lessWay: string;
  lessDoes: string;
  /** one line for the plaque: 'mouse up: hoist · down: lower' */
  text: string;
}

/** the gesture for a hold station, or null for the kinds that have none */
export function dragHint(action: RaftAction): DragHint | null {
  const st = RAFT_STATIONS[action];
  const label = RAFT_LABELS[action];
  if (st === undefined || label === undefined || !isHold(st.kind)) return null;
  if (label.more === undefined || label.less === undefined) return null;
  const [pos, neg] = AXIS_WORDS[st.axis ?? 'mouse-x'];
  const up = (st.dir ?? 1) > 0;
  const moreWay = `mouse ${up ? pos : neg}`;
  const lessWay = up ? neg : pos;
  return {
    moreWay,
    moreDoes: label.more,
    lessWay,
    lessDoes: label.less,
    text: `${moreWay}: ${label.more} · ${lessWay}: ${label.less}`,
  };
}

/**
 * §T.135 — THE ONE PROMPT THAT IS NOT A STATION. A swimmer alongside is told
 * how to get back aboard, and the thing he is being offered is a metre of
 * foot-rail, not a socket: `raftBoardingPoints` emits nineteen of them along
 * the rails and the stern and the nearest one wins, so it cannot live in
 * `RAFT_STATIONS` (and adding it there would break §V84's "∀ RaftAction ∃ a
 * socket that resolves on the assembly"). It lives HERE beside the labels
 * because the copy rule and the label table are what it shares — the prompt
 * module renders it through exactly the same plaque (§V95).
 */
export const CLIMB_ABOARD: StationLabel = { name: 'Climb aboard' };
