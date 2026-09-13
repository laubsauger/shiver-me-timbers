/**
 * The field as the HUD sees it: eight community paints (design doc §4 + §8 "Community paint"),
 * the seven rival couriers, and the eyewear options (STYLE-SPEC §0/§8: bare head, strap goggles).
 *
 * UI data only. `src/speedboat/assets/livery.ts` owns the hull-texture uniforms and at the time of
 * writing carries the STYLE-SPEC §4.2 four-boat table (hero/yellow/turquoise/charcoal, numbers
 * 27/8/41/63), which does not match the design doc's eight communities. `liveryKey` is the join
 * the page uses once the asset side has the eight; the HUD never reads hull uniforms.
 *
 * `hue` is the boat's dominant hue (HUD swatch, plotter dot). `ring` is a light second colour for
 * hues that vanish on the stencil-black planes (STYLE-SPEC C11: charcoal gets a light accent).
 */

export type PaintPattern = 'band' | 'diagonals' | 'patchwork';

export interface CommunityPaint {
  id: string;
  community: string;
  /** hull topsides */
  hull: string;
  /** band / diagonals / patches */
  accent: string;
  /** second patch colour (patchwork) or sigil */
  accent2: string;
  pattern: PaintPattern;
  /** numeral colour on this hull */
  numeral: string;
  /** dominant hue: HUD + plotter */
  hue: string;
  /** light outline for dark hues on dark planes, or '' */
  ring: string;
  reflectiveTape: boolean;
  /** asset-side livery join (T181/assets); '' until it exists */
  liveryKey: string;
}

export const COMMUNITY_PAINTS: readonly CommunityPaint[] = [
  { id: 'signal', community: 'Open courier', hull: '#E9E5DA', accent: '#FF6B1F', accent2: '#151B1C', pattern: 'band', numeral: '#151B1C', hue: '#FF6B1F', ring: '#F2F4EF', reflectiveTape: true, liveryKey: 'hero' },
  { id: 'dome-ten', community: 'Dome Ten', hull: '#3A4E7A', accent: '#D9A640', accent2: '#E9E5DA', pattern: 'band', numeral: '#E9E5DA', hue: '#3A4E7A', ring: '#D9A640', reflectiveTape: false, liveryKey: '' },
  { id: 'outer-bar', community: 'Outer Bar', hull: '#6FB2B0', accent: '#F2F2EE', accent2: '#151B1C', pattern: 'diagonals', numeral: '#151B1C', hue: '#6FB2B0', ring: '', reflectiveTape: false, liveryKey: 'turquoise' },
  { id: 'bench-hollow', community: 'Bench Hollow', hull: '#E3CFA3', accent: '#B2472A', accent2: '#151B1C', pattern: 'band', numeral: '#151B1C', hue: '#E3CFA3', ring: '#B2472A', reflectiveTape: false, liveryKey: '' },
  { id: 'pine-cut', community: 'Pine Cut', hull: '#A9A39A', accent: '#4F6F4A', accent2: '#E9E5DA', pattern: 'patchwork', numeral: '#151B1C', hue: '#8C9A72', ring: '', reflectiveTape: false, liveryKey: '' },
  { id: 'levee-town', community: 'Levee Town', hull: '#E8B420', accent: '#151B1C', accent2: '#151B1C', pattern: 'diagonals', numeral: '#151B1C', hue: '#E8B420', ring: '', reflectiveTape: false, liveryKey: 'yellow' },
  { id: 'solar-ridge', community: 'Solar Ridge', hull: '#E9E5DA', accent: '#8A5CC7', accent2: '#2B4A6F', pattern: 'patchwork', numeral: '#151B1C', hue: '#8A5CC7', ring: '', reflectiveTape: true, liveryKey: '' },
  { id: 'the-stills', community: 'The Stills', hull: '#24292B', accent: '#D23C2A', accent2: '#D23C2A', pattern: 'diagonals', numeral: '#E9E5DA', hue: '#24292B', ring: '#D23C2A', reflectiveTape: false, liveryKey: 'charcoal' },
];

export interface GogglesOption {
  id: string;
  label: string;
  lens: string;
  strap: string;
}

/** STYLE-SPEC §8: strap goggles recommended, sport sunglasses on a cord as the alternative */
export const GOGGLES: readonly GogglesOption[] = [
  { id: 'strap-amber', label: 'Strap goggles, amber', lens: '#D99A3A', strap: '#5B3F2A' },
  { id: 'strap-smoke', label: 'Strap goggles, smoke', lens: '#4A5358', strap: '#2B2F33' },
  { id: 'strap-clear', label: 'Strap goggles, clear', lens: '#C9D6D8', strap: '#6B4E36' },
  { id: 'sport-cord', label: 'Sport glasses on a cord', lens: '#1F2A30', strap: '#E4572E' },
];

/** a racer as the HUD labels it */
export interface HudRacer {
  racerId: number;
  number: number;
  /** boat name, upper-cased by CSS */
  boat: string;
  pilot: string;
  community: string;
  hue: string;
  ring: string;
  isPlayer: boolean;
}

const paint = (id: string): CommunityPaint => COMMUNITY_PAINTS.find((p) => p.id === id) as CommunityPaint;

/** design doc §4 rivals, in paint order */
export const RIVALS: readonly Omit<HudRacer, 'racerId' | 'isPlayer'>[] = [
  { number: 9, boat: 'Crosswind', pilot: 'J. Reyes', community: 'Dome Ten', hue: paint('dome-ten').hue, ring: paint('dome-ten').ring },
  { number: 44, boat: 'White Horses', pilot: 'A. Lindqvist', community: 'Outer Bar', hue: paint('outer-bar').hue, ring: '' },
  { number: 3, boat: 'Longhaul', pilot: 'R. Castellane', community: 'Bench Hollow', hue: paint('bench-hollow').hue, ring: paint('bench-hollow').ring },
  { number: 56, boat: 'Flat Jack', pilot: 'S. Moreau', community: 'Pine Cut', hue: paint('pine-cut').hue, ring: '' },
  { number: 22, boat: 'Breakwater', pilot: 'M. Okafor', community: 'Levee Town', hue: paint('levee-town').hue, ring: '' },
  { number: 27, boat: 'Spark', pilot: 'T. Varga', community: 'Solar Ridge', hue: paint('solar-ridge').hue, ring: '' },
  { number: 11, boat: 'Shine', pilot: 'D. Kowalczyk', community: 'The Stills', hue: paint('the-stills').hue, ring: paint('the-stills').ring },
];

/** race numbers the rivals already carry (the player's number stepper skips them) */
export const RIVAL_NUMBERS: readonly number[] = RIVALS.map((r) => r.number);

/**
 * The default field: player = racerId 0 in the chosen paint, rivals 1..7.
 * If the player picks a rival community's paint, that rival keeps its paint and the player's
 * swatch gets the signal-orange ring so the two never read as the same boat.
 */
export function buildRoster(playerPaintId: string, playerNumber: number): HudRacer[] {
  const p = COMMUNITY_PAINTS.find((c) => c.id === playerPaintId) ?? COMMUNITY_PAINTS[0];
  const clash = RIVALS.some((r) => r.hue === p.hue);
  const player: HudRacer = {
    racerId: 0,
    number: playerNumber,
    boat: 'You',
    pilot: 'Player',
    community: p.community,
    hue: p.hue,
    ring: clash ? '#FF6B1F' : p.ring,
    isPlayer: true,
  };
  return [player, ...RIVALS.map((r, i) => ({ ...r, racerId: i + 1, isPlayer: false }))];
}
