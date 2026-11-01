/**
 * Undertime's sky: light that belongs to the whole dome rather than to one sprite, evaluated per VIEW
 * DIRECTION on a sphere around the eye (so all six cube faces of a dome capture agree, as in billboard.ts).
 *
 *   SHELLS     the hero pair's two annihilations (U0) each release a sphere of light expanding at
 *              `shellSpeed`, drawn as its limb (`ring` below): one thin gold-white ring per flash, growing
 *              out of it, widening over the audience to the great circle and fading as the light moves on
 *              behind them. Light is neutral: no coloured echo rings (they read as a logo).
 *   WAVE       the annihilation front (U3) as light, rebuilt after the 2026-10-30 review ("a better ramp into
 *              intensity … a total collapse of space and time … too tame"; it had been a soft grey band). Its edge
 *              is front.ts's, the same ragged circle the pairs die on and the trails freeze at. Three movements:
 *                BUILD     before it rises, a glow comes up under the front horizon — warm, flickering faster as the
 *                          tension builds (timeline.ts waveEnvelope), the dome's first light since the boil
 *                FRONT     a RADIANT line rather than a band: a white-hot core under a degree wide, a violet-cyan
 *                          fringe just ahead (the light it drives before it, the antimatter side), a gold-to-amber
 *                          wake behind it (the matter side) that streams back in filaments, the whole of it
 *                          broken along its length into brighter and fainter veins. HDR: the core is ~7–10, so the
 *                          tone map's shoulder rolls it to a white with colour at its edges instead of clipping a
 *                          flat band, and only the core and veins pass the bloom threshold — the bloom follows the
 *                          front's structure instead of fogging it.
 *                CREST     while the front STALLS over the audience (timeline.ts waveSweep) its light broadens into
 *                          a band — mostly ahead of the line, narrow behind it — textured as a caustic web, and holds:
 *                          the climax, and it belongs to the front. Behind the line the dome is spent: dark.
 *                          Dimmer past the zenith (nobody looks there, and its light would grey the front by
 *                          cross-reflection).
 *
 * No background fill anywhere: a fill greys a dome's blacks for everything after it.
 */
import * as THREE from 'three/webgpu';
import { Fn, PI, abs, acos, cameraPosition, exp, float, mix, mx_noise_float, mx_noise_vec3, mx_worley_noise_vec2, normalize, positionWorld, smoothstep, sqrt, step, uniform, vec3, vec4 } from 'three/tsl';
import { frontFrac, shimmer } from './waveFx';

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
  /** wave progress 0..1 (the front's angle from the dome front over π), dome front, the front's radiance */
  setWave(wave: number, front: THREE.Vector3, radiance: number): void;
  /** the light wave's other movements (timeline.ts waveEnvelope): the build (0..1), the crest (0..1) and its
   * radiance, act s (the build's flicker and the light's slow churn), and the colours of the front's lead and wake */
  setCollapse(build: number, crest: number, crestRadiance: number, time: number, lead: THREE.Color, trail: THREE.Color, ember: THREE.Color): void;
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
    build: uniform(0),
    crest: uniform(0),
    crestRadiance: uniform(1),
    time: uniform(0),
    lead: uniform(new THREE.Color(0.55, 0.6, 1)),
    trail: uniform(new THREE.Color(1, 0.7, 0.3)),
    ember: uniform(new THREE.Color(0.9, 0.25, 0.07)),
  };
  const light = u.light as unknown as V3;

  const material = new THREE.MeshBasicNodeMaterial();
  material.side = THREE.BackSide;
  material.transparent = true;
  material.depthWrite = false;
  material.depthTest = false;
  material.blending = THREE.AdditiveBlending;
  material.colorNode = Fn(() => {
    const d0 = normalize(positionWorld.sub(cameraPosition));
    // THE HEAT SHIMMER (waveFx.ts shimmer; the 2026-11-01 brief): near the front's line the sky's light is bent by
    // the same small, fast jitter the field's points are, so the line itself ripples like air over a hot road
    const x0 = frontFrac(d0, { front: u.waveFront as unknown as V3 }).sub(u.wave).mul(PI);
    const d = normalize(d0.add(shimmer(d0, x0, { time: u.time, sweep: u.wave })));

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
      // (squared by hand: WGSL's pow of a negative base is undefined, and x is signed)
      const xw = x.div(w);
      const core = exp(xw.mul(xw).negate());
      const skirt = exp(xw.mul(xw).div(9).negate()).mul(0.08);
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

    // ---- the light wave
    const F = u.waveFront as unknown as V3;
    const lead = u.lead as unknown as V3;
    const trailC = u.trail as unknown as V3;
    const ember = u.ember as unknown as V3;
    const theta = acos(d.dot(F).clamp(-1, 1));
    // rad ahead of the front (> 0) or behind it (< 0), on front.ts's ragged edge
    const x = frontFrac(d, { front: F }).sub(u.wave).mul(PI);
    const ahead = step(0, x);
    // where on the front's circle: the direction across it, a unit vector in the plane square to the front's axis
    // (3D noise of it has no seam where an azimuth angle would wrap)
    const across = normalize(d.sub(F.mul(d.dot(F))));
    // VEINS along the front: ridged noise, fast round the circle, slow along the front's travel, so the light
    // breaks into streamers that trail back from the line; they churn slowly as it goes
    const vn = mx_noise_float(across.mul(5.5).add(F.mul(x.mul(1.6))).add(vec3(0, u.time.mul(0.35), 0)));
    const ridge = float(1).sub(abs(vn));
    const veins = ridge.mul(ridge).mul(ridge).mul(ridge);
    const patches = mx_noise_float(across.mul(2.2).add(u.wave.mul(2))).mul(0.5).add(0.5);
    // the line: a white-hot core (~0.7°), the violet light it drives ahead, the gold-amber wake streaming behind
    const xc = x.div(0.012);
    const core = exp(xc.mul(xc).negate()).mul(veins.mul(0.9).add(0.55)).mul(patches.mul(0.8).add(0.6));
    // (each side's exponent clamped to its own side: an exp that overflows on the other side times a 0 is a NaN)
    const xa = x.max(0);
    const xb = x.min(0);
    // THE LEADING EDGE (the 2026-11-01 brief: "the leading edge is the brightest"): a hot rim just ahead of the core,
    // ~0.8° out, where the swept-up field rides (waveFx.ts PILE) — so the light peaks at the line and its front lip,
    // and only falls away behind it
    const xr = xa.sub(0.012).div(0.007);
    const rim = exp(xr.mul(xr).negate()).mul(veins.mul(0.6).add(0.5)).mul(0.7);
    // (0.028 rad at 0.3 until 2026-11-01: with the rim in front of it, a white band ~3° deep that fed the bloom a wash)
    const leadGlow = exp(xa.div(0.018).negate()).mul(0.22).add(exp(xa.div(0.12).negate()).mul(0.02)).mul(ahead);
    const behind = float(1).sub(ahead);
    // (tight: behind the front the dome is the field's afterglow on black — a broad wake, and a residue fill under it,
    // browned the whole dome behind the line, 2026-10-30 second look; only its streamers trail further)
    // (and narrower again on 2026-11-01, "real darkness and quiet left behind": the wake 0.4 → 0.22 and its
    // streamers 0.18 → 0.05 and 4° → 1.7° deep (at 0.05 rad they drew vertical brown streaks 10° down the spent sky), the residue gone; the darkness starts a few degrees behind the line)
    const wake = exp(xb.div(0.022)).mul(0.22).mul(veins.mul(0.9).add(0.35))
      .add(exp(xb.div(0.03)).mul(veins.mul(0.05)))
      .mul(behind);
    const residue = float(0);
    const wakeColour = mix(trailC, light, exp(xb.div(0.04)));
    const lineLight = light.mul(core.add(rim.mul(ahead))).add(lead.mul(leadGlow)).add(wakeColour.mul(wake)).add(ember.mul(residue));
    const presence = smoothstep(0, 0.02, u.wave).mul(smoothstep(1, 0.95, u.wave));
    // half as bright once well past the zenith (nobody looks there; its light greys the front)
    const backDim = float(1).sub(smoothstep(1.75, 2.4, theta).mul(0.5));
    const front = lineLight.mul(presence).mul(backDim).mul(u.waveRadiance);

    // BUILD: the glow under the front horizon, before the front itself rises; it hands over as the front comes up
    const fl = mx_noise_float(d.mul(2.6).add(vec3(0, u.time.mul(float(0.8).add(u.build.mul(2.6))), u.time.mul(0.4)))).mul(0.5).add(0.5);
    const flicker = fl.mul(fl).mul(1.4).add(0.3);
    // (hugging the horizon: a wider glow greyed the whole front sky brown, 2026-10-30 first look)
    const under = exp(theta.div(0.13).negate()).mul(0.5).add(exp(theta.div(0.3).negate()).mul(0.02));
    const fringe = exp(theta.sub(0.2).div(0.05).mul(theta.sub(0.2).div(0.05)).negate()).mul(0.08);
    const build = mix(trailC, light, float(0.35)).mul(under).add(lead.mul(fringe)).mul(flicker)
      .mul(u.build.mul(u.build)).mul(float(1).sub(smoothstep(0.03, 0.14, u.wave)));

    // THE CREST: while the front stalls over the audience its light broadens into a band, textured as a CAUSTIC WEB —
    // light focused by a medium that is no longer flat, as sunlight through rippled water draws bright networks on
    // the floor: the collapse of space as light gathered along folds. It belongs to the front and moves with it:
    // mostly AHEAD of its line (the light it drives before it), narrow behind it, where the dome is spent. (The
    // 2026-10-30 story note: a dome-wide web that flashed up while the front was still climbing, and lit the spent
    // dome behind it again, read as a second, competing event.) Two scales of cell edges (Worley F2 − F1 → 0 on an
    // edge), their domain warped hard so the edges curve, drifting slowly; the lines a little over the bloom
    // threshold, the band's fill under it.
    const warp = mx_noise_vec3(d.mul(1.4).add(vec3(0, u.time.mul(0.12), 0))).mul(0.6)
      .add(mx_noise_vec3(d.mul(3.8).add(vec3(u.time.mul(-0.1), 0, 0))).mul(0.18));
    const q1 = d.mul(3.1).add(warp).add(vec3(u.time.mul(0.07), 0, u.time.mul(-0.05)));
    const w1 = mx_worley_noise_vec2(q1);
    const e1 = w1.y.sub(w1.x);
    const q2 = d.mul(7.3).add(warp.mul(1.8)).add(vec3(0, u.time.mul(-0.09), u.time.mul(0.06)));
    const w2 = mx_worley_noise_vec2(q2);
    const e2 = w2.y.sub(w2.x);
    // a caustic's lines are not even: they brighten toward its cusps and fade along their length
    const cusp = mx_noise_float(q1.mul(1.9).add(3.3)).mul(0.5).add(0.5);
    const lines = exp(e1.div(0.028).negate()).mul(1.25).add(exp(e1.div(0.11).negate()).mul(0.22)).mul(cusp.mul(cusp).mul(1.8).add(0.2));
    const fine = exp(e2.div(0.03).negate()).add(exp(e2.div(0.1).negate()).mul(0.12)).mul(0.3);
    const web = lines.add(fine);
    // the band: up to ~20° ahead of the line at the crest, ~5° behind it
    // (0.32 until 2026-11-01: a band 20° deep, its fill under the bloom, toned into a brown haze over the whole focus
    // zone at the crest — the brief's "no grey haze"; the line must stay the brightest thing)
    const wAhead = u.crest.mul(0.2).add(0.04);
    const wBehind = u.crest.mul(0.04).add(0.02);
    const xA = xa.div(wAhead);
    const xB = xb.div(wBehind);
    const band = exp(xA.mul(xA).negate()).mul(ahead).add(exp(xB.mul(xB).negate()).mul(behind));
    // streamers along the front's travel, broken into lengths, in the band
    const rn = mx_noise_float(across.mul(9).add(F.mul(theta.mul(0.6))));
    const cut = mx_noise_float(across.mul(4).add(F.mul(theta.mul(3.5))).add(vec3(7.1, 0, 0)));
    const rays = float(1).sub(abs(rn)).pow(6).mul(smoothstep(0.05, 0.45, cut));
    const tone = mix(mix(light, trailC, float(0.06)), mix(light, lead, float(0.2)), ahead).mul(vec3(0.97, 0.99, 1.08));
    // (the web as the TEXTURE of the front's light, not a pattern of its own: at 2.4× over a 0.35 fill it read as a
    // network flashing up — the very thing the 2026-10-30 story note asked to be cut — so the band's own light leads)
    const crestLight = tone.mul(band.mul(web.mul(0.9).add(0.3).add(rays.mul(0.4)))).mul(presence).mul(backDim).mul(u.crest).mul(u.crestRadiance);

    return vec4(shells.add(front).add(build).add(crestLight), 1);
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
    setCollapse(build, crest, crestRadiance, time, lead, trail, ember) {
      u.build.value = build;
      u.crest.value = crest;
      u.crestRadiance.value = crestRadiance;
      u.time.value = time;
      u.lead.value.copy(lead);
      u.trail.value.copy(trail);
      u.ember.value.copy(ember);
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
