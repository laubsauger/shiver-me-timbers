/**
 * STATION PROMPTS (§T.116, §V84). §V84 gave every play action a diegetic place
 * on the raft and nothing that says so: the walker could stand at the tiller,
 * looking straight at it, with no way to know it was a thing you could take
 * hold of. USER: "we need some sort of visual indication for anything that can
 * be operated, with a little bit of text."
 *
 * TWO STRENGTHS, ONE SOURCE.
 *   the plaque — the station `interact.focus()` is offering: its name and the
 *                key, or, once it is held, ONLY what the drag does. One at a
 *                time, because only one station is ever offered.
 *   the cue    — a 7px brass diamond on every OTHER station within reach.
 *                It says "there is something here", not what.
 * Both read `interact`; neither has its own idea of what is reachable, so the
 * cue can never mark a station E refuses (§V62 — the shape of this project's
 * favourite defect is a second copy of a rule).
 *
 * §V71 — THE ANCHOR IS RESOLVED LIVE, EVERY FRAME. The label hangs on a socket
 * of a raft that pitches, rolls and sails away; a screen point cached when the
 * station came into focus would be nailed to the sea instead of to the tiller.
 * `socketWorld` is the assembly's own resolver, re-asked per frame, and the
 * camera's view matrix is refreshed here rather than read from the last frame
 * (a stale view lags the whole label one frame behind the lens while turning,
 * which reads as the label sliding off the object).
 *
 * The maths and the state machine below the DOM layer are pure and exported —
 * `projectPoint`, `promptState`, `cuePoints`, `stepFade` — because that is
 * everything worth pinning (§V80) and none of it needs a GPU or a browser.
 */
import { CONTROL_CODES } from '../input/controlMap';
import { playerParams, type PlayerParams } from '../params/player';
import { RAFT_LABELS, RAFT_STATIONS, type RaftAction } from '../player/stations';
import { div, el } from './dom';
import { ensureUiStyles } from './styles';

export type Vec3 = readonly [number, number, number];
export type SocketResolver = (id: string) => Vec3 | null;

/** a 4×4 in three's layout: column-major, `elements[column * 4 + row]` */
export interface Mat4Like {
  readonly elements: ArrayLike<number>;
}
interface Mat4Live extends Mat4Like {
  copy(m: Mat4Live): Mat4Live;
  invert(): Mat4Live;
}

/**
 * The slice of a camera the projection needs, declared structurally so this
 * module — and its tests — never import three. A real `THREE.Camera` satisfies
 * it, and so does a literal of four matrices in a test.
 */
export interface CameraLike {
  projectionMatrix: Mat4Like;
  matrixWorldInverse: Mat4Like;
  /** three's own; when present the view matrix is refreshed in place per frame */
  matrixWorld?: Mat4Like;
  updateMatrixWorld?(force?: boolean): void;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface PromptState {
  action: RaftAction;
  /** the station's name; empty while held — the verb speaks instead */
  name: string;
  /** the key to press, or null while the station is already in hand */
  key: string | null;
  /** what the drag does; only while held */
  verb: string | null;
  x: number;
  y: number;
}

/** `KeyE` → `E`, the same reading the quick-controls card uses */
export function keyLabel(code: string): string {
  return code.startsWith('Key') ? code.slice(3) : code;
}

/** the interact surface a prompt needs; `Interact` satisfies it */
export interface PromptSource {
  focus(): RaftAction | null;
  held(): RaftAction | null;
  inReach(): RaftAction[];
}

/** view-projection = projection · view, column-major, three's element order */
export function viewProjection(camera: CameraLike): number[] {
  camera.updateMatrixWorld?.();
  const inv = camera.matrixWorldInverse as Mat4Live;
  // three keeps `matrixWorldInverse` up to date only inside render; ask it to
  // catch up now so the anchor cannot trail the lens by a frame
  if (camera.matrixWorld !== undefined && typeof inv.copy === 'function') {
    inv.copy(camera.matrixWorld as Mat4Live).invert();
  }
  const p = camera.projectionMatrix.elements;
  const v = inv.elements;
  const out = new Array<number>(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = p[r] * v[c * 4] + p[4 + r] * v[c * 4 + 1] + p[8 + r] * v[c * 4 + 2] + p[12 + r] * v[c * 4 + 3];
    }
  }
  return out;
}

/**
 * World point → screen pixels, or null when there is no honest answer:
 * BEHIND the camera (w ≤ 0, where the perspective divide flips the point to
 * the opposite corner and a label would appear at a garbage position that
 * looks perfectly plausible), or off the viewport, or non-finite because a
 * socket resolved on a part that has not been placed yet.
 */
export function projectPoint(
  p: Vec3,
  viewProj: ArrayLike<number>,
  width: number,
  height: number,
): ScreenPoint | null {
  if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2])) return null;
  if (!(width > 0) || !(height > 0)) return null;
  const m = viewProj;
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  if (!(w > 1e-6)) return null; // at or behind the lens
  const cx = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
  const cy = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  const x = (cx / w * 0.5 + 0.5) * width;
  const y = (0.5 - cy / w * 0.5) * height;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  // a station the walker is within 1.6 m of is never far off screen; a point
  // that is has come from a matrix nobody updated
  const margin = Math.max(width, height);
  if (x < -margin || x > width + margin || y < -margin || y > height + margin) return null;
  return { x, y };
}

export interface PromptInput {
  focus: RaftAction | null;
  held: RaftAction | null;
  /** photo or cinematic mode: nothing over the render at all */
  hidden: boolean;
  socketWorld: SocketResolver;
  viewProj: ArrayLike<number>;
  width: number;
  height: number;
}

/**
 * The one station being offered, resolved to a screen point — or null, which
 * means the plaque fades out. Held outranks focus: while the tiller is in hand
 * the walker may look wherever the yaw limit allows, and the prompt must not
 * hop to whatever else passes through the cone.
 */
export function promptState(o: PromptInput): PromptState | null {
  if (o.hidden) return null;
  const action = o.held ?? o.focus;
  if (action === null) return null;
  const station = RAFT_STATIONS[action];
  const label = RAFT_LABELS[action];
  if (station === undefined || label === undefined) return null;
  const world = o.socketWorld(station.socket);
  if (world === null) return null;
  const at = projectPoint(world, o.viewProj, o.width, o.height);
  if (at === null) return null;
  const held = o.held !== null;
  // a hold with no verb still says the name: silence would be worse than a
  // nameplate, and the §V80 test refuses the table that gets there
  const verb = held ? label.verb ?? null : null;
  return {
    action,
    name: held && verb !== null ? '' : label.name,
    key: held ? null : keyLabel(CONTROL_CODES.interact),
    verb,
    x: at.x,
    y: at.y,
  };
}

export interface CueInput extends PromptInput {
  inReach: readonly RaftAction[];
  mergePx: number;
  maxDots: number;
}

/**
 * The dots. Every station in reach EXCEPT the one the plaque already names,
 * nearest first, thinned so that two sockets half a metre apart — the port and
 * starboard sheets — do not stack into an unreadable blob. Nothing is drawn at
 * all while a station is held: both hands are busy, and a constellation of
 * other options is noise at that moment.
 */
export function cuePoints(o: CueInput): Array<ScreenPoint & { action: RaftAction }> {
  if (o.hidden || o.held !== null) return [];
  const out: Array<ScreenPoint & { action: RaftAction }> = [];
  const merge = Math.max(0, o.mergePx);
  for (const a of o.inReach) {
    if (out.length >= Math.max(0, o.maxDots)) break;
    if (a === o.focus) continue; // the plaque is its cue
    const station = RAFT_STATIONS[a];
    if (station === undefined) continue;
    const world = o.socketWorld(station.socket);
    if (world === null) continue;
    const at = projectPoint(world, o.viewProj, o.width, o.height);
    if (at === null) continue;
    // `inReach` is nearest first, so the survivor of a merge is the station E
    // would actually take
    if (out.some((q) => Math.hypot(q.x - at.x, q.y - at.y) < merge)) continue;
    out.push({ action: a, x: at.x, y: at.y });
  }
  return out;
}

/**
 * One step of a linear fade toward `target` (0 or 1) over `fadeSec`. Linear
 * and dt-driven rather than a CSS transition: the element it drives is being
 * re-positioned every frame, and `prefers-reduced-motion` then has exactly one
 * owner — `reduced` snaps, and nothing else in the module animates.
 */
export function stepFade(alpha: number, target: number, dt: number, fadeSec: number, reduced = false): number {
  if (reduced || !(fadeSec > 0) || !Number.isFinite(dt)) return target;
  const step = Math.max(0, dt) / fadeSec;
  return alpha < target ? Math.min(target, alpha + step) : Math.max(target, alpha - step);
}

export interface RaftPromptOptions {
  /** the walker's stations — `player.interact` */
  interact: PromptSource;
  /** LIVE socket resolver (§V71), the assembly's own */
  socketWorld: SocketResolver;
  /** the lens the frame was drawn through */
  camera: () => CameraLike | null;
  /**
   * §I ui/cinematic — photo mode and cinematic (full screen) both mean "the
   * frame is being captured": no overlay. Pass the view-mode state, do not
   * keep a second flag.
   */
  hidden?: () => boolean;
  /** viewport in CSS px; defaults to the window */
  size?: () => ScreenPoint;
  parent?: HTMLElement;
  params?: PlayerParams;
}

export interface RaftPrompt {
  /** call once per rendered frame, after the camera has been placed */
  update(dt: number): void;
  /** what is on screen right now — the §V62 read-back for tests and the console */
  readState(): PromptState | null;
  dispose(): void;
}

const px = (v: number): string => `${Math.round(v * 10) / 10}px`;

/** live read, so a system-preference change is honoured without a reload */
function reducedMotion(): boolean {
  const mm = (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia;
  if (typeof mm !== 'function') return false;
  try {
    return mm('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function createRaftPrompt(o: RaftPromptOptions): RaftPrompt {
  ensureUiStyles();
  const p = o.params ?? playerParams;
  const root = div('smt-ui smt-prompt-layer');
  const name = el('span', 'smt-prompt-name', '');
  const key = el('kbd', 'smt-key', keyLabel(CONTROL_CODES.interact));
  const verb = el('span', 'smt-prompt-verb', '');
  const plaque = div('smt-prompt', key, name, verb);
  plaque.setAttribute('role', 'status');
  plaque.style.opacity = '0';
  plaque.style.visibility = 'hidden';
  root.appendChild(plaque);
  (o.parent ?? document.body).appendChild(root);

  /** one dot per station, so a fade belongs to a station and never slides
   *  from one socket to another when the set in reach changes */
  const dots = new Map<RaftAction, { node: HTMLElement; alpha: number }>();
  let alpha = 0;
  let shown: PromptState | null = null;

  const place = (node: HTMLElement, x: number, y: number, extra: string): void => {
    node.style.transform = `translate(${px(x)}, ${px(y)}) ${extra}`;
  };

  const paintDots = (points: Array<ScreenPoint & { action: RaftAction }>, dt: number, reduced: boolean): void => {
    const live = new Set(points.map((q) => q.action));
    for (const q of points) {
      let dot = dots.get(q.action);
      if (dot === undefined) {
        const node = div('smt-prompt-cue');
        node.style.opacity = '0';
        root.appendChild(node);
        dot = { node, alpha: 0 };
        dots.set(q.action, dot);
      }
      place(dot.node, q.x, q.y, 'translate(-50%, -50%) rotate(45deg)');
      dot.alpha = stepFade(dot.alpha, 1, dt, p.promptFade, reduced);
      dot.node.style.opacity = (dot.alpha * 0.62).toFixed(3);
      dot.node.style.visibility = 'visible';
    }
    for (const [action, dot] of dots) {
      if (live.has(action)) continue;
      dot.alpha = stepFade(dot.alpha, 0, dt, p.promptFade, reduced);
      dot.node.style.opacity = (dot.alpha * 0.62).toFixed(3);
      if (dot.alpha > 0) continue;
      dot.node.remove();
      dots.delete(action);
    }
  };

  return {
    update(dt: number): void {
      const reduced = reducedMotion();
      const camera = o.camera();
      const view = o.size?.() ?? { x: window.innerWidth, y: window.innerHeight };
      const hidden = o.hidden?.() ?? false;
      const input: PromptInput = {
        focus: hidden || camera === null ? null : o.interact.focus(),
        held: hidden || camera === null ? null : o.interact.held(),
        hidden: hidden || camera === null,
        socketWorld: o.socketWorld,
        // §V71: resolved from THIS frame's lens, not a cached one
        viewProj: camera === null ? [] : viewProjection(camera),
        width: view.x,
        height: view.y,
      };
      const next = promptState(input);
      if (next !== null) {
        shown = next;
        name.textContent = next.name;
        verb.textContent = next.verb ?? '';
        key.style.display = next.key === null ? 'none' : '';
        name.style.display = next.name === '' ? 'none' : '';
        verb.style.display = next.verb === null ? 'none' : '';
        // the plaque floats above the socket, pointing down at it
        place(plaque, next.x, next.y - p.promptRisePx, 'translate(-50%, -100%)');
      } else {
        shown = null;
      }
      alpha = stepFade(alpha, next === null ? 0 : 1, dt, p.promptFade, reduced);
      plaque.style.opacity = alpha.toFixed(3);
      plaque.style.visibility = alpha > 0 ? 'visible' : 'hidden';
      paintDots(
        cuePoints({
          ...input,
          inReach: input.hidden ? [] : o.interact.inReach(),
          mergePx: p.cueMergePx,
          maxDots: p.cueMaxDots,
        }),
        dt,
        reduced,
      );
    },
    readState: () => (alpha > 0 ? shown : null),
    dispose(): void {
      for (const dot of dots.values()) dot.node.remove();
      dots.clear();
      root.remove();
    },
  };
}
