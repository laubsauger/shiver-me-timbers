/**
 * First-person player (§T.94): glue between the pure core, the deck field,
 * the keyboard/pointer-lock collectors and the camera.
 *
 * Locomotion integrates in SHIP-LOCAL space (§V73/§V85); the live ship pose
 * is applied here, once per query, to produce the WORLD camera pose — so the
 * walker rides the deck through every heave and roll with zero sliding. The
 * state lives in `SimState.player` (plain data, §V2/§V3) and is REPLACED each
 * tick, never mutated in place.
 */
import { Quaternion, Vector3 } from 'three';
import type { Quat, SimState, Vec3 as SimVec3 } from '../state/simState';
import type { DeckHeightfield } from '../ship/deckHeightfield';
import { playerParams } from '../params/player';
import { createDeckSurface } from './deckSurface';
import { createTerrainSurface } from './ashore';
import { transitionFrame, type FrameContext } from './frames';
import { LookAccumulator, attachPointerLock, type LockElement } from './pointerLock';
import { PlayerKeys, attachPlayerKeys } from './playerInput';
import { createInteract, type Interact, type SocketResolver } from './interact';
import type { PieceResolver } from './stations';
import type { RaftAction } from './stations';
import { attachDebugKeys, type DebugChannel } from './debugKeys';
import type { Hands } from './hands';
import {
  boardingCandidate,
  createPlayerState,
  eyeHeight,
  stepPlayer,
  type PlayerState,
  type Vec3,
  type WalkSurface,
} from './playerStep';

export type { PlayerFrame, PlayerInput, PlayerState, WalkSurface } from './playerStep';
export type { FrameContext } from './frames';
export type { Interact, SocketResolver } from './interact';
export type { RaftAction } from './stations';
export type { DebugChannel } from './debugKeys';

export interface ShipPose {
  position: SimVec3;
  quaternion: Quat;
}

export interface PlayerOptions {
  sim: SimState;
  /** the live pose the deck is drawn at — `() => sim.ships[0]` works */
  shipPose: () => ShipPose;
  /**
   * The pose the HULL IS DRAWN AT this frame, if it differs from the sim's.
   *
   * §T.139/§B103. The sim steps at a fixed 60 Hz and the hull is rendered
   * between two sim states by the loop's `alpha` (`raftFrame.renderVessel`
   * lerps/slerps into the assembly group). The camera was converting the
   * walker's ship-local eye through the RAW end-of-tick pose, so every frame
   * the lens and the deck disagreed by the interpolation residual — the world
   * shook against the camera at the beat between the sim rate and the display
   * rate. The hands never shook, because they are children of the camera and
   * therefore the one thing that cannot show the error.
   *
   * Only `cameraPose()` uses this. Stepping, boarding and the frame
   * transitions keep the sim pose: they are sim-time facts and interpolating
   * them would put the walker somewhere the simulation never was.
   *
   * Defaults to `shipPose`, so a harness that draws the hull uninterpolated
   * (`preview.ts`) is unaffected.
   */
  renderPose?: () => ShipPose;
  deckField: DeckHeightfield;
  /** WORLD sea height; absent = flat sea at y = 0 */
  waterAt?: (x: number, z: number) => number;
  /** ship-local foot-rail points a swimmer can climb back at */
  boardingPoints?: readonly Vec3[];
  /** ship-local cabin roof etc.; absent = open sky */
  ceilingAt?: (x: number, z: number) => number | null;
  /** where to stand at boot, ship-local feet; yaw 0 faces the bow */
  spawn?: Vec3;
  /** keyboard source (default window) and the canvas for pointer lock */
  keyTarget?: EventTarget;
  canvas?: LockElement;
  /** called on the tick T was pressed — main wiring flips the camera mode */
  onToggle?: () => void;
  /**
   * §T.95 stations. `socketWorld` resolves a blueprint socket to its LIVE
   * world position (`assembly.socketWorldPosition`, §V71); absent = no
   * stations. `groundAt` is world ground height (null over water) for the
   * gangways AND the terrain the walker stands on ashore (§T.100).
   * `obstacleAt` marks solid props ashore. `actionEnabled` gates stations
   * (push-off only while beached). `hands` is the placeholder mitt rig.
   */
  socketWorld?: SocketResolver;
  /**
   * §T.157 — `ShipAssembly.pieceNearestPoint`: the live point on the PIECE a
   * station operates, nearest a given world point. Absent = the look cone aims
   * at the stance, as it did before a station could name its object.
   */
  pieceNear?: PieceResolver;
  groundAt?: (x: number, z: number) => number | null;
  obstacleAt?: (x: number, z: number) => boolean;
  actionEnabled?: (action: RaftAction) => boolean;
  hands?: Hands;
  /** raft debug hotkeys (§V84): heard only while this is true AND the walker is inactive */
  devLayerOn?: () => boolean;
  onDebug?: (channel: DebugChannel, delta: number) => void;
}

export interface CameraPose {
  position: Vector3;
  quaternion: Quaternion;
}

export type ActionHandler = (value: unknown) => void;

export interface Player {
  readonly state: PlayerState;
  /** advance one fixed sim tick; writes `sim.player` */
  step(dt: number): void;
  /** WORLD eye pose for the camera, through the live ship transform */
  cameraPose(): CameraPose;
  /** true while the first-person view owns the keys and the lens */
  isActive(): boolean;
  setActive(active: boolean): void;
  /**
   * Station hook for §T.95: `onAction` registers a named handler, `applyAction`
   * fires it. Returns false when nothing handles the name — a silent no-op is
   * the §V62 shape, so callers can assert on it.
   */
  onAction(name: string, handler: ActionHandler): () => void;
  applyAction(name: string, value?: unknown): boolean;
  /**
   * §T.135 — the WORLD point the swimmer's `[Space] Climb aboard` plaque hangs
   * on, or null when there is nothing to climb. It answers with the SAME
   * `boardingCandidate` the haul-out itself takes and with the SAME lunge
   * limits, so the prompt is on screen exactly when the key would work: a
   * second copy of that rule would advertise a climb Space refuses (§V62).
   */
  boardingAnchor(): Vec3 | null;
  /** §T.95 station interaction; inert (no stations) when `socketWorld` is absent */
  readonly interact: Interact;
  /** the placeholder hands, if main passed them */
  readonly hands: Hands | null;
  dispose(): void;
}

function rotate(q: Quat, v: Vec3): Vec3 {
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx),
  ];
}

export function createPlayer(o: PlayerOptions): Player {
  const sim = o.sim;
  const shipToWorld = (p: Vec3): Vec3 => {
    const s = o.shipPose();
    const r = rotate(s.quaternion, p);
    return [r[0] + s.position[0], r[1] + s.position[1], r[2] + s.position[2]];
  };
  const waterAt = o.waterAt ?? (() => 0);
  const surface: WalkSurface = createDeckSurface(o.deckField, {
    waterAt,
    boardingPoints: o.boardingPoints,
    shipToWorld,
    ceilingAt: o.ceilingAt,
  });
  const groundAt = o.groundAt ?? ((): null => null);
  const terrain: WalkSurface = createTerrainSurface({ groundAt, waterAt, obstacleAt: o.obstacleAt });
  if (sim.player === undefined) {
    const spawn = o.spawn ?? [0, o.deckField.deckY, 0];
    const st = createPlayerState(spawn);
    st.pos[1] = surface.heightAt(spawn[0], spawn[2]) ?? spawn[1];
    st.grounded = true;
    sim.player = st;
  }

  let active = false;
  const keys = new PlayerKeys();
  const look = new LookAccumulator();
  const detachKeys = attachPlayerKeys(keys, o.keyTarget ?? window, () => active);
  const detachLock = o.canvas === undefined
    ? (): void => {}
    : attachPointerLock(o.canvas, { isActive: () => active, look });
  const actions = new Map<string, ActionHandler>();
  const applyAction = (name: string, value?: unknown): boolean => {
    const h = actions.get(name);
    if (h === undefined) return false;
    h(value);
    return true;
  };
  const worldToShip = (w: Vec3): Vec3 => {
    const s = o.shipPose();
    const q = s.quaternion;
    const d: Vec3 = [w[0] - s.position[0], w[1] - s.position[1], w[2] - s.position[2]];
    return rotate([-q[0], -q[1], -q[2], q[3]], d);
  };
  const interact = createInteract(
    {
      get state() {
        return sim.player as PlayerState;
      },
      setState: (next) => {
        sim.player = next;
      },
      applyAction,
      shipToWorld,
      worldToShip,
    },
    {
      socketWorld: o.socketWorld ?? (() => null),
      pieceNear: o.pieceNear,
      groundAt: o.groundAt,
      waterAt,
      enabled: o.actionEnabled,
    },
  );
  const frameCtx: FrameContext = {
    shipToWorld,
    worldToShip,
    groundAt,
    waterAt,
    deckHeightAt: (x, z) => surface.heightAt(x, z),
    boardingPoints: o.boardingPoints,
  };
  const detachDebug = o.onDebug === undefined
    ? (): void => {}
    : attachDebugKeys(o.keyTarget ?? window, {
        isDevLayerOn: () => o.devLayerOn?.() ?? false,
        isPlayerActive: () => active,
        onDebug: o.onDebug,
      });
  const hands = o.hands ?? null;
  let turning = false;
  /** aloft on the lookout the deck field is far below: stand on the perch instead */
  const perchSurface: WalkSurface = {
    heightAt: () => interact.perch()?.[1] ?? null,
    solidAt: () => false,
    shipToWorld,
  };

  const pos = new Vector3();
  const quat = new Quaternion();
  const shipQ = new Quaternion();
  const yawQ = new Quaternion();
  const pitchQ = new Quaternion();
  const Y = new Vector3(0, 1, 0);
  const X = new Vector3(1, 0, 0);

  return {
    get state() {
      return sim.player as PlayerState;
    },
    step(dt) {
      if (keys.takeToggle()) o.onToggle?.();
      const lookDelta = active ? look.take() : { yawDelta: 0, pitchDelta: 0 };
      const input = keys.sample(lookDelta);
      const presses = active ? keys.takeInteract() : 0;
      for (let i = 0; i < presses; i++) interact.begin();
      interact.step(dt, lookDelta);
      const frame = (sim.player as PlayerState).frame;
      // the surface is the FRAME's (§V85): deck while aboard and swimming
      // (the deck carries the boarding points), terrain ashore
      const walk = interact.perch() !== null ? perchSurface : frame === 'world' ? terrain : surface;
      sim.player = transitionFrame(
        interact.constrain(stepPlayer(sim.player as PlayerState, interact.shapeInput(input), walk, dt)),
        frameCtx,
      );
      if (hands !== null) {
        const held = interact.held();
        const d = interact.lastDelta();
        if (held === null) turning = false;
        else if (d !== 0) turning = true;
        hands.setPose(held === null ? 'idle' : turning ? 'turn' : 'grab');
        if (d !== 0) hands.turnBy(d);
        hands.update(dt);
      }
    },
    cameraPose() {
      const s = sim.player as PlayerState;
      const eye: Vec3 = [s.pos[0], s.pos[1] + eyeHeight(s.crouch, playerParams), s.pos[2]];
      // camera looks down its own -z; yaw 0 must face frame +z, hence the π
      yawQ.setFromAxisAngle(Y, s.yaw + Math.PI);
      pitchQ.setFromAxisAngle(X, s.pitch);
      quat.copy(yawQ).multiply(pitchQ);
      if (s.frame === 'ship') {
        // the LENS rides the drawn hull, not the simulated one (§B103)
        const rp = (o.renderPose ?? o.shipPose)();
        const r = rotate(rp.quaternion, eye);
        pos.set(r[0] + rp.position[0], r[1] + rp.position[1], r[2] + rp.position[2]);
        const q = rp.quaternion;
        shipQ.set(q[0], q[1], q[2], q[3]);
        quat.premultiply(shipQ);
      } else {
        pos.set(eye[0], eye[1], eye[2]);
      }
      return { position: pos, quaternion: quat };
    },
    boardingAnchor() {
      const s = sim.player as PlayerState;
      if (s.frame !== 'swim') return null;
      const water = waterAt(s.pos[0], s.pos[2]);
      const hit = boardingCandidate(
        surface,
        s.pos[0],
        s.pos[2],
        water,
        playerParams.boardLungeReach,
        playerParams.boardLungeVertical,
      );
      return hit === null ? null : hit.world;
    },
    isActive: () => active,
    setActive(a) {
      active = a;
      if (!a) {
        keys.clear();
        interact.end();
      }
    },
    onAction(name, handler) {
      actions.set(name, handler);
      return () => {
        if (actions.get(name) === handler) actions.delete(name);
      };
    },
    applyAction,
    interact,
    hands,
    dispose() {
      detachKeys();
      detachLock();
      detachDebug();
    },
  };
}
