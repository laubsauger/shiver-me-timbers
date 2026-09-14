#!/usr/bin/env node
/**
 * Stitch the per-shot clips into one film. OPTIONAL — the sink already wrote
 * every shot as its own numbered mp4 in `seg/`, in timeline order
 * (`04-D-stern-chase.mp4`), which is what you want for cutting by hand or for
 * re-rendering a single shot without touching the rest.
 *
 *   node scripts/cine-mux.mjs [--out out/cine] [--crf 12] [--audio vo.wav]
 *
 * WHY IT IS NOT ONE ffmpeg CALL. A dissolve needs both shots on screen at
 * once and the engine has one camera, so the recorder writes the outgoing
 * shot's TAIL as handle frames past its own out-point (recorder.nextShot) and
 * the mix happens here. Runs of hard cuts are concatenated without re-encoding;
 * only the dissolve joins are re-encoded, so a 240 s film costs three xfades
 * rather than twenty-three.
 *
 * Pipeline (the per-shot encode already happened in the sink):
 *   seg/<shot>.mp4      ->  runs of `cut` joins, concatenated with -c copy
 *   `dissolve` joins    ->  xfade, pairwise
 *   trailing `fade`     ->  fade to black + black tail
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};

const OUT = resolve(arg('out', 'out/cine'));
const CRF = arg('crf', '12');
const AUDIO = arg('audio', null);
const TITLE_SECONDS = 15; // shot R — see the note at the bottom

const manifestPath = join(OUT, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error(`[mux] no manifest at ${manifestPath} — run the recorder first`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const FPS = manifest.fps ?? 24;

const ff = (args) => {
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  } catch (e) {
    console.error(`[mux] ffmpeg failed: ffmpeg ${args.join(' ')}`);
    throw e;
  }
};

// NOT cleared: the sink wrote this run's per-shot clips in here
const SEG = join(OUT, 'seg');
mkdirSync(SEG, { recursive: true });

const ENC = ['-c:v', 'libx264', '-preset', 'slow', '-crf', CRF, '-pix_fmt', 'yuv420p'];

const probeDuration = (file) => {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    { encoding: 'utf8' },
  );
  return Number(out.trim());
};

/* ---------------- 1. collect the per-shot clips ------------------------- */

// The sink already encoded each shot as it arrived (scripts/cine-sink.mjs):
// frames never touch the disk as stills, so there is nothing to encode here.

const rendered = [];
const width = manifest.width ?? 1920;
const height = manifest.height ?? 1080;

for (const shot of manifest.shots) {
  const seg = join(SEG, `${shot.clip ?? shot.id}.mp4`);
  if (!existsSync(seg)) {
    console.warn(`[mux] SKIPPING ${shot.id} (${shot.slug}) — no clip on disk`);
    continue;
  }
  const dur = probeDuration(seg);
  const frames = Math.round(dur * FPS);
  if (frames < shot.frames - 1) {
    // loud, not silent: a short shot is a render that died, and concatenating
    // it anyway would produce a film that looks finished and is not
    console.warn(
      `[mux] ${shot.id} is SHORT: ${frames}/${shot.frames} frames ` +
        `(${dur.toFixed(1)}s of ${(shot.frames / FPS).toFixed(1)}s)`,
    );
  }
  // the audio pass drops a sibling next to the clip (src/cine/audio.ts)
  const sound = ['wav', 'webm', 'ogg', 'm4a']
    .map((e) => join(SEG, `${shot.clip ?? shot.id}.${e}`))
    .find((f) => existsSync(f));
  rendered.push({ ...shot, file: seg, sound, actualFrames: frames });
  console.log(
    `[mux] ${shot.id.padEnd(3)} ${String(frames).padStart(4)}f  ` +
      `${sound === undefined ? '     ' : ' +snd'}  ${shot.slug}`,
  );
}

if (rendered.length === 0) {
  console.error('[mux] nothing to assemble');
  process.exit(1);
}

/* ---------------- 2. group into runs of hard cuts ----------------------- */

/** a run ends at a shot whose transition needs a re-encode to build */
const runs = [];
let run = [];
for (const shot of rendered) {
  run.push(shot);
  if (shot.transition === 'dissolve') {
    runs.push(run);
    run = [];
  }
}
if (run.length > 0) runs.push(run);

const runFiles = runs.map((group, i) => {
  if (group.length === 1) return group[0].file;
  const list = join(SEG, `run${i}.txt`);
  writeFileSync(list, group.map((s) => `file '${s.file}'`).join('\n'));
  const outFile = join(SEG, `run${i}.mp4`);
  ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', outFile]);
  return outFile;
});

/* ---------------- 3. xfade the runs together ---------------------------- */

let current = runFiles[0];
for (let i = 1; i < runFiles.length; i++) {
  // the run that ENDS at a dissolve owns the transition length
  const prevGroup = runs[i - 1];
  const d = prevGroup[prevGroup.length - 1].transitionSeconds || 1;
  const dur = probeDuration(current);
  const offset = Math.max(dur - d, 0);
  const next = join(SEG, `mix${i}.mp4`);
  ff([
    '-i', current,
    '-i', runFiles[i],
    '-filter_complex',
    `[0:v][1:v]xfade=transition=fade:duration=${d}:offset=${offset.toFixed(3)},format=yuv420p[v]`,
    '-map', '[v]',
    ...ENC,
    '-r', String(FPS),
    next,
  ]);
  console.log(`[mux] dissolve ${d}s at ${offset.toFixed(2)}s`);
  current = next;
}

/* ---------------- 4. tail: fade out, black, optional audio -------------- */

const bodyDur = probeDuration(current);
const lastShot = rendered[rendered.length - 1];
// clamped to what is actually there: rendering a subset (--only H1,D) leaves a
// body shorter than the fade, and a negative start time is an ffmpeg hard error
const fadeLen = Math.min(
  lastShot.transition === 'fade' ? (lastShot.transitionSeconds || 3) : 1,
  bodyDur,
);
const faded = join(SEG, 'faded.mp4');
ff([
  '-i', current,
  '-vf', `fade=t=out:st=${Math.max(bodyDur - fadeLen, 0).toFixed(3)}:d=${fadeLen.toFixed(3)},format=yuv420p`,
  ...ENC,
  '-r', String(FPS),
  faded,
]);

const black = join(SEG, 'black.mp4');
ff([
  '-f', 'lavfi',
  '-i', `color=c=black:s=${width}x${height}:r=${FPS}:d=${TITLE_SECONDS}`,
  ...ENC,
  black,
]);

const list = join(SEG, 'final.txt');
writeFileSync(list, [faded, black].map((f) => `file '${f}'`).join('\n'));
let silent = join(SEG, 'silent.mp4');
ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', silent]);

// Per-shot sound, laid back onto the finished timeline at each shot's own IN
// point. The clips were recorded per shot in a separate real-time pass, so the
// only thing that knows where they belong is the shot list's own timing.
const perShotSound = rendered.filter((s) => s.sound !== undefined);
if (AUDIO === null && perShotSound.length > 0) {
  const inputs = perShotSound.flatMap((s) => ['-i', s.sound]);
  const delays = perShotSound
    .map((s, i) => `[${i + 1}:a]adelay=${Math.round(s.in * 1000)}:all=1[a${i}]`)
    .join(';');
  const mixIn = perShotSound.map((_, i) => `[a${i}]`).join('');
  const withSound = join(SEG, 'withsound.mp4');
  ff([
    '-i', silent,
    ...inputs,
    '-filter_complex',
    `${delays};${mixIn}amix=inputs=${perShotSound.length}:normalize=0[a]`,
    '-map', '0:v', '-map', '[a]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k',
    withSound,
  ]);
  console.log(`[mux] laid ${perShotSound.length} per-shot sound take(s) onto the timeline`);
  silent = withSound;
}

const final = join(OUT, 'warfish.mp4');
if (AUDIO !== null) {
  ff(['-i', silent, '-i', resolve(AUDIO), '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-shortest', final]);
} else {
  ff(['-i', silent, '-c', 'copy', final]);
}

console.log(`\n[mux] ${final}  (${(probeDuration(final)).toFixed(1)}s @ ${FPS}fps)`);
console.log(
  `[mux] TITLES ARE NOT BURNED IN — the last ${TITLE_SECONDS}s is black.\n` +
    `      This ffmpeg has no drawtext (built without libfreetype). Either add\n` +
    `      the cards in an editor, or on a freetype build append:\n` +
    `        -vf "drawtext=fontfile=<serif>:text='ALAN WATTS':fontsize=42:` +
    `fontcolor=white@0.55:x=(w-tw)/2:y=(h-th)/2:enable='between(t,231,235)'"`,
);
