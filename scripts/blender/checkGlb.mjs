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
 * Hero parts (root extras `partsVersion`, scripts/blender/parts/manifest.json): the runtime spins props
 * and turns the wheel, dial, levers and outboards WITHOUT node transforms (identity rule), so every
 * animated node must carry its pivot + axis in the body frame, and LOD0 must have a prop per outboard
 * that names the outboard it follows.
 */
export function partsErrors(lod0) {
  const errors = [];
  if (!lod0) return errors;
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

  if (rx.partsVersion !== undefined) errors.push(...partsErrors(byLevel.get(0)));

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
