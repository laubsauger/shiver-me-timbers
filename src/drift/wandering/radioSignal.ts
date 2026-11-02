/**
 * ONE SIGNAL IN FLIGHT — a single pulse of light running along one path across the sky, for the radio story's moments
 * that are not a link of the Rose (the 2026-11-02 next-level review, drift-narrative/next-level-2026-11-02.md):
 *
 *   our call (c4, move 1)     from the raft's masthead lamp out to the lamp ahead, twice; the first "ends in nothing"
 *   the stranger (w6, move 7) from the sea's horizon up to the one place, in Act 1's two colours: a pair braided about
 *                             its path, matter and antimatter, as Act 1's pairs loop about each other (loops.ts)
 *
 * It is drawn as the Rose's arcs are (props.ts THE ARCS AS LIGHT IN THE HAZE): a camera-facing ribbon carrying a thin
 * core where the pulse is, a short trail behind it and the haze's glow about both, added light that writes no depth,
 * depth-tested so whatever stands nearer hides it. Unlike them it is laid on the CPU every frame from a path the
 * caller hands it (props.ts arcPoint: the same straight chord in the dome's fisheye, with its lift) — one ribbon, ends
 * that move with the raft, and nothing kept between frames, so every frame is a pure function of t. Faced to the eye,
 * which is one point for all six faces of the dome's cube capture, so it runs on across their seams.
 *
 * Between messages the path is dark: a call that reaches nothing leaves nothing (the review: "It travels out and ends
 * in nothing: no flare, no reply").
 */
import * as THREE from 'three/webgpu';
import { Fn, exp, float, sin, step, uniform, uv, vec3, vec4 } from 'three/tsl';

/** segments along the ribbon; and those laid on past each end, along its tangent, over 3 σ of an end's glow — so a glow
 * at an end is round (the ribbon had stopped at its ends, and the stranger's arrival at the one place was a half-disc
 * with a straight edge: the second look, out/drift/review/radio-1102/r2 end_arrive_7650, a render glitch on a dome) */
const SEGMENTS = 160;
const EXT = 10;
/** deg: σ of the pulse's core and of the haze's glow about it, across the path (the Rose's: props.ts ARC core, halo) */
const WIDTH = { core: 0.07, halo: 0.5 };
/** the pulse in time (s): its head's σ, its trail's time constant and share, its afterglow's (haze only) — the Rose's
 * own (props.ts PULSE), so our call reads as the same kind of thing as the network's messages */
const PULSE = { head: 0.35, trail: 0.6, trailK: 0.35, long: 4, longK: 0.12 };
/** radiances (scene units, at the night's exposure): the core and the haze, as the Rose's (props.ts ARC_L) */
const L = { core: 0.035, halo: 0.01 };
/** deg: σ of the glow at an end (the stranger's arrival at the one place, its faint glow on the horizon before) */
const END_GLOW = 0.6;
/** deg along the path one turn of a pair's braid takes; and how far apart its two cores swing (σ of the haze) */
const BRAID = { turn: 5, apart: 0.7 };

type F = THREE.Node<'float'>;

export interface SignalLook {
  /** linear colours: the core (or the pair's two) and the haze about it */
  core: [number, number, number];
  pair?: [number, number, number];
  halo: [number, number, number];
}

export interface SignalState {
  /** m from the eye (the ribbon's group stands at the eye, unturned): the path at u 0 … 1 */
  path: (u: number) => THREE.Vector3;
  /** sea s now, the s the pulse leaves the path's start, and the s it takes to its end */
  t: number;
  t0: number;
  dur: number;
  /** × everything (the night, the beat's fade) */
  gain: number;
  /** a glow at the end (× END_GLOW's radiance, 0 none) and at the start */
  endGlow?: number;
  startGlow?: number;
}

export interface Signal {
  readonly mesh: THREE.Mesh;
  /** lay the ribbon on its path and set its pulse; hidden when `gain` is 0 */
  set(s: SignalState): void;
}

export function createSignal(look: SignalLook): Signal {
  const g = new THREE.BufferGeometry();
  const COUNT = SEGMENTS + 1 + 2 * EXT;
  const pos = new Float32Array(COUNT * 2 * 3);
  // (u along the path, 0 … 1 between its ends and beyond them on the extensions — laid every frame, as the path's
  // length sets how far in u the extensions reach; v across)
  const uvs = new Float32Array(COUNT * 2 * 2);
  const idx: number[] = [];
  for (let i = 0; i < COUNT - 1; i++) idx.push(2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2);
  const posAttr = new THREE.BufferAttribute(pos, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  const uvAttr = new THREE.BufferAttribute(uvs, 2);
  uvAttr.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('position', posAttr);
  g.setAttribute('uv', uvAttr);
  g.setIndex(idx);

  const time = uniform(0);
  const t0 = uniform(0);
  const dur = uniform(1);
  const gain = uniform(0);
  const endK = uniform(0);
  const startK = uniform(0);
  /** deg: the path's length as the eye sees it (for the braid and the end glows) */
  const arcLen = uniform(1);

  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthTest: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide });
  mat.colorNode = Fn(() => {
    const u = uv().x;
    // across the ribbon, in σ of the haze (the ribbon holds 3 σ each side)
    const across = uv().y.mul(2).sub(1).mul(3);
    const tau = time.sub(t0).sub(u.mul(dur));
    // (squares as products: WGSL's pow is undefined for a negative base)
    const h = tau.div(PULSE.head);
    const head = exp(h.mul(h).negate());
    const after = tau.max(0);
    const trail = step(0, tau).mul(exp(after.div(-PULSE.trail)).mul(PULSE.trailK));
    const long = step(0, tau).mul(exp(after.div(-PULSE.long)).mul(PULSE.longK));
    // (the pulse runs between the ends only: the extensions carry the ends' glows)
    const inside = step(0, u).mul(step(u, 1));
    const coreK = head.add(trail).mul(inside);
    const haloK = head.mul(0.8).add(trail.mul(0.5)).add(long).mul(inside);
    const ratio = WIDTH.halo / WIDTH.core;
    const profile = (off: F): F => {
      const x = across.sub(off).mul(ratio);
      return exp(x.mul(x).negate()) as F;
    };
    let core;
    if (look.pair) {
      // THE PAIR: two cores braided about the path, a turn every BRAID.turn degrees, half the light each
      const swing = sin(u.mul(arcLen).mul((2 * Math.PI) / BRAID.turn)).mul(BRAID.apart) as F;
      core = vec3(...look.core).mul(profile(swing)).add(vec3(...look.pair).mul(profile(swing.negate() as F))).mul(0.5);
    } else {
      core = vec3(...look.core).mul(profile(float(0) as F));
    }
    const halo = exp(across.mul(across).negate());
    // the ends' glows (along the path from the end, and across it, in degrees)
    const acrossDeg = across.mul(WIDTH.halo);
    const glowAt = (alongDeg: F): F => exp(alongDeg.mul(alongDeg).add(acrossDeg.mul(acrossDeg)).div(-(END_GLOW * END_GLOW))) as F;
    const ends = glowAt(float(1).sub(u).mul(arcLen) as F).mul(endK).add(glowAt(u.mul(arcLen) as F).mul(startK));
    const light = core
      .mul(coreK.mul(L.core))
      .add(vec3(...look.halo).mul(haloK.mul(halo).add(ends).mul(L.halo)));
    return vec4(light.mul(gain), 1);
  })();
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = 'drift-radio-signal';
  mesh.frustumCulled = false;
  mesh.visible = false;

  const P = Array.from({ length: COUNT }, () => new THREE.Vector3());
  const U = new Float32Array(COUNT);
  const side = new THREE.Vector3();
  const dP = new THREE.Vector3();
  const tan = new THREE.Vector3();
  /** P[at] turned on along the path's tangent there (from P[from] toward it) by `deg`, at P[at]'s distance */
  const onward = (out: THREE.Vector3, at: THREE.Vector3, from: THREE.Vector3, deg: number): THREE.Vector3 => {
    const n = at.clone().normalize();
    tan.subVectors(at, from);
    tan.addScaledVector(n, -tan.dot(n)).normalize();
    const a = (deg * Math.PI) / 180;
    return out.copy(n.multiplyScalar(Math.cos(a)).addScaledVector(tan, Math.sin(a))).multiplyScalar(at.length());
  };
  return {
    mesh,
    set(s) {
      mesh.visible = s.gain > 0;
      if (!mesh.visible) return;
      time.value = s.t;
      t0.value = s.t0;
      dur.value = s.dur;
      gain.value = s.gain;
      endK.value = s.endGlow ?? 0;
      startK.value = s.startGlow ?? 0;
      for (let i = 0; i <= SEGMENTS; i++) {
        P[EXT + i].copy(s.path(i / SEGMENTS));
        U[EXT + i] = i / SEGMENTS;
      }
      let deg = 0;
      for (let i = 1; i <= SEGMENTS; i++) deg += (P[EXT + i - 1].angleTo(P[EXT + i]) * 180) / Math.PI;
      arcLen.value = Math.max(deg, 1e-3);
      // the extensions, 3 σ of an end's glow past each end
      const first = EXT;
      const last = EXT + SEGMENTS;
      for (let k = 1; k <= EXT; k++) {
        const d = (3 * END_GLOW * k) / EXT;
        onward(P[first - k], P[first], P[first + 1], d);
        U[first - k] = -d / arcLen.value;
        onward(P[last + k], P[last], P[last - 1], d);
        U[last + k] = 1 + d / arcLen.value;
      }
      const half = (3 * WIDTH.halo * Math.PI) / 180;
      for (let i = 0; i < COUNT; i++) {
        uvs.set([U[i], 0, U[i], 1], i * 4);
        dP.subVectors(P[Math.min(COUNT - 1, i + 1)], P[Math.max(0, i - 1)]);
        // (the eye is the group's origin: the ribbon faces it, across the path)
        side.crossVectors(dP, P[i]).normalize().multiplyScalar(P[i].length() * half);
        pos.set([P[i].x - side.x, P[i].y - side.y, P[i].z - side.z, P[i].x + side.x, P[i].y + side.y, P[i].z + side.z], i * 6);
      }
      posAttr.needsUpdate = true;
      uvAttr.needsUpdate = true;
    },
  };
}
