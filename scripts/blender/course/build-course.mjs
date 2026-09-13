#!/usr/bin/env node
/**
 * Course furniture build (§T.187): headless Blender → course checker → normalise/dedup/prune →
 * KTX2 (UASTC data maps, ETC1S colour) → meshopt → course checker (final) → assets/models/<asset>.glb.
 * Same packaging steps as scripts/asset-build.mjs (the boat build); the course has its own contract
 * (src/circuit/assets/courseAssetContract.json) and checker (checkCourseGlb.mjs).
 *
 *   node scripts/blender/course/build-course.mjs [--asset <name>|all] [--bake-size 1024] [--ao-samples 16]
 *        [--threads 4] [--work <dir>] [--keep] [--render <dir>] [--blender <path>] [--ktx-bin <dir>]
 *
 * --render <dir>: CPU Cycles hero/detail renders of the raw GLB (render_course.py) into <dir>.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PropertyType } from '@gltf-transform/core';
import { EXTMeshoptCompression } from '@gltf-transform/extensions';
import { dedup, prune, quantize, reorder } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import { createIO } from '../checkGlb.mjs';
import { checkCourseDocument, loadCourseContract } from './checkCourseGlb.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {
    asset: 'all',
    bakeSize: 1024,
    aoSamples: 16,
    threads: 4,
    work: null,
    keep: false,
    render: null,
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
    if (a === '--asset') out.asset = next();
    else if (a === '--bake-size') out.bakeSize = Number(next());
    else if (a === '--ao-samples') out.aoSamples = Number(next());
    else if (a === '--threads') out.threads = Number(next());
    else if (a === '--work') out.work = resolve(next());
    else if (a === '--keep') out.keep = true;
    else if (a === '--render') out.render = resolve(next());
    else if (a === '--blender') out.blender = next();
    else if (a === '--ktx-bin') out.ktxBin = next();
    else throw new Error(`unknown flag ${a}`);
  }
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
  console.log(`\n[course-build] ${label}\n  $ ${[cmd, ...args].join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${label} failed (exit ${r.status})`);
}

const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);

async function check(io, contract, path, stage, asset) {
  const doc = await io.read(path);
  const { errors, warnings, stats } = checkCourseDocument(doc, contract, { stage, asset });
  for (const w of warnings) console.warn(`[course-check] warn: ${w}`);
  console.log(`[course-check] ${asset} ${stage}: instance tris/LOD ${stats.tris.join(' / ')}, instance draws/LOD ${stats.draws.join(' / ')}, all variants ${(stats.totalTris ?? []).join(' / ')}, materials ${stats.materials}, textures ${stats.textures}`);
  for (const e of errors) console.error(`[course-check] FAIL: ${e}`);
  if (errors.length) throw new Error(`${path}: ${errors.length} course convention violation(s) at stage '${stage}'`);
  return stats;
}

async function buildOne(asset, opt, contract, env) {
  const work = opt.work ? join(opt.work, asset) : mkdtempSync(join(tmpdir(), `course-${asset}-`));
  mkdirSync(work, { recursive: true });
  const outDir = join(ROOT, 'assets/models');
  mkdirSync(outDir, { recursive: true });
  const finalPath = join(outDir, `${asset}.glb`);
  const raw = join(work, `raw-${asset}.glb`);
  const step = (n) => join(work, `step${n}.glb`);
  const cli = join(ROOT, 'node_modules/@gltf-transform/cli/bin/cli.js');
  const t0 = Date.now();

  run(`1/6 ${asset}: Blender model + bake + LODs + export`, opt.blender, [
    '-b', '--factory-startup', '--python-exit-code', '1', '-P', join(HERE, 'build_course.py'), '--',
    '--asset', asset, '--out', raw, '--work', work, '--bake-size', String(opt.bakeSize),
    '--ao-samples', String(opt.aoSamples), '--threads', String(opt.threads),
  ]);
  if (!existsSync(raw)) throw new Error(`Blender exited 0 but wrote no ${raw}`);
  const io = await createIO();
  console.log(`\n[course-build] 2/6 ${asset}: checker (raw)`);
  await check(io, contract, raw, 'raw', asset);

  if (opt.render) {
    mkdirSync(opt.render, { recursive: true });
    run(`   ${asset}: CPU renders`, opt.blender, [
      '-b', '--factory-startup', '--python-exit-code', '1', '-P', join(HERE, 'render_course.py'), '--',
      '--glb', raw, '--asset', asset, '--out-dir', opt.render, '--threads', String(opt.threads),
    ]);
  }

  console.log(`\n[course-build] 3/6 ${asset}: normalise + dedup + prune`);
  const doc = await io.read(raw);
  for (const mat of doc.getRoot().listMaterials()) {
    const slot = contract.slots[mat.getName()];
    if (slot) mat.setAlphaMode(slot.alphaMode);
    const coat = mat.getExtension('KHR_materials_clearcoat');
    if (coat && coat.getClearcoatFactor() === 0 && !coat.getClearcoatTexture()) mat.setExtension('KHR_materials_clearcoat', null);
  }
  const slotsBefore = doc.getRoot().listMaterials().map((m) => m.getName()).sort().join(',');
  await doc.transform(
    dedup({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.TEXTURE] }),
    prune({ keepExtras: true, keepLeaves: false }),
  );
  await io.write(step(1), doc);

  const size = String(contract.assets[asset].textureSize);
  run(`4/6 ${asset}: resize`, process.execPath, [cli, 'resize', step(1), step(2), '--width', size, '--height', size], env);
  run(`4/6 ${asset}: UASTC (normal, ORM)`, process.execPath, [
    cli, 'uastc', step(2), step(3), '--slots', '{normalTexture,occlusionTexture,metallicRoughnessTexture}', '--level', '2', '--zstd', '18', '--jobs', '2',
  ], env);
  run(`4/6 ${asset}: ETC1S (baseColor, emissive)`, process.execPath, [
    cli, 'etc1s', step(3), step(4), '--slots', '{baseColorTexture,emissiveTexture}', '--quality', '160', '--jobs', '2',
  ], env);

  console.log(`\n[course-build] 5/6 ${asset}: meshopt (positions stay float: instances carry the transform)`);
  const packed = await io.read(step(4));
  await MeshoptEncoder.ready;
  await packed.transform(
    reorder({ encoder: MeshoptEncoder, target: 'size' }),
    quantize({ pattern: /^(NORMAL|TANGENT)$/, quantizeNormal: 10 }),
  );
  packed.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  await io.write(finalPath, packed);
  console.log(`\n[course-build] 6/6 ${asset}: checker (final)`);
  const stats = await check(io, contract, finalPath, 'final', asset);
  const slotsAfter = (await io.read(finalPath)).getRoot().listMaterials().map((m) => m.getName()).sort().join(',');
  if (slotsAfter !== slotsBefore) throw new Error(`material slots changed in packaging: [${slotsBefore}] → [${slotsAfter}]`);
  const mb = statSync(finalPath).size / 1e6;
  console.log(`[course-build] OK ${finalPath} ${mb.toFixed(2)} MB sha256:${sha(finalPath)} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if (!opt.keep && !opt.work) rmSync(work, { recursive: true, force: true });
  return { asset, mb, tris: stats.tris, draws: stats.draws, materials: stats.materials, textures: stats.textures };
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const contract = loadCourseContract();
  const ktxBin = findKtxBin(opt.ktxBin);
  const env = { PATH: `${ktxBin}:${process.env.PATH}` };
  if (!existsSync(opt.blender)) throw new Error(`Blender not found at ${opt.blender}`);
  const assets = opt.asset === 'all' ? Object.keys(contract.assets) : opt.asset.split(',');
  for (const a of assets) if (!contract.assets[a]) throw new Error(`no course asset '${a}' (have ${Object.keys(contract.assets).join(', ')})`);
  const results = [];
  for (const a of assets) results.push(await buildOne(a, opt, contract, env));
  console.log('\n[course-build] summary');
  for (const r of results) console.log(`  ${r.asset.padEnd(20)} ${r.mb.toFixed(2)} MB  tris ${r.tris.join('/')}  draws ${r.draws.join('/')}  mats ${r.materials}  tex ${r.textures}`);
}

main().catch((err) => {
  console.error(`\n[course-build] FAILED: ${err.message}`);
  process.exit(1);
});
