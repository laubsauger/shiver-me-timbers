#!/usr/bin/env node
/**
 * Speedboat pilot build: MPFB2 human → headless Blender stages → checker → glTF normalisation →
 * KTX2 + meshopt → checker → assets/models/speedboat_pilot.glb. Deterministic, fails loud.
 * docs/speedboat/pilot-log.md has the full description, the decisions and the self-critique.
 *
 *   node scripts/pilot-build.mjs [--bake-size 2048] [--samples 16] [--threads 4] [--max-texture 2048]
 *        [--work <dir>] [--keep] [--stages body,fit,...] [--blender <path>] [--ktx-bin <dir>]
 *
 * --stages re-runs only some Blender stages against the checkpoints in --work (dev loop); a
 * normal build runs every stage from the MPFB human up.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextureInfo } from '@gltf-transform/core';
import {
  EXTMeshoptCompression,
  KHRMaterialsAnisotropy,
  KHRMaterialsClearcoat,
  KHRMaterialsVariants,
  KHRTextureTransform,
} from '@gltf-transform/extensions';
import { prune, quantize, reorder } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import { createIO } from './blender/checkGlb.mjs';
import { checkPilotDocument, loadPilotConfig, slotOf } from './blender/pilot/checkPilotGlb.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'speedboat_pilot';

function parseArgs(argv) {
  const out = {
    bakeSize: 2048,
    samples: 16,
    threads: 4,
    maxTexture: 2048,
    work: null,
    keep: false,
    stages: null,
    blender: process.env.BLENDER_BIN ?? '/Applications/Blender.app/Contents/MacOS/Blender',
    ktxBin: process.env.KTX_BIN_DIR ?? null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--bake-size') out.bakeSize = Number(next());
    else if (a === '--samples') out.samples = Number(next());
    else if (a === '--threads') out.threads = Number(next());
    else if (a === '--max-texture') out.maxTexture = Number(next());
    else if (a === '--work') out.work = resolve(next());
    else if (a === '--keep') out.keep = true;
    else if (a === '--stages') out.stages = next();
    else if (a === '--blender') out.blender = next();
    else if (a === '--ktx-bin') out.ktxBin = next();
    else throw new Error(`unknown flag ${a}`);
  }
  return out;
}

function findKtxBin(explicit) {
  const candidates = [explicit, join(homedir(), '.local/opt/ktx-software-4.4.2/bin'), '/usr/local/bin', '/opt/homebrew/bin'];
  for (const dir of candidates) if (dir && existsSync(join(dir, 'ktx'))) return dir;
  throw new Error('KTX-Software `ktx` CLI not found (docs/speedboat/asset-pipeline.md §Installs); pass --ktx-bin <dir>');
}

function run(label, cmd, args, env) {
  console.log(`\n[pilot-build] ${label}\n  $ ${[cmd, ...args].join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${label} failed (exit ${r.status})`);
}

const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);

async function check(io, cfg, path, stage) {
  const doc = await io.read(path);
  const { errors, stats } = checkPilotDocument(doc, cfg, { stage });
  console.log(`[check-pilot] ${stage}: tris/LOD ${stats.tris.join(' / ')} (worst variant ${stats.worstVariantTris.join(' / ')}), draws ${stats.draws.join(' / ')}, joints ${stats.joints}, clips ${stats.clips.length}, textures ${stats.textures}`);
  for (const e of errors) console.error(`[check-pilot] FAIL: ${e}`);
  if (errors.length) throw new Error(`${path}: ${errors.length} pilot convention violation(s) at stage '${stage}'`);
  return stats;
}

function pngTexture(doc, work, name) {
  const path = join(work, `${name}.png`);
  if (!existsSync(path)) throw new Error(`missing texture ${path}`);
  return doc.createTexture(name).setImage(new Uint8Array(readFileSync(path))).setMimeType('image/png');
}

/** what the Blender exporter cannot express (docs/speedboat/pilot-log.md §Runtime material) */
function normalise(doc, cfg, work) {
  const root = doc.getRoot();
  const mats = Object.fromEntries(root.listMaterials().map((m) => [m.getName(), m]));
  for (const slot of Object.keys(cfg.materials)) if (!mats[slot]) throw new Error(`raw GLB has no material ${slot}`);
  const clearcoat = doc.createExtension(KHRMaterialsClearcoat);
  const transform = doc.createExtension(KHRTextureTransform);
  const anisotropy = doc.createExtension(KHRMaterialsAnisotropy);
  const variants = doc.createExtension(KHRMaterialsVariants);
  for (const [name, m] of Object.entries(mats)) {
    const slot = cfg.materials[slotOf(name)];
    m.setAlphaMode(slot.alphaMode).setDoubleSided(slot.doubleSided);
    if (slot.alphaMode === 'MASK') m.setAlphaCutoff(slot.alphaCutoff);
    m.setExtension('KHR_materials_clearcoat', null);
  }
  const detail = (mat, texName, repeat) => {
    const cc = clearcoat.createClearcoat().setClearcoatFactor(0).setClearcoatNormalTexture(pngTexture(doc, work, texName)).setClearcoatNormalScale(1);
    const info = cc.getClearcoatNormalTextureInfo();
    info.setWrapS(TextureInfo.WrapMode.REPEAT).setWrapT(TextureInfo.WrapMode.REPEAT);
    info.setExtension('KHR_texture_transform', transform.createTransform().setScale([repeat, repeat]));
    mat.setExtension('KHR_materials_clearcoat', cc);
  };
  const pilot = mats.M_Pilot;
  detail(pilot, 'T_Pilot_detail', 24);
  pilot.setExtras({
    baseColorAlpha: 'accent mask: mix(albedo, boatAccentHue * luminance, mask) — foam vest, vest collar, glove cuff band',
    detailNormal: { carrier: 'KHR_materials_clearcoat.clearcoatNormalTexture with clearcoatFactor 0', repeat: 24 },
    orm: 'R occlusion, G roughness, B metal',
  });
  const skin = mats.M_PilotSkin;
  detail(skin, 'T_PilotSkin_detail', 18);
  skin.setExtras({
    baseColorAlpha: 'subsurface thickness (ears/lips/nose high, scalp low, eyes 0)',
    detailNormal: { carrier: 'KHR_materials_clearcoat.clearcoatNormalTexture with clearcoatFactor 0', repeat: 18, fadeDistanceM: 3 },
    sss: { model: 'wrap diffuse + back-scatter lobe', wrap: 0.35, scatterColor: [0.85, 0.32, 0.22], strength: 0.6 },
    orm: 'R occlusion, G roughness, B 0',
  });
  const hair = mats.M_PilotHair;
  const an = anisotropy.createAnisotropy().setAnisotropyStrength(0.8).setAnisotropyRotation(0).setAnisotropyTexture(pngTexture(doc, work, 'T_PilotHair_flow'));
  hair.setExtension('KHR_materials_anisotropy', an);
  hair.setExtras({
    anisotropyTexture: 'RG strand direction (card v = root→tip), B strength, A root→tip gradient',
    alphaToCoverage: true,
    tint: 'rgb = hairColor * luminance(albedo) / luminance(heroHairColor)',
    wind: 'TEXCOORD_1.x along card (0 = root pinned), TEXCOORD_1.y phase',
  });
  const lens = mats.M_PilotLens;
  lens.setBaseColorFactor([0.62, 0.34, 0.08, 0.5]).setRoughnessFactor(0.1).setMetallicFactor(0);
  lens.setExtension('KHR_materials_clearcoat', clearcoat.createClearcoat().setClearcoatFactor(1).setClearcoatRoughnessFactor(0.04));
  lens.setExtras({ look: 'amber tinted clearcoat; hero may use a screen-space refraction offset, NPCs plain BLEND' });
  // skin albedo variants: same UV layout, only the base colour differs
  const vmap = {};
  const heroTex = skin.getBaseColorTexture();
  heroTex.setName('T_PilotSkin_base_hero');
  for (const v of ['hero', 'npc_b', 'npc_c']) {
    vmap[v] = variants.createVariant(v);
  }
  const skinMats = { hero: skin };
  for (const v of ['npc_b', 'npc_c']) {
    skinMats[v] = skin.clone().setName(`M_PilotSkin@${v}`).setBaseColorTexture(pngTexture(doc, work, `T_PilotSkin_base_${v}`));
  }
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMaterial() !== skin) continue;
      const list = variants.createMappingList();
      for (const v of ['hero', 'npc_b', 'npc_c']) list.addMapping(variants.createMapping().setMaterial(skinMats[v]).addVariant(vmap[v]));
      prim.setExtension('KHR_materials_variants', list);
    }
  }
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const cfg = loadPilotConfig();
  const ktxBin = findKtxBin(opt.ktxBin);
  const env = { PATH: `${ktxBin}:${process.env.PATH}` };
  if (!existsSync(opt.blender)) throw new Error(`Blender not found at ${opt.blender} (pass --blender)`);
  const work = opt.work ?? mkdtempSync(join(tmpdir(), 'pilot-build-'));
  mkdirSync(work, { recursive: true });
  const outDir = join(ROOT, 'assets/models');
  mkdirSync(outDir, { recursive: true });
  const finalPath = join(outDir, `${NAME}.glb`);
  const raw = join(work, 'raw.glb');
  const step = (n) => join(work, `step${n}.glb`);
  const cli = join(ROOT, 'node_modules/@gltf-transform/cli/bin/cli.js');

  run('1/5 Blender: MPFB human → fit → rig → hair → texture → anim → lod → export', opt.blender, [
    '-b', '--factory-startup', '--python-exit-code', '1', '-P', 'scripts/blender/pilot/build_pilot.py', '--',
    '--work', work, '--out', raw, '--threads', String(opt.threads), '--bake-size', String(opt.bakeSize),
    '--samples', String(opt.samples), ...(opt.stages ? ['--stages', opt.stages] : []),
  ]);
  if (!existsSync(raw)) throw new Error(`Blender exited 0 but wrote no ${raw}`);

  const io = await createIO();
  console.log('\n[pilot-build] 2/5 pilot checker (raw export)');
  await check(io, cfg, raw, 'raw');

  console.log('\n[pilot-build] 3/5 materials, variants, flow + detail textures');
  const doc = await io.read(raw);
  normalise(doc, cfg, work);
  // keepLeaves: the seat socket is an empty leaf; keepAttributes: TEXCOORD_1 (hair wind) is read by the
  // runtime vertex shader, not by any glTF material slot
  await doc.transform(prune({ keepExtras: true, keepLeaves: true, keepAttributes: true }));
  await io.write(step(1), doc);

  const uastc = '{T_Pilot_normal,T_Pilot_orm,T_Pilot_detail,T_PilotSkin_normal,T_PilotSkin_orm,T_PilotSkin_detail,T_PilotHair_flow,T_PilotHair_base}';
  const etc1s = '{T_Pilot_base,T_PilotSkin_base_hero,T_PilotSkin_base_npc_b,T_PilotSkin_base_npc_c}';
  run('4/5 textures: resize', process.execPath, [cli, 'resize', step(1), step(2), '--width', String(opt.maxTexture), '--height', String(opt.maxTexture)], env);
  // AO / roughness / metal and the strand flow are low-frequency: half and quarter resolution
  run('4/5 textures: ORM 1024', process.execPath, [cli, 'resize', step(2), step(2), '--pattern', 'T_Pilot_orm', '--width', String(Math.min(1024, opt.maxTexture)), '--height', String(Math.min(1024, opt.maxTexture))], env);
  run('4/5 textures: hair flow 512', process.execPath, [cli, 'resize', step(2), step(2), '--pattern', 'T_PilotHair_flow', '--width', '512', '--height', '512'], env);
  // the hero face gets the 2k skin; NPC albedo variants and the skin ORM stay at 1k
  const k1 = String(Math.min(1024, opt.maxTexture));
  run('4/5 textures: NPC skin albedos + skin ORM 1024', process.execPath, [cli, 'resize', step(2), step(2), '--pattern', '{T_PilotSkin_base_npc_b,T_PilotSkin_base_npc_c,T_PilotSkin_orm}', '--width', k1, '--height', k1], env);
  run('4/5 UASTC (normals, ORM, detail, hair)', process.execPath, [cli, 'uastc', step(2), step(3), '--pattern', uastc, '--level', '2', '--zstd', '18', '--jobs', '2'], env);
  run('4/5 ETC1S (albedos)', process.execPath, [cli, 'etc1s', step(3), step(4), '--pattern', etc1s, '--quality', '200', '--jobs', '2'], env);

  console.log('\n[pilot-build] 5/5 meshopt (positions and UVs stay float)');
  const packed = await io.read(step(4));
  await MeshoptEncoder.ready;
  await packed.transform(
    reorder({ encoder: MeshoptEncoder, target: 'size', cleanup: false }),
    quantize({ pattern: /^(NORMAL|TANGENT)$/, quantizeNormal: 10, cleanup: false }),
    // the replaced accessors are orphans now; keep leaves (seat socket) and unused attributes (wind UV)
    prune({ keepExtras: true, keepLeaves: true, keepAttributes: true }),
  );
  packed.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  await io.write(finalPath, packed);
  const stats = await check(io, cfg, finalPath, 'final');

  console.log(`\n[pilot-build] OK ${finalPath}`);
  console.log(`  tris per LOD (worst variant) ${stats.worstVariantTris.join(' / ')}, joints ${stats.joints}, clips ${stats.clips.join(', ')}`);
  console.log(`  raw   ${statSync(raw).size} B  sha256:${sha(raw)}`);
  console.log(`  final ${statSync(finalPath).size} B  sha256:${sha(finalPath)}`);
  if (!opt.keep && !opt.work) rmSync(work, { recursive: true, force: true });
  else console.log(`  intermediates kept in ${work}`);
}

main().catch((err) => {
  console.error(`\n[pilot-build] FAILED: ${err.message}`);
  process.exit(1);
});
