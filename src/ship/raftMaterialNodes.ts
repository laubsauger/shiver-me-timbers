/**
 * Per-OBJECT inputs for the raft materials (§T90), and the small node helpers
 * the raft families share.
 *
 * WHY PER-OBJECT UNIFORMS AND NOT PER-PIECE MATERIALS. main.ts / ShipAssembly
 * cache piece materials by KIND and share them between ships (§T.40: three's
 * node cache key is built from node INSTANCE ids, so a second structurally
 * identical material is a second pipeline). A raft has nine logs of nine
 * different lengths, three crates that are not the same box, and one sail of
 * three that carries the face — and all of each kind must draw through ONE
 * shader. So everything a fragment needs to know about WHICH piece it is on
 * arrives the way the sails' wind state does (sailDriver.ts): `objectGroup`
 * uniforms filled in `onObjectUpdate`, read straight off the mesh. The
 * MaterialFactory contract is `(kind, role)` and carries no piece def, so the
 * mesh's NAME (`${pieceId}-mesh`, shipAssembly.ts) is the identity the
 * variants key on — a documented CPU function per family, covered by tests.
 *
 * §V23: functional mix()/smoothstep() only.
 */
import * as THREE from 'three/webgpu';
import { float, normalWorldGeometry, objectGroup, positionWorld, smoothstep, uniform } from 'three/tsl';
import { bandLimitedEdge, coordFilter, periodResolved } from './bandLimit';
import { waterLighting } from '../caustics';
import type { LocalFrame } from './woodMaterial';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyNode = any;

export interface RaftPieceUniforms {
  /** piece-local bounds of the mesh being drawn (vec3 uniforms) */
  readonly aabbMin: AnyNode;
  readonly aabbMax: AnyNode;
  /** the piece's origin in the ship frame — where a log sits along the hull */
  readonly origin: AnyNode;
  /** world DOWN expressed in piece-local axes (thatch strands run along it) */
  readonly downLocal: AnyNode;
  /** 0..1 hash of the piece id — seeds per-piece tone */
  readonly seed: AnyNode;
  /** family-specific integer variant, from {@link RaftPieceUniformOptions.variantOf} */
  readonly variant: AnyNode;
}

export interface RaftPieceUniformOptions {
  /** piece id → variant number; default 0 for every piece */
  variantOf?: (pieceId: string, width: number) => number;
}

/** `${pieceId}-mesh` → pieceId (shipAssembly.ts names meshes this way) */
export function pieceIdOfMesh(meshName: string): string {
  return meshName.endsWith('-mesh') ? meshName.slice(0, -'-mesh'.length) : meshName;
}

/** deterministic 0..1 from a string (FNV-1a folded) — §V2, seeded never random */
export function hashPieceId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 8) / 0x01000000;
}

const boxes = new WeakMap<THREE.BufferGeometry, THREE.Box3>();
const quat = new THREE.Quaternion();
const down = new THREE.Vector3();

function boundsOf(geometry: THREE.BufferGeometry): THREE.Box3 {
  let box = boxes.get(geometry);
  if (box === undefined) {
    if (geometry.boundingBox === null) geometry.computeBoundingBox();
    box = geometry.boundingBox ?? new THREE.Box3(new THREE.Vector3(), new THREE.Vector3());
    boxes.set(geometry, box);
  }
  return box;
}

/**
 * Seeded so that a material drawn outside an assembly (headless probe, a
 * renderer swap) still has finite, plausible bounds — fail visible, not NaN.
 */
export function createRaftPieceUniforms(opts: RaftPieceUniformOptions = {}): RaftPieceUniforms {
  const aabbMin = uniform(new THREE.Vector3(-1, -1, -1)).setGroup(objectGroup);
  const aabbMax = uniform(new THREE.Vector3(1, 1, 1)).setGroup(objectGroup);
  const origin = uniform(new THREE.Vector3()).setGroup(objectGroup);
  const downLocal = uniform(new THREE.Vector3(0, -1, 0)).setGroup(objectGroup);
  const seed = uniform(0.5).setGroup(objectGroup);
  const variant = uniform(0).setGroup(objectGroup);
  const variantOf = opts.variantOf ?? ((): number => 0);

  // THE UPDATE HANGS OFF EVERY UNIFORM, NOT JUST `aabbMin` — §B70. Three runs
  // a uniform's onObjectUpdate only if THAT uniform is referenced by the
  // shader. The crate and sail-decal graphs read `seed`/`variant` alone, so
  // with the hook on aabbMin only they were never updated: every crate drew
  // as pine, and the Kon-Tiki face never switched on. A per-frame memo keeps
  // the work at once per object however many of the six are referenced.
  let lastObject: THREE.Object3D | null = null;
  let lastFrame = -1;
  const update = (frame: { object: THREE.Object3D | null; frameId: number }): void => {
    const object = frame.object;
    if (object === null || object === undefined) return;
    if (object === lastObject && frame.frameId === lastFrame) return;
    lastObject = object;
    lastFrame = frame.frameId;
    const mesh = object as THREE.Mesh;
    if (mesh.geometry !== undefined) {
      const box = boundsOf(mesh.geometry);
      aabbMin.value.copy(box.min);
      aabbMax.value.copy(box.max);
    }
    // the mesh sits at the piece node's origin; an unparented piece's node
    // position IS its ship-frame origin (a child piece's is parent-relative,
    // which no current consumer of `origin` is)
    const node = object.parent;
    if (node !== null) origin.value.copy(node.position);
    object.getWorldQuaternion(quat);
    down.set(0, -1, 0).applyQuaternion(quat.invert());
    downLocal.value.copy(down);
    const id = pieceIdOfMesh(object.name);
    seed.value = hashPieceId(id);
    variant.value = variantOf(id, aabbMax.value.x - aabbMin.value.x);
  };
  for (const u of [aabbMin, aabbMax, origin, downLocal, seed, variant]) u.onObjectUpdate(update);

  return { aabbMin, aabbMax, origin, downLocal, seed, variant };
}

/**
 * A RING round (or a band across) a piece at every `pitch` along `along`:
 * 1 away from the ring, → 0 on it. Centred distance in pitch units, so the
 * edge is measured against the ring's OWN width and not the repeat (§V.48,
 * §B.20), and it fades to 1 — the surrounding level, a groove's honest mean
 * (§V.70) — once the ring is sub-pixel.
 *
 * @param along  smooth metres coordinate along the piece
 * @param pitch  metres between rings (uniform)
 * @param width  the ring's width in metres (uniform)
 * @param phase  metres offset of ring 0 (node or number)
 */
export function ringMask(along: AnyNode, pitch: AnyNode, width: AnyNode, phase: AnyNode = float(0)): AnyNode {
  const c = along.sub(phase).div(pitch.max(1e-3));
  const filter = coordFilter(c);
  // @band-limited-elsewhere: bandLimitedEdge below widens and fades it
  const centred = c.fract().sub(0.5).abs(); // 0 at a ring, 0.5 between
  const half = width.div(pitch.max(1e-3)).mul(0.5);
  // distance OUTSIDE the ring's own width, 0 across the whole ring; the edge
  // ramp is the ring's half-width, widened and faded by bandLimitedEdge
  return bandLimitedEdge(centred.sub(half).max(0), c, half, filter);
}

/** a 0.6..0.9 ramp on |n·axis| — which face of a box a fragment is on.
 *  A dot product of the normal: no period, no sub-pixel regime (§V.48). */
export function faceness(component: AnyNode): AnyNode {
  // @band-limited-elsewhere: normal component, not a spatial coordinate
  return smoothstep(float(0.6), float(0.9), component.abs());
}

/** per-cell 0/1 gate from a hash without a `step`: open above `threshold` */
export function gateAbove(hash: AnyNode, threshold: number): AnyNode {
  return hash.sub(threshold).mul(1 / Math.max(1e-3, 1 - threshold)).clamp(0, 1);
}

/** the ship-wide water lighting every raft family composes in (as fittingMaterials) */
export function shipWater(frame: LocalFrame | undefined): ReturnType<typeof waterLighting> {
  return waterLighting({
    worldPos: positionWorld,
    normal: normalWorldGeometry,
    ...(frame === undefined ? {} : { shipLocalPos: frame.localPos }),
    mode: 'both',
  });
}

/** finest-octave gate for a relief term built from fbm (see woodMaterial's grainResolved) */
export function noiseResolved(samplePos: AnyNode, octaves: number): AnyNode {
  const finest = samplePos.mul(2 ** Math.max(0, octaves - 1));
  const gw = finest.dFdx().abs().add(finest.dFdy().abs());
  return periodResolved(float(0), gw.x.max(gw.y).max(gw.z));
}
