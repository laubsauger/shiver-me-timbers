/**
 * THE PEOPLE ON THE RAFT (c1–w2), as figures rather than capsules — still stand-ins (the user, 2026-10-27: crude
 * placeholders now, real assets in a later pass), but ones that read as people sitting and standing on a deck. The
 * capsule-and-ball blockers did not (the open notes, 2026-10-29: "Raft: capsule people"; the 2026-10-30 triage: in
 * every close view of the raft — the show's eye at 365 and 545 s, the chase at 460 s by lantern light — a tan pill
 * with a ball on it was the first thing the eye found).
 *
 * WHAT MAKES A FIGURE READ at 5–20 m is its silhouette and its weight: where the joints are, that a torso is wider at
 * the shoulders than at the waist and flatter front to back, that a sitting body folds at hip and knee and leans on its
 * hands or its knees, that a standing one carries its weight on one leg. So each figure is a small skeleton — joint
 * positions per pose, in metres, measured off an adult 1.75 m tall — dressed in tapered limbs between its joints
 * (lathed capsules), a lathed torso flattened front to back, a head with its hair, hands and feet. No face, no
 * fingers: at the raft's distances a face is a few pixels and fingers less.
 *
 * DRESS from the voyage (docs/raft2100/kon-tiki-reference.md: sun, salt, bare legs): a shirt with short sleeves, its
 * cloth faded; shorts; bare forearms, shins and feet. One wears a straw hat. Lit by the scene like everything else;
 * every part casts and takes shadow.
 *
 * Figure-local metres: the feet (standing) or the seat (sitting) on the deck at y = 0, facing −z (+x its right).
 */
import * as THREE from 'three/webgpu';
import { float, positionLocal, sin, vec3 } from 'three/tsl';

export type CrewPose = 'hug' | 'lean' | 'stand';

export interface CrewLook {
  /** sRGB hex: shirt, shorts, skin, hair */
  shirt: number;
  shorts: number;
  skin: number;
  hair: number;
  /** a straw hat */
  hat?: boolean;
}

type V = [number, number, number];

/** the joints of a pose (m); the paired ones [right (x > 0), left], `sym` mirroring one where the pose is symmetric */
interface Skeleton {
  pelvis: V;
  neck: V;
  head: V;
  hip: [V, V];
  knee: [V, V];
  ankle: [V, V];
  toe: [V, V];
  shoulder: [V, V];
  elbow: [V, V];
  wrist: [V, V];
}

const sym = (p: V): [V, V] => [p, [-p[0], p[1], p[2]]];

/**
 * THE POSES (m). `hug`: sitting on the deck, knees up, forearms over the knees, leaning a little into them — how people
 * sit on a raft's deck for hours. `lean`: sitting with the legs out, one knee drawn up a little, leaning back on the
 * hands. `stand`: the weight on one leg, the other knee eased, the right hand on the hip, the left arm hanging.
 */
const POSES: Record<CrewPose, Skeleton> = {
  hug: {
    pelvis: [0, 0.15, 0.04],
    neck: [0, 0.66, -0.06],
    head: [0, 0.79, -0.11],
    hip: sym([0.09, 0.13, 0.02]),
    knee: sym([0.12, 0.47, -0.34]),
    ankle: sym([0.11, 0.08, -0.46]),
    toe: sym([0.12, 0.03, -0.6]),
    shoulder: sym([0.18, 0.62, -0.04]),
    elbow: sym([0.21, 0.5, -0.29]),
    wrist: sym([0.06, 0.5, -0.4]),
  },
  lean: {
    pelvis: [0, 0.14, 0.02],
    neck: [0, 0.62, 0.17],
    head: [0, 0.77, 0.19],
    hip: sym([0.09, 0.12, 0]),
    knee: [[0.11, 0.2, -0.42], [-0.13, 0.36, -0.36]],
    ankle: [[0.13, 0.07, -0.84], [-0.14, 0.07, -0.68]],
    toe: [[0.15, 0.16, -0.89], [-0.16, 0.05, -0.82]],
    shoulder: sym([0.18, 0.59, 0.15]),
    elbow: sym([0.25, 0.33, 0.25]),
    wrist: sym([0.25, 0.05, 0.32]),
  },
  stand: {
    pelvis: [0, 0.95, 0],
    neck: [0, 1.46, 0.02],
    head: [0, 1.62, 0],
    hip: [[0.09, 0.93, 0], [-0.09, 0.95, 0]],
    knee: [[0.11, 0.51, -0.05], [-0.1, 0.5, -0.01]],
    ankle: [[0.12, 0.08, 0.0], [-0.11, 0.08, 0.02]],
    toe: [[0.15, 0.03, -0.14], [-0.12, 0.03, -0.13]],
    shoulder: [[0.19, 1.42, 0.02], [-0.19, 1.42, 0.02]],
    elbow: [[0.33, 1.17, 0.06], [-0.23, 1.15, 0.02]],
    wrist: [[0.17, 0.98, 0.02], [-0.22, 0.89, -0.05]],
  },
};

const Y = new THREE.Vector3(0, 1, 0);
const v3 = (p: V): THREE.Vector3 => new THREE.Vector3(p[0], p[1], p[2]);

/** a lathed capsule from `a` to `b` (m): radius r0 at a, r1 at b, round at both ends, a little fuller a third along */
function limb(a: V, b: V, r0: number, r1: number, mat: THREE.Material): THREE.Mesh {
  const A = v3(a);
  const d = v3(b).sub(A);
  const len = d.length();
  const pts: THREE.Vector2[] = [];
  const CAP = 4;
  for (let i = 0; i <= CAP; i++) {
    const t = (i / CAP) * (Math.PI / 2);
    pts.push(new THREE.Vector2(r0 * Math.sin(t), -r0 * Math.cos(t)));
  }
  pts.push(new THREE.Vector2(Math.max(r0, r1) * 1.05 + (r0 - r1) * 0.1, len * 0.33));
  for (let i = 0; i <= CAP; i++) {
    const t = (i / CAP) * (Math.PI / 2);
    pts.push(new THREE.Vector2(r1 * Math.cos(t), len + r1 * Math.sin(t)));
  }
  const mesh = new THREE.Mesh(new THREE.LatheGeometry(pts, 12), mat);
  mesh.position.copy(A);
  mesh.quaternion.setFromUnitVectors(Y, d.normalize());
  return mesh;
}

/** the torso, pelvis to neck: lathed (hips, waist, chest, shoulders, the neck's root) and flattened front to back */
function torso(from: V, to: V, mat: THREE.Material): THREE.Mesh {
  const A = v3(from);
  const d = v3(to).sub(A);
  const L = d.length();
  // (r m, at a fraction of the length)
  const profile: Array<[number, number]> = [
    [0, -0.02],
    [0.13, 0],
    [0.158, 0.1],
    [0.142, 0.36],
    [0.164, 0.62],
    [0.172, 0.8],
    [0.13, 0.94],
    [0.06, 1.0],
    [0, 1.02],
  ];
  const mesh = new THREE.Mesh(new THREE.LatheGeometry(profile.map(([r, f]) => new THREE.Vector2(r, f * L)), 16), mat);
  mesh.position.copy(A);
  mesh.quaternion.setFromUnitVectors(Y, d.normalize());
  mesh.scale.set(1, 1, 0.62);
  return mesh;
}

/** cloth or skin, lit: its colour broken a little by fold-scale shading, so a flat sleeve does not read as plastic */
function material(hex: number, roughness: number, folds: number): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness, metalness: 0 });
  m.name = 'drift-crew';
  const base = new THREE.Color(hex);
  const p = positionLocal;
  // (a few creases' worth of light and dark, ~4–6 cm apart: no texture, no noise to crawl at range)
  const crease = sin(p.y.mul(97).add(sin(p.x.mul(41)).mul(2))).mul(sin(p.z.mul(73).add(p.y.mul(11)))).mul(folds);
  m.colorNode = vec3(base.r, base.g, base.b).mul(float(1).add(crease));
  return m;
}

/** a crew figure in `pose`, dressed as `look` (figure-local metres, see the header) */
export function createCrewFigure(pose: CrewPose, look: CrewLook): THREE.Group {
  const k = POSES[pose];
  const shirt = material(look.shirt, 0.92, 0.05);
  const shorts = material(look.shorts, 0.9, 0.05);
  const skin = material(look.skin, 0.58, 0);
  const hair = material(look.hair, 0.75, 0);
  const g = new THREE.Group();
  g.name = `drift-crew-${pose}`;

  g.add(torso(k.pelvis, k.neck, shirt));
  // the seat of the shorts round the hips
  const seat = new THREE.Mesh(new THREE.SphereGeometry(0.16, 14, 10), shorts);
  seat.position.copy(v3(k.pelvis));
  seat.scale.set(1, 0.62, 0.78);
  g.add(seat);
  for (const s of [0, 1] as const) {
    // legs: shorts to just over the knee, bare below; feet bare
    const above: V = [
      k.hip[s][0] + (k.knee[s][0] - k.hip[s][0]) * 0.8,
      k.hip[s][1] + (k.knee[s][1] - k.hip[s][1]) * 0.8,
      k.hip[s][2] + (k.knee[s][2] - k.hip[s][2]) * 0.8,
    ];
    g.add(limb(k.hip[s], above, 0.078, 0.062, shorts));
    g.add(limb(above, k.knee[s], 0.056, 0.05, skin));
    g.add(limb(k.knee[s], k.ankle[s], 0.05, 0.034, skin));
    g.add(limb(k.ankle[s], k.toe[s], 0.036, 0.03, skin));
    // arms: short sleeves to mid upper arm, bare below, a hand at the wrist
    const sleeve: V = [
      k.shoulder[s][0] + (k.elbow[s][0] - k.shoulder[s][0]) * 0.55,
      k.shoulder[s][1] + (k.elbow[s][1] - k.shoulder[s][1]) * 0.55,
      k.shoulder[s][2] + (k.elbow[s][2] - k.shoulder[s][2]) * 0.55,
    ];
    g.add(limb(k.shoulder[s], sleeve, 0.058, 0.052, shirt));
    g.add(limb(sleeve, k.elbow[s], 0.042, 0.037, skin));
    g.add(limb(k.elbow[s], k.wrist[s], 0.036, 0.027, skin));
    const fore = v3(k.wrist[s]).sub(v3(k.elbow[s])).normalize();
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), skin);
    hand.position.copy(v3(k.wrist[s]).addScaledVector(fore, 0.06));
    hand.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), fore);
    hand.scale.set(0.85, 0.5, 1.35);
    g.add(hand);
  }
  g.add(...headOf(k, look, skin, hair));
  g.traverse((o) => {
    o.castShadow = true;
    o.receiveShadow = true;
  });
  return g;
}

/** the neck, the head (a little longer than wide, a jaw's worth deeper at the front), the hair over its crown and
 * back, and the straw hat if it has one */
function headOf(k: Skeleton, look: CrewLook, skin: THREE.Material, hair: THREE.Material): THREE.Object3D[] {
  const g: THREE.Object3D[] = [];
  const add = (...o: THREE.Object3D[]): number => g.push(...o);
  const head = v3(k.head);
  const neckTop = head.clone().add(new THREE.Vector3(0, -0.08, 0.01));
  add(limb(k.neck, [neckTop.x, neckTop.y, neckTop.z], 0.05, 0.046, skin));
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.1, 18, 14), skin);
  skull.position.copy(head);
  skull.scale.set(0.86, 1.12, 0.98);
  add(skull);
  const jaw = new THREE.Mesh(new THREE.SphereGeometry(0.062, 12, 8), skin);
  jaw.position.copy(head).add(new THREE.Vector3(0, -0.06, -0.035));
  jaw.scale.set(1, 0.85, 1);
  add(jaw);
  const crown = new THREE.Mesh(new THREE.SphereGeometry(0.104, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.56), hair);
  crown.position.copy(head).add(new THREE.Vector3(0, 0.008, 0.012));
  crown.rotation.x = 0.42;
  crown.scale.set(0.9, 1.1, 1.02);
  add(crown);
  if (look.hat) {
    const straw = material(0xb59a62, 0.95, 0.12);
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.22, 0.012, 28), straw);
    brim.position.copy(head).add(new THREE.Vector3(0, 0.06, 0));
    brim.rotation.x = 0.12;
    const top = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.104, 0.1, 20), straw);
    top.position.copy(head).add(new THREE.Vector3(0, 0.11, 0.005));
    top.rotation.x = 0.12;
    add(brim, top);
  }
  return g;
}

/**
 * THE WANDERERS WALKING (w5, props.ts): the crew ashore, walking on along the waterline. The box-limbed stand-ins
 * they had been read as "the crudest thing in the act" (the 2026-10-30 QA sweep: "box-limbed, pure-black stand-ins …
 * bold black stick figures"); these are the raft's own three, dressed as they were aboard, on the same skeleton,
 * jointed at hip, knee, ankle, shoulder and elbow so they walk.
 *
 * THE WALK, per stride (two steps; `phase` counts strides): each thigh swings ±WALK_HIP about its hip (the stride's
 * length is 4·leg·sin of it: 0.41 rad and a 0.85 m leg make a 1.36 m stride, an adult's at ~1.2 m/s); the knee bends
 * most mid-swing (WALK_KNEE) and stays soft in stance; the foot stays level; the arms swing against the legs
 * (WALK_ARM) with the elbows bending more on the forward swing; and the body rides up over the straight stance leg,
 * lowest at each double support (the leg's own geometry, about 6 cm).
 */
const WALK: Skeleton = {
  pelvis: [0, 0.95, 0],
  neck: [0, 1.46, -0.02],
  head: [0, 1.62, -0.03],
  hip: sym([0.09, 0.93, 0]),
  knee: sym([0.1, 0.51, 0]),
  ankle: sym([0.1, 0.08, 0.02]),
  toe: sym([0.11, 0.03, -0.13]),
  // (the arms in to the body: from the stand pose's 0.19–0.23 m out they hung off the torso like a mannequin's, the
  // first round's 690 s still)
  shoulder: sym([0.172, 1.41, 0.0]),
  elbow: sym([0.19, 1.14, 0.03]),
  wrist: sym([0.19, 0.89, -0.01]),
};
/** rad: the thigh's swing either way, the knee's bend mid-swing (and in stance), the arm's swing */
const WALK_HIP = 0.41;
const WALK_KNEE: [number, number] = [0.95, 0.08];
const WALK_ARM = 0.32;
/** m: hip to ankle (WALK) — the stance leg's drop as it swings through */
const WALK_LEG = 0.85;
/** m per stride for a figure `height` m tall: what WALK_HIP makes of its legs */
export const strideLength = (height: number): number => 4 * WALK_LEG * Math.sin(WALK_HIP) * (height / 1.75);

/** a walker's pose (THE WANDERERS WALKING, and what they do between their strides) */
export interface WalkerPose {
  /** strides into its walk */
  phase: number;
  /** 0 … 1: how far its stride swings (0: standing, its feet together; a slow walk swings less) */
  amp: number;
  /** 0 … 1: bent to the sand at the waist and knees, the right hand down to it (picking something up) */
  stoop: number;
  /** rad: its head turned (+ to its left), its shoulders a third as far */
  look: number;
}

export interface CrewWalker {
  /** feet at its origin, facing −z */
  readonly group: THREE.Group;
  /** pose it `phase` strides into its walk, in its full stride */
  stride(phase: number): void;
  /** pose it as `p` */
  pose(p: WalkerPose): void;
  /** its two feet's joints (at the ankle; their world positions once posed and the matrices updated): what its
   * contact shade on the sand follows (props.ts) */
  readonly feet: readonly THREE.Object3D[];
}

/** rad at a full stoop: the upper body forward at the waist, the thighs forward, the knees bent, the reaching arm
 * forward (a person picking a shell off wet sand bends at the waist more than the knees) */
const STOOP = { waist: 1.05, thigh: 0.35, knee: 0.75, reach: 0.65 };

/** one of the crew walking, dressed as `look`, `height` m tall (THE WANDERERS WALKING) */
export function createCrewWalker(look: CrewLook, height: number): CrewWalker {
  const k = WALK;
  const shirt = material(look.shirt, 0.92, 0.05);
  const shorts = material(look.shorts, 0.9, 0.05);
  const skin = material(look.skin, 0.58, 0);
  const hair = material(look.hair, 0.75, 0);
  const g = new THREE.Group();
  g.name = 'drift-crew-walker';
  // everything rides on the body, which rises and falls over the stance leg; the upper body on it bends at the
  // pelvis (stooping), the head on that turns at the neck (looking round)
  const body = new THREE.Group();
  g.add(body);
  const upper = new THREE.Group();
  upper.position.copy(v3(k.pelvis));
  body.add(upper);
  const chest = torso(k.pelvis, k.neck, shirt);
  chest.position.sub(v3(k.pelvis));
  upper.add(chest);
  const neck = new THREE.Group();
  neck.position.copy(v3(k.neck)).sub(v3(k.pelvis));
  upper.add(neck);
  for (const o of headOf(k, look, skin, hair)) {
    o.position.sub(v3(k.neck));
    neck.add(o);
  }
  const seat = new THREE.Mesh(new THREE.SphereGeometry(0.16, 14, 10), shorts);
  seat.position.copy(v3(k.pelvis));
  seat.scale.set(1, 0.62, 0.78);
  body.add(seat);
  const O: V = [0, 0, 0];
  const rel = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const part = (a: V, f: number): V => [a[0] * f, a[1] * f, a[2] * f];
  /** a joint: a pivot at `at` (in its parent's frame) */
  const joint = (parent: THREE.Object3D, at: V): THREE.Group => {
    const j = new THREE.Group();
    j.position.copy(v3(at));
    parent.add(j);
    return j;
  };
  const legs = ([0, 1] as const).map((s) => {
    const hip = joint(body, k.hip[s]);
    const knee = rel(k.knee[s], k.hip[s]);
    const above = part(knee, 0.8);
    hip.add(limb(O, above, 0.078, 0.062, shorts), limb(above, knee, 0.056, 0.05, skin));
    const shin = joint(hip, knee);
    const ankle = rel(k.ankle[s], k.knee[s]);
    shin.add(limb(O, ankle, 0.05, 0.034, skin));
    const foot = joint(shin, ankle);
    foot.add(limb(O, rel(k.toe[s], k.ankle[s]), 0.036, 0.03, skin));
    return { hip, shin, foot };
  });
  const arms = ([0, 1] as const).map((s) => {
    const shoulder = joint(upper, rel(k.shoulder[s], k.pelvis));
    const elbow = rel(k.elbow[s], k.shoulder[s]);
    const sleeve = part(elbow, 0.55);
    shoulder.add(limb(O, sleeve, 0.058, 0.052, shirt), limb(sleeve, elbow, 0.042, 0.037, skin));
    const fore = joint(shoulder, elbow);
    const wrist = rel(k.wrist[s], k.elbow[s]);
    fore.add(limb(O, wrist, 0.036, 0.027, skin));
    const dir = v3(wrist).normalize();
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), skin);
    hand.position.copy(v3(wrist).addScaledVector(dir, 0.06));
    hand.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    hand.scale.set(0.85, 0.5, 1.35);
    fore.add(hand);
    return { shoulder, fore };
  });
  g.scale.setScalar(height / 1.75);
  g.traverse((o) => {
    o.castShadow = true;
    o.receiveShadow = true;
  });
  const pose = ({ phase, amp, stoop, look }: WalkerPose): void => {
    // (rotation about x: + swings a limb forward, toward −z; the left side half a stride behind the right)
    for (const s of [0, 1] as const) {
      const w = 2 * Math.PI * (phase + s * 0.5);
      const thigh = amp * WALK_HIP * Math.sin(w) + STOOP.thigh * stoop;
      const bend = (WALK_KNEE[1] + (WALK_KNEE[0] - WALK_KNEE[1]) * Math.max(0, Math.cos(w)) ** 2) * amp + STOOP.knee * stoop;
      legs[s].hip.rotation.x = thigh;
      legs[s].shin.rotation.x = -bend;
      legs[s].foot.rotation.x = bend - thigh;
      const arm = -amp * WALK_ARM * Math.sin(w);
      // (the right hand reaches down to the sand as it stoops)
      arms[s].shoulder.rotation.x = arm * (1 - stoop) + (s === 0 ? STOOP.reach * stoop : 0.2 * stoop);
      arms[s].fore.rotation.x = (0.25 + 0.3 * Math.max(0, arm / WALK_ARM)) * (1 - 0.6 * stoop);
    }
    upper.rotation.set(-STOOP.waist * stoop, look / 3, 0, 'YXZ');
    neck.rotation.set(0.25 * stoop, (2 * look) / 3, 0, 'YXZ');
    // the stance leg is the one swinging back (its thigh's angle falling): the body over it, highest as it passes
    // under the hip (straight down), lowest at double support; and lower as the knees bend to stoop (the hip's
    // height over the ankle with the thigh forward and the shin back, about 7 cm at a full stoop)
    const stance = amp * WALK_HIP * Math.sin(2 * Math.PI * phase);
    const crouch = 1 - 0.5 * (Math.cos(STOOP.thigh * stoop) + Math.cos((STOOP.thigh - STOOP.knee) * stoop));
    body.position.y = -WALK_LEG * (1 - Math.cos(stance)) - WALK_LEG * crouch;
  };
  return {
    group: g,
    stride: (phase) => pose({ phase, amp: 1, stoop: 0, look: 0 }),
    pose,
    feet: legs.map((l) => l.foot),
  };
}

/** the three aboard: their poses and clothes (faded, salt-stained colours; nothing bright) */
export const CREW: Array<{ pose: CrewPose; look: CrewLook; x: number; z: number; rot: number }> = [
  { pose: 'hug', look: { shirt: 0x8a6a52, shorts: 0x3e3a33, skin: 0x8a6650, hair: 0x2a221c }, x: -0.9, z: 1.2, rot: 0.6 },
  { pose: 'lean', look: { shirt: 0x6f8290, shorts: 0x524636, skin: 0x7a5844, hair: 0x1c1814, hat: true }, x: 0.7, z: 2.2, rot: -0.5 },
  { pose: 'stand', look: { shirt: 0xb9ab8e, shorts: 0x47505a, skin: 0x93705a, hair: 0x3b2a1e }, x: 0.2, z: -1.8, rot: 2.6 },
];
