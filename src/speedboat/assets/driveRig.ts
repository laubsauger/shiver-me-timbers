/**
 * DRIVE ANIMATION (§T.192, USER: "the engines should move when steering, right? and the propeller rotating, or at least
 * faking it. right now all of that is static").
 *
 * The GLB keeps every node transform identity (asset contract: shading reads positionLocal as the body frame), so the
 * pivots ride as extras in the body frame (scripts/blender/parts/outboard.py, prop.py, build_parts.py) and the runtime
 * re-pivots the INSTANCE's cloned nodes:
 *   LOD0  `Outboard_<id>`  steer about `steerPivot`/`steerAxis` (the swivel tube), then trim about `trimPivot`/`trimAxis`
 *                         (the tilt tube, which carries the swivel): M = Trim · Steer
 *         `Prop_<id>`      M = M(follows) · spin about `pivot`/`axis`, sign `handed`
 *   LOD1  `Drive_<id>`     outboard + prop of one engine, the same M as its outboard (spin is not visible at LOD1 range)
 *         `Drives`         legacy merged node (pre-§T.192 GLBs): its single centre pivot
 *   LOD2  merged into `Parts`: static (≥ 96 m, a 30° steer is ~4 px)
 *
 * STROBING. A 4-blade prop at 3000 rpm turns 300° per 60 fps frame — the eye reads it as crawling backwards. The drawn
 * blades never turn more than `PROP_MAX_STEP_RAD` per frame, and a blur disc (a translucent annulus the size of the
 * blades) fades in over `PROP_BLUR_RPM`; past the top of that ramp the blade mesh hides and only the disc remains.
 * Render-side only (§V3): nothing here feeds the sim.
 */
import * as THREE from 'three/webgpu';
import { float, length, objectGroup, positionLocal, smoothstep, uniform, vec3 } from 'three/tsl';

export interface DriveState {
  /** drive steer angle, rad: + turns the thrust line from body +z toward +x (deepV12.hull.json lowerUnit), = HullWater's */
  steerRad: number;
  /** drive trim, rad: + trims out (lower unit aft and up, bow up) */
  trimRad: number;
  /** prop rpm per drive, ordered by the drive's body x ascending (S, C, P on the SB-12 = `hull.drives` order) */
  propRpm: readonly number[];
}

export interface DriveRig {
  set(state: Readonly<DriveState>, dt: number): void;
  /** per prop, body x ascending: the drawn blur amount 0..1 (tests, HUD debug) */
  readonly blur: readonly number[];
}

/** blur disc fades in over this rpm range; blades hide at its top */
export const PROP_BLUR_RPM: readonly [number, number] = [600, 1500];
/** largest drawn blade turn per frame (≈ 34°: well under half the 90° blade spacing, so it never reads backwards) */
export const PROP_MAX_STEP_RAD = 0.6;
/** past this blur the blade mesh hides (the disc alone reads as a spinning prop) */
const HIDE_BLADES_AT = 0.98;

const NODE = /^(Outboard|Prop|Drive)_([A-Z]+)_LOD(\d+)$/;

type V3 = [number, number, number];
const isV3 = (v: unknown): v is V3 => Array.isArray(v) && v.length === 3 && v.every((c) => typeof c === 'number' && Number.isFinite(c));
const finite = (v: number, fallback = 0): number => (Number.isFinite(v) ? v : fallback);

interface DriveNode {
  object: THREE.Object3D;
  x: number;
  steerPivot: THREE.Vector3;
  steerAxis: THREE.Vector3;
  trimPivot: THREE.Vector3;
  trimAxis: THREE.Vector3;
  matrix: THREE.Matrix4;
}

interface PropNode {
  object: THREE.Object3D;
  x: number;
  pivot: THREE.Vector3;
  axis: THREE.Vector3;
  handed: number;
  follows: DriveNode | null;
  phase: number;
  disc: THREE.Mesh | null;
  discCentre: THREE.Vector3;
}

const _a = new THREE.Matrix4();
const _b = new THREE.Matrix4();
const _q = new THREE.Quaternion();

/** T(p) · R(axis, angle) · T(−p), written into `out` */
function rotateAbout(out: THREE.Matrix4, pivot: THREE.Vector3, axis: THREE.Vector3, angle: number): THREE.Matrix4 {
  out.makeRotationFromQuaternion(_q.setFromAxisAngle(axis, angle));
  const e = out.elements;
  // translation = p − R·p
  const px = pivot.x, py = pivot.y, pz = pivot.z;
  e[12] = px - (e[0] * px + e[4] * py + e[8] * pz);
  e[13] = py - (e[1] * px + e[5] * py + e[9] * pz);
  e[14] = pz - (e[2] * px + e[6] * py + e[10] * pz);
  return out;
}

/** the prop's blade radius and the blades' mid-plane along the axis, from its own vertices (body frame) */
function propDiscOf(object: THREE.Object3D, pivot: THREE.Vector3, axis: THREE.Vector3): { radius: number; centre: THREE.Vector3 } {
  let radius = 0;
  const pts: { r: number; t: number }[] = [];
  const v = new THREE.Vector3();
  object.traverse((o) => {
    const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    const pos = g?.getAttribute('position');
    if (!pos) return;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).sub(pivot);
      const t = v.dot(axis);
      const r = Math.sqrt(Math.max(0, v.lengthSq() - t * t));
      radius = Math.max(radius, r);
      pts.push({ r, t });
    }
  });
  const outer = pts.filter((p) => p.r > 0.6 * radius);
  const t = outer.length ? outer.reduce((s, p) => s + p.t, 0) / outer.length : 0;
  return { radius, centre: pivot.clone().addScaledVector(axis, t) };
}

/** one blur material per asset: dark cast steel, coverage from the per-object `userData.propBlur` */
export function createPropBlurMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.name = 'PropBlur';
  m.transparent = true;
  m.depthWrite = false;
  m.side = THREE.DoubleSide;
  const blur = uniform(0).setGroup(objectGroup);
  const hubR = uniform(0.05).setGroup(objectGroup);
  const tipR = uniform(0.2).setGroup(objectGroup);
  // §V28: every caller-fed value finite-guarded before it reaches the GPU
  const num = (v: unknown, lo: number, hi: number, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
  blur.onObjectUpdate(({ object }) => {
    const ud = (object as THREE.Object3D | null)?.userData ?? {};
    blur.value = num(ud.propBlur, 0, 1, 0);
    hubR.value = num(ud.propHubR, 0, 1, 0.05);
    tipR.value = num(ud.propTipR, 0.01, 2, 0.2);
  });
  // radial coverage of a 4-blade cleaver: dense at the root, thinning to the tip, soft at both edges (smooth, no
  // periodic term to alias: §V48)
  const r = length(positionLocal.xy);
  const root = smoothstep(hubR, hubR.add(0.015), r);
  const tip = smoothstep(tipR, tipR.mul(0.82), r);
  const density = float(0.62).sub(r.sub(hubR).div(tipR.sub(hubR).max(1e-3)).mul(0.22));
  m.colorNode = vec3(0.1, 0.105, 0.11);
  m.opacityNode = blur.mul(root).mul(tip).mul(density).clamp(0, 1);
  m.fog = false;
  return m;
}

export function createDriveRig(levels: readonly THREE.Object3D[], blurMaterial: THREE.Material | null = null): DriveRig {
  const drives = new Map<string, DriveNode>(); // key `${level}:${id}` (and `${level}:*` for legacy Drives)
  const props: PropNode[] = [];
  levels.forEach((levelObject, level) => {
    const found: THREE.Object3D[] = [];
    levelObject.traverse((o) => {
      if (NODE.test(o.name) || /^Drives_LOD\d+$/.test(o.name)) found.push(o);
    });
    for (const o of found) {
      const ex = o.userData as Record<string, unknown>;
      const m = NODE.exec(o.name);
      const kind = m ? m[1] : 'Drives';
      if (kind === 'Outboard' || kind === 'Drive' || kind === 'Drives') {
        if (!isV3(ex.steerPivot) || !isV3(ex.steerAxis) || !isV3(ex.trimPivot) || !isV3(ex.trimAxis)) {
          throw new Error(`speedboat asset: '${o.name}' has no steer/trim pivots in extras (rebuild the GLB)`);
        }
        const d: DriveNode = {
          object: o,
          x: ex.steerPivot[0],
          steerPivot: new THREE.Vector3(...ex.steerPivot),
          steerAxis: new THREE.Vector3(...ex.steerAxis).normalize(),
          trimPivot: new THREE.Vector3(...ex.trimPivot),
          trimAxis: new THREE.Vector3(...ex.trimAxis).normalize(),
          matrix: new THREE.Matrix4(),
        };
        o.matrixAutoUpdate = false;
        drives.set(`${level}:${m ? m[2] : '*'}`, d);
      }
    }
    for (const o of found) {
      const m = NODE.exec(o.name);
      if (!m || m[1] !== 'Prop') continue;
      const ex = o.userData as Record<string, unknown>;
      if (!isV3(ex.pivot) || !isV3(ex.axis)) throw new Error(`speedboat asset: '${o.name}' has no spin pivot/axis in extras`);
      const pivot = new THREE.Vector3(...ex.pivot);
      const axis = new THREE.Vector3(...ex.axis).normalize();
      const followsId = typeof ex.follows === 'string' ? /_([A-Z]+)$/.exec(ex.follows)?.[1] : undefined;
      const p: PropNode = {
        object: o,
        x: pivot.x,
        pivot,
        axis,
        handed: ex.handed === -1 ? -1 : 1,
        follows: followsId ? (drives.get(`${level}:${followsId}`) ?? null) : null,
        phase: 0,
        disc: null,
        discCentre: pivot.clone(),
      };
      o.matrixAutoUpdate = false;
      if (blurMaterial && o.parent) {
        const { radius, centre } = propDiscOf(o, pivot, axis);
        const disc = new THREE.Mesh(new THREE.RingGeometry(0.02, Math.max(radius, 0.05), 48, 1), blurMaterial);
        disc.name = `PropBlur_${m[2]}_LOD${m[3]}`;
        disc.userData = { propBlur: 0, propHubR: 0.045, propTipR: Math.max(radius, 0.05) };
        disc.castShadow = false;
        disc.receiveShadow = false;
        disc.visible = false;
        disc.matrixAutoUpdate = false;
        o.parent.add(disc);
        p.disc = disc;
        p.discCentre = centre;
      }
      props.push(p);
    }
  });
  props.sort((a, b) => a.x - b.x);
  // prop index by body x: one slot per distinct engine x (LOD levels share it)
  const xs = [...new Set(props.map((p) => Math.round(p.x * 1000)))].sort((a, b) => a - b);
  const blur: number[] = xs.map(() => 0);
  const discBase = new THREE.Matrix4();
  const axisZ = new THREE.Vector3(0, 0, 1);

  return {
    blur,
    set(state, dt) {
      const steer = finite(state.steerRad);
      const trim = finite(state.trimRad);
      const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;
      for (const d of drives.values()) {
        rotateAbout(_a, d.trimPivot, d.trimAxis, trim);
        rotateAbout(_b, d.steerPivot, d.steerAxis, steer);
        d.matrix.multiplyMatrices(_a, _b);
        d.object.matrix.copy(d.matrix);
        d.object.matrixWorldNeedsUpdate = true;
      }
      for (let k = 0; k < xs.length; k++) {
        const rpm = Math.max(0, finite(state.propRpm[k] ?? 0));
        blur[k] = THREE.MathUtils.smoothstep(rpm, PROP_BLUR_RPM[0], PROP_BLUR_RPM[1]);
      }
      for (const p of props) {
        const k = xs.indexOf(Math.round(p.x * 1000));
        const rpm = Math.max(0, finite(state.propRpm[k] ?? 0));
        const turn = Math.min((rpm / 60) * 2 * Math.PI * step, PROP_MAX_STEP_RAD);
        p.phase = (p.phase + p.handed * turn) % (2 * Math.PI);
        const base = p.follows ? p.follows.matrix : _b.identity();
        rotateAbout(_a, p.pivot, p.axis, p.phase);
        p.object.matrix.multiplyMatrices(base, _a);
        p.object.matrixWorldNeedsUpdate = true;
        p.object.visible = blur[k] < HIDE_BLADES_AT;
        if (p.disc) {
          p.disc.visible = blur[k] > 0.001;
          p.disc.userData.propBlur = blur[k];
          // the ring is authored in XY (normal +Z) at the origin: seat it on the blades' mid-plane about the prop axis
          discBase.makeRotationFromQuaternion(_q.setFromUnitVectors(axisZ, p.axis)).setPosition(p.discCentre);
          p.disc.matrix.multiplyMatrices(base, discBase);
          p.disc.matrixWorldNeedsUpdate = true;
        }
      }
    },
  };
}
