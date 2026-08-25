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
import {
  CLIMB_ABOARD,
  dragHint,
  isHold,
  RAFT_LABELS,
  RAFT_STATIONS,
  stationAnchor,
  type PieceResolver,
  type RaftAction,
  type RaftStation,
} from '../player/stations';
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

/**
 * §T.135 — `'climb-aboard'` is a prompt, not a station. It is deliberately NOT
 * a `RaftAction`: it has no socket (the anchor is whichever metre of foot-rail
 * the swimmer is beside), no channel and no `E`, and adding it to the union
 * would break §V84's "∀ RaftAction ∃ a socket that resolves on the assembly".
 * Everything else about it — the plaque, the fade, the keycap, the label table
 * — is shared, which is the §V95 half that matters.
 */
export type PromptAction = RaftAction | 'climb-aboard';

export interface PromptState {
  action: PromptAction;
  /** the station's name; empty while held — the verb speaks instead */
  name: string;
  /** the key to press, or null while the station is already in hand */
  key: string | null;
  /** what the drag does; only while held */
  verb: string | null;
  /**
   * §T.136a — the gesture, while held: 'mouse up: hoist · down: lower'. The
   * verb says what the station DOES and this says what the hand does, which is
   * the half §T.116 left out ("I don't know how to actually raise or lower
   * this. What do we do? Do we click?").
   */
  gesture: string | null;
  /** §T.136a — how to let go, while held; the grab is a toggle, not a hold */
  release: string | null;
  /**
   * §T.136b — the live channel while held, so the player SEES the number move
   * as they drag. `readout` is the printed value, `bar` is the same value as a
   * fill of the track (`from`/`to` in 0..1) — signed channels fill out from
   * the middle, so the tiller reads as an angle either side of amidships.
   */
  readout: string | null;
  bar: { from: number; to: number } | null;
  /**
   * §T.156 — WHAT THE STATION ITSELF IS SAYING, when it has something to say
   * that the channel cannot: the radio's live frequency, its signal, and the
   * name of the station it has locked. Supplied by the wiring (`statusOf`),
   * because the plaque knows about channels and sockets and must not learn
   * what a megahertz is (§V95 — the tuner already owns that arithmetic).
   */
  status: string | null;
  /** §T.136d — the station is named but out of arm's reach; the plaque says so */
  outOfReach: boolean;
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
  /** §T.136b — the live channel of a hold station, for the readout and the bar */
  value(action: RaftAction): number;
  /** §T.136d — looked at, named, too far to touch */
  outOfReach(): RaftAction | null;
}

/**
 * §T.136b — WHERE THE FILL STARTS AND WHERE IT ENDS, in 0..1 of the track.
 *
 * A 0..1 channel (guara depth, sheet, halyard) fills from the empty end. A
 * signed one (the tiller, −1..1) fills from the middle, because amidships is
 * not "empty" — it is the rest position, and a bar that reads half full with
 * the oar straight would say the helm is over when it is not.
 */
export function channelBar(st: RaftStation, value: number): { from: number; to: number } {
  const min = st.min ?? 0;
  const max = st.max ?? 1;
  const span = max - min;
  if (!(span > 1e-9) || !Number.isFinite(value)) return { from: 0, to: 0 };
  const t = Math.min(1, Math.max(0, (value - min) / span));
  const zero = min < 0 && max > 0 ? -min / span : 0;
  return t < zero ? { from: t, to: zero } : { from: zero, to: t };
}

/**
 * §T.136b — the printed value. A signed channel reads as a percentage of full
 * travel with the SIDE named, because "−0.42" tells a helmsman nothing and
 * "42% to port" tells him where his oar is; an unsigned one is a plain
 * percentage of its own range.
 */
export function channelReadout(action: RaftAction, st: RaftStation, value: number): string {
  const min = st.min ?? 0;
  const max = st.max ?? 1;
  const span = max - min;
  if (!(span > 1e-9) || !Number.isFinite(value)) return '';
  const v = Math.min(max, Math.max(min, value));
  if (min < 0 && max > 0) {
    const pct = Math.round((Math.abs(v) / Math.max(-min, max)) * 100);
    if (pct === 0) return 'amidships';
    const hint = dragHint(action);
    const side = v > 0 ? hint?.moreDoes : hint?.lessDoes;
    return side === undefined ? `${pct}%` : `${pct}% — ${side}`;
  }
  return `${Math.round(((v - min) / span) * 100)}%`;
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
  /** §T.136d — named but too far to touch; used only when `focus` is null */
  outOfReach?: RaftAction | null;
  /**
   * §T.135 — the WORLD point of the foot-rail a SWIMMER could haul out at, or
   * null. `Player.boardingAnchor` answers it with the same reach the haul-out
   * itself uses, so the plaque appears exactly when Space would work.
   */
  board?: Vec3 | null;
  /** §T.136b — live channel of a hold station; absent = no readout */
  value?: (action: RaftAction) => number;
  /** §T.156 — the station's own live line, or null; see `PromptState.status` */
  statusOf?: (action: RaftAction) => string | null;
  /** photo or cinematic mode: nothing over the render at all */
  hidden: boolean;
  socketWorld: SocketResolver;
  /**
   * §T.157 — the live point on a PIECE nearest a world point. With it, the
   * plaque and the dots hang on the OBJECT (the oar's tiller end, the radio's
   * face); without it they fall back to the stance, which is where they used
   * to hang and why the labels read as misplaced.
   */
  pieceNear?: PieceResolver;
  viewProj: ArrayLike<number>;
  width: number;
  height: number;
}

/**
 * The one thing being offered, resolved to a screen point — or null, which
 * means the plaque fades out. The order of precedence, strongest first:
 *
 *   held    while the tiller is in hand the walker may look wherever the yaw
 *           limit allows, and the prompt must not hop to whatever else passes
 *           through the cone.
 *   board   a swimmer has exactly one thing to do and it is not the tiller
 *           (§T.135). `interact.scan` lets stations resolve from the water,
 *           so without this a man in the sea would be offered the helm.
 *   focus   the station being looked at from arm's reach.
 *   too far the station being looked at from beyond it, which says so
 *           (§T.136d) rather than staying silent.
 */
export function promptState(o: PromptInput): PromptState | null {
  if (o.hidden) return null;
  if (o.held === null && o.board !== undefined && o.board !== null) {
    const at = projectPoint(o.board, o.viewProj, o.width, o.height);
    if (at === null) return null;
    return {
      action: 'climb-aboard',
      name: CLIMB_ABOARD.name,
      key: keyLabel(CONTROL_CODES.walkJump),
      verb: null,
      gesture: null,
      release: null,
      readout: null,
      bar: null,
      status: null,
      outOfReach: false,
      x: at.x,
      y: at.y,
    };
  }
  const far = o.held === null && o.focus === null ? o.outOfReach ?? null : null;
  const action = o.held ?? o.focus ?? far;
  if (action === null) return null;
  const station = RAFT_STATIONS[action];
  const label = RAFT_LABELS[action];
  if (station === undefined || label === undefined) return null;
  const world = stationAnchor(action, o.socketWorld, o.pieceNear);
  if (world === null) return null;
  const at = projectPoint(world, o.viewProj, o.width, o.height);
  if (at === null) return null;
  const held = o.held !== null;
  // a hold with no verb still says the name: silence would be worse than a
  // nameplate, and the §V80 test refuses the table that gets there
  const verb = held ? label.verb ?? null : null;
  const hold = isHold(station.kind);
  const v = held && hold && o.value !== undefined ? o.value(action) : null;
  return {
    action,
    name: held && verb !== null ? '' : label.name,
    // out of reach there is no key to offer: pressing it does nothing, and a
    // keycap on a plaque that says "step closer" is the contradiction §T.136d
    // is about
    key: held || far !== null ? null : keyLabel(CONTROL_CODES.interact),
    verb,
    gesture: held ? dragHint(action)?.text ?? null : null,
    release: held ? `${keyLabel(CONTROL_CODES.interact)} to let go` : null,
    readout: v === null ? null : channelReadout(action, station, v),
    bar: v === null ? null : channelBar(station, v),
    // the status is the station's own voice: offered whenever there is one,
    // held or not, so a radio that has a lock still says so as you walk up
    status: far !== null ? null : o.statusOf?.(action) ?? null,
    outOfReach: far !== null,
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
  // …and nothing at all from the water: a swimmer's one job is the rail
  // (§T.135), and dots on the tiller he cannot take would be a lie
  if (o.hidden || o.held !== null || (o.board !== undefined && o.board !== null)) return [];
  const out: Array<ScreenPoint & { action: RaftAction }> = [];
  const merge = Math.max(0, o.mergePx);
  for (const a of o.inReach) {
    if (out.length >= Math.max(0, o.maxDots)) break;
    if (a === o.focus) continue; // the plaque is its cue
    const station = RAFT_STATIONS[a];
    if (station === undefined) continue;
    const world = stationAnchor(a, o.socketWorld, o.pieceNear);
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
  /**
   * §T.135 — `player.boardingAnchor`: the rail a SWIMMER can haul out at, in
   * world coordinates, or null. Optional so a harness with no water (the ship
   * preview) simply never shows it.
   */
  board?: () => Vec3 | null;
  /** LIVE socket resolver (§V71), the assembly's own */
  socketWorld: SocketResolver;
  /** §T.157 — `ShipAssembly.pieceNearestPoint`, so a plaque hangs on its object */
  pieceNear?: PieceResolver;
  /**
   * §T.155 — WHAT THE PLAQUE IS NAMING, and how far it has faded in. The raft
   * wiring turns this into the focused piece's outline glow, so the rim
   * arrives and leaves WITH the prompt instead of on a second timer that is
   * free to disagree with it (§V62). Called every update, including with
   * `null` when there is nothing to name.
   */
  onFocus?: (action: RaftAction | null, alpha: number) => void;
  /** the lens the frame was drawn through */
  camera: () => CameraLike | null;
  /**
   * §I ui/cinematic — photo mode and cinematic (full screen) both mean "the
   * frame is being captured": no overlay. Pass the view-mode state, do not
   * keep a second flag.
   */
  hidden?: () => boolean;
  /**
   * §T.156 — the live line a station wants on its plaque, or null. The raft
   * wiring supplies the radio's (frequency, signal, lock); everything else
   * answers null and reads exactly as it did.
   */
  status?: (action: RaftAction) => string | null;
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
  // §T.136 — the second line. It only ever carries what a HELD station needs
  // (the gesture, the live value and its bar, how to let go) or the "step
  // closer" of §T.136d, so an idle plaque is exactly the nameplate it was.
  const gesture = el('span', 'smt-prompt-gesture', '');
  const readout = el('span', 'smt-prompt-readout', '');
  // §T.156 — the station's own line (the radio's frequency and lock)
  const status = el('span', 'smt-prompt-status', '');
  const fill = div('smt-prompt-fill');
  const bar = div('smt-prompt-bar', fill);
  const release = el('span', 'smt-prompt-release', '');
  const far = el('span', 'smt-prompt-far', 'step closer');
  const line1 = div('smt-prompt-line', key, name, verb);
  const line2 = div('smt-prompt-line smt-prompt-how', gesture, bar, readout, release, far);
  const line3 = div('smt-prompt-line smt-prompt-how', status);
  const plaque = div('smt-prompt', line1, line2, line3);
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
      const dark = hidden || camera === null;
      const input: PromptInput = {
        focus: dark ? null : o.interact.focus(),
        held: dark ? null : o.interact.held(),
        outOfReach: dark ? null : o.interact.outOfReach(),
        board: dark ? null : o.board?.() ?? null,
        value: (a) => o.interact.value(a),
        statusOf: o.status,
        hidden: dark,
        socketWorld: o.socketWorld,
        pieceNear: o.pieceNear,
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
        key.textContent = next.key ?? '';
        key.style.display = next.key === null ? 'none' : '';
        name.style.display = next.name === '' ? 'none' : '';
        verb.style.display = next.verb === null ? 'none' : '';
        // §T.136 second line — every part hidden unless this state carries it,
        // so `display` and the state agree and nothing lingers from a previous
        // station (a stale readout under a new nameplate is a lie about which
        // lever the number belongs to)
        gesture.textContent = next.gesture ?? '';
        gesture.style.display = next.gesture === null ? 'none' : '';
        readout.textContent = next.readout ?? '';
        readout.style.display = next.readout === null ? 'none' : '';
        release.textContent = next.release ?? '';
        release.style.display = next.release === null ? 'none' : '';
        far.style.display = next.outOfReach ? '' : 'none';
        status.textContent = next.status ?? '';
        line3.style.display = next.status === null || next.status === '' ? 'none' : '';
        bar.style.display = next.bar === null ? 'none' : '';
        if (next.bar !== null) {
          fill.style.left = `${(next.bar.from * 100).toFixed(2)}%`;
          fill.style.width = `${Math.max(0, (next.bar.to - next.bar.from) * 100).toFixed(2)}%`;
        }
        line2.style.display =
          next.gesture === null && next.readout === null && next.release === null && !next.outOfReach
            ? 'none'
            : '';
        // the plaque floats above the socket, pointing down at it
        place(plaque, next.x, next.y - p.promptRisePx, 'translate(-50%, -100%)');
      } else {
        shown = null;
      }
      alpha = stepFade(alpha, next === null ? 0 : 1, dt, p.promptFade, reduced);
      // §T.155: the outline follows the plaque — same action, same fade
      o.onFocus?.(next === null || next.action === 'climb-aboard' ? null : next.action, alpha);
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
