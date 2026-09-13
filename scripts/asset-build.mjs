#!/usr/bin/env node
/**
 * Speedboat asset build: physics offsets → headless Blender → checker → gltf-transform → checker
 * → assets/models/<name>.glb. Deterministic and re-runnable; every step fails loud.
 * docs/speedboat/asset-pipeline.md has the full command reference.
 *
 *   node scripts/asset-build.mjs [--name speedboat_pipeline_test] [--kind player|npc]
 *        [--bake-size 1024] [--ao-samples 16] [--threads 4] [--max-texture 1024]
 *        [--work <dir>] [--keep] [--blender <path>] [--ktx-bin <dir>]
 *        [--parts <manifest.json> | --no-parts] [--blend <scene.blend>]
 *
 * --parts (default scripts/blender/parts/manifest.json) builds the hero parts onto the hull:
 * outboards, props, bracket, arch, windscreen, cockpit, deck hardware, salvage dressing.
 *
 * Only the pipeline-test builder exists today (scripts/blender/build_pipeline_test.py); the hero
 * builder will take the same flags and slot into BUILDERS below.
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
import { checkDocument, createIO, loadContract } from './blender/checkGlb.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILDERS = { speedboat_pipeline_test: 'scripts/blender/build_pipeline_test.py' };

function parseArgs(argv) {
  const out = {
    name: 'speedboat_pipeline_test',
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
  const { errors, stats } = checkDocument(doc, contract, { stage, expect });
  console.log(`[check] ${stage}: tris/LOD ${stats.tris.join(' / ')}, draws/LOD ${stats.drawsPerLod.join(' / ')}, materials ${stats.materials}, textures ${stats.textures}`);
  for (const e of errors) console.error(`[check] FAIL: ${e}`);
  if (errors.length > 0) throw new Error(`${path}: ${errors.length} convention violation(s) at stage '${stage}'`);
}

/**
 * Contract normalisation the Blender exporter cannot express: alphaMode is data-driven (the
 * gelcoat's baseColor alpha is a livery MASK, linked in Blender only so the channel survives
 * export), and a clearcoat extension with factor 0 is noise the runtime would have to ignore.
 */
function normalise(document, contract) {
  for (const mat of document.getRoot().listMaterials()) {
    const slot = contract.slots[mat.getName()];
    if (slot) mat.setAlphaMode(slot.alphaMode);
    const coat = mat.getExtension('KHR_materials_clearcoat');
    if (coat && coat.getClearcoatFactor() === 0 && !coat.getClearcoatTexture()) mat.setExtension('KHR_materials_clearcoat', null);
  }
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
    '-b', '--factory-startup', '--python-exit-code', '1', '-P', BUILDERS[opt.name], '--',
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
  normalise(doc, contract);
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
  run('5/6 UASTC', process.execPath, [
    gltfTransform, 'uastc', step(2), step(3), '--slots', '{normalTexture,occlusionTexture,metallicRoughnessTexture}',
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
