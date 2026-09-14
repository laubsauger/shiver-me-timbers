/**
 * THE COURIER'S CARGO, for the trailer only (docs/cine/speedboat-trailer-v1.md, shot 04 "secured courier cargo behind
 * the seat"). The hero GLB carries no cargo, so this is a small in-engine bundle the cine host bolts to the hero boat
 * while shooting and takes off again after (host.ts `setShooting`). Nothing in the game builds it.
 *
 * WHERE, measured on the built hero GLB (body frame: CG origin, +Z bow, +Y up; scratch raycast over LOD0):
 *   - the cockpit well (sole y −0.21) ends at z ≈ −1.25; the flat aft deck runs from there to the transom at
 *     y 0.54 (0.52 at z −2.0), and it carries a pair of deck fittings at x ±0.55..0.65, z −1.7..−1.9 (0.6 m tall)
 *     — the lashing points the straps run to.
 *   - the arch crossbar is at y ≈ 1.5 over z −0.4..−0.7: STYLE-SPEC §2 rule 3, "lashed cargo stays below the arch
 *     crossbar", so the stack tops out at 1.13.
 *   - cargo on the cockpit SOLE would be hidden from shot 04's bow lens by the dash and the seat back; on the aft
 *     deck it shows either side of the pilot's shoulders (the lens looks aft over the windscreen at y ≈ 1.0).
 *
 * WHAT (STYLE-SPEC §5.3 "cockpit lashings", §4.1 palette): two stacked waterproof cases (olive, sun-faded blue-grey)
 * with lids, ribs, latches and a bone label, a mustard roll-top dry bag lying fore-and-aft beside them, and two teal
 * webbing straps over the lot to the deck fittings, each with an aluminium ratchet. Heavy wear, still cared for: matte
 * plastics, no textures. ~3.5k triangles.
 */
import * as THREE from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

/** the bundle's centre station on the aft deck (body z) */
const BUNDLE_Z = -1.8;
/**
 * deck top at the bundle centre (measured 0.531; a 6 mm crown to x ±0.45, bases sink into it) and the deck's fall aft
 * (0.537 at z −1.5, 0.524 at z −2.0: 1.5°), which the whole bundle is pitched to
 */
const DECK_Y = 0.527;
const DECK_FALL = 0.026;
/** the two deck cleats the straps run to: metal, x ±0.49..0.63, z −1.70..−1.92, top y 0.60 — strap ends on their inner horn */
const FITTING_X = 0.52;
const FITTING_Y = 0.59;

interface CaseSpec {
  /** centre x, z and base y (body frame) */
  x: number;
  z: number;
  y: number;
  w: number;
  d: number;
  h: number;
  yaw: number;
  color: number;
}

// z is relative to BUNDLE_Z. Everything stays inside the cleats (|x| < 0.45) and below the arch crossbar.
const LOWER: CaseSpec = { x: -0.17, z: 0.02, y: DECK_Y, w: 0.5, d: 0.4, h: 0.34, yaw: 0, color: 0x4e5638 };
const UPPER: CaseSpec = { x: -0.24, z: 0.04, y: DECK_Y + 0.34 + 0.012, w: 0.34, d: 0.3, h: 0.22, yaw: 0.06, color: 0x56656b };
const BAG = { x: 0.265, z: 0, r: 0.18, len: 0.62, squash: 0.9, color: 0xc08f2e };
/**
 * strap stations along z, relative: the first over the whole stack, the second just aft of the upper case (over the
 * lower case and the bag only). Both run in to the cleats' horns (relative z −0.09..0.07) at their ends.
 */
const STRAP_Z = [0.1, -0.165];
const CLEAT_Z: readonly [number, number] = [-0.09, 0.07];
const STRAP_W = 0.038;

export interface CourierCargo {
  readonly object: THREE.Group;
  dispose(): void;
}

const mat = (color: number, roughness: number, metalness = 0): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness });

/** a strapped waterproof case: rounded body, a lid band, stacking ribs, two latches, side handles, a stencil label */
function buildCase(c: CaseSpec, mats: { body: THREE.Material; metal: THREE.Material; label: THREE.Material }, geos: THREE.BufferGeometry[]): THREE.Group {
  const g = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number): THREE.Mesh => {
    geos.push(geo);
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    g.add(mesh);
    return mesh;
  };
  const bodyH = c.h * 0.8;
  add(new RoundedBoxGeometry(c.w, bodyH, c.d, 2, 0.03), mats.body, 0, bodyH / 2, 0);
  // the lid: a touch wider than the body, with a visible seam under it
  const lidH = c.h - bodyH - 0.006;
  add(new RoundedBoxGeometry(c.w + 0.014, lidH, c.d + 0.014, 2, 0.02), mats.body, 0, bodyH + 0.006 + lidH / 2, 0);
  // stacking ribs down the long faces
  for (const side of [-1, 1]) {
    for (const u of [-0.3, 0, 0.3]) {
      add(new THREE.BoxGeometry(0.03, bodyH * 0.8, 0.012), mats.body, u * c.w, bodyH * 0.45, side * (c.d / 2 + 0.004));
    }
    // side handle: a bar on two stand-offs on the short ends
    add(new THREE.BoxGeometry(0.02, 0.022, c.d * 0.42), mats.metal, side * (c.w / 2 + 0.022), bodyH * 0.72, 0);
    for (const v of [-1, 1]) add(new THREE.BoxGeometry(0.026, 0.02, 0.018), mats.body, side * (c.w / 2 + 0.01), bodyH * 0.72, v * c.d * 0.19);
  }
  // latches on the bow-facing (+z) face, across the lid seam
  for (const u of [-0.3, 0.3]) add(new RoundedBoxGeometry(0.05, 0.07, 0.022, 1, 0.006), mats.metal, u * c.w, bodyH - 0.01, c.d / 2 + 0.012);
  // stencil label panel
  add(new THREE.BoxGeometry(c.w * 0.34, bodyH * 0.3, 0.004), mats.label, 0, bodyH * 0.42, c.d / 2 + 0.002);
  g.position.set(c.x, c.y, c.z);
  g.rotation.y = c.yaw;
  return g;
}

/** a roll-top dry bag lying fore-and-aft: a lathe capsule squashed by its own weight, the roll and buckle at the bow end */
function buildBag(body: THREE.Material, strapMat: THREE.Material, metal: THREE.Material, geos: THREE.BufferGeometry[]): THREE.Group {
  const g = new THREE.Group();
  const pts: THREE.Vector2[] = [];
  const n = 14;
  for (let i = 0; i <= n; i++) {
    const s = i / n; // 0 = closed end .. 1 = neck
    const end = Math.sin(Math.min(1, s / 0.16) * Math.PI / 2); // rounded closed end
    const neck = s > 0.8 ? 1 - 0.55 * ((s - 0.8) / 0.2) ** 1.4 : 1; // tapers into the roll
    const bulge = 1 + 0.04 * Math.sin(s * Math.PI * 3); // soft lumps of whatever is inside
    pts.push(new THREE.Vector2(Math.max(0.004, BAG.r * end * neck * bulge), s * BAG.len));
  }
  const lathe = new THREE.LatheGeometry(pts, 16);
  // lie it down along +z and let it sag: flatter on the deck, fuller at the sides
  lathe.rotateX(Math.PI / 2);
  lathe.scale(1.06, BAG.squash, 1);
  lathe.computeVertexNormals();
  geos.push(lathe);
  const bag = new THREE.Mesh(lathe, body);
  bag.position.set(0, BAG.r * BAG.squash, -BAG.len / 2);
  g.add(bag);
  // the roll-top: a flattened roll across the neck, folded down, with its buckle strap
  const roll = new RoundedBoxGeometry(0.2, 0.05, 0.08, 2, 0.022);
  geos.push(roll);
  const rollMesh = new THREE.Mesh(roll, body);
  rollMesh.position.set(0, BAG.r * BAG.squash * 0.95, BAG.len / 2 + 0.02);
  rollMesh.rotation.x = -0.35;
  g.add(rollMesh);
  const tab = new THREE.BoxGeometry(0.026, 0.004, 0.14);
  geos.push(tab);
  const tabMesh = new THREE.Mesh(tab, strapMat);
  tabMesh.position.set(0, BAG.r * BAG.squash * 1.2, BAG.len / 2 - 0.02);
  g.add(tabMesh);
  const buckle = new RoundedBoxGeometry(0.036, 0.014, 0.05, 1, 0.005);
  geos.push(buckle);
  const buckleMesh = new THREE.Mesh(buckle, metal);
  buckleMesh.position.set(0, BAG.r * BAG.squash * 1.24, BAG.len / 2 - 0.05);
  g.add(buckleMesh);
  g.position.set(BAG.x, DECK_Y - 0.005, BAG.z);
  return g;
}

/** the top of the bundle at (x, z) (bundle frame), for a strap of STRAP_W to lie over: the two cases and the bag's round back */
function profileAt(x: number, z: number): number {
  let y = DECK_Y;
  const caseTop = (c: CaseSpec): number =>
    Math.abs(x - c.x) <= c.w / 2 + 0.007 && Math.abs(z - c.z) <= c.d / 2 + STRAP_W / 2 + Math.abs(c.yaw) * c.w / 2 ? c.y + c.h : -Infinity;
  y = Math.max(y, caseTop(LOWER), caseTop(UPPER));
  const dx = x - BAG.x;
  const rx = BAG.r * 1.06;
  if (Math.abs(dx) < rx) y = Math.max(y, DECK_Y + BAG.r * BAG.squash * (1 + Math.sqrt(1 - (dx / rx) ** 2)));
  return y;
}

/**
 * A webbing strap from one deck fitting over the bundle to the other, as a flat ribbon of STRAP_W with 4 mm of body.
 * The path is the bundle's top profile (hull-wrapped, never through a corner) with straight runs down to the fittings.
 */
function strapGeometry(z: number): THREE.BufferGeometry {
  const lift = 0.005;
  // top profile, sampled then reduced to its corners
  const raw: THREE.Vector2[] = [];
  const x0 = LOWER.x - LOWER.w / 2 - 0.02;
  const x1 = BAG.x + BAG.r * 1.06 + 0.02;
  for (let x = x0; x <= x1 + 1e-6; x += 0.01) raw.push(new THREE.Vector2(x, profileAt(x, z) + lift));
  // convex hull from above (upper hull) so the strap bridges the gaps like a tensioned strap does
  const hull: THREE.Vector2[] = [new THREE.Vector2(-FITTING_X, FITTING_Y)];
  for (const p of [...raw, new THREE.Vector2(FITTING_X, FITTING_Y)]) {
    while (hull.length >= 2) {
      const a = hull[hull.length - 2] as THREE.Vector2;
      const b = hull[hull.length - 1] as THREE.Vector2;
      if ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) >= 0) hull.pop();
      else break;
    }
    hull.push(p);
  }
  // resample densely enough for the bag's curve, then build a thin closed ribbon (top, bottom and both edges)
  const path: THREE.Vector2[] = [];
  for (let i = 1; i < hull.length; i++) {
    const a = hull[i - 1] as THREE.Vector2;
    const b = hull[i] as THREE.Vector2;
    const steps = Math.max(1, Math.ceil(a.distanceTo(b) / 0.04));
    for (let k = i === 1 ? 0 : 1; k <= steps; k++) path.push(a.clone().lerp(b, k / steps));
  }
  // the runs down to the cleats swing in along z to the cleat's horn
  const zIn = Math.min(Math.max(z, CLEAT_Z[0]), CLEAT_Z[1]);
  const zAt = (x: number): number => {
    const u = x < x0 ? (x0 - x) / (x0 + FITTING_X) : x > x1 ? (x - x1) / (FITTING_X - x1) : 0;
    return z + (zIn - z) * Math.min(1, Math.max(0, u));
  };
  const t = 0.004;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < path.length; i++) {
    const p = path[i] as THREE.Vector2;
    const prev = path[Math.max(0, i - 1)] as THREE.Vector2;
    const next = path[Math.min(path.length - 1, i + 1)] as THREE.Vector2;
    const tx = next.x - prev.x;
    const ty = next.y - prev.y;
    const l = Math.hypot(tx, ty) || 1;
    const nx = -ty / l;
    const ny = tx / l; // outward (up) normal of the path in the x-y plane
    for (const [off, dz] of [[0, -1], [0, 1], [-t, 1], [-t, -1]] as const) {
      pos.push(p.x + nx * off, p.y + ny * off, zAt(p.x) + (dz * STRAP_W) / 2);
    }
  }
  for (let i = 0; i + 1 < path.length; i++) {
    const a = i * 4;
    const b = a + 4;
    for (let s = 0; s < 4; s++) {
      const s1 = (s + 1) % 4;
      idx.push(a + s, b + s, b + s1, a + s, b + s1, a + s1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  // winding check-free: normals from faces, and the strap material is double-sided
  geo.computeVertexNormals();
  return geo;
}

export function createCourierCargo(): CourierCargo {
  const geos: THREE.BufferGeometry[] = [];
  const olive = mat(LOWER.color, 0.72);
  const slate = mat(UPPER.color, 0.66);
  const metal = mat(0xa7adb0, 0.42, 0.75);
  const label = mat(0xd9d3c4, 0.85);
  const bag = mat(BAG.color, 0.58);
  const webbing = mat(0x1f4e5f, 0.9);
  webbing.side = THREE.DoubleSide;
  const materials = [olive, slate, metal, label, bag, webbing];

  const root = new THREE.Group();
  root.name = 'cine:courierCargo';
  // pitched with the deck's fall aft, about the bundle centre on the deck
  root.position.set(0, 0, BUNDLE_Z);
  root.rotation.x = -Math.atan(DECK_FALL);
  root.add(buildCase(LOWER, { body: olive, metal, label }, geos));
  root.add(buildCase(UPPER, { body: slate, metal, label }, geos));
  root.add(buildBag(bag, webbing, metal, geos));
  STRAP_Z.forEach((z, i) => {
    const geo = strapGeometry(z);
    geos.push(geo);
    root.add(new THREE.Mesh(geo, webbing));
    // the ratchet, on a flat top where a hand reaches it: the upper case for the first strap, the lower for the second
    const ratchet = new RoundedBoxGeometry(0.07, 0.03, 0.06, 1, 0.008);
    geos.push(ratchet);
    const r = new THREE.Mesh(ratchet, metal);
    const x = i === 0 ? UPPER.x + 0.06 : 0;
    r.position.set(x, profileAt(x, z) + 0.02, z);
    root.add(r);
  });
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.castShadow = true;
    m.receiveShadow = true;
  });
  return {
    object: root,
    dispose() {
      root.removeFromParent();
      for (const g of geos) g.dispose();
      for (const m of materials) m.dispose();
    },
  };
}
