/**
 * The field as the HUD sees it: eight community paints (design doc §4 + §8 "Community paint"),
 * the seven rival couriers, and the eyewear options (STYLE-SPEC §0/§8: bare head, strap goggles).
 *
 * UI data only. `src/speedboat/assets/livery.ts` owns the hull colours; `liveryKey` is the join the page uses
 * (`page/liveries.ts`); the HUD never reads hull uniforms.
 *
 * §T.201: a paint here is a NAME, a HUD hue and that join. The hull's colours (topsides, band, pinstripe, numeral)
 * live only in livery.ts; the old SVG hull art kept its own copy of them and drifted from the boats on the water
 * (§T.200 moved every boat to a neutral hull with a signature band). Boat-select pictures are rendered from the
 * runtime GLB instead (page/boatPreview.ts).
 *
 * `hue` is the boat's dominant hue (HUD swatch, plotter dot). `ring` is a light second colour for
 * hues that vanish on the stencil-black planes (STYLE-SPEC C11: charcoal gets a light accent).
 */

export interface CommunityPaint {
  id: string;
  community: string;
  /** dominant hue: HUD + plotter (the livery's signature) */
  hue: string;
  /** light outline for dark hues on dark planes, or '' */
  ring: string;
  /** asset-side livery join: an `assets/livery.ts` FLEET_LIVERIES key (`speedboat/page/liveries.ts` COMMUNITY_LIVERIES) */
  liveryKey: string;
}

export const COMMUNITY_PAINTS: readonly CommunityPaint[] = [
  { id: 'signal', community: 'Open courier', hue: '#FF6B1F', ring: '#F2F4EF', liveryKey: 'hero' },
  { id: 'dome-ten', community: 'Dome Ten', hue: '#FFD21F', ring: '', liveryKey: 'dome-ten' },
  { id: 'outer-bar', community: 'Outer Bar', hue: '#6CC24A', ring: '', liveryKey: 'outer-bar' },
  { id: 'bench-hollow', community: 'Bench Hollow', hue: '#7A1F2B', ring: '', liveryKey: 'bench-hollow' },
  { id: 'pine-cut', community: 'Pine Cut', hue: '#6B6B1E', ring: '', liveryKey: 'pine-cut' },
  { id: 'levee-town', community: 'Levee Town', hue: '#141414', ring: '#F2F4EF', liveryKey: 'levee-town' },
  { id: 'solar-ridge', community: 'Solar Ridge', hue: '#6A3FD0', ring: '', liveryKey: 'solar-ridge' },
  { id: 'the-stills', community: 'The Stills', hue: '#F25CB0', ring: '', liveryKey: 'the-stills' },
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
