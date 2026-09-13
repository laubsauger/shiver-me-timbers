#!/usr/bin/env node
/**
 * Speedboat asset conventions checker (docs/speedboat/asset-pipeline.md §Checker rules).
 *
 * FAILS the build when a GLB breaks the contract in src/speedboat/assets/assetContract.json:
 * hierarchy + names, extras, identity transforms, material slots and count, textures per
 * material, tri budgets per LOD, a manifold outward-wound hull per LOD, frame/axis/origin, tangents
 * under normal maps, and (stage `final`) meshopt + KTX2 with mip chains.
 *
 *   node scripts/blender/checkGlb.mjs <file.glb> [--stage raw|final] [--expect <hull.json>]
 *
 * `--expect` is a scripts/blender/hullOffsets.ts dump: the hull must then also sit on the physics
 * proxy's stem, transom, keel and deck (body frame, ±tolerance).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

export const CONTRACT_PATH = fileURLToPath(new URL('../../src/speedboat/assets/assetContract.json', import.meta.url));

export function loadContract(path = CONTRACT_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** raw file bytes — for callers (tests) that have no node typings of their own */
export function readBytes(path) {
  return new Uint8Array(readFileSync(path));
}

export async function createIO() {
  await MeshoptDecoder.ready;
  await MeshoptEncoder.ready;
  return new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
}

const fmt = (template, level) => template.replace('{level}', String(level));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function isIdentity(node) {
  const t = node.getTranslation();
  const r = node.getRotation();
  const s = node.getScale();
  const eps = 1e-6;
  return (
    Math.abs(t[0]) < eps && Math.abs(t[1]) < eps && Math.abs(t[2]) < eps &&
    Math.abs(r[0]) < eps && Math.abs(r[1]) < eps && Math.abs(r[2]) < eps && Math.abs(r[3] - 1) < eps &&
    Math.abs(s[0] - 1) < eps && Math.abs(s[1] - 1) < eps && Math.abs(s[2] - 1) < eps
  );
}

function applyMat4(m, x, y, z) {
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
}

/** triangles of a primitive as world-space position triples + raw vertex indices */
function primitiveTriangles(node, prim) {
  const pos = prim.getAttribute('POSITION');
  if (!pos) return { positions: [], tris: [] };
  const m = node.getWorldMatrix();
  const positions = [];
  const el = [0, 0, 0];
  for (let i = 0; i < pos.getCount(); i++) {
    pos.getElement(i, el);
    positions.push(applyMat4(m, el[0], el[1], el[2]));
  }
  const idx = prim.getIndices();
  const tris = [];
  const n = idx ? idx.getCount() : pos.getCount();
  for (let i = 0; i + 2 < n; i += 3) {
    tris.push(idx ? [idx.getScalar(i), idx.getScalar(i + 1), idx.getScalar(i + 2)] : [i, i + 1, i + 2]);
  }
  return { positions, tris };
}

function triCount(mesh) {
  let n = 0;
  for (const prim of mesh.listPrimitives()) {
    if (prim.getMode() !== 4) continue;
    const idx = prim.getIndices();
    const pos = prim.getAttribute('POSITION');
    n += Math.floor((idx ? idx.getCount() : pos ? pos.getCount() : 0) / 3);
  }
  return n;
}

/** distinct Texture objects reachable from a material (core slots and extension slots) */
function materialTextures(document, material) {
  const graph = document.getGraph();
  const found = new Set();
  const seen = new Set();
  const walk = (prop, depth) => {
    if (depth > 3 || seen.has(prop)) return;
    seen.add(prop);
    for (const child of graph.listChildren(prop)) {
      if (child.propertyType === 'Texture') found.add(child);
      else if (child.propertyType !== 'Accessor' && child.propertyType !== 'Buffer') walk(child, depth + 1);
    }
  };
  walk(material, 0);
  return found;
}

/**
 * Manifold + winding + volume of one hull: positions welded on a `tol` grid (glTF splits vertices
 * at UV seams and material boundaries, so raw indices never close); every undirected edge must be
 * used by exactly two triangles in opposite directions, and the signed volume must be positive.
 */
export function hullTopology(node, tol) {
  const keyOf = (p) => `${Math.round(p[0] / tol)},${Math.round(p[1] / tol)},${Math.round(p[2] / tol)}`;
  const ids = new Map();
  const directed = new Map();
  let degenerate = 0;
  let volume = 0;
  let tris = 0;
  for (const prim of node.getMesh().listPrimitives()) {
    const { positions, tris: t } = primitiveTriangles(node, prim);
    const welded = positions.map((p) => {
      const k = keyOf(p);
      if (!ids.has(k)) ids.set(k, ids.size);
      return ids.get(k);
    });
    for (const [a, b, c] of t) {
      tris++;
      const [ia, ib, ic] = [welded[a], welded[b], welded[c]];
      if (ia === ib || ib === ic || ia === ic) {
        degenerate++;
        continue;
      }
      const [p0, p1, p2] = [positions[a], positions[b], positions[c]];
      volume += (p0[0] * (p1[1] * p2[2] - p1[2] * p2[1]) - p0[1] * (p1[0] * p2[2] - p1[2] * p2[0]) + p0[2] * (p1[0] * p2[1] - p1[1] * p2[0])) / 6;
      for (const [u, v] of [[ia, ib], [ib, ic], [ic, ia]]) {
        const k = `${u}|${v}`;
        directed.set(k, (directed.get(k) ?? 0) + 1);
      }
    }
  }
  let open = 0;
  let overShared = 0;
  let flipped = 0;
  for (const [k, count] of directed) {
    if (count > 1) flipped += count - 1; // same direction twice = inconsistent winding or >2 faces
    const [u, v] = k.split('|');
    const back = directed.get(`${v}|${u}`) ?? 0;
    if (back === 0) open++;
    else if (back > 1 || count > 1) overShared++;
  }
  return { tris, degenerate, openEdges: open, nonManifoldEdges: overShared, windingConflicts: flipped, volume };
}

function bounds(node) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const all = [];
  for (const prim of node.getMesh().listPrimitives()) {
    for (const p of primitiveTriangles(node, prim).positions) {
      all.push(p);
      for (let i = 0; i < 3; i++) {
        if (p[i] < min[i]) min[i] = p[i];
        if (p[i] > max[i]) max[i] = p[i];
      }
    }
  }
  return { min, max, points: all };
}

/**
 * STYLE-SPEC C3: the render hull's sections sit on the physics proxy. At sampled stations the hull
 * is sliced by the plane z = station (so any mesh works, lofted or not):
 *   chine: widest point at or below the proxy chine height = halfBeamAt(z)            (±tol)
 *   sheer: widest point of the section = halfBeamAt(z) + flare term                      (±tol)
 * where the flare term is max(0, deckY − chineY − flareStart) · tan(topsideFlareDeg) (render-only
 * flare over the top of the topside, json renderOnly). Raked-stem stations (deckZ ≠ z) are skipped.
 */
export function sectionErrors(hull, expect, tol, samples = 24) {
  const errors = [];
  const { spec, stations } = expect;
  const ro = expect.renderOnly ?? {};
  const flare = ((ro.topsideFlareDeg ?? 0) * Math.PI) / 180;
  const fs = ro.topsideFlareStartAboveChine ?? 0;
  const tris = [];
  for (const prim of hull.getMesh().listPrimitives()) {
    const { positions, tris: t } = primitiveTriangles(hull, prim);
    for (const [a, b, c] of t) tris.push([positions[a], positions[b], positions[c]]);
  }
  const usable = stations.filter((s) => Math.abs((s.deckZ ?? s.z) - s.z) < 1e-6 && s.z > 0.01 * spec.length && s.chineHalfBeam > 0.1);
  const step = Math.max(1, Math.floor(usable.length / samples));
  const worst = { chine: null, sheer: null };
  let sliced = 0;
  for (let i = 0; i < usable.length; i += step) {
    const s = usable[i];
    const zb = s.z - spec.lcgFromTransom;
    const chineYb = s.chineY - spec.vcgAboveKeel;
    let chineX = -Infinity;
    let sheerX = -Infinity;
    for (const tri of tris) {
      for (let e = 0; e < 3; e++) {
        const p = tri[e];
        const q = tri[(e + 1) % 3];
        const dp = p[2] - zb;
        const dq = q[2] - zb;
        let hit = null;
        if (Math.abs(dp) < 1e-7) hit = p;
        else if (dp * dq < 0) {
          const t = dp / (dp - dq);
          hit = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, zb];
        }
        if (!hit) continue;
        const ax = Math.abs(hit[0]);
        if (ax > sheerX) sheerX = ax;
        if (hit[1] <= chineYb + 0.005 && ax > chineX) chineX = ax;
      }
    }
    if (!Number.isFinite(sheerX)) continue;
    sliced++;
    const wantChine = s.chineHalfBeam;
    const wantSheer = s.chineHalfBeam + Math.max(0, s.deckY - s.chineY - fs) * Math.tan(flare);
    for (const [kind, got, want] of [['chine', chineX, wantChine], ['sheer', sheerX, wantSheer]]) {
      const d = Math.abs(got - want);
      if (!(d <= tol) && (!worst[kind] || d > worst[kind].d)) worst[kind] = { d, got, want, z: s.z };
    }
  }
  if (sliced === 0) errors.push(`proxy: no hull section found at any proxy station (hull not on the proxy's z range)`);
  for (const kind of ['chine', 'sheer']) {
    const w = worst[kind];
    if (w) {
      errors.push(
        `proxy: ${kind} half-beam ${Number.isFinite(w.got) ? w.got.toFixed(3) : 'none'} ≠ proxy ${w.want.toFixed(3)} at station z ${w.z.toFixed(2)} (±${tol}; ` +
          (kind === 'chine' ? 'halfBeamAt' : 'halfBeamAt + flare over the top of the topside') + ', STYLE-SPEC C3)',
      );
    }
  }
  return errors;
}

const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum);

/**
 * Hero hull race number (STYLE-SPEC §4.3): the numeral field in M_Gelcoat's extras must sit wholly inside the clear
 * topside the build derived (pinstripe bottom → boot line, with a margin), and that clear band must itself sit on the
 * proxy topside: under the deck with room for the band, above the chine across the field's length. A freeboard change
 * that would clip the number into the band fails here instead of on screen.
 */
export function liveryErrors(document, expect, margin = 0.03) {
  const errors = [];
  for (const mat of document.getRoot().listMaterials()) {
    const hl = (mat.getExtras() ?? {}).hullLivery;
    if (!hl) continue;
    const nf = hl.numberField;
    const ct = hl.clearTopside;
    if (!nf || !ct || ![nf.zCentre, nf.yCentre, nf.height, nf.digitWidth, nf.gap, ct.top, ct.bottom, ct.zMin, ct.zMax].every(isNum)) {
      errors.push(`livery: ${mat.getName()} hullLivery needs numberField {zCentre, yCentre, height, digitWidth, gap} and clearTopside {top, bottom, zMin, zMax}`);
      continue;
    }
    const top = nf.yCentre + nf.height / 2;
    const bottom = nf.yCentre - nf.height / 2;
    const halfW = nf.digitWidth + nf.gap / 2;
    if (top > ct.top - margin) errors.push(`livery: race number top ${top.toFixed(3)} runs into the pinstripe/band (clear topside top ${ct.top.toFixed(3)}, margin ${margin})`);
    if (bottom < ct.bottom + margin) errors.push(`livery: race number bottom ${bottom.toFixed(3)} runs into the boot line (clear topside bottom ${ct.bottom.toFixed(3)}, margin ${margin})`);
    if (nf.zCentre - halfW < ct.zMin || nf.zCentre + halfW > ct.zMax) errors.push(`livery: race number z ${(nf.zCentre - halfW).toFixed(2)}..${(nf.zCentre + halfW).toFixed(2)} leaves its field ${ct.zMin}..${ct.zMax}`);
    const dn = hl.deckNumberField;
    const dp = hl.deckPanel;
    if (dn || dp) {
      if (!dn || !dp || ![dn.zCentre, dn.xCentre, dn.height, dn.digitWidth, dn.gap, dp.zMin, dp.zMax, dp.halfWidth].every(isNum)) {
        errors.push(`livery: ${mat.getName()} deck number needs deckNumberField {zCentre, xCentre, height, digitWidth, gap} and deckPanel {zMin, zMax, halfWidth}`);
      } else {
        const hw = dn.digitWidth + dn.gap / 2;
        if (Math.abs(dn.xCentre) + hw > dp.halfWidth - margin) errors.push(`livery: deck race number (half-width ${hw.toFixed(3)}) runs off its panel (half-width ${dp.halfWidth})`);
        if (dn.zCentre - dn.height / 2 < dp.zMin + margin || dn.zCentre + dn.height / 2 > dp.zMax - margin) {
          errors.push(`livery: deck race number z ${(dn.zCentre - dn.height / 2).toFixed(3)}..${(dn.zCentre + dn.height / 2).toFixed(3)} runs off its panel ${dp.zMin}..${dp.zMax}`);
        }
      }
    }
    if (expect?.proxy && expect?.stations && expect?.spec) {
      const { spec, stations, proxy } = expect;
      if (ct.top > proxy.deckBodyY - 0.10) errors.push(`livery: clear topside top ${ct.top.toFixed(3)} leaves < 0.10 m under the deck ${proxy.deckBodyY.toFixed(3)} for the band`);
      const z0 = nf.zCentre - halfW + spec.lcgFromTransom;
      const z1 = nf.zCentre + halfW + spec.lcgFromTransom;
      let chine = -Infinity;
      for (const st of stations) if (st.z >= z0 - 0.5 && st.z <= z1 + 0.5) chine = Math.max(chine, st.chineY - spec.vcgAboveKeel);
      if (Number.isFinite(chine) && bottom < chine + margin) errors.push(`livery: race number bottom ${bottom.toFixed(3)} is below the proxy chine ${chine.toFixed(3)} + ${margin}`);
    }
  }
  return errors;
}

/**
 * Parts hanging below the hull bottom at the transom FAIL the build (a bracket plate below the V reads as a broken
 * hull in every airborne shot). A slab of
 * parts vertices in the transom plane must not reach under the hull's own transom outline at the same x.
 */
export function transomOverhangErrors(lod0, hull) {
  const warnings = [];
  if (!lod0 || !hull) return warnings;
  const hb = bounds(hull);
  const zT = hb.min[2];
  // lower convex envelope of the transom outline in (|x|, y): the V bottom rises with |x|; strake notches
  // (≤ 3 cm) only make the envelope slightly conservative, hence the 3 cm threshold below
  const pts = hb.points.filter((p) => Math.abs(p[2] - zT) <= 0.01).map((p) => [Math.abs(p[0]), p[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2) {
      const [o, a] = [lower[lower.length - 2], lower[lower.length - 1]];
      if ((a[0] - o[0]) * (p[1] - o[1]) - (a[1] - o[1]) * (p[0] - o[0]) <= 0) lower.pop();
      else break;
    }
    lower.push(p);
  }
  const floorAt = (ax) => {
    if (lower.length < 2 || ax > lower[lower.length - 1][0]) return undefined;
    for (let i = 1; i < lower.length; i++) {
      if (ax <= lower[i][0]) {
        const [a, b] = [lower[i - 1], lower[i]];
        const t = b[0] > a[0] ? (ax - a[0]) / (b[0] - a[0]) : 0;
        return a[1] + (b[1] - a[1]) * t;
      }
    }
    return undefined;
  };
  let worst = null;
  const walk = (n) => {
    if (n.getMesh() && n !== hull) {
      for (const prim of n.getMesh().listPrimitives()) {
        for (const p of primitiveTriangles(n, prim).positions) {
          if (p[2] < zT - 0.03 || p[2] > zT + 0.003) continue;
          const floor = floorAt(Math.abs(p[0]));
          if (floor === undefined) continue;
          const below = floor - p[1];
          if (below > 0.03 && (!worst || below > worst.below)) worst = { below, x: p[0], y: p[1], floor, node: n.getName() };
        }
      }
    }
    n.listChildren().forEach(walk);
  };
  lod0.listChildren().forEach(walk);
  if (worst) {
    warnings.push(`parts: '${worst.node}' hangs ${worst.below.toFixed(3)} m below the hull transom bottom (x ${worst.x.toFixed(3)}, y ${worst.y.toFixed(3)} vs hull ${worst.floor.toFixed(3)}, body frame) — clip it to the transom profile`);
  }
  return warnings;
}

/**
 * Hero parts (root extras `partsVersion`, scripts/blender/parts/manifest.json): the runtime spins props
 * and turns the wheel, dial, levers and outboards WITHOUT node transforms (identity rule), so every
 * animated node must carry its pivot + axis in the body frame, and LOD0 must have a prop per outboard
 * that names the outboard it follows.
 */
export function partsErrors(lod0, lod1 = null) {
  const errors = [];
  if (!lod0) return errors;
  // §T.192: LOD1 folds each outboard + prop into `Drive_<id>`, which steers and trims about that outboard's own pivots
  for (const n of meshNodesUnder(lod1)) {
    if (!/^Drive_[A-Z]+_LOD1$/.test(n.getName())) continue;
    const ex = n.getExtras() ?? {};
    for (const k of ['steerPivot', 'steerAxis', 'trimPivot', 'trimAxis']) {
      if (!isVec3(ex[k])) errors.push(`parts: '${n.getName()}' extras.${k} must be a body-frame [x, y, z] (the LOD1 drive steers about its own swivel)`);
    }
  }
  const nodes = [];
  const walk = (n) => {
    if (n.getMesh()) nodes.push(n);
    n.listChildren().forEach(walk);
  };
  lod0.listChildren().forEach(walk);
  const names = new Set(nodes.map((n) => n.getName()));
  const outboards = nodes.filter((n) => /^Outboard_[A-Z]+_LOD0$/.test(n.getName()));
  const props = nodes.filter((n) => /^Prop_[A-Z]+_LOD0$/.test(n.getName()));
  if (outboards.length === 0) errors.push('parts: LOD0 has no Outboard_<id>_LOD0 node');
  for (const ob of outboards) {
    const id = ob.getName().slice('Outboard_'.length, -'_LOD0'.length);
    if (!names.has(`Prop_${id}_LOD0`)) errors.push(`parts: outboard ${id} has no separate prop node Prop_${id}_LOD0 (props spin at runtime)`);
    const ex = ob.getExtras() ?? {};
    for (const k of ['steerPivot', 'steerAxis', 'trimPivot', 'trimAxis']) {
      if (!isVec3(ex[k])) errors.push(`parts: '${ob.getName()}' extras.${k} must be a body-frame [x, y, z]`);
    }
  }
  for (const p of props) {
    const ex = p.getExtras() ?? {};
    if (ex.animRole !== 'propSpin') errors.push(`parts: '${p.getName()}' animRole must be 'propSpin'`);
    if (!isVec3(ex.pivot) || !isVec3(ex.axis)) errors.push(`parts: '${p.getName()}' needs extras.pivot and extras.axis [x, y, z]`);
    if (typeof ex.follows !== 'string' || !names.has(`${ex.follows}_LOD0`)) {
      errors.push(`parts: '${p.getName()}' extras.follows '${ex.follows}' does not name an LOD0 node (the prop must ride its outboard's trim/steer)`);
    }
  }
  for (const n of nodes) {
    const ex = n.getExtras() ?? {};
    if (['wheel', 'throttle', 'governorDial'].includes(ex.animRole) && (!isVec3(ex.pivot) || !isVec3(ex.axis))) {
      errors.push(`parts: '${n.getName()}' (${ex.animRole}) needs extras.pivot and extras.axis [x, y, z]`);
    }
  }
  return errors;
}

/** every mesh node under a LOD group, depth-first */
function meshNodesUnder(group) {
  const out = [];
  const walk = (n) => {
    if (n.getMesh()) out.push(n);
    n.listChildren().forEach(walk);
  };
  if (group) group.listChildren().forEach(walk);
  return out;
}

/** area of a convex polygon [[u, v], …] */
function polyArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

/** Sutherland–Hodgman: convex `subject` clipped by convex CCW `clip`, both [[u, v], …] */
function clipConvex(subject, clip) {
  let out = subject;
  for (let i = 0; i < clip.length && out.length > 0; i++) {
    const [ax, ay] = clip[i];
    const [bx, by] = clip[(i + 1) % clip.length];
    const side = (p) => (bx - ax) * (p[1] - ay) - (by - ay) * (p[0] - ax);
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j];
      const q = input[(j + 1) % input.length];
      const sp = side(p);
      const sq = side(q);
      if (sp >= 0) out.push(p);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
  }
  return out;
}

/**
 * §V98 ON THE BUILT GLB: TWO FACES MAY NOT SHARE A PLANE OVER AN AREA (§T.192, USER: "a bunch of z-fighting inside the
 * cockpit"). Every LOD0 triangle, in WORLD space through each node's real world matrix (§B118: never an additive
 * parent walk), is binned by plane; two triangles whose normals agree within `maxAngleDeg` (same facing — opposite
 * faces only fight when either material is double-sided) and whose vertices all lie within `planeTol` of the other's
 * plane are clipped against each other in that plane. Overlap polygons on one plane are clustered (touching bounds),
 * and a cluster wider than `minExtent` in BOTH in-plane axes is a fight. Adjacent triangles of one surface share only
 * an edge (zero overlap), so no identity bookkeeping is needed — which is also why two pieces JOINED into one node
 * are still caught. Returns [{area, extent: [du, dv], centre: [x, y, z], nodes: [a, b], materials: [a, b]}].
 */
export function coplanarOverlaps(lod0, { planeTol = 0.002, maxAngleDeg = 1.0, minExtent = 0.02 } = {}) {
  const tris = [];
  for (const node of meshNodesUnder(lod0)) {
    for (const prim of node.getMesh().listPrimitives()) {
      if (prim.getMode() !== 4) continue;
      const mat = prim.getMaterial();
      const ds = mat ? mat.getDoubleSided() : false;
      const { positions, tris: t } = primitiveTriangles(node, prim);
      for (const [a, b, c] of t) {
        const p0 = positions[a];
        const p1 = positions[b];
        const p2 = positions[c];
        const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
        const e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
        const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const len = Math.hypot(n[0], n[1], n[2]);
        if (len < 2e-6) continue; // < 1 mm² — nothing to fight over
        n[0] /= len;
        n[1] /= len;
        n[2] /= len;
        tris.push({ p: [p0, p1, p2], n, d: n[0] * p0[0] + n[1] * p0[1] + n[2] * p0[2], ds, node: node.getName(), mat: mat ? mat.getName() : '?' });
      }
    }
  }
  // bin by direction-independent plane (flip so the largest normal component is positive) at 1/40 normal + planeTol offset
  const canon = (t) => {
    const n = t.n;
    const big = Math.abs(n[0]) >= Math.abs(n[1]) && Math.abs(n[0]) >= Math.abs(n[2]) ? 0 : Math.abs(n[1]) >= Math.abs(n[2]) ? 1 : 2;
    const s = n[big] < 0 ? -1 : 1;
    return { n: [n[0] * s, n[1] * s, n[2] * s], d: t.d * s };
  };
  const cells = new Map();
  const keyOf = (c, dn = [0, 0, 0, 0]) =>
    `${Math.round(c.n[0] * 40) + dn[0]},${Math.round(c.n[1] * 40) + dn[1]},${Math.round(c.n[2] * 40) + dn[2]},${Math.round(c.d / planeTol) + dn[3]}`;
  tris.forEach((t, i) => {
    const c = canon(t);
    t.c = c;
    const k = keyOf(c);
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(i);
  });
  const cosMax = Math.cos((maxAngleDeg * Math.PI) / 180);
  const planeDist = (t, p) => Math.abs(t.n[0] * p[0] + t.n[1] * p[1] + t.n[2] * p[2] - t.d);
  const bboxOf = (t) => {
    const mn = [Infinity, Infinity, Infinity];
    const mx = [-Infinity, -Infinity, -Infinity];
    for (const p of t.p) for (let k = 0; k < 3; k++) {
      mn[k] = Math.min(mn[k], p[k]);
      mx[k] = Math.max(mx[k], p[k]);
    }
    return [mn, mx];
  };
  const overlapsByPlane = new Map(); // plane cell key → [{poly3 bbox, area, nodes}]
  const offsets = [];
  for (const a of [-1, 0, 1]) for (const b of [-1, 0, 1]) for (const c of [-1, 0, 1]) for (const d of [-1, 0, 1]) offsets.push([a, b, c, d]);
  for (let i = 0; i < tris.length; i++) {
    const A = tris[i];
    A.bb ??= bboxOf(A);
    const seen = new Set();
    for (const off of offsets) {
      const list = cells.get(keyOf(A.c, off));
      if (!list) continue;
      for (const j of list) {
        if (j <= i || seen.has(j)) continue;
        seen.add(j);
        const B = tris[j];
        const dot = A.n[0] * B.n[0] + A.n[1] * B.n[1] + A.n[2] * B.n[2];
        if (!(dot >= cosMax || (dot <= -cosMax && (A.ds || B.ds)))) continue;
        B.bb ??= bboxOf(B);
        let apart = false;
        for (let k = 0; k < 3; k++) if (A.bb[1][k] < B.bb[0][k] - planeTol || B.bb[1][k] < A.bb[0][k] - planeTol) apart = true;
        if (apart) continue;
        if (!B.p.every((p) => planeDist(A, p) <= planeTol) || !A.p.every((p) => planeDist(B, p) <= planeTol)) continue;
        // in-plane basis from A's canonical normal
        const n = A.c.n;
        const ax = Math.abs(n[0]) <= Math.abs(n[1]) && Math.abs(n[0]) <= Math.abs(n[2]) ? [1, 0, 0] : Math.abs(n[1]) <= Math.abs(n[2]) ? [0, 1, 0] : [0, 0, 1];
        let u = [n[1] * ax[2] - n[2] * ax[1], n[2] * ax[0] - n[0] * ax[2], n[0] * ax[1] - n[1] * ax[0]];
        const ul = Math.hypot(...u);
        u = u.map((x) => x / ul);
        const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
        const to2 = (p) => [p[0] * u[0] + p[1] * u[1] + p[2] * u[2], p[0] * v[0] + p[1] * v[1] + p[2] * v[2]];
        const ccw = (poly) => (polyArea(poly) < 0 ? poly.slice().reverse() : poly);
        const pa = ccw(A.p.map(to2));
        const pb = ccw(B.p.map(to2));
        const inter = clipConvex(pa, pb);
        if (inter.length < 3) continue;
        const area = Math.abs(polyArea(inter));
        if (area < 1e-6) continue;
        const k = keyOf(A.c);
        if (!overlapsByPlane.has(k)) overlapsByPlane.set(k, []);
        const us = inter.map((q) => q[0]);
        const vs = inter.map((q) => q[1]);
        // back to world for the report: centroid of the overlap polygon on A's plane
        const cu = us.reduce((s, x) => s + x, 0) / us.length;
        const cv = vs.reduce((s, x) => s + x, 0) / vs.length;
        const centre = [0, 1, 2].map((q) => u[q] * cu + v[q] * cv + n[q] * A.c.d);
        overlapsByPlane.get(k).push({ lo: [Math.min(...us), Math.min(...vs)], hi: [Math.max(...us), Math.max(...vs)], area, centre, normal: A.n, nodes: [A.node, B.node], materials: [A.mat, B.mat] });
      }
    }
  }
  const buriedAt = (c, n) => {
    const probe = { n, d: n[0] * c[0] + n[1] * c[1] + n[2] * c[2] };
    for (const off of offsets) {
      const list = cells.get(keyOf(canon(probe), off));
      if (!list) continue;
      for (const j of list) {
        const T = tris[j];
        if (T.ds || T.n[0] * n[0] + T.n[1] * n[1] + T.n[2] * n[2] > -cosMax) continue;
        if (planeDist(T, c) > planeTol) continue;
        // barycentric inside test in 3D
        const [a, b, cc] = T.p;
        const v0 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const v1 = [cc[0] - a[0], cc[1] - a[1], cc[2] - a[2]];
        const v2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const d00 = v0[0] * v0[0] + v0[1] * v0[1] + v0[2] * v0[2];
        const d01 = v0[0] * v1[0] + v0[1] * v1[1] + v0[2] * v1[2];
        const d11 = v1[0] * v1[0] + v1[1] * v1[1] + v1[2] * v1[2];
        const d20 = v2[0] * v0[0] + v2[1] * v0[1] + v2[2] * v0[2];
        const d21 = v2[0] * v1[0] + v2[1] * v1[1] + v2[2] * v1[2];
        const den = d00 * d11 - d01 * d01;
        if (Math.abs(den) < 1e-14) continue;
        const v = (d11 * d20 - d01 * d21) / den;
        const w = (d00 * d21 - d01 * d20) / den;
        if (v >= -1e-4 && w >= -1e-4 && v + w <= 1 + 1e-4) return true;
      }
    }
    return false;
  };
  const fights = [];
  for (const list of overlapsByPlane.values()) {
    // cluster touching overlap bounds (union-find)
    const parent = list.map((_, i) => i);
    const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (a.lo[0] <= b.hi[0] + 1e-4 && b.lo[0] <= a.hi[0] + 1e-4 && a.lo[1] <= b.hi[1] + 1e-4 && b.lo[1] <= a.hi[1] + 1e-4) parent[find(i)] = find(j);
    }
    const groups = new Map();
    list.forEach((o, i) => {
      const r = find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(o);
    });
    for (const g of groups.values()) {
      const lo = [Math.min(...g.map((o) => o.lo[0])), Math.min(...g.map((o) => o.lo[1]))];
      const hi = [Math.max(...g.map((o) => o.hi[0])), Math.max(...g.map((o) => o.hi[1]))];
      const extent = [hi[0] - lo[0], hi[1] - lo[1]];
      if (extent[0] <= minExtent || extent[1] <= minExtent) continue;
      const area = g.reduce((s, o) => s + o.area, 0);
      const big = g.reduce((m, o) => (o.area > m.area ? o : m), g[0]);
      // BURIED: the shared plane is pressed against an opposite-facing opaque face (a cleat base on the deck, two
      // plates bolted face to face). Nothing can see it, so nothing fights — skip when a single-sided face looking the
      // other way covers the overlap's centre.
      if (buriedAt(big.centre, big.normal)) continue;
      fights.push({ area, extent, centre: big.centre, normal: big.normal, nodes: big.nodes, materials: big.materials });
    }
  }
  return fights.sort((a, b) => b.area - a.area);
}

export function coplanarErrors(lod0, opts) {
  return coplanarOverlaps(lod0, opts).map(
    (f) =>
      `z-fight: coplanar overlap ${(f.extent[0] * 100).toFixed(1)} × ${(f.extent[1] * 100).toFixed(1)} cm (${(f.area * 1e4).toFixed(1)} cm²) ` +
      `at body (${f.centre.map((x) => x.toFixed(3)).join(', ')}) between ${f.nodes[0]}:${f.materials[0]} and ${f.nodes[1]}:${f.materials[1]} — ` +
      `lift one ON the other or make them abut (§V98, > 2 mm apart)`,
  );
}

/** distance from point p to triangle (a, b, c) — Ericson, Real-Time Collision Detection §5.1.5 */
function pointTriDistance(p, a, b, c) {
  const sub = (x, y) => [x[0] - y[0], x[1] - y[1], x[2] - y[2]];
  const dot = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  let q;
  if (d1 <= 0 && d2 <= 0) q = a;
  else {
    const bp = sub(p, b);
    const d3 = dot(ab, bp);
    const d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) q = b;
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const t = d1 / (d1 - d3);
        q = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
      } else {
        const cp = sub(p, c);
        const d5 = dot(ab, cp);
        const d6 = dot(ac, cp);
        if (d6 >= 0 && d5 <= d6) q = c;
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const t = d2 / (d2 - d6);
            q = [a[0] + ac[0] * t, a[1] + ac[1] * t, a[2] + ac[2] * t];
          } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const t = (d4 - d3) / (d4 - d3 + (d5 - d6));
              q = [b[0] + (c[0] - b[0]) * t, b[1] + (c[1] - b[1]) * t, b[2] + (c[2] - b[2]) * t];
            } else {
              const den = 1 / (va + vb + vc);
              const v = vb * den;
              const w = vc * den;
              q = [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
            }
          }
        }
      }
    }
  }
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/**
 * OUTBOARD LOD SILHOUETTE (§T.192, USER: "engine of NPCs is poking out of the water when viewed from more than ~10 m").
 * The drives are what sits in and just above the water, so a coarser LOD whose faces bridge out of the LOD0 shape (a
 * collapse that webs the skeg to the cav plate, a cowl that swells) reads as the engine poking out. For each engine
 * (LOD0 `Outboard_<id>` + `Prop_<id>`), sample every coarse triangle of THAT engine — vertices, edge midpoints and the
 * centroid, so a bridging face is caught even when its corners sit on the surface — and measure the distance to the
 * LOD0 surface. Coarse geometry per engine: LOD1 `Drive_<id>` (or legacy merged `Drives` by x band); LOD2 the merged
 * `Parts` samples inside the LOD0 engine's bounds (+5 cm) and ≥ 10 cm aft of its forward face (the bracket mount
 * plates it bolts to live there). One-sided (LODn → LOD0): a coarse LOD may lose a hose, it may not add shape.
 * Returns [{level, engine, worst, at, node, samples}] for every engine and level.
 */
export function driveLodDeviation(lodGroups) {
  const out = [];
  const lod0 = lodGroups[0];
  if (!lod0) return out;
  const engines = new Map(); // id → {tris, min, max}
  for (const n of meshNodesUnder(lod0)) {
    const m = /^(Outboard|Prop)_([A-Z]+)_LOD0$/.exec(n.getName());
    if (!m) continue;
    if (!engines.has(m[2])) engines.set(m[2], { tris: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
    const e = engines.get(m[2]);
    for (const prim of n.getMesh().listPrimitives()) {
      const { positions, tris } = primitiveTriangles(n, prim);
      for (const [a, b, c] of tris) e.tris.push([positions[a], positions[b], positions[c]]);
      for (const p of positions) for (let k = 0; k < 3; k++) {
        e.min[k] = Math.min(e.min[k], p[k]);
        e.max[k] = Math.max(e.max[k], p[k]);
      }
    }
  }
  if (engines.size === 0) return out;
  const ids = [...engines.keys()];
  const cell = 0.05;
  const grids = new Map();
  for (const id of ids) {
    const g = new Map();
    for (const t of engines.get(id).tris) {
      const mn = [0, 1, 2].map((k) => Math.floor(Math.min(t[0][k], t[1][k], t[2][k]) / cell));
      const mx = [0, 1, 2].map((k) => Math.floor(Math.max(t[0][k], t[1][k], t[2][k]) / cell));
      for (let i = mn[0]; i <= mx[0]; i++) for (let j = mn[1]; j <= mx[1]; j++) for (let k = mn[2]; k <= mx[2]; k++) {
        const key = `${i},${j},${k}`;
        if (!g.has(key)) g.set(key, []);
        g.get(key).push(t);
      }
    }
    grids.set(id, g);
  }
  // nearest LOD0 surface, searched in growing shells until a hit bounds the answer (exact, not capped)
  const nearest = (id, p) => {
    const g = grids.get(id);
    const c = p.map((v) => Math.floor(v / cell));
    let best = Infinity;
    for (let r = 0; r < 40; r++) {
      for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) for (let k = -r; k <= r; k++) {
        if (Math.max(Math.abs(i), Math.abs(j), Math.abs(k)) !== r) continue;
        const list = g.get(`${c[0] + i},${c[1] + j},${c[2] + k}`);
        if (!list) continue;
        for (const t of list) {
          const d = pointTriDistance(p, t[0], t[1], t[2]);
          if (d < best) best = d;
        }
      }
      if (best <= r * cell) break;
    }
    return best;
  };
  const centre = (id) => (engines.get(id).min[0] + engines.get(id).max[0]) / 2;
  const samplesOf = (t) => {
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    return [t[0], t[1], t[2], mid(t[0], t[1]), mid(t[1], t[2]), mid(t[2], t[0]), [(t[0][0] + t[1][0] + t[2][0]) / 3, (t[0][1] + t[1][1] + t[2][1]) / 3, (t[0][2] + t[1][2] + t[2][2]) / 3]];
  };
  for (let level = 1; level < lodGroups.length; level++) {
    const worst = new Map(ids.map((id) => [id, { level, engine: id, worst: 0, at: null, node: null, samples: 0 }]));
    const visit = (id, node, p) => {
      const d = nearest(id, p);
      if (!Number.isFinite(d)) return;
      const w = worst.get(id);
      w.samples++;
      if (d > w.worst) Object.assign(w, { worst: d, at: p, node });
    };
    const nodes = meshNodesUnder(lodGroups[level]);
    const own = new Map(nodes.map((n) => [n, /^Drive_([A-Z]+)_LOD\d+$/.exec(n.getName())?.[1]]));
    const hasOwn = [...own.values()].some(Boolean);
    for (const n of nodes) {
      const name = n.getName();
      if (/^Hull_/.test(name)) continue;
      const ownId = own.get(n);
      const legacyDrives = /^Drives_LOD\d+$/.test(name);
      if (hasOwn && !ownId && !/^Parts_/.test(name)) continue;
      for (const prim of n.getMesh().listPrimitives()) {
        const { positions, tris } = primitiveTriangles(n, prim);
        for (const [a, b, c] of tris) {
          for (const p of samplesOf([positions[a], positions[b], positions[c]])) {
            if (ownId && engines.has(ownId)) {
              visit(ownId, name, p);
              continue;
            }
            if (hasOwn && !/^Parts_/.test(name)) continue;
            // nearest engine by x, then the bounds gate (merged nodes only)
            let id = ids[0];
            for (const e of ids) if (Math.abs(p[0] - centre(e)) < Math.abs(p[0] - centre(id))) id = e;
            const e = engines.get(id);
            if (!legacyDrives) {
              const inside = [0, 1, 2].every((k) => p[k] >= e.min[k] - 0.05 && p[k] <= e.max[k] + 0.05) && p[2] <= e.max[2] - 0.10;
              if (!inside) continue;
            }
            visit(id, name, p);
          }
        }
      }
    }
    out.push(...worst.values());
  }
  return out;
}

export function driveLodErrors(lodGroups, opts = {}) {
  const tol = opts.tol ?? 0.02;
  return driveLodDeviation(lodGroups)
    .filter((r) => r.worst > tol)
    .map((r) => `lod: engine ${r.engine} at LOD${r.level} ('${r.node}') stands ${(r.worst * 100).toFixed(1)} cm off its LOD0 surface at body (${r.at.map((x) => x.toFixed(3)).join(', ')}) > ${tol * 100} cm — a coarse drive must not grow out of the LOD0 silhouette (§T.192)`);
}

/**
 * WATER MASK (§T.192, USER: "we see water poking through the boat's bottom"). The rest waterline stands above the cockpit
 * sole, so the sea surface inside the hull shows through the well opening; the runtime caps that opening with a
 * depth-only mesh drawn before the (transparent) ocean (src/speedboat/assets/waterMask.ts). The cap comes from root
 * extras `waterMask` {y, soleY, outline: [[x, z], …]} and must: sit on the deck (y = deckY), cover every sole vertex of
 * the LOD0 hull (else water shows in the uncovered corner), and stay ≥ 5 cm inside the deck edge (else it hides real
 * sea behind the topsides). Required on the hero hull (`hullKind: 'hero'`).
 */
export function waterMaskErrors(rx, lod0, tol = 0.02) {
  const errors = [];
  if (rx.waterMask === undefined) {
    if (rx.hullKind === 'hero') errors.push("water mask: hero hull root extras have no 'waterMask' (the sea would show inside the cockpit well)");
    return errors;
  }
  let wm = rx.waterMask;
  if (typeof wm === 'string') {
    try {
      wm = JSON.parse(wm);
    } catch {
      errors.push('water mask: waterMask is not JSON');
      return errors;
    }
  }
  const outline = wm?.outline;
  if (!isNum(wm?.y) || !isNum(wm?.soleY) || !Array.isArray(outline) || outline.length < 8 || !outline.every((q) => Array.isArray(q) && q.length === 2 && q.every(isNum))) {
    errors.push('water mask: waterMask needs {y, soleY, outline: [[x, z], … ≥ 8]} with finite numbers');
    return errors;
  }
  if (isNum(rx.deckY) && Math.abs(wm.y - rx.deckY) > tol) errors.push(`water mask: cap y ${wm.y} is not on the deck ${rx.deckY} (±${tol})`);
  const hull = meshNodesUnder(lod0).find((n) => (n.getExtras() ?? {}).foamTarget === true);
  if (!hull) return errors;
  const pts = bounds(hull).points;
  const inside = (x, z) => {
    let c = false;
    for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
      const [xi, zi] = outline[i];
      const [xj, zj] = outline[j];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
    }
    return c;
  };
  // sole = hull vertices at the sole height that are INSIDE the shell (the outer topside and bottom also cross that
  // height, at the hull's own half-width): ≥ 10 cm inboard of the widest hull point in their 5 × 5 cm (z, y) bin
  const outer = new Map();
  const bin = (p) => `${Math.round(p[2] / 0.05)},${Math.round(p[1] / 0.05)}`;
  for (const p of pts) outer.set(bin(p), Math.max(outer.get(bin(p)) ?? 0, Math.abs(p[0])));
  const sole = pts.filter((p) => Math.abs(p[1] - wm.soleY) < 0.005 && Math.abs(p[0]) < (outer.get(bin(p)) ?? 0) - 0.1);
  if (sole.length === 0) errors.push(`water mask: no LOD0 hull vertex on the sole y ${wm.soleY} (the cap cannot be checked against the well)`);
  const missed = sole.filter((p) => !inside(p[0], p[2]));
  if (missed.length > 0) {
    const m = missed[0];
    errors.push(`water mask: ${missed.length} sole vertices lie outside the cap outline, e.g. (${m[0].toFixed(3)}, ${m[2].toFixed(3)}) — water would show in that part of the well`);
  }
  // the deck edge: widest hull point near deck height at each outline z
  const deckPts = pts.filter((p) => p[1] > wm.y - 0.1);
  for (const [x, z] of outline) {
    let edge = 0;
    for (const p of deckPts) if (Math.abs(p[2] - z) < 0.08) edge = Math.max(edge, Math.abs(p[0]));
    if (Math.abs(x) > edge - 0.05) {
      errors.push(`water mask: cap point (${x.toFixed(3)}, ${z.toFixed(3)}) is within 5 cm of the deck edge ${edge.toFixed(3)} — it would hide the sea beside the hull`);
      break;
    }
  }
  return errors;
}

/**
 * PARTS SOCKETS (§T.192, pilot-log v2): the pilot build and the runtime seat the pilot and wrap its hands from named
 * body-frame sockets in root extras `partsSockets`, not from constants copied out of the part scripts. They must all
 * exist, agree with the animated nodes they describe, and be REACHABLE: the v1 helm sat below the seat pan and the
 * quadrant 0.67 m off-centre, which bent the pilot 43° forward and put the wheel out of the cockpit view.
 */
export function partsSocketErrors(rx, lod0) {
  const errors = [];
  if (rx.partsVersion === undefined) return errors;
  let s = rx.partsSockets;
  if (typeof s === 'string') {
    try {
      s = JSON.parse(s);
    } catch {
      s = undefined;
    }
  }
  if (!s || typeof s !== 'object') return ["sockets: root extras have no 'partsSockets' (seat, wheelRim, throttleHandle, footrest, dashCableAnchor)"];
  const need = {
    seat: ['position', 'up', 'forward'],
    wheelRim: ['centre', 'axis'],
    throttleHandle: ['position', 'pivot', 'axis'],
    footrest: ['centre', 'axis'],
    dashCableAnchor: ['position', 'normal'],
  };
  for (const [name, keys] of Object.entries(need)) {
    if (!s[name]) {
      errors.push(`sockets: '${name}' is missing from partsSockets`);
      continue;
    }
    for (const k of keys) if (!isVec3(s[name][k])) errors.push(`sockets: ${name}.${k} must be a body-frame [x, y, z]`);
  }
  for (const [name, k] of [['wheelRim', 'radius'], ['wheelRim', 'tube'], ['footrest', 'halfLength'], ['footrest', 'radius']]) {
    if (s[name] && !(isNum(s[name][k]) && s[name][k] > 0)) errors.push(`sockets: ${name}.${k} must be a positive number`);
  }
  if (errors.length) return errors;
  const node = (re) => meshNodesUnder(lod0).find((n) => re.test(n.getName()));
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const helm = node(/^Helm_LOD0$/);
  if (helm && isVec3(helm.getExtras()?.pivot) && dist(helm.getExtras().pivot, s.wheelRim.centre) > 0.01) errors.push('sockets: wheelRim.centre is not the Helm_LOD0 pivot (±1 cm)');
  const thr = node(/^Throttle_LOD0$/);
  if (thr && isVec3(thr.getExtras()?.pivot) && dist(thr.getExtras().pivot, s.throttleHandle.pivot) > 0.01) errors.push('sockets: throttleHandle.pivot is not the Throttle_LOD0 pivot (±1 cm)');
  // reach, in the seat frame (pilot-log v2 ergonomics): hub above the pan and ahead within bent-elbow reach; the
  // quadrant within natural lateral reach, at forearm-rest height
  const [sx, sy, sz] = s.seat.position;
  const hub = s.wheelRim.centre;
  if (!(hub[1] - sy >= 0.15 && hub[1] - sy <= 0.45)) errors.push(`sockets: wheel hub ${(hub[1] - sy).toFixed(2)} m above the seat pan (reach band 0.15–0.45)`);
  if (!(hub[2] - sz >= 0.35 && hub[2] - sz <= 0.65)) errors.push(`sockets: wheel hub ${(hub[2] - sz).toFixed(2)} m ahead of the seat (reach band 0.35–0.65)`);
  const th = s.throttleHandle.position;
  if (!(Math.abs(th[0] - sx) >= 0.3 && Math.abs(th[0] - sx) <= 0.5)) errors.push(`sockets: throttle handle ${Math.abs(th[0] - sx).toFixed(2)} m off the seat centreline (natural reach 0.30–0.50)`);
  if (!(th[1] - sy >= 0.05 && th[1] - sy <= 0.35)) errors.push(`sockets: throttle handle ${(th[1] - sy).toFixed(2)} m above the pan (forearm-rest band 0.05–0.35)`);
  return errors;
}

export function ktx2LevelCount(bytes) {
  const id = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!bytes || bytes.length < 48 || id.some((b, i) => bytes[i] !== b)) return -1;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(40, true);
}

/**
 * Check one Document against the contract.
 * @param {import('@gltf-transform/core').Document} document
 * @param {object} contract            parsed assetContract.json
 * @param {{stage?: 'raw'|'final', expect?: object}} [opts]
 * @returns {{errors: string[], warnings: string[], stats: object}}
 */
export function checkDocument(document, contract, opts = {}) {
  const stage = opts.stage ?? 'raw';
  const errors = [];
  const warnings = [];
  const tol = contract.tolerance.extrasVsGeometry;
  const root = document.getRoot();
  const stats = { tris: [], materials: 0, textures: root.listTextures().length, drawsPerLod: [] };

  // ── hierarchy + root extras ───────────────────────────────────────────
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  const roots = scene ? scene.listChildren() : [];
  if (roots.length !== 1) {
    errors.push(`hierarchy: expected exactly 1 root node, found ${roots.length} (${roots.map((n) => n.getName()).join(', ')})`);
    return { errors, warnings, stats };
  }
  const rootNode = roots[0];
  const rx = rootNode.getExtras() ?? {};
  for (const key of contract.extras.root) {
    if (rx[key] === undefined) errors.push(`extras: root '${rootNode.getName()}' is missing '${key}'`);
  }
  const kind = contract.assetKinds[rx.assetKind];
  if (rx.assetKind !== undefined && !kind) errors.push(`extras: assetKind '${rx.assetKind}' is not one of ${Object.keys(contract.assetKinds).join('|')}`);
  if (rx.contractVersion !== undefined && rx.contractVersion !== contract.version) {
    errors.push(`extras: contractVersion ${rx.contractVersion} ≠ contract ${contract.version}`);
  }
  for (const key of ['bowZ', 'sternZ', 'beam', 'keelY', 'deckY']) {
    if (rx[key] !== undefined && !isNum(rx[key])) errors.push(`extras: root '${key}' must be a finite number, got ${JSON.stringify(rx[key])}`);
  }
  if (isNum(rx.bowZ) && isNum(rx.sternZ) && !(rx.bowZ > 0 && rx.sternZ < 0)) {
    errors.push(`frame: origin must be at the CG between stern and bow (sternZ ${rx.sternZ} < 0 < bowZ ${rx.bowZ})`);
  }

  // ── identity transforms (shipLocalPos = positionLocal, wetline span in metres) ─
  const allNodes = [];
  const visit = (n) => {
    allNodes.push(n);
    n.listChildren().forEach(visit);
  };
  visit(rootNode);
  for (const n of allNodes) {
    if (!isIdentity(n)) errors.push(`frame: node '${n.getName()}' has a non-identity transform (geometry must be authored in the body frame)`);
  }

  // ── LOD groups ────────────────────────────────────────────────────────
  const lodGroups = rootNode.listChildren();
  const byLevel = new Map();
  for (const g of lodGroups) {
    const m = /^LOD(\d+)$/.exec(g.getName());
    const lvl = g.getExtras()?.lodLevel;
    if (!m) {
      errors.push(`hierarchy: root child '${g.getName()}' is not a LOD group (expected ${fmt(contract.names.lodGroup, 'n')})`);
      continue;
    }
    if (lvl !== Number(m[1])) errors.push(`extras: '${g.getName()}' lodLevel ${JSON.stringify(lvl)} ≠ ${m[1]}`);
    byLevel.set(Number(m[1]), g);
  }
  const levels = [...byLevel.keys()].sort((a, b) => a - b);
  if (levels.length === 0 || levels[0] !== 0) errors.push('hierarchy: LOD0 group is missing');
  levels.forEach((l, i) => {
    if (l !== i) errors.push(`hierarchy: LOD levels must be contiguous from 0, got ${levels.join(',')}`);
  });
  if (levels.length > contract.lod.levels) errors.push(`hierarchy: ${levels.length} LOD groups > contract ${contract.lod.levels}`);

  // ── per-LOD meshes, budgets, hull ─────────────────────────────────────
  const usedMaterials = new Set();
  let prevTris = Infinity;
  for (const level of levels) {
    const group = byLevel.get(level);
    let tris = 0;
    let draws = 0;
    const hulls = [];
    const meshNodes = [];
    const walk = (n) => {
      if (n.getMesh()) meshNodes.push(n);
      n.listChildren().forEach(walk);
    };
    group.listChildren().forEach(walk);
    for (const n of meshNodes) {
      const name = n.getName();
      const suffix = fmt(contract.names.meshSuffix, level);
      if (!name.endsWith(suffix)) errors.push(`names: mesh node '${name}' under LOD${level} must end with '${suffix}'`);
      const ex = n.getExtras() ?? {};
      if (ex.lodLevel !== level) errors.push(`extras: mesh '${name}' lodLevel ${JSON.stringify(ex.lodLevel)} ≠ ${level}`);
      if (ex.foamTarget === true) hulls.push(n);
      tris += triCount(n.getMesh());
      for (const prim of n.getMesh().listPrimitives()) {
        draws++;
        const mat = prim.getMaterial();
        if (!mat) {
          errors.push(`materials: primitive of '${name}' has no material`);
          continue;
        }
        usedMaterials.add(mat);
        if (mat.getNormalTexture() && !prim.getAttribute('TANGENT')) {
          errors.push(`tangents: '${name}' uses a normal map (${mat.getName()}) but has no TANGENT attribute (export MikkTSpace tangents)`);
        }
        if (materialTextures(document, mat).size > 0 && !prim.getAttribute('TEXCOORD_0')) {
          errors.push(`uv: '${name}' has textured material ${mat.getName()} but no TEXCOORD_0`);
        }
      }
    }
    stats.tris[level] = tris;
    stats.drawsPerLod[level] = draws;
    if (kind) {
      const budget = kind.triBudget[level];
      if (budget !== undefined && tris > budget) errors.push(`budget: LOD${level} has ${tris} tris > ${rx.assetKind} budget ${budget}`);
    }
    if (kind?.drawBudget) {
      const dbudget = kind.drawBudget[level];
      if (dbudget !== undefined && draws > dbudget) {
        errors.push(`budget: LOD${level} has ${draws} draws > ${rx.assetKind} draw budget ${dbudget} (merge static parts per slot; only animated nodes stay separate)`);
      }
    }
    if (tris >= prevTris) errors.push(`budget: LOD${level} (${tris} tris) is not lighter than LOD${level - 1} (${prevTris})`);
    prevTris = tris;

    const expectedHull = fmt(contract.names.hull, level);
    if (hulls.length !== 1) {
      errors.push(`extras: LOD${level} needs exactly one foamTarget mesh (${expectedHull}), found ${hulls.length}`);
      continue;
    }
    const hull = hulls[0];
    if (hull.getName() !== expectedHull) errors.push(`names: foamTarget mesh '${hull.getName()}' must be named '${expectedHull}'`);
    const topo = hullTopology(hull, contract.tolerance.weld);
    if (topo.openEdges > 0 || topo.nonManifoldEdges > 0 || topo.windingConflicts > 0 || topo.degenerate > 0) {
      errors.push(
        `manifold: ${hull.getName()} is not a closed consistently-wound shell (open edges ${topo.openEdges}, ` +
          `non-manifold ${topo.nonManifoldEdges}, winding conflicts ${topo.windingConflicts}, degenerate tris ${topo.degenerate})`,
      );
    } else if (!(topo.volume > 0)) {
      errors.push(`manifold: ${hull.getName()} encloses non-positive volume ${topo.volume.toFixed(3)} m³ (inside-out)`);
    }

    // ── frame: bow +Z, up +Y, origin at CG, extras describe this geometry ─
    const b = bounds(hull);
    const L = b.max[2] - b.min[2];
    const halfW = Math.max(Math.abs(b.min[0]), Math.abs(b.max[0]));
    const H = b.max[1] - b.min[1];
    if (!(L > 2 * halfW && L > H)) errors.push(`frame: ${hull.getName()} is longest along X/Y, not Z (L ${L.toFixed(2)}, beam ${(2 * halfW).toFixed(2)}, H ${H.toFixed(2)}) — bow must point +Z`);
    if (Math.abs(b.min[0] + b.max[0]) > tol) errors.push(`frame: ${hull.getName()} is not symmetric about x = 0 (x ∈ [${b.min[0].toFixed(3)}, ${b.max[0].toFixed(3)}])`);
    const widthNear = (zTest) => Math.max(0, ...b.points.filter((p) => Math.abs(p[2] - zTest) < 0.05 * L).map((p) => Math.abs(p[0])));
    if (!(widthNear(b.max[2]) < 0.5 * widthNear(b.min[2]))) errors.push(`frame: ${hull.getName()} is wider at +Z than at −Z — the bow must point +Z (transom at −Z)`);
    const keelHalf = Math.max(0, ...b.points.filter((p) => p[1] < b.min[1] + 0.03 * H).map((p) => Math.abs(p[0])));
    if (!(keelHalf < 0.35 * halfW)) errors.push(`frame: ${hull.getName()}'s lowest points span ${(2 * keelHalf).toFixed(2)} m — keel must be down (+Y up)`);
    if (level === 0) {
      const near = (a, v) => isNum(a) && Math.abs(a - v) <= tol;
      if (isNum(rx.bowZ) && !near(rx.bowZ, b.max[2])) errors.push(`extras: bowZ ${rx.bowZ} ≠ hull max z ${b.max[2].toFixed(3)} (±${tol})`);
      if (isNum(rx.sternZ) && !near(rx.sternZ, b.min[2])) errors.push(`extras: sternZ ${rx.sternZ} ≠ hull min z ${b.min[2].toFixed(3)} (±${tol})`);
      if (isNum(rx.beam) && !near(rx.beam, 2 * halfW)) errors.push(`extras: beam ${rx.beam} ≠ hull beam ${(2 * halfW).toFixed(3)} (±${tol})`);
      if (isNum(rx.keelY) && !near(rx.keelY, b.min[1])) errors.push(`extras: keelY ${rx.keelY} ≠ hull min y ${b.min[1].toFixed(3)} (±${tol})`);
      if (isNum(rx.deckY) && !near(rx.deckY, b.max[1])) errors.push(`extras: deckY ${rx.deckY} ≠ hull max y ${b.max[1].toFixed(3)} (±${tol})`);
      const px = opts.expect?.proxy;
      if (px) {
        const vs = [
          ['stem', b.max[2], px.stemZ],
          ['transom', b.min[2], px.transomZ],
          ['keel', b.min[1], px.keelBodyY],
          ['deck', b.max[1], px.deckBodyY],
        ];
        for (const [label, got, want] of vs) {
          if (!near(got, want)) errors.push(`proxy: hull ${label} ${got.toFixed(3)} ≠ physics proxy ${want.toFixed(3)} (±${tol}) — origin/scale off the CG body frame`);
        }
        if (!(2 * halfW >= px.chineBeam - tol)) errors.push(`proxy: hull beam ${(2 * halfW).toFixed(3)} < proxy chine beam ${px.chineBeam}`);
      }
      if (opts.expect?.stations && opts.expect?.spec) errors.push(...sectionErrors(hull, opts.expect, tol));
    }
  }

  if (rx.partsVersion !== undefined) errors.push(...partsErrors(byLevel.get(0), byLevel.get(1)));
  // §V98 on the drawn geometry, and the drives' coarse LODs on their LOD0 silhouette (§T.192)
  errors.push(...coplanarErrors(byLevel.get(0)));
  errors.push(...driveLodErrors(levels.map((l) => byLevel.get(l))));
  errors.push(...waterMaskErrors(rx, byLevel.get(0)));
  errors.push(...partsSocketErrors(rx, byLevel.get(0)));
  errors.push(...liveryErrors(document, opts.expect));
  const lod0 = byLevel.get(0);
  if (lod0) {
    const hull0 = [];
    const w0 = (n) => {
      if (n.getMesh() && (n.getExtras() ?? {}).foamTarget === true) hull0.push(n);
      n.listChildren().forEach(w0);
    };
    lod0.listChildren().forEach(w0);
    if (hull0.length === 1) errors.push(...transomOverhangErrors(lod0, hull0[0]));
  }

  // ── materials + textures ──────────────────────────────────────────────
  stats.materials = usedMaterials.size;
  if (usedMaterials.size > contract.maxMaterials) {
    errors.push(`materials: ${usedMaterials.size} materials > ${contract.maxMaterials} (${[...usedMaterials].map((m) => m.getName()).join(', ')})`);
  }
  const names = new Set();
  for (const mat of usedMaterials) {
    const name = mat.getName();
    if (names.has(name)) errors.push(`materials: slot '${name}' appears as two different materials`);
    names.add(name);
    const slot = contract.slots[name];
    if (!slot) {
      errors.push(`materials: '${name}' is not a contract slot (${Object.keys(contract.slots).join(', ')})`);
      continue;
    }
    if (stage === 'final' && mat.getAlphaMode() !== slot.alphaMode) {
      errors.push(`materials: ${name} alphaMode ${mat.getAlphaMode()} ≠ contract ${slot.alphaMode}`);
    }
    const nTex = materialTextures(document, mat).size;
    if (nTex > contract.maxTexturesPerMaterial) {
      errors.push(`textures: ${name} samples ${nTex} textures > ${contract.maxTexturesPerMaterial} (§V40 sampler wall)`);
    }
  }

  // ── final-stage packaging ─────────────────────────────────────────────
  if (stage === 'final') {
    const used = root.listExtensionsUsed().map((e) => e.extensionName);
    if (!used.includes('EXT_meshopt_compression')) errors.push('package: final GLB is not meshopt-compressed (EXT_meshopt_compression)');
    for (const tex of root.listTextures()) {
      if (tex.getMimeType() !== 'image/ktx2') {
        errors.push(`package: texture '${tex.getName() || tex.getURI()}' is ${tex.getMimeType()}, not KTX2`);
        continue;
      }
      const levelsInFile = ktx2LevelCount(tex.getImage());
      const size = tex.getSize();
      const want = size ? Math.floor(Math.log2(Math.max(size[0], size[1]))) + 1 : 2;
      if (levelsInFile < want) errors.push(`package: KTX2 '${tex.getName()}' has ${levelsInFile} mip levels < full chain ${want} (§V48)`);
    }
  }
  return { errors, warnings, stats };
}

export async function checkGlbFile(path, opts = {}) {
  const io = await createIO();
  const document = await io.read(path);
  return checkDocument(document, opts.contract ?? loadContract(), opts);
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--stage' && args[args.indexOf(a) - 1] !== '--expect');
  const stage = args.includes('--stage') ? args[args.indexOf('--stage') + 1] : 'raw';
  const expectPath = args.includes('--expect') ? args[args.indexOf('--expect') + 1] : null;
  if (!file) {
    console.error('usage: node scripts/blender/checkGlb.mjs <file.glb> [--stage raw|final] [--expect hull.json]');
    process.exit(2);
  }
  const expect = expectPath ? JSON.parse(readFileSync(expectPath, 'utf8')) : undefined;
  const { errors, warnings, stats } = await checkGlbFile(file, { stage, expect });
  console.log(`[check] ${file} (${stage}): tris per LOD ${stats.tris.join(' / ')}, draws per LOD ${stats.drawsPerLod.join(' / ')}, materials ${stats.materials}, textures ${stats.textures}`);
  for (const w of warnings) console.warn(`[check] warn: ${w}`);
  for (const e of errors) console.error(`[check] FAIL: ${e}`);
  if (errors.length > 0) {
    console.error(`[check] ${errors.length} convention violation(s) — build failed`);
    process.exit(1);
  }
  console.log('[check] conventions OK');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
