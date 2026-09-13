#!/usr/bin/env node
/**
 * Course furniture GLB checker (§T.187, docs/speedboat/circuit.md §Assets). FAILS the build on any break of
 * src/circuit/assets/courseAssetContract.json:
 *   hierarchy (one CF_<asset> root → contiguous LOD groups → <Variant>_LOD<n> meshes), root/LOD/mesh extras,
 *   identity transforms (instancing), every contract variant present at LOD0, tri + draw budgets per LOD with
 *   each LOD strictly lighter, finite geometry without degenerate triangles, material slots + count,
 *   textures per material (§V40), tangents under normal maps, UVs under textures, emissive lamp slot,
 *   per-asset geometry sanity (roof tops vs the contract table, heights above water), and at stage `final`
 *   meshopt + KTX2 with full mip chains (§V48).
 *
 *   node scripts/blender/course/checkCourseGlb.mjs <file.glb> [--stage raw|final]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename } from 'node:path';
import { createIO, ktx2LevelCount } from '../checkGlb.mjs';

export const COURSE_CONTRACT_PATH = fileURLToPath(new URL('../../../src/circuit/assets/courseAssetContract.json', import.meta.url));

export function loadCourseContract(path = COURSE_CONTRACT_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function isIdentity(node) {
  const t = node.getTranslation();
  const r = node.getRotation();
  const s = node.getScale();
  const e = 1e-6;
  return Math.abs(t[0]) < e && Math.abs(t[1]) < e && Math.abs(t[2]) < e && Math.abs(r[0]) < e && Math.abs(r[1]) < e && Math.abs(r[2]) < e &&
    Math.abs(r[3] - 1) < e && Math.abs(s[0] - 1) < e && Math.abs(s[1] - 1) < e && Math.abs(s[2] - 1) < e;
}

function meshStats(mesh) {
  let tris = 0;
  let degenerate = 0;
  let nonFinite = 0;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const el = [0, 0, 0];
  for (const prim of mesh.listPrimitives()) {
    if (prim.getMode() !== 4) continue;
    const pos = prim.getAttribute('POSITION');
    const idx = prim.getIndices();
    const n = idx ? idx.getCount() : pos.getCount();
    const P = [];
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, el);
      if (!el.every(Number.isFinite)) nonFinite++;
      P.push([el[0], el[1], el[2]]);
      for (let k = 0; k < 3; k++) {
        if (el[k] < min[k]) min[k] = el[k];
        if (el[k] > max[k]) max[k] = el[k];
      }
    }
    for (let i = 0; i + 2 < n; i += 3) {
      tris++;
      const a = P[idx ? idx.getScalar(i) : i];
      const b = P[idx ? idx.getScalar(i + 1) : i + 1];
      const c = P[idx ? idx.getScalar(i + 2) : i + 2];
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const area2 = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
      if (!(area2 > 1e-12)) degenerate++;
    }
  }
  return { tris, degenerate, nonFinite, min, max };
}

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
 * @param {import('@gltf-transform/core').Document} document
 * @param {object} contract  parsed courseAssetContract.json
 * @param {{stage?: 'raw'|'final', asset?: string}} opts  `asset` = the contract key (defaults from the root name)
 */
export function checkCourseDocument(document, contract, opts = {}) {
  const stage = opts.stage ?? 'raw';
  const errors = [];
  const warnings = [];
  const root = document.getRoot();
  const stats = { tris: [], draws: [], materials: 0, textures: root.listTextures().length, variants: {} };
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  const roots = scene ? scene.listChildren() : [];
  if (roots.length !== 1) {
    errors.push(`hierarchy: expected exactly 1 root node, found ${roots.length}`);
    return { errors, warnings, stats };
  }
  const rootNode = roots[0];
  const m = /^CF_(.+)$/.exec(rootNode.getName());
  const asset = opts.asset ?? (m ? m[1] : undefined);
  const spec = asset ? contract.assets[asset] : undefined;
  if (!m) errors.push(`names: root '${rootNode.getName()}' must be CF_<asset>`);
  if (!spec) {
    errors.push(`contract: no asset '${asset}' (have ${Object.keys(contract.assets).join(', ')})`);
    return { errors, warnings, stats };
  }
  if (m && m[1] !== asset) errors.push(`names: root '${rootNode.getName()}' is not CF_${asset}`);
  const rx = rootNode.getExtras() ?? {};
  for (const key of contract.extras.root) if (rx[key] === undefined) errors.push(`extras: root is missing '${key}'`);
  if (rx.assetKind !== undefined && rx.assetKind !== spec.kind) errors.push(`extras: assetKind '${rx.assetKind}' ≠ contract '${spec.kind}'`);
  if (rx.contractVersion !== undefined && rx.contractVersion !== contract.version) errors.push(`extras: contractVersion ${rx.contractVersion} ≠ ${contract.version}`);
  let variantsExtras = {};
  try {
    variantsExtras = typeof rx.variants === 'string' ? JSON.parse(rx.variants) : rx.variants ?? {};
  } catch {
    errors.push('extras: root variants is not JSON');
  }
  const visit = (n, out) => {
    out.push(n);
    n.listChildren().forEach((c) => visit(c, out));
    return out;
  };
  for (const n of visit(rootNode, [])) if (!isIdentity(n)) errors.push(`frame: node '${n.getName()}' has a non-identity transform (instancing needs geometry in the asset frame)`);

  const groups = new Map();
  for (const g of rootNode.listChildren()) {
    const mm = /^LOD(\d+)$/.exec(g.getName());
    if (!mm) {
      errors.push(`hierarchy: root child '${g.getName()}' is not a LOD group`);
      continue;
    }
    if (g.getExtras()?.lodLevel !== Number(mm[1])) errors.push(`extras: '${g.getName()}' lodLevel ≠ ${mm[1]}`);
    groups.set(Number(mm[1]), g);
  }
  const levels = [...groups.keys()].sort((a, b) => a - b);
  if (levels[0] !== 0) errors.push('hierarchy: LOD0 missing');
  levels.forEach((l, i) => l !== i && errors.push(`hierarchy: LOD levels not contiguous (${levels.join(',')})`));
  if (levels.length > contract.lod.levels) errors.push(`hierarchy: ${levels.length} LOD groups > ${contract.lod.levels}`);

  const usedMaterials = new Set();
  let prev = Infinity;
  const variantBounds = {};
  for (const level of levels) {
    const g = groups.get(level);
    let tris = 0;
    const perVariant = {};
    const seen = new Set();
    for (const n of visit(g, []).filter((x) => x.getMesh())) {
      const name = n.getName();
      const vm = new RegExp(`^(.+)_LOD${level}$`).exec(name);
      const ex = n.getExtras() ?? {};
      if (!vm) errors.push(`names: mesh '${name}' under LOD${level} must be <Variant>_LOD${level}`);
      const variant = vm ? vm[1] : name;
      if (!spec.variants.includes(variant)) errors.push(`names: '${name}' is not a contract variant of ${asset}`);
      if (ex.lodLevel !== level) errors.push(`extras: '${name}' lodLevel ${ex.lodLevel} ≠ ${level}`);
      if (ex.variant !== variant) errors.push(`extras: '${name}' variant '${ex.variant}' ≠ '${variant}'`);
      if (seen.has(variant)) errors.push(`names: variant ${variant} appears twice in LOD${level}`);
      seen.add(variant);
      const st = meshStats(n.getMesh());
      tris += st.tris;
      perVariant[variant] = { tris: st.tris, draws: n.getMesh().listPrimitives().length };
      if (st.nonFinite) errors.push(`geometry: '${name}' has ${st.nonFinite} non-finite positions`);
      if (st.degenerate > st.tris * 0.002 + 2) errors.push(`geometry: '${name}' has ${st.degenerate} degenerate triangles of ${st.tris}`);
      else if (st.degenerate) warnings.push(`geometry: '${name}' has ${st.degenerate} degenerate triangles`);
      if (level === 0) variantBounds[variant] = st;
      for (const prim of n.getMesh().listPrimitives()) {
        const mat = prim.getMaterial();
        if (!mat) {
          errors.push(`materials: a primitive of '${name}' has no material`);
          continue;
        }
        usedMaterials.add(mat);
        if (mat.getNormalTexture() && !prim.getAttribute('TANGENT')) errors.push(`tangents: '${name}' uses a normal map but has no TANGENT`);
        if (materialTextures(document, mat).size > 0 && !prim.getAttribute('TEXCOORD_0')) errors.push(`uv: '${name}' is textured but has no TEXCOORD_0`);
      }
    }
    if (level === 0) for (const v of spec.variants) if (!seen.has(v)) errors.push(`variants: LOD0 has no ${v}_LOD0`);
    // per PLACED INSTANCE: the heaviest composition of variant nodes one placement draws
    const heaviest = (key) => {
      let worst = 0;
      for (const inst of spec.instances) {
        let sum = 0;
        for (const entry of inst) {
          const names = entry.endsWith('*') ? Object.keys(perVariant).filter((k) => k.startsWith(entry.slice(0, -1))) : [entry];
          sum += Math.max(0, ...names.map((k) => perVariant[k]?.[key] ?? 0));
        }
        worst = Math.max(worst, sum);
      }
      return worst;
    };
    const instTris = heaviest('tris');
    const instDraws = heaviest('draws');
    stats.tris[level] = instTris;
    stats.draws[level] = instDraws;
    stats.totalTris = stats.totalTris ?? [];
    stats.totalTris[level] = tris;
    if (instTris > spec.triBudget[level]) errors.push(`budget: LOD${level} instance ${instTris} tris > ${spec.triBudget[level]}`);
    if (instDraws > spec.drawBudget[level]) errors.push(`budget: LOD${level} instance ${instDraws} draws > ${spec.drawBudget[level]}`);
    if (instTris >= prev) errors.push(`budget: LOD${level} instance (${instTris} tris) is not lighter than LOD${level - 1} (${prev})`);
    prev = instTris;
  }
  stats.variants = Object.fromEntries(Object.entries(variantBounds).map(([k, v]) => [k, { tris: v.tris, min: v.min.map((x) => +x.toFixed(3)), max: v.max.map((x) => +x.toFixed(3)) }]));

  // ── per-asset geometry sanity ─────────────────────────────────────────
  const top = (v) => variantBounds[v]?.max[1];
  if (spec.kind === 'roofs') {
    for (const v of spec.variants) {
      const want = contract.roofs[v];
      if (!want) errors.push(`contract: roofs table has no ${v}`);
      else if (isNum(top(v)) && Math.abs(top(v) - want.top) > 0.2) errors.push(`geometry: ${v} top ${top(v).toFixed(2)} ≠ contract roofs.${v}.top ${want.top} (±0.2) — placements would poke wrong`);
    }
  }
  const hAbove = isNum(rx.heightAboveWater) ? rx.heightAboveWater : undefined;
  if (spec.kind === 'gatePole' && !(top('Spar') > 5.5)) errors.push(`geometry: gate pole spar top ${top('Spar')} < 5.5 m (unreadable at 80 kn)`);
  if (spec.kind === 'tower' && !(top('Mast') > 90)) errors.push(`geometry: mast top ${top('Mast')} < 90 m`);
  if (hAbove !== undefined) {
    const allTop = Math.max(...Object.values(variantBounds).map((b) => b.max[1]));
    if (Math.abs(allTop - hAbove) > 0.35) errors.push(`extras: heightAboveWater ${hAbove} ≠ geometry top ${allTop.toFixed(2)} (±0.35)`);
  }
  for (const v of Object.keys(variantsExtras)) if (!spec.variants.includes(v)) errors.push(`extras: variants lists unknown '${v}'`);

  // ── materials ─────────────────────────────────────────────────────────
  stats.materials = usedMaterials.size;
  if (usedMaterials.size > contract.maxMaterials) errors.push(`materials: ${usedMaterials.size} > ${contract.maxMaterials}`);
  const names = new Set();
  for (const mat of usedMaterials) {
    const name = mat.getName();
    if (names.has(name)) errors.push(`materials: slot '${name}' appears twice`);
    names.add(name);
    const slot = contract.slots[name];
    if (!slot) {
      errors.push(`materials: '${name}' is not a course slot (${Object.keys(contract.slots).join(', ')})`);
      continue;
    }
    if (stage === 'final' && mat.getAlphaMode() !== slot.alphaMode) errors.push(`materials: ${name} alphaMode ${mat.getAlphaMode()} ≠ ${slot.alphaMode}`);
    if (slot.emissive) {
      const f = mat.getEmissiveFactor();
      if (!(f[0] + f[1] + f[2] > 0) || !mat.getEmissiveTexture()) errors.push(`materials: ${name} is the emissive lamp slot but has no emissive factor/texture`);
    }
    const nTex = materialTextures(document, mat).size;
    if (nTex > contract.maxTexturesPerMaterial) errors.push(`textures: ${name} samples ${nTex} > ${contract.maxTexturesPerMaterial} (§V40)`);
  }

  if (stage === 'final') {
    const used = root.listExtensionsUsed().map((e) => e.extensionName);
    if (!used.includes('EXT_meshopt_compression')) errors.push('package: not meshopt-compressed');
    for (const tex of root.listTextures()) {
      if (tex.getMimeType() !== 'image/ktx2') {
        errors.push(`package: texture '${tex.getName()}' is ${tex.getMimeType()}, not KTX2`);
        continue;
      }
      const lv = ktx2LevelCount(tex.getImage());
      const size = tex.getSize();
      const want = size ? Math.floor(Math.log2(Math.max(size[0], size[1]))) + 1 : 2;
      if (lv < want) errors.push(`package: KTX2 '${tex.getName()}' has ${lv} mip levels < ${want} (§V48)`);
    }
  }
  return { errors, warnings, stats };
}

export async function checkCourseGlbFile(path, opts = {}) {
  const io = await createIO();
  const document = await io.read(path);
  const asset = opts.asset ?? basename(path).replace(/\.glb$/, '').replace(/^raw-/, '');
  return checkCourseDocument(document, opts.contract ?? loadCourseContract(), { ...opts, asset: opts.asset ?? (loadCourseContract().assets[asset] ? asset : undefined) });
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--stage');
  const stage = args.includes('--stage') ? args[args.indexOf('--stage') + 1] : 'raw';
  if (!file) {
    console.error('usage: node scripts/blender/course/checkCourseGlb.mjs <file.glb> [--stage raw|final]');
    process.exit(2);
  }
  const { errors, warnings, stats } = await checkCourseGlbFile(file, { stage });
  console.log(`[course-check] ${file} (${stage}): instance tris/LOD ${stats.tris.join(' / ')}, instance draws/LOD ${stats.draws.join(' / ')}, all-variant tris ${(stats.totalTris ?? []).join(' / ')}, materials ${stats.materials}, textures ${stats.textures}`);
  for (const w of warnings) console.warn(`[course-check] warn: ${w}`);
  for (const e of errors) console.error(`[course-check] FAIL: ${e}`);
  if (errors.length) {
    console.error(`[course-check] ${errors.length} violation(s)`);
    process.exit(1);
  }
  console.log('[course-check] conventions OK');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
