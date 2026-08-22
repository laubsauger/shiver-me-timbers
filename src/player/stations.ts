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
}

const guaraLabel = (where: string): StationLabel => ({ name: `Guara — ${where}`, verb: 'raise / lower' });

export const RAFT_LABELS: Record<RaftAction, StationLabel> = {
  tiller: { name: 'Tiller', verb: 'turn' },
  // the five boards in the order buildLogs sockets them (raftPartsLayout.guaraStations)
  'guara-1': guaraLabel('bow port'),
  'guara-2': guaraLabel('bow starboard'),
  'guara-3': guaraLabel('midships'),
  'guara-4': guaraLabel('stern port'),
  'guara-5': guaraLabel('stern starboard'),
  'sheet-p': { name: 'Port sheet', verb: 'haul' },
  'sheet-s': { name: 'Starboard sheet', verb: 'haul' },
  halyard: { name: 'Halyard', verb: 'hoist / lower' },
  radio: { name: 'Radio', verb: 'tune' },
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
