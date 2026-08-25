/**
 * ShipAssembly — piece graph → three.js scene subtree. Blueprint-agnostic.
 * §V.13: destruction happens ONLY through piece ops here (state swaps,
 * detach). §V.3: callers drive this from SimState; it never writes sim.
 */
import * as THREE from 'three';
import type { DamageStateId, PieceDef, PieceKind, SailStateId, Vec3 } from './pieceTypes';
import { buildHoledVariant, buildPieceGeometry, buildSailGeometry } from './pieceGeometry';
import type { PieceBreach } from './pieceGeometryHoled';
import { destructionParams } from '../params/destruction';
import { createHoleMaterial, createPieceMaterial } from './pieceMaterials';
import { buildDeckHeightfield, type DeckHeightfield } from './deckHeightfield';
import { sailClothPoint, type SailClothState } from './sailShape';
import {
  NEUTRAL_SAIL_WIND_FRAME,
  readSailWindFrame,
  readSailSparSources,
  readSheetLeadSign,
  resolveSailSpars,
  sailPhaseSeed,
  sheetLeadDirections,
  writeSailSparSources,
  type SailSparSource,
  type SailWindFrame,
} from './sailFrame';
import { MAST_TOP_SCALE } from './pieceGeometrySpar';
import { poleTaper } from './pieceGeometryRaft';
import { readSailWindRef, sailDrive } from './sailDynamics';
import { oceanParams } from '../params/ocean';
import { shipMaterialParams } from '../params/ship';
import { createDeckFieldTexture, type DeckFieldSampler } from './deckFieldTexture';


/**
 * ─────────── WHICH SPARS EACH SAIL IS PUSHED OFF (§T.114 / §B.74) ───────────
 *
 * The cloth may not pass through its mast, and §V71 says the mast it is
 * pushed off has to BE the mast in the piece graph — its live transform, its
 * own aabb, and the taper its geometry is actually drawn with. That is what
 * these three helpers assemble; `sailFrame.resolveSailSpars` then re-expresses
 * them in the sail's frame every frame, because bracing swings the yard about
 * the mast and a rest-pose capsule would be wrong the moment the crew trims.
 */

/** every piece a sail could foul: masts, and a bipod's legs. NOT the rope
 *  ladder hanging off one of them — it is `bipod-mast` kind but a flat panel,
 *  and a cylinder round it would hold the canvas half a metre off nothing. */
function isSparPiece(def: PieceDef): boolean {
  if (def.kind !== 'mast' && def.kind !== 'bipod-mast') return false;
  return (def.shape?.ladder ?? 0) <= 0;
}

/** a pole along local +y, radius from its own aabb and its own taper */
function poleSource(def: PieceDef, node: THREE.Object3D): SailSparSource {
  const r = (def.aabb.max[0] - def.aabb.min[0]) / 2;
  const taper = def.kind === 'mast' ? MAST_TOP_SCALE : poleTaper(def.shape ?? {});
  return {
    node,
    a: [0, def.aabb.min[1], 0],
    b: [0, def.aabb.max[1], 0],
    ra: r,
    rb: r * taper,
  };
}

/**
 * A yard lies along local x and is thickest at the SLINGS, tapering to both
 * yardarms — a shape one capsule cannot hold. It takes the slings radius at
 * both ends, which is the conservative read (never thinner than the spar) and
 * costs nothing: measured worst clearance to its own yard is 0.07 m on every
 * ship, so this capsule is a guarantee against future re-tunes, not a fix.
 */
function yardSource(def: PieceDef, node: THREE.Object3D): SailSparSource {
  const r = (def.aabb.max[1] - def.aabb.min[1]) / 2;
  return { node, a: [def.aabb.min[0], 0, 0], b: [def.aabb.max[0], 0, 0], ra: r, rb: r };
}

const vSpineA = new THREE.Vector3();
const vSpineB = new THREE.Vector3();
const vCap = new THREE.Vector3();
const mSail = new THREE.Matrix4();
const lineSpar = new THREE.Line3();

/**
 * The two nearest spars ABAFT this sail, plus its own yard.
 *
 * ABAFT is the load-bearing word. Every yard in every blueprint rides FORWARD
 * of its mast, so the cloth is pushed forward — which means a spar FORWARD of
 * the sail would be pushed INTO rather than out of. The galleon has one three
 * masts ahead of another; without this filter her main course would be shoved
 * 8 m by the foremast. The test asserts the filter holds for all three ships.
 *
 * TWO of them, because the raft's mainsail hangs BETWEEN the legs of a bipod
 * and one capsule leaves the other leg cutting the canvas. On a square-rigger
 * the second slot picks up the next mast along, metres away, and never fires.
 */
function rankSparsForSail(
  sailDef: PieceDef,
  sailNode: THREE.Object3D,
  candidates: Array<{ def: PieceDef; node: THREE.Object3D }>,
): SailSparSource[] {
  sailNode.updateWorldMatrix(true, false);
  mSail.copy(sailNode.matrixWorld).invert();
  const drop = -sailDef.aabb.min[1];
  vSpineA.set(0, 0, 0).applyMatrix4(sailNode.matrixWorld); // head centre
  vSpineB.set(0, -drop, 0).applyMatrix4(sailNode.matrixWorld); // foot centre
  const ranked: Array<{ src: SailSparSource; d: number }> = [];
  for (const c of candidates) {
    const src = poleSource(c.def, c.node);
    c.node.updateWorldMatrix(true, false);
    lineSpar.start.set(src.a[0], src.a[1], src.a[2]).applyMatrix4(c.node.matrixWorld);
    lineSpar.end.set(src.b[0], src.b[1], src.b[2]).applyMatrix4(c.node.matrixWorld);
    let d = Infinity;
    let abaft = false;
    for (const p of [vSpineA, vSpineB]) {
      lineSpar.closestPointToPoint(p, true, vCap);
      d = Math.min(d, vCap.distanceTo(p));
      // the sail's own frame: −z is aft of the canvas, which is where a mast
      // it may be pushed off has to be
      if (vCap.applyMatrix4(mSail).z < 0) abaft = true;
    }
    if (abaft) ranked.push({ src, d });
  }
  // ties broken by nothing but the blueprint's own order, so the slot a spar
  // lands in is deterministic — a slot that swapped would jump the cloth
  ranked.sort((a, b) => a.d - b.d);
  return ranked.slice(0, 2).map((r) => r.src);
}

export type MaterialFactory = (kind: PieceKind, role: 'base' | 'hole') => THREE.Material;

/**
 * The default factory is built PER ASSEMBLY so it can close over that ship's
 * own deck heightfield (deckHeightfield.ts) — the field is a function of the
 * blueprint, so a brigantine and a galleon must not share one. Callers that
 * pass their own factory (tests, greybox previews) never build a field at all.
 */
function makeDefaultMaterialFactory(deckField?: DeckFieldSampler): MaterialFactory {
  return (kind, role) =>
    role === 'hole' ? createHoleMaterial() : createPieceMaterial(kind, deckField);
}

/** scratch vector — socketWorldPosition is called once per rope per frame */
const tmpSocket = new THREE.Vector3();
/** …and its inverse, for `pieceNearestPoint`'s world→local step (§T.157) */
const tmpMatrix = new THREE.Matrix4();

interface PieceRuntime {
  def: PieceDef;
  node: THREE.Group;
  mesh: THREE.Mesh;
  damage: DamageStateId;
  /** trim state of a 'sail' piece; 'full' (and unused) on everything else */
  sail: SailStateId;
  /** §T.63 — every breach this piece is carrying, in the order they landed */
  breaches: PieceBreach[];
}

export class ShipAssembly {
  readonly group: THREE.Group;
  /**
   * This ship's procedural deck heightfield (§T.34 / talk "Surface Water:
   * Setup"), or null when a caller supplied its own material factory and the
   * field was never needed. The deck-water solver reads it for its terrain —
   * see deckHeightfield.ts for the channel contract.
   */
  readonly deckField: DeckHeightfield | null = null;
  /** GPU view of `deckField`, shared with the piece materials */
  readonly deckFieldTexture: DeckFieldSampler | null = null;
  private readonly pieces = new Map<string, PieceRuntime>();
  private readonly socketOwner = new Map<string, string>();
  private readonly materials = new Map<string, THREE.Material>();
  private readonly materialFactory: MaterialFactory;
  /** live yard brace angle (rad), applied to every yard node */
  private rigTrim = 0;
  private helmAngle = 0;
  /** live rudder blade angle (rad) about the stock, applied to the blade node */
  private rudderAngle = 0;
  /** §B100(a) — the raft's steering oar, which is not a rudder */
  private oarAngle = 0;
  /** §B100(b) — drawn guara depths, by piece id */
  private readonly guaraDepths = new Map<string, number>();
  private windFrame: SailWindFrame = NEUTRAL_SAIL_WIND_FRAME;

  constructor(blueprint: PieceDef[], materialFactory?: MaterialFactory) {
    if (materialFactory === undefined) {
      this.deckField = buildDeckHeightfield(blueprint);
      this.deckFieldTexture =
        this.deckField === null ? null : createDeckFieldTexture(this.deckField);
      this.materialFactory = makeDefaultMaterialFactory(this.deckFieldTexture ?? undefined);
    } else {
      this.materialFactory = materialFactory;
    }
    this.group = new THREE.Group();
    this.group.name = 'ship';

    for (const def of blueprint) {
      if (this.pieces.has(def.id)) throw new Error(`duplicate piece id: ${def.id}`);
      const node = new THREE.Group();
      node.name = def.id;
      node.position.fromArray(def.transform.position);
      node.rotation.set(...def.transform.rotation);
      const geometry =
        def.kind === 'sail'
          ? buildSailGeometry('full', def.aabb, def.shape)
          : buildPieceGeometry(def.kind, def.aabb, def.shape);
      const mesh = new THREE.Mesh(geometry, this.material(def.kind, 'base'));
      mesh.name = `${def.id}-mesh`;
      if (def.shape?.sheetLeadAft !== undefined) mesh.userData.sheetLeadAft = def.shape.sheetLeadAft;
      // §B86-2: a per-ship saturating wind, carried on the mesh like the lead
      // sign above so ONE sail material still serves every class (sailFrame.ts)
      if (def.shape?.windRef !== undefined) mesh.userData.sailWindRef = def.shape.windRef;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      node.add(mesh);
      this.pieces.set(def.id, { def, node, mesh, damage: 'intact', sail: 'full', breaches: [] });
      for (const socket of def.sockets) {
        if (this.socketOwner.has(socket.id)) throw new Error(`duplicate socket id: ${socket.id}`);
        this.socketOwner.set(socket.id, def.id);
      }
    }
    // second pass: parent links (yards → mast, sails → yard, …)
    for (const rt of this.pieces.values()) {
      const parentId = rt.def.parent;
      if (parentId === undefined) {
        this.group.add(rt.node);
      } else {
        const parent = this.pieces.get(parentId);
        if (parent === undefined) throw new Error(`unknown parent ${parentId} for ${rt.def.id}`);
        parent.node.add(rt.node);
      }
    }
    /**
     * third pass: WHICH SPARS EACH SAIL MAY NOT PASS THROUGH (§T.114).
     *
     * The CHOICE is topology and is made once, here — a mast does not stop
     * being the sail's mast when the yard braces. The CAPSULES are re-resolved
     * from the live transforms every frame by both evaluators (§V71), which is
     * the half that has to be live: bracing walks the mast right round the
     * sail's own frame.
     */
    this.group.updateMatrixWorld(true);
    const spars = [...this.pieces.values()]
      .filter((rt) => isSparPiece(rt.def))
      .map((rt) => ({ def: rt.def, node: rt.node }));
    for (const rt of this.pieces.values()) {
      if (rt.def.kind !== 'sail') continue;
      const sources = rankSparsForSail(rt.def, rt.node, spars);
      const yard = rt.def.parent === undefined ? undefined : this.pieces.get(rt.def.parent);
      // slot 2 is the sail's own yard; a sail with no yard leaves it empty and
      // the evaluators read that as "no spar" rather than inventing one
      if (yard !== undefined && yard.def.kind === 'yard') {
        // the yard is ALWAYS slot 2, so a sail with only one mast abaft it
        // pads slot 1 with a null capsule (a == b) rather than shifting the
        // yard up — a slot that meant different things on different sails
        // would need a branch in the vertex stage
        while (sources.length < 2) sources.push({ node: rt.node, a: [0, 0, 0], b: [0, 0, 0], ra: 0, rb: 0 });
        sources.push(yardSource(yard.def, yard.node));
      }
      writeSailSparSources(rt.mesh, sources);
    }
  }

  /** §V.14: intact ↔ holed swap, destroyed hides the piece. */
  setDamageState(pieceId: string, stateId: DamageStateId): void {
    const rt = this.piece(pieceId);
    if (!rt.def.damageStates.some((s) => s.id === stateId)) {
      throw new Error(`piece ${pieceId} has no damage state ${stateId}`);
    }
    if (rt.damage === stateId) return;
    if (stateId === 'destroyed') {
      rt.mesh.visible = false;
    } else {
      rt.mesh.visible = true;
      if (stateId === 'intact') rt.breaches.length = 0; // repaired: shell whole again
      this.rebuild(rt, stateId);
    }
    rt.damage = stateId;
  }

  /**
   * §T.63 — record a breach on `pieceId` and re-cut the shell.
   *
   * WHY THIS EXISTS SEPARATELY FROM `setDamageState`. The state swap is
   * exactly-once at the hp threshold, so it could only ever produce ONE hole
   * per section, at an authored station, whatever the player did. A hit is
   * what makes a hole, and every hit makes its own: `breachesPerPiece` is the
   * only thing that stops the list, and it is a look budget, not a rule of
   * the sim — hp, flooding and the holed threshold are untouched by this
   * call.
   *
   * Returns whether the breach was taken, so a caller can tell "recorded" from
   * "at the cap" instead of guessing (§V.62 — a silent no-op here would read
   * exactly like a hit that did not register, which is the bug being fixed).
   */
  addBreach(pieceId: string, breach: PieceBreach): boolean {
    const rt = this.piece(pieceId);
    if (!rt.def.damageStates.some((s) => s.id === 'holed')) return false;
    if (rt.damage === 'destroyed') return false;
    if (!breach.point.every(Number.isFinite) || !Number.isFinite(breach.radius)) return false; // §V.28
    const cap = Math.max(1, Math.floor(destructionParams.breachesPerPiece));
    if (rt.breaches.length >= cap) return false;
    // A second ball into the SAME hole does not make a second hole. Recording
    // it would spend a slot and a rebuild on an aperture the shell geometry
    // then drops anyway (two apertures cannot share cells — see `sideStrip`),
    // which is a silent no-op of exactly the §V.62 shape. Rejecting it here is
    // the same answer, said out loud through the return value.
    const near = rt.breaches.some((b) => {
      const dy = b.point[1] - breach.point[1];
      const dz = b.point[2] - breach.point[2];
      return Math.hypot(dy, dz) < b.radius + breach.radius;
    });
    if (near) return false;
    rt.breaches.push(breach);
    rt.mesh.visible = true;
    // the shell is perforated the moment the first ball goes through it; the
    // hp threshold still owns splinters, flooding and the 'holed' bookkeeping
    this.rebuild(rt, 'holed');
    rt.damage = 'holed';
    return true;
  }

  /** breaches currently cut into a piece (tests/tools; the live list) */
  breachesOf(pieceId: string): readonly PieceBreach[] {
    return this.piece(pieceId).breaches;
  }

  private rebuild(rt: PieceRuntime, stateId: 'intact' | 'holed'): void {
    // outboard face: loft hints know their side; fallback = origin side
    const side = rt.def.shape?.side ?? rt.def.transform.position[0];
    const faceSign: 1 | -1 = side < 0 ? -1 : 1;
    const next =
      stateId === 'holed'
        ? buildHoledVariant(rt.def.kind, rt.def.aabb, faceSign, rt.def.shape, rt.breaches)
        : buildPieceGeometry(rt.def.kind, rt.def.aabb, rt.def.shape);
    rt.mesh.geometry.dispose();
    rt.mesh.geometry = next;
    rt.mesh.material =
      stateId === 'holed'
        ? [this.material(rt.def.kind, 'base'), this.material(rt.def.kind, 'hole')]
        : this.material(rt.def.kind, 'base');
  }

  /** sail trim swap (furled | reefed | full) — sail pieces only */
  setSailState(pieceId: string, stateId: SailStateId): void {
    const rt = this.piece(pieceId);
    if (!rt.def.sailStates?.some((s) => s.id === stateId)) {
      throw new Error(`piece ${pieceId} has no sail state ${stateId}`);
    }
    if (rt.sail === stateId) return; // rebuilds geometry: never do it twice
    rt.mesh.geometry.dispose();
    rt.mesh.geometry = buildSailGeometry(stateId, rt.def.aabb);
    rt.sail = stateId;
  }

  /** current trim state of a sail piece */
  sailState(pieceId: string): SailStateId {
    return this.piece(pieceId).sail;
  }

  /**
   * Continuous cloth-drop scale (0..1) for a sail piece — read per object by
   * the cloth shader, so easing the sheets shortens the canvas smoothly
   * instead of popping between the three discrete states. Stored on the mesh
   * so it stays per-object with one shared material (and survives a
   * detached mast).
   */
  setSailDropScale(pieceId: string, scale: number): void {
    if (!Number.isFinite(scale)) return; // §V28
    this.piece(pieceId).mesh.userData.sailDropScale = scale;
  }

  /**
   * §B86-3 — A YARD COMES DOWN AS ITS SAIL FURLS, if its class authored a
   * travel (`shape.hoistDrop`, metres). A square sail is not furled where it
   * is set: it is lowered on its halyard and lashed along the yard, and the
   * moored replica (docs/raft2100/ref/replica-moored-beam.png) carries its
   * roll a couple of metres over the deck, not up at the crossing. Ours sat
   * at full hoist with the cloth simply gone — "the yard does not lower on
   * furl" (§B86-3).
   *
   * A TRANSFORM, so it belongs here and not in a uniform: `sailDropScale` can
   * shorten cloth but cannot move a spar, and the yard carries the sail, its
   * rope anchors and its own ends with it — every rope re-resolves from the
   * live sockets next frame (§V71), which is exactly what a halyard should do.
   * Classes that author no travel (the galleon) never move: `hoistDrop`
   * absent ⇒ this is a no-op.
   */
  setYardHoist(sailPieceId: string, scale: number): void {
    if (!Number.isFinite(scale)) return; // §V28
    const rt = this.piece(sailPieceId);
    const yard = rt.def.parent === undefined ? undefined : this.pieces.get(rt.def.parent);
    if (yard === undefined || yard.def.kind !== 'yard') return;
    const travel = yard.def.shape?.hoistDrop ?? 0;
    if (!(travel > 0)) return;
    const t = scale < 0 ? 0 : scale > 1 ? 1 : scale;
    yard.node.position.y = yard.def.transform.position[1] - travel * (1 - t);
  }

  /**
   * §T.73 — dye every sail on this ship. A hex RGB multiplier on the cloth
   * colour, read per mesh by the shared sail material (sailDriver.ts
   * `tint`), so a second ship's canvas costs no second material. 0xffffff
   * restores the default canvas.
   */
  setSailTint(hex: number): void {
    if (!Number.isFinite(hex)) return; // §V28
    for (const rt of this.pieces.values()) {
      if (rt.def.kind === 'sail') rt.mesh.userData.sailTint = hex;
    }
  }

  /** every sail piece id, in blueprint order */
  sailPieceIds(): string[] {
    const ids: string[] = [];
    for (const [id, rt] of this.pieces) if (rt.def.kind === 'sail') ids.push(id);
    return ids;
  }

  /**
   * §V13 piece op: swing every yard (and the sail + rope anchors riding it)
   * about the mast. Absolute angle in radians; the caller owns the rate
   * limit. Yards keep their blueprint rotation on the other two axes.
   */
  setRigTrim(angle: number): void {
    if (!Number.isFinite(angle)) return; // §V28: never poison a transform
    if (angle === this.rigTrim) return;
    this.rigTrim = angle;
    for (const rt of this.pieces.values()) {
      if (rt.def.kind !== 'yard') continue;
      rt.node.rotation.y = rt.def.transform.rotation[1] + angle;
    }
  }

  /** current yard brace angle (rad) */
  get braceAngle(): number {
    return this.rigTrim;
  }

  /**
   * Spin the ship's wheel. Same shape as `setRigTrim`: one moving piece kind,
   * one transform, edge-triggered so calling it every frame is free.
   *
   * ABOUT LOCAL +Z, which is the axle — `buildWheelDiscGeometry` lays the rim
   * in XY and centres it on the origin, and the piece is parented to the
   * pedestal at the hub, so this is a pure spin with no lever arm.
   */
  setHelmAngle(angle: number): void {
    if (!Number.isFinite(angle)) return; // §V28: never poison a transform
    if (angle === this.helmAngle) return;
    this.helmAngle = angle;
    for (const rt of this.pieces.values()) {
      if (rt.def.kind !== 'wheel-disc') continue;
      rt.node.rotation.z = rt.def.transform.rotation[2] + angle;
    }
  }

  /** current wheel angle (rad); multiple turns, so NOT wrapped */
  get wheelAngle(): number {
    return this.helmAngle;
  }

  /**
   * PUT THE BLADE OVER — §B92. "The rudder does not seem to move on the big
   * pirate ship, or not enough": it did not move at all. `setHelmAngle` above
   * turned the WHEEL and nothing turned the thing the wheel is geared to, so
   * every hull in the game — galleon, brigantine — steered with a blade frozen
   * amidships while she swung.
   *
   * ABOUT LOCAL +Y, WHICH IS THE STOCK. `blueprintEnds.buildRudder` lays the
   * blade over z ∈ [−chord, 0], i.e. entirely ABAFT its own origin, so the
   * node origin sits on the leading edge — the pintle line a real rudder hangs
   * on. Rotating the node about y is therefore a pure swing about the stock
   * with no lever arm, exactly as `setHelmAngle` is a pure spin about the
   * axle. Rotating about the blade's centre instead would swim it sideways
   * through the transom.
   *
   * Same shape as the other two piece ops: absolute angle, edge-triggered,
   * §V28-guarded, and the caller owns the mapping from `ship.rudder`
   * (`rigTrim.rudderBladeAngle`, which is where the ±35° stop lives).
   */
  setRudderAngle(angle: number): void {
    if (!Number.isFinite(angle)) return; // §V28: never poison a transform
    if (angle === this.rudderAngle) return;
    this.rudderAngle = angle;
    for (const rt of this.pieces.values()) {
      if (rt.def.kind !== 'rudder') continue;
      rt.node.rotation.y = rt.def.transform.rotation[1] + angle;
    }
  }

  /** current rudder blade angle (rad) about the stock */
  get bladeAngle(): number {
    return this.rudderAngle;
  }

  /**
   * §B100(a) — PUT THE OAR OVER. Same defect as §B92, one class further on:
   * `setRudderAngle` filters on `kind === 'rudder'` and the raft's blade is
   * kind `steering-oar`, so the one vessel whose ONLY control surface is that
   * oar steered with it welded amidships. §T.118 flagged the case when §B92
   * was fixed and it was never wired.
   *
   * NOT A RUDDER, AND SO NOT THE SAME CALL. A rudder hangs on a stock at its
   * own origin; this oar is a 5.8 m pole lying LOOSE BETWEEN TWO THOLE-PINS
   * on the stern block [§5 Mount], with its piece origin AT the pins and a
   * rest rotation of `[-oarDip, 0, 0]` that dips the blade abaft them. About
   * local +y that is a pure sweep about the pins — the handle goes one way,
   * the blade the other, which is what a steering oar does — and because
   * three composes Euler 'XYZ' as Rx·Ry, the dip still applies to the swept
   * pole rather than the sweep applying to the dipped one. Rotating about the
   * blade would drag the loom sideways through the helmsman.
   *
   * The caller owns the mapping and the rope stop (`rigTrim.oarSweepAngle`).
   */
  setSteeringOarAngle(angle: number): void {
    if (!Number.isFinite(angle)) return; // §V28: never poison a transform
    if (angle === this.oarAngle) return;
    this.oarAngle = angle;
    for (const rt of this.pieces.values()) {
      if (rt.def.kind !== 'steering-oar') continue;
      rt.node.rotation.y = rt.def.transform.rotation[1] + angle;
    }
  }

  /** current steering-oar sweep (rad) about the thole-pins */
  get oarSweep(): number {
    return this.oarAngle;
  }

  /**
   * §B100(b) — THE CENTREBOARDS RIDE UP AND DOWN. `raftPartsHull.buildGuaras`
   * has said since §T89 that "the sim raises/lowers a guara by moving the piece
   * along y by up to `shape.travel`", and nothing read `shape.travel`: the
   * boards were scenery while `guaraYawMoment` steered the raft with them. A
   * control whose only feedback is the heading changing is the §T.136
   * complaint, and this one had no feedback at all.
   *
   * `depths[k]` drives `guara-{k+1}` — the same index `raftActions.GUARA`
   * publishes, so the station, the debug key and the drawn plank are one
   * channel. 0 = hauled clear, 1 = fully down; the blueprint pose is at the
   * piece's own `shape.depth`, so the offset is `travel × (rest − wanted)`
   * and a re-tune of `guaraDefaultDepth` carries the drawn plank with it.
   */
  setGuaraDepths(depths: readonly number[]): void {
    for (const rt of this.pieces.values()) {
      if (rt.def.kind !== 'guara') continue;
      const k = Number.parseInt(rt.def.id.slice(rt.def.id.lastIndexOf('-') + 1), 10) - 1;
      const raw = depths[k];
      if (typeof raw !== 'number' || !Number.isFinite(raw)) continue; // §V28
      const d = Math.min(1, Math.max(0, raw));
      if (this.guaraDepths.get(rt.def.id) === d) continue; // edge-triggered
      this.guaraDepths.set(rt.def.id, d);
      const travel = rt.def.shape?.travel ?? 0;
      const rest = rt.def.shape?.depth ?? 0;
      rt.node.position.y = rt.def.transform.position[1] + travel * (rest - d);
    }
  }

  /** drawn depth of one guara piece, 0..1; undefined = never driven */
  guaraDepthOf(pieceId: string): number | undefined {
    return this.guaraDepths.get(pieceId);
  }

  /**
   * §T.157 — THE POINT ON A PIECE NEAREST A GIVEN WORLD POINT, live.
   *
   * What a station's plaque, its cue dot and (§T.155) its outline all want is
   * "where IS the thing" — and for a long piece the answer depends on where
   * you are standing: the helmsman wants the oar's TILLER end, not the middle
   * of a 5.8 m shaft; the halyard's plaque wants the leg at deck height, not
   * the masthead 8 m up; the kneeling player wants the radio's FACE, not the
   * middle of the case. Clamping the reference point into the piece's own box
   * answers all three from one rule, with no per-station offsets to drift
   * (§V62), and it is resolved through the LIVE matrix (§V71) so a guara being
   * raised carries its label up with it.
   *
   * Returns null for a piece that does not exist, so a station naming a prop
   * that has not been built yet degrades to its socket rather than anchoring
   * at the origin.
   */
  pieceNearestPoint(pieceId: string, near: Vec3): Vec3 | null {
    const rt = this.pieces.get(pieceId);
    if (rt === undefined) return null;
    if (!near.every((v) => Number.isFinite(v))) return null;
    rt.node.updateWorldMatrix(true, false);
    const local = tmpSocket.set(near[0], near[1], near[2]).applyMatrix4(
      tmpMatrix.copy(rt.node.matrixWorld).invert(),
    );
    const lo = rt.def.aabb.min;
    const hi = rt.def.aabb.max;
    local.set(
      Math.min(hi[0], Math.max(lo[0], local.x)),
      Math.min(hi[1], Math.max(lo[1], local.y)),
      Math.min(hi[2], Math.max(lo[2], local.z)),
    );
    const v = local.applyMatrix4(rt.node.matrixWorld);
    return [v.x, v.y, v.z];
  }

  socketWorldPosition(socketId: string): Vec3 {
    const pieceId = this.socketOwner.get(socketId);
    if (pieceId === undefined) throw new Error(`unknown socket: ${socketId}`);
    const rt = this.piece(pieceId);
    const socket = rt.def.sockets.find((s) => s.id === socketId);
    if (socket === undefined) throw new Error(`unknown socket: ${socketId}`);
    rt.node.updateWorldMatrix(true, false);
    // A CLOTH ANCHOR MOVES. Its `position` is where it sits on the flat panel;
    // the canvas it is sewn to bellies and flutters, so the live station comes
    // from the same shape function the vertex stage runs (sailShape.ts). Using
    // the flat position would leave every sheet and buntline ending in mid-air
    // beside a bellied sail — §V.45's lesson, applied to canvas instead of rope.
    const local =
      socket.cloth === undefined
        ? tmpSocket.fromArray(socket.position)
        : tmpSocket.fromArray(
            sailClothPoint(
              socket.cloth[0],
              socket.cloth[1],
              rt.def.aabb.max[0] - rt.def.aabb.min[0],
              -rt.def.aabb.min[1],
              this.clothState(rt),
              shipMaterialParams,
            ),
          );
    const v = local.applyMatrix4(rt.node.matrixWorld);
    return [v.x, v.y, v.z];
  }

  /**
   * The drive state a sail's cloth is currently shaped by. Mirrors what
   * sailDriver.ts pushes into the per-object uniforms, from the same pure
   * `sailDrive` the shader's values come from, so the CPU-side anchor and the
   * GPU-side vertex agree about where the cloth is.
   *
   * THERE IS NO CLOCK LEFT IN HERE, and that is the point. This used to read
   * `performance.now()` while the shader read three's `time` node, so the two
   * evaluators of one shape ran on two clocks and their flutter phase
   * disagreed by up to ~0.28 m of rope anchor — recorded in §B.30 as
   * §V.45-class and knowingly unfixed. Both phases are now integrated by a
   * single owner and published on the mesh (sailFrame.ts); this side READS
   * them. Same for the wind: hull heading, way through the water and the gust
   * train all arrive in the frame rather than being re-derived here.
   */
  private clothState(rt: PieceRuntime): SailClothState {
    const m = rt.node.matrixWorld.elements;
    const wf = readSailWindFrame(rt.mesh);
    const drive = sailDrive(
      {
        forwardX: m[8],
        forwardZ: m[10],
        shipForwardX: wf.shipForwardX,
        shipForwardZ: wf.shipForwardZ,
        windDirection: oceanParams.windDirection,
        windSpeed: oceanParams.windSpeed,
        shipVelX: wf.shipVelX,
        shipVelZ: wf.shipVelZ,
        yawRate: 0, // the skew term is a transient; anchors need the steady shape
        gustPhase: wf.gustPhase,
        gustPhaseB: wf.gustPhaseB,
        // §B86-2: the SAME per-sail reference the driver pushes into the
        // uniforms — two evaluators, one value (§B.30)
        windRef: readSailWindRef(rt.mesh, shipMaterialParams.sailWindRef),
      },
      shipMaterialParams,
    );
    const trimDrop = rt.mesh.userData.sailDropScale;
    const width = rt.def.aabb.max[0] - rt.def.aabb.min[0];
    const drop = -rt.def.aabb.min[1];
    const phase = rt.mesh.userData.sailFlutterPhase;
    // the SAME pure helper the driver pushes into the uniforms, from the same
    // matrix and the same published heading — so the clew the sheet is tied to
    // and the clew the shader draws are one point (§V.45)
    const leads = sheetLeadDirections(m, wf.shipForwardX, wf.shipForwardZ, shipMaterialParams.sailSheetSpread, readSheetLeadSign(rt.mesh));
    return {
      sheetLeadPort: leads.port,
      sheetLeadStarboard: leads.starboard,
      // the mast and yard this cloth is pushed off, live (§T.114). The ROPES
      // resolve through this function, so a clew that ignored the mast would
      // sit where the shader is not drawing canvas — §V.45's failure again.
      spars: resolveSailSpars(rt.node, readSailSparSources(rt.mesh)),
      ...drive,
      dropScale: typeof trimDrop === 'number' && Number.isFinite(trimDrop) ? trimDrop : 1,
      // the driver owns this; the seed is only what a sail that has not been
      // rendered yet correctly reads, and it is the same seed the driver uses
      flutterPhase:
        typeof phase === 'number' && Number.isFinite(phase)
          ? phase
          : sailPhaseSeed(width, drop),
    };
  }

  /** the mesh a sail piece draws through — rigTrim publishes the wind frame
   *  onto it, sailDriver reads it back per object (sailFrame.ts) */
  sailMesh(pieceId: string): THREE.Mesh {
    return this.piece(pieceId).mesh;
  }

  /** the last wind frame published to this ship's sails, for tests and tools */
  setSailWindFrame(frame: SailWindFrame): void {
    this.windFrame = frame;
  }

  get sailWindFrame(): SailWindFrame {
    return this.windFrame;
  }

  /**
   * §V.14 mast break: remove a piece (with its child pieces — a mast takes
   * its yards/sails) from the ship and hand the subtree to physics.
   */
  detachPiece(pieceId: string): THREE.Object3D {
    const rt = this.piece(pieceId);
    rt.node.removeFromParent();
    return rt.node;
  }

  dispose(): void {
    for (const rt of this.pieces.values()) {
      rt.mesh.geometry.dispose();
    }
    for (const mat of this.materials.values()) mat.dispose();
    this.materials.clear();
  }

  private piece(pieceId: string): PieceRuntime {
    const rt = this.pieces.get(pieceId);
    if (rt === undefined) throw new Error(`unknown piece: ${pieceId}`);
    return rt;
  }

  private material(kind: PieceKind, role: 'base' | 'hole'): THREE.Material {
    const key = `${kind}:${role}`;
    let mat = this.materials.get(key);
    if (mat === undefined) {
      mat = this.materialFactory(kind, role);
      this.materials.set(key, mat);
    }
    return mat;
  }
}
