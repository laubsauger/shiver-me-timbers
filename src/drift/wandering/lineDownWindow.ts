/**
 * THE RAFT THROUGH THE WINDOW (`?linedown=day`, lineDown.ts): the raft's mast, yard, cabin and stores — everything of
 * it above the water — drawn INTO Snell's window, where the sea's underside shows the sky. The look-dev's window showed
 * the sky and nothing else (the underside refracts `skyDomeColor` along the refracted ray: ocean/surfaceMaterial.ts),
 * so from below only the logs read, never the rig (the 2026-11-02 brief: "today only the logs read, not the sail and
 * mast").
 *
 * HOW, CHEAPLY. The underside asks the sky for the radiance along `airDir`, the view ray refracted up through the LIVE
 * wave normal at that fragment of the surface. Here that question is answered first by the raft: the ray from the
 * fragment's own point on the surface (`positionWorld`) along `airDir` is tested against a handful of boxes — one per
 * piece of the raft above the waterline (each piece's own bounding box in its own frame: a leg of the bipod mast is a
 * long thin box along the leg, the yard one along the yard, the cabin its box), refreshed every frame from the raft's
 * live pose — and where it meets one, that piece's light is returned instead of the sky's: its face lit by the Sun
 * and the sky as wood is (no shadows, no texture: at the window's rim, 20 m off, the whole rig is a few degrees of the
 * dome). Everything the underside does with the sky then happens to the raft too: the n² gain, the window's edge,
 * the wobble of the live normal (near the rim, where the raft stands, a millimetre of slope swings the image by
 * degrees — the shattered, dancing picture of a boat seen from under water), the water on the way down.
 *
 * WHY NOT THE REAL RAFT IN A CUBE (the alternative the brief named: "the real raft rendered into the window's sky
 * lookup"): a cube drawn from one point sees the raft from that point, and the window's fragments refract from points
 * up to ~9 m apart on the surface (depth·tan 48.6°) — at 20 m that is a parallax of ~25° across the window, the rig
 * smeared or doubled; plus six more renders of the raft a frame. The boxes are traced from each fragment's own point,
 * so their parallax is exact, for a few dozen box tests in the window's fragments only. The cost of the boxes: the
 * rig's shape is blocky at close range — fine at the window's rim, wrong if the eye ever came up right under the raft.
 *
 * Off (`on` 0) it is the sky, untouched: the hook only exists with `?linedown=day` (main-drift.ts), and even then it
 * answers only while the eye is under the water — above it, the same function is the reflected sky of the sea's top.
 */
import * as THREE from 'three/webgpu';
import { Fn, If, Loop, float, int, max, min, positionWorld, uniform, uniformArray, vec3, vec4 } from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node unions
type Node = any;

/** LOOK-DEV ONLY, `&ldwin`: the traced pieces drawn bright red, to see where the trace puts them. (Its frames reached
 * the user's dashboard on 2026-11-02 and were taken for an artifact — "something red next to / behind the raft": a
 * debug render's folder is named as one, out/drift/review/linedown_build_r6_DEBUG_red_trace.) Off unless asked */
export const WINDOW_DEBUG = typeof location !== 'undefined' && new URLSearchParams(location.search).has('ldwin');
/** the most pieces traced (the largest above the water first) */
const BOXES = 40;
/** m: a piece counts if it reaches this far over the raft's waterline and is at least `least` long */
const ABOVE = 0.15;
const LEAST = 0.35;
/** what is not a solid piece: the rig's ropes (one mesh spanning the whole rig: its box would hide it all), the
 * cabin frame's hemp, the halyards, the lanterns' glass and flames */
const NOT_SOLID = /rig-lines|hemp|halyard|lantern|flame|glass/i;
/** the pieces' albedo: weathered balsa, bamboo, the furled cloth (~0.3 against the sky) */
const ALBEDO: [number, number, number] = [0.32, 0.27, 0.21];
/** the share of the open light its faces seen from below get (see the trace's shading) */
const SHADE = 0.3;

export interface WindowRaft {
  /** the sea's window sky (createSea's `windowSky`): the raft's pieces in front of `sky` along `dir` */
  sky(dir: Node, sky: Node): Node;
  /**
   * per frame: the raft's group (its pieces, posed for this frame; null: none), whether the eye is under the water,
   * the Sun (unit, toward it), its irradiance and the sky's on a surface facing them (linear)
   */
  update(raft: THREE.Object3D | null, on: boolean, sun: THREE.Vector3, sunE: THREE.Vector3, skyE: THREE.Vector3): void;
  /** how many pieces the trace holds this frame */
  readonly boxes: number;
}

/**
 * The world → unit-box map of a piece (its geometry's own bounding box `box`, posed by `world`), as the three rows the
 * trace reads: box coordinate k = row k · (x, y, z, 1), the piece filling [−½, ½]³ (a flat piece kept 2 cm thick)
 */
export function boxRows(world: THREE.Matrix4, box: THREE.Box3, out: [THREE.Vector4, THREE.Vector4, THREE.Vector4]): void {
  const centre = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const m = world
    .clone()
    .multiply(new THREE.Matrix4().makeTranslation(centre.x, centre.y, centre.z))
    .multiply(new THREE.Matrix4().makeScale(Math.max(size.x, 0.02), Math.max(size.y, 0.02), Math.max(size.z, 0.02)))
    .invert();
  const e = m.elements;
  // (column-major: row k is elements k, k+4, k+8, k+12)
  out[0].set(e[0], e[4], e[8], e[12]);
  out[1].set(e[1], e[5], e[9], e[13]);
  out[2].set(e[2], e[6], e[10], e[14]);
}

export function createWindowRaft(): WindowRaft {
  // three rows per box: the world → unit-box affine map (box coordinate k = row k · (x, y, z, 1)), the box [−½, ½]³
  const rows = Array.from({ length: BOXES * 3 }, () => new THREE.Vector4());
  const uRows = uniformArray(rows, 'vec4');
  const uCount = uniform(0);
  const uOn = uniform(0);
  const uSun = uniform(new THREE.Vector3(0, 1, 0));
  const uSunE = uniform(new THREE.Vector3());
  const uSkyE = uniform(new THREE.Vector3());

  const sky = (dir: Node, behind: Node): Node =>
    Fn(() => {
      const out = vec3(behind).toVar();
      If(uOn.greaterThan(0.5), () => {
        const o = positionWorld;
        const best = float(1e6).toVar();
        const nrm = vec3(0, 1, 0).toVar();
        Loop({ start: int(0), end: int(uCount), type: 'int', condition: '<' }, ({ i }: { i: Node }) => {
          const r0: Node = uRows.element(i.mul(3));
          const r1: Node = uRows.element(i.mul(3).add(1));
          const r2: Node = uRows.element(i.mul(3).add(2));
          const p = vec3(r0.dot(vec4(o, 1)), r1.dot(vec4(o, 1)), r2.dot(vec4(o, 1)));
          const d = vec3(r0.xyz.dot(dir), r1.xyz.dot(dir), r2.xyz.dot(dir));
          // (a direction component of 0 is a slab the ray never leaves: a huge inverse keeps the test right)
          const safe = (x: Node): Node => x.abs().max(1e-7).mul(x.greaterThanEqual(0).select(float(1), float(-1)));
          const inv = vec3(float(1).div(safe(d.x)), float(1).div(safe(d.y)), float(1).div(safe(d.z)));
          const ta = vec3(-0.5).sub(p).mul(inv);
          const tb = vec3(0.5).sub(p).mul(inv);
          const lo = min(ta, tb);
          const hi = max(ta, tb);
          const tn = max(max(lo.x, lo.y), lo.z);
          const tf = min(min(hi.x, hi.y), hi.z);
          If(tf.greaterThan(tn.max(0)).and(tn.greaterThan(0)).and(tn.lessThan(best)), () => {
            best.assign(tn);
            // the face it enters by: the slab whose entry is the last (its plane's normal is that row's gradient),
            // turned to face the ray
            const g: Node = lo.x.greaterThanEqual(tn).select(r0.xyz, lo.y.greaterThanEqual(tn).select(r1.xyz, r2.xyz));
            const n = g.normalize();
            nrm.assign(n.dot(dir).greaterThan(0).select(n.negate(), n));
          });
        });
        If(best.lessThan(1e5), () => {
          // wood in the open: the Sun on the face it turns to it, the sky from above more than from the sea below —
          // SEEN FROM BELOW AGAINST THE SKY, a silhouette: lit at the full light (the first build's), the rig came out
          // as bright as the sky round it and could not be found (the r6 stills had to paint it red, `&ldwin`, to show
          // it was there: a band above the logs at 327 s, shattered by the waves at 330 s). The faces the eye sees
          // from down here are the raft's undersides and its shaded side (the Sun is ahead-left, behind the rig):
          // `SHADE` of the light, a dark rig against the window with a hint of its lit edges
          const lit = uSunE.mul(nrm.dot(uSun).max(0)).add(uSkyE.mul(nrm.y.mul(0.35).add(0.5))).mul(SHADE);
          out.assign(WINDOW_DEBUG ? vec3(4, 0, 0) : lit.mul(vec3(...ALBEDO)).div(Math.PI));
        });
      });
      return out;
    })();

  const size = new THREE.Vector3();
  const m = new THREE.Matrix4();
  const raftInv = new THREE.Matrix4();
  const local = new THREE.Box3();
  const picked: Array<{ mesh: THREE.Mesh; len: number }> = [];
  let boxes = 0;
  return {
    sky,
    get boxes() {
      return boxes;
    },
    update(raft, on, sun, sunE, skyE) {
      uOn.value = on && raft ? 1 : 0;
      uSun.value.copy(sun);
      uSunE.value.copy(sunE);
      uSkyE.value.copy(skyE);
      if (!on || !raft) return;
      raft.updateMatrixWorld(true);
      raftInv.copy(raft.matrixWorld).invert();
      // the pieces above the waterline, largest first (the raft's own frame: its logs' axis is y 0, raft.ts)
      picked.length = 0;
      raft.traverse((x) => {
        const mesh = x as THREE.Mesh;
        if (!mesh.isMesh || (mesh as unknown as THREE.InstancedMesh).isInstancedMesh || !mesh.visible || NOT_SOLID.test(mesh.name)) return;
        const g = mesh.geometry;
        if (!g.boundingBox) g.computeBoundingBox();
        local.copy(g.boundingBox!).applyMatrix4(m.multiplyMatrices(raftInv, mesh.matrixWorld));
        if (local.max.y < ABOVE) return;
        g.boundingBox!.getSize(size);
        const len = Math.max(size.x, size.y, size.z) * mesh.matrixWorld.getMaxScaleOnAxis();
        if (len < LEAST) return;
        picked.push({ mesh, len });
      });
      picked.sort((a, b) => b.len - a.len);
      const n = Math.min(BOXES, picked.length);
      for (let i = 0; i < n; i++) boxRows(picked[i].mesh.matrixWorld, picked[i].mesh.geometry.boundingBox!, [rows[i * 3], rows[i * 3 + 1], rows[i * 3 + 2]]);
      uCount.value = n;
      boxes = n;
    },
  };
}
