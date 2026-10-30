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
 * AT DUSK AND NIGHT each shows one lantern, so they read as people out there: a lamp point drawn as the towers' beacons
 * are (radio/mast.ts THE LAMP) — an eye-facing point at least CORE_PX target pixels in radius whose core carries the
 * radiance the eye sees in its own resolution cell (EYE_CELL), its light LANTERN_CD candela through the air, warm, lit
 * on the raft lanterns' own curve (raftLanterns.ts lanternNight) and stepped down at night as the beacons are.
 */
import * as THREE from 'three/webgpu';
import { abs, cameraPosition, cameraProjectionMatrix, cross, float, modelWorldMatrixInverse, normalize, positionGeometry, select, smoothstep, uniform, uv, varying, vec3, vec4, viewport } from 'three/tsl';
import { coreProfile } from '../../radio/mast';

type V3 = THREE.Node<'vec3'>;

/** one of them: deg right of the front, m off, rad its heading turns off the course, its size against ours */
export interface FarRaft {
  bearing: number;
  distance: number;
  off: number;
  scale: number;
}

/** deg: the nearest a far raft stands to a Rose station's bearing (props.ts STATIONS) */
export const ROSE_CLEAR = 8;
export const FAR_RAFTS: FarRaft[] = [
  // near: backlit just right of the Sun (it sets at −22°), our size
  { bearing: -15, distance: 260, off: 0.25, scale: 1 },
  // near: canoe-sized, side-on to the low Sun on the left
  { bearing: -60, distance: 300, off: -0.5, scale: 0.65 },
  // far off: a bigger one, and two more
  { bearing: -78, distance: 1500, off: 0.15, scale: 1.35 },
  { bearing: 72, distance: 1300, off: -0.3, scale: 0.8 },
  { bearing: 128, distance: 1700, off: 0.4, scale: 1 },
];

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
