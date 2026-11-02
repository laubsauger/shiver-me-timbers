/**
 * THE FLOTSAM OVER THE WINDOW (`?linedown`, lineDown.ts): what the flood left afloat, seen from under it. The look-dev
 * drew stand-ins — boxes for the planks, the door and the chair, a cylinder, a torus, a grid for the net — and the
 * 2026-11-02 brief asks for the real thing: "planks, a door, a chair, a barrel, a tyre, branches and leaves, and a
 * drifting net with floats. Real silhouettes and modest detail; they mostly read as silhouettes against the window."
 *
 * WHAT EACH IS, AND WHERE IT COMES FROM (no new download: everything is the repo's own, or made here):
 *   barrel, tyre, chair  the Poly Haven scans the sea's debris mat already floats (CC0; public/drift/pbr/<name>/
 *                        <name>_float.glb, cut by scripts/drift-prop-export.py, in the render nodes' bundle), at their
 *                        real sizes: a steel drum on its side, a car tyre flat, a white monobloc chair afloat on its back
 *                        with its legs up — the flood's own furniture (sunken-world-cues.md: "human things, not boxes")
 *   planks               broken boards made here: a board's outline with both ends snapped off along a jagged line,
 *                        in the debris field's own scanned plank (planks/diffuse.jpg, BlenderKit, its atlas rect)
 *   a door               made here: a four-panel house door, its panels raised on both faces (from below the relief is
 *                        what tells a door from a board), its paint faded, a knob — the Poly Haven roller-shutter scan
 *                        is a garage's, not a house's
 *   branches, leaves     made here: a limb torn off a tree with its twigs (tubes along curves, tapering) and its leaves
 *                        still on (alpha-cut leaf shapes), and loose leaves strewn on the water round it — at 8 m a 10 cm
 *                        leaf is ~0.7° across: the fine grain of silhouettes in the window
 *   the net              a ghost net: a curtain of twine (cut out of a sheet by its uv grid, greyed out with distance so
 *                        it never shimmers) torn through in places, its foot ragged, hung from a headline of oval trawl
 *                        floats that ride the swell one by one
 *
 * Everything floats ON THE SEA THE GPU DRAWS (the CpuOcean the rafts float on, §V.8: `water`), each piece at its own
 * freeboard and tilted with the swell's slope under it; the set rides the debris field's slow turn as the raft does, so
 * the eye, carried by the same turn, does not slide under it. Pure in t.
 */
import * as THREE from 'three/webgpu';
import { abs, float, fract, fwidth, max, mix, mx_noise_float, positionLocal, sin, smoothstep, texture, uniform, uniformArray, uv, vec2, vec3 } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node unions
type Node = any;

export type FlotsamKind = 'plank' | 'door' | 'chair' | 'barrel' | 'tyre' | 'branch' | 'twig';

/** a piece in the set's frame (x right, z ahead, m), its length for the made ones (m), its turn about up (rad) */
export interface FlotsamPiece {
  kind: FlotsamKind;
  at: [number, number];
  turn: number;
  length?: number;
}

/** the net: its float line from `a` to `b` (m in the set's frame), how far it hangs (m) */
export interface NetSpec {
  a: [number, number];
  b: [number, number];
  drop: number;
}

/** m: how each kind floats — its centre over the sea's surface (negative: mostly under), and how far its tilt follows
 * the swell's slope (0..1: a long plank lies on the swell, a drum rolls less) */
const FLOAT: Record<FlotsamKind, { y: number; follow: number }> = {
  plank: { y: -0.008, follow: 1 },
  door: { y: -0.006, follow: 1 },
  chair: { y: -0.12, follow: 0.6 },
  barrel: { y: -0.04, follow: 0.5 },
  tyre: { y: -0.03, follow: 0.8 },
  branch: { y: -0.025, follow: 0.7 },
  twig: { y: -0.015, follow: 0.7 },
};
/** m: the board's width and thickness; the door's size */
const BOARD: [number, number] = [0.21, 0.028];
const DOOR: [number, number, number] = [0.82, 2.02, 0.042];
/** the scans: file, the turn that floats them (applied to the geometry), the size kept */
const SCANS: Partial<Record<FlotsamKind, { file: string; turn: (g: THREE.BufferGeometry) => void }>> = {
  // (a drum on its side; a tyre flat; the chair on its back, its legs up and its seat awash)
  barrel: { file: 'Barrel_02', turn: (g) => g.rotateZ(Math.PI / 2) },
  tyre: { file: 'old_tyre', turn: (g) => g.rotateX(Math.PI / 2) },
  chair: { file: 'plastic_monobloc_chair_01', turn: (g) => g.rotateX(Math.PI * 0.62).rotateZ(0.25) },
};
/** loose leaves strewn round the branches, and the m of water they are strewn over */
const LOOSE_LEAVES = 140;
const LEAF_SPREAD = 6;
/** the net's floats and its twine's mesh (m) */
const NET_FLOATS = 11;
const NET_CELL = 0.14;

export interface Flotsam {
  readonly group: THREE.Group;
  /** resolves once the scans are in (a render waits for it) */
  readonly ready: Promise<void>;
  /** sea s; the set's frame in the world (x, z m; yaw rad: its −z the front); the sea's height (m) at a world x, z */
  update(t: number, frame: { x: number; z: number; yaw: number }, water: (x: number, z: number) => number): void;
}

const rng = (seed: number): (() => number) => {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9) >>> 0;
    s = Math.imul(s ^ (s >>> 13), 3266489917) >>> 0;
    return ((s ^ (s >>> 16)) >>> 0) / 4294967295;
  };
};

/** a board snapped off at both ends: its outline in (x along, y across), extruded through its thickness (y up after) */
function brokenBoard(length: number, seed: number): THREE.BufferGeometry {
  const r = rng(seed);
  const [w, th] = BOARD;
  const s = new THREE.Shape();
  const end = (x0: number, dir: number): Array<[number, number]> => {
    // a splintered end: a few teeth across the board's width, reaching up to 12 cm along it
    const pts: Array<[number, number]> = [];
    const teeth = 4 + Math.floor(r() * 4);
    for (let i = 0; i <= teeth; i++) pts.push([x0 + dir * r() * 0.12, -w / 2 + (w * i) / teeth]);
    return pts;
  };
  const a = end(-length / 2, 1);
  const b = end(length / 2, -1).reverse();
  s.moveTo(a[0][0], a[0][1]);
  for (const [x, y] of a.slice(1)) s.lineTo(x, y);
  for (const [x, y] of b) s.lineTo(x, y);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: th, bevelEnabled: false });
  // (the outline in xz, its thickness up)
  g.translate(0, 0, -th / 2).rotateX(-Math.PI / 2);
  return g;
}

/** a four-panel door, its panels raised on both faces */
function door(): THREE.BufferGeometry[] {
  const [w, h, th] = DOOR;
  const parts: THREE.BufferGeometry[] = [new THREE.BoxGeometry(w, th, h)];
  for (const [px, pz, pw, ph] of [[-0.19, -0.48, 0.28, 0.78], [0.19, -0.48, 0.28, 0.78], [-0.19, 0.5, 0.28, 0.62], [0.19, 0.5, 0.28, 0.62]]) {
    for (const side of [1, -1]) parts.push(new THREE.BoxGeometry(pw, 0.012, ph).translate(px, side * (th / 2 + 0.006), pz));
  }
  return parts;
}

/** a limb with its twigs (tubes) and where its leaves grow (on the outer half of each twig) */
function limb(length: number, seed: number): { wood: THREE.BufferGeometry[]; leaves: THREE.Matrix4[] } {
  const r = rng(seed);
  const wood: THREE.BufferGeometry[] = [];
  const leaves: THREE.Matrix4[] = [];
  const tube = (pts: THREE.Vector3[], r0: number, r1: number): THREE.CatmullRomCurve3 => {
    const curve = new THREE.CatmullRomCurve3(pts);
    const g = new THREE.TubeGeometry(curve, 16, 1, 6, false);
    // taper: the tube's radius scaled from r0 at its start to r1 at its tip
    const pos = g.getAttribute('position');
    const along = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      const seg = Math.floor(i / 7);
      const u = Math.min(1, seg / 16);
      curve.getPointAt(u, along);
      const k = r0 + (r1 - r0) * u;
      pos.setXYZ(i, along.x + (pos.getX(i) - along.x) * k, along.y + (pos.getY(i) - along.y) * k, along.z + (pos.getZ(i) - along.z) * k);
    }
    g.computeVertexNormals();
    wood.push(g);
    return curve;
  };
  // the limb lies along x, wandering a little, afloat
  const main: THREE.Vector3[] = [];
  for (let i = 0; i <= 5; i++) main.push(new THREE.Vector3(-length / 2 + (length * i) / 5, (r() - 0.5) * 0.06, (r() - 0.5) * 0.25));
  const mainCurve = tube(main, 0.05 * (length / 2.5), 0.012);
  const twigs = 4 + Math.floor(r() * 3);
  const p = new THREE.Vector3();
  const dir = new THREE.Vector3();
  for (let k = 0; k < twigs; k++) {
    const u = 0.25 + 0.7 * (k / twigs) + r() * 0.05;
    mainCurve.getPointAt(Math.min(1, u), p);
    const side = k % 2 ? 1 : -1;
    const len = (0.35 + r() * 0.5) * (length / 2.5);
    dir.set(0.7, (r() - 0.4) * 0.5, side * (0.5 + r() * 0.5)).normalize();
    const pts = [p.clone(), p.clone().addScaledVector(dir, len * 0.5).add(new THREE.Vector3(0, (r() - 0.5) * 0.08, 0)), p.clone().addScaledVector(dir, len)];
    const c = tube(pts, 0.016, 0.004);
    const n = 8 + Math.floor(r() * 8);
    for (let i = 0; i < n; i++) {
      c.getPointAt(0.35 + 0.65 * r(), p);
      const s = 0.07 + r() * 0.06;
      leaves.push(new THREE.Matrix4().compose(p.clone(), new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2 + (r() - 0.5) * 1.6, r() * Math.PI * 2, (r() - 0.5) * 1.2)), new THREE.Vector3(s * 0.55, s, 1)));
    }
  }
  // leaves on the limb's own outer reach too
  for (let i = 0; i < 10; i++) {
    mainCurve.getPointAt(0.6 + 0.4 * r(), p);
    const s = 0.07 + r() * 0.06;
    leaves.push(new THREE.Matrix4().compose(p.clone(), new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2 + (r() - 0.5) * 1.4, r() * Math.PI * 2, 0)), new THREE.Vector3(s * 0.55, s, 1)));
  }
  return { wood, leaves };
}

/** a leaf: a unit quad cut to a leaf's outline (pointed oval, the stalk end at v 0), its midrib darker */
function leafMaterial(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ color: 0x46552a, roughness: 0.7, side: THREE.DoubleSide });
  const q = uv();
  const half = sin(q.y.mul(Math.PI)).max(0).pow(0.75).mul(float(0.46).sub(q.y.mul(0.12)));
  const across = abs(q.x.sub(0.5));
  m.opacityNode = float(1).sub(smoothstep(half.sub(0.02), half, across));
  m.alphaTest = 0.5;
  m.colorNode = mix(vec3(0.16, 0.2, 0.08), vec3(0.27, 0.33, 0.13), smoothstep(0.0, 0.05, across));
  return m;
}

/** the loose leaves: where they are strewn round (m, the set's frame), how far, and the places kept clear of them (m,
 * a radius: where the eye goes through the surface — a leaf a hand's breadth from the lens fills the dome) */
export interface LeafSpec {
  at: [number, number];
  spread: number;
  clear?: Array<[number, number]>;
  clearRadius?: number;
}

export function createFlotsam(pieces: FlotsamPiece[], net: NetSpec | null, leaves: LeafSpec = { at: [0, -2], spread: LEAF_SPREAD }, seed = 2140): Flotsam {
  const group = new THREE.Group();
  group.name = 'line-down-flotsam';
  const loads: Array<Promise<void>> = [];
  const base = typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env.BASE_URL : '/';

  // materials: wet wood (the debris field's plank scan, its first board's rect), the door's faded paint, bark
  const plankMap = typeof document !== 'undefined' ? new THREE.TextureLoader().load(`${base}drift/pbr/planks/diffuse.jpg`) : null;
  if (plankMap) plankMap.colorSpace = THREE.SRGBColorSpace;
  const wood = new THREE.MeshStandardNodeMaterial({ color: 0x6a5640, roughness: 0.85 });
  if (plankMap) {
    // (the board's length along x, its width along z: into the atlas's first plank, [0.039, 0.07] + [0.205, 0.86])
    const u = positionLocal.z.div(BOARD[0]).add(0.5).clamp(0, 1);
    const v = fract(positionLocal.x.div(1.0).add(0.5));
    wood.colorNode = texture(plankMap, vec2(u.mul(0.205).add(0.039), v.mul(0.86).add(0.07))).rgb.mul(0.75);
  }
  const paint = new THREE.MeshStandardNodeMaterial({ color: 0x5e7f86, roughness: 0.75 });
  const bark = new THREE.MeshStandardNodeMaterial({ color: 0x3b2f24, roughness: 0.9 });
  const leaf = leafMaterial();
  const metal = new THREE.MeshStandardNodeMaterial({ color: 0x8a8070, roughness: 0.4, metalness: 0.8 });

  interface Held {
    piece: FlotsamPiece;
    holder: THREE.Group;
    phase: number;
  }
  const held: Held[] = [];
  const r = rng(seed);
  for (const piece of pieces) {
    const holder = new THREE.Group();
    holder.name = `line-down-${piece.kind}`;
    const body = new THREE.Group();
    holder.add(body);
    if (piece.kind === 'plank') {
      body.add(new THREE.Mesh(brokenBoard(piece.length ?? 2.2, Math.floor(r() * 1e6)), wood));
    } else if (piece.kind === 'door') {
      for (const g of door()) body.add(new THREE.Mesh(g, paint));
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 8), metal);
      knob.position.set(DOOR[0] / 2 - 0.07, -DOOR[2] / 2 - 0.03, 0.02);
      body.add(knob);
    } else if (piece.kind === 'branch' || piece.kind === 'twig') {
      const l = limb(piece.length ?? (piece.kind === 'branch' ? 2.6 : 1.2), Math.floor(r() * 1e6));
      for (const g of l.wood) body.add(new THREE.Mesh(g, bark));
      const leaves = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0), leaf, l.leaves.length);
      l.leaves.forEach((m, i) => leaves.setMatrixAt(i, m));
      leaves.frustumCulled = false;
      body.add(leaves);
    } else {
      const scan = SCANS[piece.kind]!;
      if (typeof document !== 'undefined') {
        loads.push(
          new GLTFLoader()
            .loadAsync(`${base}drift/pbr/${scan.file}/${scan.file}_float.glb`)
            .then((gltf) => {
              gltf.scene.updateMatrixWorld(true);
              gltf.scene.traverse((o) => {
                const m = o as THREE.Mesh;
                if (!m.isMesh) return;
                const g = m.geometry.clone().applyMatrix4(m.matrixWorld);
                scan.turn(g);
                g.computeBoundingBox();
                const c = g.boundingBox!.getCenter(new THREE.Vector3());
                g.translate(-c.x, -c.y, -c.z);
                body.add(new THREE.Mesh(g, m.material));
              });
            })
            .catch((e: unknown) => {
              // FAIL LOUD: a piece missing from the set is a set that is not the one reviewed
              console.error(`lineDown flotsam: ${scan.file} did not load`, e);
            }),
        );
      }
    }
    group.add(holder);
    held.push({ piece, holder, phase: r() * 10 });
  }

  // the loose leaves, strewn round the set's middle
  const loose = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0), leaf, LOOSE_LEAVES);
  loose.frustumCulled = false;
  const looseAt = Array.from({ length: LOOSE_LEAVES }, () => {
    let x = 0;
    let z = 0;
    // (drawn again until clear of the kept places: a few tries, then wherever the last fell)
    for (let k = 0; k < 8; k++) {
      const a = r() * Math.PI * 2;
      const d = Math.sqrt(r()) * leaves.spread;
      x = leaves.at[0] + Math.cos(a) * d;
      z = leaves.at[1] + Math.sin(a) * d;
      if (!(leaves.clear ?? []).some(([cx, cz]) => Math.hypot(x - cx, z - cz) < (leaves.clearRadius ?? 1.5))) break;
    }
    return { x, z, turn: r() * Math.PI * 2, size: 0.06 + r() * 0.07, curl: (r() - 0.5) * 0.5, phase: r() * 10 };
  });
  group.add(loose);

  // THE NET (see the header): its curtain, its headline and floats
  let netUpdate: ((t: number, toWorld: (x: number, z: number) => [number, number], water: (x: number, z: number) => number) => void) | null = null;
  if (net) {
    const span = Math.hypot(net.b[0] - net.a[0], net.b[1] - net.a[1]);
    const ang = Math.atan2(net.b[1] - net.a[1], net.b[0] - net.a[0]);
    // the float line's heights, sampled at the floats and drawn through by the curtain's top (m over the mean sea)
    const tops = Array.from({ length: NET_FLOATS }, () => 0);
    const uTops = uniformArray(tops, 'float');
    const uNet = uniform(0);
    const netGeo = new THREE.PlaneGeometry(span, net.drop, 60, 18).translate(span / 2, -net.drop / 2, 0);
    const netMat = new THREE.MeshStandardNodeMaterial({ color: 0x2c3a33, roughness: 0.9, side: THREE.DoubleSide, transparent: true, depthWrite: false });
    {
      const q = uv();
      const g = vec2(q.x.mul(span / NET_CELL), q.y.mul(net.drop / NET_CELL));
      const w = fwidth(g).max(1e-4);
      // (twine 1.2 cm on a 14 cm cell, sharp while a cell spans pixels, its mean — a faint grey veil — once it does not)
      const dist = float(0.5).sub(abs(fract(g).sub(0.5)));
      const sharp = dist.negate().add(0.043).div(w).add(0.5).clamp(0, 1);
      const far = smoothstep(0.3, 1.0, max(w.x, w.y));
      const cover = mix(max(sharp.x, sharp.y), float(0.165), far);
      // a ghost net is torn: holes where a slow noise of the sheet runs high, and a ragged foot
      const tear = smoothstep(0.42, 0.5, mx_noise_float(vec3(q.x.mul(span * 0.55), q.y.mul(net.drop * 0.7), 3.1)));
      const foot = smoothstep(0.0, 0.06, q.y.sub(mx_noise_float(vec3(q.x.mul(span * 1.3), 0.5, 7.7)).mul(0.12).add(0.1)));
      netMat.opacityNode = cover.mul(0.85).mul(float(1).sub(tear)).mul(foot);
      // hung from the float line (its height at this x, between the floats), bellied out with depth, swaying
      const share = positionLocal.x.div(span).clamp(0, 1).mul(NET_FLOATS - 1);
      const i0 = share.floor().min(NET_FLOATS - 2).toInt();
      const top: Node = mix(uTops.element(i0) as Node, uTops.element(i0.add(1)) as Node, share.fract());
      const depthShare = positionLocal.y.negate().div(net.drop);
      const sway = sin(positionLocal.x.mul(0.9).add(uNet.mul(0.5))).mul(0.35).add(sin(positionLocal.x.mul(2.3).sub(uNet.mul(0.8))).mul(0.12));
      netMat.positionNode = positionLocal.add(vec3(0, top.add(positionLocal.y.mul(0.15).mul(depthShare)), sway.mul(depthShare).add(depthShare.mul(depthShare).mul(0.8))));
    }
    const curtain = new THREE.Mesh(netGeo, netMat);
    curtain.frustumCulled = false;
    curtain.name = 'line-down-net';
    curtain.position.set(net.a[0], 0, -net.a[1]);
    curtain.rotation.y = ang;
    group.add(curtain);
    // the floats: oval trawl floats, orange and a few white, and the headline between them
    const floatGeo = new THREE.CapsuleGeometry(0.07, 0.1, 6, 12).rotateZ(Math.PI / 2);
    const floatMat = new THREE.MeshStandardNodeMaterial({ color: 0xc0602a, roughness: 0.6 });
    const floats = new THREE.InstancedMesh(floatGeo, floatMat, NET_FLOATS);
    floats.frustumCulled = false;
    for (let i = 0; i < NET_FLOATS; i++) if (i % 4 === 2) floats.setColorAt(i, new THREE.Color(0xd8d4c8));
    group.add(floats);
    const ropeMat = new THREE.MeshStandardNodeMaterial({ color: 0x3a3a30, roughness: 0.9 });
    const rope = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.008, 0.008, 1, 5).rotateZ(Math.PI / 2).translate(0.5, 0, 0), ropeMat, NET_FLOATS - 1);
    rope.frustumCulled = false;
    group.add(rope);
    const m4 = new THREE.Matrix4();
    const q4 = new THREE.Quaternion();
    const pts: THREE.Vector3[] = Array.from({ length: NET_FLOATS }, () => new THREE.Vector3());
    netUpdate = (t, toWorld, water) => {
      uNet.value = t;
      for (let i = 0; i < NET_FLOATS; i++) {
        const k = i / (NET_FLOATS - 1);
        // (each float a little off the straight line: the headline sags between them on the current)
        const lx = net.a[0] + (net.b[0] - net.a[0]) * k + 0.25 * Math.sin(k * Math.PI) * Math.sin(t * 0.13);
        const lz = net.a[1] + (net.b[1] - net.a[1]) * k + 0.3 * Math.sin(k * Math.PI);
        const [wx, wz] = toWorld(lx, lz);
        const y = water(wx, wz) - 0.03;
        tops[i] = y;
        pts[i].set(lx, y, -lz);
        m4.compose(pts[i], q4.setFromAxisAngle(new THREE.Vector3(0, 1, 0), ang), new THREE.Vector3(1, 1, 1));
        floats.setMatrixAt(i, m4);
      }
      for (let i = 0; i < NET_FLOATS - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const len = a.distanceTo(b);
        const dir = b.clone().sub(a).normalize();
        q4.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
        rope.setMatrixAt(i, m4.compose(a, q4, new THREE.Vector3(len, 1, 1)));
      }
      floats.instanceMatrix.needsUpdate = true;
      rope.instanceMatrix.needsUpdate = true;
    };
  }

  group.traverse((x) => void ((x as THREE.Mesh).isMesh && ((x as THREE.Mesh).castShadow = false)));
  const tilt = new THREE.Euler();
  const m4 = new THREE.Matrix4();
  const q4 = new THREE.Quaternion();
  return {
    group,
    ready: Promise.all(loads).then(() => undefined),
    update(t, frame, water) {
      group.position.set(frame.x, 0, frame.z);
      group.rotation.set(0, frame.yaw, 0);
      const c = Math.cos(frame.yaw);
      const s = Math.sin(frame.yaw);
      // the set's frame (x right, z ahead: the group's −z) into the world
      const toWorld = (x: number, z: number): [number, number] => [frame.x + x * c - z * s, frame.z - x * s - z * c];
      for (const h of held) {
        const f = FLOAT[h.piece.kind];
        // a slow wander on the current (cm a second) and a slow turn
        const x = h.piece.at[0] + 0.15 * Math.sin(t * 0.07 + h.phase);
        const z = h.piece.at[1] + 0.12 * Math.cos(t * 0.05 + h.phase);
        const [wx, wz] = toWorld(x, z);
        const y0 = water(wx, wz);
        // its tilt: the swell's slope under it, in the set's frame (x right, −z ahead)
        const dx = (water(wx + 0.4 * c, wz - 0.4 * s) - water(wx - 0.4 * c, wz + 0.4 * s)) / 0.8;
        const dz = (water(wx - 0.4 * s, wz - 0.4 * c) - water(wx + 0.4 * s, wz + 0.4 * c)) / 0.8;
        h.holder.position.set(x, y0 + f.y, -z);
        tilt.set(-Math.atan(dz) * f.follow, h.piece.turn + 0.02 * Math.sin(t * 0.11 + h.phase), Math.atan(dx) * f.follow, 'YXZ');
        h.holder.rotation.copy(tilt);
      }
      for (let i = 0; i < LOOSE_LEAVES; i++) {
        const l = looseAt[i];
        const x = l.x + 0.1 * Math.sin(t * 0.09 + l.phase);
        const z = l.z + 0.1 * Math.cos(t * 0.07 + l.phase);
        const [wx, wz] = toWorld(x, z);
        q4.setFromEuler(new THREE.Euler(-Math.PI / 2 + l.curl, l.turn, 0, 'YXZ'));
        loose.setMatrixAt(i, m4.compose(new THREE.Vector3(x, water(wx, wz) - 0.006, -z), q4, new THREE.Vector3(l.size * 0.55, l.size, 1)));
      }
      loose.instanceMatrix.needsUpdate = true;
      netUpdate?.(t, toWorld, water);
    },
  };
}

/**
 * THE RAFT'S UNDERSIDE (`?linedown=day`): weed grown on its logs — the brief's "the raft's underside detail" (the
 * 2026-11-02 review). The logs, their lashings and the guaras are the raft's own (raft.ts: the game's raft, dressed);
 * what a raft weeks at sea has under it besides is a fringe of weed, short green ribbons hanging from the logs'
 * bellies, swaying with the swell's orbit. From 8–10 m below, the raft's silhouette against the window gets a soft,
 * living edge instead of the cut edge of a model. Strands: instanced quads, each hung at a log's bottom (raft.ts
 * raftLogsInPlan: its frame, x to starboard, the bow +z, the logs' axis at y 0), bending more toward its free end.
 */
const WEED = 260;
export function createRaftWeed(logs: Array<{ x: number; r: number; zStern: number; zBow: number }>, seed = 2150): { mesh: THREE.InstancedMesh; update(t: number): void } {
  const r = rng(seed);
  const uTime = uniform(0);
  // (a unit strip, its top at y 0 and hanging to −1; uv.y 1 at the top)
  const geo = new THREE.PlaneGeometry(1, 1, 1, 6).translate(0, -0.5, 0);
  const mat = new THREE.MeshStandardNodeMaterial({ color: 0x2f3d1e, roughness: 0.8, side: THREE.DoubleSide });
  const q = uv();
  const free = float(1).sub(q.y);
  // the sway: the swell's orbit under the raft, a slow back and forth along the raft and a little across (in each
  // strand's own frame, so the strands, turned every way, do not sway as one)
  const sway = sin(uTime.mul(0.9)).mul(0.35).mul(free.mul(free));
  mat.positionNode = positionLocal.add(vec3(sway.mul(0.3), 0, sway));
  // a ribbon's outline: narrowing to its tip
  mat.opacityNode = float(1).sub(smoothstep(free.mul(-0.35).add(0.5).sub(0.04), free.mul(-0.35).add(0.5), abs(q.x.sub(0.5))));
  mat.alphaTest = 0.5;
  const mesh = new THREE.InstancedMesh(geo, mat, WEED);
  mesh.name = 'line-down-raft-weed';
  mesh.frustumCulled = false;
  const m4 = new THREE.Matrix4();
  for (let i = 0; i < WEED; i++) {
    const log = logs[Math.floor(r() * logs.length)];
    const z = log.zStern + (log.zBow - log.zStern) * (0.05 + 0.9 * r());
    const x = log.x + (r() - 0.5) * log.r * 0.8;
    const len = 0.15 + r() * r() * 0.7;
    const w = 0.02 + r() * 0.03;
    m4.compose(new THREE.Vector3(x, -log.r * 0.92, z), new THREE.Quaternion().setFromEuler(new THREE.Euler((r() - 0.5) * 0.4, r() * Math.PI, (r() - 0.5) * 0.4)), new THREE.Vector3(w, len, 1));
    mesh.setMatrixAt(i, m4);
  }
  return {
    mesh,
    update(t) {
      uTime.value = t;
    },
  };
}
