/**
 * C3's dolphin (drift-narrative/wandering-on/direction.md: "a dolphin surfaces beside the raft, circles, and flips
 * something onto the deck with its snout"). At last light it is seen as a dark outline against the afterglow, so
 * what matters is the outline and the motion (the user, 2026-10-27: "shape and movement … only the outline really
 * visible; motion curves and the speed / timing" over geometry at close range). No model: the v9 stand-in was a
 * spindle that hopped in sine bumps at 1.3 m/s, a blob.
 *
 * THE OUTLINE: a bottlenose's proportions, 2.6 m: a short beak, the melon rising steeply behind it, the body
 * deepest a third of the way back, a falcate dorsal fin (swept, its trailing edge concave), pectoral flippers
 * angled back and down, the tail stock narrowing and laterally compressed, crescent flukes with a notch.
 * Counter-shaded: dark above, pale below.
 *
 * THE MOTION, as a dolphin travels near the surface: it swims at 3–6 m/s about a metre down (out of sight at
 * last light) and comes up in three ways — a ROLL (the back and fin roll out and under, the blow), a LEAP
 * (ballistic: out at the speed and angle that clear the water by `h`, its body along its path, arched to the
 * arc's curvature), and the FLIP (a steep, slow lunge, head high, at the raft). Under water its tail beats; in
 * the air it does not. A pure function of the time into c3; positions in the eye's level frame.
 */
import * as THREE from 'three/webgpu';
import { float, mix, positionLocal, sin, smoothstep, uniform, vec3 } from 'three/tsl';

/** m/s² */
const G = 9.81;
/** m: the body's centre while it swims between surfacings, under the water */
const DEPTH = 1.3;
/** m: the body's centre at the top of a roll (the back and the fin out) */
const ROLL_TOP = -0.2;
/** s a roll takes, from going up to going down again (at ~3.5 m/s its nose rises ~24°: a dolphin's roll) */
const ROLL = 2.2;
/** Hz the tail beats at under water, m it swings at the flukes */
const BEAT = 2.2;
const BEAT_AMP = 0.08;

export type SurfacingKind = 'roll' | 'leap' | 'flip';
/** s into c3 (a roll: its top; a leap or the flip: where it leaves the water), m right of the eye and m ahead
 * of it (its level frame), how it comes up, and m a leap's centre clears the water by */
export type Surfacing = [number, number, number, SurfacingKind, number?];

/**
 * Porpoising in from far out on the left on a diagonal that crosses the Sun's line (c3's Sun sets ~24° left: a
 * dark body only reads against the afterglow, so the high breach is on that line, 20 m out), past the raft's
 * port side close by us (the raft lies ahead, ~10° right at 10 m, bow ahead), a loop out, the flip at the
 * raft's sunward end (its bow, ahead left), and away the way it came. Spaced for ~3.5–4 m/s, a dolphin's
 * cruise; slower into the flip.
 */
export const SURFACINGS: Surfacing[] = [
  [1.5, -45, 38, 'roll'],
  [4.0, -36.4, 32.8, 'roll'],
  [6.5, -27.8, 27.6, 'leap', 0.8],
  [9.0, -19.2, 22.4, 'leap', 1.4],
  [11.5, -10.6, 17.2, 'leap', 2.1],
  [14.4, -2, 12, 'roll'],
  [17.0, -6.5, 4, 'roll'],
  [19.8, -13, 9, 'roll'],
  [22.6, -9, 17, 'leap', 1.0],
  [25.6, -1.8, 16, 'flip', 1.3],
  [29.2, -10, 22, 'roll'],
  [32.0, -19, 27, 'leap', 0.9],
  [34.8, -28, 32, 'roll'],
];
/** s it swims on after the last surfacing (out of sight) */
const AWAY = 3.5;

export interface DolphinPose {
  /** m, eye frame: x right, y up (the sea's 0), z ahead */
  x: number;
  y: number;
  z: number;
  /** rad: its heading (0: along +z, ahead; positive: turning right), and its nose up */
  heading: number;
  pitch: number;
  /** 1/m: the body's arch along its length (positive: nose and tail down), the tail beat's swing (m), its phase */
  bend: number;
  beat: number;
  phase: number;
  /** m/s along the water */
  speed: number;
}

/** the path over the water: a Catmull-Rom through the surfacings (and a lead-in and a lead-out along their line) */
function track(t: number): { x: number; z: number; vx: number; vz: number } {
  const k = SURFACINGS.map(([at, x, z]) => [at, x, z] as [number, number, number]);
  const first = k[0];
  const second = k[1];
  const last = k[k.length - 1];
  const prev = k[k.length - 2];
  const lead: [number, number, number] = [first[0] - 3, first[1] * 2 - second[1], first[2] * 2 - second[2]];
  const out: [number, number, number] = [last[0] + AWAY, last[1] * 2 - prev[1], last[2] * 2 - prev[2]];
  const keys = [lead, ...k, out];
  let i = 0;
  while (i < keys.length - 2 && t > keys[i + 1][0]) i++;
  const p0 = keys[Math.max(0, i - 1)];
  const p1 = keys[i];
  const p2 = keys[i + 1];
  const p3 = keys[Math.min(keys.length - 1, i + 2)];
  const h = p2[0] - p1[0];
  const u = Math.min(1, Math.max(0, (t - p1[0]) / h));
  // (non-uniform Catmull-Rom: tangents from the neighbours' slopes in time, so the speed is continuous)
  const tan = (a: [number, number, number], b: [number, number, number], c: [number, number, number], j: 1 | 2) =>
    ((b[j] - a[j]) / Math.max(1e-6, b[0] - a[0]) + (c[j] - b[j]) / Math.max(1e-6, c[0] - b[0])) / 2;
  const m1 = [tan(p0, p1, p2, 1), tan(p0, p1, p2, 2)];
  const m2 = [tan(p1, p2, p3, 1), tan(p1, p2, p3, 2)];
  const h00 = 2 * u ** 3 - 3 * u ** 2 + 1;
  const h10 = u ** 3 - 2 * u ** 2 + u;
  const h01 = -2 * u ** 3 + 3 * u ** 2;
  const h11 = u ** 3 - u ** 2;
  const d00 = (6 * u ** 2 - 6 * u) / h;
  const d10 = 3 * u ** 2 - 4 * u + 1;
  const d01 = (-6 * u ** 2 + 6 * u) / h;
  const d11 = 3 * u ** 2 - 2 * u;
  return {
    x: h00 * p1[1] + h10 * h * m1[0] + h01 * p2[1] + h11 * h * m2[0],
    z: h00 * p1[2] + h10 * h * m1[1] + h01 * p2[2] + h11 * h * m2[1],
    vx: d00 * p1[1] + d10 * m1[0] + d01 * p2[1] + d11 * m2[0],
    vz: d00 * p1[2] + d10 * m1[1] + d01 * p2[2] + d11 * m2[1],
  };
}

/** the body's centre height, and its first and second derivatives, at t */
function rise(t: number): [number, number, number] {
  for (const [at, , , kind, h = 0] of SURFACINGS) {
    if (kind === 'roll') {
      const s = t - (at - ROLL / 2);
      if (s < 0 || s > ROLL) continue;
      // −D + A sin²(πs/R): up and over and down, level at both ends
      const A = DEPTH + ROLL_TOP;
      const w = (2 * Math.PI) / ROLL;
      return [-DEPTH + (A * (1 - Math.cos(w * s))) / 2, (A * w * Math.sin(w * s)) / 2, (A * w * w * Math.cos(w * s)) / 2];
    }
    // a leap: up from the depth at a steady pull, out at vy0, ballistic, back in and levelled off, mirrored
    const vy0 = Math.sqrt(2 * G * h);
    const air = (2 * vy0) / G;
    const pull = (2 * DEPTH) / vy0;
    const s = t - at;
    if (s < -pull || s > air + pull) continue;
    if (s < 0) {
      const a = vy0 / pull;
      const q = s + pull;
      return [-DEPTH + (a * q * q) / 2, a * q, a];
    }
    if (s <= air) return [vy0 * s - (G * s * s) / 2, vy0 - G * s, -G];
    const a = vy0 / pull;
    const q = s - air;
    return [-vy0 * q + (a * q * q) / 2, -vy0 + a * q, a];
  }
  return [-DEPTH, 0, 0];
}

/** the time window it is drawn in (s into c3): from its first approach to well after its last dive */
export const DOLPHIN_SPAN: [number, number] = [SURFACINGS[0][0] - 3, SURFACINGS[SURFACINGS.length - 1][0] + AWAY];

/** the flip: s into c3 it is at its height (where the case leaves its snout) */
export const FLIP_TOP = (() => {
  const f = SURFACINGS.find((x) => x[3] === 'flip')!;
  return f[0] + Math.sqrt(2 * G * (f[4] ?? 0)) / G;
})();

export function dolphinPose(t: number): DolphinPose {
  const p = track(t);
  const [y, vy, ay] = rise(t);
  const vh = Math.max(0.3, Math.hypot(p.vx, p.vz));
  const v = Math.hypot(vh, vy);
  // the path's curvature in its vertical plane (vh steady along it): the body lies along the arc
  const bend = Math.max(-0.5, Math.min(0.5, (-vh * ay) / (v * v * v)));
  // the tail beats under water, stills as the body leaves it
  const wet = 1 - smoothstep01((y + 0.6) / 0.5);
  return { x: p.x, y, z: p.z, heading: Math.atan2(p.vx, p.vz), pitch: Math.atan2(vy, vh), bend, beat: BEAT_AMP * wet, phase: 2 * Math.PI * BEAT * t, speed: vh };
}

function smoothstep01(x: number): number {
  const k = Math.min(1, Math.max(0, x));
  return k * k * (3 - 2 * k);
}

// ------------------------------------------------------------------ the outline

/** m: the body's length; its stations from the beak (0) to the flukes' notch (1): the back's and the belly's
 * height over the body's axis, and the half-width (side and plan views of a bottlenose) */
const LENGTH = 2.6;
const STATIONS: Array<[number, number, number, number]> = [
  [0.0, 0.0, -0.01, 0.005],
  [0.02, 0.03, -0.03, 0.03],
  [0.06, 0.05, -0.05, 0.05],
  [0.1, 0.06, -0.06, 0.06],
  [0.13, 0.12, -0.1, 0.1],
  [0.17, 0.19, -0.15, 0.15],
  [0.22, 0.24, -0.2, 0.2],
  [0.3, 0.29, -0.25, 0.25],
  [0.4, 0.32, -0.28, 0.27],
  [0.5, 0.31, -0.27, 0.25],
  [0.6, 0.27, -0.23, 0.2],
  [0.7, 0.21, -0.17, 0.14],
  [0.8, 0.14, -0.11, 0.08],
  [0.88, 0.09, -0.07, 0.05],
  [0.94, 0.06, -0.05, 0.04],
  [0.97, 0.04, -0.03, 0.03],
  [1.0, 0.02, -0.01, 0.015],
];

/** body-frame z (the beak at −LENGTH/2, along −z) of station s */
const zAt = (s: number): number => -LENGTH / 2 + LENGTH * s;

function profile(s: number): [number, number, number] {
  let i = 0;
  while (i < STATIONS.length - 2 && s > STATIONS[i + 1][0]) i++;
  const a = STATIONS[i];
  const b = STATIONS[i + 1];
  const u = smoothstep01((s - a[0]) / (b[0] - a[0]));
  return [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u];
}

function bodyGeometry(): THREE.BufferGeometry {
  const RINGS = 48;
  const AROUND = 24;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= RINGS; i++) {
    const s = i / RINGS;
    const [top, bot, hw] = profile(s);
    const yc = (top + bot) / 2;
    const hh = (top - bot) / 2;
    for (let j = 0; j < AROUND; j++) {
      const a = (j / AROUND) * Math.PI * 2;
      // a superellipse a little fuller than an ellipse (a dolphin's flanks are flat-ish, not round)
      const c = Math.cos(a);
      const sn = Math.sin(a);
      const e = 0.85;
      pos.push(Math.sign(c) * Math.abs(c) ** e * hw, yc + Math.sign(sn) * Math.abs(sn) ** e * hh, zAt(s));
    }
  }
  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < AROUND; j++) {
      const a = i * AROUND + j;
      const b = i * AROUND + ((j + 1) % AROUND);
      idx.push(a, a + AROUND, b, b, a + AROUND, b + AROUND);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** a fin from its outline (x, y in its own plane), `thick` m thick, placed by `m` */
function fin(outline: Array<[number, number]>, thick: number, m: THREE.Matrix4): THREE.BufferGeometry {
  const sh = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(sh, { depth: thick, bevelEnabled: true, bevelThickness: thick * 0.4, bevelSize: thick * 0.4, bevelSegments: 2, curveSegments: 6 });
  g.translate(0, 0, -thick / 2);
  g.applyMatrix4(m);
  return g;
}

/** a smooth outline through control points (a closed Catmull-Rom, sampled) */
function smoothOutline(pts: Array<[number, number]>, n = 10): Array<[number, number]> {
  const c = new THREE.SplineCurve(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  return c.getPoints(pts.length * n).map((p) => [p.x, p.y]);
}

export interface Dolphin {
  readonly group: THREE.Group;
  set(p: DolphinPose): void;
}

export function createDolphin(): Dolphin {
  const uBend = uniform(0);
  const uBeat = uniform(0);
  const uPhase = uniform(0);
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.32, metalness: 0 });
  // counter-shaded: the back dark slate, the belly pale
  mat.colorNode = mix(vec3(0.62, 0.64, 0.64), vec3(0.2, 0.23, 0.26), smoothstep(-0.12, 0.1, positionLocal.y));
  // the arch (nose and tail toward the arc's centre) and, under water, the tail's beat, a wave running to the
  // flukes, growing toward them
  const z = positionLocal.z;
  const tail = smoothstep(-0.2, LENGTH / 2, z);
  const dy = uBend.mul(z.mul(z)).mul(-0.5).add(uBeat.mul(tail.mul(tail)).mul(sin(uPhase.sub(z.mul(2.2)))));
  mat.positionNode = positionLocal.add(vec3(float(0), dy, float(0)));

  const parts: THREE.BufferGeometry[] = [bodyGeometry()];
  // the dorsal fin: falcate, on the back from 0.42 to 0.60 of the length, its tip swept back past its base
  const s0 = zAt(0.42);
  const back = profile(0.5)[0];
  const rotFin = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), new THREE.Vector3(-1, 0, 0));
  parts.push(fin(smoothOutline([[0, -0.03], [0.06, 0.12], [0.2, 0.24], [0.4, 0.29], [0.36, 0.2], [0.38, 0.08], [0.48, -0.03]], 8), 0.035, new THREE.Matrix4().makeTranslation(0, back - 0.035, s0).multiply(rotFin)));
  // the pectorals: paddles from the flanks a quarter back, angled back and down
  for (const side of [-1, 1]) {
    const span = new THREE.Vector3(side * 0.75, -0.55, 0.45).normalize();
    const chord = new THREE.Vector3(0, -0.15, 1).normalize();
    const normal = new THREE.Vector3().crossVectors(span, chord).normalize();
    chord.crossVectors(normal, span).normalize();
    const m = new THREE.Matrix4().makeBasis(span, chord, normal).setPosition(side * 0.16, -0.12, zAt(0.26));
    parts.push(fin(smoothOutline([[0, -0.02], [0.18, 0.0], [0.34, 0.04], [0.38, 0.09], [0.3, 0.12], [0.14, 0.14], [0, 0.15]], 6), 0.025, m));
  }
  // the flukes: a crescent, its tips swept back, a notch in the middle of its trailing edge
  const rotFluke = new THREE.Matrix4().makeBasis(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, -1, 0));
  parts.push(fin(smoothOutline([[0, -0.02], [0.16, 0.02], [0.3, 0.13], [0.33, 0.22], [0.22, 0.16], [0.08, 0.15], [0, 0.12], [-0.08, 0.15], [-0.22, 0.16], [-0.33, 0.22], [-0.3, 0.13], [-0.16, 0.02]], 6), 0.03, new THREE.Matrix4().makeTranslation(0, 0.0, zAt(0.95)).multiply(rotFluke)));

  const group = new THREE.Group();
  for (const g of parts) {
    const mesh = new THREE.Mesh(g, mat);
    mesh.castShadow = true;
    // (the vertex shader bends it: its bounds are no longer the geometry's)
    mesh.frustumCulled = false;
    group.add(mesh);
  }
  return {
    group,
    set(p) {
      uBend.value = p.bend;
      uBeat.value = p.beat;
      uPhase.value = p.phase;
    },
  };
}
