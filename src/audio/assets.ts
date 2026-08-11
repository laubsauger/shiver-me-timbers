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
  | 'sailDeploy';

/**
 * Load order = audibility order. The bed layers land first (they are what you
 * hear when the game starts), the tiny one-shots ride along at the end.
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

async function decode(ctx: BaseAudioContext, url: string): Promise<AudioBuffer | null> {
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
          const buffer = await decode(ctx, SAMPLE_URLS[name]);
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
