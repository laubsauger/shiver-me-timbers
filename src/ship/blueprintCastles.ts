/**
 * Castle + deck-furniture blueprint generators (galleon stern/bow works).
 * §V.13 pieces only; castle decks carry hull shape hints so their slabs
 * taper with the plan (§V22 — no overhang), furniture pieces sit at the
 * fixture sockets (wheel, capstan) plus grating and companionway stairs.
 */
import type { ShipClassParams } from '../params/ship';
import type { PieceDef } from './pieceTypes';
import { hullShapeHints, mkPiece } from './blueprintParts';

/** Raised bow/stern works: forecastle, quarterdeck + cabin (stepped stern
 *  ~2 levels above main deck), gallery band, lantern posts. Galleon only. */
export function buildCastles(p: ShipClassParams): PieceDef[] {
  const L2 = p.hullLength / 2;
  const cabinLen = p.sterncastleLength * 0.5;
  const roofY = p.freeboard + p.sterncastleRise + p.cabinHeight;
  return [
    // castle decks taper with the hull plan (shape hints) and carry their
    // bulkhead + posts down to the main deck — never a floating slab
    mkPiece('forecastle-deck', 'forecastle-deck',
      [0, p.freeboard + p.forecastleRise, L2 - p.forecastleLength / 2],
      {
        min: [-p.beam * 0.425, -p.forecastleRise, -p.forecastleLength / 2],
        max: [p.beam * 0.425, 0, p.forecastleLength / 2],
      },
      {
        shape: {
          ...hullShapeHints(p, 0, L2 - p.forecastleLength, L2),
          rise: p.forecastleRise,
          bulkheadAft: 1,
        },
      }),
    mkPiece('sterncastle-deck', 'sterncastle-deck',
      [0, p.freeboard + p.sterncastleRise, -(L2 - p.sterncastleLength / 2)],
      {
        min: [-p.beam * 0.475, -p.sterncastleRise, -p.sterncastleLength / 2],
        max: [p.beam * 0.475, 0, p.sterncastleLength / 2],
      },
      {
        sockets: [{
          id: 'socket-wheel',
          type: 'fixture',
          position: [0, 0.05, p.sterncastleLength / 2 - 0.4],
        }],
        shape: {
          ...hullShapeHints(p, 0, -L2, -L2 + p.sterncastleLength),
          rise: p.sterncastleRise,
          bulkheadAft: 0,
        },
      }),
    // cabin plan follows the stern envelope — part of the hull silhouette
    mkPiece('cabin', 'cabin',
      [0, p.freeboard + p.sterncastleRise, -(L2 - cabinLen / 2 - 0.1)],
      {
        min: [-p.beam * 0.42, 0, -cabinLen / 2],
        max: [p.beam * 0.42, p.cabinHeight, cabinLen / 2],
      },
      { shape: hullShapeHints(p, 0, -(L2 - 0.1), -(L2 - 0.1 - cabinLen)) }),
    mkPiece('gallery', 'gallery',
      [0, p.freeboard + p.sterncastleRise + p.cabinHeight * 0.5, -(L2 + 0.15)],
      {
        min: [-p.beam * 0.38, -p.galleryHeight / 2, -0.12],
        max: [p.beam * 0.38, p.galleryHeight / 2, 0.12],
      }),
    mkPiece('lantern-post-port', 'lantern-post',
      [-p.beam * 0.32, roofY, -(L2 - 0.5)],
      { min: [-0.1, 0, -0.1], max: [0.1, p.lanternPostHeight, 0.1] }),
    mkPiece('lantern-post-starboard', 'lantern-post',
      [p.beam * 0.32, roofY, -(L2 - 0.5)],
      { min: [-0.1, 0, -0.1], max: [0.1, p.lanternPostHeight, 0.1] }),
  ];
}

/** deck furniture: wheel + capstan at their fixture sockets, hatch
 *  grating, companionway stairs to both castles (§V22 review) */
export function buildFurniture(p: ShipClassParams): PieceDef[] {
  const L2 = p.hullLength / 2;
  const sl2 = p.sterncastleLength / 2;
  return [
    mkPiece('wheel', 'wheel', [0, 0.05, sl2 - 0.7],
      { min: [-0.75, 0, -0.3], max: [0.75, 1.5, 0.3] },
      { parent: 'sterncastle-deck' }),
    mkPiece('capstan', 'capstan', [0, 0.05, p.hullLength * 0.18],
      { min: [-0.85, 0, -0.85], max: [0.85, 1.15, 0.85] },
      { parent: 'deck' }),
    mkPiece('grating-main', 'grating', [0, 0.02, -2],
      { min: [-0.85, 0, -1.0], max: [0.85, 0.24, 1.0] },
      { parent: 'deck' }),
    // stairs climb +z; the aft pair is turned 180° to climb the sterncastle
    mkPiece('stairs-fore', 'stairs', [1.7, 0, L2 - p.forecastleLength - 0.9],
      { min: [-0.6, 0, -0.9], max: [0.6, p.forecastleRise, 0.9] },
      { parent: 'deck' }),
    mkPiece('stairs-aft', 'stairs', [1.7, 0, -(L2 - p.sterncastleLength) - 0.9],
      { min: [-0.6, 0, -1.1], max: [0.6, p.sterncastleRise, 1.1] },
      { parent: 'deck', rotation: [0, Math.PI, 0] }),
  ];
}
