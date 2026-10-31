/**
 * THE OTHER RAFTS (c2–c4; direction.md, C2: "other rafts and small vessels far off on the horizon, each alone, all
 * drifting the same way").
 *
 * They were five copies of our raft at 950–2100 m, which the user could not read on a c2 sunset frame (2026-10-30):
 * "What are these things far in the distance? Are these pirate ships, or two other rafts? What are these things at the
 * bottom left, and to the right in front of the sail on the horizon?" An 8 m raft at 1.5 km is a third of a degree,
 * a dark speck on the horizon line, and the two on the right stood behind our own sail.
 *
 * So two come nearer, where the eye looks: one just right of the Sun (c2–c3's Sun stands 22° left of the front), a
 * silhouette — square sail, hut — against the brightest of the sunset; one canoe-sized one further left, side-on to the
 * low Sun, its sail catching it. How near: our raft stands 8.3 m over the water (its blueprint's mast top) and is 17 m
 * long. At 480 m that is ~1°, ~20 px of a 1280 px 16:9 frame — a speck again; at 300 m (the first round's farm stills,
 * 2026-10-30) the square sail and the hut read in a tele but still small in the 60° frame; so 260 m (~1.8°, ~40 px),
 * and the canoe-sized one (0.65 of ours) at 300 m. The rest stay far off, sizes varied (one bigger, one smaller), all
 * on the left or well round to the right, where our raft (24° right at 15 m: sea.ts) does not cover them. None within
 * ROSE_CLEAR of a Rose station's bearing (props.ts STATIONS: their islands stand 7 km off, ±4°), none on the eye's way.
 * They keep their places about the eye (they drift as we do) and their own headings off the course (not our raft's:
 * it swings broadside in c3 and they did with it), and they float on the sea at their own place: pure in t.
 *
 * NOT OUR RAFT (the 2026-10-31 review, at the sea's first shot: "not one but two copies of our raft … doing stuff" in
 * the distance, read as our main character duplicated — "we shouldn't have stuff bleed from one shot to another,
 * especially our singular main character"). They were copies of our raft (wandering/raft.ts `far`), and they were
 * switched on with the follow at 335 s, popping in mid-shot ("suddenly we see a second raft in the distance"). So:
 * each is its own, smaller craft, with nothing of ours — an outrigger canoe under a rust crab-claw sail, or a little log
 * raft with a blue tarp lean-to and a tarp on a pole (FarCraftKind) — and they belong to c2–c4 only, the sunset and the
 * night: from c2's start they come up out of the haze over FAR_FADE s (their opacity, `farRaftsIn`), a pure function
 * of the sea's clock, so a dissolve's two beats see the same.
 *
 * AT DUSK AND NIGHT each shows one lantern, so they read as people out there: a lamp point drawn as the towers' beacons
 * are (radio/mast.ts THE LAMP) — an eye-facing point at least CORE_PX target pixels in radius whose core carries the
 * radiance the eye sees in its own resolution cell (EYE_CELL), its light LANTERN_CD candela through the air, warm, lit
 * on the raft lanterns' own curve (raftLanterns.ts lanternNight) and stepped down at night as the beacons are.
 */
import * as THREE from 'three/webgpu';
import { abs, cameraPosition, cameraProjectionMatrix, color, cross, float, modelWorldMatrixInverse, normalize, positionGeometry, select, smoothstep, uniform, uv, varying, vec3, vec4, viewport } from 'three/tsl';
import { coreProfile } from '../../radio/mast';

type V3 = THREE.Node<'vec3'>;

/** what each is (NOT OUR RAFT): an outrigger canoe under a crab-claw sail, or a small log raft with a tarp lean-to */
export type FarCraftKind = 'canoe' | 'tarp';
/** m: each kind's length and its top over the water at scale 1 (what `createFarCraft` builds) */
export const FAR_CRAFT_SIZE: Record<FarCraftKind, { length: number; height: number }> = {
  canoe: { length: 6.5, height: 5.2 },
  tarp: { length: 4.2, height: 3.3 },
};
/** m: our raft's length and its mast top over the water (its blueprint's), which no far craft may come near */
export const OUR_RAFT = { length: 17, height: 8.3 };
/** rad: the canoe's crab-claw rig swung out over the side about its foot (running before the wind) */
const CLAW_OUT = 1.1;
/** s: from c2's start, the far craft come up out of the haze over this (their opacity) */
export const FAR_FADE = 10;

/** one of them: deg right of the front, m off, rad its heading turns off the course, what it is, its size against
 * its kind's (FAR_CRAFT_SIZE) */
export interface FarRaft {
  bearing: number;
  distance: number;
  off: number;
  kind: FarCraftKind;
  scale: number;
}

/** deg: the nearest a far raft stands to a Rose station's bearing (props.ts STATIONS) */
export const ROSE_CLEAR = 8;
export const FAR_RAFTS: FarRaft[] = [
  // near: backlit just right of the Sun (it sets at −22°): the crab-claw sail's silhouette against the sunset
  { bearing: -15, distance: 260, off: 0.25, kind: 'canoe', scale: 1 },
  // near: the little tarp raft, side-on to the low Sun on the left
  { bearing: -60, distance: 300, off: -0.5, kind: 'tarp', scale: 1 },
  // far off: a bigger canoe, and two more
  { bearing: -78, distance: 1500, off: 0.15, kind: 'canoe', scale: 1.35 },
  { bearing: 72, distance: 1300, off: -0.3, kind: 'tarp', scale: 0.8 },
  { bearing: 128, distance: 1700, off: 0.4, kind: 'canoe', scale: 0.85 },
];

/** 0 … 1: the far craft's opacity at sea time t, from c2's start (sea s); 0 before it */
export function farRaftsIn(t: number, c2: number): number {
  const k = Math.min(1, Math.max(0, (t - c2) / FAR_FADE));
  return k * k * (3 - 2 * k);
}

export interface FarCraft {
  readonly group: THREE.Group;
  /** the lantern's place (an empty, for its world position) */
  readonly lamp: THREE.Object3D;
  /** float it at (x, z) m on heading (rad, 0 = bow toward +z) at sea time t */
  update(t: number, x: number, z: number, heading: number): void;
}

/** the far craft's look, shared by all of them: one opacity (`farRaftsIn`), plain lit surfaces (a few pixels to ~40) */
export function createFarCraftLook(): { fade: THREE.UniformNode<'float', number>; material(hex: number, roughness: number, sided?: boolean): THREE.MeshStandardNodeMaterial } {
  const fade = uniform(0);
  const made = new Map<string, THREE.MeshStandardNodeMaterial>();
  return {
    fade,
    material(hex, roughness, sided = false) {
      const key = `${hex}/${roughness}/${sided}`;
      let m = made.get(key);
      if (!m) {
        m = new THREE.MeshStandardNodeMaterial({ roughness, metalness: 0, transparent: true, side: sided ? THREE.DoubleSide : THREE.FrontSide });
        m.colorNode = color(hex);
        m.opacityNode = fade;
        m.name = 'drift-far-craft';
        made.set(key, m);
      }
      return m;
    },
  };
}

/**
 * One far craft (NOT OUR RAFT), its waterline at y = 0, bow toward +z, floated on the sea by four taps.
 *   canoe: a dugout 6.5 m by 0.7 m, an outrigger float 2.3 m out to port on two booms, a raked mast and a rust
 *          crab-claw sail (two spars meeting low at the bow, the cloth's top edge hollowed);
 *   tarp:  five logs 4.2 m long, a blue tarp lean-to aft, a pole forward with a small grey-blue tarp sail set askew.
 */
export function createFarCraft(kind: FarCraftKind, look: ReturnType<typeof createFarCraftLook>, heightAt: (x: number, z: number, t: number) => number): FarCraft {
  const group = new THREE.Group();
  group.name = `drift-far-craft-${kind}`;
  const body = new THREE.Group();
  group.add(body);
  const wood = look.material(0x3b2a1e, 0.85);
  const pale = look.material(0x6b5440, 0.85);
  const add = (geo: THREE.BufferGeometry, m: THREE.Material, at: [number, number, number], rot: [number, number, number] = [0, 0, 0], to: THREE.Object3D = body): THREE.Mesh => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(...at);
    mesh.rotation.set(...rot);
    to.add(mesh);
    return mesh;
  };
  /** a spar from a to b, r m */
  const spar = (a: THREE.Vector3, b: THREE.Vector3, r: number, m: THREE.Material, to: THREE.Object3D = body): void => {
    const d = b.clone().sub(a);
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, d.length(), 6), m);
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    to.add(mesh);
  };
  const lamp = new THREE.Object3D();
  lamp.name = 'far-lamp';
  body.add(lamp);
  const { length } = FAR_CRAFT_SIZE[kind];
  let beam: number;
  if (kind === 'canoe') {
    beam = 2.6;
    // the dugout: a capsule along z, flattened, a third of it under
    const hull = add(new THREE.CapsuleGeometry(0.35, length - 0.7, 4, 10), wood, [0, 0.08, 0], [Math.PI / 2, 0, 0]);
    hull.scale.set(1, 1, 0.75);
    // the float and its booms, to port (−x)
    add(new THREE.CapsuleGeometry(0.13, 3.2, 3, 8), wood, [-2.3, 0.04, 0.2], [Math.PI / 2, 0, 0]);
    for (const z of [-0.9, 1.3]) spar(new THREE.Vector3(0.2, 0.32, z), new THREE.Vector3(-2.3, 0.18, z + 0.1), 0.045, pale);
    // the crab claw: its two spars from a foot low near the bow, the cloth between them, its head hollowed — the
    // whole rig swung out over the side about its foot (CLAW_OUT), as a crab claw runs before the wind: laid along the
    // hull, a craft sailing our way showed it edge-on, a bare pole (the first stills, 2026-10-31)
    const claw = new THREE.Group();
    claw.position.set(0, 0.4, 2.2);
    claw.rotation.y = CLAW_OUT;
    body.add(claw);
    const foot = new THREE.Vector3(0, 0, 0);
    const upper = new THREE.Vector3(0, 4.8, -2.8);
    const lower = new THREE.Vector3(0, 1.6, -4.8);
    spar(foot, upper, 0.05, pale, claw);
    spar(foot, lower, 0.045, pale, claw);
    spar(new THREE.Vector3(0, 0.3, 0.9), new THREE.Vector3(0, 3.4, 0.4), 0.06, wood);
    const shape = new THREE.Shape();
    // (in the sail's plane: x along the hull toward the bow is −z here, y up)
    const P = (v: THREE.Vector3): [number, number] => [-v.z, v.y];
    shape.moveTo(...P(foot));
    shape.lineTo(...P(upper));
    // the hollowed head between the claws' tips
    shape.quadraticCurveTo(1.8, 2.6, ...P(lower));
    shape.lineTo(...P(foot));
    const sail = add(new THREE.ShapeGeometry(shape, 8), look.material(0x8a4a2a, 0.9, true), [0, 0, 0], [0, Math.PI / 2, 0], claw);
    sail.name = 'far-sail';
    lamp.position.set(0, 1.2, -2.6);
  } else {
    beam = 2.0;
    for (let i = 0; i < 5; i++) {
      add(new THREE.CylinderGeometry(0.18, 0.2, length, 8), wood, [(i - 2) * 0.4, 0.06, 0], [Math.PI / 2, 0, 0]);
    }
    // the lean-to aft: two tarp planes in an A over a ridge pole
    const tarp = look.material(0x2f5f8a, 0.8, true);
    for (const side of [-1, 1]) {
      // (laid flat along the logs, then pitched down outboard: Rx first, so the order is ZYX)
      add(new THREE.PlaneGeometry(1.3, 1.9), tarp, [side * 0.42, 0.75, -1.0]).rotation.set(-Math.PI / 2, 0, -side * 0.72, 'ZYX');
    }
    spar(new THREE.Vector3(0, 1.25, -2.0), new THREE.Vector3(0, 1.25, 0), 0.04, pale);
    // the pole forward and its tarp, set askew between a sprit and the pole
    spar(new THREE.Vector3(0.2, 0.2, 1.2), new THREE.Vector3(0.25, 3.3, 1.05), 0.05, pale);
    const rag = new THREE.Shape();
    rag.moveTo(0, 0);
    rag.lineTo(1.7, 0.2);
    rag.lineTo(1.5, 1.7);
    rag.lineTo(0, 1.4);
    rag.lineTo(0, 0);
    // (set well across the logs, as a square-ish rag runs before the wind: along them it was edge-on to us)
    add(new THREE.ShapeGeometry(rag), look.material(0x4d6f86, 0.85, true), [0.25, 1.4, 1.1], [0, Math.PI / 2 + 1.15, 0]).name = 'far-sail';
    lamp.position.set(0.25, 2.2, 1.2);
  }
  body.traverse((o) => {
    o.castShadow = false;
    o.receiveShadow = false;
  });
  const half = length / 2;
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  return {
    group,
    lamp,
    update(t, x, z, heading) {
      const k = group.scale.x;
      const c = Math.cos(heading);
      const sn = Math.sin(heading);
      const at = (u: number, v: number): number => heightAt(x + (u * c + v * sn) * k, z + (-u * sn + v * c) * k, t);
      const bow = at(0, half);
      const stern = at(0, -half);
      const port = at(-beam / 2, 0);
      const stbd = at(beam / 2, 0);
      group.position.set(x, (bow + stern + port + stbd) / 4, z);
      euler.set(-Math.atan2(bow - stern, length * k), heading, Math.atan2(stbd - port, beam * k));
      group.quaternion.setFromEuler(euler);
      group.updateMatrixWorld(true);
    },
  };
}

/** cd: a pressure lantern hung up to be seen (a hurricane lantern is ~10) */
const LANTERN_CD = 25;
/** lux in the film's unit of irradiance (radioTower.ts LUX_PER_UNIT: the Sun's 7 is ~128 000 lux) */
const LUX_PER_UNIT = 128000 / 7;
/** rad: the eye's resolution cell; target px the core is drawn at least; m its least size (radioTower.ts filmLamp) */
const EYE_CELL = 0.12e-3;
const CORE_PX = 1.6;
const LENS = 0.1;
/** the glow: the share of the light the air scatters out of the beam, drawn over this many rad */
const GLOW = { share: 0.5, radius: 1.5e-3 };
/** m of marine air a lantern's light falls by e over */
const AIR = 8500;
/** a candle's/kerosene flame's 1800 K, at unit luminance */
const FLAME: [number, number, number] = [1, 0.55, 0.22].map((c) => c / (0.2126 + 0.7152 * 0.55 + 0.0722 * 0.22)) as [number, number, number];
/** ∫ coreProfile over the unit disc, and the glow's (1 − ρ²)³ (π/4) */
const CORE_AREA = (() => {
  let a = 0;
  const n = 2000;
  for (let i = 0; i < n; i++) {
    const r = (i + 0.5) / n;
    a += coreProfile(r) * 2 * Math.PI * r * (1 / n);
  }
  return a;
})();
const GLOW_AREA = Math.PI / 4;

export interface FarLantern {
  readonly mesh: THREE.Mesh;
  /** per pass: the lantern's world position, the eye's, and its level (0 out … 1 lit, × the night step) */
  update(at: THREE.Vector3, eye: THREE.Vector3, level: number): void;
}

/** a far raft's lantern as a lamp point (THE OTHER RAFTS, AT DUSK AND NIGHT) */
export function createFarLantern(): FarLantern {
  const at = uniform(new THREE.Vector3());
  /** scene units: the irradiance at the eye (the cd through the air over d²), and the glow's share of it */
  const E = uniform(0);
  const S = uniform(0);
  const lampW = at as unknown as V3;
  // (drawn a metre toward the eye, clear of the hut it hangs from)
  const centre = lampW.add(cameraPosition.sub(lampW).normalize().mul(1)) as V3;
  const dist = centre.sub(cameraPosition).length();
  // (a target pixel's angle at the view's centre: the same in every face of the cube capture)
  const pixel = float(2).div(cameraProjectionMatrix.mul(vec4(1, 0, 0, 0)).x.abs().mul(viewport.z));
  const coreAng = dist.mul(pixel).mul(CORE_PX).max(LENS).div(dist);
  const glowAng = coreAng.mul(2).max(GLOW.radius);
  const toEye = normalize(cameraPosition.sub(centre));
  const up0 = select(abs(toEye.y).greaterThan(0.98), vec3(1, 0, 0), vec3(0, 1, 0)) as V3;
  const right = normalize(cross(up0, toEye));
  const upv = cross(toEye, right);
  const size = dist.mul(glowAng).mul(2);
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  const cornerW = centre.add(right.mul(positionGeometry.x.mul(size))).add(upv.mul(positionGeometry.y.mul(size)));
  m.positionNode = modelWorldMatrixInverse.mul(vec4(cornerW, 1)).xyz;
  const vCore = varying(coreAng);
  const vGlow = varying(glowAng);
  const drawn = vCore.mul(vCore).mul(CORE_AREA);
  const coreL = E.div(drawn.min(Math.PI * EYE_CELL * EYE_CELL));
  const across = uv().sub(0.5).mul(2).length();
  const core = float(1).sub(smoothstep(0.5, 1, across.mul(vGlow).div(vCore)));
  const glowL = S.div(vGlow.mul(vGlow).mul(GLOW_AREA)).mul(float(1).sub(across.mul(across)).max(0).pow(3));
  m.colorNode = vec4(vec3(...FLAME).mul(coreL.mul(core).add(glowL)), 1);
  m.name = 'drift-far-lantern';
  // (the quad is placed in world space by its positionNode, whatever group it is added to: never culled)
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), m);
  mesh.name = 'drift-far-lantern';
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  return {
    mesh,
    update(p, eye, level) {
      (at.value as THREE.Vector3).copy(p);
      const d = Math.max(1, p.distanceTo(eye));
      const T = Math.exp(-d / AIR);
      const I = (LANTERN_CD / LUX_PER_UNIT) * level;
      E.value = (I * T) / (d * d);
      S.value = (GLOW.share * (1 - T) * I) / (d * d);
      mesh.visible = level > 0;
    },
  };
}
