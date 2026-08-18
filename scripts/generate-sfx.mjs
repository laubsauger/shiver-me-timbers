/**
 * ElevenLabs sound-effect generator — HAND-RUN DEV TOOL, NOT RUNTIME.
 *
 *     ELEVENLABS_API_KEY=... node scripts/generate-sfx.mjs [--probe] [--only <id>] [--force]
 *
 * Nothing the game ships imports this file and nothing at runtime needs a key:
 * the generated mp3s are committed alongside the freesound recordings and are
 * loaded by src/audio/assets.ts like any other sample. If this script is never
 * run again the game is unaffected.
 *
 * The key is read from the environment and NEVER written anywhere — not into a
 * generated file's metadata, not into CREDITS.md, not into a log line. There is
 * deliberately no literal fallback: an absent key is a loud exit, not a
 * mysterious 401 thirteen times in a row.
 *
 * SKIP-IF-EXISTS IS THE POINT. This is a metered API (40 credits/second of
 * audio), so a re-run must cost nothing for assets that already landed. Pass
 * --force to deliberately re-spend on a slot you want a different take of.
 *
 * API: POST https://api.elevenlabs.io/v1/sound-generation
 *   text              the prompt
 *   duration_seconds  0.5..30 (omit = model chooses, and then you cannot
 *                     predict the cost, so we always specify)
 *   prompt_influence  0..1, default 0.3 — higher = more literal
 *   model_id          eleven_text_to_sound_v2
 * Docs: https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert
 */
import { writeFile, mkdir, access, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'assets', 'audio', 'sfx');
const ENDPOINT = 'https://api.elevenlabs.io/v1/sound-generation';
const MODEL_ID = 'eleven_text_to_sound_v2';
/** 128 kbps ≈ 16 KB/s — these are 1-3 s one-shots, so the whole set is sub-MB */
const OUTPUT_FORMAT = 'mp3_44100_128';
const CREDITS_PER_SECOND = 40;

/**
 * The set. `id` is the SampleName in src/audio/assets.ts, `file` the basename
 * under assets/audio/sfx.
 *
 * NAMING: the repo's provenance convention is filename-only and it is
 * `<source>-<slug>` (see the freesound_community-* and dammafra-* files), so
 * generated assets carry `elevenlabs-` for the same reason: you can tell where
 * a file came from without opening anything.
 *
 * WHY VARIATIONS: three cannon takes, not one. A single sample repeated is
 * instantly recognisable as a loop, and for the cannon it is worse than that —
 * see src/audio/events.ts, a broadside fires N muzzles in ONE frame, so N
 * identical waveforms sum in phase into one louder gun rather than a battery.
 * The prompts for A/B/C are deliberately different takes on the same gun (and
 * prompt_influence is varied too) so the three do not converge.
 */
const MANIFEST = [
  {
    id: 'cannonFireA',
    file: 'elevenlabs-cannon-fire-a.mp3',
    group: 'cannon',
    seconds: 3,
    influence: 0.45,
    prompt:
      'Single 18th century naval cannon firing on a wooden ship deck, close perspective: ' +
      'sharp explosive crack, deep chest-punching boom, then the report rolling away over ' +
      'open water. Dry one-shot, no music, no voices.',
  },
  {
    id: 'cannonFireB',
    file: 'elevenlabs-cannon-fire-b.mp3',
    group: 'cannon',
    seconds: 3,
    influence: 0.35,
    prompt:
      'Heavy black-powder ship cannon fires one shot: hard percussive blast with a gritty ' +
      'powder crack, low thumping body, long rolling echo decaying across the sea. ' +
      'Single one-shot, no music, no voices.',
  },
  {
    id: 'cannonFireC',
    file: 'elevenlabs-cannon-fire-c.mp3',
    group: 'cannon',
    seconds: 3,
    influence: 0.55,
    prompt:
      'One large iron cannon discharges on a galleon gun deck: violent snap of ignition, ' +
      'thunderous low boom, wooden gun carriage recoiling and rumbling on its trucks, ' +
      'distant echo tail over water. One-shot, no music, no voices.',
  },
  {
    id: 'woodSplinterA',
    file: 'elevenlabs-wood-splinter-a.mp3',
    group: 'splinter',
    seconds: 1.2,
    influence: 0.5,
    /**
     * The take came back as a small tick, ~650 ms of near-silence, and THEN
     * the actual splinter at 710 ms. A one-shot fired at the moment a ball
     * lands must have its transient at the head or it arrives as a separate,
     * unrelated event three quarters of a second late. Trimmed to the real
     * onset rather than re-rolled — the tail is good, only the lead-in is dead.
     */
    trimStart: 0.7,
    prompt:
      'Thick oak timber splintering and cracking apart: sharp splitting crack followed by ' +
      'shards of wood clattering down. Dry close one-shot, no music.',
  },
  {
    id: 'woodSplinterB',
    file: 'elevenlabs-wood-splinter-b.mp3',
    group: 'splinter',
    seconds: 1.2,
    influence: 0.4,
    prompt:
      'Heavy wooden ship hull planking bursting and splintering, dry cracking snap with ' +
      'tumbling wood debris. Close one-shot, no music.',
  },
  {
    id: 'mastBreakCrack',
    file: 'elevenlabs-mast-break.mp3',
    group: 'mast',
    seconds: 3.5,
    influence: 0.5,
    prompt:
      'A tall wooden ship mast snapping and falling: long groaning strain under load, an ' +
      'enormous rending crack of splitting timber, rigging ropes whipping and blocks ' +
      'clattering, then the spar crashing into the sea. One-shot, no music, no voices.',
  },
  {
    id: 'ballSplashA',
    file: 'elevenlabs-ball-splash-a.mp3',
    group: 'ballSplash',
    seconds: 2,
    influence: 0.45,
    prompt:
      'A heavy iron cannonball plunges into open sea: sharp deep plunge impact, water ' +
      'column collapsing back on itself, foam hissing. Close one-shot, no music.',
  },
  {
    id: 'ballSplashB',
    file: 'elevenlabs-ball-splash-b.mp3',
    group: 'ballSplash',
    seconds: 2,
    influence: 0.35,
    prompt:
      'Large solid iron shot hits the ocean surface hard: deep gulping splash, heavy water ' +
      'swallow and settling foam. Close one-shot, no music.',
  },
  {
    id: 'canvasCrackA',
    file: 'elevenlabs-canvas-crack-a.mp3',
    group: 'canvas',
    seconds: 1.5,
    influence: 0.5,
    prompt:
      'An enormous ship sail cracking violently in a gale: a single sharp thunderclap of ' +
      'heavy canvas snapping taut, rope creaking. One-shot, no music.',
  },
  {
    id: 'canvasCrackB',
    file: 'elevenlabs-canvas-crack-b.mp3',
    group: 'canvas',
    seconds: 1.5,
    influence: 0.4,
    prompt:
      'Huge heavy canvas sail luffing and snapping hard in strong wind, deep flapping ' +
      'crack of thick wet cloth. Dry one-shot, no music.',
  },
  {
    id: 'ballWhooshA',
    file: 'elevenlabs-ball-whoosh-a.mp3',
    group: 'whoosh',
    seconds: 1.2,
    influence: 0.45,
    prompt:
      'A heavy cannonball hurtling past close overhead: fast low whooshing rush with a ' +
      'whistling edge, dopplering by and away. One-shot, no music.',
  },
  {
    id: 'ballWhooshB',
    file: 'elevenlabs-ball-whoosh-b.mp3',
    group: 'whoosh',
    seconds: 1.2,
    influence: 0.35,
    prompt:
      'Solid iron round shot flies past at speed: deep air-tearing whoosh passing by and ' +
      'receding into the distance. One-shot, no music.',
  },
  {
    id: 'ropeBlock',
    file: 'elevenlabs-rope-block.mp3',
    group: 'rope',
    seconds: 1.5,
    influence: 0.5,
    prompt:
      'Thick hemp rope hauling through a wooden pulley block on a sailing ship: rough rope ' +
      'friction, creaking sheave squeal, wooden block knocking. One-shot, no music.',
  },
];

/** the throwaway used to check the key has sound_generation before the real run */
const PROBE = {
  id: 'probe',
  seconds: 0.5,
  influence: 0.3,
  prompt: 'A short dry wooden knock. One-shot.',
};

/**
 * Peak ceiling every file is scaled under. mp3 decode overshoots — several
 * takes came back measuring above 0 dBFS — and these are then multiplied by
 * gain params and summed with three other layers, so leaving headroom here is
 * cheaper than discovering it as distortion in a broadside.
 */
const PEAK_CEILING_DB = -1;

function fail(message) {
  console.error(`\n[generate-sfx] ${message}\n`);
  process.exit(1);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * One generation. Returns a Buffer, or throws with the API's own message —
 * a 401 `missing_permissions` here means the key lacks sound_generation and
 * every subsequent call would fail identically, so the caller stops.
 */
async function generate(key, { prompt, seconds, influence }) {
  const res = await fetch(`${ENDPOINT}?output_format=${OUTPUT_FORMAT}`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({
      text: prompt,
      duration_seconds: seconds,
      prompt_influence: influence,
      model_id: MODEL_ID,
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    const err = new Error(`HTTP ${res.status}: ${detail.slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Drop `seconds` off the front of a file, in place. See woodSplinterA: the
 * model happily puts the event you asked for anywhere inside the window it was
 * given, and for an impact one-shot the head is the only place it may be.
 */
async function trimHead(path, seconds) {
  const tmp = `${path}.tmp.mp3`;
  await execFile('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', path,
    '-ss', String(seconds),
    '-c:a', 'libmp3lame', '-b:a', '128k',
    tmp,
  ]);
  await rename(tmp, path);
  console.log(`trim   ${path.split('/').pop()} head -${seconds}s`);
}

/** peak and RMS in dBFS, via ffmpeg's astats (writes to stderr at info level) */
async function measure(path) {
  const { stdout, stderr } = await execFile(
    'ffmpeg',
    ['-hide_banner', '-nostats', '-i', path, '-af', 'astats=measure_perchannel=none', '-f', 'null', '-'],
    { maxBuffer: 1 << 24 },
  ).catch((e) => ({ stdout: '', stderr: String(e.stderr ?? e) }));
  const text = `${stdout}${stderr}`;
  const grab = (label) => {
    const hits = [...text.matchAll(new RegExp(`${label} dB:\\s*(-?[\\d.]+)`, 'g'))];
    return hits.length > 0 ? Number(hits[hits.length - 1][1]) : Number.NaN;
  };
  return { peak: grab('Peak level'), rms: grab('RMS level') };
}

/**
 * Level-match the round-robin groups, then cap every file's peak.
 *
 * WHY THIS EXISTS. The three cannon takes came back spread over 10 dB (RMS
 * -22.0 / -31.8 / -23.0). Round-robin between takes of different loudness does
 * not read as variation, it reads as the gun misfiring every third shot — the
 * defect the variations were generated to fix, reintroduced by the asset.
 * Level is matched WITHIN a group only: a rope block must not come out as loud
 * as a cannon, and the across-event balance is the mix's job (params/audio.ts),
 * not the asset's.
 *
 * Pure gain, no compression and no limiting. These are impacts, and the whole
 * lesson of hullHit is that the transient IS the sound — a normalizer that
 * pulls a peak down toward the body would undo exactly what makes them land.
 */
async function normalize(queue) {
  const byGroup = new Map();
  for (const entry of queue) {
    const path = join(OUT_DIR, entry.file);
    if (!(await exists(path))) continue;
    const stats = await measure(path);
    if (!Number.isFinite(stats.peak) || !Number.isFinite(stats.rms)) {
      console.error(`FAIL   ${entry.id.padEnd(16)} could not measure levels`);
      return false;
    }
    if (!byGroup.has(entry.group)) byGroup.set(entry.group, []);
    byGroup.get(entry.group).push({ entry, path, ...stats });
  }

  for (const [group, members] of byGroup) {
    // The common RMS every member can actually REACH without its peak breaking
    // the ceiling. Naively targeting the loudest member and then clamping each
    // file to the ceiling separately does NOT match them — whichever take is
    // peakiest gets clamped short and stays quiet, which is how ballSplash sat
    // 5 dB apart after the first pass. Taking the min of the achievable
    // targets means the gain below is within every member's headroom by
    // construction, so the group is genuinely matched.
    const targetRms = Math.min(...members.map((m) => m.rms + (PEAK_CEILING_DB - m.peak)));
    for (const m of members) {
      const gainDb = targetRms - m.rms;
      // Deadband wider than the measurement wobble a re-encode introduces
      // (~0.5 dB). Without it every --normalize run re-encodes every file to
      // chase a difference nobody can hear, losing a little mp3 quality each
      // pass; with it a second run is a no-op, which is what "converged" means.
      if (Math.abs(gainDb) < 0.6) {
        console.log(`level  ${m.entry.id.padEnd(16)} ${group} (already matched)`);
        continue;
      }
      const tmp = `${m.path}.tmp.mp3`;
      await execFile('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', m.path,
        '-af', `volume=${gainDb.toFixed(3)}dB`,
        '-c:a', 'libmp3lame', '-b:a', '128k',
        tmp,
      ]);
      await rename(tmp, m.path);
      const after = await measure(m.path);
      console.log(
        `level  ${m.entry.id.padEnd(16)} ${group} ${gainDb > 0 ? '+' : ''}${gainDb.toFixed(1)} dB ` +
          `→ peak ${after.peak.toFixed(1)} rms ${after.rms.toFixed(1)}`,
      );
    }
  }
  return true;
}

async function main() {
  const argv = process.argv.slice(2);
  const force = argv.includes('--force');
  const onlyIdx = argv.indexOf('--only');
  const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;
  const queue = MANIFEST.filter((e) => !only || e.id === only);
  if (queue.length === 0) fail(`--only ${only} matched nothing in the manifest`);

  // re-levelling touches no API and so needs no key — it must stay runnable
  // on a checkout of the committed assets
  if (argv.includes('--normalize')) {
    process.exit((await normalize(queue)) ? 0 : 1);
  }

  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    fail(
      'ELEVENLABS_API_KEY is not set. This script never carries a literal key.\n' +
        '  Run it as:  set -a; . ./.env.local; set +a; node scripts/generate-sfx.mjs',
    );
  }

  if (argv.includes('--probe')) {
    // cheapest possible call (0.5 s = ~20 credits) purely to prove the key
    // carries sound_generation before committing to the whole manifest
    process.stdout.write('[generate-sfx] probing key permission (0.5 s, ~20 credits)... ');
    const audio = await generate(key, PROBE);
    console.log(`ok, ${audio.length} bytes. Key can generate sound effects.`);
    return;
  }

  await mkdir(OUT_DIR, { recursive: true });
  const done = [];
  const skipped = [];
  const failed = [];
  let spentSeconds = 0;

  for (const entry of queue) {
    const path = join(OUT_DIR, entry.file);
    if (!force && (await exists(path))) {
      skipped.push(entry.id);
      console.log(`skip   ${entry.id.padEnd(16)} ${entry.file} (exists)`);
      continue;
    }
    try {
      const audio = await generate(key, entry);
      await writeFile(path, audio);
      // dead lead-in is cut HERE, not in normalize(), because a trim is not
      // idempotent — it only ever runs on a freshly generated file, which
      // skip-if-exists already makes a once-per-file event
      if (entry.trimStart) await trimHead(path, entry.trimStart);
      spentSeconds += entry.seconds;
      done.push(entry.id);
      console.log(
        `wrote  ${entry.id.padEnd(16)} ${entry.file} ` +
          `(${entry.seconds}s, ${(audio.length / 1024).toFixed(0)} KB)`,
      );
    } catch (err) {
      failed.push({ id: entry.id, message: err.message });
      console.error(`FAIL   ${entry.id.padEnd(16)} ${err.message}`);
      // a permission/auth failure repeats for every remaining entry — stop
      // rather than burn the run discovering it thirteen times
      if (err.status === 401 || err.status === 403) {
        fail('auth/permission failure — the key likely lacks `sound_generation`. Stopping.');
      }
    }
  }

  console.log(
    `\n[generate-sfx] ${done.length} written, ${skipped.length} skipped, ` +
      `${failed.length} failed. ~${spentSeconds * CREDITS_PER_SECOND} credits spent.`,
  );
  // §Rule 8: a partial run must not look like a clean one
  if (failed.length > 0) process.exit(1);

  // a fresh take is at whatever level the model produced it, so re-level the
  // groups it belongs to before anyone wires it up
  if (done.length > 0) {
    console.log('');
    if (!(await normalize(MANIFEST))) process.exit(1);
  }
}

await main();
