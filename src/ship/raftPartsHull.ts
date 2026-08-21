/**
 * Raft hull parts — logs, splashboards, crossbeams, foot-rails, bamboo deck,
 * guaras, steering block + oar. §V13 pieces + sockets only, no meshes. Every
 * station comes from raftPartsLayout (one source) and every dimension from
 * params/raft.ts, which cites the reference row (§V82).
 */
import type { RaftParams } from '../params/raft';
import type { PieceDef, SocketDef, SocketType, Vec3 } from './pieceTypes';
import { mkPiece } from './blueprintParts';
import { guaraStations, outermostLogAt, type LogStation, type RaftLayout } from './raftPartsLayout';

/** a socket on a log's TOP at ship-space z (logs are un-rotated, so local = offset) */
function logSocket(
  log: LogStation,
  id: string,
  type: SocketType,
  z: number,
  dx = 0,
): SocketDef {
  const zc = (log.zStern + log.zBow) / 2;
  return { id, type, position: [dx, log.r, z - zc] };
}

/**
 * The nine logs, port → starboard (`log-0` … `log-8`). They carry the static
 * stations that must NOT move with a part: the guara stations (the plank
 * itself rides up and down), the gangways, and the belay points the rigging
 * plan looks for abeam each mast (`anchor-channel-{side}-{mast}-1`).
 */
export function buildLogs(p: RaftParams, L: RaftLayout): PieceDef[] {
  const n = L.logs.length;
  const sockets = new Map<number, SocketDef[]>();
  const add = (k: number, s: SocketDef): void => {
    const list = sockets.get(k) ?? [];
    list.push(s);
    sockets.set(k, list);
  };
  // guara stations: the crew stands on the log INBOARD of the chink [§2 Fixing]
  guaraStations(p).forEach((g, idx) => {
    const k = Math.abs(L.logs[g.chink].i) <= Math.abs(L.logs[g.chink + 1].i) ? g.chink : g.chink + 1;
    add(k, logSocket(L.logs[k], `station-guara-${idx + 1}`, 'fixture', g.z));
  });
  const centre = Math.floor(n / 2);
  add(centre, logSocket(L.logs[centre], 'station-gangway-bow', 'fixture', L.logs[centre].zBow - 0.5));
  // the stern gangway is starboard of the helmsman, on the bare stern logs
  add(centre + 2, logSocket(L.logs[centre + 2], 'station-gangway-stern', 'fixture', L.sternZ + 0.4));
  add(0, logSocket(L.logs[0], 'station-gangway-port', 'fixture', L.cabinAftZ + 1.0));
  add(n - 1, logSocket(L.logs[n - 1], 'station-gangway-starboard', 'fixture', L.cabinAftZ + 1.0));
  // belay / guy points abeam each mast — consumed by src/ropes/shipRigging
  // (main shrouds → outer logs abeam the bipod; mizzen guys + the main
  // sheets' belay → logs ±3 abeam the mizzen) [§4 Standing rigging, Controls]
  add(0, logSocket(L.logs[0], 'anchor-channel-port-main-1', 'rope-anchor', L.mastZ));
  add(n - 1, logSocket(L.logs[n - 1], 'anchor-channel-starboard-main-1', 'rope-anchor', L.mastZ));
  add(1, logSocket(L.logs[1], 'anchor-channel-port-mizzen-1', 'rope-anchor', p.mizzenZ));
  add(n - 2, logSocket(L.logs[n - 2], 'anchor-channel-starboard-mizzen-1', 'rope-anchor', p.mizzenZ));

  return L.logs.map((log, k) =>
    mkPiece(`log-${k}`, 'log', [log.x, p.logAxisY, (log.zStern + log.zBow) / 2], {
      min: [-log.r, -log.r, -log.length / 2],
      max: [log.r, log.r, log.length / 2],
    }, {
      sockets: sockets.get(k) ?? [],
      // bow end tapers and is chamfered "native fashion"; stern cut square [§1]
      shape: { taper: p.logBowTaper, chamfer: p.logBowChamfer, taperLen: p.logTaperLength, sides: 12 },
    }),
  );
}

/**
 * Dark planks across the bow stagger, one per side [§1 Bow ends], and then a
 * straight run aft along each outer log (§B73 [ref-sails-1947]: the boards
 * are a LOW BULWARK down the fore-body, standing ~0.5 m over the logs, not a
 * pair of boards at the tips). Four planks, lashed through the logs.
 */
export function buildSplashboards(p: RaftParams, L: RaftLayout): PieceDef[] {
  const centre = L.logs.find((l) => l.i === 0)!;
  const out: PieceDef[] = [];
  const h = p.splashboardHeight;
  const t = p.splashboardThickness;
  for (const [side, sign] of [['port', -1], ['starboard', 1]] as const) {
    const outer = L.logs[sign < 0 ? 0 : L.logs.length - 1];
    const a: Vec3 = [centre.x, 0, centre.zBow - p.splashboardInset];
    const b: Vec3 = [outer.x, 0, outer.zBow - p.splashboardInset];
    const dx = b[0] - a[0];
    const dz = b[2] - a[2];
    const len = Math.hypot(dx, dz);
    // on the bow ENDS of the logs, which are tapered: the full-radius
    // logTopY left the boards floating a hand's width above the tips
    const yBow = p.logAxisY + outer.r * p.logBowTaper + h / 2 - 0.05;
    out.push(
      mkPiece(`splashboard-${side}`, 'splashboard',
        [(a[0] + b[0]) / 2, yBow, (a[2] + b[2]) / 2], {
          min: [-len / 2, -h / 2, -t / 2],
          max: [len / 2, h / 2, t / 2],
        }, { rotation: [0, Math.atan2(-dz, dx), 0] }),
    );
    // the side run: outboard of the outer log, from the bow board aft
    const run = Math.max(0.5, Math.min(p.splashboardRun, outer.length - p.splashboardInset - 0.5));
    const z1 = b[2];
    out.push(
      mkPiece(`splashboard-${side}-side`, 'splashboard',
        [outer.x + sign * (outer.r + t / 2), p.logAxisY + outer.r + h / 2 - 0.08, z1 - run / 2], {
          min: [-t / 2, -h / 2, -run / 2],
          max: [t / 2, h / 2, run / 2],
        }),
    );
  }
  return out;
}

/** crossbeams on the logs under the decked midsection + the two foot-rail logs */
export function buildCrossbeams(p: RaftParams, L: RaftLayout): PieceDef[] {
  const d = p.crossbeamDiameter;
  const out: PieceDef[] = [];
  const count = Math.max(1, Math.round(p.crossbeamCount));
  for (let k = 0; k < count; k++) {
    // from the cabin's aft wall forward [§9.5: under the decked midsection]
    const z = L.cabinAftZ + 0.2 + k * p.crossbeamPitch;
    out.push(
      mkPiece(`crossbeam-${k}`, 'crossbeam', [0, L.logTopY + d / 2, z], {
        min: [-p.crossbeamLength / 2, -d / 2, -d / 2],
        max: [p.crossbeamLength / 2, d / 2, d / 2],
      }, { shape: { sides: 10 } }),
    );
  }
  const fr = p.footRailDiameter / 2;
  for (const [side, sign] of [['port', -1], ['starboard', 1]] as const) {
    out.push(
      mkPiece(`foot-rail-${side}`, 'log',
        [sign * L.halfBeam, L.logTopY + fr, L.cabinAftZ + p.footRailLength / 2], {
          min: [-fr, -fr, -p.footRailLength / 2],
          max: [fr, fr, p.footRailLength / 2],
        }, { shape: { taper: 1, chamfer: 0, sides: 8 } }),
    );
  }
  return out;
}

/**
 * Rope lashings, one piece per crossbeam, ringing the crossing with every log
 * the beam reaches (and it reaches them all: 5.5 m over a ~5.3 m field). The
 * ring positions ride in `shape` because a geometry builder only sees the
 * piece's own box (§V18); the §T89 test counts rings against crossings.
 */
export function buildLashings(p: RaftParams, L: RaftLayout): PieceDef[] {
  const d = p.crossbeamDiameter;
  const count = Math.max(1, Math.round(p.crossbeamCount));
  const out: PieceDef[] = [];
  for (let k = 0; k < count; k++) {
    const z = L.cabinAftZ + 0.2 + k * p.crossbeamPitch;
    // the OUTER two logs each side: the crossings the deck does not cover,
    // which is where the photos show the rope [PHOTO-01,08]. The inner five
    // are under the mats forward of the cabin, and the tri budget is better
    // spent where it is seen (the §T89 test measures the count).
    const half = (L.logs.length - 1) / 2;
    const reached = L.logs.filter((l) => Math.abs(l.i) >= half - 1
      && Math.abs(l.x) <= p.crossbeamLength / 2 && z > l.zStern && z < l.zBow);
    const shape: Record<string, number> = {
      n: reached.length,
      rope: p.lashingRopeDiameter,
      turns: p.lashingTurns,
      beamR: d / 2,
      logR: Math.max(...reached.map((l) => l.r)),
    };
    reached.forEach((l, i) => { shape[`x${i}`] = l.x; });
    const rMax = shape.logR;
    out.push(
      mkPiece(`lashing-${k}`, 'lashing', [0, L.logTopY + d / 2, z], {
        min: [-p.crossbeamLength / 2, -(d + 2 * rMax), -rMax - 0.05],
        max: [p.crossbeamLength / 2, d / 2 + 0.05, rMax + 0.05],
      }, { shape }),
    );
  }
  return out;
}

function slab(
  id: string,
  x0: number, x1: number, z0: number, z1: number,
  y0: number, y1: number,
  sockets: SocketDef[] = [],
  shape: Record<string, number> = { mat: 1 },
): PieceDef {
  return mkPiece(id, 'bamboo-deck', [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], {
    min: [-(x1 - x0) / 2, -(y1 - y0) / 2, -(z1 - z0) / 2],
    max: [(x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2],
  }, { sockets, shape });
}

/**
 * Bamboo deck: FORWARD of the cabin (stepping in with the bow stagger) and the
 * STARBOARD strip alongside it. Nothing port of the cabin, nothing aft [§1 Deck
 * coverage] — those are bare logs, and the deck-field writer (§V83) reads the
 * same pieces, so the walk surface and the look cannot disagree.
 */
export function buildBambooDeck(p: RaftParams, L: RaftLayout): PieceDef[] {
  const y0 = L.crossbeamTopY;
  const y1 = L.deckY;
  const outerP = L.logs[0];
  const outerS = L.logs[L.logs.length - 1];
  const zA = Math.min(outerP.zBow, outerS.zBow) - 0.2;
  const halfW = p.cabinWidth / 2;
  const fore = slab('deck-fore', outerP.x, outerS.x, L.cabinFrontZ, zA, y0, y1, [
    // hauling stations at the mast foot and the two sheets at the cabin's
    // forward corners (§V84 — every sailing action has a place to stand)
    { id: 'station-halyard', type: 'fixture', position: [-0.8, (y1 - y0) / 2, L.mastZ - (L.cabinFrontZ + zA) / 2] },
    { id: 'station-sheet-p', type: 'fixture', position: [-halfW, (y1 - y0) / 2, 0.35 - (zA - L.cabinFrontZ) / 2] },
    { id: 'station-sheet-s', type: 'fixture', position: [halfW, (y1 - y0) / 2, 0.35 - (zA - L.cabinFrontZ) / 2] },
  ]);
  // the tip slab reaches as far as the next log pair in allows
  const tipP = outermostLogAt(L, zA + 0.6, -1);
  const tipS = outermostLogAt(L, zA + 0.6, 1);
  const zB = Math.min(tipP.zBow, tipS.zBow) - 0.2;
  const tip = slab('deck-fore-tip', tipP.x, tipS.x, zA, zB, y0, y1);
  const strip = slab('deck-starboard', halfW + 0.03, outerS.x, L.cabinAftZ, L.cabinFrontZ, y0, y1);
  return [fore, tip, strip];
}

/**
 * Five fir planks on edge in the larger chinks [§2]. Rest pose is
 * `guaraDefaultDepth` of the way down; the sim raises/lowers a guara by moving
 * the piece along y by up to `shape.travel` (its station socket stays on the
 * log, so the crew's stand does not ride with the plank).
 */
export function buildGuaras(p: RaftParams, L: RaftLayout): PieceDef[] {
  // "1.5 m below raft" is below the LOG AXIS (the waterline): a 2 m plank
  // then shows 0.5 m fully lowered and ~1.1 m at the half-raised rest pose,
  // which is the museum's standing planks [PHOTO-04]. Measured from the log
  // bottoms the top sat UNDER the deck and the guaras were invisible (§B70).
  const bottomLowered = p.logAxisY - p.guaraDepth;
  const lift = p.guaraTravel * (1 - p.guaraDefaultDepth);
  return guaraStations(p).map((g, idx) => {
    const a = L.logs[g.chink];
    const x = a.x + a.r + L.chinks[g.chink] / 2;
    return mkPiece(`guara-${idx + 1}`, 'guara', [x, bottomLowered + p.guaraHeight / 2 + lift, g.z], {
      min: [-p.guaraThickness / 2, -p.guaraHeight / 2, -p.guaraWidth / 2],
      max: [p.guaraThickness / 2, p.guaraHeight / 2, p.guaraWidth / 2],
    }, { shape: { depth: p.guaraDefaultDepth, travel: p.guaraTravel } });
  });
}

/** balsa block across the three projecting stern logs, thole-pins, and the oar [§5] */
export function buildSteering(p: RaftParams, L: RaftLayout): PieceDef[] {
  const s = p.sternBlockSection;
  const blockZ = L.sternZ - p.sternProjection / 2;
  const blockTop = L.logTopY + s;
  const block = mkPiece('stern-block', 'stern-block', [0, L.logTopY + s / 2, blockZ], {
    min: [-p.sternBlockLength / 2, -s / 2, -s / 2],
    max: [p.sternBlockLength / 2, s / 2, s / 2],
  }, {
    shape: {
      pinHeight: p.tholePinHeight,
      pinSpacing: p.tholePinSpacing,
      pinRadius: p.tholePinDiameter / 2,
    },
    sockets: [
      // the helmsman stands on the bare logs just forward of the block
      { id: 'station-tiller', type: 'fixture', position: [0, -s / 2, s / 2 + 0.5] },
      // stern cleats: backstays and the mizzen's sheets/braces belay here
      { id: 'anchor-cleat-stern-port', type: 'rope-anchor', position: [-p.sternBlockLength / 2 + 0.1, s / 2, 0] },
      { id: 'anchor-cleat-stern-starboard', type: 'rope-anchor', position: [p.sternBlockLength / 2 - 0.1, s / 2, 0] },
    ],
  });
  const shaftR = p.oarShaftDiameter / 2;
  const aft = p.oarLength - p.oarInboard;
  const oar = mkPiece('steering-oar', 'steering-oar', [0, blockTop + shaftR + 0.02, blockZ], {
    min: [-p.oarTillerLength / 2, -p.oarBladeWidth / 2, -aft],
    max: [p.oarTillerLength / 2, p.oarBladeWidth / 2, p.oarInboard],
  }, {
    // pivot between the pins; blade dips aft (−z) by oarDip
    rotation: [-p.oarDip, 0, 0],
    shape: {
      inboard: p.oarInboard,
      shaftRadius: shaftR,
      bladeLength: p.oarBladeLength,
      bladeWidth: p.oarBladeWidth,
      tillerLength: p.oarTillerLength,
    },
  });
  return [block, oar];
}
