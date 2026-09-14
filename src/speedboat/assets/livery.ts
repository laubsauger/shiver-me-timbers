/**
 * Per-boat livery for the shared hero-hull textures (docs/speedboat/concept/STYLE-SPEC.md §4.2–§4.3, §6).
 *
 * All eight boats share ONE texture set: the hull mask carries where the band, pinstripe and antifoul
 * are, and a glyph strip carries the stencil numerals. What differs per boat is only these values, read
 * per object by the slot materials (the `sailTint` mechanism): four paint hues, the numeral colour, the
 * race number, and the dominant hue the cowl tops take (M_Carbon).
 *
 * PURE (no three.js): it runs under vitest's node environment as-is.
 */

export interface BoatLivery {
  /** hull topsides paint, 0xRRGGBB (sRGB) */
  topsides: number;
  /** the wide band under the sheer */
  band: number;
  /** the pinstripe under the band */
  stripe: number;
  /** bottom paint below the boot line */
  antifoul: number;
  /** hand-painted race number (black on light topsides, bone on dark) */
  numeral: number;
  /** HUD / plotter hue and the outboard cowl tops */
  dominant: number;
  /** race number 0–99 */
  number: number;
}

const BONE = 0xe9e5da;
const STENCIL = 0x151b1c;
const BOTTOM = 0x1e1f21;

/**
 * A community race paint (§T.200, USER: "a stripe of player color on the side of the boat … a band of white on the
 * bottom big bucket section of the engines"; §T.191 "all NPCs should use unique, well-readable and different
 * colours"). Every boat wears the hero's scheme: a neutral-ish hull base for character, ONE saturated signature hue on
 * the sheer band, the deck band and the cowl tops (`band` = `dominant`), and a pinstripe that contrasts with both. The
 * §T.197 one-colour boats (topsides = band) hid the stripe, the deck band and the cowl split. Numeral: stencil black on a
 * light base, bone on a dark one.
 */
const paint = (topsides: number, signature: number, stripe: number, number: number, dark: boolean): BoatLivery => ({
  topsides,
  band: signature,
  stripe,
  antifoul: BOTTOM,
  numeral: dark ? BONE : STENCIL,
  dominant: signature,
  number,
});

/**
 * THE EIGHT BOATS ON THE GRID: the hero's STYLE-SPEC §4.2 signal livery (bone topsides, orange band, teal pinstripe) and
 * the seven community paints of design doc §4/§8, keyed as `ui/roster.ts` COMMUNITY_PAINTS `liveryKey` names them.
 * The signatures are T197's hues, which the roster's HUD/plotter hues already match. tests/speedboatLiveries.test.ts
 * checks, in CIEDE2000:
 *  - every pair of signatures ≥ 25 apart;
 *  - no signature within 15 of the Tower Reach shallows, deep water or sky (blue and teal are deliberately absent:
 *    they vanish on this sea);
 *  - on every boat, band vs topsides ≥ 30, so the stripe always reads;
 *  - the pinstripe ≥ 25 from the topsides and ≥ 15 from the band.
 * The rows' comments read base / signature / pinstripe.
 * LIMIT, stated: the mask has ONE band; the roster's 'diagonals' and 'patchwork' patterns render as the band until the
 * hull mask grows a pattern channel.
 */
export const FLEET_LIVERIES = {
  hero: { topsides: BONE, band: 0xe4572e, stripe: 0x1f4e5f, antifoul: 0x6b2e25, numeral: STENCIL, dominant: 0xe4572e, number: 27 },
  'dome-ten': paint(0x2b2f33, 0xffd21f, 0xc8372d, 9, true), // charcoal / signal yellow / red (concept 08's yellow rival)
  'outer-bar': paint(0x5a4f42, 0x6cc24a, BONE, 44, true), // wet-sand bronze / lime / bone
  'bench-hollow': paint(0xcdbfa3, 0x7a1f2b, STENCIL, 3, false), // sand / wine / black
  'pine-cut': paint(0xf4f3ee, 0x6b6b1e, STENCIL, 56, false), // white / olive drab / black
  'levee-town': paint(0xd7dadb, 0x141414, 0xc8372d, 22, false), // concrete white / black / red
  'solar-ridge': paint(0xa89c84, 0x6a3fd0, STENCIL, 27, false), // taupe / violet / black
  'the-stills': paint(0x3a3d40, 0xf25cb0, BONE, 11, true), // graphite / hot pink / bone
} as const satisfies Record<string, BoatLivery>;

/**
 * STYLE-SPEC §4.2's rendered rival variants (concept sheet 08: yellow band on charcoal, turquoise topsides, charcoal /
 * bone). Kept for look-dev; NOT on the race grid — turquoise reads as the sea and charcoal/yellow share a hull.
 */
export const CONCEPT_LIVERIES = {
  yellow: { topsides: 0x2b2f33, band: 0xe8b420, stripe: 0xc8372d, antifoul: 0x6b2e25, numeral: 0xe9e5da, dominant: 0xe8b420, number: 8 },
  turquoise: { topsides: 0x3e8c8a, band: 0xf2e6c8, stripe: 0x2b2f33, antifoul: 0x1e1f21, numeral: 0x151b1c, dominant: 0x3e8c8a, number: 41 },
  charcoal: { topsides: 0x2b2f33, band: 0xe9e5da, stripe: 0xe4572e, antifoul: 0x1e1f21, numeral: 0xe9e5da, dominant: 0x2b2f33, number: 63 },
} as const satisfies Record<string, BoatLivery>;

export type FleetLiveryName = keyof typeof FLEET_LIVERIES;

export const HERO_LIVERY: Readonly<BoatLivery> = FLEET_LIVERIES.hero;

const isHex = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 0xffffff;

/**
 * The livery an object wears, from its `userData`:
 *  - `boatLivery` (a full or partial BoatLivery) wins, filled from the hero livery;
 *  - else `liveryTint` (one hex, the older single-hue API) recolours the band and the dominant hue;
 *  - else the hero livery. Invalid fields fall back to the hero's rather than rendering NaN colours.
 */
export function resolveLivery(userData: Record<string, unknown> | undefined): BoatLivery {
  const out: BoatLivery = { ...HERO_LIVERY };
  if (!userData) return out;
  const full = userData.boatLivery as Partial<BoatLivery> | undefined;
  if (full && typeof full === 'object') {
    for (const k of ['topsides', 'band', 'stripe', 'antifoul', 'numeral', 'dominant'] as const) {
      if (isHex(full[k])) out[k] = full[k] as number;
    }
    if (typeof full.number === 'number' && Number.isFinite(full.number)) out.number = full.number;
    return out;
  }
  if (isHex(userData.liveryTint)) {
    out.band = userData.liveryTint;
    out.dominant = userData.liveryTint;
  }
  return out;
}

/** the glyphs painted for a race number: one digit below 10, else tens and ones (the number wraps at 100) */
export function numberGlyphs(n: number): number[] {
  const v = ((Math.floor(Math.abs(n)) % 100) + 100) % 100;
  return v < 10 ? [v] : [Math.floor(v / 10), v % 10];
}
