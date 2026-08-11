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
  | 'rudder';

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
}
