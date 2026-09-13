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

/** STYLE-SPEC §4.2 fleet table (+ numeral colours per §4.3, numbers assigned here) */
export const FLEET_LIVERIES = {
  hero: { topsides: 0xe9e5da, band: 0xe4572e, stripe: 0x1f4e5f, antifoul: 0x6b2e25, numeral: 0x151b1c, dominant: 0xe4572e, number: 27 },
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
