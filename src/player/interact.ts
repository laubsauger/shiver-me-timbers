/**
 * Station interaction (§T.95, §V84): PLAY = WALK + TOUCH. The walker looks at
 * a station within reach, presses E, and while holding it the mouse works the
 * channel — tiller, guara, sheet, halyard, radio knob. Every channel change
 * leaves through `host.applyAction(action, value)`, so the raft wiring maps
 * actions onto `RaftControls` and nothing here knows about sailing.
 *
 * Stations are resolved LIVE through `socketWorld` (§V71): the socket rides
 * the assembly, a guara that is being raised still has its station on the
 * log it pierces. Distances are measured in the player's CURRENT frame —
 * ship-local while aboard — so the deck may heave under both hand and lever.
 *
 * Pure logic, no three.js, no DOM: tests drive it with a fake host and the
 * real raft blueprint's sockets.
 */
import { playerParams, type PlayerParams } from '../params/player';
import type { LookDelta } from './pointerLock';
import { neutralPlayerInput, wrapAngle, type PlayerInput, type PlayerState, type Vec3 } from './playerStep';
import {
  isHold,
  LOOKOUT_SOCKET,
  RAFT_ACTIONS,
  RAFT_STATIONS,
  type RaftAction,
  type RaftStation,
} from './stations';

export type SocketResolver = (id: string) => Vec3 | null;

/** the slice of the player the stations need — `createPlayer` implements it */
export interface InteractHost {
  readonly state: PlayerState;
  setState(next: PlayerState): void;
  applyAction(name: string, value?: unknown): boolean;
  /** live ship transform; identity when absent */
  shipToWorld?(p: Vec3): Vec3;
  worldToShip?(p: Vec3): Vec3;
}

export interface InteractOptions {
  /** WORLD position of a socket, null if it does not exist */
  socketWorld: SocketResolver;
  /** WORLD ground height at (x,z), null over water — step-off needs it */
  groundAt?: (x: number, z: number) => number | null;
  /** starting channel values; defaults below */
  initial?: Partial<Record<RaftAction, number>>;
}

export interface Interact {
  /** nearest station within reach and inside the look cone, or null */
  focus(): RaftAction | null;
  /** E pressed: take hold of the focus, or fire its one-shot */
  begin(): void;
  /** E pressed again / let go */
  end(): void;
  held(): RaftAction | null;
  /** current channel value of a hold-* station */
  value(action: RaftAction): number;
  /** per tick, with this tick's look delta (radians, the walker's own units) */
  step(dt: number, look: LookDelta): void;
  /** the walker's input with the hands busy: no walking while holding */
  shapeInput(input: PlayerInput): PlayerInput;
  /** after the locomotion step: keep the head within the hold's yaw limit */
  constrain(state: PlayerState): PlayerState;
  /** frame-local perch while aloft on the lookout, else null */
  perch(): Vec3 | null;
  /** channel delta applied this tick (for the hands' wrist turn) */
  lastDelta(): number;
}

const DEFAULTS: Record<string, number> = {
  tiller: 0,
  'guara-1': 0.5,
  'guara-2': 0.5,
  'guara-3': 0.5,
  'guara-4': 0.5,
  'guara-5': 0.5,
  'sheet-p': 0.5,
  'sheet-s': 0.5,
  halyard: 1,
  radio: 0.5,
};

const num = (v: number, f = 0): number => (Number.isFinite(v) ? v : f);
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const identity = (p: Vec3): Vec3 => [p[0], p[1], p[2]];

/** look direction in the frame of `state`: yaw 0 faces +z, +yaw turns toward +x */
export function lookDir(yaw: number, pitch: number): Vec3 {
  const c = Math.cos(pitch);
  return [Math.sin(yaw) * c, Math.sin(pitch), Math.cos(yaw) * c];
}

function eyeOf(s: PlayerState, p: PlayerParams): Vec3 {
  const h = (s.crouch ? p.crouchHeight : p.standHeight) - p.eyeDrop;
  return [s.pos[0], s.pos[1] + h, s.pos[2]];
}

export function createInteract(host: InteractHost, o: InteractOptions, p: PlayerParams = playerParams): Interact {
  const values = new Map<RaftAction, number>();
  for (const a of RAFT_ACTIONS) values.set(a, o.initial?.[a] ?? DEFAULTS[a] ?? 0);

  let held: RaftAction | null = null;
  let facing = 0;
  let aloft: Vec3 | null = null;
  let ladderReturn: Vec3 | null = null;
  let delta = 0;

  /** socket in the player's current frame, or null */
  const socketLocal = (id: string): Vec3 | null => {
    const w = o.socketWorld(id);
    if (w === null || !w.every(Number.isFinite)) return null;
    if (host.state.frame !== 'ship') return w;
    return (host.worldToShip ?? identity)(w);
  };

  const shipYaw = (): number => {
    const tw = host.shipToWorld ?? identity;
    const a = tw([0, 0, 0]);
    const b = tw([0, 0, 1]);
    return Math.atan2(b[0] - a[0], b[2] - a[2]);
  };

  const focus = (): RaftAction | null => {
    const s = host.state;
    if (aloft !== null) return 'ladder'; // the only thing to do up there is come down
    const eye = eyeOf(s, p);
    const dir = lookDir(num(s.yaw), num(s.pitch));
    const cosCone = Math.cos((p.focusConeDeg * Math.PI) / 180);
    let best: RaftAction | null = null;
    let bestD = Infinity;
    for (const a of RAFT_ACTIONS) {
      const st = RAFT_STATIONS[a];
      if (st.kind === 'step-off' && s.frame !== 'ship') continue;
      const q = socketLocal(st.socket);
      if (q === null) continue;
      const dx = q[0] - eye[0];
      const dy = q[1] - eye[1];
      const dz = q[2] - eye[2];
      const d = Math.hypot(dx, dy, dz);
      if (d > p.reach || d < 1e-6) continue;
      const cos = (dx * dir[0] + dy * dir[1] + dz * dir[2]) / d;
      if (cos < cosCone) continue;
      if (d < bestD) {
        bestD = d;
        best = a;
      }
    }
    return best;
  };

  const publish = (a: RaftAction, v: number): void => {
    values.set(a, v);
    host.applyAction(a, v);
  };

  const climb = (): void => {
    const s = host.state;
    if (aloft === null) {
      const top = socketLocal(LOOKOUT_SOCKET);
      if (top === null) return;
      ladderReturn = [s.pos[0], s.pos[1], s.pos[2]];
      aloft = [top[0], top[1], top[2]];
      host.setState({ ...s, pos: [top[0], top[1], top[2]], vel: [0, 0, 0], grounded: true, crouch: false });
      host.applyAction('ladder', 1);
    } else {
      const back = ladderReturn ?? socketLocal(RAFT_STATIONS.ladder.socket) ?? s.pos;
      aloft = null;
      ladderReturn = null;
      host.setState({ ...s, pos: [back[0], back[1], back[2]], vel: [0, 0, 0], grounded: true });
      host.applyAction('ladder', 0);
    }
  };

  const stepOff = (a: RaftAction, st: RaftStation): void => {
    const s = host.state;
    if (s.frame !== 'ship' || o.groundAt === undefined) return;
    const w = o.socketWorld(st.socket);
    if (w === null) return;
    const tw = host.shipToWorld ?? identity;
    const origin = tw([0, 0, 0]);
    const out = tw([st.out?.[0] ?? 0, 0, st.out?.[1] ?? 0]);
    let ox = out[0] - origin[0];
    let oz = out[2] - origin[2];
    const l = Math.hypot(ox, oz) || 1;
    ox /= l;
    oz /= l;
    const x = w[0] + ox * p.stepOffDistance;
    const z = w[2] + oz * p.stepOffDistance;
    const g = o.groundAt(x, z);
    if (g === null || !Number.isFinite(g)) return;
    host.setState({
      frame: 'world',
      pos: [x, g, z],
      yaw: wrapAngle(s.yaw + shipYaw()),
      pitch: s.pitch,
      vel: [0, 0, 0],
      crouch: false,
      grounded: true,
    });
    host.applyAction(a, 1);
  };

  const begin = (): void => {
    if (held !== null) {
      end();
      return;
    }
    const a = focus();
    if (a === null) return;
    const st = RAFT_STATIONS[a];
    switch (st.kind) {
      case 'hold-turn':
      case 'hold-slide': {
        held = a;
        const q = socketLocal(st.socket);
        const s = host.state;
        facing = q === null ? s.yaw : Math.atan2(q[0] - s.pos[0], q[2] - s.pos[2]);
        host.applyAction(a, values.get(a));
        break;
      }
      case 'toggle':
      case 'press':
        host.applyAction(a, true);
        break;
      case 'climb':
        climb();
        break;
      case 'step-off':
        stepOff(a, st);
        break;
    }
  };

  const end = (): void => {
    held = null;
    delta = 0;
  };

  return {
    focus,
    begin,
    end,
    held: () => held,
    value: (a) => values.get(a) ?? 0,
    step(_dt, look) {
      delta = 0;
      if (held === null) return;
      const st = RAFT_STATIONS[held];
      if (!isHold(st.kind)) return;
      const dir = st.dir ?? 1;
      // mouse right is yaw NEGATIVE, mouse down is pitch negative (pointerLock.ts)
      const raw = st.axis === 'mouse-x'
        ? -num(look.yawDelta) * p.turnSensitivity
        : num(look.pitchDelta) * p.slideSensitivity;
      const d = raw * dir;
      if (d === 0) return;
      const prev = values.get(held) ?? 0;
      const next = clamp(prev + d, st.min ?? 0, st.max ?? 1);
      delta = next - prev;
      if (delta !== 0) publish(held, next);
    },
    shapeInput(input) {
      if (held === null && aloft === null) return input;
      const out = neutralPlayerInput();
      out.yawDelta = input.yawDelta;
      out.pitchDelta = input.pitchDelta;
      return out;
    },
    constrain(state) {
      if (held === null) return state;
      const lim = (p.holdYawLimitDeg * Math.PI) / 180;
      const off = wrapAngle(num(state.yaw) - facing);
      if (Math.abs(off) <= lim) return state;
      return { ...state, yaw: wrapAngle(facing + clamp(off, -lim, lim)) };
    },
    perch: () => aloft,
    lastDelta: () => delta,
  };
}
