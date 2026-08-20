/**
 * §T.34 detail-pass blueprint generators.
 *
 * DERIVED, NOT DUPLICATED. Every fitting here is generated FROM the pieces it
 * hangs on — gunports from the hull sections' own shape hints, deadeye
 * channels from the chainplate sockets those sections already declare,
 * ratlines from those same sockets plus the masthead. Recomputing any of it
 * from params would let the fitting and its host drift apart, which is
 * precisely the failure §V37 was written about (two polylines through one
 * curve agree only at the ends).
 *
 * §V13/§V18: these are real pieces with parents, sockets and damage states,
 * not decoration welded into a shell. Blow a hull section away and its ports,
 * its channel and its moulding go with it; break a mast and its ratlines and
 * its pennant go with that.
 */
import { galleonParams, shipDetailParams, type ShipClassParams } from '../params/ship';
import type { PieceDef, SocketDef } from './pieceTypes';
import {
  PIN_RAIL_HALF,
  PIN_RAIL_SETBACK,
  companionwayStations,
  figureheadStation,
  helmStation,
  hullShapeHints,
  mkPiece,
} from './blueprintParts';
import { hullHalfWidthAt, hullTopY, type HullShape } from './hullMath';
import { FLAG_STYLE_JOLLY, FLAG_STYLE_PENNANT } from './flagMaterial';
import { vjitter } from './variation';

/**
 * Gunports, channels and the sheer moulding for the hull sections that were
 * already built. Reads their hints and their chainplate sockets, so nothing
 * here can disagree with the shell.
 */
export function buildHullFittings(
  p: ShipClassParams,
  sections: PieceDef[],
): PieceDef[] {
  const d = shipDetailParams;
  const pieces: PieceDef[] = [];
  for (const section of sections) {
    const hints = section.shape;
    if (hints === undefined) continue;
    const zc = section.transform.position[2];
    const side = hints.side >= 0 ? 1 : -1;
    const shell = hints as unknown as HullShape;

    // --- gunports ---------------------------------------------------------
    pieces.push(
      mkPiece(`gunports-${section.id.replace('hull-', '')}`, 'gunport', [0, 0, 0], {
        min: [side < 0 ? -shell.beamHalf : 0, d.gunportY - 1, section.aabb.min[2]],
        max: [side < 0 ? 0 : shell.beamHalf, d.gunportY + d.gunportSize + 1, section.aabb.max[2]],
      }, {
        parent: section.id,
        shape: { ...hints, zc, ports: d.gunportsPerSection, portSize: d.gunportSize, portY: d.gunportY },
      }),
    );

    // --- deadeye channels, one per chainplate fan on this section ---------
    const fans = new Map<string, SocketDef[]>();
    for (const socket of section.sockets) {
      const match = /^anchor-channel-(port|starboard)-(\w+)-\d+$/.exec(socket.id);
      if (match === null) continue;
      const key = match[2];
      const list = fans.get(key) ?? [];
      list.push(socket);
      fans.set(key, list);
    }
    for (const [mast, plates] of fans) {
      const shape: Record<string, number> = {
        ...hints,
        zc,
        plates: plates.length,
        radius: d.deadeyeRadius,
        // the board has to reach past the deadeye, and the deadeye's station
        // is the plate socket itself — one number, not two (§T.75)
        proj: p.channelProjection,
      };
      let minZ = Infinity;
      let maxZ = -Infinity;
      plates.forEach((plate, i) => {
        shape[`p${i}x`] = plate.position[0];
        shape[`p${i}y`] = plate.position[1];
        shape[`p${i}z`] = plate.position[2];
        minZ = Math.min(minZ, plate.position[2]);
        maxZ = Math.max(maxZ, plate.position[2]);
      });
      const y0 = plates[0].position[1];
      pieces.push(
        mkPiece(`channel-${side < 0 ? 'port' : 'starboard'}-${mast}`, 'channel', [0, 0, 0], {
          min: [side < 0 ? -shell.beamHalf - 0.5 : 0, y0 - 1, minZ - 0.6],
          max: [side < 0 ? 0 : shell.beamHalf + 0.5, y0 + 1, maxZ + 0.6],
        }, { parent: section.id, shape }),
      );
    }
  }

  // --- sheer moulding, one run per side over the whole midships ------------
  const len = p.hullLength * 0.86;
  for (const [name, sign] of [['port', -1], ['starboard', 1]] as const) {
    pieces.push(
      mkPiece(`moulding-${name}`, 'moulding', [0, 0, 0], {
        min: [sign < 0 ? -p.beam / 2 : 0, 0, -len / 2],
        max: [sign < 0 ? 0 : p.beam / 2, p.freeboard + Math.max(p.sheerBow, p.sheerStern), len / 2],
      }, {
        shape: {
          ...hullShapeHints(p, sign, -len / 2, len / 2),
          drop: 0.62,
          section: d.mouldingSize,
        },
      }),
    );
  }
  return pieces;
}

/**
 * Masthead pennants and belaying pin racks, derived from the masts the hull
 * already declares. Ratlines are NOT here: they are rope geometry now, and
 * ratlinePlan.ts emits the intent for src/ropes to solve (§V.45).
 */
export function buildRigDetail(p: ShipClassParams, built: PieceDef[]): PieceDef[] {
  const d = shipDetailParams;
  const pieces: PieceDef[] = [];
  const masts = built.filter((piece) => piece.kind === 'mast');

  for (const mast of masts) {
    const name = mast.id.replace(/^mast-/, '');
    const head = mast.aabb.max[1];
    const [, baseY, mastZ] = mast.transform.position;
    // (ratlines used to be generated here as static rung meshes; they are now
    // src/ropes' to draw off the solved shrouds — see ratlinePlan.ts, §V.45)

    // masthead flag. The main truck flies the colours; fore and mizzen fly
    // long coachwhip pennants, which are the finer wind telltale of the two.
    const isMain = name === 'main';
    pieces.push(
      mkPiece(`pennant-${name}`, 'pennant', [0, head + 0.12, 0], {
        min: [0, -(isMain ? d.flagHoist : d.pennantHoist), -0.1],
        max: [isMain ? d.flagFly : d.pennantFly, 0.1, 0.1],
      }, {
        parent: mast.id,
        shape: {
          fly: isMain ? d.flagFly : d.pennantFly,
          hoist: isMain ? d.flagHoist : d.pennantHoist,
          style: isMain ? FLAG_STYLE_JOLLY : FLAG_STYLE_PENNANT,
          taper: isMain ? 0 : 0.72,
          headY: 0,
          staff: 0, // the mast truck IS the staff
        },
      }),
    );

    // fiferail at the mast foot, on the deck the mast is stepped on — it stays
    // aboard when the mast goes over the side, so it is NOT a child of the mast
    const deckId = Math.abs(baseY - p.freeboard) < 0.05 ? 'deck' : 'sterncastle-deck';
    const deckPiece = built.find((piece) => piece.id === deckId);
    if (deckPiece !== undefined) {
      const localZ = mastZ - deckPiece.transform.position[2] - PIN_RAIL_SETBACK;
      pieces.push(
        mkPiece(`pin-rail-${name}`, 'pin-rail', [0, 0.04, localZ], {
          min: [-1.15, 0, -PIN_RAIL_HALF],
          max: [1.15, 1.05, PIN_RAIL_HALF],
        }, { parent: deckId }),
      );
    }
  }
  return pieces;
}

/**
 * Head works: figurehead, beakhead rails, catheads and their anchors. The
 * figurehead finally mounts `socket-figurehead`, which existed with nothing
 * on it.
 */
export function buildHeadWorks(
  p: ShipClassParams,
  opts: { figurehead: boolean }, // the same flag buildBowAndTransom's socket takes
): PieceDef[] {
  const L2 = p.hullLength / 2;
  const bowHints = hullShapeHints(p, 0, L2, L2 + p.bowLength);
  const shell = bowHints as unknown as HullShape;
  const stem = figureheadStation(p); // the same station socket-figurehead uses
  const size = Math.max(1, p.bowLength * 0.62);
  const pieces: PieceDef[] = opts.figurehead
    ? [
        // rides the stem: the bow piece is what a bow-on ram destroys (§V13)
        mkPiece('figurehead', 'figurehead', [0, stem.y, stem.z - L2], {
          min: [-size * 0.45, -size * 0.75, -size * 0.2],
          max: [size * 0.45, size * 0.45, size * 1.35],
        }, { parent: 'bow' }),
      ]
    : [];

  for (const [name, sign] of [['port', -1], ['starboard', 1]] as const) {
    pieces.push(
      mkPiece(`headrail-${name}`, 'headrail', [0, 0, 0], {
        min: [sign < 0 ? -p.beam * 0.4 : 0, p.freeboard, 0],
        max: [sign < 0 ? 0 : p.beam * 0.4, p.freeboard + p.sheerBow + 2.4, p.bowLength],
      }, {
        parent: 'bow',
        shape: {
          ...bowHints,
          side: sign,
          zc: L2,
          startZ: L2 + 0.2,
          startY: hullTopY(L2 + 0.2, shell) - 0.15,
          endZ: L2 + p.bowLength * 0.95,
          endY: hullTopY(L2 + p.bowLength, shell) + 1.15,
          flare: 0.42,
        },
      }),
    );

    // cathead: rakes forward and outboard off the forecastle break
    const catZ = L2 - 0.4;
    const catY = p.freeboard + p.forecastleRise + 0.55;
    const catX = hullHalfWidthAt(catZ, catY, hullShapeHints(p, 0, catZ, catZ) as unknown as HullShape);
    const rake = sign * (0.42 + vjitter(0.03, sign, 5)); // hand-fitted, not mirrored
    pieces.push(
      mkPiece(`cathead-${name}`, 'cathead', [sign * catX * 0.86, catY, catZ], {
        min: [-0.19, -0.22, 0],
        max: [0.19, 0.22, 1.9],
      }, {
        rotation: [-0.12, rake, 0],
        sockets: [{ id: `socket-cathead-${name}`, type: 'fixture', position: [0, -0.2, 1.7] }],
      }),
      mkPiece(`anchor-${name}`, 'anchor', [sign * (catX * 0.86 + sign * 0.7), catY - 0.3, catZ + 1.5], {
        min: [-shipDetailParams.anchorSize * 0.45, -shipDetailParams.anchorSize * 1.15, -0.2],
        max: [shipDetailParams.anchorSize * 0.45, 0.2, 0.2],
      }, { rotation: [0, sign * 0.25, sign * -0.22] }),
    );
  }
  return pieces;
}

/**
 * Railings on the raised decks and the stern detail. The user has asked for
 * railings three times: a quarterdeck you can walk on with nothing round its
 * edge is the loudest missing element in the whole silhouette.
 */
export function buildDeckRails(p: ShipClassParams = galleonParams): PieceDef[] {
  const d = shipDetailParams;
  const L2 = p.hullLength / 2;
  const t = p.railThickness;
  const pieces: PieceDef[] = [];
  const ladders = companionwayStations(p);

  /**
   * The CABIN swallows the after end of the quarterdeck run.
   *
   * `buildCastles` puts a solid tapered cabin block on the quarterdeck from
   * the transom forward over `sterncastleLength × 0.5`, rising cabinHeight —
   * so 4.4 m of each 8.8 m quarterdeck rail was drawn inside it. The rail
   * stops at the cabin's forward face instead, which is also the honest
   * answer: you cannot fall off there, there is a deckhouse in the way.
   */
  const cabinFront = -(L2 - p.sterncastleLength * 0.5);
  const runs = [
    {
      id: 'forecastle',
      parent: 'forecastle-deck',
      z0: L2 - p.forecastleLength,
      z1: L2 - 0.15,
      zc: L2 - p.forecastleLength / 2,
    },
    {
      id: 'quarterdeck',
      parent: 'sterncastle-deck',
      z0: cabinFront,
      z1: -(L2 - p.sterncastleLength),
      zc: -(L2 - p.sterncastleLength / 2),
    },
  ] as const;

  for (const run of runs) {
    for (const [name, sign] of [['port', -1], ['starboard', 1]] as const) {
      const z0 = Math.min(run.z0, run.z1);
      const z1 = Math.max(run.z0, run.z1);
      pieces.push(
        mkPiece(`rail-${run.id}-${name}`, 'rail', [0, 0, -run.zc], {
          min: [sign < 0 ? -p.beam / 2 : t, 0, z0],
          max: [sign < 0 ? -t : p.beam / 2, d.castleRailHeight, z1],
        }, {
          parent: run.parent,
          shape: {
            ...hullShapeHints(p, sign, z0, z1),
            // a castle deck is FLAT: it does not carry the main sheer, and
            // adding it here would rake every stanchion up toward the ends
            sheerBow: 0,
            sheerStern: 0,
            railInset: p.railInset + 0.16,
            railHeight: d.castleRailHeight,
          },
        }),
      );
    }
    // athwartships rail across the break of the deck (straight run: no hull
    // hints, so the post-and-rail builder handles it)
    const breakZ = run.id === 'forecastle' ? run.z0 : run.z1;
    const half = hullHalfWidthAt(
      breakZ,
      p.freeboard,
      hullShapeHints(p, 0, breakZ, breakZ) as unknown as HullShape,
    ) * 0.9;
    /**
     * THE TWO STAIRCASE GAPS (§T.45, user: "railings that are all the way
     * around except for 2 staircases left and right around the steering
     * wheel").
     *
     * The quarterdeck break is where both companionways land, so this is the
     * run that has to carry holes. Nothing anywhere used to cut one — the
     * stairs simply intersected the rail and the bulkhead behind it.
     *
     * Gaps are declared in ARC LENGTH FROM THE PORT END, because that is the
     * one parameter `buildRailRun` works in and it is the same whether the run
     * is straight or curved. The stair centres are mirrored about the
     * centreline, so `x + half` converts each to its arc position.
     */
    /**
     * Gaps come from `companionwayStations` — the SAME call blueprintCastles
     * places the ladders from (§V.37). Declared in ARC LENGTH FROM THE PORT
     * END, because that is the one parameter `buildRailRun` works in and it
     * reads the same whether a run is straight or curved.
     */
    const clear = d.stairWidth / 2 + 0.12; // stair half-width plus a hand's clearance
    const gaps: Record<string, number> = {};
    const here = ladders.filter((st) => Math.abs(st.headZ - breakZ) < 0.05);
    gaps.gapCount = here.length;
    here.forEach((st, i) => {
      gaps[`gap${i}Center`] = st.x + half;
      gaps[`gap${i}Half`] = clear;
    });
    pieces.push(
      mkPiece(`rail-${run.id}-break`, 'rail', [0, 0, breakZ - run.zc], {
        min: [-half, 0, -t / 2],
        max: [half, d.castleRailHeight, t / 2],
      }, { parent: run.parent, shape: gaps }),
    );
  }
  return pieces;
}

/**
 * Stern cabin lights, the ensign staff, and the binnacle by the wheel. A class
 * without a gallery has no lights to glaze; one without a cabin flies her
 * ensign off the transom head instead of the cabin roof (§V.18).
 */
export function buildSternDetail(p: ShipClassParams): PieceDef[] {
  const d = shipDetailParams;
  const L2 = p.hullLength / 2;
  const cabinLen = p.sterncastleLength * 0.5;
  const helm = helmStation(p);
  const onCabin = p.cabinHeight > 0;
  const sternHints = hullShapeHints(p, 0, -L2, -L2) as unknown as HullShape;
  const ensignZ = -(L2 - 0.25); // ship-space, 0.25 m forward of the counter
  return [
    // glazing behind the gallery's mullions (the band had none at all)
    ...(p.galleryHeight > 0
      ? [
          mkPiece('stern-lights', 'window', [0, 0, -0.055], {
            min: [-0.01, -p.galleryHeight * 0.34, -0.05],
            max: [0.01, p.galleryHeight * 0.34, 0.05],
          }, { parent: 'gallery', shape: { lights: 5 } }),
        ]
      : []),
    // the ensign at the taffrail, on its own raked staff
    mkPiece('ensign-stern', 'pennant',
      onCabin
        ? [0, p.cabinHeight, -cabinLen / 2 + 0.15]
        : [0, hullTopY(ensignZ, sternHints), ensignZ + L2], {
      min: [0, -d.pennantHoist * 1.5, -0.1],
      max: [d.pennantFly * 0.65, d.ensignStaff + 0.2, 0.1],
    }, {
      parent: onCabin ? 'cabin' : 'transom',
      rotation: [-0.26, 0, 0], // staffs at the taffrail rake aft
      shape: {
        fly: d.pennantFly * 0.62,
        hoist: d.pennantHoist * 1.5,
        style: FLAG_STYLE_JOLLY,
        taper: 0,
        headY: d.ensignStaff,
        staff: 1,
      },
    }),
    // 1.05 m abaft the wheel and off the centreline, on the helmsman's deck
    mkPiece('binnacle', 'binnacle', [0.95, 0.04, helm.wheelZ - 1.05], {
      min: [-0.3, 0, -0.26],
      max: [0.3, 1.1, 0.26],
    }, { parent: helm.deckId }),
  ];
}
