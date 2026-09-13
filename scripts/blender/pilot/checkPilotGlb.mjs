#!/usr/bin/env node
/**
 * Speedboat pilot GLB checker (skinned asset). docs/speedboat/pilot-log.md §Checker lists the rules.
 * Reuses the shared IO + KTX2 helpers of scripts/blender/checkGlb.mjs (read-only); the rules live
 * here because the hull checker's rules (foam hull, manifold shell, body-frame identity meshes)
 * do not apply to a skinned character.
 *
 *   node scripts/blender/pilot/checkPilotGlb.mjs <file.glb> [--stage raw|final]
 *
 * Exit 1 on any violation.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createIO, ktx2LevelCount } from '../checkGlb.mjs';

export const PILOT_CONFIG_PATH = fileURLToPath(new URL('./pilot_config.json', import.meta.url));

/** MPFB game_engine skeleton: the bones the clips and IK depend on */
export const REQUIRED_BONES = [
  'Root', 'pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01', 'head',
  'clavicle_l', 'upperarm_l', 'lowerarm_l', 'hand_l', 'clavicle_r', 'upperarm_r', 'lowerarm_r', 'hand_r',
  'thigh_l', 'calf_l', 'foot_l', 'ball_l', 'thigh_r', 'calf_r', 'foot_r', 'ball_r',
  'index_01_l', 'middle_01_l', 'thumb_01_l', 'index_01_r', 'middle_01_r', 'thumb_01_r',
];
export const VARIANT_KEYS = ['variant_b', 'variant_c'];

export function loadPilotConfig(path = PILOT_CONFIG_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const EPS = 1e-6;

function isIdentity(node) {
  const t = node.getTranslation();
  const r = node.getRotation();
  const s = node.getScale();
  return (
    Math.abs(t[0]) < EPS && Math.abs(t[1]) < EPS && Math.abs(t[2]) < EPS &&
    Math.abs(r[0]) < EPS && Math.abs(r[1]) < EPS && Math.abs(r[2]) < EPS && Math.abs(r[3] - 1) < EPS &&
    Math.abs(s[0] - 1) < EPS && Math.abs(s[1] - 1) < EPS && Math.abs(s[2] - 1) < EPS
  );
}

function parseExtras(ex) {
  const out = {};
  for (const [k, v] of Object.entries(ex ?? {})) {
    if (typeof v === 'string' && (v.startsWith('{') || v.startsWith('['))) {
      try {
        out[k] = JSON.parse(v);
        continue;
      } catch {
        /* keep the string */
      }
    }
    out[k] = v;
  }
  return out;
}

function triCount(mesh) {
  let n = 0;
  for (const prim of mesh.listPrimitives()) {
    const idx = prim.getIndices();
    const pos = prim.getAttribute('POSITION');
    n += Math.floor((idx ? idx.getCount() : pos ? pos.getCount() : 0) / 3);
  }
  return n;
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

function isAncestor(a, node) {
  for (let p = node.getParentNode(); p; p = p.getParentNode()) if (p === a) return true;
  return false;
}

/** base slot name of a material: variant clones are named <slot>@<variant> */
export const slotOf = (name) => name.split('@')[0];

/**
 * @param {import('@gltf-transform/core').Document} document
 * @param {object} cfg pilot_config.json
 * @param {{stage?: 'raw'|'final'}} [opts]
 */
export function checkPilotDocument(document, cfg, opts = {}) {
  const stage = opts.stage ?? 'raw';
  const HAIR_STYLES = cfg.hair?.styles ?? [];
  const errors = [];
  const warnings = [];
  const root = document.getRoot();
  const stats = { tris: [], worstVariantTris: [], joints: 0, clips: [], materials: [], textures: root.listTextures().length, draws: [] };
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  const roots = scene ? scene.listChildren() : [];
  if (roots.length !== 1 || roots[0].getName() !== 'SB_Pilot') {
    errors.push(`hierarchy: expected exactly one root node 'SB_Pilot', found [${roots.map((n) => n.getName()).join(', ')}]`);
    return { errors, warnings, stats };
  }
  const rootNode = roots[0];
  const rx = parseExtras(rootNode.getExtras());
  if (rx.assetKind !== 'pilot') errors.push(`extras: root assetKind must be 'pilot', got ${JSON.stringify(rx.assetKind)}`);
  if (rx.contractVersion !== cfg.version) errors.push(`extras: contractVersion ${rx.contractVersion} ≠ pilot_config ${cfg.version}`);
  if (!isIdentity(rootNode)) errors.push('frame: root SB_Pilot must have an identity transform (the seat socket frame)');

  // ── seat socket ──
  const children = rootNode.listChildren();
  const socket = children.find((n) => n.getName() === rx.seatSocket);
  if (!rx.seatSocket || !socket) errors.push(`socket: root child '${rx.seatSocket}' (extras.seatSocket) is missing`);
  else if (!isIdentity(socket)) errors.push(`socket: ${socket.getName()} must sit at the origin with identity rotation (pilot frame = seat frame)`);

  // ── skin ──
  const skins = root.listSkins();
  if (skins.length !== 1) errors.push(`skin: expected exactly one skin shared by every LOD, found ${skins.length}`);
  const skin = skins[0];
  const jointNames = skin ? skin.listJoints().map((j) => j.getName()) : [];
  stats.joints = jointNames.length;
  if (jointNames.length > cfg.rig.maxBones) errors.push(`skin: ${jointNames.length} joints > rig.maxBones ${cfg.rig.maxBones}`);
  for (const b of [...REQUIRED_BONES, ...Object.keys(cfg.rig.extraBones)]) {
    if (!jointNames.includes(b)) errors.push(`skin: required bone '${b}' is not a joint`);
  }
  const rigNode = children.find((n) => n.getName() === 'PilotRig');
  if (!rigNode) errors.push("hierarchy: armature node 'PilotRig' missing under the root");
  else if (!isIdentity(rigNode)) errors.push('frame: PilotRig must have an identity transform');

  // ── cockpit camera socket + first-person head hide ──
  const sock = cfg.rig.sockets?.cam_eye;
  if (sock) {
    const parentJoint = skin?.listJoints().find((j) => j.getName() === sock.parentBone);
    const cam = parentJoint?.listChildren().find((n) => n.getName() === 'cam_eye');
    if (!cam) errors.push(`camera: node 'cam_eye' is not a child of joint '${sock.parentBone}'`);
    else {
      const eyeL = skin.listJoints().find((j) => j.getName() === 'eye_l');
      const eyeR = skin.listJoints().find((j) => j.getName() === 'eye_r');
      const head = parentJoint;
      if (eyeL && eyeR) {
        const m = cam.getWorldMatrix();
        const p = [m[12], m[13], m[14]];
        const a = eyeL.getWorldMatrix();
        const b = eyeR.getWorldMatrix();
        const mid = [(a[12] + b[12]) / 2, (a[13] + b[13]) / 2, (a[14] + b[14]) / 2];
        const view = [-m[8], -m[9], -m[10]];
        const vl = Math.hypot(...view) || 1;
        const off = [p[0] - mid[0], p[1] - mid[1], p[2] - mid[2]];
        const along = (off[0] * view[0] + off[1] * view[1] + off[2] * view[2]) / vl;
        const lateral = Math.hypot(off[0] - (along * view[0]) / vl, off[1] - (along * view[1]) / vl, off[2] - (along * view[2]) / vl);
        if (Math.abs(along - sock.forwardM) > 0.01) errors.push(`camera: cam_eye sits ${along.toFixed(3)} m ahead of the eye midpoint along its view, want ${sock.forwardM} (near plane must clear the goggles)`);
        if (lateral > 0.01) errors.push(`camera: cam_eye is ${lateral.toFixed(3)} m off the eye midpoint (not between the eyes)`);
        if (view[2] / vl < 0.5) errors.push(`camera: cam_eye looks along ${view.map((x) => (x / vl).toFixed(2)).join(',')}, not toward the bow (+Z)`);
        if (!head) errors.push('camera: no head joint');
      }
    }
    if (rx.firstPerson?.cameraNode !== 'cam_eye') errors.push("extras: firstPerson.cameraNode must be 'cam_eye'");
    const hide = rx.firstPerson?.collapseBone;
    const hideJoint = skin?.listJoints().find((j) => j.getName() === hide);
    if (!hideJoint) errors.push(`extras: firstPerson.collapseBone '${hide}' is not a joint`);
    else if (cam && isAncestor(hideJoint, cam)) errors.push(`camera: cam_eye is under the collapse bone '${hide}' (collapsing it would collapse the camera)`);
  }

  // ── LOD groups + meshes ──
  const lodGroups = children.filter((n) => /^LOD\d+$/.test(n.getName()));
  const levels = lodGroups.map((g) => Number(g.getName().slice(3))).sort((a, b) => a - b);
  if (levels.length !== cfg.lod.trisMax.length || levels.some((l, i) => l !== i)) {
    errors.push(`hierarchy: LOD groups must be LOD0..LOD${cfg.lod.trisMax.length - 1}, got [${levels.join(',')}]`);
  }
  const usedMaterials = new Set();
  let prevWorst = Infinity;
  for (const level of levels) {
    const g = lodGroups.find((n) => n.getName() === `LOD${level}`);
    if (parseExtras(g.getExtras()).lodLevel !== level) errors.push(`extras: LOD${level} lodLevel ≠ ${level}`);
    if (!isIdentity(g)) errors.push(`frame: LOD${level} must have an identity transform`);
    let common = 0;
    const hair = {};
    let draws = 0;
    for (const n of g.listChildren()) {
      const name = n.getName();
      const mesh = n.getMesh();
      if (!mesh) continue;
      if (!name.endsWith(`_LOD${level}`)) errors.push(`names: mesh node '${name}' under LOD${level} must end with '_LOD${level}'`);
      const ex = parseExtras(n.getExtras());
      if (ex.lodLevel !== level) errors.push(`extras: '${name}' lodLevel ${JSON.stringify(ex.lodLevel)} ≠ ${level}`);
      if (n.getSkin() !== skin) errors.push(`skin: mesh '${name}' is not bound to the shared skin`);
      const t = triCount(mesh);
      if (name.startsWith('Hair_')) {
        const style = name.split('_')[1];
        if (!HAIR_STYLES.includes(style)) errors.push(`names: unknown hair style node '${name}'`);
        hair[style] = t;
      } else common += t;
      const me = parseExtras(mesh.getExtras());
      const names = me.targetNames ?? [];
      for (const prim of mesh.listPrimitives()) {
        draws++;
        const mat = prim.getMaterial();
        if (!mat) {
          errors.push(`materials: primitive of '${name}' has no material`);
          continue;
        }
        usedMaterials.add(mat);
        for (const attr of ['JOINTS_0', 'WEIGHTS_0']) {
          if (!prim.getAttribute(attr)) errors.push(`skin: '${name}' has no ${attr}`);
        }
        if (prim.getAttribute('JOINTS_1') || prim.getAttribute('WEIGHTS_1')) errors.push(`skin: '${name}' has more than 4 influences per vertex (JOINTS_1/WEIGHTS_1)`);
        const w = prim.getAttribute('WEIGHTS_0');
        const j = prim.getAttribute('JOINTS_0');
        if (w && j) {
          const we = [0, 0, 0, 0];
          const je = [0, 0, 0, 0];
          let bad = 0;
          let badJ = 0;
          let onCamParent = 0;
          const camParent = jointNames.indexOf(cfg.rig.sockets?.cam_eye?.parentBone ?? '');
          for (let i = 0; i < w.getCount(); i++) {
            w.getElement(i, we);
            j.getElement(i, je);
            const s = we[0] + we[1] + we[2] + we[3];
            if (Math.abs(s - 1) > 0.02) bad++;
            if (je.some((x, k) => we[k] > 0 && x >= jointNames.length)) badJ++;
            if (camParent >= 0 && je.some((x, k) => x === camParent && we[k] > 0.25)) onCamParent++;
          }
          if (bad) errors.push(`skin: '${name}' has ${bad} vertices whose weights do not sum to 1`);
          if (badJ) errors.push(`skin: '${name}' has ${badJ} vertices referencing joints outside the skin`);
          // head geometry rides the collapse bone; weights left on the camera's parent joint would stay
          // visible inside the cockpit camera when the head is hidden
          if (onCamParent) errors.push(`firstPerson: '${name}' has ${onCamParent} vertices weighted > 25 % to '${cfg.rig.sockets.cam_eye.parentBone}' (must ride the collapse bone)`);
        }
        if (mat.getNormalTexture() && !prim.getAttribute('TANGENT')) errors.push(`tangents: '${name}' (${mat.getName()}) has a normal map but no TANGENT`);
        if (materialTextures(document, mat).size > 0 && !prim.getAttribute('TEXCOORD_0')) errors.push(`uv: '${name}' is textured but has no TEXCOORD_0`);
        if (name.startsWith('Hair_') && !prim.getAttribute('TEXCOORD_1')) errors.push(`hair: '${name}' has no TEXCOORD_1 (wind: along-card + phase)`);
        const targets = prim.listTargets();
        if (targets.length !== VARIANT_KEYS.length || VARIANT_KEYS.some((k, i) => names[i] !== k)) {
          errors.push(`variants: '${name}' morph targets [${names.join(',')}] (${targets.length}) ≠ [${VARIANT_KEYS.join(',')}]`);
        }
      }
    }
    for (const style of HAIR_STYLES) if (level < 2 && hair[style] === undefined) errors.push(`hair: LOD${level} is missing Hair_${style}_LOD${level}`);
    const worst = common + Math.max(0, ...Object.values(hair));
    stats.tris[level] = common;
    stats.worstVariantTris[level] = worst;
    stats.draws[level] = draws;
    const max = cfg.lod.trisMax[level];
    if (max !== undefined && worst > max) errors.push(`budget: LOD${level} worst variant ${worst} tris > ${max}`);
    if (worst >= prevWorst) errors.push(`budget: LOD${level} (${worst}) is not lighter than LOD${level - 1} (${prevWorst})`);
    prevWorst = worst;
  }

  // ── materials + textures ──
  stats.materials = [...usedMaterials].map((m) => m.getName());
  const variantMats = root.listMaterials();
  for (const mat of new Set([...usedMaterials, ...variantMats])) {
    const slot = cfg.materials[slotOf(mat.getName())];
    if (!slot) {
      errors.push(`materials: '${mat.getName()}' is not a pilot slot (${Object.keys(cfg.materials).join(', ')})`);
      continue;
    }
    const nTex = materialTextures(document, mat).size;
    if (nTex > 4) errors.push(`textures: ${mat.getName()} samples ${nTex} textures > 4 (§V40)`);
    if (stage === 'final') {
      if (mat.getAlphaMode() !== slot.alphaMode) errors.push(`materials: ${mat.getName()} alphaMode ${mat.getAlphaMode()} ≠ ${slot.alphaMode}`);
      if (mat.getDoubleSided() !== slot.doubleSided) errors.push(`materials: ${mat.getName()} doubleSided ${mat.getDoubleSided()} ≠ ${slot.doubleSided}`);
    }
  }
  if (stage === 'final') {
    const skinMats = variantMats.filter((m) => slotOf(m.getName()) === 'M_PilotSkin');
    if (skinMats.length !== 3) errors.push(`variants: expected 3 skin materials (hero + 2 NPC albedo variants), found ${skinMats.length}`);
    const hairMat = variantMats.find((m) => m.getName() === 'M_PilotHair');
    if (hairMat && !hairMat.getExtension('KHR_materials_anisotropy')) errors.push('hair: M_PilotHair has no KHR_materials_anisotropy flow texture');
    const used = root.listExtensionsUsed().map((e) => e.extensionName);
    if (!used.includes('KHR_materials_variants')) errors.push('variants: KHR_materials_variants is not used');
  }

  // ── animations ──
  const clips = root.listAnimations();
  stats.clips = clips.map((a) => a.getName());
  const jointSet = new Set(skin ? skin.listJoints() : []);
  for (const name of Object.keys(cfg.clips)) {
    const a = clips.find((c) => c.getName() === name);
    if (!a) {
      errors.push(`clips: '${name}' missing`);
      continue;
    }
    const ch = a.listChannels();
    if (ch.length === 0) errors.push(`clips: '${name}' has no channels`);
    for (const c of ch) {
      if (rx.clipsRotationOnly && c.getTargetPath() !== 'rotation') errors.push(`clips: '${name}' animates ${c.getTargetPath()} of ${c.getTargetNode()?.getName()} (clips are rotation-only so re-bound variants keep their joints)`);
      if (!jointSet.has(c.getTargetNode())) errors.push(`clips: '${name}' targets '${c.getTargetNode()?.getName()}', not a skin joint`);
    }
    if (cfg.clips[name].loop) {
      const input = ch[0]?.getSampler()?.getInput();
      if (input && input.getMax([0])[0] < 0.5) errors.push(`clips: looping clip '${name}' is shorter than 0.5 s`);
    }
  }

  // ── IK + variants extras ──
  for (const [chain, def] of Object.entries(rx.ik ?? {})) {
    for (const b of [def.target, def.effector, ...(def.links ?? []), ...(def.bones ?? [])].filter(Boolean)) {
      if (!jointNames.includes(b)) errors.push(`ik: chain '${chain}' references '${b}', not a joint`);
    }
  }
  if (!rx.ik) errors.push('ik: root extras carry no IK chains');
  for (const v of ['hero', 'npc_b', 'npc_c']) {
    const def = rx.variants?.[v];
    if (!def) {
      errors.push(`variants: root extras have no '${v}'`);
      continue;
    }
    const missing = jointNames.filter((j) => !def.jointHeads?.[j]);
    if (missing.length) errors.push(`variants: '${v}' jointHeads missing ${missing.length} joints (${missing.slice(0, 3).join(', ')}…)`);
    if (!HAIR_STYLES.includes(def.hairStyle)) errors.push(`variants: '${v}' hairStyle '${def.hairStyle}' has no hair node`);
  }

  // ── packaging ──
  if (stage === 'final') {
    const used = root.listExtensionsUsed().map((e) => e.extensionName);
    if (!used.includes('EXT_meshopt_compression')) errors.push('package: final GLB is not meshopt-compressed');
    for (const tex of root.listTextures()) {
      if (tex.getMimeType() !== 'image/ktx2') {
        errors.push(`package: texture '${tex.getName()}' is ${tex.getMimeType()}, not KTX2`);
        continue;
      }
      const lv = ktx2LevelCount(tex.getImage());
      const size = tex.getSize();
      const want = size ? Math.floor(Math.log2(Math.max(size[0], size[1]))) + 1 : 2;
      if (lv < want) errors.push(`package: KTX2 '${tex.getName()}' has ${lv} mip levels < full chain ${want} (§V48)`);
    }
  }
  return { errors, warnings, stats };
}

export async function checkPilotFile(path, opts = {}) {
  const io = await createIO();
  const document = await io.read(path);
  return checkPilotDocument(document, opts.config ?? loadPilotConfig(), opts);
}

async function main() {
  const args = process.argv.slice(2);
  const stage = args.includes('--stage') ? args[args.indexOf('--stage') + 1] : 'raw';
  const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--stage');
  if (!file) {
    console.error('usage: node scripts/blender/pilot/checkPilotGlb.mjs <file.glb> [--stage raw|final]');
    process.exit(2);
  }
  const { errors, warnings, stats } = await checkPilotFile(file, { stage });
  console.log(`[check-pilot] ${file} (${stage}): tris/LOD ${stats.tris.join(' / ')} (worst variant ${stats.worstVariantTris.join(' / ')}), draws ${stats.draws.join(' / ')}, joints ${stats.joints}, clips ${stats.clips.length}, materials ${stats.materials.join(',')}, textures ${stats.textures}`);
  for (const w of warnings) console.warn(`[check-pilot] warn: ${w}`);
  for (const e of errors) console.error(`[check-pilot] FAIL: ${e}`);
  if (errors.length) {
    console.error(`[check-pilot] ${errors.length} violation(s)`);
    process.exit(1);
  }
  console.log('[check-pilot] OK');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
