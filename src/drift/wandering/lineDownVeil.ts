/**
 * THE CROSSINGS' WATER AND THE WATER'S GRAIN of the daylight Line Down (`?linedown=day`, lineDown.ts; lineDownDive.ts
 * the dive they dress).
 *
 * ROUND 2 (the user, 2026-11-02, on the first build's clip: "Before we hit the water we suddenly have what looks like a
 * gray screen with snow on it… As soon as we're in the water we get this other snow effect… we definitely overdid it
 * and they are static… it should be pretty immediately when diving in. And maybe we need a bit of a wetness shader on
 * the lens when coming out"). The first build hid each crossing under a VEIL: a shell round the eye, milky and dotted,
 * up for 1–2 s — a flat grey-beige screen over the whole dome with a pattern of dots that moved with the eye (so they
 * read as static, as snow on a screen), and 2 600 flecks of marine snow lit evenly everywhere. All gone. Now:
 *
 *   THE WATERLINE    no veil in the air. The approach stays clean and sunlit down to the water; the crossing is the
 *                    surface rushing up and through (~0.1 s through the waterline band at 4.5 m/s), and for a moment
 *                    round it a band of FOAM where the surface meets the eye — a ring round the dome at the eye's level
 *                    (on the tilted dome, low in front) — gone within ~0.35 s. The rest of the dome is the scene.
 *   THE BUBBLES      the air the plunge drags down: world-placed (true parallax), 1–12 mm, born along the eye's way down
 *                    as it passes, thrown down with it, slowed by the water and rising at their own speed, silver-rimmed
 *                    and brighter where a shaft passes them; and a cloud of fine ones the eye comes up through.
 *   MARINE SNOW      a tenth of before: sparse flecks in a 10 m box round the eye, of every size, soft (the near ones
 *                    out of focus, large and faint), drifting in a slow current and circling with the swell's orbit
 *                    and their own small eddies (a pure function of t), and lit only where a shaft of light crosses
 *                    them (lineDown.ts beamAt) — the rest of the water holds them, unseen.
 *   THE WET LENS     OFF unless `&ldwet=1` (see WET_LENS: not yet good enough to show). Coming up: a few drops and a thin
 *                    film on the eye's own surface, the film sheeting off downward and the drops sliding and shrinking,
 *                    all gone within ~1.3 s. On the dome the "lens" is the whole sphere round the eye, so the drops sit
 *                    where the audience looks (ahead, 5–70° up) and stay few and small (1.5–3.5°), mostly clear. A drop shows what is
 *                    behind it turned over — the sky in its lower half, the sea in its upper — with a bright rim: a
 *                    drop's look, computed from the world's directions alone (no read of the frame behind it: on six
 *                    cube faces a screen read would seam where a drop crossed an edge).
 *
 * Every quad faces the eye's POSITION (undertime/billboard.ts eyeFacing), and the lens is a sphere round the eye shaded
 * by world direction: the dome's six faces agree on all of it.
 */
import * as THREE from 'three/webgpu';
import { Fn, If, Loop, cameraPosition, exp, float, instanceIndex, int, max, min, mix, mx_noise_float, mx_worley_noise_float, normalize, positionWorld, smoothstep, uniformArray, uniform, uv, vec2, vec3, vec4 } from 'three/tsl';
import { billboardMesh, eyeFacing } from '../undertime/billboard';
import { hash2 } from '../../terrain/noise';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node unions
type Node = any;
type F = THREE.Node<'float'>;

const QUERY = typeof location !== 'undefined' ? new URLSearchParams(location.search) : undefined;
/**
 * `&ldwet=1`: the surfacing's wet lens ON — OFF BY DEFAULT. The user on its first frames (2026-11-02): "the droplets on
 * the lens look really, really ugly … If you do this, it needs to be spot on, not some janky blob." What real footage
 * shows — each drop a true, inverted, compressed image of the scene behind it, a mix of many tiny and a few large
 * drops, sharp, a sheet sliding off and breaking into trails of drops — needs the frame behind the drop, and on the
 * dome's six cube faces a read of it seams wherever a drop crosses a face's edge; the drops here are shaded from the
 * world's directions alone (the sky below, the sea above, a rim), and that is the blob the user saw. Kept, switchable,
 * for a later round that renders the drops from the finished master (a post pass in the dome's own projection).
 */
export const WET_LENS = QUERY?.get('ldwet') === '1';

/** bubbles dragged down by the entry, and the cloud the eye surfaces through */
const DOWN_BUBBLES = 1600;
const UP_BUBBLES = 700;
/** m: how deep the plunge drags air (the eye enters at ~4.5 m/s), and the spread round its way down */
const DRAG_DEPTH = 3.5;
const DRAG_SPREAD = 1.4;
/** s: a dragged bubble's slowing (the water's drag on it), and its life */
const DRAG_TAU = 0.5;
const LIFE = 5;
/** m: the surfacing cloud's radius and depth; s it gathers over before the surfacing */
const CLOUD_R = 2.2;
const CLOUD_DEPTH = 1.6;
const CLOUD_LEAD = 1.8;
/** the marine snow: flecks (a tenth of the first build's 2 600), m the box round the eye they wrap in, m/s the current,
 * m and s of the swell's orbit (SWELL_PERIOD's 10 s, its orbit a few cm under a 0.13 m swell, more for the ripples) */
export const SNOW = 240;
const SNOW_BOX = 10;
const SNOW_CURRENT: [number, number, number] = [0.07, -0.012, 0.04];
const SNOW_ORBIT: [number, number] = [0.12, 10];
/** m: the lens's sphere round the eye */
const LENS_R = 0.4;
/** rad: half the width of the waterline's foam band round the eye's level */
const FOAM_BAND = 0.1;
/** the wet lens's drops, and the s the film takes to sheet off */
const DROPS = 18;
const FILM_S = 0.9;

export interface DiveBursts {
  /** sea s and m (x, z) where the eye goes in, its speed down (m/s, negative) and its way over the ground (m/s, x z) */
  down: { t: number; x: number; z: number; v: number; vx: number; vz: number };
  /** sea s and m (x, z) where the eye comes up; the eye's front there (unit, world: the drops sit ahead) */
  up: { t: number; x: number; z: number; front?: [number, number] };
}

export interface LineDownVeil {
  readonly group: THREE.Group;
  /**
   * sea s; the eye (m, world); the waterline foam (0..1, lineDownDive.ts foamAt); the light the eye is in (linear
   * radiance off a white surface: the foam's, the drops' sky); the water's own (the deep's radiance at the eye); whether
   * the eye is under
   */
  update(t: number, eye: THREE.Vector3, foam: number, light: THREE.Vector3, waterLight: THREE.Vector3, under: boolean): void;
  setPixelAngle(rad: number): void;
}

/** the wet lens's drops at s `tau` after the surfacing: [unit direction (world), angular radius (rad)], none past life */
export function dropsAt(tau: number, front: [number, number], seed = 2160): Array<[THREE.Vector3, number]> {
  let s = seed >>> 0;
  const r = (): number => {
    s = (Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9) >>> 0;
    s = Math.imul(s ^ (s >>> 13), 3266489917) >>> 0;
    return ((s ^ (s >>> 16)) >>> 0) / 4294967295;
  };
  const out: Array<[THREE.Vector3, number]> = [];
  const az0 = Math.atan2(front[0], front[1]);
  for (let i = 0; i < DROPS; i++) {
    const az = az0 + (r() - 0.5) * 2 * 1.7;
    const el0 = (5 + r() * 65) * (Math.PI / 180);
    const r0 = (1.5 + r() * r() * 2) * (Math.PI / 180);
    const life = 0.6 + r() * 0.5;
    const g = (20 + r() * 40) * (Math.PI / 180);
    const born = r() * 0.15;
    const k = tau - born;
    if (k < 0 || k > life) continue;
    // sliding down, faster as it goes (a drop breaking loose), and shrinking as it runs out
    const el = el0 - 0.5 * g * k * k;
    const rad = r0 * (1 - Math.max(0, (k - life * 0.5) / (life * 0.5)) * 0.85);
    out.push([new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)), rad]);
  }
  return out;
}

export function createLineDownVeil(b: DiveBursts, o: { beam?: (p: Node) => Node } = {}): LineDownVeil {
  const U = {
    time: uniform(0),
    foam: uniform(0),
    light: uniform(new THREE.Vector3()),
    water: uniform(new THREE.Vector3()),
    pixelAngle: uniform(0.0015),
    film: uniform(0),
    dropCount: uniform(0),
  };
  const beam = (p: Node): Node => (o.beam ? o.beam(p) : float(0.5));
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
    // passes it, thrown down with ~half the eye's speed
    const yb = h(1).pow(1.6).mul(-DRAG_DEPTH);
    const tb = float(b.down.t).add(yb.negate().div(-b.down.v).mul(float(1).add(yb.negate().mul(0.18))));
    const r0 = h(2).sqrt().mul(DRAG_SPREAD).mul(float(1).add(yb.mul(0.18)).max(0.25));
    const ang = h(3).mul(Math.PI * 2);
    // (rise: ~0.15 m/s a millimetre bubble, ~0.3 one of a centimetre)
    const size = mix(float(0.001), float(0.012), h(9).pow(2.2));
    const w = mix(float(0.13), float(0.32), size.div(0.012).sqrt());
    const v0 = float(b.down.v).mul(mix(float(0.25), float(0.6), h(5))).mul(float(1).add(yb.div(DRAG_DEPTH)));
    const tauD = U.time.sub(tb);
    const tp = tauD.max(0);
    const yD = yb.add(w.mul(tp)).add(v0.sub(w).mul(DRAG_TAU).mul(float(1).sub(exp(tp.div(-DRAG_TAU)))));
    // (a bubble wobbles as it rises — the larger, the wider)
    const wob = vec2(tp.mul(mix(float(5), float(9), h(6))).add(h(7).mul(6.3)).sin(), tp.mul(mix(float(4), float(8), h(8))).cos()).mul(size.mul(4).add(0.01));
    const rr = r0.add(tp.mul(0.08));
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
    const wanted = isUp.select(size.mul(0.6), size);
    const drawn = max(wanted, U.pixelAngle.mul(1.3).mul(dist));
    const coverage = wanted.div(drawn).pow(2);
    // (the light it catches: the water's, and a shaft's where one passes it)
    const lit = beam(pos).mul(1.6).add(0.35);
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
      return vec4(U.water.mul(lit).mul(16).mul(a), 1);
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
    // its place in the water: carried by the current, circling with the swell's orbit (its phase by its place along
    // the swell's way) and in its own small eddy — all of t
    const [orbit, period] = SNOW_ORBIT;
    const ph = U.time.mul((2 * Math.PI) / period).add(seed.x.mul(0.05));
    const eddy = vec3(U.time.mul(mix(float(0.3), float(0.8), h(5))).add(h(6).mul(6.3)).sin(), U.time.mul(mix(float(0.25), float(0.6), h(7))).add(h(8).mul(6.3)).sin(), U.time.mul(mix(float(0.3), float(0.7), h(9))).add(h(10).mul(6.3)).cos()).mul(0.04);
    const world = seed.add(vec3(...SNOW_CURRENT).mul(U.time)).add(vec3(ph.cos().mul(orbit), ph.sin().mul(orbit), 0)).add(eddy);
    // (wrapped round the eye: the world place taken modulo the box about the eye)
    const rel = world.sub(cameraPosition).div(SNOW_BOX).fract().sub(0.5).mul(SNOW_BOX);
    const pos = cameraPosition.add(rel);
    const edge = max(max(rel.x.abs(), rel.y.abs()), rel.z.abs()).div(SNOW_BOX / 2);
    const dist = rel.length();
    // every size, most tiny; the near ones out of focus — drawn larger and fainter (a soft disc, never a dot field)
    const wanted = mix(float(0.0008), float(0.006), h(4).pow(3));
    const blur = float(0.02).mul(smoothstep(1.6, 0.3, dist));
    const drawn = max(max(wanted, blur), U.pixelAngle.mul(1.3).mul(dist));
    const coverage = wanted.div(drawn).pow(2);
    const lit = beam(pos);
    const material = new THREE.NodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;
    material.blending = THREE.AdditiveBlending;
    material.fog = false;
    material.positionNode = eyeFacing(pos, drawn);
    material.colorNode = Fn(() => {
      const r = uv().sub(0.5).mul(2).length();
      const dot = float(1).sub(smoothstep(0.1, 1, r));
      // (faded at the box's edge, where it wraps; dimmed with distance; none above the water; lit by the shafts only)
      const keep = float(1).sub(smoothstep(0.5, 0.9, edge)).mul(exp(dist.mul(-0.25))).mul(smoothstep(-0.05, -0.5, pos.y));
      return vec4(U.water.mul(lit.mul(9)).mul(dot).mul(min(coverage.mul(3), 1)).mul(keep), 1);
    })();
    material.name = 'line-down-snow';
    const mesh = billboardMesh(material, SNOW, 'line-down-snow');
    mesh.renderOrder = 9997;
    group.add(mesh);
    return mesh;
  })();

  // ── THE LENS: the waterline's foam, and the wet lens coming up ──────────────────────────────────────────────
  const drops = Array.from({ length: DROPS }, () => new THREE.Vector4());
  const uDrops = uniformArray(drops, 'vec4');
  const lens = (() => {
    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, transparent: true, depthTest: false, depthWrite: false, fog: false });
    const d = normalize(positionWorld.sub(cameraPosition));
    const out = Fn(() => {
      const col = vec3(0).toVar();
      const a = float(0).toVar();
      // THE WATERLINE'S FOAM: a band round the eye's level, a lace of foam racing through it
      const band = exp(d.y.div(FOAM_BAND).pow(2).negate());
      // (a lace of foam: sharp cells of bubbles in a coarser froth — a soft noise alone smeared into a blurred strip
      // across the dome's lower edge on the round-2 clip)
      const flow = vec3(U.time.mul(0.9), U.time.mul(-1.5), U.time.mul(0.7));
      const froth = smoothstep(0.3, 0.6, mx_noise_float(d.mul(9).add(flow)).mul(0.5).add(0.5));
      const cells = float(1).sub(smoothstep(0.08, 0.22, mx_worley_noise_float(d.mul(60).add(flow.mul(2)))));
      const foamA = U.foam.mul(band).mul(froth.mul(cells.mul(0.6).add(0.4)).mul(0.9));
      col.assign(U.light.mul(0.85));
      a.assign(foamA);
      // THE FILM: a thin sheet of water over the upper lens, its lower edge running down; a faint sheen in it
      If(U.film.greaterThan(0), () => {
        // (draining: dry above a line that runs from the zenith down past the eye's level as the film goes)
        const dry = float(1).sub(U.film.mul(1.3));
        const sheet = float(1).sub(smoothstep(dry.sub(0.05), dry.add(0.08), d.y)).mul(float(1).sub(U.film).mul(0.9).add(0.1));
        const sheen = mx_noise_float(vec3(d.x.mul(14), d.y.mul(5).add(U.time.mul(3)), d.z.mul(14))).mul(0.5).add(0.5);
        const filmA = sheet.mul(smoothstep(0.4, 0.9, sheen).mul(0.18).add(0.04));
        col.assign(mix(col, U.light.mul(1.1), filmA.div(a.add(filmA).max(1e-4))));
        a.assign(a.add(filmA).min(1));
      });
      // THE DROPS: the world turned over inside each (sky below, sea above) and a bright rim
      Loop({ start: int(0), end: int(U.dropCount), type: 'int', condition: '<' }, ({ i }: { i: Node }) => {
        const dr: Node = uDrops.element(i);
        const c = d.dot(dr.xyz);
        const ang = float(1).sub(c.min(1)).mul(2).sqrt();
        If(ang.lessThan(dr.w), () => {
          const k = ang.div(dr.w);
          // (its local up: the world's up, flattened onto the drop's tangent plane)
          const v = d.y.sub(dr.y.mul(c)).div(dr.w);
          // (round 2b: drawn near-opaque, the first drops read as grey balls hanging in the sky. A drop is clear: mostly
          // the world behind it, turned over and a little darker, a thin dark edge where it bends the light away, a
          // bright inner rim and a glint)
          const inside = mix(U.light.mul(0.95), U.light.mul(vec3(0.3, 0.38, 0.46)), smoothstep(-0.6, 0.5, v));
          const edge = smoothstep(0.86, 0.96, k).mul(float(1).sub(smoothstep(0.96, 1.0, k)));
          const rim = smoothstep(0.62, 0.82, k).mul(float(1).sub(smoothstep(0.82, 0.9, k)));
          const glint = float(1).sub(smoothstep(0.0, 0.18, vec2(k.mul(0.6), v.sub(0.5)).length())).mul(0.9);
          const dc = mix(inside.add(U.light.mul(rim.mul(0.6).add(glint))), U.light.mul(0.12), edge);
          const da = float(1).sub(smoothstep(0.96, 1.0, k)).mul(mix(float(0.22), float(0.75), max(edge, rim.mul(0.8))).add(glint.mul(0.3)).min(0.9));
          col.assign(mix(col, dc, da));
          a.assign(max(a, da));
        });
      });
      return vec4(col, a);
    })();
    material.colorNode = out.xyz;
    material.opacityNode = out.w;
    material.name = 'line-down-lens';
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(LENS_R, 64, 32), material);
    mesh.name = 'line-down-lens';
    mesh.frustumCulled = false;
    mesh.renderOrder = 9998;
    group.add(mesh);
    return mesh;
  })();

  for (const c of group.children) c.userData.lineDownOwn = true;
  const front = b.up.front ?? [0, -1];
  return {
    group,
    update(t, eye, foam, light, waterLight, under) {
      U.time.value = t;
      U.foam.value = foam;
      U.light.value.copy(light);
      U.water.value.copy(waterLight);
      lens.position.copy(eye);
      snowMesh.visible = under;
      // the wet lens: from the surfacing on, its film sheeting off over FILM_S s, its drops over their own lives
      const tau = t - b.up.t;
      const wet = WET_LENS && tau > 0 && tau < 1.6;
      U.film.value = wet ? Math.max(0, Math.min(1, tau / FILM_S)) : 0;
      if (U.film.value >= 1) U.film.value = 0;
      const ds = wet ? dropsAt(tau, front) : [];
      ds.forEach(([dir, r], i) => drops[i].set(dir.x, dir.y, dir.z, r));
      U.dropCount.value = ds.length;
      lens.visible = foam > 1e-3 || U.film.value > 0 || ds.length > 0;
    },
    setPixelAngle(rad) {
      U.pixelAngle.value = rad;
    },
  };
}
