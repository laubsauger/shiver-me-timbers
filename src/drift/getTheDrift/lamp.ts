/**
 * LIGHTS OUT'S LAMP: the one light that stays on (the 2026-11-02 next-level review, move 2, "the flood as Act 1's
 * wave"; params lightsOut). Act 1 says a billion were lost and one grain remained; Act 2 rhymes it — the flood's front
 * crosses the night side, every city goes out behind it (lifeLayers.ts floodFront), and in the 4–5 s of near-black in
 * the score's dip one warm point is still lit, blinking slowly, low in front: a surviving rafter's lamp. It is the setup
 * Act 3 pays off (move 1: the raft calls and a lamp ahead answers).
 *
 * WHERE: a fixed place on the planet, not a moving light — a light that travels over the ground seen from orbit reads
 * as a UFO (the review, section 6). The camera's path is the approved one (timeline.ts, commit 367627d: the dive holds
 * ~−27° onto the ground from 241 s and pulls up from 282 s); the lamp is placed WITH it: on the drowned Po delta
 * (params loLampLat/loLampLon, 45.03° N 12.30° E), ~30 km beyond the debris spiral's centre on the descent's heading.
 * Measured on that path (the scratch harness of the review): straight ahead (az 0 ± 0.1°) the whole way, at 20.0° up the
 * dome through the overshoot, the front and the black (225–245 s: just inside the limb, "one warm lamp is still blinking
 * near the limb"), rising slowly to 26° by 265 s, 22° at the landing's start and 26° again at 300 s, 20° at the sea's
 * hand-over — the review's 15–25° band, never more than 1° outside it, and nowhere does it slide. Candidates nearer the
 * spiral sank to 19° at 285 s; farther east (13.2–14° E) they climbed to 33–35° at 290 s, and off the heading (45.2° N)
 * they swung 12° to the left as the eye came down.
 *
 * WHAT: a pinpoint, as the planet's glint is (earth.ts): STAR_SIGMA's light drawn LAMP_PX pixels wide on any master, so
 * its light is the same at 1024² and at 4096² and only its sharpness changes (the 2026-11-02 brief: point lights change
 * with resolution — checked at 4096²). Warm (a lamp's, not the cities' sodium or the overshoot's LED), seen through the
 * air toward the eye — softened (LAMP_AIR), or near the limb at 240 s it would be all but gone into the long path.
 *
 * WHEN (lampState, a pure function of t): it comes up unnoticed among the cities in the overshoot, steady; the front
 * passes it first (it is near the limb, where the water comes from) and from there it blinks, slowly (loBlink, 3.2 s:
 * ~0.3 Hz, a soft rise and a slower fall, never off — no strobe on a dome); it dims as the day comes to it (it stays a
 * point in the low light, at a third) and is gone by the sea's hand-over (the sea's scene does not draw it).
 */
import * as THREE from 'three/webgpu';
import { Fn, cameraPosition, exp, float, length, normalize, step, uniform, uv, vec3, vec4 } from 'three/tsl';
import { billboardMesh, eyeFacing } from '../undertime/billboard';
import { EARTH_R, towardEye } from './atmosphere';
import { STAR_SIGMA } from './milkyWay';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

/** px: the lamp's drawn width (σ), as the planet's glint (0.64 px) */
const LAMP_PX = 0.64;
/** the lamp's peak radiance at STAR_SIGMA (linear; its light π·STAR_SIGMA²·this at any width): a bright city core's
 * radiance is ~6 (lifeLayers.ts nightLights), and the lamp is one point of it, held clear of the stars */
export const LAMP_PEAK = 40;
/** (r, g, b): warm, a flame's or a warm LED's, redder than the cities' sodium */
const LAMP_TINT: [number, number, number] = [1, 0.58, 0.26];
/** the air's transmittance to the eye is taken to this power: the lamp keeps its warmth's reddening, not its loss */
const LAMP_AIR = 0.35;
/** quad half-width in σ */
const QUAD_SIGMAS = 4;

export interface LampState {
  /** 0..1 how bright, with the blink in it */
  gain: number;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const smooth = (x: number): number => {
  const k = clamp01(x);
  return k * k * (3 - 2 * k);
};

/**
 * The lamp's brightness at act time t. `from` act s it comes up (over 3 s), `passed` act s the flood's front has
 * passed it (the blink grows in over 2 s from there), `period` s a blink, `sunEl` deg the Sun stands over the lamp's
 * horizon now, `gone` act s it is out by (the sea's hand-over less a margin; over the 10 s before).
 */
export function lampState(t: number, o: { from: number; passed: number; period: number; sunEl: number; gone: number }): LampState {
  const on = smooth((t - o.from) / 3);
  // the blink: a soft rise over ~0.5 s, held, a slower fall over ~0.8 s, then dim — never off (0.25), ~0.3 Hz
  const ph = (((t - o.passed) / o.period) % 1 + 1) % 1;
  const pulse = smooth(ph / 0.16) * (1 - smooth((ph - 0.42) / 0.24));
  const blink = smooth((t - o.passed) / 2);
  const level = (1 - blink) * 0.7 + blink * (0.25 + 0.75 * pulse);
  // the day takes it to a third as the Sun comes up over it, and the hand-over takes the rest
  const day = 1 - 0.67 * smooth((o.sunEl + 1) / 6);
  const out = 1 - smooth((t - (o.gone - 10)) / 10);
  return { gain: on * level * day * out };
}

export interface Lamp {
  readonly mesh: THREE.InstancedMesh;
  /** world position of the lamp, the planet's centre (world), its gain (LampState), the master's pixel (rad) */
  update(at: THREE.Vector3, centre: THREE.Vector3, gain: number, pixelAngle: number): void;
  dispose(): void;
}

export function createLamp(): Lamp {
  const u = { at: uniform(new THREE.Vector3()), centre: uniform(new THREE.Vector3()), gain: uniform(0), pixelAngle: uniform(0.0015) };
  const at = u.at as unknown as V3;
  const C = u.centre as unknown as V3;
  const P = u.pixelAngle as unknown as F;
  const dist = length(at.sub(cameraPosition));
  const sigma = P.mul(LAMP_PX);
  const mat = new THREE.NodeMaterial();
  mat.transparent = true;
  mat.depthWrite = false;
  // (no depth test, as the glint: from hundreds of km the depth buffer cannot hold a point on the ground in front of
  // the ground's own faces; lampState's caller hides it behind the horizon)
  mat.depthTest = false;
  mat.side = THREE.DoubleSide;
  mat.blending = THREE.AdditiveBlending;
  mat.positionNode = eyeFacing(at, dist.mul(sigma).mul(QUAD_SIGMAS * 2).mul(step(1e-4, u.gain)));
  mat.colorNode = Fn(() => {
    const q = uv().sub(0.5).mul(2);
    const r = q.length().mul(sigma.mul(QUAD_SIGMAS)); // rad from the lamp
    const core = exp(r.div(sigma).pow(2).negate()).mul(float(STAR_SIGMA).div(sigma).pow(2)).mul(LAMP_PEAK);
    const toEye = normalize(cameraPosition.sub(at));
    const n = normalize(at.sub(C));
    const eyeUp = normalize(cameraPosition.sub(C));
    const T = towardEye(float(EARTH_R), n.dot(toEye).max(1e-3), length(cameraPosition.sub(C)), eyeUp.dot(toEye)).pow(LAMP_AIR);
    return vec4(vec3(...LAMP_TINT).mul(T).mul(core).mul(u.gain), 1);
  })();
  mat.name = 'drift-lights-out-lamp';
  const mesh = billboardMesh(mat, 1, 'drift-lights-out-lamp');
  mesh.renderOrder = 3;
  return {
    mesh,
    update(p, c, gain, pixelAngle) {
      u.at.value.copy(p);
      u.centre.value.copy(c);
      u.gain.value = gain;
      u.pixelAngle.value = pixelAngle;
      mesh.visible = gain > 1e-4;
    },
    dispose() {
      mesh.geometry.dispose();
      mat.dispose();
    },
  };
}
