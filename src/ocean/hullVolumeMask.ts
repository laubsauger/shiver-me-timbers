/**
 * HULL VOLUME MASK (§T.192 follow-up, USER trailer review: "the water that crosses through the whole boat … make sure
 * it's masked out and can NEVER go through the boat and randomly fly into the camera where the person is sitting").
 *
 * WHY THE DEPTH CAP WAS NOT ENOUGH (speedboat/assets/waterMask.ts). The cap is a depth-only lid over the cockpit well at
 * the sheer plane. It hides ocean fragments BELOW the sheer that lie BEHIND the lid from the lens, and nothing else:
 *  - a crest standing ABOVE the deck (bow stuffed, heeled into a wave, a landing that buries the foredeck) is in FRONT of
 *    the lid, so the ocean plane is drawn straight through the cockpit, the seats and the pilot;
 *  - an eye below the local surface (cockpit insert under a crest) sees the ocean's UNDERSIDE through the whole boat;
 *  - spray is a separate transparent pass: a bow sheet the hull overruns streams aft through the windscreen, the pilot
 *    and the lens, because nothing tests a particle against the hull at all.
 *
 * THE MASK. Each boat is a closed, conservative body-frame VOLUME that moves with its full 6DOF render pose: the render
 * hull's own sections (keel → deep-V bottom → chine → flared topside → sheer), inset by `inset` metres so it never
 * reaches outside the drawn shell (a mask wider than the hull cuts a dry moat at the waterline), plus a COLUMN over the
 * deck up to `columnHeight` above the sheer (the cockpit, the seat, the pilot's head, the cockpit eye). Any ocean
 * fragment — top face or underside, foam included since foam is the ocean's own shading — and any spray fragment inside
 * a volume is dropped: the ocean draws it at opacity 0 (`material.opacityNode`), the spray discards it (`maskNode`); a
 * separate term either way, it never touches the colour graphs.
 *
 * Real green water over the gunwale still exists in the physics; it is drawn by the spray/sheet emitters OUTSIDE the
 * volume, never as the sea plane cutting the cockpit.
 *
 * COST / BUDGET (§V40): ONE uniform array (vec4 × (2·MAX + 3 + STATIONS)), no texture, no sampler. Per fragment: one
 * bounding-sphere test per boat DRAWN (free roam: 1); only a boat whose sphere contains the fragment pays the quaternion rotate and section lookup.
 * The ocean's form keeps its early depth test (see `hullMaskOceanNode`).
 *
 * OPT-IN AT BUILD TIME, the `setActiveBoatLightPool` convention: `setActiveHullMask(mask)` BEFORE `buildSea`. With no
 * active mask no node is added anywhere — the raft and pirate seas and sprays are bit-identical.
 *
 * SLOTS. The boats write their poses from the renderer's own draw of their depth caps (speedboat/assets/waterMask.ts
 * `attachHullMaskSlot`): the caps sit at transparent renderOrder −1, before every consumer (prop bubbles −0.5, ocean 0,
 * spray 0.5), and an upload with no claim since the previous upload clears every slot — so a hidden boat never leaves
 * a hole where it was. More boats than slots: the nearest to the lens win.
 */
import * as THREE from 'three/webgpu';
import { Break, Fn, If, Loop, cameraWorldMatrix, cross, float, int, mix, positionView, positionWorld, uniformArray, vec4 } from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node union (surfaceMaterial.ts convention)
type TslNode = any;

export const HULL_MASK_MAX = 8;
/** stations in the shape table (the SB-12 hull JSON has 29 evenly spaced; any hull is resampled to this) */
export const HULL_MASK_STATIONS = 29;
const SHAPE0 = 2 * HULL_MASK_MAX; // (sternZ, keelEndZ, deckY, columnTop)
const SHAPE1 = SHAPE0 + 1; // (inset, boundR², flareStartAboveChine, tanFlare)
const STATION0 = SHAPE0 + 2;
const COUNT = STATION0 + HULL_MASK_STATIONS; // x = boats claimed (slots 0 … count − 1): the shader loops only over those

/** body-frame hull volume (origin = the boat object's origin = physics CG, +y up, +z bow) */
export interface HullMaskShape {
  /** transom z and the last station's z (the keel's forward end), m */
  sternZ: number;
  keelEndZ: number;
  /** sheer (deck edge) height, m — constant along the hull */
  deckY: number;
  /** how far above the sheer the masked column reaches (cockpit, pilot, eye), m */
  columnHeight: number;
  /** inward margin from the drawn shell, m (horizontal) */
  inset: number;
  /** the topside flare: starts this far above the chine, at this angle (render hull, hero_hull.py `proxy_sheer_half`) */
  flareStartAboveChine: number;
  flareDeg: number;
  /** HULL_MASK_STATIONS × (keelY, chineY, chineHalfBeam), evenly spaced sternZ → keelEndZ */
  stations: ArrayLike<number>;
}

/** the section half-width at body (y, station values), before the inset; −1 below the keel */
function sectionHalf(y: number, keelY: number, chineY: number, chineHalf: number, deckY: number, flareStart: number, tanFlare: number): number {
  if (y < keelY) return -1;
  const yy = Math.min(y, deckY); // the column over the deck keeps the sheer's half-width
  if (yy <= chineY) return (chineHalf * (yy - keelY)) / Math.max(chineY - keelY, 1e-4);
  return chineHalf + Math.max(0, yy - chineY - flareStart) * tanFlare;
}

/** CPU mirror of the shader test: is the BODY-frame point inside the volume? */
export function hullMaskContainsBody(s: Readonly<HullMaskShape>, x: number, y: number, z: number): boolean {
  if (y > s.deckY + s.columnHeight) return false;
  if (z < s.sternZ + s.inset || z > s.keelEndZ) return false;
  const K = HULL_MASK_STATIONS;
  const f = ((z - s.sternZ) / (s.keelEndZ - s.sternZ)) * (K - 1);
  const i0 = Math.min(K - 2, Math.max(0, Math.floor(f)));
  const t = f - i0;
  const st = s.stations;
  const lerp = (c: number): number => st[i0 * 3 + c] * (1 - t) + st[(i0 + 1) * 3 + c] * t;
  const half = sectionHalf(y, lerp(0), lerp(1), lerp(2), s.deckY, s.flareStartAboveChine, Math.tan((s.flareDeg * Math.PI) / 180));
  return Math.abs(x) < half - s.inset;
}

/** world point → body frame of a pose (position + unit quaternion [x, y, z, w]) */
export function worldToBody(pos: ArrayLike<number>, q: ArrayLike<number>, p: ArrayLike<number>): [number, number, number] {
  const vx = p[0] - pos[0];
  const vy = p[1] - pos[1];
  const vz = p[2] - pos[2];
  // rotate by the conjugate: t = 2·(−q.xyz × v); v' = v + w·t + (−q.xyz) × t
  const qx = -q[0];
  const qy = -q[1];
  const qz = -q[2];
  const w = q[3];
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [vx + w * tx + (qy * tz - qz * ty), vy + w * ty + (qz * tx - qx * tz), vz + w * tz + (qx * ty - qy * tx)];
}

/** CPU mirror: is the WORLD point inside the volume of a boat at this pose? */
export function hullMaskContains(s: Readonly<HullMaskShape>, pos: ArrayLike<number>, q: ArrayLike<number>, p: ArrayLike<number>): boolean {
  const b = worldToBody(pos, q, p);
  return hullMaskContainsBody(s, b[0], b[1], b[2]);
}

/** radius of a sphere about the body origin that contains the whole volume (the shader's early reject) */
export function hullMaskBoundRadius(s: Readonly<HullMaskShape>): number {
  let r2 = 0;
  const K = HULL_MASK_STATIONS;
  const top = s.deckY + s.columnHeight;
  const tanF = Math.tan((s.flareDeg * Math.PI) / 180);
  for (let k = 0; k < K; k++) {
    const z = s.sternZ + ((s.keelEndZ - s.sternZ) * k) / (K - 1);
    const keelY = s.stations[k * 3];
    const half = sectionHalf(s.deckY, keelY, s.stations[k * 3 + 1], s.stations[k * 3 + 2], s.deckY, s.flareStartAboveChine, tanF);
    for (const y of [keelY, top]) r2 = Math.max(r2, half * half + y * y + z * z);
  }
  return Math.sqrt(r2) + 0.05;
}

export interface HullMask {
  readonly max: number;
  readonly shape: Readonly<HullMaskShape> | null;
  setShape(shape: HullMaskShape): void;
  /**
   * A boat's pose for render call `renderId` (the renderer's `info.calls`). The first claim of a new call forgets every
   * slot; beyond `max` boats the nearest to the lens keep theirs. Returns the slot, or −1 when this boat lost.
   */
  claim(renderId: number, position: THREE.Vector3, quaternion: THREE.Quaternion, cameraDistance: number): number;
  /** the packed uniform values (slot i: [i] = position + enabled, [MAX + i] = quaternion), for tests */
  readonly data: readonly THREE.Vector4[];
  readonly node: TslNode;
}

export function createHullMask(max = HULL_MASK_MAX): HullMask {
  const n = Math.max(1, Math.min(HULL_MASK_MAX, Math.floor(max)));
  const data = Array.from({ length: COUNT + 1 }, () => new THREE.Vector4());
  const dist = new Float64Array(HULL_MASK_MAX).fill(Infinity);
  let shape: HullMaskShape | null = null;
  let lastCall = -1;
  let count = 0;
  const clear = (): void => {
    for (let i = 0; i < HULL_MASK_MAX; i++) {
      data[i].set(0, 0, 0, 0);
      dist[i] = Infinity;
    }
    count = 0;
    data[COUNT].x = 0;
  };
  let claimedSinceUpload = false;
  const node = uniformArray(data, 'vec4');
  // an upload with no claim since the last one (every boat hidden) must not carry the last poses. NOT keyed on the node
  // frame's renderId: measured in the browser, the ocean's upload does not see the `info.calls` the caps' onBeforeRender
  // see, and an id-keyed clear zeroed every slot on the GPU while the CPU array held the poses.
  const baseUpdate = (node as unknown as { update(frame: unknown): void }).update.bind(node);
  (node as unknown as { update(frame: unknown): void }).update = (frame) => {
    if (!claimedSinceUpload) clear();
    claimedSinceUpload = false;
    baseUpdate(frame);
  };
  return {
    max: n,
    get shape() {
      return shape;
    },
    setShape(s) {
      if (s.stations.length !== HULL_MASK_STATIONS * 3) throw new Error(`hull mask: ${s.stations.length / 3} stations, expected ${HULL_MASK_STATIONS}`);
      shape = s;
      data[SHAPE0].set(s.sternZ, s.keelEndZ, s.deckY, s.deckY + s.columnHeight);
      const r = hullMaskBoundRadius(s);
      data[SHAPE1].set(s.inset, r * r, s.flareStartAboveChine, Math.tan((s.flareDeg * Math.PI) / 180));
      for (let k = 0; k < HULL_MASK_STATIONS; k++) data[STATION0 + k].set(s.stations[k * 3], s.stations[k * 3 + 1], s.stations[k * 3 + 2], 0);
    },
    claim(renderId, position, quaternion, cameraDistance) {
      if (shape === null) return -1;
      if (renderId !== lastCall) {
        clear();
        lastCall = renderId;
      }
      let slot = -1;
      if (count < n) {
        slot = count++;
        data[COUNT].x = count;
      }
      else {
        let far = 0;
        for (let i = 1; i < n; i++) if (dist[i] > dist[far]) far = i;
        if (dist[far] > cameraDistance) slot = far;
      }
      claimedSinceUpload = true;
      if (slot < 0) return -1;
      dist[slot] = cameraDistance;
      data[slot].set(position.x, position.y, position.z, 1);
      data[HULL_MASK_MAX + slot].set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
      return slot;
    },
    data,
    node,
  };
}

let active: HullMask | undefined;
export function setActiveHullMask(m: HullMask | undefined): void {
  active = m;
}
export function activeHullMask(): HullMask | undefined {
  return active;
}

/**
 * true = KEEP the fragment (outside every boat's volume). Assign to `material.maskNode`.
 * @param worldPos the fragment's world position (ocean: `positionWorld`; a sprite: its billboard point in world)
 */
export function hullMaskKeepNode(mask: HullMask, worldPos: TslNode): TslNode {
  const d = mask.node;
  return Fn(() => {
    const inside = float(0).toVar();
    const s0 = d.element(int(SHAPE0));
    const s1 = d.element(int(SHAPE1));
    const n = int(d.element(int(COUNT)).x.clamp(0, HULL_MASK_MAX));
    Loop({ start: int(0), end: n, type: 'int', condition: '<' }, ({ i }: { i: TslNode }) => {
      const P = d.element(i);
      const rel = worldPos.sub(P.xyz).toVar();
      If(P.w.greaterThan(0.5).and(rel.dot(rel).lessThan(s1.y)), () => {
        const Q = d.element(i.add(HULL_MASK_MAX));
        // body frame = conjugate rotation (worldToBody)
        const qv = Q.xyz.negate();
        const t = cross(qv, rel).mul(2);
        const b = rel.add(t.mul(Q.w)).add(cross(qv, t)).toVar();
        const K1 = float(HULL_MASK_STATIONS - 1);
        const f = b.z.sub(s0.x).div(s0.y.sub(s0.x)).clamp(0, 1).mul(K1);
        const i0 = f.floor().min(K1.sub(1)).toVar();
        const tt = f.sub(i0);
        const A: THREE.Node<'vec4'> = d.element(int(i0).add(STATION0));
        const B: THREE.Node<'vec4'> = d.element(int(i0).add(STATION0 + 1));
        const st = mix(A.xyz, B.xyz, tt).toVar(); // keelY, chineY, chineHalf (NOT `A.mix(B, t)`: TSL's method form is mix(t, a, b))
        const yy = b.y.min(s0.z);
        const vHalf = st.z.mul(yy.sub(st.x)).div(st.y.sub(st.x).max(1e-4));
        const flare = st.z.add(yy.sub(st.y).sub(s1.z).max(0).mul(s1.w));
        const half = yy.lessThanEqual(st.y).select(vHalf, flare);
        const within = b.y
          .greaterThanEqual(st.x)
          .and(b.y.lessThanEqual(s0.w))
          .and(b.z.greaterThanEqual(s0.x.add(s1.x)))
          .and(b.z.lessThanEqual(s0.y))
          .and(b.x.abs().lessThan(half.sub(s1.x)));
        If(within, () => {
          inside.assign(1);
          Break();
        });
      });
    });
    return inside.lessThan(0.5);
  })();
}

/**
 * The ocean's mask, as OPACITY (1 outside every hull, 0 inside): its fragment is the displaced surface point,
 * `positionWorld`, top face and underside alike. The ocean is a transparent, normally-blended, depth-writing mesh, so an
 * alpha-0 fragment leaves the boat's interior (opaque, drawn first) untouched on screen.
 *
 * WHY NOT `maskNode` (a discard) like the spray: any discard in the ocean's pipeline turns its depth test late for EVERY
 * fragment, and the ocean's is the heaviest fragment shader in the project. Measured (headless, M-series, loop stopped,
 * render → onSubmittedWorkDone, 4×40 frames): chase 15.1 → 17.1 ms, cockpit 21.0 → 23.8 ms with the discard; the spray
 * discard +0.2 ms. The alpha form keeps early-Z; its price is that the invisible sheet still writes depth inside the
 * column, so a transparent surface drawn after the ocean behind it there (a windscreen under green water, spray) is
 * hidden too — only while the sea stands above the deck.
 */
export function hullMaskOceanNode(mask: HullMask): TslNode {
  return hullMaskKeepNode(mask, positionWorld).select(float(1), float(0));
}

/** a sprite's mask: its fragment is the billboard point, built in VIEW space (SpriteNodeMaterial), taken back to world */
export function hullMaskSpriteNode(mask: HullMask): TslNode {
  return hullMaskKeepNode(mask, cameraWorldMatrix.mul(vec4(positionView, 1)).xyz);
}
