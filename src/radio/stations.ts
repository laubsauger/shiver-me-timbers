/**
 * §V87 — CONTENT IS A MANIFEST, ⊥ CODE.
 *
 * Swapping any clip, retuning any station or adding a fourth teaching is an
 * edit to THIS FILE and a file dropped in `assets/audio/radio/`. Nothing
 * downstream branches on a teaching id: `tuner.ts` sees `{id, freqMHz, x, z}`,
 * `radioAudio.ts` sees a list of decoded buffers, and neither knows what a
 * teaching is. The placeholder clips are synthesised warbles standing in for
 * the Watts fragments (design doc §06: "content is placeholder until the
 * Foundation's clips are chosen; the structure is built now").
 *
 * THE URLS ARE STATIC LITERALS on purpose, exactly as `audio/assets.ts` does
 * it: Vite only fingerprints and copies an asset it can see at build time, so
 * a computed path would 404 in a build and work in dev.
 *
 * WHERE A STATION IS. Each one broadcasts from the summit of one slice island
 * — "the last cairn is the station's aerial on the summit" (design doc §06) —
 * so the manifest names the island by its place in the Sierra's visiting order
 * and `bindStations` resolves that to world metres against the live
 * archipelago. §V71: the position comes from the island generator's own
 * answer, never from a constant that happened to match it.
 */
import type { RadioStation } from './tuner';

export interface AudioRef {
  src: string;
  durationSec: number;
  title: string;
  credit: string;
}

export interface RadioStationDef {
  id: string;
  title: string;
  /** MHz — must lie inside `radioParams`' band, which `tests/radio.test.ts` checks */
  freqMHz: number;
  /** index into `SierraWorld.order`: which slice island carries the aerial */
  site: number;
  /** what drifts in while you hold it */
  fragments: AudioRef[];
  /** …and what it says at night, once its island has been walked (§T.104) */
  night: AudioRef[];
}

const url = (name: string): string => new URL(`../../assets/audio/radio/${name}`, import.meta.url).href;

const PLACEHOLDER = 'placeholder — synthesised warble, swap per §V87';

export const RADIO_STATIONS: RadioStationDef[] = [
  {
    id: 'wiggle',
    title: 'The Wiggle',
    freqMHz: 6.31,
    site: 0,
    fragments: [
      { src: url('wiggle-a.mp3'), durationSec: 3.4, title: 'the pattern, twice', credit: PLACEHOLDER },
      { src: url('wiggle-b.mp3'), durationSec: 2.8, title: 'a laugh', credit: PLACEHOLDER },
    ],
    night: [{ src: url('wiggle-night.mp3'), durationSec: 4.6, title: 'callback — the wiggle', credit: PLACEHOLDER }],
  },
  {
    id: 'treetops',
    title: 'Treetops',
    freqMHz: 6.84,
    site: 1,
    fragments: [
      { src: url('treetops-a.mp3'), durationSec: 3.1, title: 'what stays', credit: PLACEHOLDER },
      { src: url('treetops-b.mp3'), durationSec: 2.5, title: 'a bell in a tree', credit: PLACEHOLDER },
    ],
    night: [{ src: url('treetops-night.mp3'), durationSec: 4.9, title: 'callback — treetops', credit: PLACEHOLDER }],
  },
  {
    id: 'lagoon',
    title: 'The Still Lagoon',
    freqMHz: 7.29,
    site: 2,
    fragments: [
      { src: url('lagoon-a.mp3'), durationSec: 3.7, title: 'the shape of what holds it', credit: PLACEHOLDER },
      { src: url('lagoon-b.mp3'), durationSec: 2.9, title: 'still water', credit: PLACEHOLDER },
    ],
    night: [{ src: url('lagoon-night.mp3'), durationSec: 5.2, title: 'callback — the lagoon', credit: PLACEHOLDER }],
  },
];

/** the soft chime a lock makes (design doc §05) */
export const LOCK_CHIME: AudioRef = {
  src: url('lock-chime.mp3'),
  durationSec: 1.1,
  title: 'lock',
  credit: PLACEHOLDER,
};

/** every clip the radio can ever play, for the loader to walk once */
export function radioClips(defs: readonly RadioStationDef[] = RADIO_STATIONS): AudioRef[] {
  const out: AudioRef[] = [LOCK_CHIME];
  for (const d of defs) out.push(...d.fragments, ...d.night);
  return out;
}

/**
 * Bind the manifest to the world: `siteAt(order index)` answers with the
 * world x/z of that island's aerial, or null if the archipelago has no such
 * island. A station with no home is DROPPED rather than parked at the origin —
 * an unplaceable voice broadcasting from (0, 0) is a bug that sounds like a
 * feature (§V62's shape: it would drive something, just not the right thing).
 */
export function bindStations(
  siteAt: (orderIndex: number) => { x: number; z: number } | null,
  defs: readonly RadioStationDef[] = RADIO_STATIONS,
): RadioStation[] {
  const out: RadioStation[] = [];
  for (const d of defs) {
    const at = siteAt(d.site);
    if (at === null || !Number.isFinite(at.x) || !Number.isFinite(at.z)) continue;
    out.push({ id: d.id, freqMHz: d.freqMHz, x: at.x, z: at.z });
  }
  return out;
}
