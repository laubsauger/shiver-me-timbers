/**
 * LIGHTS OUT'S LAMP: the one light that stays on (the 2026-11-02 next-level review, move 2, "the flood as Act 1's
 * wave"; params lightsOut). Act 1 says a billion were lost and one grain remained; Act 2 rhymes it — the flood's front
 * crosses the night side, every city goes out behind it (lifeLayers.ts floodFront), and in the 4–5 s of near-black in
 * the score's dip one warm point is still lit, blinking slowly, low in front: a surviving rafter's lamp. It is the setup
 * Act 3 pays off (move 1: the raft calls and a lamp ahead answers).
 *
 * WHERE: a fixed place on the planet, not a moving light — a light that travels over the ground seen from orbit reads
 * as a UFO (the review, section 6). The camera's path is the approved one (timeline.ts, commit 367627d: the dive holds
 * ~−27° onto the ground from 241 s and pulls up from 282 s); the lamp is placed WITH it, on the drowned Po delta's new
 * sea (params loLampLat/loLampLon, 45.22° N 12.24° E), ~33 km from the raft and 40° LEFT of the landing's front as seen
 * from it: where c4's answering lamp is (wandering/props.ts STATIONS' −40°; the 2026-11-02 review, round 2: "move the
 * surviving lamp about 40° left, so it ties into Act 3" — straight ahead, where it was first put, is where our own raft
 * stands in c4). Measured on the path (tests/getTheDriftLightsOut.test.ts): through the overshoot, the front, the black
 * and the pre-dawn (225–263 s) it holds still (≤ 0.5°/s), 0.4–1.8° left of straight ahead, 20–26° up the dome just
 * inside the limb; from the Sun's rise on it swings out with the lit ground under it (≤ 1.7°/s, the ground's own
 * parallax as the eye comes down: −5° at 275 s, −15° at 285 s, −32° at 295 s) to −42° at the sea's hand-over, 18–20°
 * up, bearing −40° from the raft. A fixed place on the dome AT −40° all the way down is not to be had: until ~263 s the eye is 650–2000 km back
 * along the track and the planet is a cap whose limb, 40° left, is only 10–11° up the tilted dome (it reaches 15° at
 * ~254 s) — anything near the raft is within 2° of straight ahead from there, and a light 40° left in the black would
 * be on that far limb, 2000 km from the raft and under the horizon by the landing. So the lamp keeps the black's place
 * (still, low in front, where the first clip had it) and comes round to Act 3's bearing as the day shows the ground it
 * rides on: it moves only while there is ground to move with.
 *
 * WHAT: a pinpoint, as the planet's glint is (earth.ts): STAR_SIGMA's light drawn LAMP_PX pixels wide on any master, so
 * its light is the same at 1024² and at 4096² and only its sharpness changes (the 2026-11-02 brief: point lights change
 * with resolution — checked at 4096²). Warm (a lamp's, not the cities' sodium or the overshoot's LED), seen through the
 * air toward the eye — softened (LAMP_AIR), or near the limb at 240 s it would be all but gone into the long path. Its
 * light (LAMP_PEAK) is set against the stars, not the cities: in the black the lamp must be the one thing left, and on the
 * first clip it was not — at 4096² its light (the bloom about it included) was only 1.25× the brightest star's at a
 * blink's peak, and from row 8, where the planet is a thin cap and the lamp a few pixels, the stars outshone it.
 *
 * WHEN (lampState, a pure function of t): it comes up unnoticed among the cities in the overshoot, steady; the front
 * passes it first (it is near the limb, where the water comes from) and from there it blinks, slowly — ON THE SCORE
 * (the 2026-11-02 review, round 2: the 245–263 s pre-dawn was ~18 s of the lamp and the glow alone): each blink swells
 * with one of the soft pulses in the score's dip (LO_PULSES: 242.4, 245.3, 247.0, 249.2 s of the show, measured on
 * drift_audio.wav), then with the hit at 252.3 s that starts the dawn's glow (params loDawnAt; timeline.ts sunDay), and
 * on from there every loBlink s (3.2 s: ~0.3 Hz), as it blinked every loBlink s before the first pulse. A blink is a
 * soft swell over PULSE_RISE s about the note, held, and a slower fall over PULSE_FALL s to a glow that never goes out
 * (LAMP_LOW) — no strobe on a dome, however close two pulses come (1.7 s at the closest). It dims as the day comes to it
 * (it stays a point in the low light, at a third) and is gone by the sea's hand-over (the sea's scene does not draw it).
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
 * radiance is ~6 (lifeLayers.ts nightLights), and the lamp is one point of it, held clear of the stars. 40 on the first
 * clip was, at a blink's peak, only level with the brightest stars (see WHAT). At 120, measured at 4096² (242.9 s, 244.7
 * s; the light over the background in a 61-px window, the bloom's halo included, from the 8-bit frame, so its own core
 * clipped): 2.4× the brightest star's at a blink's top and 1.4× at its lowest (LAMP_LOW) — the brightest thing on the
 * dome through the black — and still a point: a white core 2–3 px across in a soft warm halo ~10 px in radius over
 * half-white (~0.45°), no rays, no flare */
export const LAMP_PEAK = 120;
/** 0..1 the blink's low: the lamp's glow between pulses (never off) */
const LAMP_LOW = 0.3;
/** s: a blink's swell (from PULSE_LEAD before the note), its hold at the top, and its fall to LAMP_LOW */
const PULSE_LEAD = 0.2;
const PULSE_RISE = 0.6;
const PULSE_HOLD = 0.3;
const PULSE_FALL = 1.3;
/** s from the flood's start: the score's soft pulses in its dip, the lamp's blinks (drift_audio.wav, offset 0; the
 * flood starts at 241.0 s of the show): 242.4, 245.3, 247.0 and 249.2 s, each a note 7–14 dB over the dip's −30 dB
 * (RMS over 64 ms) — the hit that starts the dawn (params loDawnAt, 252.3 s, +18 dB) follows them */
export const LO_PULSES: readonly number[] = [1.4, 4.3, 6.0, 8.2];
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
 * passed it (the blink grows in over 2 s from there), `beats` act s of the blinks the score sets (ascending: its pulses,
 * then the dawn's hit), `period` s a blink before the first and after the last, `sunEl` deg the Sun stands over the
 * lamp's horizon now, `gone` act s it is out by (the sea's hand-over less a margin; over the 10 s before).
 */
export function lampState(t: number, o: { from: number; passed: number; beats: readonly number[]; period: number; sunEl: number; gone: number }): LampState {
  const on = smooth((t - o.from) / 3);
  // the blink: the swell of the latest blink begun, or the fall of the one before it if that is still brighter (the
  // closest pulses come 1.7 s apart, inside one blink's ~2.2 s) — the larger of two continuous swells, so no step
  const first = o.beats[0];
  const last = o.beats[o.beats.length - 1];
  const at = t + PULSE_LEAD;
  let k: number;
  if (at < first) k = first - Math.ceil((first - at) / o.period) * o.period;
  else if (at >= last) k = last + Math.floor((at - last) / o.period) * o.period;
  else k = o.beats[o.beats.findIndex((b, i) => b <= at && at < o.beats[i + 1])];
  const prev = k > first && k <= last ? o.beats[o.beats.indexOf(k) - 1] : k - o.period;
  const pulse = Math.max(swell(t - k), swell(t - prev));
  const blink = smooth((t - o.passed) / 2);
  const level = (1 - blink) * 0.7 + blink * (LAMP_LOW + (1 - LAMP_LOW) * pulse);
  // the day takes it to a third as the Sun comes up over it, and the hand-over takes the rest
  const day = 1 - 0.67 * smooth((o.sunEl + 1) / 6);
  const out = 1 - smooth((t - (o.gone - 10)) / 10);
  return { gain: on * level * day * out };
}

/** 0..1 one blink, s from its note: up over PULSE_RISE from PULSE_LEAD before it, held, down over PULSE_FALL */
function swell(s: number): number {
  return smooth((s + PULSE_LEAD) / PULSE_RISE) * (1 - smooth((s + PULSE_LEAD - PULSE_RISE - PULSE_HOLD) / PULSE_FALL));
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
