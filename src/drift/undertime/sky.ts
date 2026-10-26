/**
 * Undertime's sky: light that belongs to the whole dome rather than to one sprite, evaluated per VIEW
 * DIRECTION on a sphere around the eye (so all six cube faces of a dome capture agree, as in billboard.ts).
 *
 *   SHELLS     the hero pair's two annihilations (U0) each release a sphere of light expanding at
 *              `shellSpeed`, drawn as its limb (`ring` below): a ring growing out of the flash that widens
 *              over the audience to the great circle and fades as the light moves on behind them. A thinner
 *              ring in the particle's colour trails each one (dispersion), so the two read as cyan and
 *              magenta echoes of one light.
 *   WAVE       the annihilation front (U3) as light: a band along the circle where the front plane meets the
 *              field's edge, cos θ = σ / R from the dome front — a point on the front horizon that opens into a
 *              ring, crosses overhead as the great circle and closes at the back. Gold-white, a cooler leading
 *              edge, a short warm trail behind it, then darkness. It rhymes with the first light's ring.
 *   AFTERGLOW  the light the wave released, cooled into a faint mottled background (U5): fixed to the sky,
 *              mostly true black. Never a fill: a fill greys a dome's blacks for everything after it.
 */
import * as THREE from 'three/webgpu';
import { Fn, cameraPosition, exp, float, mix, mx_fractal_noise_float, normalize, positionWorld, smoothstep, sqrt, uniform, vec4 } from 'three/tsl';

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
  setAfterglow(amount: number, radiance: number): void;
  /** wave progress 0..1 (the front plane is at σ = R · (1 − 2·wave) from the eye), dome front, radiance */
  setWave(wave: number, front: THREE.Vector3, radiance: number): void;
  setColours(light: THREE.Color, matter: THREE.Color, anti: THREE.Color): void;
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
    afterglow: uniform(0),
    wave: uniform(0),
    waveFront: uniform(new THREE.Vector3(0, 0, -1)),
    waveRadiance: uniform(0),
    afterglowRadiance: uniform(0.03),
    light: uniform(new THREE.Color(1, 1, 1)),
    matter: uniform(new THREE.Color(0, 1, 1)),
    anti: uniform(new THREE.Color(1, 0, 1)),
  };
  const light = u.light as unknown as V3;
  const matter = u.matter as unknown as V3;
  const anti = u.anti as unknown as V3;

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
    const w = rho.mul(0.012).add(0.06);
    // bright at the flash, fading as it spreads and as the light leaves
    const energy = u.radiance.mul(smoothstep(0, 0.08, age)).mul(exp(age.max(0).div(3).negate())).mul(float(6).div(rho.add(6)));
    const lag = rho.sub(w.mul(6)).max(0.05);
    const c0 = u.c0 as unknown as V3;
    const c1 = u.c1 as unknown as V3;
    // each shell: a light-coloured leading ring and, just behind it, a thinner ring in its particle's colour
    const s0 = light.mul(ring(c0, rho, w)).add(matter.mul(ring(c0, lag, w.mul(0.6)).mul(0.4)));
    const s1 = light.mul(ring(c1, rho, w)).add(anti.mul(ring(c1, lag, w.mul(0.6)).mul(0.4)));
    const shells = s0.add(s1).mul(energy).mul(step01(age));

    // the wave front: c is cos θ of the front circle; ahead of it (c > cos θ) the field is still alive
    const cosT = d.dot(u.waveFront as unknown as V3);
    const c = float(1).sub(u.wave.mul(2));
    const x = cosT.sub(c);
    const band = exp(x.div(0.035).pow(2).negate());
    const lead = exp(x.add(0.05).div(0.03).pow(2).negate()).mul(0.35);
    const trail = exp(x.max(0).div(0.06).negate()).mul(step01(x)).mul(0.1);
    const presence = smoothstep(0, 0.06, u.wave).mul(smoothstep(1, 0.9, u.wave));
    const front = light.mul(band.add(trail)).add(mix(light, matter, 0.6).mul(lead)).mul(presence).mul(u.waveRadiance);

    // afterglow: large soft patches, black between them; warm with a rose cast where a second noise says
    const n = mx_fractal_noise_float(d.mul(3.5), 5, 2, 0.55).mul(0.5).add(0.5);
    const tint = mix(light, mix(light, anti, 0.45), mx_fractal_noise_float(d.mul(1.3).add(7.1), 2, 2, 0.5).mul(0.5).add(0.5));
    const glow = tint.mul(smoothstep(0.5, 0.95, n).pow(2)).mul(u.afterglow.mul(u.afterglowRadiance));

    return vec4(shells.add(front).add(glow), 1);
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
    setAfterglow(amount, radiance) {
      u.afterglow.value = amount;
      u.afterglowRadiance.value = radiance;
    },
    setWave(wave, front, radiance) {
      u.wave.value = wave;
      u.waveFront.value.copy(front);
      u.waveRadiance.value = radiance;
    },
    setColours(l, m, a) {
      u.light.value.copy(l);
      u.matter.value.copy(m);
      u.anti.value.copy(a);
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
