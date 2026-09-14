/**
 * §T.191 EIGHT BOATS, EIGHT COLOURS YOU CAN TELL APART (user playtest 2026-09-13: "all NPCs should use unique,
 * well-readable and different colours").
 *
 * WHY: in a pack at 40 kn the livery IS the name tag — the HUD's plotter dots and standings use the same hues, and a
 * rival you cannot pick out of the pack is a rival you cannot race. Measured in CIEDE2000 (the perceptual difference
 * formula, Sharma et al. 2005 reference implementation, sRGB D65):
 *  - every pair of SIGNATURE hues (band = deck band = cowl tops = dominant) ≥ 25;
 *  - §T.200: on every boat the band stands ≥ 30 from its own topsides, so the player-colour stripe always reads
 *    (the §T.197 one-colour boats had band = topsides: no stripe, no deck band edge, no cowl split), and the pinstripe
 *    ≥ 25 from the topsides it runs on and ≥ 15 from the band. The old "hulls ≥ 20 apart" rule is gone: the bases are
 *    deliberately neutral (bone, white, sand, charcoal …) and identity rides on the signature, which already keeps the
 *    hero's orange ≥ 25 from every rival;
 *  - no dominant within 15 of the sea it races on (Tower Reach teal shallows, deep water, sky): a blue or teal boat
 *    disappears;
 *  - the roster's HUD hue is the hull's dominant, so the plotter dot and the boat are one colour.
 * The formula is checked against Sharma's published test pairs first, so a wrong ΔE cannot pass a wrong palette.
 */
import { describe, expect, it } from 'vitest';
import { FLEET_LIVERIES } from '../src/speedboat/assets/livery';
import { COMMUNITY_LIVERIES } from '../src/speedboat/page/liveries';
import { COMMUNITY_PAINTS } from '../src/speedboat/ui/roster';

function labOfLinear(X: number, Y: number, Z: number): [number, number, number] {
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const fx = f(X / 0.95047);
  const fy = f(Y);
  const fz = f(Z / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function labOfHex(hex: number): [number, number, number] {
  const lin = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const r = lin((hex >> 16) & 255);
  const g = lin((hex >> 8) & 255);
  const b = lin(hex & 255);
  return labOfLinear(0.4124 * r + 0.3576 * g + 0.1805 * b, 0.2126 * r + 0.7152 * g + 0.0722 * b, 0.0193 * r + 0.1192 * g + 0.9505 * b);
}

export function ciede2000([L1, a1, b1]: readonly number[], [L2, a2, b2]: readonly number[]): number {
  const d = Math.PI / 180;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const hp = (b: number, a: number): number => (a === 0 && b === 0 ? 0 : (Math.atan2(b, a) / d + 360) % 360);
  const h1p = hp(b1, a1p);
  const h2p = hp(b2, a2p);
  const dL = L2 - L1;
  const dC = C2p - C1p;
  let dh = h2p - h1p;
  if (C1p * C2p === 0) dh = 0;
  else if (dh > 180) dh -= 360;
  else if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(C1p * C2p) * Math.sin((dh / 2) * d);
  const Lb = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hb = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hb += hb < 360 ? 360 : -360;
    hb /= 2;
  }
  const T = 1 - 0.17 * Math.cos((hb - 30) * d) + 0.24 * Math.cos(2 * hb * d) + 0.32 * Math.cos((3 * hb + 6) * d) - 0.2 * Math.cos((4 * hb - 63) * d);
  const SL = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2);
  const SC = 1 + 0.045 * Cbp;
  const SH = 1 + 0.015 * Cbp * T;
  const RT = -2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7)) * Math.sin(60 * Math.exp(-(((hb - 275) / 25) ** 2)) * d);
  return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH));
}

const SEA = { 'teal shallows': 0x3e8c8a, 'deep water': 0x1f4e5f, sky: 0x9fc4e0 };
const hexName = (h: number): string => `#${h.toString(16).padStart(6, '0')}`;

describe('§T.191 the eight liveries are distinct and readable', () => {
  it('the ΔE implementation reproduces Sharma et al. (2005) reference pairs', () => {
    // (L, a, b) pairs and ΔE00 from the paper's test data table
    const pairs: [number[], number[], number][] = [
      [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
      [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
      [[50, 2.5, 0], [50, 0, -2.5], 4.3065],
      [[50, 2.5, 0], [73, 25, -18], 27.1492],
      [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
      [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373],
    ];
    for (const [a, b, want] of pairs) expect(ciede2000(a, b)).toBeCloseTo(want, 3);
  });

  it('signatures ≥ 25 apart, no sea lookalike, HUD hue = signature', () => {
    const ids = Object.keys(COMMUNITY_LIVERIES);
    expect(ids.length).toBe(8);
    const low: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const A = COMMUNITY_LIVERIES[ids[i]];
        const B = COMMUNITY_LIVERIES[ids[j]];
        const dd = ciede2000(labOfHex(A.dominant), labOfHex(B.dominant));
        if (dd < 25) low.push(`signature ${ids[i]} ${hexName(A.dominant)} / ${ids[j]} ${hexName(B.dominant)}: ${dd.toFixed(1)}`);
      }
      const L = COMMUNITY_LIVERIES[ids[i]];
      for (const [name, sea] of Object.entries(SEA)) {
        const ds = ciede2000(labOfHex(L.dominant), labOfHex(sea));
        if (ds < 15) low.push(`${ids[i]} ${hexName(L.dominant)} vs ${name}: ${ds.toFixed(1)}`);
      }
    }
    expect(low).toEqual([]);
    // §T.200: one signature per boat, worn by the band, the deck band and the cowl tops alike
    for (const [id, l] of Object.entries(COMMUNITY_LIVERIES)) expect(l.band, id).toBe(l.dominant);
    // §T.197: the eight rows live in the ASSET table (one source for hull, deck band and cowls), the page only joins them
    expect(Object.keys(FLEET_LIVERIES).length).toBe(8);
    for (const p of COMMUNITY_PAINTS) expect(COMMUNITY_LIVERIES[p.id], p.id).toBe((FLEET_LIVERIES as Record<string, unknown>)[p.liveryKey]);
    // the hero keeps STYLE-SPEC's signal orange band on bone, and no rival wears an orange that reads as the hero's
    expect(FLEET_LIVERIES.hero.band).toBe(0xe4572e);
    for (const p of COMMUNITY_PAINTS) {
      if (p.id === 'signal') continue; // the HUD's signal orange is the STYLE-SPEC hero's, a different sRGB of the same band
      expect(Number.parseInt(p.hue.slice(1), 16), p.id).toBe(COMMUNITY_LIVERIES[p.id].dominant);
    }
  });
});

describe('§T.200 every boat wears the stripe scheme: the side stripe and its pinstripe read on the hull', () => {
  it('band vs topsides ≥ 30, pinstripe vs topsides ≥ 25 and vs band ≥ 15, on all eight', () => {
    const low: string[] = [];
    for (const [id, l] of Object.entries(COMMUNITY_LIVERIES)) {
      const bt = ciede2000(labOfHex(l.band), labOfHex(l.topsides));
      const st = ciede2000(labOfHex(l.stripe), labOfHex(l.topsides));
      const sb = ciede2000(labOfHex(l.stripe), labOfHex(l.band));
      if (bt < 30) low.push(`${id}: band ${hexName(l.band)} on topsides ${hexName(l.topsides)} ${bt.toFixed(1)} < 30`);
      if (st < 25) low.push(`${id}: pinstripe ${hexName(l.stripe)} on topsides ${hexName(l.topsides)} ${st.toFixed(1)} < 25`);
      if (sb < 15) low.push(`${id}: pinstripe ${hexName(l.stripe)} vs band ${hexName(l.band)} ${sb.toFixed(1)} < 15`);
    }
    expect(low).toEqual([]);
    // the rule bites: the §T.197 one-colour rows (topsides = band) fail it
    const oneColour = { ...COMMUNITY_LIVERIES['dome-ten'], topsides: COMMUNITY_LIVERIES['dome-ten'].band };
    expect(ciede2000(labOfHex(oneColour.band), labOfHex(oneColour.topsides))).toBeLessThan(30);
  });
});
