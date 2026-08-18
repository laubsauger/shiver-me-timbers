/**
 * Castle + deck-furniture blueprint generators (galleon stern/bow works).
 * §V.13 pieces only; castle decks carry hull shape hints so their slabs
 * taper with the plan (§V22 — no overhang), furniture pieces sit at the
 * fixture sockets (wheel, capstan) plus grating and companionway stairs.
 */
import { shipDetailParams, type ShipClassParams } from '../params/ship';
import { LANTERN_ARM_REACH, type PieceDef, type Vec3 } from './pieceTypes';
import { companionwayStations, hullShapeHints, mkPiece } from './blueprintParts';
import { hullHalfWidthAt, type HullShape } from './hullMath';
import { wheelHubHeight } from './pieceGeometryFittings';

/** Raised bow/stern works: forecastle, quarterdeck + cabin (stepped stern
 *  ~2 levels above main deck), gallery band, lantern posts. Galleon only. */
export function buildCastles(p: ShipClassParams): PieceDef[] {
  const L2 = p.hullLength / 2;
  const cabinLen = p.sterncastleLength * 0.5;
  const roofY = p.freeboard + p.sterncastleRise + p.cabinHeight;
  // cabin/gallery/lantern stations size themselves from the same envelope
  // the shell uses — nothing aft may be wider than the hull under it
  const sternHints = hullShapeHints(p, 0, -L2, -L2) as unknown as HullShape;
  const cabinAftHalf = hullHalfWidthAt(-(L2 - 0.1), roofY, sternHints) * 0.92;
  const galleryHalf = cabinAftHalf * 0.94;
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
    // window band on the cabin's aft face — width taken from the stern
    // envelope so it can't overhang the transom (§V22 "ugly panels")
    mkPiece('gallery', 'gallery',
      [0, p.freeboard + p.sterncastleRise + p.cabinHeight * 0.5, -(L2 - 0.16)],
      {
        min: [-galleryHalf, -p.galleryHeight / 2, -0.18],
        max: [galleryHalf, p.galleryHeight / 2, 0],
      }),
    // The hang points for the ship's practical lanterns (src/lanterns). The
    // posts already carried the bulb geometry but declared no socket, so the
    // lights had nowhere here to mount and hung off `anchor-cleat-stern-*`
    // instead — two lit spheres floating beside two unlit decorative ones.
    //
    // The socket is the PENDULUM PIVOT, not the flame: `lanterns.place()` hangs
    // the light `cordLength` (0.35 m) below it along the solved hang vector. So
    // it sits at the TOP of the post (the cap the iron is seized to), and it is
    // carried aft by `LANTERN_ARM_REACH` — the post shaft is only 0.05 m in
    // radius and the flame bulb is 0.09, so a pivot on the axis would hang a
    // glowing sphere around the post and let the post poke through it on every
    // swing. Aft rather than outboard keeps her over the transom, not the sea.
    //
    // The reach is SHARED with the geometry (pieceGeometry.ts `lanternPost`),
    // which builds the bracket out to exactly this station. Two literals is how
    // the lamp ended up hanging in mid-air beside a post that stopped 0.26 m
    // short of it. The AABB carries the bracket, so the piece's bounds are the
    // piece's real extent (§V.54's lesson in the geometry domain).
    mkPiece('lantern-post-port', 'lantern-post',
      [-cabinAftHalf * 0.82, roofY, -(L2 - 0.5)],
      { min: [-0.1, 0, -(LANTERN_ARM_REACH + 0.1)], max: [0.1, p.lanternPostHeight, 0.1] },
      {
        sockets: [{
          id: 'socket-lantern-port',
          type: 'fixture',
          position: [0, p.lanternPostHeight, -LANTERN_ARM_REACH],
        }],
      }),
    mkPiece('lantern-post-starboard', 'lantern-post',
      [cabinAftHalf * 0.82, roofY, -(L2 - 0.5)],
      { min: [-0.1, 0, -(LANTERN_ARM_REACH + 0.1)], max: [0.1, p.lanternPostHeight, 0.1] },
      {
        sockets: [{
          id: 'socket-lantern-starboard',
          type: 'fixture',
          position: [0, p.lanternPostHeight, -LANTERN_ARM_REACH],
        }],
      }),
  ];
}

/** deck furniture: wheel + capstan at their fixture sockets, hatch
 *  grating, companionway stairs to both castles (§V22 review) */
export function buildFurniture(p: ShipClassParams): PieceDef[] {
  const sl2 = p.sterncastleLength / 2;
  const WHEEL_HUB_Y = wheelHubHeight({ min: [-0.75, 0, -0.3], max: [0.75, 1.5, 0.3] });
  return [
    mkPiece('wheel', 'wheel', [0, 0.05, sl2 - 0.7],
      { min: [-0.75, 0, -0.3], max: [0.75, 1.5, 0.3] },
      { parent: 'sterncastle-deck' }),
    // THE TURNING HALF, parented to the pedestal at the axle. Same shape as a
    // yard on its mast: the moving part is its own piece so it has its own
    // transform, and ShipAssembly.setHelmAngle spins it. Its aabb is the
    // pedestal's, because the disc's radius is derived from it.
    mkPiece('wheel-disc', 'wheel-disc', [0, WHEEL_HUB_Y, 0],
      { min: [-0.75, 0, -0.3], max: [0.75, 1.5, 0.3] },
      { parent: 'wheel' }),
    mkPiece('capstan', 'capstan', [0, 0.05, p.hullLength * 0.18],
      { min: [-0.85, 0, -0.85], max: [0.85, 1.15, 0.85] },
      { parent: 'deck' }),
    mkPiece('grating-main', 'grating', [0, 0.02, -2],
      { min: [-0.85, 0, -1.0], max: [0.85, 0.24, 1.0] },
      { parent: 'deck' }),
    ...buildCompanionways(p),
  ];
}

/**
 * COMPANIONWAYS — the two flanking the wheel, plus the one to the forecastle.
 *
 * §T.45, user: "railings that are all the way around except for 2 staircases
 * left and right around the steering wheel". Three things were wrong and all
 * three came from the same place — nothing related the stairs to the deck they
 * land on:
 *
 *  1. BOTH stairs were on STARBOARD (x = +1.7). There was no port ladder at
 *     all, so the pair the user is describing did not exist.
 *  2. NEITHER flanked the wheel.
 *  3. The aft one climbed the WRONG WAY. It sat at z −9.4 turned 180°, so it
 *     ran from z −8.3 up to z −10.5 — and the sterncastle block starts at
 *     z −8.5, which means it climbed INTO solid geometry and through the
 *     bulkhead wall on the way.
 *
 * The fix is to derive them from the break they serve rather than from a hand
 * -placed station: a companionway's head is ON the break plane, its foot is
 * one run forward of it on the main deck, and its width and offset are the
 * same two params the rail gaps are cut from (§V.37 — one source, two
 * consumers, or the stair opens into a railing).
 */
function buildCompanionways(p: ShipClassParams): PieceDef[] {
  const hw = shipDetailParams.stairWidth / 2;
  return companionwayStations(p).map((st) => {
    // the head sits ON the break plane and the flight runs away from it, onto
    // the main deck. `buildStairsGeometry` rises along its own +z, so the
    // quarterdeck pair takes a 180° yaw to climb toward −z — which is what
    // stops them ending two metres inside the sterncastle block.
    const z = st.aft ? st.headZ + st.run / 2 : st.headZ - st.run / 2;
    return mkPiece(st.id, 'stairs', [st.x, 0, z],
      { min: [-hw, 0, -st.run / 2], max: [hw, st.rise, st.run / 2] },
      { parent: 'deck', ...(st.aft ? { rotation: [0, Math.PI, 0] as Vec3 } : {}) });
  });
}
