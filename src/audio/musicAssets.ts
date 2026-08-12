/**
 * Music track discovery. Drop files into `assets/audio/music/` and they are in
 * the game — there is no manifest to edit.
 *
 * Discovery is a build-time glob over audio extensions only (so `.gitkeep` and
 * friends are skipped), NOT a list of guessed filenames: an empty or missing
 * directory yields zero tracks, so the "no music yet" state costs nothing and
 * produces no 404s. Nothing is fetched at import time: discovery produces URLs
 * only, and a URL is handed to a streaming <audio> element at most one track
 * ahead of what is playing (see music.ts).
 *
 * NAMING CONVENTION (the user's, and it is optional):
 *
 *     <Title>_<tag>[-<tag>[-<tag>]].<ext>
 *     Knives at Dusk_smooth-vibey.mp3   → title "Knives at Dusk", tags
 *                                         ["smooth", "vibey"]
 *
 * Tags are the segment after the LAST underscore, split on dashes. Titles may
 * contain spaces and dashes; a file with no underscore at all is a perfectly
 * valid untagged track.
 *
 * Tags are kept as OPAQUE STRINGS and are never validated against an enum.
 * The vocabulary is being invented as tracks are added ("smooth", "vibey"),
 * and a hardcoded enum would silently discard tags it had never heard of —
 * exactly the silent-failure class this project keeps paying for. Unknown tags
 * simply carry no selection weight yet.
 */

/** game-side situations the selector can bias toward (see musicPlaylist) */
export type MusicState = 'calm' | 'island' | 'storm' | 'combat';
export const MUSIC_STATES: readonly MusicState[] = ['calm', 'island', 'storm', 'combat'];

/**
 * Situation → tag keywords worth a selection bonus. Data, not a validator:
 * extend it as the user's vocabulary grows; a tag missing from here costs a
 * track nothing beyond the bonus it does not get.
 */
export const SITUATION_TAGS: Record<MusicState, readonly string[]> = {
  calm: ['calm', 'smooth', 'vibey', 'ambient', 'mellow', 'sail', 'sailing'],
  island: ['island', 'land', 'happy', 'shanty', 'jolly', 'tavern', 'upbeat'],
  storm: ['storm', 'stormy', 'dark', 'heavy', 'ominous', 'tense'],
  combat: ['combat', 'battle', 'fight', 'action', 'drums', 'tense'],
};

export interface MusicTrackRef {
  /** stable id = the file's basename without extension */
  id: string;
  /** the part before the final underscore (may contain spaces and dashes) */
  title: string;
  /** lowercased opaque tags; empty for an untagged file */
  tags: readonly string[];
  url: string;
}

/**
 * Parse one path against the convention. Defensive by design: no underscore,
 * a trailing underscore, empty tag segments and unknown vocabulary are all
 * ordinary inputs, never errors.
 */
export function parseTrackName(path: string): Omit<MusicTrackRef, 'url'> {
  const file = path.split('/').pop() ?? path;
  const id = file.replace(/\.[a-z0-9]+$/i, '');
  const cut = id.lastIndexOf('_');
  if (cut < 0) return { id, title: id, tags: [] };
  const tags = id
    .slice(cut + 1)
    .split('-')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  // a trailing underscore with nothing after it is just a title quirk
  const title = cut > 0 ? id.slice(0, cut) : id;
  return { id, title, tags };
}

/** spaces in filenames are legal and common — encode them for the fetch */
function encodeUrl(url: string): string {
  return url.includes(' ') ? url.replace(/ /g, '%20') : url;
}

/**
 * Vite resolves this glob at build time; the directory may be empty or absent
 * and the result is simply `{}`. Sorted for a stable sequential order.
 */
export function discoverMusicTracks(): MusicTrackRef[] {
  let urls: Record<string, string> = {};
  try {
    urls = import.meta.glob('../../assets/audio/music/*.{mp3,ogg,m4a,wav,flac}', {
      eager: true,
      query: '?url',
      import: 'default',
    }) as Record<string, string>;
  } catch {
    return []; // no glob support (plain node) → no music, never a throw
  }
  return Object.keys(urls)
    .sort()
    .map((path) => ({ ...parseTrackName(path), url: encodeUrl(urls[path]) }));
}
