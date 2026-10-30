/**
 * THE AIR IN FRONT OF A FAR ISLAND — the light the air scatters into the eye over the island's own distance and in
 * its own direction, from the sky model itself (seaSky.ts radianceCpu), instead of "the horizon's colour".
 *
 * WHY. The user, 2026-10-30: "the white weird islands … probably an effect of haze … but it doesn't work" — the high
 * island came out as a pale, near-white mound on the horizon, brighter than the sky right behind its summit (measured
 * on the w1 morning still: the island 160, the sky over it 137). Its haze (forest.ts createForestGround, HIGH_AIR) and
 * the terrain's (terrain/aerialPerspective.ts) mix toward ONE colour, `seaSky.horizon`: the sky's radiance just over
 * the horizon AVERAGED OVER EVERY BEARING — the bright side toward a low Sun included — and over the whole ray to the
 * top of the air. An island 7 km off, away from the Sun, gets far less light from the air in front of it than that:
 * the in-scatter over 7 km of its own direction, which is always less than the sky's behind it, so a hazy island
 * reads a little darker and bluer than its sky, never paler. Measured at w1 (500 s), toward the high island, through
 * the grade: the sky over its summit 137,143,132; the island as it was 198,156,111 (paler and warmer than its sky,
 * the complaint); as it is now 100,101,98 — a slate silhouette two-thirds as bright as its sky. At w4's sunset
 * (650 s) it was already a little darker than its sky (192,145,99 against 212,187,154) and stays so, warmer
 * (210,164,121). (The sky model's horizon itself — the coordinator's first suggestion, "horizon radiance ×
 * (1 − T(L))" in the island's own bearing — still came out as bright as the sky over the summit at 650 s: 221,168,115.
 * A horizon is the light of a path hundreds of km long, reddened by all of it; 7 km of air holds a sliver of that.)
 *
 * HOW HAZY. The sky model's own air at sea level is clear (an e-folding of ~31 km in green, ~120 km visibility);
 * the film's marine air is hazier: the high island's HIGH_AIR (coast.ts, 8.5 km, as the near field's veil in sea.ts,
 * 7 km). The same air, denser near the sea: its in-scatter and its extinction over a path L taken as the sky model's
 * over k·L, k the ratio of the two e-foldings in green (~3.6) — a horizontal path's air is the same all along it.
 *
 * WHAT. Each frame (each beat of a dissolve: `update` with that pass's eye and Sun), the in-scatter of horizontal paths
 * of DIST m in AZ bearings, from the same scattering as the sky dome (Rayleigh, Mie, the multiple-scattering term,
 * the Sun's light along the way), into a small table; and the extinction over those paths, fitted per channel as an
 * exponential (blue dims first: the far island turns blue). A material's light then reaches the eye as
 *
 *   L = L_surface · T(d) + airlight(bearing, d)
 *
 * — the far islands (the high island, the Rose's motus) and the towers on them. The terrain near the eye (our
 * island, the motus across the lagoon) keeps the game's aerial curve for now (aerialPerspective.ts is the game's).
 *
 * One table for the scene, shared (`farAir`): the coast and the open sea's props each refresh it with their pass's eye
 * and Sun; it is recomputed only when those change. A pure function of them: every frame of t its own.
 */
import * as THREE from 'three/webgpu';
import { atan, cameraPosition, exp, float, log2, output, positionWorld, texture, uniform, vec2, vec3, vec4 } from 'three/tsl';
import { radianceCpu } from './seaSky';
import { EARTH_R } from '../getTheDrift/atmosphere';
import { HIGH_AIR } from './coast';
import type { MastAir } from '../../radio/mast';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

/** bearings the table holds (equal steps round the horizon) and the path lengths (m, doubling) */
const AZ = 16;
const DIST = [500, 1000, 2000, 4000, 8000, 16000];
/** Mm in a metre (the sky model's unit) */
const MM = 1e-6;
/** steps of each path's march (a horizontal path through near-uniform air: few are enough) */
const STEPS = 12;
/** m: the path the extinction is fitted on (of the sky model's air) */
const FIT = 8000;

export interface FarAir {
  /** the air for a material or a lamp (radio/mast.ts MastAir) */
  readonly air: MastAir;
  /** this pass's eye (world, m) and Sun (unit, toward it) */
  update(eye: THREE.Vector3, sun: THREE.Vector3): void;
}

/** the marine air at the eye (`eyeY` m over the sea, Sun toward `sun`): its extinction per channel (1/m), and how
 * many times the sky model's air it is (k) */
export function marineAir(eyeY: number, sun: THREE.Vector3): { beta: [number, number, number]; k: number } {
  const through: [number, number, number] = [1, 1, 1];
  radianceCpu(EARTH_R + Math.max(0, eyeY) * MM, new THREE.Vector3(0, 0, 1), sun, STEPS, undefined, FIT * MM, through);
  const sky = through.map((t) => -Math.log(Math.max(t, 1e-6)) / FIT);
  const k = 1 / (HIGH_AIR * sky[1]);
  return { beta: [sky[0] * k, sky[1] * k, sky[2] * k], k };
}

/** CPU: the airlight (linear) over a level path of `dist` m toward bearing `az` (rad; d = (sin az, 0, cos az)) in the
 * marine air of `marine` (marineAir) */
export function airlightCpu(eyeY: number, sun: THREE.Vector3, az: number, dist: number, marine = marineAir(eyeY, sun)): [number, number, number] {
  return radianceCpu(EARTH_R + Math.max(0, eyeY) * MM, new THREE.Vector3(Math.sin(az), 0, Math.cos(az)), sun, STEPS, undefined, dist * marine.k * MM);
}

export function createFarAir(): FarAir {
  const data = new Uint16Array(AZ * DIST.length * 4);
  const tex = new THREE.DataTexture(data, AZ, DIST.length, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.name = 'drift/farAir';
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  /** 1/m: the extinction per channel */
  const beta = uniform(new THREE.Vector3(1e-4, 1.3e-4, 1.8e-4));
  let last = '';

  const update = (eye: THREE.Vector3, sun: THREE.Vector3): void => {
    const key = `${eye.y.toFixed(2)}|${sun.x.toFixed(5)}|${sun.y.toFixed(5)}|${sun.z.toFixed(5)}`;
    if (key === last) return;
    last = key;
    // the sky model's air along a level path, made as dense as the marine air (green's e-folding HIGH_AIR)
    const marine = marineAir(eye.y, sun);
    (beta.value as THREE.Vector3).set(...marine.beta);
    for (let i = 0; i < DIST.length; i++) {
      for (let j = 0; j < AZ; j++) {
        // (the bearing convention seaSky's own horizon uses; level: an island's foot and its summit are a fraction of
        // a degree apart from 7 km)
        const L = airlightCpu(eye.y, sun, ((j + 0.5) / AZ) * Math.PI * 2, DIST[i], marine);
        const o = (i * AZ + j) * 4;
        for (let c = 0; c < 3; c++) data[o + c] = THREE.DataUtils.toHalfFloat(Math.max(0, L[c]));
        data[o + 3] = THREE.DataUtils.toHalfFloat(1);
      }
    }
    tex.needsUpdate = true;
  };

  /** the transmittance (rgb) over horizontal distance `dist` m */
  const T = (dist: F): V3 => exp(vec3(beta as unknown as V3).mul(dist).negate()) as V3;
  /** the airlight in front of a point `toPoint` (world, from the eye) */
  const airlight = (toPoint: V3): V3 => {
    const dist = toPoint.xz.length().max(1) as F;
    const u = atan(toPoint.x, toPoint.z).div(Math.PI * 2);
    const k = log2(dist.div(DIST[0])).clamp(0, DIST.length - 1);
    const at = texture(tex, vec2(u, k.add(0.5).div(DIST.length))).rgb as V3;
    // (below the table's first path and past its last, its nearest row scaled by the in-scatter's own growth)
    const held = float(DIST[0]).mul(k.exp2()) as F;
    const scale = vec3(1).sub(T(dist)).div(vec3(1).sub(T(held)).max(1e-6));
    return at.mul(scale) as V3;
  };

  return {
    update,
    air: {
      output(m) {
        const toPoint = positionWorld.sub(cameraPosition) as V3;
        m.outputNode = vec4(output.rgb.mul(T(toPoint.xz.length() as F)).add(airlight(toPoint)), output.a);
      },
      // (a lamp is red: what reaches the eye of it is the red channel's)
      transmittance: (at) => T(at.xz.sub(cameraPosition.xz).length() as F).x as F,
    },
  };
}

/** the scene's one table: the coast and the open sea's props refresh it with their pass's eye and Sun (the same
 * eye and Sun within a frame: computed once) */
export const farAir = createFarAir();
