/**
 * Ship blueprints — pure, deterministic piece-graph generators (§V.13).
 * Two classes share the same part helpers and piece contract (§V.18):
 * a 2-mast brigantine and a 3-mast SoT-style galleon (docs/ship-*.png).
 * No randomness; every dimension comes from params/ship.ts (§V.16).
 */
import { brigantineParams, galleonParams, type ShipClassParams } from '../params/ship';
import type { PieceDef } from './pieceTypes';
import {
  buildCannons,
  buildDeck,
  buildHullSections,
  buildKeel,
} from './blueprintParts';
import { buildBowAndTransom, buildRails, buildRudder } from './blueprintEnds';
import { buildCastles, buildFurniture, buildLanternPosts } from './blueprintCastles';
import { buildBowsprit, buildMastRig } from './blueprintRig';
import {
  buildDeckRails,
  buildHeadWorks,
  buildHullFittings,
  buildRigDetail,
  buildSternDetail,
} from './blueprintDetail';

/**
 * Two-masted brigantine, ~30 m. Guns are hull-mounted (4/side across the
 * hull sections); no raised castles, no crow's nest. She carries the same
 * three tiers of canvas per mast as the galleon: she is the ENEMY hull
 * (§T.73), and a ship the AI sails under bare poles reads as a wreck.
 */
export function buildBrigantineBlueprint(
  p: ShipClassParams = brigantineParams,
): PieceDef[] {
  const rig = { sails: true, crowNest: false };
  // chainplates abeam each mast that exists on this class (§V12 shroud feet)
  const hull = buildHullSections(p, {
    hullCannons: true,
    channels: [
      { name: 'fore', z: p.foreMastZ, baseY: p.freeboard },
      { name: 'main', z: p.mainMastZ, baseY: p.freeboard },
    ],
  });
  const core = [
    buildKeel(p),
    buildDeck(p, { deckCannons: false, capstan: true }),
    ...hull,
    ...buildCannons(hull),
    ...buildBowAndTransom(p, { figurehead: false }),
    // no castles, but the same deck fittings on the same builders (§V.18):
    // wheel + binnacle on the main deck aft (helmStation), capstan between
    // the masts, the main hatch, lantern posts at the transom head
    ...buildFurniture(p),
    ...buildLanternPosts(p),
    ...buildMastRig(p, 'fore', p.foreMastZ, p.foreMastHeight, p.freeboard, rig),
    ...buildMastRig(p, 'main', p.mainMastZ, p.mainMastHeight, p.freeboard, rig),
    buildBowsprit(p),
    ...buildRails(p, { sternBalustrade: false }),
    buildRudder(p),
  ];
  // §T.34 fittings are DERIVED from the core pieces (see blueprintDetail.ts),
  // so they are appended after it rather than woven into it
  // buildDeckRails is NOT here: it rails the castle decks, and she has none —
  // her waist rail already runs the whole hull (blueprintEnds)
  return [
    ...core,
    ...buildHullFittings(p, hull),
    ...buildRigDetail(p, core),
    ...buildHeadWorks(p, { figurehead: false }),
    ...buildSternDetail(p),
  ];
}

/**
 * Three-masted galleon, ~35 m (docs/ship-reference-schema.png): fore/main/
 * rear masts (main tallest, crow's nest), raised forecastle, stepped
 * sterncastle (quarterdeck + cabin + gallery + lantern posts), deck-mounted
 * guns 4/side, bowsprit ~20° up with figurehead socket, sails per yard.
 */
export function buildGalleonBlueprint(
  p: ShipClassParams = galleonParams,
): PieceDef[] {
  const rearBaseY = p.freeboard + p.sterncastleRise;
  const deck = buildDeck(p, { deckCannons: true, capstan: true });
  const hull = buildHullSections(p, {
    hullCannons: false,
    // baseY = the deck each mast is STEPPED on; the mizzen stands on the
    // quarterdeck, so its chainplates belong up there too (§V12 clearance)
    channels: [
      { name: 'fore', z: p.foreMastZ, baseY: p.freeboard },
      { name: 'main', z: p.mainMastZ, baseY: p.freeboard },
      { name: 'rear', z: p.rearMastZ, baseY: p.freeboard + p.sterncastleRise },
    ],
  });
  const core = [
    buildKeel(p),
    deck,
    ...buildCannons([deck]),
    ...hull,
    ...buildBowAndTransom(p, { figurehead: true }),
    ...buildCastles(p),
    ...buildFurniture(p),
    ...buildMastRig(p, 'fore', p.foreMastZ, p.foreMastHeight, p.freeboard, {
      sails: true, crowNest: false,
    }),
    ...buildMastRig(p, 'main', p.mainMastZ, p.mainMastHeight, p.freeboard, {
      sails: true, crowNest: true,
    }),
    ...buildMastRig(p, 'rear', p.rearMastZ, p.rearMastHeight, rearBaseY, {
      sails: true, crowNest: false,
    }),
    buildBowsprit(p),
    ...buildRails(p, { sternBalustrade: true }),
    buildRudder(p),
  ];
  return [
    ...core,
    ...buildHullFittings(p, hull),
    ...buildRigDetail(p, core),
    ...buildHeadWorks(p, { figurehead: true }),
    ...buildDeckRails(p),
    ...buildSternDetail(p),
  ];
}
