/**
 * THE VEIL AND THE WATER'S GRAIN of the daylight Line Down (`?linedown=day`, lineDown.ts; lineDownDive.ts the dive
 * they dress). The brief after the 2026-11-02 review: each crossing "~1–2 s … under a soft veil of bubbles and foam",
 * and "particulate (marine snow) for depth parallax".
 *
 *   THE VEIL      a shell round the eye (0.6 m), drawn over everything (no depth test: where the sea's surface cuts
 *                 through it a depth-tested shell would show the waterline as a hard line across the dome — the very
 *                 flip it is there to hide), a milky lace of foam and fine bubbles drifting up over it, as opaque as
 *                 `veil` (lineDownDive.ts veilAt: ~1–2 s round each crossing). Its light is set each frame to the
 *                 light the eye is in, so it reads as the water turned white, never as a white flash.
 *   THE BUBBLES   the air the plunge drags down (born along the eye's way down as it passes, thrown down with it,
 *                 slowed by the water and rising again at their own speed, 0.15–0.35 m/s: millimetre bubbles), and a
 *                 cloud of fine ones in the top metre and a half the eye comes up through. World-placed, so they
 *                 stream past the eye with true parallax; silver-rimmed (a bubble mirrors the light round it at its
 *                 edge: total internal reflection, the bright ring of a bubble in a photograph).
 *   MARINE SNOW   flecks of matter hanging in the water, in a 12 m box that wraps round the eye (each a fixed place in
 *                 the world until it leaves the box on one side and comes in on the other, faded out over the box's
 *                 outer metres, where it is a fleck at the edge of seeing anyway), drifting with the current and
 *                 sinking a centimetre a second: the only thing near the eye in open water, so the only thing that
 *                 shows the eye moving through it.
 *
 * Everything is a pure function of t (the bursts' times and places are the dive's, fixed at build) and every quad
 * faces the eye's POSITION (undertime/billboard.ts eyeFacing), so the dome's six faces agree on each one.
 */
import * as THREE from 'three/webgpu';
import { Fn, cameraPosition, exp, float, instanceIndex, max, min, mix, mx_noise_float, mx_worley_noise_float, normalize, positionWorld, smoothstep, uniform, uv, vec2, vec3, vec4 } from 'three/tsl';
import { billboardMesh, eyeFacing } from '../undertime/billboard';
import { hash2 } from '../../terrain/noise';

type F = THREE.Node<'float'>;

/** bubbles dragged down by the entry, and the cloud the eye surfaces through */
const DOWN_BUBBLES = 1800;
const UP_BUBBLES = 1000;
/** m: how deep the plunge drags air (the eye enters at ~4.5 m/s), and the spread round its way down (widest at the
 * surface, where the splash churns it in) */
const DRAG_DEPTH = 3.5;
const DRAG_SPREAD = 1.4;
/** s: a dragged bubble's slowing (the water's drag on it), and its life */
const DRAG_TAU = 0.5;
const LIFE = 5;
/** m: the surfacing cloud's radius and depth; s it gathers over before the surfacing */
const CLOUD_R = 2.2;
const CLOUD_DEPTH = 1.6;
const CLOUD_LEAD = 1.8;
/** the marine snow: flecks, m the box round the eye they wrap in, m/s their drift (the current across, the sinking) */
const SNOW = 2600;
const SNOW_BOX = 12;
const SNOW_DRIFT: [number, number, number] = [0.03, -0.01, 0.015];
/** m: the veil's shell round the eye; the most of the view it ever covers (0..1: at the crossing itself, all but opaque — the sea's surface is cut by the near plane there) */
const VEIL_R = 0.6;
const VEIL_MAX = 0.96;

export interface DiveBursts {
  /** sea s and m (x, z) where the eye goes in, its speed down (m/s, negative) and its way over the ground (m/s, x z) */
  down: { t: number; x: number; z: number; v: number; vx: number; vz: number };
  /** sea s and m (x, z) where the eye comes up */
  up: { t: number; x: number; z: number };
}

export interface LineDownVeil {
  readonly group: THREE.Group;
  /** sea s; the eye (m, world); the veil's strength (0..1); the light the eye is in (linear radiance, a white surface's), the
   * water's own (the deep's radiance at the eye: the snow and the bubbles are lit by it), and whether the eye is under */
  update(t: number, eye: THREE.Vector3, veil: number, veilLight: THREE.Vector3, waterLight: THREE.Vector3, under: boolean, wet?: number): void;
  setPixelAngle(rad: number): void;
}

export function createLineDownVeil(b: DiveBursts): LineDownVeil {
  const U = {
    time: uniform(0),
    veil: uniform(0),
    /** 0 in the air … 1 under the water: the bubbles are the water's (in the air, over the sky, they read as snow) */
    wet: uniform(0),
    veilLight: uniform(new THREE.Vector3()),
    water: uniform(new THREE.Vector3()),
    pixelAngle: uniform(0.0015),
  };
  const group = new THREE.Group();
  group.name = 'line-down-veil';
  group.userData.lineDownOwn = true;

  // ── THE BUBBLES ────────────────────────────────────────────────────────────────────────────────────────────
  {
    const id = float(instanceIndex);
    const isUp = id.greaterThanEqual(DOWN_BUBBLES);
    const j = isUp.select(id.sub(DOWN_BUBBLES), id);
    const h = (k: number): F => hash2(vec2(j.add(k * 13.7), isUp.select(float(91.3), float(17.9)).add(k))) as F;
    // THE PLUNGE'S: a depth along the eye's way down (more near the surface: the splash's churn), born as the eye
    // passes it (its depth over the entry speed, the eye slowing past ~2 m), thrown down with ~half the eye's speed
    const yb = h(1).pow(1.6).mul(-DRAG_DEPTH);
    const tb = float(b.down.t).add(yb.negate().div(-b.down.v).mul(float(1).add(yb.negate().mul(0.18))));
    const r0 = h(2).sqrt().mul(DRAG_SPREAD).mul(float(1).add(yb.mul(0.18)).max(0.25));
    const ang = h(3).mul(Math.PI * 2);
    const w = mix(float(0.15), float(0.35), h(4));
    const v0 = float(b.down.v).mul(mix(float(0.25), float(0.6), h(5))).mul(float(1).add(yb.div(DRAG_DEPTH)));
    const tauD = U.time.sub(tb);
    const tp = tauD.max(0);
    const yD = yb.add(w.mul(tp)).add(v0.sub(w).mul(DRAG_TAU).mul(float(1).sub(exp(tp.div(-DRAG_TAU)))));
    const wob = vec2(tp.mul(mix(float(5), float(9), h(6))).add(h(7).mul(6.3)).sin(), tp.mul(mix(float(4), float(8), h(8))).cos()).mul(0.04);
    const rr = r0.add(tp.mul(0.06));
    const pD = vec3(
      float(b.down.x).add(float(b.down.vx).mul(tb.sub(b.down.t))).add(ang.cos().mul(rr)).add(wob.x),
      yD,
      float(b.down.z).add(float(b.down.vz).mul(tb.sub(b.down.t))).add(ang.sin().mul(rr)).add(wob.y),
    );
    // THE SURFACING'S: fine bubbles in the top metre and a half round where the eye comes up, rising
    const tbU = float(b.up.t).sub(h(1).mul(CLOUD_LEAD)).sub(0.4);
    const tauU = U.time.sub(tbU);
    const yU = h(2).pow(0.7).mul(-CLOUD_DEPTH).add(w.mul(tauU.max(0)));
    const rU = h(3).sqrt().mul(CLOUD_R);
    const pU = vec3(float(b.up.x).add(ang.cos().mul(rU)).add(wob.x), yU, float(b.up.z).add(ang.sin().mul(rU)).add(wob.y));
    const pos = isUp.select(pU, pD);
    const tau = isUp.select(tauU, tauD);
    const alive = tau.greaterThan(0).and(tau.lessThan(LIFE)).and(pos.y.lessThan(-0.02));
    const dist = cameraPosition.sub(pos).length();
    // 1–6 mm, a few larger (1–1.5 cm): a millimetre bubble at half a metre is ~0.1° — a few pixels on the master
    const wanted = mix(float(0.001), float(0.006), h(9).pow(2)).mul(mix(float(1), float(2.5), smoothstep(0.93, 0.99, h(10))));
    const drawn = max(wanted, U.pixelAngle.mul(1.3).mul(dist));
    const coverage = wanted.div(drawn).pow(2);
    const material = new THREE.NodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;
    material.blending = THREE.AdditiveBlending;
    material.fog = false;
    material.positionNode = eyeFacing(pos, drawn.mul(alive.select(float(1), float(0))));
    material.colorNode = Fn(() => {
      const q = uv().sub(0.5).mul(2);
      const r = q.length();
      // a silver ring (the bubble's edge mirroring the light round it) and a glint on its upper side; its middle clear
      const ring = smoothstep(0.55, 0.85, r).mul(float(1).sub(smoothstep(0.85, 1, r)));
      const glint = float(1).sub(smoothstep(0, 0.28, q.sub(vec2(-0.25, 0.3)).length())).mul(0.8);
      const fade = float(1).sub(smoothstep(LIFE * 0.6, LIFE, tau)).mul(smoothstep(-0.02, -0.25, pos.y));
      const a = ring.add(glint).mul(min(coverage.mul(2), 1)).mul(fade);
      return vec4(U.water.mul(14).add(U.veilLight.mul(0.25)).mul(a), 1);
    })();
    material.name = 'line-down-bubbles';
    const mesh = billboardMesh(material, DOWN_BUBBLES + UP_BUBBLES, 'line-down-bubbles');
    mesh.renderOrder = 9999;
    group.add(mesh);
  }

  // ── MARINE SNOW ────────────────────────────────────────────────────────────────────────────────────────────
  const snowMesh = (() => {
    const id = float(instanceIndex);
    const h = (k: number): F => hash2(vec2(id.add(k * 7.31), float(k * 3.7 + 1))) as F;
    const seed = vec3(h(1), h(2), h(3)).mul(SNOW_BOX);
    const drift = vec3(...SNOW_DRIFT).mul(U.time);
    // (wrapped round the eye: the world place seed + drift, taken modulo the box about the eye)
    const rel = seed.add(drift).sub(cameraPosition).div(SNOW_BOX).fract().sub(0.5).mul(SNOW_BOX);
    const pos = cameraPosition.add(rel);
    const edge = max(max(rel.x.abs(), rel.y.abs()), rel.z.abs()).div(SNOW_BOX / 2);
    const dist = rel.length();
    const wanted = mix(float(0.0015), float(0.005), h(4).pow(3));
    const drawn = max(wanted, U.pixelAngle.mul(1.3).mul(dist));
    const coverage = wanted.div(drawn).pow(2);
    const material = new THREE.NodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;
    material.blending = THREE.AdditiveBlending;
    material.fog = false;
    material.positionNode = eyeFacing(pos, drawn);
    material.colorNode = Fn(() => {
      const r = uv().sub(0.5).mul(2).length();
      const dot = float(1).sub(smoothstep(0.2, 1, r));
      // (faded at the box's edge, where it wraps; dimmed with distance by the water itself, as everything is; and none
      // above the water)
      const keep = float(1).sub(smoothstep(0.55, 0.95, edge)).mul(exp(dist.mul(-0.12))).mul(smoothstep(-0.05, -0.4, pos.y));
      return vec4(U.water.mul(10).mul(dot).mul(min(coverage.mul(2), 1)).mul(keep), 1);
    })();
    material.name = 'line-down-snow';
    const mesh = billboardMesh(material, SNOW, 'line-down-snow');
    mesh.renderOrder = 9997;
    group.add(mesh);
    return mesh;
  })();

  // ── THE VEIL ───────────────────────────────────────────────────────────────────────────────────────────────
  const veil = (() => {
    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, transparent: true, depthTest: false, depthWrite: false, fog: false });
    const d = normalize(positionWorld.sub(cameraPosition));
    // a milky haze of fine bubbles and a scatter of brighter ones, rising across the eye (in the world's directions: the
    // faces agree). (A lace of value noise alone, the first round's, read as grey smoke over the dome, not as water)
    const haze = mx_noise_float(d.mul(4).add(vec3(0, U.time.mul(-0.9), 0))).mul(0.5).add(0.5);
    const cells = mx_worley_noise_float(d.mul(38).add(vec3(0, U.time.mul(-3.1), 0)));
    const cellsFine = mx_worley_noise_float(d.mul(90).add(vec3(0, U.time.mul(-4.7), 0)));
    const dots = float(1).sub(smoothstep(0.05, 0.22, cells)).add(float(1).sub(smoothstep(0.04, 0.16, cellsFine)).mul(0.6));
    const wetDots = dots.mul(U.wet);
    material.colorNode = U.veilLight.mul(haze.mul(0.35).add(0.75).add(wetDots.mul(1.2)));
    material.opacityNode = U.veil.mul(VEIL_MAX).mul(haze.mul(0.15).add(0.85)).add(wetDots.mul(U.veil).mul(0.3)).min(VEIL_MAX);
    material.name = 'line-down-veil';
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(VEIL_R, 48, 24), material);
    mesh.name = 'line-down-veil';
    mesh.frustumCulled = false;
    mesh.renderOrder = 9998;
    group.add(mesh);
    return mesh;
  })();

  for (const o of group.children) o.userData.lineDownOwn = true;
  return {
    group,
    update(t, eye, v, veilLight, waterLight, under, wet = under ? 1 : 0) {
      U.time.value = t;
      U.wet.value = wet;
      veil.position.copy(eye);
      U.veil.value = v;
      U.veilLight.value.copy(veilLight);
      U.water.value.copy(waterLight);
      snowMesh.visible = under;
      veil.visible = v > 1e-3;
    },
    setPixelAngle(rad) {
      U.pixelAngle.value = rad;
    },
  };
}
