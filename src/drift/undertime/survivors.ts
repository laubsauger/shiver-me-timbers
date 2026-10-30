/**
 * THE SURVIVORS — what the light wave leaves: the one-in-a-billion, made visible as visibly FEW.
 *
 * The 2026-10-30 story note: "The whole story arc — the big explosion of things that ultimately leaves only the
 * small particles, the small portion, the ONE BILLIONTH — is not fully clear yet." Until now the front wiped the dome
 * and, seconds later in the dark, a grain simply appeared. Now the front LEAVES them, and the audience sees it do so:
 * as it sweeps, nearly everything it touches turns to light and is spent (waveFx.ts spent), but here and there a
 * matter bead it catches does not find its partner — it runs on out of the front's light, curls down as it loses its
 * energy, and comes to rest: a warm grain on a dark dome. A few of them across the sky (`survivors`, 16), and one in
 * front and up, where the first light was: the HERO GRAIN (direction.md: "one near pair gets away … its matter track
 * keeps going — the only moving line on the dome — and curls down onto that spot").
 *
 * Each survivor's run is a product track of its own family (productModel.ts SURVIVOR: drawn by products.ts, exempt
 * from the front's freezing and spending); its grain, once it rests, is drawn here. In the remain beat the others dim
 * a little so the hero grain is the one in focus, and through the pull-back they are carried into it with the rest
 * of the remainder (scaled about the hero grain, as grains.ts does).
 *
 * The choice is made once on the CPU from the act's events: pairs the front cut short, their matter bead where the
 * front caught it, spread evenly over the visible sky (farthest-point picking on their directions), seeded.
 */
import * as THREE from 'three/webgpu';
import { Fn, attribute, cameraPosition, exp, float, max, sin, smoothstep, step, uv, vec4 } from 'three/tsl';
import type { DriftParams } from '../../params/drift';
import { domeBasis, type Vec3 } from '../../cine/domeMaster';
import { loopPoint, type PairEvent } from './events';
import { SURVIVOR, trackPoint, type ProductTrack } from './productModel';
import { HERO_RUN, beatStarts, eyePath, heroGrainPosition, heroPassTime } from './timeline';
import { billboardMesh, eyeFacing } from './billboard';
import { glowWindow } from './glow';
import { rng } from './web';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

export interface SurvivorRest {
  /** world point it comes to rest at */
  rest: Vec3;
  /** act s it comes to rest */
  at: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** the share of its run after which a survivor's grain is up (its bead has all but stopped: productEase) */
const SETTLE = 0.8;

/** a run that spirals down to rest: radius `R` m shrinking to 8 % as it turns (energy loss), decelerating to a stop */
function run(t0: number, start: Vec3, dir: Vec3, normal: Vec3, R: number, curl: number, life: number, energy: number): ProductTrack {
  const along = dot(dir, normal);
  const d = norm(sub(dir, [normal[0] * along, normal[1] * along, normal[2] * along]));
  return {
    t0, life, start, dir: d, normal, radius: R, curl, turn: -Math.log(0.08) / curl, pitch: 0, q: 1, family: SURVIVOR, shade: 0.3, energy, flash: 0, end: 1,
  };
}

/**
 * The survivors of `events` (the act's pairs after the wave has cut them, field.ts): `count` of the pairs the front
 * caught, spread over the visible sky, plus the hero's run onto the hero grain. Returns their runs (for products.ts)
 * and their resting grains (the hero's not among them: grains.ts draws it).
 */
export function pickSurvivors(events: readonly PairEvent[], p: DriftParams, count: number, keep: (at: Vec3) => boolean = () => true, seed = 6767): { tracks: ProductTrack[]; rests: SurvivorRest[] } {
  const { starts } = beatStarts(p);
  const r = rng(seed);
  const eye = eyePath(starts.wave, p);
  const b = domeBasis(p.domeTilt);
  const hero = heroGrainPosition(p);
  const heroDir = norm(sub(hero, eye));
  // candidates: pairs the front caught alive (their `end` cut short), born before it, their matter bead there at a
  // readable distance and above the dome's spring line, and not right beside the hero grain (it stands alone)
  const cands = events
    .filter((e) => e.end < 1 && e.birth < starts.wave + p.wave)
    .map((e) => {
      const at = loopPoint(e, 1, e.end);
      const v = sub(at, eye);
      const d = Math.hypot(...v);
      return { e, at, d, dir: norm(v) };
    })
    .filter((c) => c.d > 4 && c.d < 26 && dot(c.dir, b.axis) > 0.08 && dot(c.dir, heroDir) < Math.cos((12 * Math.PI) / 180) && keep(c.at));
  // farthest-point picking on the sphere of directions: an even scatter, not a clump
  const picked: typeof cands = [];
  const pool = [...cands];
  if (pool.length) picked.push(...pool.splice(Math.floor(r() * pool.length), 1));
  // (and never two within 8° of each other or of the hero grain: fewer, rather than a pair that reads as one blot)
  const apart = Math.cos((8 * Math.PI) / 180);
  while (picked.length < count && pool.length) {
    let best = -1;
    let bestScore = -Infinity;
    pool.forEach((c, i) => {
      const near = Math.max(...picked.map((q) => dot(q.dir, c.dir)), dot(heroDir, c.dir));
      if (near > apart) return;
      if (-near > bestScore) [bestScore, best] = [-near, i];
    });
    if (best < 0) break;
    picked.push(...pool.splice(best, 1));
  }
  const tracks: ProductTrack[] = [];
  const rests: SurvivorRest[] = [];
  for (const c of picked) {
    const e = c.e;
    const t0 = e.birth + e.loop * e.end;
    const tan = norm(sub(loopPoint(e, 1, Math.min(1, e.end + 0.002)), loopPoint(e, 1, Math.max(0, e.end - 0.002))));
    const T = run(t0, c.at, tan, norm(cross(e.axis, e.across)), 0.35 + 0.5 * r(), 0.55 + 0.35 * r(), 1.5 + 0.7 * r(), 1);
    tracks.push(T);
    rests.push({ rest: trackPoint(T, 1), at: t0 + T.life * SETTLE });
  }
  // THE HERO: its run starts as the front passes the spot and ends ON the hero grain — built at the origin, then
  // moved so its end is the grain. Face-on to the audience, leaving downward across the view, curling as it slows
  const view = heroDir;
  const downAcross = norm(sub([-b.axis[0], -b.axis[1], -b.axis[2]], [view[0] * -dot(b.axis, view), view[1] * -dot(b.axis, view), view[2] * -dot(b.axis, view)]));
  const H = run(heroPassTime(p), [0, 0, 0], downAcross, view, 1.1, 0.5, HERO_RUN, 1);
  const end = trackPoint(H, 1);
  H.start = sub(hero, end);
  tracks.push(H);
  return { tracks, rests };
}

export interface SurvivorUniforms {
  time: F;
  eye: V3;
  pixelAngle: F;
  /** world position of the hero grain now (the zoom's pivot), and the world's scale about it (timeline `scale`) */
  pivot: V3;
  scale: F;
  /** 0..1 how far the others have stepped back so the hero grain is the one in focus (the remain beat) */
  focus: F;
  /** their colour, and linear radiance */
  warm: V3;
  radiance: F;
}

/**
 * The resting grains: points of light, a core in a small windowed halo (glow.ts), each with its own slow breath;
 * up as its bead settles, scaled about the hero grain with the pull-back (and gone as the remainder is gathered
 * into it, as grains.ts's are), dimmer once the hero grain is singled out.
 */
export function createSurvivorGrains(rests: readonly SurvivorRest[], heroAt: Vec3, U: SurvivorUniforms): THREE.InstancedMesh {
  const n = Math.max(1, rests.length);
  const A = new Float32Array(n * 4);
  rests.forEach((s, i) => A.set([...sub(s.rest, heroAt), s.at], i * 4));
  const a = attribute<'vec4'>('survivorRest', 'vec4');
  const i = float(attribute<'float'>('survivorSeed', 'float'));
  const pos = U.pivot.add(a.xyz.mul(U.scale));
  const dist = pos.sub(cameraPosition).length();
  const up = smoothstep(a.w.sub(0.35), a.w.add(0.25), U.time);
  const breath = sin(U.time.mul(2 * Math.PI * 0.17).add(i.mul(2.3))).mul(0.12).add(1);
  const gathered = smoothstep(0.08, 0.35, U.scale);
  // as it comes to rest it catches the eye: a glint that settles (the moment it survived)
  const since = U.time.sub(a.w);
  const arrive = float(1).add(exp(since.max(0).div(0.5).negate()).mul(1.5).mul(step(0, since)));
  const bright = up.mul(breath).mul(arrive).mul(gathered).mul(float(1).sub(U.focus.mul(0.5)));
  // a point of light ~0.35° across (at ~0.25° they were lost on the dark dome at the 16:9 cut's width, 2026-10-30
  // story pass), never under ~1.5 px; what it is widened by is paid back in brightness
  const wanted = dist.mul(0.0062);
  const drawn = max(wanted, U.pixelAngle.mul(1.5).mul(dist));
  const k = wanted.div(drawn);
  const alpha = bright.mul(k.mul(k));
  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.AdditiveBlending;
  // the quad four times the grain: the core (1/e at a quarter of the quad's half-width — half the grain) and a halo
  // out to its edge, windowed to zero there (glow.ts)
  material.positionNode = eyeFacing(pos, drawn.mul(4).mul(step(0.0005, alpha)));
  material.colorNode = Fn(() => {
    const p = uv().sub(0.5).mul(2);
    const r2 = p.dot(p);
    const light = exp(r2.mul(16).negate()).mul(3).add(exp(r2.mul(4).negate()).mul(0.3).mul(glowWindow(r2)));
    return vec4(U.warm.mul(U.radiance).mul(alpha).mul(light), 1);
  })();
  material.name = 'undertime-survivor-grains';
  const mesh = billboardMesh(material, n, 'undertime-survivor-grains');
  mesh.count = rests.length;
  mesh.geometry.setAttribute('survivorRest', new THREE.InstancedBufferAttribute(A, 4));
  mesh.geometry.setAttribute('survivorSeed', new THREE.InstancedBufferAttribute(Float32Array.from({ length: n }, (_, k) => k * 1.37), 1));
  return mesh;
}
