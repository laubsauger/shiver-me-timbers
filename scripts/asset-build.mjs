#!/usr/bin/env node
/**
 * Speedboat asset build: physics offsets → headless Blender → checker → gltf-transform → checker
 * → assets/models/<name>.glb. Deterministic and re-runnable; every step fails loud.
 * docs/speedboat/asset-pipeline.md has the full command reference.
 *
 *   node scripts/asset-build.mjs [--pipeline-test] [--kind player|npc]
 *        [--bake-size 1024] [--ao-samples 16] [--threads 4] [--max-texture 1024]
 *        [--work <dir>] [--keep] [--blender <path>] [--ktx-bin <dir>]
 *        [--parts <manifest.json> | --no-parts] [--blend <scene.blend>]
 *
 * --parts (default scripts/blender/parts/manifest.json) builds the hero parts onto the hull:
 * outboards, props, bracket, arch, windscreen, cockpit, deck hardware, salvage dressing.
 *
 * Default: the SB-12 hero hull (scripts/blender/hull/, docs/speedboat/hull-log.md) → speedboat_hero.glb.
 * --pipeline-test builds the stand-in lofted hull instead → speedboat_pipeline_test.glb.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PropertyType, TextureInfo } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMaterialsClearcoat, KHRTextureBasisu } from '@gltf-transform/extensions';
import { dedup, prune, quantize, reorder } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import { checkDocument, createIO, loadContract } from './blender/checkGlb.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILDERS = {
  speedboat_hero: { script: 'scripts/blender/build_pipeline_test.py', hullKind: 'hero' },
  speedboat_pipeline_test: { script: 'scripts/blender/build_pipeline_test.py', hullKind: 'test' },
};

function parseArgs(argv) {
  const out = {
    name: 'speedboat_hero',
    kind: 'player',
    bakeSize: 1024,
    aoSamples: 16,
    threads: 4,
    // hero part atlases are 2048² (scripts/blender/parts/manifest.json); the hull bakes stay at --bake-size
    maxTexture: 2048,
    parts: 'scripts/blender/parts/manifest.json',
    blend: null,
    hullStations: 240,
    work: null,
    keep: false,
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
    if (a === '--name') out.name = next();
    else if (a === '--pipeline-test') out.name = 'speedboat_pipeline_test';
    else if (a === '--kind') out.kind = next();
    else if (a === '--bake-size') out.bakeSize = Number(next());
    else if (a === '--ao-samples') out.aoSamples = Number(next());
    else if (a === '--threads') out.threads = Number(next());
    else if (a === '--max-texture') out.maxTexture = Number(next());
    else if (a === '--hull-stations') out.hullStations = Number(next());
    else if (a === '--work') out.work = resolve(next());
    else if (a === '--keep') out.keep = true;
    else if (a === '--blender') out.blender = next();
    else if (a === '--ktx-bin') out.ktxBin = next();
    else if (a === '--parts') out.parts = next();
    else if (a === '--no-parts') out.parts = null;
    else if (a === '--blend') out.blend = resolve(next());
    else throw new Error(`unknown flag ${a}`);
  }
  if (!BUILDERS[out.name]) throw new Error(`no Blender builder for '${out.name}' (have: ${Object.keys(BUILDERS).join(', ')})`);
  return out;
}

function findKtxBin(explicit) {
  const candidates = [explicit, join(homedir(), '.local/opt/ktx-software-4.4.2/bin'), '/usr/local/bin', '/opt/homebrew/bin'];
  for (const dir of candidates) if (dir && existsSync(join(dir, 'ktx'))) return dir;
  const which = spawnSync('which', ['ktx'], { encoding: 'utf8' });
  if (which.status === 0) return dirname(which.stdout.trim());
  throw new Error('KTX-Software `ktx` CLI not found (docs/speedboat/asset-pipeline.md §Installs); pass --ktx-bin <dir>');
}

function run(label, cmd, args, env) {
  console.log(`\n[asset-build] ${label}\n  $ ${[cmd, ...args].join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${label} failed (exit ${r.status})`);
}

const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);

async function check(io, contract, path, stage, expect) {
  const doc = await io.read(path);
  const { errors, warnings, stats } = checkDocument(doc, contract, { stage, expect });
  for (const w of warnings) console.warn(`[check] warn: ${w}`);
  console.log(`[check] ${stage}: tris/LOD ${stats.tris.join(' / ')}, draws/LOD ${stats.drawsPerLod.join(' / ')}, materials ${stats.materials}, textures ${stats.textures}`);
  for (const e of errors) console.error(`[check] FAIL: ${e}`);
  if (errors.length > 0) throw new Error(`${path}: ${errors.length} convention violation(s) at stage '${stage}'`);
}

/**
 * Contract normalisation the Blender exporter cannot express: alphaMode is data-driven (the
 * gelcoat's baseColor alpha is a livery MASK, linked in Blender only so the channel survives
 * export), and a clearcoat extension with factor 0 is noise the runtime would have to ignore.
 */
function normalise(document, contract, work, hullKind) {
  for (const mat of document.getRoot().listMaterials()) {
    const slot = contract.slots[mat.getName()];
    if (slot) mat.setAlphaMode(slot.alphaMode);
    const coat = mat.getExtension('KHR_materials_clearcoat');
    if (coat && coat.getClearcoatFactor() === 0 && !coat.getClearcoatTexture()) mat.setExtension('KHR_materials_clearcoat', null);
  }
  if (hullKind === 'hero') attachHullTextures(document, work);
}

/**
 * Hero hull: the 4th texture per hull slot, which glTF has no generic slot for (pilot-build.mjs precedent):
 * M_Gelcoat's livery/wear mask as KHR_materials_clearcoat.clearcoatTexture, M_NonSlip's tiling non-skid
 * normal as clearcoatNormalTexture (factor 0). Channel semantics ride in material extras
 * (scripts/blender/hull/hull_textures.py writes hull_textures.json; slotMaterials.ts reads them).
 */
function attachHullTextures(document, work) {
  const sidecar = join(work, 'hull_textures.json');
  if (!existsSync(sidecar)) return;
  const spec = JSON.parse(readFileSync(sidecar, 'utf8'));
  const clearcoat = document.createExtension(KHRMaterialsClearcoat);
  const png = (file) => {
    const path = join(work, file);
    if (!existsSync(path)) throw new Error(`hull texture ${path} missing (hull_textures.json names it)`);
    return document.createTexture(file.replace(/\.png$/, '')).setImage(new Uint8Array(readFileSync(path))).setMimeType('image/png');
  };
  for (const mat of document.getRoot().listMaterials()) {
    const s = spec[mat.getName()];
    if (!s) continue;
    const cc = clearcoat.createClearcoat().setClearcoatFactor(s.clearcoatFactor ?? 0).setClearcoatRoughnessFactor(s.clearcoatRoughness ?? 0);
    if (s.clearcoatTexture) cc.setClearcoatTexture(png(s.clearcoatTexture));
    if (s.clearcoatNormalTexture) {
      cc.setClearcoatNormalTexture(png(s.clearcoatNormalTexture));
      cc.getClearcoatNormalTextureInfo().setWrapS(TextureInfo.WrapMode.REPEAT).setWrapT(TextureInfo.WrapMode.REPEAT);
    }
    mat.setExtension('KHR_materials_clearcoat', cc);
    mat.setExtras({ ...(mat.getExtras() ?? {}), ...(s.extras ?? {}) });
  }
}

/**
 * §T.200 DATA CHANNELS SURVIVE PACKAGING. gltf-transform's KTX commands choose the encoded channels from each slot's
 * glTF meaning (functions getTextureChannelMask): an OPAQUE material's baseColor is written RGB only, and a
 * clearcoatTexture R only. Our masks ride exactly there — M_Gelcoat/M_NonSlip baseColor A (overlay / non-skid
 * coverage), M_Carbon baseColor A (cowl livery), the hull mask's G pinstripe, B antifoul and A wear — so until T200
 * the shipped GLB had none of them: the runtime sampled A = 1 and G = B = R, the hull drew its overlay colour with no
 * livery and M_Carbon took the livery hue everywhere (USER: "cowls solid in player colour", "no stripe on the side").
 * Those textures are encoded here with every channel, at the CLI steps' own settings (ETC1S q160 sRGB, UASTC level 2
 * + zstd 18 linear, full mip chains, 2 threads); the CLI steps then skip them as already KTX2.
 * checkGlb.mjs `liveryChannelErrors` fails a final GLB that loses them again.
 */
const DATA_ALPHA_BASE = new Set(['M_Gelcoat', 'M_NonSlip', 'M_Carbon']);
function encodeDataTextures(document, work, env) {
  const jobs = new Map();
  for (const mat of document.getRoot().listMaterials()) {
    const base = mat.getBaseColorTexture();
    if (base && DATA_ALPHA_BASE.has(mat.getName())) jobs.set(base, 'etc1s');
    const cc = mat.getExtension('KHR_materials_clearcoat')?.getClearcoatTexture();
    if (cc) jobs.set(cc, 'uastc');
  }
  let i = 0;
  for (const [tex, mode] of jobs) {
    if (tex.getMimeType() !== 'image/png') throw new Error(`data texture '${tex.getName()}' is ${tex.getMimeType()}, expected PNG before KTX2`);
    const src = join(work, `data_tex_${i}.png`);
    const dst = join(work, `data_tex_${i++}.ktx2`);
    writeFileSync(src, tex.getImage());
    const codec = mode === 'etc1s'
      ? ['--encode', 'basis-lz', '--qlevel', '160', '--assign-tf', 'srgb', '--assign-primaries', 'bt709', '--format', 'R8G8B8A8_SRGB']
      : ['--encode', 'uastc', '--uastc-quality', '2', '--zstd', '18', '--assign-tf', 'linear', '--assign-primaries', 'none', '--format', 'R8G8B8A8_UNORM'];
    run(`5/6 ${mode.toUpperCase()} RGBA (data channels): ${tex.getName()}`, 'ktx', ['create', '--generate-mipmap', ...codec, '--threads', '2', src, dst], env);
    tex.setImage(new Uint8Array(readFileSync(dst))).setMimeType('image/ktx2');
    if (tex.getURI()) tex.setURI(tex.getURI().replace(/\.png$/, '') + '.ktx2');
  }
  if (jobs.size > 0) document.createExtension(KHRTextureBasisu).setRequired(true);
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const contract = loadContract();
  const ktxBin = findKtxBin(opt.ktxBin);
  const env = { PATH: `${ktxBin}:${process.env.PATH}` };
  if (!existsSync(opt.blender)) throw new Error(`Blender not found at ${opt.blender} (pass --blender)`);
  const work = opt.work ?? mkdtempSync(join(tmpdir(), `asset-build-${opt.name}-`));
  mkdirSync(work, { recursive: true });
  const outDir = join(ROOT, 'assets/models');
  mkdirSync(outDir, { recursive: true });
  const finalPath = join(outDir, `${opt.name}.glb`);
  const hullJson = join(work, 'hull.json');
  const raw = join(work, 'raw.glb');
  const step = (n) => join(work, `step${n}.glb`);
  const gltfTransform = join(ROOT, 'node_modules/@gltf-transform/cli/bin/cli.js');

  run('1/6 hull offsets from src/speedboat/hullMesh.ts', join(ROOT, 'node_modules/.bin/vite-node'), [
    'scripts/blender/hullOffsets.ts', '--', hullJson, String(opt.hullStations),
  ]);
  const expect = JSON.parse(readFileSync(hullJson, 'utf8'));

  run('2/6 Blender headless build + bake + export', opt.blender, [
    '-b', '--factory-startup', '--python-exit-code', '1', '-P', BUILDERS[opt.name].script, '--',
    '--hull-kind', BUILDERS[opt.name].hullKind,
    '--hull', hullJson, '--out', raw, '--work', work, '--kind', opt.kind,
    '--bake-size', String(opt.bakeSize), '--ao-samples', String(opt.aoSamples), '--threads', String(opt.threads),
    '--name', opt.name,
    ...(opt.parts ? ['--parts', opt.parts] : []),
    ...(opt.blend ? ['--blend', opt.blend] : []),
  ]);
  if (!existsSync(raw)) throw new Error(`Blender exited 0 but wrote no ${raw}`);

  const io = await createIO();
  console.log('\n[asset-build] 3/6 conventions check (raw export)');
  await check(io, contract, raw, 'raw', expect);

  console.log('\n[asset-build] 4/6 normalise + dedup + prune');
  const doc = await io.read(raw);
  normalise(doc, contract, work, BUILDERS[opt.name].hullKind);
  // materials are NOT deduplicated: two slots with identical factors are still two slots (the
  // runtime factory maps by name), and merging them silently deletes a slot from the contract
  const slotsBefore = doc.getRoot().listMaterials().map((m) => m.getName()).sort().join(',');
  await doc.transform(
    dedup({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.MESH, PropertyType.TEXTURE] }),
    prune({ keepExtras: true, keepLeaves: false }),
  );
  await io.write(step(1), doc);

  run('5/6 textures: resize, UASTC (normal/ORM), ETC1S (baseColor)', process.execPath, [
    gltfTransform, 'resize', step(1), step(2), '--width', String(opt.maxTexture), '--height', String(opt.maxTexture),
  ], env);
  const dataDoc = await io.read(step(2));
  encodeDataTextures(dataDoc, work, env);
  await io.write(step('2b'), dataDoc);
  run('5/6 UASTC', process.execPath, [
    gltfTransform, 'uastc', step('2b'), step(3), '--slots', '{normalTexture,occlusionTexture,metallicRoughnessTexture,clearcoatTexture,clearcoatNormalTexture}',
    '--level', '2', '--zstd', '18', '--jobs', '2',
  ], env);
  run('5/6 ETC1S', process.execPath, [
    gltfTransform, 'etc1s', step(3), step(4), '--slots', 'baseColorTexture', '--quality', '160', '--jobs', '2',
  ], env);

  console.log('\n[asset-build] 6/6 meshopt (positions stay float: the body frame is the shading frame)');
  const packed = await io.read(step(4));
  await MeshoptEncoder.ready;
  await packed.transform(
    reorder({ encoder: MeshoptEncoder, target: 'size' }),
    // POSITION is deliberately NOT quantized: quantization moves the dequantisation into node
    // transforms, and the runtime's shipLocalPos/wetline span read positionLocal in metres
    quantize({ pattern: /^(NORMAL|TANGENT)$/, quantizeNormal: 10 }),
  );
  packed.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({
    method: EXTMeshoptCompression.EncoderMethod.QUANTIZE,
  });
  await io.write(finalPath, packed);
  await check(io, contract, finalPath, 'final', expect);
  const slotsAfter = (await io.read(finalPath)).getRoot().listMaterials().map((m) => m.getName()).sort().join(',');
  if (slotsAfter !== slotsBefore) throw new Error(`material slots changed in packaging: [${slotsBefore}] → [${slotsAfter}]`);

  console.log(`\n[asset-build] OK ${finalPath}`);
  console.log(`  raw   ${statSync(raw).size} B  sha256:${sha(raw)}`);
  console.log(`  final ${statSync(finalPath).size} B  sha256:${sha(finalPath)}`);
  if (!opt.keep && !opt.work) rmSync(work, { recursive: true, force: true });
  else console.log(`  intermediates kept in ${work}`);
}

main().catch((err) => {
  console.error(`\n[asset-build] FAILED: ${err.message}`);
  process.exit(1);
});
