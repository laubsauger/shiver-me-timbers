/**
 * §T.95 stations, interact, hands, debug keys. WHY each block exists:
 *
 * - §V84: PLAY = WALK + TOUCH. Every action has a socket on the REAL raft
 *   blueprint (resolved through the assembly, §V71) and fires through the
 *   interact path headlessly; the hotkey path is inert with the dev layer off
 *   or the walker on the lens.
 * - §V62: a channel that is published but clamped wrong, or a key that is
 *   bound and drives nothing, is this project's signature defect — so the
 *   assertions are on `applyAction` being CALLED with a monotone value.
 * - §V80: properties, with the limits read from `playerParams` (reach, cone,
 *   yaw limit, pose time), never the numbers themselves.
 */
import { describe, expect, it } from 'vitest';
import type { Material } from 'three';
import { capsuleDistance, createInteract, lookDir, type InteractHost } from '../src/player/interact';
import { LOOKOUT_SOCKET, RAFT_ACTIONS, RAFT_STATIONS, type RaftAction } from '../src/player/stations';
import { HandBlend, lerpTransform, poseTransform, turnAngle } from '../src/player/handPoses';
import { attachDebugKeys, debugKeyAction, type DebugChannel } from '../src/player/debugKeys';
import { createPlayer } from '../src/player/index';
import { createPlayerState, type PlayerState, type Vec3 } from '../src/player/playerStep';
import { neutralPlayerInput } from '../src/player/playerStep';
import { playerParams } from '../src/params/player';
import { CONTROL_CODES } from '../src/input/controlMap';
import { buildRaftBlueprint } from '../src/ship/raftBlueprint';
import { buildGalleonBlueprint } from '../src/ship/shipBlueprint';
import { ShipAssembly } from '../src/ship/shipAssembly';
import { buildDeckHeightfield } from '../src/ship/deckHeightfield';
import { buildRaftDeckField, createRaftCeiling } from '../src/ship/raftDeckField';
import { createDeckSurface } from '../src/player/deckSurface';
import { createInitialState, type ShipState } from '../src/state/simState';
import { updateShipRig } from '../src/ship/rigTrim';
import { applyRaftAction, initialRaftControls } from '../src/raft/raftActions';
import { stepRaftShip } from '../src/raft/raftShip';

const DT = 1 / 60;
const P = playerParams;
const stubFactory = () => ({ dispose(): void {} }) as unknown as Material;
const EYE = P.standHeight - P.eyeDrop;

function keyEvent(type: string, code: string, over: Record<string, unknown> = {}): Event {
  const e = new Event(type, { cancelable: true }) as Event & Record<string, unknown>;
  e.code = code;
  e.repeat = false;
  e.metaKey = false;
  e.altKey = false;
  e.ctrlKey = false;
  e.shiftKey = false;
  Object.assign(e, over);
  return e;
}

/** a fake host: plain state, an action log, identity ship transform */
function fakeHost(pos: Vec3, yaw = 0, pitch = 0): InteractHost & { log: [string, unknown][]; st: PlayerState } {
  const h = {
    st: { ...createPlayerState(pos, yaw), pitch, grounded: true } as PlayerState,
    log: [] as [string, unknown][],
    get state() {
      return h.st;
    },
    setState(n: PlayerState) {
      h.st = n;
    },
    applyAction(name: string, value?: unknown) {
      h.log.push([name, value]);
      return true;
    },
  };
  return h;
}

/** stand 1 m from the socket (horizontally), eye-level, facing it */
function standAt(socket: Vec3, back: Vec3 = [0, 0, -1]): { pos: Vec3; yaw: number; pitch: number } {
  const pos: Vec3 = [socket[0] + back[0], socket[1] - EYE, socket[2] + back[2]];
  const yaw = Math.atan2(socket[0] - pos[0], socket[2] - pos[2]);
  return { pos, yaw, pitch: 0 };
}

const raft = buildRaftBlueprint();
const raftAsm = new ShipAssembly(raft, stubFactory);
const raftSocket = (id: string): Vec3 | null => {
  try {
    return raftAsm.socketWorldPosition(id) as Vec3;
  } catch {
    return null;
  }
};

describe('§V84 every action has a station on the real raft', () => {
  it('every RAFT_STATIONS socket resolves to a finite position on the assembly, and so does the lookout', () => {
    for (const a of RAFT_ACTIONS) {
      const p = raftAsm.socketWorldPosition(RAFT_STATIONS[a].socket);
      expect(p, a).toHaveLength(3);
      for (const v of p) expect(Number.isFinite(v), `${a} ${RAFT_STATIONS[a].socket}`).toBe(true);
    }
    expect(raftAsm.socketWorldPosition(LOOKOUT_SOCKET).every(Number.isFinite)).toBe(true);
  });

  it('the table covers every member of the union exactly once, and each socket is claimed by one action PER FRAME (§T.100: push-off shares the bow gangway socket from the sand)', () => {
    const keys = RAFT_ACTIONS.map((a) => `${RAFT_STATIONS[a].frame ?? 'ship'}:${RAFT_STATIONS[a].socket}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(RAFT_ACTIONS.length).toBe(18);
  });

  it('each action fires headlessly through interact at its own socket', () => {
    // the fake host uses the identity ship transform, so the raft's sockets
    // ARE the player's frame. The raft is DENSE (the halyard is 0.5 m from
    // the port sheet), so the property is: from SOME stance 0.8 m off the
    // socket, looking at it, that station is the one in focus — every
    // station is reachable on foot, none is shadowed by a neighbour.
    const approaches: Vec3[] = [[0, 0, -0.8], [0, 0, 0.8], [0.8, 0, 0], [-0.8, 0, 0]];
    for (const a of RAFT_ACTIONS) {
      const st = RAFT_STATIONS[a];
      const q = raftSocket(st.socket) as Vec3;
      let host = fakeHost([0, 0, 0]);
      let ix = createInteract(host, { socketWorld: raftSocket });
      let found = false;
      for (const back of approaches) {
        const { pos, yaw } = standAt(q, back);
        host = fakeHost(pos, yaw);
        if (st.frame !== undefined) host.st.frame = st.frame; // a station worked from the sand (push-off)
        ix = createInteract(host, {
          socketWorld: raftSocket,
          groundAt: () => pos[1], // ground everywhere, level with the feet, so the gangways have somewhere to go
          waterAt: () => -10, // the fake stances sit below y = 0; the sea is lower still
        });
        if (ix.focus() === a) {
          found = true;
          break;
        }
      }
      expect(found, `no stance focuses ${a}`).toBe(true);
      ix.begin();
      const fired = host.log.map(([n]) => n);
      expect(fired, `${a} fired`).toContain(a);
      if (st.kind === 'hold-turn' || st.kind === 'hold-slide') {
        expect(ix.held()).toBe(a);
        // natural gesture: mouse right for turn, or the station's own sign for slide
        const look = st.axis === 'mouse-x'
          ? { yawDelta: -0.05, pitchDelta: 0 }
          : { yawDelta: 0, pitchDelta: 0.05 * (st.dir ?? 1) };
        // the other way first: it runs down to the floor and clamps there
        // (the halyard starts hoisted, so "up" from rest would be a no-op)
        const rev = { yawDelta: -look.yawDelta, pitchDelta: -look.pitchDelta };
        for (let i = 0; i < 400; i++) ix.step(DT, rev);
        expect(ix.value(a)).toBe(st.min ?? 0);
        const seen: number[] = [];
        for (let i = 0; i < 200; i++) {
          ix.step(DT, look);
          const last = host.log[host.log.length - 1];
          if (last[0] === a) seen.push(last[1] as number);
        }
        expect(seen.length).toBeGreaterThan(1);
        for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
        expect(seen[seen.length - 1]).toBeGreaterThan(st.min ?? 0);
        expect(seen[seen.length - 1]).toBeLessThanOrEqual(st.max ?? 1);
        ix.end();
        expect(ix.held()).toBeNull();
      } else {
        expect(ix.held()).toBeNull();
      }
    }
  });
});

describe('focus: reach and look cone, read from playerParams', () => {
  const two = (id: string): Vec3 | null => (id === 'station-tiller' ? [0, EYE, 1.0] : id === 'station-radio' ? [0, EYE, 1.3] : null);

  it('picks the nearer of two stations both inside reach and cone', () => {
    const host = fakeHost([0, 0, 0], 0);
    const ix = createInteract(host, { socketWorld: two });
    expect(ix.focus()).toBe('tiller');
  });

  it('gate(d) admits ⟺ d ≤ reach', () => {
    const at = (d: number): RaftAction | null => {
      const host = fakeHost([0, 0, 0], 0);
      return createInteract(host, { socketWorld: (id) => (id === 'station-tiller' ? [0, EYE, d] : null) }).focus();
    };
    expect(at(P.reach - 0.01)).toBe('tiller');
    expect(at(P.reach + 0.01)).toBeNull();
  });

  it('gate(θ) admits ⟺ θ ≤ focusConeDeg', () => {
    const cone = (P.focusConeDeg * Math.PI) / 180;
    const at = (theta: number): RaftAction | null => {
      const host = fakeHost([0, 0, 0], theta); // look away from the station by θ
      return createInteract(host, { socketWorld: (id) => (id === 'station-tiller' ? [0, EYE, 1] : null) }).focus();
    };
    expect(at(cone - 0.02)).toBe('tiller');
    expect(at(cone + 0.02)).toBeNull();
    expect(at(-(cone - 0.02))).toBe('tiller');
  });

  it('a socket the resolver cannot find is simply not a station', () => {
    const host = fakeHost([0, 0, 0], 0);
    const ix = createInteract(host, { socketWorld: () => null });
    expect(ix.focus()).toBeNull();
    ix.begin();
    expect(ix.held()).toBeNull();
    expect(host.log).toEqual([]);
  });

  it('lookDir follows the walker convention: yaw 0 is +z, +yaw turns toward +x, +pitch looks up', () => {
    expect(lookDir(0, 0)).toEqual([0, 0, 1]);
    expect(lookDir(Math.PI / 2, 0)[0]).toBeCloseTo(1, 12);
    expect(lookDir(0, Math.PI / 2)[1]).toBeCloseTo(1, 12);
  });
});

describe('holding: hands are busy, head is tethered', () => {
  const tillerAhead = (id: string): Vec3 | null => (id === 'station-tiller' ? [0, EYE, 1] : null);

  it('walking input is zeroed while a hold-* station is held, and restored on end()', () => {
    const host = fakeHost([0, 0, 0], 0);
    const ix = createInteract(host, { socketWorld: tillerAhead });
    const walk = { ...neutralPlayerInput(), forward: 1, strafe: -1, jump: true, yawDelta: 0.01 };
    expect(ix.shapeInput(walk)).toBe(walk);
    ix.begin();
    const shaped = ix.shapeInput(walk);
    expect(shaped.forward).toBe(0);
    expect(shaped.strafe).toBe(0);
    expect(shaped.jump).toBe(false);
    expect(shaped.yawDelta).toBe(0.01); // looking is still allowed
    ix.end();
    expect(ix.shapeInput(walk)).toBe(walk);
  });

  it('yaw is clamped to ±holdYawLimitDeg of the station facing while held, free otherwise', () => {
    const host = fakeHost([0, 0, 0], 0);
    const ix = createInteract(host, { socketWorld: tillerAhead });
    const lim = (P.holdYawLimitDeg * Math.PI) / 180;
    const turned = { ...host.state, yaw: lim + 0.3 };
    expect(ix.constrain(turned).yaw).toBe(lim + 0.3);
    ix.begin();
    expect(ix.constrain(turned).yaw).toBeCloseTo(lim, 12);
    expect(ix.constrain({ ...host.state, yaw: -lim - 0.3 }).yaw).toBeCloseTo(-lim, 12);
    expect(ix.constrain({ ...host.state, yaw: lim - 0.1 }).yaw).toBeCloseTo(lim - 0.1, 12);
  });

  it('a second begin() while holding releases — E is grab AND let go', () => {
    const host = fakeHost([0, 0, 0], 0);
    const ix = createInteract(host, { socketWorld: tillerAhead });
    ix.begin();
    expect(ix.held()).toBe('tiller');
    ix.begin();
    expect(ix.held()).toBeNull();
  });
});

describe('climb and step-off move the walker', () => {
  it('the ladder puts the feet within 0.3 m of station-lookout, the next use brings them back', () => {
    const ladder = raftSocket('station-ladder') as Vec3;
    const lookout = raftSocket(LOOKOUT_SOCKET) as Vec3;
    const { pos, yaw } = standAt(ladder);
    const host = fakeHost(pos, yaw);
    const ix = createInteract(host, { socketWorld: raftSocket });
    expect(ix.focus()).toBe('ladder');
    ix.begin();
    const up = host.state.pos;
    expect(Math.hypot(up[0] - lookout[0], up[1] - lookout[1], up[2] - lookout[2])).toBeLessThan(0.3);
    expect(ix.perch()).not.toBeNull();
    expect(host.state.grounded).toBe(true);
    // up there the only station is the way down, whatever the eye is on
    expect(ix.focus()).toBe('ladder');
    ix.begin();
    expect(ix.perch()).toBeNull();
    expect(host.state.pos).toEqual(pos);
    expect(host.log.map(([n, v]) => `${n}:${v}`)).toEqual(['ladder:1', 'ladder:0']);
  });

  it('a gangway with no ground (groundAt null) is a no-op; with ground it steps the walker off into the world frame', () => {
    const g = raftSocket('station-gangway-starboard') as Vec3;
    const { pos, yaw } = standAt(g, [-1, 0, 0]);
    const dry = fakeHost(pos, yaw);
    const ixDry = createInteract(dry, { socketWorld: raftSocket, groundAt: () => null });
    expect(ixDry.focus()).toBe('gangway-starboard');
    ixDry.begin();
    expect(dry.state.frame).toBe('ship');
    expect(dry.state.pos).toEqual(pos);
    expect(dry.log).toEqual([]);

    const wet = fakeHost(pos, yaw);
    // ground 0.2 m below the feet: within ashoreVertical of the deck edge (§T.100)
    const ixWet = createInteract(wet, { socketWorld: raftSocket, groundAt: () => pos[1] - 0.2, waterAt: () => -10 });
    ixWet.begin();
    expect(wet.state.frame).toBe('world');
    // starboard gangway: 0.6 m further to +x of the socket, standing on the ground
    expect(wet.state.pos[0]).toBeCloseTo(g[0] + P.stepOffDistance, 9);
    expect(wet.state.pos[2]).toBeCloseTo(g[2], 9);
    expect(wet.state.pos[1]).toBe(pos[1] - 0.2);
    expect(wet.log).toEqual([['gangway-starboard', 1]]);
  });

  it('step-off honours the live ship transform: a raft yawed 90° puts the landing on the world side the socket faces', () => {
    const g = raftSocket('station-gangway-bow') as Vec3;
    const { pos, yaw } = standAt(g, [0, 0, -1]);
    const host = fakeHost(pos, yaw);
    // ship yawed +90° about y: local +z → world +x
    const R = Math.PI / 2;
    const toW = (p: Vec3): Vec3 => [Math.cos(R) * p[0] + Math.sin(R) * p[2], p[1], -Math.sin(R) * p[0] + Math.cos(R) * p[2]];
    const toL = (p: Vec3): Vec3 => [Math.cos(R) * p[0] - Math.sin(R) * p[2], p[1], Math.sin(R) * p[0] + Math.cos(R) * p[2]];
    host.shipToWorld = toW;
    host.worldToShip = toL;
    const ix = createInteract(host, { socketWorld: (id) => (raftSocket(id) === null ? null : toW(raftSocket(id) as Vec3)), groundAt: () => pos[1], waterAt: () => -10 });
    expect(ix.focus()).toBe('gangway-bow');
    ix.begin();
    const gw = toW(g);
    expect(host.state.frame).toBe('world');
    expect(host.state.pos[0]).toBeCloseTo(gw[0] + P.stepOffDistance, 9);
    expect(host.state.pos[2]).toBeCloseTo(gw[2], 9);
    expect(host.state.yaw).toBeCloseTo(yaw + R, 9);
  });
});

describe('debug hotkeys are gated twice (§V84)', () => {
  function mount(dev: boolean, active: boolean): { target: EventTarget; log: [DebugChannel, number][] } {
    const target = new EventTarget();
    const log: [DebugChannel, number][] = [];
    attachDebugKeys(target, { isDevLayerOn: () => dev, isPlayerActive: () => active, onDebug: (c, d) => log.push([c, d]) });
    return { target, log };
  }
  const codes = [CONTROL_CODES.debugOarPort, CONTROL_CODES.debugGuaraFwd, CONTROL_CODES.debugSheetIn, CONTROL_CODES.debugTune, CONTROL_CODES.debugDawn];

  it('inert when the dev layer is off', () => {
    const { target, log } = mount(false, false);
    for (const c of codes) target.dispatchEvent(keyEvent('keydown', c));
    expect(log).toEqual([]);
  });

  it('inert when the walker owns the lens, even with the dev layer on', () => {
    const { target, log } = mount(true, true);
    for (const c of codes) target.dispatchEvent(keyEvent('keydown', c));
    expect(log).toEqual([]);
  });

  it('effective with dev on and walker off: each key a signed debugStep, N once, Shift reverses', () => {
    const { target, log } = mount(true, false);
    target.dispatchEvent(keyEvent('keydown', CONTROL_CODES.debugOarPort));
    target.dispatchEvent(keyEvent('keydown', CONTROL_CODES.debugOarStarboard));
    target.dispatchEvent(keyEvent('keydown', CONTROL_CODES.debugGuaraFwd));
    target.dispatchEvent(keyEvent('keydown', CONTROL_CODES.debugGuaraAft, { shiftKey: true }));
    target.dispatchEvent(keyEvent('keydown', CONTROL_CODES.debugSheetIn));
    target.dispatchEvent(keyEvent('keydown', CONTROL_CODES.debugSheetOut));
    target.dispatchEvent(keyEvent('keydown', CONTROL_CODES.debugTune));
    target.dispatchEvent(keyEvent('keydown', CONTROL_CODES.debugDawn));
    target.dispatchEvent(keyEvent('keydown', CONTROL_CODES.debugDawn, { repeat: true }));
    target.dispatchEvent(keyEvent('keydown', 'KeyZ'));
    const s = P.debugStep;
    expect(log).toEqual([
      ['oar', -s],
      ['oar', s],
      ['guara-fwd', s],
      ['guara-aft', -s],
      ['sheet', s],
      ['sheet', -s],
      ['tune', s],
      ['dawn', 1],
    ]);
  });

  it('the tune key is not the first-person toggle, and the interact key is the walker’s E', () => {
    expect(CONTROL_CODES.debugTune).not.toBe(CONTROL_CODES.toggleFirstPerson);
    expect(debugKeyAction(CONTROL_CODES.toggleFirstPerson, false)).toBeNull();
    expect(CONTROL_CODES.interact).toBe('KeyE');
  });
});

describe('hands pose math', () => {
  it('a pose blend arrives within handPoseTime ± one frame, and not before', () => {
    const b = new HandBlend('right');
    b.setPose('grab', P.handPoseTime);
    const target = poseTransform('right', 'grab');
    const frames = Math.ceil(P.handPoseTime / DT);
    for (let i = 0; i < frames - 2; i++) b.advance(DT);
    const early = b.current(P.handPoseTime);
    expect(early.position).not.toEqual(target.position);
    b.advance(DT);
    b.advance(DT);
    expect(b.settled(P.handPoseTime)).toBe(true);
    expect(b.current(P.handPoseTime)).toEqual(target);
  });

  it('a blend interrupted mid-way starts from where the hand IS, not from where it was going', () => {
    const b = new HandBlend('left');
    b.setPose('grab', 1);
    b.advance(0.5);
    const mid = b.current(1);
    b.setPose('idle', 1);
    expect(b.current(1)).toEqual(mid);
  });

  it('turn angle is channel delta × gain, and NaN-safe', () => {
    expect(turnAngle(0.25, P.handTurnGain)).toBeCloseTo(0.25 * P.handTurnGain, 12);
    expect(turnAngle(-0.5, 2)).toBe(-1);
    expect(turnAngle(Number.NaN, 2)).toBe(0);
    expect(turnAngle(1, Number.NaN)).toBe(0);
  });

  it('lerp clamps t and the two hands mirror in x', () => {
    const a = poseTransform('left', 'idle');
    const c = poseTransform('left', 'grab');
    expect(lerpTransform(a, c, 2)).toEqual(c);
    expect(lerpTransform(a, c, -1)).toEqual(a);
    expect(poseTransform('right', 'grab').position[0]).toBeCloseTo(-poseTransform('left', 'grab').position[0], 12);
  });
});

describe('through the real player: E begins and ends a hold, and the hold stops the walk', () => {
  const galleon = buildGalleonBlueprint();
  const field = buildDeckHeightfield(galleon);
  if (field === null) throw new Error('galleon has no deck field');

  function mount() {
    const sim = createInitialState(1);
    const target = new EventTarget();
    const spawn: Vec3 = [1.5, field!.deckY, 0];
    const log: [string, unknown][] = [];
    // a tiller 1 m ahead of the spawn, at eye level, in the (identity) ship frame
    const player = createPlayer({
      sim,
      shipPose: () => ({ position: [0, 0, 0], quaternion: [0, 0, 0, 1] }),
      deckField: field!,
      keyTarget: target,
      spawn,
      socketWorld: (id) => (id === 'station-tiller' ? [spawn[0], spawn[1] + EYE, spawn[2] + 1] : null),
    });
    player.onAction('tiller', (v) => log.push(['tiller', v]));
    return { sim, target, player, log };
  }

  it('KeyE on a real EventTarget grabs the station in focus; the walk keys then move nothing; E again lets go', () => {
    const { sim, target, player, log } = mount();
    player.setActive(true);
    for (let i = 0; i < 5; i++) player.step(DT);
    expect(player.interact.focus()).toBe('tiller');
    target.dispatchEvent(keyEvent('keydown', CONTROL_CODES.interact));
    player.step(DT);
    expect(player.interact.held()).toBe('tiller');
    expect(log.length).toBe(1);
    target.dispatchEvent(keyEvent('keyup', CONTROL_CODES.interact));
    const p0 = [...sim.player!.pos];
    target.dispatchEvent(keyEvent('keydown', CONTROL_CODES.walkForward));
    for (let i = 0; i < 60; i++) player.step(DT);
    expect(sim.player!.pos).toEqual(p0);
    target.dispatchEvent(keyEvent('keyup', CONTROL_CODES.walkForward));
    target.dispatchEvent(keyEvent('keydown', CONTROL_CODES.interact));
    player.step(DT);
    expect(player.interact.held()).toBeNull();
    target.dispatchEvent(keyEvent('keyup', CONTROL_CODES.interact));
    target.dispatchEvent(keyEvent('keydown', CONTROL_CODES.walkForward));
    for (let i = 0; i < 60; i++) player.step(DT);
    expect(sim.player!.pos[2] - p0[2]).toBeGreaterThan(0.5);
    player.dispose();
  });

  it('E is ignored while the walker is off the lens (it is the brace key then), and leaving the view lets go', () => {
    const { target, player } = mount();
    target.dispatchEvent(keyEvent('keydown', CONTROL_CODES.interact));
    player.step(DT);
    expect(player.interact.held()).toBeNull();
    target.dispatchEvent(keyEvent('keyup', CONTROL_CODES.interact));
    player.setActive(true);
    for (let i = 0; i < 5; i++) player.step(DT);
    target.dispatchEvent(keyEvent('keydown', CONTROL_CODES.interact));
    player.step(DT);
    expect(player.interact.held()).toBe('tiller');
    player.setActive(false);
    expect(player.interact.held()).toBeNull();
    player.dispose();
  });

  it('leaving the first-person view lets go; the deck field is ignored while aloft', () => {
    const sim = createInitialState(1);
    const spawn: Vec3 = [1.5, field!.deckY, 0];
    const player = createPlayer({
      sim,
      shipPose: () => ({ position: [0, 0, 0], quaternion: [0, 0, 0, 1] }),
      deckField: field!,
      keyTarget: new EventTarget(),
      spawn,
      socketWorld: (id) =>
        id === 'station-ladder' ? [spawn[0], spawn[1] + EYE, spawn[2] + 1] : id === LOOKOUT_SOCKET ? [spawn[0], spawn[1] + 9, spawn[2] + 1] : null,
    });
    player.setActive(true);
    for (let i = 0; i < 5; i++) player.step(DT);
    player.interact.begin();
    expect(player.interact.perch()).not.toBeNull();
    for (let i = 0; i < 120; i++) player.step(DT);
    expect(sim.player!.pos[1]).toBeCloseTo(spawn[1] + 9, 6); // not fallen to the deck
    expect(player.cameraPose().position.y).toBeCloseTo(spawn[1] + 9 + EYE, 6);
    player.interact.begin();
    for (let i = 0; i < 30; i++) player.step(DT);
    expect(sim.player!.pos[1]).toBeCloseTo(spawn[1], 1);
    player.dispose();
  });
});

describe('§V2 determinism and NaN safety', () => {
  it('the same script twice yields the same action log', () => {
    const script = (): string => {
      const q = raftSocket('station-tiller') as Vec3;
      const { pos, yaw } = standAt(q);
      const host = fakeHost(pos, yaw);
      const ix = createInteract(host, { socketWorld: raftSocket });
      ix.begin();
      for (let i = 0; i < 300; i++) ix.step(DT, { yawDelta: Math.sin(i * 0.1) * 0.02, pitchDelta: 0 });
      return JSON.stringify(host.log);
    };
    expect(script()).toBe(script());
  });

  it('NaN look, NaN dt, NaN socket: every published value stays finite and in range', () => {
    const q = raftSocket('station-guara-3') as Vec3;
    const { pos, yaw } = standAt(q);
    const host = fakeHost(pos, yaw);
    let poison = false;
    const ix = createInteract(host, { socketWorld: (id) => (poison ? [Number.NaN, 0, 0] : raftSocket(id)) });
    ix.begin();
    expect(ix.held()).toBe('guara-3');
    ix.step(Number.NaN, { yawDelta: Number.NaN, pitchDelta: Number.NaN });
    ix.step(DT, { yawDelta: 0, pitchDelta: Number.POSITIVE_INFINITY });
    ix.step(DT, { yawDelta: 0, pitchDelta: -0.3 });
    for (const [, v] of host.log) {
      expect(Number.isFinite(v as number)).toBe(true);
      expect(v as number).toBeGreaterThanOrEqual(0);
      expect(v as number).toBeLessThanOrEqual(1);
    }
    ix.end();
    poison = true;
    expect(ix.focus()).toBeNull();
    host.st = { ...host.st, yaw: Number.NaN };
    expect(() => ix.focus()).not.toThrow();
  });
});

/**
 * §B69 / §B86-4 — A STATION YOU CAN ONLY TOUCH BY CROUCHING IS NOT A STATION.
 *
 * `focus()` returned null 0.7 m from the tiller while looking straight at it,
 * and the gangways (sockets on the log tops, 0.29 m up) only came into focus
 * from a crouch. The cause was the RANGE metric, not the raft: the distance
 * was taken eye→socket, so a standing eye 1.6 m over a deck-level socket had
 * already spent the whole `reach` before moving a step. The property is about
 * the STANCE, so it is measured on the real deck: from somewhere a walker can
 * actually stand, at a distance a person would stand at, looking at it.
 */
describe('§B69 stations focus from a natural standing stance on the real deck', () => {
  const deckField = buildRaftDeckField(raft);
  const ceiling = createRaftCeiling();
  const deck = createDeckSurface(deckField, { ceilingAt: ceiling });
  const NEAR = 0.6;
  const FAR = 1.4;

  interface Stance { d: number; crouch: boolean }

  function stanceThatFocuses(a: RaftAction, standingOnly: boolean): Stance | null {
    const st = RAFT_STATIONS[a];
    const q = raftSocket(st.socket) as Vec3;
    for (let d = NEAR; d <= FAR + 1e-9; d += 0.05) {
      for (let k = 0; k < 24; k++) {
        const t = (k / 24) * Math.PI * 2;
        const x = q[0] + Math.cos(t) * d;
        const z = q[2] + Math.sin(t) * d;
        const world = st.frame === 'world';
        // stand where the raft lets you stand — real deck height, no walls
        const h = world ? q[1] : deck.heightAt(x, z);
        if (h === null || (!world && deck.solidAt(x, z))) continue;
        const c = world ? null : ceiling(x, z);
        const crouch = c !== null && c - h < P.standHeight;
        if (standingOnly && crouch) continue;
        const eye = h + (crouch ? P.crouchHeight : P.standHeight) - P.eyeDrop;
        const host = fakeHost([x, h, z], Math.atan2(q[0] - x, q[2] - z), Math.atan2(q[1] - eye, d));
        host.st.crouch = crouch;
        if (world) host.st.frame = 'world';
        const ix = createInteract(host, {
          socketWorld: raftSocket,
          groundAt: () => h,
          waterAt: () => h - 10,
        });
        if (ix.focus() === a) return { d, crouch };
      }
    }
    return null;
  }

  it('every station comes into focus from 0.6–1.4 m, standing where the deck lets you stand', () => {
    for (const a of RAFT_ACTIONS) {
      const st = RAFT_STATIONS[a];
      const q = raftSocket(st.socket) as Vec3;
      const s = stanceThatFocuses(a, false);
      expect(s, `${a} (${st.socket}) has no stance in reach`).not.toBeNull();
      const found = s as Stance;
      expect(found.d).toBeGreaterThanOrEqual(NEAR - 1e-9);
      expect(found.d).toBeLessThanOrEqual(FAR + 1e-9);
      // UNDER THE SKY, STANDING MUST BE ENOUGH. The cabin roof is 1.2 m over
      // its floor [§3 Height], so the stations inside it are worked on your
      // knees by design (§V85 auto-crouch) — but a crouch anywhere ELSE is
      // the §B69 defect: nothing about the stance changed, only the eye.
      const roofed = st.frame !== 'world' && ceiling(q[0], q[2]) !== null;
      if (!roofed) {
        expect(stanceThatFocuses(a, true), `${a} focuses only from a crouch`).not.toBeNull();
      }
    }
    expect(raftSocket(LOOKOUT_SOCKET)).not.toBeNull();
  });

  it('the reach is the CAPSULE\'s, not the eye\'s: a socket at the feet is in reach at arm\'s length', () => {
    // the exact §B86-4 report: 0.7 m from the tiller socket, which sits at
    // deck level, facing it. The eye metric made that hypot(0.7, 1.6) = 1.75.
    const feet: Vec3 = [0, 0, 0];
    const socket: Vec3 = [0, 0, 0.7]; // level with the boots, 0.7 m ahead
    const host = fakeHost(feet, 0, Math.atan2(-EYE, 0.7));
    const ix = createInteract(host, { socketWorld: (id) => (id === 'station-tiller' ? socket : null) });
    expect(Math.hypot(0.7, EYE)).toBeGreaterThan(P.reach); // the old metric refused it
    expect(capsuleDistance(host.st, socket, P)).toBeCloseTo(0.7, 6);
    expect(ix.focus()).toBe('tiller');
    // and it is still a REACH: the same socket a full reach away is out
    const far = fakeHost(feet, 0, Math.atan2(-EYE, P.reach + 0.2));
    const ixFar = createInteract(far, { socketWorld: (id) => (id === 'station-tiller' ? [0, 0, P.reach + 0.2] as Vec3 : null) });
    expect(ixFar.focus()).toBeNull();
  });
});

/**
 * §T.136c THE PIECE MUST MOVE. USER at a guara: "there's also no visual
 * feedback as to if there's anything happening or not."
 *
 * §B92 is exactly this defect and it went unnoticed for weeks — the wheel
 * turned, the rudder blade never did, on every hull in the game. So this
 * block does not inspect wiring: it drives the REAL interact path with a
 * REAL mouse delta and asserts BOTH that the channel moved AND that the
 * three.js transform of the piece the station names moved with it.
 */
describe('§T.136c a hold station moves the thing it names', () => {
  const WIND = { direction: 0, speed: 9 };
  const raftShipState = (): ShipState => ({
    id: 'raft', kind: 'player', position: [0, 0, 0], quaternion: [0, 0, 0, 1],
    velocity: [0, 0, 0], angularVelocity: [0, 0, 0],
    rudder: 0, sailTrim: 1, flood: 0, damage: {},
  });

  /** the walker standing under `action`'s socket, looking at it, holding it */
  function holding(action: RaftAction, publish: (a: string, v: unknown) => void) {
    const st = RAFT_STATIONS[action];
    const socket = raftAsm.socketWorldPosition(st.socket) as Vec3;
    // half a metre back from it, eye level with it: the stance the §V84 block
    // above proves every station has
    const feet: Vec3 = [socket[0], socket[1] - EYE, socket[2] - 0.5];
    const host = fakeHost(feet, 0, 0);
    const ix = createInteract(
      {
        get state() {
          return host.st;
        },
        setState: (n: PlayerState) => {
          host.st = n;
        },
        applyAction: (n: string, v: unknown) => {
          publish(n, v);
          return true;
        },
      },
      { socketWorld: (id) => (id === st.socket ? socket : null) },
    );
    expect(ix.focus(), `${action} is not focusable from its own stance`).toBe(action);
    ix.begin();
    expect(ix.held()).toBe(action);
    return ix;
  }

  /** the sail's yard node, by the blueprint's own parent link */
  function yardOf(asm: ShipAssembly): { y: () => number; drop: () => number } {
    const sailId = asm.sailPieceIds()[0];
    expect(sailId, 'the raft carries no canvas: this test would prove nothing').toBeDefined();
    const def = raft.find((q) => q.id === sailId);
    const yard = asm.group.getObjectByName(def?.parent ?? '');
    expect(yard, `sail ${sailId} has no yard node to move`).toBeDefined();
    return {
      y: () => (yard as { position: { y: number } }).position.y,
      drop: () => (asm.sailMesh(sailId).userData.sailDropScale as number),
    };
  }

  it('the sheets shorten the canvas and lower the yard, through the real path', () => {
    // the whole chain, no shortcuts: interact → applyRaftAction → RaftControls
    // → stepRaftShip → ShipState.sailTrim → updateShipRig → the yard's node
    const asm = new ShipAssembly(raft, stubFactory);
    const controls = initialRaftControls();
    controls.sailUp = true;
    const ship = raftShipState();
    const spar = yardOf(asm);
    const drive = (): void => {
      stepRaftShip(ship, controls, WIND, DT);
      updateShipRig(ship, asm, DT);
    };
    const ix = holding('sheet-p', (n, v) => applyRaftAction(controls, n, v, { skipToDawn: () => {} }));
    // sheet home: the mouse goes UP, which is exactly what the plaque now says
    for (let i = 0; i < 60; i++) ix.step(DT, { yawDelta: 0, pitchDelta: 0.05 });
    drive();
    expect(ix.value('sheet-p')).toBeGreaterThan(0.9);
    expect(controls.sheet).toBeCloseTo(ix.value('sheet-p'), 9);
    const full = { y: spar.y(), drop: spar.drop() };
    // …and now ease it right off
    for (let i = 0; i < 120; i++) ix.step(DT, { yawDelta: 0, pitchDelta: -0.05 });
    drive();
    expect(ix.value('sheet-p')).toBeLessThan(0.1);
    expect(controls.sheet).toBeCloseTo(ix.value('sheet-p'), 9);
    // THE PIECE MOVED. Either assertion alone would have passed §B92 too: the
    // canvas is shorter AND the spar has come down its own travel.
    expect(spar.drop()).toBeLessThan(full.drop);
    expect(spar.y()).toBeLessThan(full.y - 1e-6);
  });

  it('the halyard lowers the same yard, so the station and the spar agree', () => {
    const asm = new ShipAssembly(raft, stubFactory);
    const controls = initialRaftControls();
    controls.sheet = 1;
    const ship = raftShipState();
    const spar = yardOf(asm);
    const drive = (): void => {
      stepRaftShip(ship, controls, WIND, DT);
      updateShipRig(ship, asm, DT);
    };
    const ix = holding('halyard', (n, v) => applyRaftAction(controls, n, v, { skipToDawn: () => {} }));
    for (let i = 0; i < 60; i++) ix.step(DT, { yawDelta: 0, pitchDelta: 0.05 });
    drive();
    expect(controls.sailUp).toBe(true);
    const hoisted = spar.y();
    for (let i = 0; i < 120; i++) ix.step(DT, { yawDelta: 0, pitchDelta: -0.05 });
    drive();
    expect(controls.sailUp).toBe(false);
    expect(spar.y()).toBeLessThan(hoisted - 1e-6);
  });

  /**
   * §T.136c, THE HALF THAT IS NOT FIXED HERE — reported, not papered over.
   *
   *   · the TILLER publishes `oarAngle` → `ship.rudder` (raftShip.ts:92) and
   *     `updateRig` turns `wheel-disc` and `rudder` pieces. The raft has
   *     NEITHER: her blade is a `steering-oar` piece (raftPartsHull.ts:273),
   *     which no `set*Angle` in `shipAssembly.ts` touches. §T.118 found this
   *     and it is still true.
   *   · the GUARAS publish `guaraDepth[i]`, which reaches `raftKinematics`
   *     and stops there. `buildGuaras` (raftPartsHull.ts:227) authors
   *     `shape: { depth, travel }` and its own comment says "the sim
   *     raises/lowers a guara by moving the piece along y by up to
   *     `shape.travel`" — nothing in the codebase does. `grep setGuara` is
   *     empty.
   *
   * Both fixes live in `src/ship/**`, which this task does not own, so what
   * is asserted here is the CONTRACT the fix will need: the travel exists in
   * the blueprint, and it is a real distance. A test that asserted the
   * defect would write it down (§V80); this one fails the day someone
   * deletes the affordance and passes the day someone drives it.
   */
  it('the guara pieces carry the travel a fix would move them along', () => {
    const boards = raft.filter((q) => q.kind === 'guara');
    expect(boards.length).toBe(5);
    for (const b of boards) {
      expect(b.shape?.travel, `${b.id} has no authored travel`).toBeGreaterThan(0.1);
      expect(b.shape?.depth, `${b.id} has no rest depth`).toBeGreaterThanOrEqual(0);
    }
    // and the steering oar is one piece with a real lever to swing
    const oar = raft.find((q) => q.kind === 'steering-oar');
    expect(oar, 'no steering oar to turn').toBeDefined();
    expect(oar?.shape?.tillerLength, 'the oar has no tiller cross-piece').toBeGreaterThan(0);
  });
});
