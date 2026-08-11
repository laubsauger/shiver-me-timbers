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
import type { PieceDef, SocketDef, Vec3 } from './pieceTypes';
import { figureheadStation, hullShapeHints, mkPiece } from './blueprintParts';
import { hullHalfWidthAt, hullTopY, type HullShape } from './hullMath';
import { FLAG_STYLE_JOLLY, FLAG_STYLE_PENNANT } from './flagMaterial';
import { vjitter } from './variation';

/** ship-space position of a socket on an un-rotated, directly-parented piece */
function socketShipPos(piece: PieceDef, socket: SocketDef): Vec3 {
  return [
    piece.transform.position[0] + socket.position[0],
    piece.transform.position[1] + socket.position[1],
    piece.transform.position[2] + socket.position[2],
  ];
}

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
 * Ratlines, masthead pennants and belaying pin racks, derived from the masts
 * and from the chainplate sockets the hull already declares.
 */
export function buildRigDetail(p: ShipClassParams, built: PieceDef[]): PieceDef[] {
  const d = shipDetailParams;
  const pieces: PieceDef[] = [];
  const masts = built.filter((piece) => piece.kind === 'mast');

  for (const mast of masts) {
    const name = mast.id.replace(/^mast-/, '');
    const head = mast.aabb.max[1];
    const [, baseY, mastZ] = mast.transform.position;

    for (const [sideName, sign] of [['port', -1], ['starboard', 1]] as const) {
      // the SAME sockets the shrouds are solved from (§V12) — the rungs land
      // on the ropes because they are interpolated between the same endpoints
      const plates: Vec3[] = [];
      for (const section of built) {
        if (section.kind !== 'hull-section') continue;
        for (const socket of section.sockets) {
          if (!socket.id.startsWith(`anchor-channel-${sideName}-${name}-`)) continue;
          const ship = socketShipPos(section, socket);
          plates.push([ship[0], ship[1] - baseY, ship[2] - mastZ]); // mast-local
        }
      }
      if (plates.length < 2) continue;
      const shape: Record<string, number> = {
        plates: plates.length,
        topX: 0,
        topY: head,
        topZ: 0,
        spacing: d.ratlineSpacing,
        radius: d.ratlineRadius,
        topFrac: d.ratlineTopFrac,
      };
      plates.forEach(([x, y, z], i) => {
        shape[`p${i}x`] = x;
        shape[`p${i}y`] = y;
        shape[`p${i}z`] = z;
      });
      const spread = Math.abs(plates[0][0]);
      pieces.push(
        mkPiece(`ratlines-${sideName}-${name}`, 'ratlines', [0, 0, 0], {
          min: [sign < 0 ? -spread : 0, plates[0][1], -2],
          max: [sign < 0 ? 0 : spread, head, 2],
        }, { parent: mast.id, shape }),
      );
    }

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
      const localZ = mastZ - deckPiece.transform.position[2] - 1.15;
      pieces.push(
        mkPiece(`pin-rail-${name}`, 'pin-rail', [0, 0.04, localZ], {
          min: [-1.15, 0, -0.12],
          max: [1.15, 1.05, 0.12],
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
export function buildHeadWorks(p: ShipClassParams): PieceDef[] {
  const L2 = p.hullLength / 2;
  const bowHints = hullShapeHints(p, 0, L2, L2 + p.bowLength);
  const shell = bowHints as unknown as HullShape;
  const stem = figureheadStation(p); // the same station socket-figurehead uses
  const size = Math.max(1, p.bowLength * 0.62);
  const pieces: PieceDef[] = [
    // rides the stem: the bow piece is what a bow-on ram destroys (§V13)
    mkPiece('figurehead', 'figurehead', [0, stem.y, stem.z - L2], {
      min: [-size * 0.45, -size * 0.75, -size * 0.2],
      max: [size * 0.45, size * 0.45, size * 1.35],
    }, { parent: 'bow' }),
  ];

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
      z0: -(L2 - 0.2),
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
    pieces.push(
      mkPiece(`rail-${run.id}-break`, 'rail', [0, 0, breakZ - run.zc], {
        min: [-half, 0, -t / 2],
        max: [half, d.castleRailHeight, t / 2],
      }, { parent: run.parent }),
    );
  }
  return pieces;
}

/** stern cabin lights, the ensign staff, and the binnacle by the wheel */
export function buildSternDetail(p: ShipClassParams): PieceDef[] {
  const d = shipDetailParams;
  const cabinLen = p.sterncastleLength * 0.5;
  const sl2 = p.sterncastleLength / 2;
  return [
    // glazing behind the gallery's mullions (the band had none at all)
    mkPiece('stern-lights', 'window', [0, 0, -0.055], {
      min: [-0.01, -p.galleryHeight * 0.34, -0.05],
      max: [0.01, p.galleryHeight * 0.34, 0.05],
    }, { parent: 'gallery', shape: { lights: 5 } }),
    // the ensign at the taffrail, on its own raked staff
    mkPiece('ensign-stern', 'pennant', [0, p.cabinHeight, -cabinLen / 2 + 0.15], {
      min: [0, -d.pennantHoist * 1.5, -0.1],
      max: [d.pennantFly * 0.65, d.ensignStaff + 0.2, 0.1],
    }, {
      parent: 'cabin',
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
    mkPiece('binnacle', 'binnacle', [0.95, 0.04, sl2 - 1.75], {
      min: [-0.3, 0, -0.26],
      max: [0.3, 1.1, 0.26],
    }, { parent: 'sterncastle-deck' }),
  ];
}
