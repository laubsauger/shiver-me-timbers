/**
 * Ship blueprints — pure, deterministic piece-graph generators (§V.13).
 * Two classes share the same part helpers and piece contract (§V.18):
 * a 2-mast brigantine and a 3-mast SoT-style galleon (docs/ship-*.png).
 * No randomness; every dimension comes from params/ship.ts (§V.16).
 */
import { brigantineParams, galleonParams, type ShipClassParams } from '../params/ship';
import type { PieceDef } from './pieceTypes';
import {
  buildBowAndTransom,
  buildCannons,
  buildDeck,
  buildHullSections,
  buildKeel,
  buildRails,
  buildRudder,
} from './blueprintParts';
import { buildCastles, buildFurniture } from './blueprintCastles';
import { buildBowsprit, buildMastRig } from './blueprintRig';

/**
 * Two-masted brigantine, ~30 m. Guns are hull-mounted (4/side across the
 * hull sections); no raised castles, no sails in blueprint, no crow's nest.
 */
export function buildBrigantineBlueprint(
  p: ShipClassParams = brigantineParams,
): PieceDef[] {
  const rig = { sails: false, crowNest: false };
  const hull = buildHullSections(p, { hullCannons: true });
  return [
    buildKeel(p),
    buildDeck(p, { deckCannons: false, capstan: false }),
    ...hull,
    ...buildCannons(hull),
    ...buildBowAndTransom(p),
    ...buildMastRig(p, 'fore', p.foreMastZ, p.foreMastHeight, p.freeboard, rig),
    ...buildMastRig(p, 'main', p.mainMastZ, p.mainMastHeight, p.freeboard, rig),
    buildBowsprit(p, { figurehead: false }),
    ...buildRails(p, { sternBalustrade: false }),
    buildRudder(p),
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
  return [
    buildKeel(p),
    deck,
    ...buildCannons([deck]),
    ...buildHullSections(p, { hullCannons: false }),
    ...buildBowAndTransom(p),
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
    buildBowsprit(p, { figurehead: true }),
    ...buildRails(p, { sternBalustrade: true }),
    buildRudder(p),
  ];
}
