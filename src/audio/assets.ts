/**
 * Sample manifest + lazy loader for assets/audio/sfx.
 *
 * These are multi-MB mp3s, so NOTHING here runs at import time: the loader is
 * kicked off only after the AudioContext unlocks (first user gesture), fetches
 * strictly one file at a time in priority order (so 18 MB of audio never
 * competes with texture uploads during first paint), and every failure is
 * swallowed — a missing or undecodable file leaves that slot null and the game
 * keeps rendering (audio may never break the renderer).
 *
 * URLs go through `new URL(..., import.meta.url)` with static literals so Vite
 * fingerprints and emits them in a production build too.
 */

export type SampleName =
  | 'oceanWaves'
  | 'windCockpit'
  | 'sailingBed'
  | 'wake'
  | 'hullGurgle'
  | 'shipCreak'
  | 'canvasSnapA'
  | 'canvasSnapB'
  | 'sailDeploy'
  // generated one-shots (scripts/generate-sfx.mjs, see assets/audio/CREDITS.md)
  | 'cannonFireA'
  | 'cannonFireB'
  | 'cannonFireC'
  | 'woodSplinterA'
  | 'woodSplinterB'
  | 'woodSplinterC'
  | 'mastBreakCrack'
  | 'ballSplashA'
  | 'ballSplashB'
  | 'canvasCrackA'
  | 'canvasCrackB'
  | 'ballWhooshA'
  | 'ballWhooshB'
  | 'ropeBlock';

/**
 * Load order = audibility order, and it is NOT simply "big things first".
 *
 * The bed layers you hear at the start come first, but the tiny one-shots are
 * deliberately slotted AHEAD of the two multi-MB tails (the 5.8 MB wooden-ship
 * loop and the 1.4 MB sailing bed): together they are a few hundred KB, so
 * putting them early makes combat and canvas audible roughly 7 MB sooner and
 * delays the two loops by a fraction of what they already cost. Loading is
 * still strictly one file at a time so none of this competes with texture
 * uploads at first paint.
 *
 * The byte-identical `... (1).mp3` duplicate of the gurgle is ignored.
 */
export const SAMPLE_URLS: Record<SampleName, string> = {
  oceanWaves: new URL('../../assets/audio/sfx/rmultimediaeu-ocean-waves-250310.mp3', import.meta.url)
    .href,
  windCockpit: new URL(
    '../../assets/audio/sfx/freesound_community-sailboat-cockpit-at-12kn-wind-speed-17465.mp3',
    import.meta.url,
  ).href,
  wake: new URL(
    '../../assets/audio/sfx/freesound_community-pope-sailing-wake-26126.mp3',
    import.meta.url,
  ).href,
  hullGurgle: new URL(
    '../../assets/audio/sfx/freesound_community-water-under-boat-gurgling-waves-manitoulin-05-55844.mp3',
    import.meta.url,
  ).href,
  canvasSnapA: new URL(
    '../../assets/audio/sfx/freesound_community-canvas-dropcloth-snap-1-98862.mp3',
    import.meta.url,
  ).href,
  canvasSnapB: new URL(
    '../../assets/audio/sfx/freesound_community-canvas-dropcloth-snap-2-98861.mp3',
    import.meta.url,
  ).href,
  sailDeploy: new URL(
    '../../assets/audio/sfx/freesound_community-saildeploy-99393.mp3',
    import.meta.url,
  ).href,
  shipCreak: new URL(
    '../../assets/audio/sfx/joelfazhari-wooden-ship-interior-ambience-3min-loop-361505.mp3',
    import.meta.url,
  ).href,
  sailingBed: new URL('../../assets/audio/sfx/dammafra-sailing-435998.mp3', import.meta.url).href,
  cannonFireA: new URL('../../assets/audio/sfx/elevenlabs-cannon-fire-a.mp3', import.meta.url).href,
  cannonFireB: new URL('../../assets/audio/sfx/elevenlabs-cannon-fire-b.mp3', import.meta.url).href,
  cannonFireC: new URL('../../assets/audio/sfx/elevenlabs-cannon-fire-c.mp3', import.meta.url).href,
  woodSplinterA: new URL(
    '../../assets/audio/sfx/elevenlabs-wood-splinter-a.mp3',
    import.meta.url,
  ).href,
  woodSplinterB: new URL(
    '../../assets/audio/sfx/elevenlabs-wood-splinter-b.mp3',
    import.meta.url,
  ).href,
  woodSplinterC: new URL(
    '../../assets/audio/sfx/elevenlabs-wood-splinter-c.mp3',
    import.meta.url,
  ).href,
  mastBreakCrack: new URL('../../assets/audio/sfx/elevenlabs-mast-break.mp3', import.meta.url).href,
  ballSplashA: new URL('../../assets/audio/sfx/elevenlabs-ball-splash-a.mp3', import.meta.url).href,
  ballSplashB: new URL('../../assets/audio/sfx/elevenlabs-ball-splash-b.mp3', import.meta.url).href,
  canvasCrackA: new URL(
    '../../assets/audio/sfx/elevenlabs-canvas-crack-a.mp3',
    import.meta.url,
  ).href,
  canvasCrackB: new URL(
    '../../assets/audio/sfx/elevenlabs-canvas-crack-b.mp3',
    import.meta.url,
  ).href,
  ballWhooshA: new URL('../../assets/audio/sfx/elevenlabs-ball-whoosh-a.mp3', import.meta.url).href,
  ballWhooshB: new URL('../../assets/audio/sfx/elevenlabs-ball-whoosh-b.mp3', import.meta.url).href,
  ropeBlock: new URL('../../assets/audio/sfx/elevenlabs-rope-block.mp3', import.meta.url).href,
};

/** fetch/decode order — see note above */
export const LOAD_ORDER: readonly SampleName[] = [
  'oceanWaves',
  'windCockpit',
  'wake',
  'hullGurgle',
  'canvasSnapA',
  'canvasSnapB',
  'sailDeploy',
  // the generated one-shots: ~420 KB for the lot, so they sit here rather than
  // behind the 7 MB of loops below. Cannon first — it is the one the player
  // notices missing, because a broadside that only makes the procedural
  // fallback sound is the defect this set exists to fix.
  'cannonFireA',
  'cannonFireB',
  'cannonFireC',
  // ahead of the splashes: the splinter pool is the most-fired pool in the
  // game (both `ballHit` and `splinter` draw from it), so it is the one whose
  // absence is noticed first — see the WHY VARIATIONS note in generate-sfx.mjs
  'woodSplinterA',
  'woodSplinterB',
  'woodSplinterC',
  'ballSplashA',
  'ballSplashB',
  'canvasCrackA',
  'canvasCrackB',
  'ballWhooshA',
  'ballWhooshB',
  'mastBreakCrack',
  'ropeBlock',
  'shipCreak',
  'sailingBed',
];

export interface SampleLoader {
  /** decoded buffer, or null while pending / after a failed load */
  get(name: SampleName): AudioBuffer | null;
  /** true once every entry has either decoded or failed */
  isDone(): boolean;
  /** at least one buffer decoded — the sample path is viable */
  anyLoaded(): boolean;
  /** idempotent: starts the sequential load, resolves when the queue drains */
  loadAll(): Promise<void>;
}

/** fetch + decode one file; every failure resolves to null, never throws */
export async function decodeAudio(
  ctx: BaseAudioContext,
  url: string,
): Promise<AudioBuffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await ctx.decodeAudioData(await res.arrayBuffer());
  } catch (err) {
    console.warn(`[audio] sample unavailable, degrading silently: ${url}`, err);
    return null;
  }
}

/**
 * @param onLoaded fires per successful decode so layers can fade themselves in
 *                 as their sample arrives instead of waiting for the whole set
 */
export function createSampleLoader(
  ctx: BaseAudioContext,
  onLoaded?: (name: SampleName, buffer: AudioBuffer) => void,
): SampleLoader {
  const buffers = new Map<SampleName, AudioBuffer>();
  let done = false;
  let running: Promise<void> | null = null;

  return {
    get: (name) => buffers.get(name) ?? null,
    isDone: () => done,
    anyLoaded: () => buffers.size > 0,
    loadAll() {
      if (running) return running;
      running = (async () => {
        for (const name of LOAD_ORDER) {
          const buffer = await decodeAudio(ctx, SAMPLE_URLS[name]);
          if (buffer) {
            buffers.set(name, buffer);
            onLoaded?.(name, buffer);
          }
        }
        done = true;
      })();
      return running;
    },
  };
}
