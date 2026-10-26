/**
 * Undertime's sky: light that belongs to the whole dome rather than to one sprite, evaluated per VIEW
 * DIRECTION on a sphere around the eye (so all six cube faces of a dome capture agree, as in billboard.ts).
 *
 *   SHELLS     the hero pair's two annihilations (U0) each release a sphere of light expanding at
 *              `shellSpeed`, drawn as its limb (`ring` below): one thin gold-white ring per flash, growing
 *              out of it, widening over the audience to the great circle and fading as the light moves on
 *              behind them. Light is neutral: no coloured echo rings (they read as a logo).
 *   WAVE       the annihilation front (U3) as light: a narrow band at angle θ = π·wave from the dome front,
 *              its edge ragged (pairModel.ts waveRag, the same edge the pairs and sparks die on). Gold-white,
 *              a short trail that decays to black within about a second, and half as bright once it is well
 *              past the zenith — nobody looks there, and its light would grey the front by cross-reflection.
 *
 * No background fill anywhere: a fill greys a dome's blacks for everything after it.
 */
import * as THREE from 'three/webgpu';
import { Fn, PI, acos, cameraPosition, exp, float, mx_noise_float, normalize, positionWorld, smoothstep, sqrt, uniform, vec4 } from 'three/tsl';
import { waveRag } from './pairModel';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

export interface UndertimeSky {
  readonly mesh: THREE.Mesh;
  readonly u: {
    /** world centres of the two light shells (the hero's annihilation points) */
    c0: THREE.Vector3;
    c1: THREE.Vector3;
  };
  /** s since the hero's annihilation (negative before it) */
  setShell(age: number, speed: number, radiance: number): void;
  /** wave progress 0..1 (the front plane is at σ = R · (1 − 2·wave) from the eye), dome front, radiance */
  setWave(wave: number, front: THREE.Vector3, radiance: number): void;
  setLight(light: THREE.Color): void;
  /** the sphere follows the eye */
  follow(eye: THREE.Vector3): void;
  dispose(): void;
}

export function createUndertimeSky(): UndertimeSky {
  const u = {
    c0: uniform(new THREE.Vector3()),
    c1: uniform(new THREE.Vector3()),
    age: uniform(-1),
    speed: uniform(6),
    radiance: uniform(1),
    wave: uniform(0),
    waveFront: uniform(new THREE.Vector3(0, 0, -1)),
    waveRadiance: uniform(0),
    light: uniform(new THREE.Color(1, 1, 1)),
  };
  const light = u.light as unknown as V3;

  const material = new THREE.MeshBasicNodeMaterial();
  material.side = THREE.BackSide;
  material.transparent = true;
  material.depthWrite = false;
  material.depthTest = false;
  material.blending = THREE.AdditiveBlending;
  material.colorNode = Fn(() => {
    const d = normalize(positionWorld.sub(cameraPosition));

    /**
     * The ring a shell of light (centre C, radius rho) draws on the sky, of world width w: bright where the
     * line of sight GRAZES the shell (closest approach m ≈ ρ) — the limb, which is where a thin glowing
     * shell is bright. While the eye is outside, the limb is a ring growing out of the flash; as the shell
     * reaches the eye it widens to the great circle across the dome; once the eye is inside, rays across
     * the shell's radial direction still nearly graze it, so the band along that great circle fades as the
     * shell moves on. No fill inside the ring: a lit bowl greys the dome (the bleached look we left).
     */
    const ring = (C: V3, rho: F, w: F): F => {
      const oc = C.sub(cameraPosition);
      const b = d.dot(oc);
      const m = sqrt(oc.dot(oc).sub(b.mul(b)).max(0));
      const x = rho.sub(m);
      const core = exp(x.div(w).pow(2).negate());
      const skirt = exp(x.div(w.mul(3)).pow(2).negate()).mul(0.08);
      // m is measured from the whole LINE of sight, so the same ring also appears mirrored behind the eye:
      // keep the half in front (b > 0), faded softly — at the great circle b → 0 and the two halves meet
      const half = smoothstep(oc.length().mul(-0.3), oc.length().mul(0.3), b);
      // and once the light has passed the audience it is gone: the band it leaves fades out quickly
      const passed = float(1).sub(smoothstep(oc.length().mul(0.97), oc.length().mul(1.2), rho));
      return core.add(skirt).mul(half).mul(passed) as F;
    };

    const age = u.age;
    const rho = age.max(0).mul(u.speed).add(0.05);
    const w = rho.mul(0.006).add(0.03);
    // bright at the flash, fading as it spreads and as the light leaves
    const energy = u.radiance.mul(smoothstep(0, 0.08, age)).mul(exp(age.max(0).div(3).negate())).mul(float(6).div(rho.add(6)));
    const c0 = u.c0 as unknown as V3;
    const c1 = u.c1 as unknown as V3;
    // ONE shell: both annihilations happen at once, a few metres apart — their light leaves as one front
    const shells = light.mul(ring(c0.add(c1).mul(0.5), rho, w)).mul(energy.mul(1.6)).mul(step01(age));

    // the wave front, in angle from the dome front (θ = π·wave), with the pairs' ragged edge
    const theta = acos(d.dot(u.waveFront as unknown as V3).clamp(-1, 1));
    const x = theta.sub(u.wave.add(waveRag(d)).mul(PI)).negate(); // > 0: already passed
    const band = exp(x.div(0.03).pow(2).negate()).add(exp(x.div(0.09).pow(2).negate()).mul(0.15));
    // the trail: ~1 s of the front's travel (π/7 rad per s at the default 7 s wave) back to black
    const trail = exp(x.max(0).div(0.12).negate()).mul(step01(x)).mul(0.05);
    const presence = smoothstep(0, 0.05, u.wave).mul(smoothstep(1, 0.92, u.wave));
    const behind = float(1).sub(smoothstep(1.75, 2.3, theta).mul(0.5));
    // not a wipe: the band breaks into brighter and fainter stretches along its length (where more or fewer
    // pairs were left to cancel), drifting slowly as it travels
    const patches = mx_noise_float(d.mul(4.5).add(u.wave.mul(3))).mul(0.5).add(0.5).pow(1.5).mul(1.6).add(0.15);
    const front = light.mul(band.mul(patches).add(trail)).mul(presence).mul(behind).mul(u.waveRadiance);

    return vec4(shells.add(front), 1);
  })();
  material.name = 'undertime-sky';

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(500, 96, 48), material);
  mesh.name = 'undertime-sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;

  return {
    mesh,
    u: { c0: u.c0.value, c1: u.c1.value },
    setShell(age, speed, radiance) {
      u.age.value = age;
      u.speed.value = speed;
      u.radiance.value = radiance;
    },
    setWave(wave, front, radiance) {
      u.wave.value = wave;
      u.waveFront.value.copy(front);
      u.waveRadiance.value = radiance;
    },
    setLight(l) {
      u.light.value.copy(l);
    },
    follow(eye) {
      mesh.position.copy(eye);
    },
    dispose() {
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}

/** 1 once the flash has happened (the shells do not exist before it) */
const step01 = (age: F): F => smoothstep(-0.001, 0, age);
