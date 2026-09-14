/**
 * THE EIGHT COMMUNITY PAINTS AS HULL LIVERIES (§T.185 → §T.191 → §T.197). The HUD's roster (`ui/roster.ts`
 * COMMUNITY_PAINTS) names eight community paints and joins each to the asset table by `liveryKey`; the asset side
 * (`assets/livery.ts` FLEET_LIVERIES) now carries all eight rows (hero + seven community boats: a neutral base, one
 * signature hue on band / deck band / cowl tops, a contrasting pinstripe, §T.200), so this file is only the join by paint
 * id. Every value is a `BoatLivery` over the one shared hull mask (hull bands, deck
 * band, cowl tops): a paint needs no texture of its own. Pure data, no three.js.
 */
import { FLEET_LIVERIES, type BoatLivery } from '../assets/livery';
import { COMMUNITY_PAINTS } from '../ui/roster';

const fleet = FLEET_LIVERIES as Readonly<Record<string, Readonly<BoatLivery>>>;

/** paint id → livery; a paint whose `liveryKey` the asset table lacks fails loud at import (never a silent hero boat) */
export const COMMUNITY_LIVERIES: Readonly<Record<string, Readonly<BoatLivery>>> = Object.freeze(
  Object.fromEntries(
    COMMUNITY_PAINTS.map((p) => {
      const l = fleet[p.liveryKey];
      if (!l) throw new Error(`[speedboat] paint '${p.id}': no livery '${p.liveryKey}' in assets/livery.ts FLEET_LIVERIES`);
      return [p.id, l];
    }),
  ),
);

/** the paint's livery wearing race number `number`; an unknown paint falls back to the hero (never NaN colours) */
export function liveryFor(paintId: string, number: number): BoatLivery {
  const base = COMMUNITY_LIVERIES[paintId] ?? FLEET_LIVERIES.hero;
  return { ...base, number };
}
