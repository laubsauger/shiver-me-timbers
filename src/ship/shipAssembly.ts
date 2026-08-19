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
  sailPhaseSeed,
  sheetLeadDirections,
  type SailWindFrame,
} from './sailFrame';
import { sailDrive } from './sailDynamics';
import { oceanParams } from '../params/ocean';
import { shipMaterialParams } from '../params/ship';
import { createDeckFieldTexture, type DeckFieldSampler } from './deckFieldTexture';

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
          ? buildSailGeometry('full', def.aabb)
          : buildPieceGeometry(def.kind, def.aabb, def.shape);
      const mesh = new THREE.Mesh(geometry, this.material(def.kind, 'base'));
      mesh.name = `${def.id}-mesh`;
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
    const leads = sheetLeadDirections(m, wf.shipForwardX, wf.shipForwardZ, shipMaterialParams.sailSheetSpread);
    return {
      sheetLeadPort: leads.port,
      sheetLeadStarboard: leads.starboard,
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
