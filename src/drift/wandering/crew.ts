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
 *
 * POSED EVERY FRAME (the 2026-11-02 review: "they look like very cheap characters, they look out of place, and they're
 * sitting and standing sometimes in weird spots. When the dolphin comes there's no reaction from them … Maybe there
 * are ways, without having to dig too deep, to make this feel more alive"). The figures aboard had been built once,
 * frozen in their pose, so nothing about them could move. Now each is a RIG (createCrewRig): the same parts, re-laid
 * every frame between joints that `solveCrew` works out from a pose blend (sitting to standing, kneeling to upright)
 * and what the figure is doing (crewLife.ts: looking at something, pointing, shading its eyes, working a line in its
 * lap, a hand on the steering oar), its limbs held to their lengths by a two-bone reach (knees and elbows found from hip
 * and ankle, shoulder and hand), breathing, shifting its weight, and leaning against the raft's roll. Every input is a
 * function of show time, so the pose is too.
 */
import * as THREE from 'three/webgpu';
import { float, max, positionLocal, sin, vec3 } from 'three/tsl';

export type CrewPose = 'hug' | 'lean' | 'stand' | 'kneel' | 'kneelAt' | 'kneelUp' | 'edge' | 'sill';

export interface CrewLook {
  /** sRGB hex: shirt, shorts, skin, hair */
  shirt: number;
  shorts: number;
  skin: number;
  hair: number;
  /** a straw hat */
  hat?: boolean;
  /** a cloth knotted over the hair (sRGB hex) */
  scarf?: number;
  /** a short beard, the hair's colour */
  beard?: boolean;
  /** long trousers rolled to mid-shin (the `shorts` colour), not shorts */
  long?: boolean;
  /** the shirt's sleeves rolled to the elbow, not short */
  rolled?: boolean;
  /** × the chest's breadth and its depth front to back (1: the 1.75 m figure's): the three are not one build (the
   * 2026-11-02 review, "a slight silhouette variety between the three") */
  broad?: number;
  deep?: number;
}

type V = [number, number, number];

/** the joints of a pose (m); the paired ones [right (x > 0), left], `sym` mirroring one where the pose is symmetric */
export interface Skeleton {
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
  /** rad the head is bowed, turned about the neck's top (face down toward −z); none if absent */
  bow?: number;
}

const sym = (p: V): [V, V] => [p, [-p[0], p[1], p[2]]];

/**
 * THE POSES (m). `hug`: sitting on the deck, knees up, forearms over the knees, leaning a little into them — how people
 * sit on a raft's deck for hours. `lean`: sitting with the legs out, one knee drawn up a little, leaning back on the
 * hands. `stand`: the weight on one leg, the other knee eased, the right hand on the hip, the left arm hanging.
 * `kneel` (the 2026-11-02 next-level review, open question 6: "one figure at the dial, lit by it"; props.ts
 * THE OPERATOR): on both knees, sitting half back on the heels with the feet flat behind, the body bent forward over
 * something on the deck ~0.5 m ahead — the right hand on it (a dial: the wrist ~0.3 m over the deck, the case's top
 * at 0.22), the left braced on the left thigh, the head bowed to it. Lengths as the others': thigh ~0.5 m, shin ~0.48,
 * pelvis to neck ~0.53. BOWED OVER THE DIAL (the 2026-11-02 review of the first look: "a more pronounced bow over the
 * dial"): the back 50° from upright (it was 28°, which read as someone sitting up behind the case, facing us), the
 * pelvis up off the heels a little as the weight goes forward, and the head itself bowed 0.55 rad (`bow`) so its face
 * is turned down to the dial and the eye sees more of the crown — the skull over the case's middle, ~0.6 m above it.
 *
 * SOLVED TO ONE SET OF BONES (2026-11-02: the rig, BONE): the poses had been laid joint by joint, and their thighs ran
 * 0.42–0.53 m. Every pose is now re-solved to BONE's lengths (knees and elbows found from hips and ankles, shoulders and
 * hands), so `kneel` is laid again with them — the same bow, its pelvis lower (0.44 m: back on the heels with a 0.43 m
 * thigh) — and the knees and elbows given here are where the joint bends TOWARD (the pole), not where it ends up.
 * New with the rig: `kneelUp`, the kneeler straightened up off the dial, the hands on the thighs (the radio's answer,
 * crewLife.ts); `kneelAt`, kneeling up to something at chest height and leaning in to it — the
 * case comes to rest on the bow's splashboards, its lid ~0.9 m over the logs he kneels on, where `kneel`'s 50° bow put
 * his chest into it (tests/driftCrew.test.ts); his right hand on it (the dial: crewLife.ts), his left on his thigh; `edge`, sitting on the raft's edge with the legs over the side, the shins hanging outboard, the hands
 * on the thighs ("sitting on the deck edge with legs over the side": the review's brief); `sill`, the same sitting on a
 * step 0.3 m up, the feet down on the deck before it (the hut's doorway: crewLife.ts).
 */
const POSES: Record<CrewPose, Skeleton> = {
  hug: {
    pelvis: [0, 0.105, 0.04],
    neck: [0, 0.62, -0.06],
    head: [0, 0.75, -0.11],
    hip: sym([0.09, 0.1, 0.02]),
    knee: sym([0.12, 0.47, -0.34]),
    ankle: sym([0.11, 0.08, -0.46]),
    toe: sym([0.12, 0.03, -0.6]),
    shoulder: sym([0.18, 0.58, -0.04]),
    elbow: sym([0.21, 0.46, -0.29]),
    wrist: sym([0.06, 0.46, -0.4]),
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
  kneel: {
    pelvis: [0, 0.44, -0.05],
    neck: [0, 0.774, -0.448],
    head: [0, 0.8, -0.6],
    hip: sym([0.09, 0.42, -0.06]),
    knee: sym([0.12, 0.06, -0.3]),
    ankle: sym([0.1, 0.06, 0.13]),
    toe: sym([0.1, 0.03, 0.27]),
    shoulder: sym([0.18, 0.74, -0.42]),
    elbow: [[0.25, 0.56, -0.45], [-0.28, 0.58, -0.3]],
    wrist: [[0.07, 0.3, -0.6], [-0.12, 0.31, -0.2]],
    bow: 0.55,
  },
  kneelAt: {
    pelvis: [0, 0.47, -0.1],
    neck: [0, 0.94, -0.32],
    head: [0, 1.08, -0.38],
    hip: sym([0.09, 0.45, -0.1]),
    knee: sym([0.12, 0.075, -0.3]),
    ankle: sym([0.1, 0.06, 0.13]),
    toe: sym([0.1, 0.03, 0.27]),
    shoulder: sym([0.18, 0.9, -0.3]),
    elbow: [[0.38, 0.94, -0.3], [-0.26, 0.6, -0.3]],
    wrist: [[0.12, 0.74, -0.6], [-0.13, 0.46, -0.3]],
    bow: 0.25,
  },
  kneelUp: {
    pelvis: [0, 0.48, -0.13],
    neck: [0, 0.99, -0.2],
    head: [0, 1.15, -0.22],
    hip: sym([0.09, 0.46, -0.12]),
    knee: sym([0.12, 0.075, -0.3]),
    ankle: sym([0.1, 0.06, 0.13]),
    toe: sym([0.1, 0.03, 0.27]),
    shoulder: sym([0.18, 0.95, -0.18]),
    elbow: sym([0.25, 0.72, -0.2]),
    wrist: sym([0.13, 0.44, -0.32]),
  },
  sill: {
    pelvis: [0, 0.11, 0.04],
    neck: [0, 0.62, -0.04],
    head: [0, 0.78, -0.07],
    hip: sym([0.1, 0.1, 0.03]),
    knee: sym([0.12, 0.16, -0.38]),
    ankle: sym([0.14, -0.25, -0.5]),
    toe: sym([0.15, -0.28, -0.64]),
    shoulder: sym([0.18, 0.58, -0.03]),
    elbow: sym([0.25, 0.36, -0.1]),
    wrist: sym([0.13, 0.19, -0.3]),
  },
  edge: {
    pelvis: [0, 0.11, 0.04],
    neck: [0, 0.62, -0.06],
    head: [0, 0.78, -0.09],
    hip: sym([0.1, 0.1, 0.03]),
    knee: sym([0.12, 0.12, -0.4]),
    ankle: sym([0.13, -0.33, -0.47]),
    toe: sym([0.14, -0.4, -0.6]),
    shoulder: sym([0.18, 0.58, -0.04]),
    elbow: sym([0.25, 0.36, -0.1]),
    wrist: sym([0.13, 0.17, -0.3]),
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

/** the torso, pelvis to neck: lathed (hips, waist, chest, shoulders, the neck's root) and flattened front to back; its
 * breadth × `broad`, its depth × `deep` (CrewLook) */
function torso(from: V, to: V, mat: THREE.Material, broad = 1, deep = 1): THREE.Mesh {
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
  mesh.scale.set(broad, 1, 0.62 * deep);
  return mesh;
}

/**
 * cloth or skin, lit: its colour broken a little by fold-scale shading, so a flat sleeve does not read as plastic; and
 * WEATHERED (the 2026-11-02 review: "very cheap characters"; "matte, weathered cloth"): `salt` of the colour drawn
 * toward a paler grey of itself in broad patches ~20–40 cm across — sun-faded, salt-dried cloth is never one flat dye,
 * and a flat dye under a low Sun is what read as a mannequin's. In the part's own frame, so nothing crawls as it moves.
 */
function material(hex: number, roughness: number, folds: number, salt = 0): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness, metalness: 0 });
  m.name = 'drift-crew';
  const base = new THREE.Color(hex);
  const p = positionLocal;
  // (a few creases' worth of light and dark, ~4–6 cm apart: no texture, no noise to crawl at range)
  const crease = sin(p.y.mul(97).add(sin(p.x.mul(41)).mul(2))).mul(sin(p.z.mul(73).add(p.y.mul(11)))).mul(folds);
  const lum = 0.2126 * base.r + 0.7152 * base.g + 0.0722 * base.b;
  const faded = vec3(lum * 1.35 + 0.02, lum * 1.3 + 0.02, lum * 1.22 + 0.02);
  const patch = max(sin(p.x.mul(17).add(sin(p.y.mul(11)).mul(1.6))).mul(sin(p.z.mul(14).add(p.y.mul(9)))), 0).mul(salt);
  const tone = vec3(base.r, base.g, base.b);
  m.colorNode = tone.add(faded.sub(tone).mul(patch)).mul(float(1).add(crease));
  return m;
}

/** a crew figure held in `pose`, dressed as `look` (figure-local metres, see the header): the rig, posed once */
export function createCrewFigure(pose: CrewPose, look: CrewLook): THREE.Group {
  const rig = createCrewRig(look);
  rig.set(solveCrew({ ...REST_ACT, a: pose, b: pose }));
  rig.group.name = `drift-crew-${pose}`;
  return rig.group;
}

/** the neck, the head (a little longer than wide, a jaw's worth deeper at the front), the hair over its crown and
 * back, and the straw hat if it has one */
function headOf(k: Skeleton, look: CrewLook, skin: THREE.Material, hair: THREE.Material): THREE.Object3D[] {
  const g: THREE.Object3D[] = [];
  const add = (...o: THREE.Object3D[]): number => g.push(...o);
  const head = v3(k.head);
  const neckTop = head.clone().add(new THREE.Vector3(0, -0.08, 0.01));
  add(limb(k.neck, [neckTop.x, neckTop.y, neckTop.z], 0.05, 0.046, skin));
  // a bowed head (Skeleton `bow`): its parts laid as if upright about the neck's top, and turned about it (the others'
  // heads are laid as they always were)
  const pivot = k.bow ? new THREE.Group() : null;
  if (pivot) {
    pivot.position.copy(neckTop);
    pivot.rotation.x = -k.bow!;
    head.sub(neckTop);
    add(pivot);
  }
  const addHead = (...o: THREE.Object3D[]): unknown => (pivot ? pivot.add(...o) : add(...o));
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.1, 18, 14), skin);
  skull.position.copy(head);
  skull.scale.set(0.86, 1.12, 0.98);
  addHead(skull);
  const jaw = new THREE.Mesh(new THREE.SphereGeometry(0.062, 12, 8), skin);
  jaw.position.copy(head).add(new THREE.Vector3(0, -0.06, -0.035));
  jaw.scale.set(1, 0.85, 1);
  addHead(jaw);
  const crown = new THREE.Mesh(new THREE.SphereGeometry(0.104, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.56), hair);
  crown.position.copy(head).add(new THREE.Vector3(0, 0.008, 0.012));
  crown.rotation.x = 0.42;
  crown.scale.set(0.9, 1.1, 1.02);
  addHead(crown);
  if (look.hat) {
    const straw = material(0xb59a62, 0.95, 0.12);
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.22, 0.012, 28), straw);
    brim.position.copy(head).add(new THREE.Vector3(0, 0.06, 0));
    brim.rotation.x = 0.12;
    const top = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.104, 0.1, 20), straw);
    top.position.copy(head).add(new THREE.Vector3(0, 0.11, 0.005));
    top.rotation.x = 0.12;
    addHead(brim, top);
  }
  // (2026-11-02, a silhouette apiece: the hat, a knotted cloth, a bare head and a beard)
  if (look.scarf !== undefined) {
    // a cloth over the crown, tied at the back of the head, its ends hanging to the neck
    const cloth = material(look.scarf, 0.95, 0.08, 0.35);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.112, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), cloth);
    cap.position.copy(head).add(new THREE.Vector3(0, 0.012, 0.008));
    cap.rotation.x = 0.3;
    cap.scale.set(0.92, 1.05, 1.06);
    const knot = new THREE.Mesh(new THREE.SphereGeometry(0.032, 10, 8), cloth);
    knot.position.copy(head).add(new THREE.Vector3(0, -0.01, 0.105));
    const tails = limb([0, -0.02, 0.11], [0.02, -0.13, 0.12], 0.022, 0.012, cloth);
    tails.position.add(head);
    addHead(cap, knot, tails);
  }
  if (look.beard) {
    // (over the jaw's front, not under it: lower, it read as a dark collar — the 2026-11-02 close stills)
    const beard = new THREE.Mesh(new THREE.SphereGeometry(0.066, 12, 8), hair);
    beard.position.copy(head).add(new THREE.Vector3(0, -0.05, -0.062));
    beard.scale.set(0.92, 0.85, 0.72);
    addHead(beard);
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
  // (dressed as aboard: CLOTHES, the cloth, the cut and the build — the 2026-11-02 review)
  const { shirt, shorts, skin, hair } = clothes(look);
  const cut = cutOf(look);
  const g = new THREE.Group();
  g.name = 'drift-crew-walker';
  // everything rides on the body, which rises and falls over the stance leg; the upper body on it bends at the
  // pelvis (stooping), the head on that turns at the neck (looking round)
  const body = new THREE.Group();
  g.add(body);
  const upper = new THREE.Group();
  upper.position.copy(v3(k.pelvis));
  body.add(upper);
  const chest = torso(k.pelvis, k.neck, shirt, look.broad, look.deep);
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
    const above = part(knee, cut.thigh);
    hip.add(limb(O, above, 0.078, 0.062, shorts));
    if (cut.thigh < 1) hip.add(limb(above, knee, 0.056, 0.05, skin));
    const shin = joint(hip, knee);
    const ankle = rel(k.ankle[s], k.knee[s]);
    const hem = part(ankle, cut.shin);
    if (cut.shin > 0) shin.add(limb(O, hem, 0.062, 0.05, shorts));
    shin.add(limb(hem, ankle, 0.05, 0.034, skin));
    const foot = joint(shin, ankle);
    foot.add(limb(O, rel(k.toe[s], k.ankle[s]), 0.036, 0.03, skin));
    return { hip, shin, foot };
  });
  const arms = ([0, 1] as const).map((s) => {
    const shoulder = joint(upper, rel(k.shoulder[s], k.pelvis));
    const elbow = rel(k.elbow[s], k.shoulder[s]);
    const sleeve = part(elbow, cut.sleeve);
    shoulder.add(limb(O, sleeve, 0.058, cut.sleeve < 1 ? 0.052 : 0.05, shirt));
    if (cut.sleeve < 1) shoulder.add(limb(sleeve, elbow, 0.042, 0.037, skin));
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

/**
 * THE THREE (aboard and ashore: the same people, dressed the same). Their clothes faded and salt-stained, nothing
 * bright; and since the 2026-11-02 review ("a slight silhouette variety between the three (build, height, a hat …)")
 * each its own outline even small against the sky: the tallest, broad, in long trousers rolled to the shin, sleeves
 * rolled, a knotted cloth on his head, at the steering oar; the slight one in the straw hat; the stocky, bearded one,
 * bare-headed. `height` m (the walkers' own, props.ts WALKERS). Where each is aboard and what they do: crewLife.ts.
 */
export const CREW: Array<{ look: CrewLook; height: number }> = [
  // (his shirt a faded slate: in the brown it was, his skin's tone, he read bare-chested — the 2026-11-02 close stills)
  { look: { shirt: 0x5d6a63, shorts: 0x3e3a33, skin: 0x8a6650, hair: 0x2a221c, beard: true, broad: 1.06, deep: 1.14 }, height: 1.78 },
  { look: { shirt: 0x6f8290, shorts: 0x524636, skin: 0x7a5844, hair: 0x1c1814, hat: true, broad: 0.93, deep: 0.92 }, height: 1.64 },
  { look: { shirt: 0x97896e, shorts: 0x47505a, skin: 0x93705a, hair: 0x3b2a1e, scarf: 0x7d4a36, long: true, rolled: true, broad: 1.04 }, height: 1.72 },
];

/** a look's materials: weathered cloth (`material`'s salt), skin a little rougher than it was (0.58 read as a sheen
 * under the low Sun: "skin and hair that isn't plastic", the 2026-11-02 review), hair matte */
function clothes(look: CrewLook): { shirt: THREE.Material; shorts: THREE.Material; skin: THREE.Material; hair: THREE.Material } {
  return {
    shirt: material(look.shirt, 0.95, 0.05, 0.3),
    shorts: material(look.shorts, 0.93, 0.05, 0.25),
    skin: material(look.skin, 0.72, 0),
    hair: material(look.hair, 0.88, 0),
  };
}

/** a look's cut: the share of the thigh its shorts (or trousers) cover, of the shin its rolled trousers do, of the upper
 * arm its sleeve does */
function cutOf(look: CrewLook): { thigh: number; shin: number; sleeve: number } {
  return { thigh: look.long ? 1 : 0.8, shin: look.long ? 0.45 : 0, sleeve: look.rolled ? 1 : 0.55 };
}

/* ───────────────────────── THE RIG (aboard, posed every frame: the header) ───────────────────────── */

/** m: the bones every aboard pose is solved to (an adult 1.75 m tall): thigh, shin, upper arm, forearm */
const BONE = { thigh: 0.43, shin: 0.43, upper: 0.29, fore: 0.26 };
/** m: the head's centre from the neck's root, in the head's own frame (upright: up, and a little forward) */
const HEAD_UP: V = [0, 0.16, -0.02];
/** rad: how far the head turns on the shoulders (yaw) before the shoulders turn too, the most the shoulders turn, and
 * the head's pitch range (down, up) */
const NECK_YAW = 1.25;
const TWIST_MAX = 0.6;
const PITCH: [number, number] = [-0.75, 0.6];
/** what each pose stands on: 1 on the feet (the balance pivots about the ankles), 0 on the seat or the knees */
const STANDS: Record<CrewPose, number> = { stand: 1, sill: 0, hug: 0, lean: 0, kneel: 0, kneelAt: 0, kneelUp: 0, edge: 0 };

/**
 * What a figure aboard is doing at an instant (figure-local metres, the 1.75 m frame; crewLife.ts fills it, a pure
 * function of show time): its pose, blended from `a` to `b` by `w`, and on top of it —
 */
export interface CrewAct {
  a: CrewPose;
  b: CrewPose;
  w: number;
  /** the point its head turns to, and how far (0 … 1) it does from its idle look */
  look: V | null;
  lookW: number;
  /** the point its right arm points at, 0 … 1 */
  point: V | null;
  pointW: number;
  /** its left hand at its brow, shading its eyes, 0 … 1 */
  shade: number;
  /** both hands working a line in its lap (coiling it, the right hand going round), 0 … 1, and the turns it has made */
  work: number;
  workPhase: number;
  /** where its two hands hold on (right, left: a rail, a line), 0 … 1 */
  grip: [V, V] | null;
  gripW: number;
  /** where its right hand rests on something (the steering oar's loom, the radio's dial), 0 … 1 */
  touch: V | null;
  touchW: number;
  /** short steps on the spot (standing), while crewLife.ts carries the figure across the deck: their turns (a step
   * each foot a turn) and 0 … 1 how high they lift */
  step: number;
  stepAmp: number;
  /** turns of its breath, and of the slow shift of its weight from leg to leg (standing) */
  breath: number;
  sway: number;
  /** rad: where its head rests when it looks at nothing, yaw (+ to its left) and pitch (+ up) */
  idle: [number, number];
  /** the world's up in its frame (unit): it leans toward it as the deck tilts under it (1 is all the way) */
  up: V;
  balance: number;
}

/** an act with nothing on: the pose alone, upright, still */
export const REST_ACT: CrewAct = {
  a: 'stand', b: 'stand', w: 0, look: null, lookW: 0, point: null, pointW: 0, shade: 0, work: 0, workPhase: 0,
  grip: null, gripW: 0, touch: null, touchW: 0, step: 0, stepAmp: 0, breath: 0, sway: 0, idle: [0, 0], up: [0, 1, 0], balance: 0,
};

/** the joints solved, and the head turned on its body: rad yaw (+ left), pitch (+ up; the kneel's bow in it) */
export interface CrewSolved {
  k: Skeleton;
  yaw: number;
  pitch: number;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const vv = (p: V): THREE.Vector3 => new THREE.Vector3(p[0], p[1], p[2]);
const arr = (p: THREE.Vector3): V => [p.x, p.y, p.z];
const mixV = (a: V, b: V, w: number): V => [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w];
const clampN = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/**
 * TWO BONES BETWEEN TWO POINTS: the middle joint (a knee, an elbow) of bones `l1`, `l2` from `root` to `end`, bent
 * toward `pole`. `end` is pulled in to the bones' reach (less 1 mm) if it lies beyond it; returns [joint, end].
 */
export function twoBone(root: V, end: V, l1: number, l2: number, pole: V): [V, V] {
  const A = vv(root);
  const d = vv(end).sub(A);
  let len = d.length();
  const reach = l1 + l2 - 1e-3;
  if (len > reach) {
    d.multiplyScalar(reach / len);
    len = reach;
  }
  len = Math.max(len, Math.abs(l1 - l2) + 1e-3);
  const dir = d.clone().normalize();
  const C = A.clone().addScaledVector(dir, len);
  const a = (l1 * l1 - l2 * l2 + len * len) / (2 * len);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const n = vv(pole).sub(A);
  n.addScaledVector(dir, -n.dot(dir));
  if (n.lengthSq() < 1e-8) n.set(0, 0, -1).addScaledVector(dir, -dir.z);
  n.normalize();
  return [arr(A.addScaledVector(dir, a).addScaledVector(n, h)), arr(C)];
}

/** the body's frame from its joints: x to its right (across the shoulders), y up its spine, z out of its back */
export function bodyFrame(k: Skeleton, out = new THREE.Quaternion()): THREE.Quaternion {
  const up = vv(k.neck).sub(vv(k.pelvis)).normalize();
  const right = vv(k.shoulder[0]).sub(vv(k.shoulder[1]));
  right.addScaledVector(up, -right.dot(up)).normalize();
  const back = new THREE.Vector3().crossVectors(right, up);
  return out.setFromRotationMatrix(_m.makeBasis(right, up, back));
}

/** the head's frame: the body's, turned `yaw` about its spine and `pitch` about its shoulders' line */
export function headFrame(k: Skeleton, yaw: number, pitch: number, out = new THREE.Quaternion()): THREE.Quaternion {
  bodyFrame(k, out);
  return out.multiply(_q.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ')));
}

const JOINTS = ['pelvis', 'neck', 'head'] as const;
const PAIRS = ['hip', 'knee', 'ankle', 'toe', 'shoulder', 'elbow', 'wrist'] as const;
const UPPER_PAIRS = ['shoulder', 'elbow', 'wrist'] as const;
function blendPoses(a: Skeleton, b: Skeleton, w: number): Skeleton {
  const k = { bow: (a.bow ?? 0) + ((b.bow ?? 0) - (a.bow ?? 0)) * w } as Skeleton;
  for (const j of JOINTS) k[j] = mixV(a[j], b[j], w);
  for (const j of PAIRS) k[j] = [mixV(a[j][0], b[j][0], w), mixV(a[j][1], b[j][1], w)];
  return k;
}
/** turn the joints `pick` of `k` by `q` about `o` (in place) */
function turnJoints(k: Skeleton, q: THREE.Quaternion, o: V, pick: { one: ReadonlyArray<'pelvis' | 'neck' | 'head'>; pairs: ReadonlyArray<(typeof PAIRS)[number]> }): void {
  const O = vv(o);
  const t = (p: V): V => arr(_c.set(p[0], p[1], p[2]).sub(O).applyQuaternion(q).add(O));
  for (const j of pick.one) k[j] = t(k[j]);
  for (const j of pick.pairs) k[j] = [t(k[j][0]), t(k[j][1])];
}

/**
 * THE POSE AT AN INSTANT (figure-local, the 1.75 m frame): `act`'s pose blend, then —
 *   breath: the shoulders and the neck rise 5 mm on the in-breath, a little more than the chest;
 *   the weight's shift, standing: the hips over one foot and then the other, ±2.5 cm over the sway's turn, the
 *     knees taking it (re-solved to the planted ankles);
 *   the look: the head turned to `look` (or resting at `idle`), its yaw shared with the shoulders — a third of it, and
 *     whatever is past the neck's reach (NECK_YAW), up to TWIST_MAX — so a figure looking behind it turns its body;
 *   the balance: the body leaned toward the world's up as the deck tilts, `balance` of the way — a person on a rolling
 *     deck keeps their head over their feet rather than tilting with the planks (the 2026-11-02 review: "swaying in
 *     counter-phase with the raft's roll") — about the ankles standing, about the pelvis seated;
 *   the hands: to the grip, the work in the lap, the brow, or out along the pointing arm, and the elbows found;
 *   the knees found from the hips to the ankles.
 */
export function solveCrew(act: CrewAct): CrewSolved {
  const k = blendPoses(POSES[act.a], POSES[act.b], act.w);
  const poles = blendPoses(POSES[act.a], POSES[act.b], act.w);
  const stand = STANDS[act.a] + (STANDS[act.b] - STANDS[act.a]) * act.w;
  // breath and the weight's shift
  const rise = 0.005 * Math.sin(2 * Math.PI * act.breath);
  k.neck = [k.neck[0], k.neck[1] + rise, k.neck[2]];
  for (const s of [0, 1] as const) k.shoulder[s] = [k.shoulder[s][0], k.shoulder[s][1] + rise * 1.2, k.shoulder[s][2]];
  const shift = 0.025 * stand * Math.sin(2 * Math.PI * act.sway);
  if (shift !== 0) {
    const move = (p: V, f: number): V => [p[0] + shift * f, p[1] - Math.abs(shift) * 0.25 * f, p[2]];
    k.pelvis = move(k.pelvis, 1);
    k.hip = [move(k.hip[0], 1), move(k.hip[1], 1)];
    k.neck = move(k.neck, 0.6);
    for (const j of UPPER_PAIRS) k[j] = [move(k[j][0], 0.6), move(k[j][1], 0.6)];
  }
  // the look: rad yaw (+ left), pitch, from the neck
  let yaw = act.idle[0];
  let pitch = act.idle[1];
  if (act.look && act.lookW > 0) {
    const dx = act.look[0] - k.neck[0];
    const dy = act.look[1] - (k.neck[1] + 0.15);
    const dz = act.look[2] - k.neck[2];
    const ly = Math.atan2(-dx, -dz);
    // (the shorter way round from the idle look)
    let dYaw = ly - yaw;
    dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw));
    yaw += dYaw * act.lookW;
    pitch += (Math.atan2(dy, Math.hypot(dx, dz)) - pitch) * act.lookW;
  }
  // (a third of it in the shoulders — less with both hands holding on: the shoulders stay to what they hold)
  const twist = clampN(yaw - clampN((yaw * 2) / 3, -NECK_YAW, NECK_YAW), -TWIST_MAX, TWIST_MAX) * (1 - 0.7 * (act.grip ? act.gripW : 0));
  const headYaw = clampN(yaw - twist, -NECK_YAW, NECK_YAW);
  const upper = { one: ['neck', 'head'] as const, pairs: UPPER_PAIRS };
  turnJoints(k, _q.setFromAxisAngle(_a.set(0, 1, 0), twist), k.pelvis, upper);
  turnJoints(poles, _q, poles.pelvis, upper);
  // the balance
  const up = vv(act.up).normalize();
  // (braced on what the hands hold, a body leans less)
  const balance = clampN(act.balance, 0, 1) * (1 - 0.6 * (act.grip ? act.gripW : 0));
  const lean = new THREE.Quaternion().setFromUnitVectors(_a.set(0, 1, 0), _b.set(0, 1, 0).lerp(up, balance).normalize());
  if (stand > 0) {
    const feet = mixV(k.ankle[0], k.ankle[1], 0.5);
    const q = new THREE.Quaternion().slerp(lean, stand);
    const lower = { one: ['pelvis', 'neck', 'head'] as const, pairs: ['hip', 'shoulder', 'elbow', 'wrist'] as const };
    turnJoints(k, q, feet, lower);
    turnJoints(poles, q, feet, { one: [], pairs: ['knee', 'elbow'] });
  }
  if (stand < 1) {
    const q = new THREE.Quaternion().slerp(lean, 1 - stand);
    turnJoints(k, q, k.pelvis, upper);
    turnJoints(poles, q, k.pelvis, { one: [], pairs: ['elbow'] });
  }
  // the head, on the body as it now stands
  // (the kneel's bow is where its head rests; looking at something, the look decides: bowed AND looking down at the
  // dial it was bent twice over, the hat's brim on the case's lid — the 2026-11-02 close stills at 424 s)
  const bow = (k.bow ?? 0) * (1 - (act.look ? act.lookW : 0));
  const headPitch = clampN(pitch, PITCH[0], PITCH[1]) - bow;
  const hq = headFrame(k, headYaw, headPitch);
  k.head = arr(vv(HEAD_UP).applyQuaternion(hq).add(vv(k.neck)));
  // the hands, then the elbows
  for (const s of [0, 1] as const) {
    let w = k.wrist[s];
    if (act.grip && act.gripW > 0) w = mixV(w, act.grip[s], act.gripW);
    if (s === 0 && act.touch && act.touchW > 0) w = mixV(w, act.touch, act.touchW);
    if (act.work > 0) {
      // the lap: over the thighs, a hand's breadth up; the left holds the coil, the right lays each turn on it
      const lap: V = [k.pelvis[0], k.pelvis[1] + 0.17, k.pelvis[2] - 0.27];
      const a = 2 * Math.PI * act.workPhase;
      const at: V = s === 0 ? [lap[0] + 0.1 + 0.07 * Math.cos(a), lap[1] + 0.05 + 0.07 * Math.sin(a), lap[2] - 0.02 + 0.03 * Math.sin(a)] : [lap[0] - 0.09, lap[1] + 0.02, lap[2]];
      w = mixV(w, at, act.work);
    }
    if (s === 1 && act.shade > 0) {
      // the left hand flat over the brow, the elbow out to the side
      const brow = arr(_a.set(-0.04, 0.05, -0.17).applyQuaternion(hq).add(vv(k.head)));
      w = mixV(w, brow, act.shade);
    }
    if (s === 0 && act.point && act.pointW > 0) {
      const dir = vv(act.point).sub(vv(k.shoulder[0])).normalize();
      w = mixV(w, arr(dir.multiplyScalar(0.535).add(vv(k.shoulder[0]))), act.pointW);
    }
    // (the elbow out and down: the pose's own, a little more outboard as the hand comes up to the brow or out ahead)
    const side = s === 0 ? 1 : -1;
    const pole = mixV(poles.elbow[s], [poles.elbow[s][0] + side * 0.25, poles.elbow[s][1] - 0.1, poles.elbow[s][2] + 0.1], Math.max(act.shade * (s === 1 ? 1 : 0), act.pointW * (s === 0 ? 1 : 0)));
    const [elbow, wrist] = twoBone(k.shoulder[s], w, BONE.upper, BONE.fore, pole);
    k.elbow[s] = elbow;
    k.wrist[s] = wrist;
  }
  // the knees (each foot lifted 7 cm and set a little ahead through its half of a step)
  for (const s of [0, 1] as const) {
    if (act.stepAmp > 0) {
      const ph = 2 * Math.PI * (act.step + s / 2);
      const lift = 0.07 * act.stepAmp * Math.max(0, Math.sin(ph));
      const fwd = -0.05 * act.stepAmp * Math.cos(ph);
      k.ankle[s] = [k.ankle[s][0], k.ankle[s][1] + lift, k.ankle[s][2] + fwd];
      k.toe[s] = [k.toe[s][0], k.toe[s][1] + lift, k.toe[s][2] + fwd];
    }
    const [knee, ankle] = twoBone(k.hip[s], k.ankle[s], BONE.thigh, BONE.shin, poles.knee[s]);
    const d: V = [ankle[0] - k.ankle[s][0], ankle[1] - k.ankle[s][1], ankle[2] - k.ankle[s][2]];
    k.knee[s] = knee;
    k.ankle[s] = ankle;
    k.toe[s] = [k.toe[s][0] + d[0], k.toe[s][1] + d[1], k.toe[s][2] + d[2]];
  }
  return { k, yaw: headYaw, pitch: headPitch };
}

/** where a hand is drawn: a little on from the wrist along the forearm (m) */
const HAND = 0.06;

/** a figure aboard: its parts re-laid every frame from a solved pose (`set`), its root at its seat or its feet */
export interface CrewRig {
  readonly group: THREE.Group;
  /** pose it; with a line (createCrewRig `line`), `held` 0 … 1 brings its coil from its lap (0) up into its left hand
   * (1), its end running to the right hand (the work) */
  set(s: CrewSolved, held?: number): void;
}

/** one of the crew aboard, dressed as `look` (THE RIG: the header); `height` m tall (the group scaled to it) */
export function createCrewRig(look: CrewLook, height = 1.75, o: { line?: boolean } = {}): CrewRig {
  const { shirt, shorts, skin, hair } = clothes(look);
  const cut = cutOf(look);
  const g = new THREE.Group();
  g.name = 'drift-crew-rig';
  type Bone = { mesh: THREE.Mesh; from: (k: Skeleton) => V; to: (k: Skeleton) => V; rest: number };
  const bones: Bone[] = [];
  const frac = (a: (k: Skeleton) => V, b: (k: Skeleton) => V, f: number) => (k: Skeleton): V => mixV(a(k), b(k), f);
  const ref = POSES.stand;
  const bone = (from: (k: Skeleton) => V, to: (k: Skeleton) => V, r0: number, r1: number, mat: THREE.Material): void => {
    const a = from(ref);
    const b = to(ref);
    const rest = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const mesh = limb([0, 0, 0], [0, rest, 0], r0, r1, mat);
    g.add(mesh);
    bones.push({ mesh, from, to, rest });
  };
  const chest = torso(ref.pelvis, ref.neck, shirt, look.broad, look.deep);
  const chestRest = Math.hypot(ref.neck[0] - ref.pelvis[0], ref.neck[1] - ref.pelvis[1], ref.neck[2] - ref.pelvis[2]);
  g.add(chest);
  const seat = new THREE.Mesh(new THREE.SphereGeometry(0.16, 14, 10), shorts);
  g.add(seat);
  const hands: THREE.Mesh[] = [];
  for (const s of [0, 1] as const) {
    const hip = (k: Skeleton): V => k.hip[s];
    const knee = (k: Skeleton): V => k.knee[s];
    const ankle = (k: Skeleton): V => k.ankle[s];
    const above = frac(hip, knee, cut.thigh);
    bone(hip, above, 0.078, 0.062, shorts);
    if (cut.thigh < 1) bone(above, knee, 0.056, 0.05, skin);
    const hem = frac(knee, ankle, cut.shin);
    if (cut.shin > 0) bone(knee, hem, 0.062, 0.05, shorts);
    bone(hem, ankle, 0.05, 0.034, skin);
    bone(ankle, (k) => k.toe[s], 0.036, 0.03, skin);
    const shoulder = (k: Skeleton): V => k.shoulder[s];
    const elbow = (k: Skeleton): V => k.elbow[s];
    const sleeve = frac(shoulder, elbow, cut.sleeve);
    bone(shoulder, sleeve, 0.058, cut.sleeve < 1 ? 0.052 : 0.05, shirt);
    if (cut.sleeve < 1) bone(sleeve, elbow, 0.042, 0.037, skin);
    bone(elbow, (k) => k.wrist[s], 0.036, 0.027, skin);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), skin);
    hand.scale.set(0.85, 0.5, 1.35);
    g.add(hand);
    hands.push(hand);
  }
  // the head and the neck's top, laid about the neck's root (headOf, on an upright head at the origin)
  const head = new THREE.Group();
  head.add(...headOf({ ...ref, neck: [0, 0, 0], head: HEAD_UP, bow: 0 }, look, skin, hair));
  g.add(head);
  // the line it works: a coil (hemp) at the left hand, its end to the right
  const hemp = material(0x8f7a55, 0.95, 0.15, 0.2);
  const coil = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.022, 6, 18), hemp);
  const lead = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 1, 5), hemp);
  coil.visible = lead.visible = o.line === true;
  g.add(coil, lead);
  g.scale.setScalar(height / 1.75);
  g.traverse((o) => {
    o.castShadow = true;
    o.receiveShadow = true;
  });
  const up = new THREE.Vector3(0, 1, 0);
  const body = new THREE.Quaternion();
  return {
    group: g,
    set({ k, yaw, pitch }, held = 0) {
      for (const b of bones) {
        const a = vv(b.from(k));
        const d = vv(b.to(k)).sub(a);
        const len = d.length();
        b.mesh.position.copy(a);
        b.mesh.quaternion.setFromUnitVectors(up, d.normalize());
        b.mesh.scale.set(1, Math.max(1e-3, len / b.rest), 1);
      }
      bodyFrame(k, body);
      chest.position.copy(vv(k.pelvis));
      chest.quaternion.copy(body);
      const spine = Math.hypot(k.neck[0] - k.pelvis[0], k.neck[1] - k.pelvis[1], k.neck[2] - k.pelvis[2]);
      chest.scale.set(look.broad ?? 1, spine / chestRest, 0.62 * (look.deep ?? 1));
      seat.position.copy(vv(k.pelvis));
      seat.quaternion.copy(body);
      seat.scale.set(1, 0.62, 0.78);
      for (const s of [0, 1] as const) {
        const fore = vv(k.wrist[s]).sub(vv(k.elbow[s])).normalize();
        hands[s].position.copy(vv(k.wrist[s])).addScaledVector(fore, HAND);
        hands[s].quaternion.setFromUnitVectors(_a.set(0, 0, 1), fore);
      }
      head.position.copy(vv(k.neck));
      headFrame(k, yaw, pitch, head.quaternion);
      if (coil.visible) {
        // the coil in the lap (on the left thigh) or up in the left hand, flat-ish; the line from it to the right hand
        const lap = vv(mixV(k.hip[1], k.knee[1], 0.55)).add(_a.set(0, 0.09, 0));
        coil.position.copy(lap).lerp(_b.copy(hands[1].position).add(_a.set(0.02, -0.06, 0.02)), clampN(held, 0, 1));
        coil.quaternion.copy(body).multiply(_q.setFromEuler(new THREE.Euler(1.2, 0, 0.3)));
        const a = coil.position.clone().add(_a.set(0.1, 0.02, 0));
        const b = hands[0].position;
        lead.position.copy(a).add(b).multiplyScalar(0.5);
        lead.quaternion.setFromUnitVectors(up, _b.copy(b).sub(a).normalize());
        lead.scale.set(1, Math.max(1e-3, a.distanceTo(b)), 1);
      }
    },
  };
}

/** a capsule of a figure (figure-local metres, the 1.75 m frame): from `a` to `b`, radius `r` */
export interface CrewCapsule {
  part: string;
  a: V;
  b: V;
  r: number;
}

/**
 * The volume a solved figure fills, as capsules (figure-local, the 1.75 m frame): what tests/driftCrew.test.ts clears
 * against the sails, the rig and each other. Each part's thickest radius; the hands and the head as balls; a hat's
 * brim as two bars across it. Generous by a few millimetres, never short.
 */
export function crewCapsules(s: CrewSolved, look: CrewLook): CrewCapsule[] {
  const { k } = s;
  // the torso (crew.ts `torso`: lathed, flattened to 0.62 front to back): slices across it at its waist, its chest and
  // its shoulders, each a bar as wide as the lathe there and as thick as it is deep; and the spine through them
  const deep = 0.62 * (look.deep ?? 1);
  const broad = look.broad ?? 1;
  const right = vv(k.shoulder[0]).sub(vv(k.shoulder[1]));
  const up = vv(k.neck).sub(vv(k.pelvis));
  right.addScaledVector(up, -right.dot(up) / up.lengthSq()).normalize();
  const out: CrewCapsule[] = [
    { part: 'torso', a: mixV(k.pelvis, k.neck, 0.1), b: k.neck, r: 0.13 * deep },
    { part: 'seat', a: k.pelvis, b: k.pelvis, r: 0.16 },
    { part: 'head', a: k.head, b: k.head, r: 0.12 },
    { part: 'neck', a: k.neck, b: k.head, r: 0.05 },
  ];
  for (const [f, r] of [[0.1, 0.158], [0.36, 0.142], [0.62, 0.164], [0.8, 0.172]] as const) {
    const c = vv(mixV(k.pelvis, k.neck, f));
    const half = Math.max(0, r * broad - r * deep);
    out.push({ part: 'torso', a: arr(c.clone().addScaledVector(right, -half)), b: arr(c.addScaledVector(right, half)), r: r * deep + 0.004 });
  }
  for (const s2 of [0, 1] as const) {
    const n = s2 === 0 ? 'r' : 'l';
    out.push(
      { part: `thigh-${n}`, a: k.hip[s2], b: k.knee[s2], r: 0.079 },
      { part: `shin-${n}`, a: k.knee[s2], b: k.ankle[s2], r: 0.063 },
      { part: `foot-${n}`, a: k.ankle[s2], b: k.toe[s2], r: 0.037 },
      { part: `upper-${n}`, a: k.shoulder[s2], b: k.elbow[s2], r: 0.059 },
      { part: `fore-${n}`, a: k.elbow[s2], b: k.wrist[s2], r: 0.037 },
    );
    const fore = vv(k.wrist[s2]).sub(vv(k.elbow[s2])).normalize();
    out.push({ part: `hand-${n}`, a: k.wrist[s2], b: arr(fore.multiplyScalar(HAND + 0.03).add(vv(k.wrist[s2]))), r: 0.04 });
  }
  if (look.hat) {
    const hq = headFrame(k, s.yaw, s.pitch);
    const at = (x: number, z: number): V => arr(_a.set(x, 0.06, z).applyQuaternion(hq).add(vv(k.head)));
    out.push({ part: 'brim', a: at(-0.2, 0), b: at(0.2, 0), r: 0.03 }, { part: 'brim', a: at(0, -0.2), b: at(0, 0.2), r: 0.03 });
  }
  return out;
}
