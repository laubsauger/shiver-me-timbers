/**
 * Piece contract for procedural ships.
 * §V.13: ship = piece graph + named sockets; destruction only via piece ops.
 * §V.18: this contract is what future AI-generated meshes must satisfy —
 * plain serializable data only, no three.js types, mesh-agnostic.
 */

export type Vec3 = [number, number, number];

/**
 * Metres a lantern post's bracket reaches AFT, and therefore the z of
 * `socket-lantern-*`. ONE constant because the two must agree: the socket is
 * the pendulum pivot (src/lanterns hangs the flame `cordLength` below it) and
 * the arm is the thing the eye reads it as hanging from. They were written as
 * two independent literals once and the lamp hung in mid-air beside a post
 * that reached nowhere near it.
 *
 * The reach is not styling either: the post shaft is 0.05 m in radius and the
 * flame bulb 0.09, so a pivot ON the axis hangs a glowing sphere around the
 * post and lets the post poke through it on every swing.
 */
export const LANTERN_ARM_REACH = 0.26;

export type PieceKind =
  | 'hull-section'
  | 'keel'
  | 'deck'
  | 'bow'
  | 'transom'
  | 'gallery'
  | 'forecastle-deck'
  | 'sterncastle-deck'
  | 'cabin'
  | 'lantern-post'
  | 'mast'
  | 'crow-nest'
  | 'yard'
  | 'sail'
  | 'bowsprit'
  | 'rail'
  | 'cannon'
  | 'wheel'
  | 'capstan'
  | 'grating'
  | 'stairs'
  | 'rudder'
  // --- §T.34 detail pass. Every one is a real piece with its own sockets and
  // damage states (§V13/§V18), NOT decoration welded into a shell: a blown-off
  // hull section must take its gunports and channels with it, and a broken
  // mast must take its ratlines and its pennant.
  | 'pennant' // masthead streamer / ensign — the wind telltale
  | 'figurehead'
  // NOTE: ratlines are NOT a piece. They are rendered by src/ropes from the
  // same solved points buffer as the shrouds they are seized to (§V.45); the
  // ship system emits only the intent — see ratlinePlan.ts.
  | 'gunport' // port frames + lids along a hull section
  | 'channel' // chainplate ironwork + deadeyes + lanyards
  | 'headrail' // beakhead rails, stem → bowsprit
  | 'cathead'
  | 'anchor'
  | 'pin-rail' // belaying pin rack at a mast foot
  | 'binnacle'
  | 'window' // glazed lights (stern gallery)
  | 'moulding'; // decorative sheer batten

/**
 * 'fixture' = named attach point for deck furniture / ornaments
 * (ship's wheel, capstan, lookout stand, figurehead).
 */
export type SocketType = 'rope-anchor' | 'cannon-mount' | 'damage-zone' | 'fixture';

export interface SocketDef {
  id: string;
  type: SocketType;
  /** piece-local position — the FLAT, undisplaced station for cloth anchors */
  position: Vec3;
  /**
   * Present only on anchors sewn to a SAIL: the point's (u, v) in the sail's
   * own cloth parameter space. `position` is where it sits on the flat panel;
   * the live position is that panel point plus the cloth displacement, which
   * ShipAssembly resolves through sailShape.ts. A sail anchor that ignored
   * this would sit on the yard while the canvas bellied away from it.
   */
  cloth?: [number, number];
}

export type DamageStateId = 'intact' | 'holed' | 'destroyed';

export interface DamageStateDef {
  id: DamageStateId;
}

/** sail trim states — visual variants, orthogonal to damage (§V.13) */
export type SailStateId = 'furled' | 'reefed' | 'full';

export interface SailStateDef {
  id: SailStateId;
}

export interface PieceTransform {
  position: Vec3;
  /** euler radians, XYZ order */
  rotation: Vec3;
}

export interface AABB {
  min: Vec3;
  max: Vec3;
}

export interface PieceDef {
  id: string;
  kind: PieceKind;
  /** parent-relative when `parent` is set, else ship-local */
  transform: PieceTransform;
  sockets: SocketDef[];
  damageStates: DamageStateDef[];
  /** piece-local bounds; greybox geometry is sized from this */
  aabb: AABB;
  /**
   * Optional piece-graph parent id (yards ride their mast, sails their
   * yard). A detached piece takes its children with it (§V.14 mast break).
   */
  parent?: string;
  /** present on 'sail' pieces only */
  sailStates?: SailStateDef[];
  /**
   * Optional numeric shaping hints for the geometry builder (hull loft:
   * taper/sheer/tumblehome inputs). Plain serializable numbers — an
   * AI-mesh generator gets the same hints (§V18).
   */
  shape?: Record<string, number>;
}
