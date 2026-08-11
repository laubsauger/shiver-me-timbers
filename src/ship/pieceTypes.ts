/**
 * Piece contract for procedural ships.
 * §V.13: ship = piece graph + named sockets; destruction only via piece ops.
 * §V.18: this contract is what future AI-generated meshes must satisfy —
 * plain serializable data only, no three.js types, mesh-agnostic.
 */

export type Vec3 = [number, number, number];

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
  | 'ratlines' // rung ladder across a shroud fan
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
  /** piece-local position */
  position: Vec3;
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
