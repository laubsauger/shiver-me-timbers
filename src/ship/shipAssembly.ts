/**
 * ShipAssembly — piece graph → three.js scene subtree. Blueprint-agnostic.
 * §V.13: destruction happens ONLY through piece ops here (state swaps,
 * detach). §V.3: callers drive this from SimState; it never writes sim.
 */
import * as THREE from 'three';
import type { DamageStateId, PieceDef, PieceKind, SailStateId, Vec3 } from './pieceTypes';
import { buildHoledVariant, buildPieceGeometry, buildSailGeometry } from './pieceGeometry';
import { createHoleMaterial, createPieceMaterial } from './pieceMaterials';

export type MaterialFactory = (kind: PieceKind, role: 'base' | 'hole') => THREE.Material;

const defaultMaterialFactory: MaterialFactory = (kind, role) =>
  role === 'hole' ? createHoleMaterial() : createPieceMaterial(kind);

interface PieceRuntime {
  def: PieceDef;
  node: THREE.Group;
  mesh: THREE.Mesh;
  damage: DamageStateId;
}

export class ShipAssembly {
  readonly group: THREE.Group;
  private readonly pieces = new Map<string, PieceRuntime>();
  private readonly socketOwner = new Map<string, string>();
  private readonly materials = new Map<string, THREE.Material>();
  private readonly materialFactory: MaterialFactory;

  constructor(blueprint: PieceDef[], materialFactory: MaterialFactory = defaultMaterialFactory) {
    this.materialFactory = materialFactory;
    this.group = new THREE.Group();
    this.group.name = 'ship';

    for (const def of blueprint) {
      if (this.pieces.has(def.id)) throw new Error(`duplicate piece id: ${def.id}`);
      const node = new THREE.Group();
      node.name = def.id;
      node.position.fromArray(def.transform.position);
      node.rotation.set(...def.transform.rotation);
      const geometry =
        def.kind === 'sail' ? buildSailGeometry('full', def.aabb) : buildPieceGeometry(def.kind, def.aabb);
      const mesh = new THREE.Mesh(geometry, this.material(def.kind, 'base'));
      mesh.name = `${def.id}-mesh`;
      node.add(mesh);
      this.pieces.set(def.id, { def, node, mesh, damage: 'intact' });
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
      const faceSign: 1 | -1 = rt.def.transform.position[0] < 0 ? -1 : 1;
      const next =
        stateId === 'holed'
          ? buildHoledVariant(rt.def.kind, rt.def.aabb, faceSign)
          : buildPieceGeometry(rt.def.kind, rt.def.aabb);
      rt.mesh.geometry.dispose();
      rt.mesh.geometry = next;
      rt.mesh.material =
        stateId === 'holed'
          ? [this.material(rt.def.kind, 'base'), this.material(rt.def.kind, 'hole')]
          : this.material(rt.def.kind, 'base');
    }
    rt.damage = stateId;
  }

  /** sail trim swap (furled | reefed | full) — sail pieces only */
  setSailState(pieceId: string, stateId: SailStateId): void {
    const rt = this.piece(pieceId);
    if (!rt.def.sailStates?.some((s) => s.id === stateId)) {
      throw new Error(`piece ${pieceId} has no sail state ${stateId}`);
    }
    rt.mesh.geometry.dispose();
    rt.mesh.geometry = buildSailGeometry(stateId, rt.def.aabb);
  }

  socketWorldPosition(socketId: string): Vec3 {
    const pieceId = this.socketOwner.get(socketId);
    if (pieceId === undefined) throw new Error(`unknown socket: ${socketId}`);
    const rt = this.piece(pieceId);
    const socket = rt.def.sockets.find((s) => s.id === socketId);
    if (socket === undefined) throw new Error(`unknown socket: ${socketId}`);
    rt.node.updateWorldMatrix(true, false);
    const v = new THREE.Vector3().fromArray(socket.position).applyMatrix4(rt.node.matrixWorld);
    return [v.x, v.y, v.z];
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
