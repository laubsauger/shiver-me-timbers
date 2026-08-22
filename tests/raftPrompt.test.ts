/**
 * §T.116 STATION PROMPTS. WHY each block exists:
 *
 * - §V84 gave every action a station and no way to know it was there. The
 *   label table is the affordance, so the first block is exhaustive over the
 *   `RaftAction` union: an action added without a name must FAIL here, not
 *   walk up to the player silent.
 * - §V71: the plaque hangs on a socket of a raft that pitches and sails away.
 *   The anchor is asserted as a PROPERTY — feed two ship transforms, the point
 *   must move — because that is exactly what a cached screen point cannot do.
 * - §V62: the last block drives a REAL `createInteract` and reads the text out
 *   of the DOM. A prompt module that is perfect in isolation and wired to
 *   nothing is this project's signature defect.
 * - §V80: the fade is asserted against `playerParams.promptFade`, the merge
 *   against `cueMergePx` — properties, not the numbers those knobs hold today.
 *
 * GPU-free and DOM-free by construction: the maths and the state machine are
 * pure exports, and the one block that needs elements stubs `document` the way
 * `perfHudFrameRow.test.ts` does (this repo runs vitest in the node env).
 */
import { describe, expect, it, beforeAll } from 'vitest';
import {
  createRaftPrompt,
  cuePoints,
  keyLabel,
  projectPoint,
  promptState,
  stepFade,
  viewProjection,
  type CameraLike,
  type Vec3,
} from '../src/ui/raftPrompt';
import {
  RAFT_ACTIONS,
  RAFT_LABELS,
  RAFT_STATIONS,
  isHold,
  type RaftAction,
} from '../src/player/stations';
import { createInteract, type InteractHost } from '../src/player/interact';
import { createPlayerState, type PlayerState } from '../src/player/playerStep';
import { playerParams } from '../src/params/player';
import { CONTROL_CODES } from '../src/input/controlMap';

const P = playerParams;
const W = 800;
const H = 600;
const EYE = P.standHeight - P.eyeDrop;

// --- matrices, three's layout: column-major, elements[column * 4 + row] ------

function mul(a: number[], b: number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

function rotY(t: number): number[] {
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}

function translate(t: Vec3): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1];
}

function perspective(fovDeg = 60, aspect = W / H, near = 0.1, far = 900): number[] {
  const f = 1 / Math.tan((fovDeg * Math.PI) / 360);
  return [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0,
  ];
}

/**
 * The view matrix for the walker's own lens: `cameraPose` builds the camera's
 * world transform as T(eye) · Ry(yaw + π) (camera looks down its own −z, yaw 0
 * faces frame +z), so the view is that inverted.
 */
function viewFor(eye: Vec3, yaw = 0): number[] {
  return mul(rotY(-(yaw + Math.PI)), translate([-eye[0], -eye[1], -eye[2]]));
}

const PROJ = perspective();
const cameraAt = (eye: Vec3, yaw = 0): CameraLike => ({
  projectionMatrix: { elements: PROJ },
  matrixWorldInverse: { elements: viewFor(eye, yaw) },
});

/** a resolver for a handful of sockets, everything else absent */
const sockets = (map: Record<string, Vec3>) => (id: string): Vec3 | null => map[id] ?? null;

const TILLER = RAFT_STATIONS.tiller.socket;
const RADIO = RAFT_STATIONS.radio.socket;

describe('§T.116 every station says what it is', () => {
  it('names every action — a new RaftAction with no label fails here', () => {
    // exhaustive over the union at RUNTIME as well as at compile time: the
    // Record<RaftAction, …> catches a missing key, this catches a stray one
    expect(Object.keys(RAFT_LABELS).sort()).toEqual([...RAFT_ACTIONS].sort());
    for (const a of RAFT_ACTIONS) {
      const name = RAFT_LABELS[a].name;
      expect(name, a).toBe(name.trim());
      expect(name.length, a).toBeGreaterThan(0);
      // it is a nameplate over a 3D object, not a sentence
      expect(name.length, a).toBeLessThanOrEqual(28);
    }
  });

  it('tells the hands what the drag does at every hold station', () => {
    // the plaque REPLACES the name and the key with this verb while the
    // station is held (see the held case below), so a hold without one is a
    // station that goes quiet at the moment the player needs telling which
    // way to pull
    for (const a of RAFT_ACTIONS) {
      if (!isHold(RAFT_STATIONS[a].kind)) continue;
      const verb = RAFT_LABELS[a].verb;
      expect(verb, a).toBeTruthy();
      expect((verb ?? '').trim().length, a).toBeGreaterThan(0);
    }
  });

  it('shows the key the walker actually presses, not a hard-coded letter', () => {
    expect(keyLabel(CONTROL_CODES.interact)).toBe('E');
    expect(keyLabel('Space')).toBe('Space');
  });
});

describe('§V71 the anchor is the LIVE socket, never a cached point', () => {
  const base: Vec3 = [0, EYE, 1];
  const cam = cameraAt([0, EYE, 0]);
  const vp = viewProjection(cam);

  it('follows the socket when the ship moves under it', () => {
    // one lens, two ship transforms — the raft heaves and yaws, exactly what
    // §V71 says a part positioned against another system must resolve against
    const still = promptState({
      focus: 'tiller', held: null, hidden: false,
      socketWorld: sockets({ [TILLER]: base }), viewProj: vp, width: W, height: H,
    });
    const heaved = promptState({
      focus: 'tiller', held: null, hidden: false,
      socketWorld: sockets({ [TILLER]: [base[0] + 0.25, base[1] + 0.15, base[2]] }),
      viewProj: vp, width: W, height: H,
    });
    expect(still).not.toBeNull();
    expect(heaved).not.toBeNull();
    // and it moved by a readable amount, not by floating-point dust: a plaque
    // that lags the object it names is the whole defect this asserts against
    expect(Math.hypot((heaved as { x: number }).x - (still as { x: number }).x,
      (heaved as { y: number }).y - (still as { y: number }).y)).toBeGreaterThan(20);
  });

  it('follows the LENS too — the same socket seen from a turned head moves', () => {
    const turned = viewProjection(cameraAt([0, EYE, 0], 0.25));
    const a = projectPoint(base, vp, W, H);
    const b = projectPoint(base, turned, W, H);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(Math.abs((b as { x: number }).x - (a as { x: number }).x)).toBeGreaterThan(20);
  });

  it('refuses a socket BEHIND the camera instead of drawing it at a plausible corner', () => {
    // the perspective divide by a negative w mirrors the point through the
    // origin: it lands on screen, in the wrong place, and looks fine
    expect(projectPoint([0, EYE, -1], vp, W, H)).toBeNull();
    expect(promptState({
      focus: 'tiller', held: null, hidden: false,
      socketWorld: sockets({ [TILLER]: [0, EYE, -1] }), viewProj: vp, width: W, height: H,
    })).toBeNull();
  });

  it('refuses a NaN socket rather than positioning at NaN px', () => {
    expect(projectPoint([Number.NaN, EYE, 1], vp, W, H)).toBeNull();
    expect(projectPoint([0, Number.POSITIVE_INFINITY, 1], vp, W, H)).toBeNull();
    expect(promptState({
      focus: 'tiller', held: null, hidden: false,
      socketWorld: sockets({ [TILLER]: [Number.NaN, EYE, 1] }), viewProj: vp, width: W, height: H,
    })).toBeNull();
  });

  it('refuses a socket the assembly does not have', () => {
    expect(promptState({
      focus: 'tiller', held: null, hidden: false,
      socketWorld: () => null, viewProj: vp, width: W, height: H,
    })).toBeNull();
  });
});

describe('§T.116 what the plaque says, and when', () => {
  const cam = viewProjection(cameraAt([0, EYE, 0]));
  const world = sockets({ [TILLER]: [0, EYE, 1], [RADIO]: [0.35, EYE, 1] });
  const at = (over: Partial<Parameters<typeof promptState>[0]> = {}) =>
    promptState({
      focus: null, held: null, hidden: false, socketWorld: world,
      viewProj: cam, width: W, height: H, ...over,
    });

  it('is shown if and only if a station is focused', () => {
    expect(at({ focus: null })).toBeNull();
    const on = at({ focus: 'tiller' });
    expect(on?.name).toBe(RAFT_LABELS.tiller.name);
    expect(on?.key).toBe('E');
    expect(on?.verb).toBeNull();
  });

  it('while a station is HELD, says only what the drag does', () => {
    const held = at({ focus: 'tiller', held: 'tiller' });
    expect(held?.verb).toBe(RAFT_LABELS.tiller.verb);
    expect(held?.name).toBe(''); // the name and the key step aside
    expect(held?.key).toBeNull();
  });

  it('keeps naming the HELD station even when the eye wanders to another', () => {
    // the head may turn holdYawLimitDeg either side while holding, so another
    // station can enter the cone; the prompt must not hop to it
    const held = at({ focus: 'radio', held: 'tiller' });
    expect(held?.action).toBe('tiller');
    expect(held?.verb).toBe(RAFT_LABELS.tiller.verb);
  });

  it('shows nothing at all in photo / cinematic mode (§I ui/cinematic)', () => {
    expect(at({ focus: 'tiller', hidden: true })).toBeNull();
    expect(at({ focus: 'tiller', held: 'tiller', hidden: true })).toBeNull();
  });
});

describe('§T.116 the in-reach cue', () => {
  const cam = viewProjection(cameraAt([0, EYE, 0]));
  const world = sockets({
    [TILLER]: [0, EYE, 1],
    [RADIO]: [0.35, EYE, 1],
    [RAFT_STATIONS['sheet-p'].socket]: [-0.02, EYE, 1], // half a metre apart in the world…
    [RAFT_STATIONS['sheet-s'].socket]: [0.02, EYE, 1], // …and a few px apart on screen
  });
  const dots = (over: Partial<Parameters<typeof cuePoints>[0]> = {}) =>
    cuePoints({
      focus: null, held: null, hidden: false, socketWorld: world, viewProj: cam,
      width: W, height: H, inReach: ['tiller', 'radio'], mergePx: P.cueMergePx,
      maxDots: P.cueMaxDots, ...over,
    });

  it('marks what is in reach, and never the station the plaque already names', () => {
    expect(dots({ inReach: ['tiller', 'radio'] }).map((d) => d.action)).toEqual(['tiller', 'radio']);
    expect(dots({ focus: 'tiller', inReach: ['tiller', 'radio'] }).map((d) => d.action)).toEqual(['radio']);
  });

  it('merges dots that would stack — the sheets sit half a metre apart', () => {
    // `inReach` is nearest first, so the survivor is the one E would take
    const both = dots({ inReach: ['sheet-p', 'sheet-s'] });
    expect(both.map((d) => d.action)).toEqual(['sheet-p']);
    // the same two are two dots once the merge distance is turned down, which
    // proves the thinning is the knob and not an accident of the projection
    expect(dots({ inReach: ['sheet-p', 'sheet-s'], mergePx: 0 })).toHaveLength(2);
  });

  it('draws at most cueMaxDots, nearest first', () => {
    const many = dots({ inReach: ['tiller', 'radio', 'sheet-p'], maxDots: 2, mergePx: 0 });
    expect(many.map((d) => d.action)).toEqual(['tiller', 'radio']);
  });

  it('goes dark while a station is held, and in photo / cinematic mode', () => {
    expect(dots({ held: 'tiller' })).toHaveLength(0);
    expect(dots({ hidden: true })).toHaveLength(0);
  });
});

describe('§T.116 the fade', () => {
  it('reaches full strength in promptFade seconds and back out again', () => {
    const dt = P.promptFade / 3;
    let a = 0;
    a = stepFade(a, 1, dt, P.promptFade);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(1);
    a = stepFade(stepFade(a, 1, dt, P.promptFade), 1, dt, P.promptFade);
    expect(a).toBeCloseTo(1, 6);
    expect(stepFade(1, 0, P.promptFade, P.promptFade)).toBe(0);
  });

  it('snaps under prefers-reduced-motion — one owner for the whole animation', () => {
    expect(stepFade(0, 1, 1 / 60, P.promptFade, true)).toBe(1);
    expect(stepFade(1, 0, 1 / 60, P.promptFade, true)).toBe(0);
  });
});

// --- §V62: the real interact, the real DOM elements -------------------------

interface FakeEl {
  tag: string;
  id: string;
  className: string;
  textContent: string;
  style: Record<string, string>;
  children: FakeEl[];
  parent: FakeEl | null;
  appendChild(c: FakeEl): void;
  remove(): void;
  setAttribute(k: string, v: string): void;
}

function makeEl(tag: string): FakeEl {
  const node: FakeEl = {
    tag, id: '', className: '', textContent: '', style: {}, children: [], parent: null,
    appendChild(c: FakeEl): void {
      c.parent = node;
      node.children.push(c);
    },
    remove(): void {
      const p = node.parent;
      if (p === null) return;
      p.children.splice(p.children.indexOf(node), 1);
      node.parent = null;
    },
    setAttribute(): void {},
  };
  return node;
}

function find(root: FakeEl, className: string): FakeEl | null {
  if (root.className.split(' ').includes(className)) return root;
  for (const c of root.children) {
    const hit = find(c, className);
    if (hit !== null) return hit;
  }
  return null;
}

let body: FakeEl;

beforeAll(() => {
  body = makeEl('body');
  (globalThis as unknown as Record<string, unknown>).document = {
    createElement: (tag: string) => makeEl(tag),
    getElementById: () => null,
    head: makeEl('head'),
    body,
  };
});

/** a walker standing at the origin, eye height, with an action log */
function fakeHost(): InteractHost & { st: PlayerState } {
  const h = {
    st: { ...createPlayerState([0, 0, 0], 0), grounded: true } as PlayerState,
    get state() {
      return h.st;
    },
    setState(n: PlayerState): void {
      h.st = n;
    },
    applyAction(): boolean {
      return true;
    },
  };
  return h;
}

describe('§V62 a focus change drives the visible label', () => {
  it('walks the real interact API from nothing, to the tiller, to a hold, to the radio', () => {
    const host = fakeHost();
    // two stations, both in reach, 73° apart so only the one being LOOKED at
    // can be in the 35° cone
    const world: Record<string, [number, number, number]> = { [TILLER]: [0, EYE, 1], [RADIO]: [1, EYE, 0.3] };
    const interact = createInteract(host, { socketWorld: (id) => world[id] ?? null });
    let photo = false;
    const parent = makeEl('div');
    body.appendChild(parent);
    let yaw = Math.PI; // facing away from both
    const prompt = createRaftPrompt({
      interact,
      socketWorld: (id) => world[id] ?? null,
      camera: () => cameraAt([0, EYE, 0], host.st.yaw),
      hidden: () => photo,
      size: () => ({ x: W, y: H }),
      parent: parent as unknown as HTMLElement,
    });
    const step = (n = 12): void => {
      for (let i = 0; i < n; i++) prompt.update(1 / 60);
    };
    const face = (y: number): void => {
      yaw = y;
      host.st = { ...host.st, yaw };
      step();
    };
    const nameEl = find(parent, 'smt-prompt-name');
    const verbEl = find(parent, 'smt-prompt-verb');
    const plaque = find(parent, 'smt-prompt');
    expect(nameEl).not.toBeNull();
    expect(plaque).not.toBeNull();

    // (1) looking at nothing: no plaque
    face(Math.PI);
    expect(interact.focus()).toBeNull();
    expect(prompt.readState()).toBeNull();
    expect(Number((plaque as FakeEl).style.opacity)).toBe(0);

    // (2) turn to the tiller — the label is the LABEL TABLE's, through the
    // real focus(), not a string this test handed the module
    face(0);
    expect(interact.focus()).toBe('tiller');
    expect(prompt.readState()?.action).toBe('tiller');
    expect((nameEl as FakeEl).textContent).toBe(RAFT_LABELS.tiller.name);
    expect(Number((plaque as FakeEl).style.opacity)).toBe(1);

    // (3) take hold of it: the drag verb replaces the name and the key
    interact.begin();
    step(2);
    expect(interact.held()).toBe('tiller');
    expect((verbEl as FakeEl).textContent).toBe(RAFT_LABELS.tiller.verb);
    expect((nameEl as FakeEl).textContent).toBe('');

    // (4) let go and turn to the radio: the plaque follows the walker
    interact.end();
    face(Math.atan2(1, 0.3));
    expect(interact.focus()).toBe('radio');
    expect((nameEl as FakeEl).textContent).toBe(RAFT_LABELS.radio.name);

    // (5) photo / cinematic mode empties the screen, and leaving it fills it
    // back in — the mode is READ from the caller's view state every frame
    photo = true;
    step();
    expect(prompt.readState()).toBeNull();
    expect(Number((plaque as FakeEl).style.opacity)).toBe(0);
    expect((plaque as FakeEl).style.visibility).toBe('hidden');
    photo = false;
    step();
    expect(prompt.readState()?.action).toBe('radio');

    prompt.dispose();
    expect(find(parent, 'smt-prompt')).toBeNull();
  });

  it('marks the stations in reach that the plaque is not naming', () => {
    const host = fakeHost();
    // both on screen this time: a cue for a socket the lens cannot see is a
    // dot at the edge of the frame pointing at nothing, and `projectPoint`
    // drops it
    const world: Record<string, [number, number, number]> = { [TILLER]: [0, EYE, 1], [RADIO]: [0.35, EYE, 1.1] };
    const interact = createInteract(host, { socketWorld: (id) => world[id] ?? null });
    const parent = makeEl('div');
    body.appendChild(parent);
    const prompt = createRaftPrompt({
      interact,
      socketWorld: (id) => world[id] ?? null,
      camera: () => cameraAt([0, EYE, 0], host.st.yaw),
      size: () => ({ x: W, y: H }),
      parent: parent as unknown as HTMLElement,
    });
    // both are within reach; only the tiller is being looked at
    expect(interact.inReach().sort()).toEqual(['radio', 'tiller']);
    expect(interact.focus()).toBe('tiller');
    for (let i = 0; i < 12; i++) prompt.update(1 / 60);
    const cues = parent.children.flatMap((c) => c.children).filter((c) => c.className === 'smt-prompt-cue');
    expect(cues).toHaveLength(1); // the radio's; the tiller has the plaque
    expect(Number(cues[0].style.opacity)).toBeGreaterThan(0);
    prompt.dispose();
  });
});

describe('§T.116 station labels are wired to the stations they name', () => {
  it('every label belongs to an action with a socket', () => {
    for (const a of Object.keys(RAFT_LABELS) as RaftAction[]) {
      expect(RAFT_STATIONS[a], a).toBeDefined();
      expect(RAFT_STATIONS[a].socket, a).toMatch(/^station-/);
    }
  });
});
