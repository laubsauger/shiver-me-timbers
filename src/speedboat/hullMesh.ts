/**
 * Procedural deep-V COLLISION hull for the speedboat physics core (§T.165 S1,
 * docs/speedboat/tech-research.md §2.2, D12). PURE DATA: no three.js, no
 * params registry, no mode wiring. The render hull is a separate concern (§V18).
 *
 * WHY PROCEDURAL: the wake doc (§3.2) and §V71 both require the hydro proxy to
 * come from the vessel's own evaluator, never hand-authored, so the section
 * table the 2D+t term reads (deadrise, chine beam) and the triangles the
 * clipper reads are built from ONE set of shape functions (§V77). The test's
 * analytic Archimedes check imports the same `halfBeamAt`/`keelRiseAt`.
 *
 * FRAMES. Hull frame: y up from the keel baseline, z forward from the
 * transom (z ∈ [0, L]), x across the beam. The emitted `positions` are in the
 * BODY frame = hull frame minus the CG, because rigid6's position IS the CG.
 *
 * The hull is CLOSED and consistently wound (outward normals): hydrostatics as
 * Σ −ρg·d·A·n̂ over the clipped wet triangles is exact Archimedes only for a
 * closed surface (divergence theorem), and the inverted hull floats on its
 * deck lid. tests/hullWater.test.ts asserts manifoldness and positive volume.
 *
 * Reference boat: 12 m LOA (user decision; the doc's §2.4 table used 11 m), 24° deadrise,
 * geometrically scaled from the doc's 11 m / 2.4 m / 4.5 t boat: chine beam 2.618 m, 5842 kg,
 * LCG 3.6 m — numbers and sources in `deepV12.hull.json`. ASSUMED (not in the doc): VCG, freeboard
 * above the chine, prop offsets (scaled from the 11 m prototype values).
 */
import type { Vec3 } from '../state/simState';
import hullJson from './deepV12.hull.json?raw';

export interface DeepVHullSpec {
  /** overall length, m */
  length: number;
  /** chine half-beam over the prismatic body, m */
  chineHalfBeam: number;
  /** deadrise, degrees (constant: the chine rides b·tanβ above the keel everywhere) */
  deadriseDeg: number;
  /** side height from the prismatic chine to the deck, m */
  freeboard: number;
  /** displacement mass, kg */
  mass: number;
  /** longitudinal CG measured forward from the transom, m */
  lcgFromTransom: number;
  /** stem rake: the deck-level stem sits this far forward of the forefoot, m (LOA = length at the deck) */
  stemRake?: number;
  /** deadrise at the stem, degrees; forward of `warpStart` it warps from `deadriseDeg` toward this */
  bowDeadriseDeg?: number;
  /** fraction of the keel length where the deadrise starts to steepen (≥ 1 ⇒ constant deadrise) */
  warpStart?: number;
  /** vertical CG above the keel baseline, m */
  vcgAboveKeel: number;
  /** fraction of L (from the transom) where the beam starts to taper to the stem */
  taperStart: number;
  /**
   * chine half-beam at the stem as a fraction of `chineHalfBeam` (the floor of the plan taper); omitted ⇒ 0.04
   * (the blunt 9 cm nose before the T179 part-3 pointed bow)
   */
  stemHalfBeamFraction?: number;
  /** fraction of L where the keel starts to rise toward the stem */
  keelRiseStart: number;
  /** keel height at the stem, m */
  bowKeelRise: number;
  /** longitudinal mesh segments (stations − 1) */
  segments: number;
  /** mesh segments per 2D+t strip (strips = segments / segmentsPerStrip) */
  segmentsPerStrip: number;
  /** pitch gyradius / L (§V53 check band 0.24–0.26) */
  gyradiusPitchOverL: number;
  /** roll gyradius / chine beam (§V53 check band 0.35–0.40) */
  gyradiusRollOverB: number;
  /** yaw gyradius / L; omitted ⇒ thin-lamina estimate I_yaw = I_pitch + I_roll */
  gyradiusYawOverL?: number;
  /** prop point below the keel, m (§3.1) */
  propBelowKeel: number;
  /** prop point aft of the transom, m (§3.1 "aft of the transom", distance assumed) */
  propAftOfTransom: number;
  /** prop radius, m (immersion smoothstep half-width, §3.1) */
  propRadius: number;
}

/**
 * The defining numbers live in ONE plain data file, `deepV12.hull.json`, shared with the Blender
 * render-hull script so the drawn hull and the physics proxy cannot drift (§V77). Read as text
 * (`?raw`, typed by vite/client) because tsconfig has no resolveJsonModule.
 */
export interface HullDataFile {
  name: string;
  spec: DeepVHullSpec;
  stations: HullStation[];
  /** rough mass budget the spec's mass / LCG / VCG / gyradii are derived from (`deriveMassProperties`) */
  massItems: MassItem[];
  engines: { mountX: number; mountZFromTransom: number; propPoint: { x: number; yAboveKeel: number; zFromTransom: number } }[];
  lowerUnit: LowerUnitSpec;
}

/** one outboard gearcase as a lateral foil (deepV12.hull.json `lowerUnit`, hull frame, m / m² / deg) */
export interface LowerUnitSpec {
  avPlateYAboveKeel: number;
  span: number;
  lateralArea: number;
  ceDepthBelowAvPlate: number;
  ceAftOfMount: number;
  stallDeg: number;
  profileDragCoeff: number;
  maxSteerDeg: number;
}

/**
 * One steerable drive in the BODY frame (relative to the CG). The drive yaws by the steer angle δ about the
 * body-y axis through `pivot`; `prop` (thrust point) and `foilCe` (gearcase centre of lateral effort) are given
 * at δ = 0 and rotate with it.
 */
export interface DriveUnit {
  pivot: Vec3;
  prop: Vec3;
  foilCe: Vec3;
  /** body y of the anti-ventilation plate (root of the gearcase foil) */
  avPlateY: number;
  span: number;
  lateralArea: number;
  stallRad: number;
  profileDragCoeff: number;
  maxSteerRad: number;
}

/** the drives of the data file, placed on a hull whose CG is (vcg above keel, lcg from transom) */
export function driveUnits(data: Readonly<HullDataFile>, spec: Readonly<DeepVHullSpec>): DriveUnit[] {
  const lu = data.lowerUnit;
  const cgY = spec.vcgAboveKeel;
  const cgZ = spec.lcgFromTransom;
  const deg = Math.PI / 180;
  return data.engines.map((e) => ({
    pivot: [e.mountX, lu.avPlateYAboveKeel - cgY, e.mountZFromTransom - cgZ] as Vec3,
    prop: [e.propPoint.x, e.propPoint.yAboveKeel - cgY, e.propPoint.zFromTransom - cgZ] as Vec3,
    foilCe: [e.mountX, lu.avPlateYAboveKeel - lu.ceDepthBelowAvPlate - cgY, e.mountZFromTransom - lu.ceAftOfMount - cgZ] as Vec3,
    avPlateY: lu.avPlateYAboveKeel - cgY,
    span: lu.span,
    lateralArea: lu.lateralArea,
    stallRad: lu.stallDeg * deg,
    profileDragCoeff: lu.profileDragCoeff,
    maxSteerRad: lu.maxSteerDeg * deg,
  }));
}

/** one mass item, hull frame (x across, y above keel, z forward of transom); k = own gyradii */
export interface MassItem {
  name: string;
  mass: number;
  x: number;
  y: number;
  z: number;
  /** the item's own gyradius about its centroid (pitch, yaw, roll axes), m; omit for point masses */
  k?: { pitch: number; yaw: number; roll: number };
}

/** mass, CG and principal inertia about the CG (body axes) of a set of items */
export function deriveMassProperties(items: readonly MassItem[]): { mass: number; cg: Vec3; inertia: Vec3 } {
  let m = 0;
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (const it of items) {
    m += it.mass;
    sx += it.mass * it.x;
    sy += it.mass * it.y;
    sz += it.mass * it.z;
  }
  const cg: Vec3 = [sx / m, sy / m, sz / m];
  let ip = 0;
  let iy = 0;
  let ir = 0;
  for (const it of items) {
    const dx = it.x - cg[0];
    const dy = it.y - cg[1];
    const dz = it.z - cg[2];
    ip += it.mass * (dy * dy + dz * dz + (it.k ? it.k.pitch * it.k.pitch : 0));
    iy += it.mass * (dx * dx + dz * dz + (it.k ? it.k.yaw * it.k.yaw : 0));
    ir += it.mass * (dx * dx + dy * dy + (it.k ? it.k.roll * it.k.roll : 0));
  }
  return { mass: m, cg, inertia: [ip, iy, ir] };
}
export const HULL_DATA: Readonly<HullDataFile> = JSON.parse(hullJson) as HullDataFile;

/** Reference boat: 12 m, 24° deadrise, chine beam 2.618 m, 5842 kg (scaling law in the JSON). */
export const REFERENCE_DEEP_V: Readonly<DeepVHullSpec> = Object.freeze({ ...HULL_DATA.spec });

/** one generator station in the HULL frame (the offsets table the render hull is lofted from) */
export interface HullStation {
  /** keel and chine station, forward of the transom */
  z: number;
  keelY: number;
  chineHalfBeam: number;
  chineY: number;
  /** local deadrise, degrees (warps forward of `warpStart`) */
  deadriseDeg: number;
  deckHalfBeam: number;
  deckY: number;
  /** deck-edge station z (differs from z only at the raked stem) */
  deckZ: number;
}

/** the offsets table at the proxy's own stations (exactly the vertices the mesh uses) */
export function hullStations(spec: Readonly<DeepVHullSpec> = REFERENCE_DEEP_V): HullStation[] {
  const H = deckHeight(spec);
  const Lk = keelLength(spec);
  const out: HullStation[] = [];
  for (let i = 0; i <= spec.segments; i++) {
    const z = (Lk * i) / spec.segments;
    const b = halfBeamAt(spec, z);
    const ky = keelRiseAt(spec, z);
    const beta = deadriseAt(spec, z);
    const cy = ky + b * Math.tan(beta);
    if (cy > H) throw new Error(`hullMesh: chine above the deck at station ${i} (z ${z.toFixed(2)})`);
    out.push({
      z,
      keelY: ky,
      chineHalfBeam: b,
      chineY: cy,
      deadriseDeg: (beta * 180) / Math.PI,
      deckHalfBeam: b,
      deckY: H,
      // the stem rake: only the stem station's deck edge overhangs the forefoot
      deckZ: i === spec.segments ? z + (spec.stemRake ?? 0) : z,
    });
  }
  return out;
}

/** 2D+t strip table, one entry per transverse strip, index 0 = aft-most (transom) */
export interface HullStrips {
  count: number;
  /** strip length along the body z axis, m */
  dz: number;
  /** body-frame z of each strip centre (relative to CG), m */
  zCentre: Float64Array;
  /** chine half-beam at the strip centre (from the mesh vertices), m */
  chineHalfBeam: Float64Array;
  /** deadrise at the strip centre (from the mesh vertices), rad */
  deadrise: Float64Array;
  /** body-frame y of the keel at the strip centre, m */
  keelY: Float64Array;
  /**
   * the chine at the strip centre as a lerp of two mesh vertices, per HALF (index 2·strip + side, side 0 = −x):
   * position = V[chineV0]·(1 − chineT[strip]) + V[chineV1]·chineT[strip] (the contact reads their depths)
   */
  chineV0: Int32Array;
  chineV1: Int32Array;
  chineT: Float64Array;
}

export interface HullProxy {
  spec: Readonly<DeepVHullSpec>;
  /** body-frame vertex positions (relative to CG), xyz packed */
  positions: Float64Array;
  vertexCount: number;
  /** triangle vertex indices, outward winding */
  indices: Uint16Array;
  triCount: number;
  /** strip index per triangle; −1 = not running surface (deck lid, transom, stem cap) */
  triStrip: Int16Array;
  strips: HullStrips;
  mass: number;
  /** body-frame diagonal inertia [pitch about x, yaw about y, roll about z], kg·m² */
  inertia: Vec3;
  /** body-frame prop point */
  propPoint: Vec3;
  propRadius: number;
  /** body-frame z of the transom and stem */
  transomZ: number;
  stemZ: number;
  /** hull-frame keel y → body y offset (= −vcg) */
  keelBodyY: number;
  /** overall beam, m */
  beam: number;
  /** the outboards: thrust points and gearcase foils (from the data file's `engines` + `lowerUnit`) */
  drives: DriveUnit[];
}

/** keel length: transom to forefoot (the stem rake overhangs it at the deck) */
export function keelLength(spec: Readonly<DeepVHullSpec>): number {
  return spec.length - (spec.stemRake ?? 0);
}

/**
 * Deadrise at hull-frame z, radians: `deadriseDeg` aft of `warpStart`, then warping (C¹ at the start,
 * t²) to `bowDeadriseDeg` at the forefoot. Hunt-type deep-Vs steepen forward — Regulator 24° at the
 * transom to 48–49° forward (Sport Fishing Mag, "Perfect Boat Hull Designs"); Ray Hunt Design: the
 * deadrise "varies continuously" bow to stern.
 */
export function deadriseAt(spec: Readonly<DeepVHullSpec>, zFromTransom: number): number {
  const aft = (spec.deadriseDeg * Math.PI) / 180;
  const ws = spec.warpStart ?? 1;
  const u = zFromTransom / keelLength(spec);
  if (ws >= 1 || u <= ws) return aft;
  const t = Math.min(1, (u - ws) / (1 - ws));
  const bow = ((spec.bowDeadriseDeg ?? spec.deadriseDeg) * Math.PI) / 180;
  return aft + (bow - aft) * t * t;
}

/** chine half-beam at hull-frame z (from the transom). ONE expression for mesh and analytic checks. */
export function halfBeamAt(spec: Readonly<DeepVHullSpec>, zFromTransom: number): number {
  const u = zFromTransom / keelLength(spec);
  if (u < spec.taperStart || spec.taperStart >= 1) return spec.chineHalfBeam;
  const t = (u - spec.taperStart) / (1 - spec.taperStart);
  return spec.chineHalfBeam * Math.max(spec.stemHalfBeamFraction ?? 0.04, Math.cos(t * (Math.PI / 2)));
}

/** keel height above the baseline at hull-frame z (from the transom). */
export function keelRiseAt(spec: Readonly<DeepVHullSpec>, zFromTransom: number): number {
  const u = zFromTransom / keelLength(spec);
  if (u < spec.keelRiseStart || spec.keelRiseStart >= 1) return 0;
  const t = (u - spec.keelRiseStart) / (1 - spec.keelRiseStart);
  return spec.bowKeelRise * t * t;
}

/** deck height above the baseline (constant sheer) */
export function deckHeight(spec: Readonly<DeepVHullSpec>): number {
  return spec.chineHalfBeam * Math.tan((spec.deadriseDeg * Math.PI) / 180) + spec.freeboard;
}

export function buildDeepVHull(spec: Readonly<DeepVHullSpec> = REFERENCE_DEEP_V): HullProxy {
  const n = spec.segments;
  if (!Number.isInteger(n) || n < 2) throw new Error(`hullMesh: segments must be an integer ≥ 2, got ${n}`);
  if (!Number.isInteger(spec.segmentsPerStrip) || n % spec.segmentsPerStrip !== 0) {
    throw new Error(`hullMesh: segments ${n} not divisible by segmentsPerStrip ${spec.segmentsPerStrip}`);
  }
  const stations = hullStations(spec);
  const cgY = spec.vcgAboveKeel;
  const cgZ = spec.lcgFromTransom;

  // welded vertices per station: keel, chine+x, chine−x, deck+x, deck−x
  const PER = 5;
  const vertexCount = (n + 1) * PER;
  if (vertexCount > 65535) throw new Error('hullMesh: too many vertices for Uint16 indices');
  const pos = new Float64Array(vertexCount * 3);
  for (let i = 0; i <= n; i++) {
    const st = stations[i];
    const base = i * PER * 3;
    const put = (k: number, x: number, y: number, z: number): void => {
      pos[base + k * 3] = x;
      pos[base + k * 3 + 1] = y - cgY;
      pos[base + k * 3 + 2] = z - cgZ;
    };
    put(0, 0, st.keelY, st.z);
    put(1, st.chineHalfBeam, st.chineY, st.z);
    put(2, -st.chineHalfBeam, st.chineY, st.z);
    put(3, st.deckHalfBeam, st.deckY, st.deckZ);
    put(4, -st.deckHalfBeam, st.deckY, st.deckZ);
  }
  const K = (i: number): number => i * PER;
  const Cp = (i: number): number => i * PER + 1;
  const Cm = (i: number): number => i * PER + 2;
  const Dp = (i: number): number => i * PER + 3;
  const Dm = (i: number): number => i * PER + 4;

  const tris: number[] = [];
  const stripOf: number[] = [];
  const pushTri = (a: number, b: number, c: number, strip: number): void => {
    tris.push(a, b, c);
    stripOf.push(strip);
  };
  // quad lower_i, upper_i, upper_{i+1}, lower_{i+1}; +x side winds (p0,p1,p3),(p1,p2,p3), −x mirrored
  const quad = (p0: number, p1: number, p2: number, p3: number, side: 1 | -1, strip: number): void => {
    if (side > 0) {
      pushTri(p0, p1, p3, strip);
      pushTri(p1, p2, p3, strip);
    } else {
      pushTri(p0, p3, p1, strip);
      pushTri(p1, p3, p2, strip);
    }
  };
  for (let i = 0; i < n; i++) {
    const strip = Math.floor(i / spec.segmentsPerStrip);
    quad(K(i), Cp(i), Cp(i + 1), K(i + 1), 1, strip); // bottom +x
    quad(K(i), Cm(i), Cm(i + 1), K(i + 1), -1, strip); // bottom −x
    quad(Cp(i), Dp(i), Dp(i + 1), Cp(i + 1), 1, strip); // side +x
    quad(Cm(i), Dm(i), Dm(i + 1), Cm(i + 1), -1, strip); // side −x
    // deck lid, outward +y
    pushTri(Dp(i), Dm(i), Dp(i + 1), -1);
    pushTri(Dm(i), Dm(i + 1), Dp(i + 1), -1);
  }
  // transom (outward −z): fan from the keel around keel, chine+, deck+, deck−, chine−
  pushTri(K(0), Dp(0), Cp(0), -1);
  pushTri(K(0), Dm(0), Dp(0), -1);
  pushTri(K(0), Cm(0), Dm(0), -1);
  // stem cap (outward +z)
  pushTri(K(n), Cp(n), Dp(n), -1);
  pushTri(K(n), Dp(n), Dm(n), -1);
  pushTri(K(n), Dm(n), Cm(n), -1);

  // strip table FROM THE MESH VERTICES (§2.3 "deadrise tabulated from the mesh")
  const count = n / spec.segmentsPerStrip;
  const dzBody = keelLength(spec) / count;
  const zCentre = new Float64Array(count);
  const chine = new Float64Array(count);
  const dead = new Float64Array(count);
  const keelY = new Float64Array(count);
  const chineV0 = new Int32Array(2 * count);
  const chineV1 = new Int32Array(2 * count);
  const chineT = new Float64Array(count);
  for (let s = 0; s < count; s++) {
    // strip centre sits at a station when segmentsPerStrip is even, else mid-segment: lerp either way
    const f = (s + 0.5) * spec.segmentsPerStrip;
    const i0 = Math.min(n - 1, Math.floor(f));
    const t = f - i0;
    const lerpV = (vi0: number, vi1: number, c: number): number =>
      pos[vi0 * 3 + c] * (1 - t) + pos[vi1 * 3 + c] * t;
    const kY = lerpV(K(i0), K(i0 + 1), 1);
    const cX = lerpV(Cp(i0), Cp(i0 + 1), 0);
    const cY = lerpV(Cp(i0), Cp(i0 + 1), 1);
    zCentre[s] = lerpV(K(i0), K(i0 + 1), 2);
    chine[s] = cX;
    dead[s] = Math.atan2(cY - kY, cX);
    keelY[s] = kY;
    chineV0[2 * s] = Cm(i0);
    chineV1[2 * s] = Cm(i0 + 1);
    chineV0[2 * s + 1] = Cp(i0);
    chineV1[2 * s + 1] = Cp(i0 + 1);
    chineT[s] = t;
  }

  const m = spec.mass;
  const L = spec.length;
  const B = 2 * spec.chineHalfBeam;
  const iPitch = m * (spec.gyradiusPitchOverL * L) ** 2;
  const iRoll = m * (spec.gyradiusRollOverB * B) ** 2;
  // yaw: thin-lamina perpendicular-axis estimate I_yaw = I_pitch + I_roll (boundary of the
  // triangle inequality, so the tensor is physically admissible); gyradius ≈ 0.263·L
  const iYaw = spec.gyradiusYawOverL !== undefined ? m * (spec.gyradiusYawOverL * L) ** 2 : iPitch + iRoll;

  return {
    spec,
    positions: pos,
    vertexCount,
    indices: Uint16Array.from(tris),
    triCount: tris.length / 3,
    triStrip: Int16Array.from(stripOf),
    strips: { count, dz: dzBody, zCentre, chineHalfBeam: chine, deadrise: dead, keelY, chineV0, chineV1, chineT },
    mass: m,
    inertia: [iPitch, iYaw, iRoll],
    propPoint: [0, -spec.propBelowKeel - cgY, -spec.propAftOfTransom - cgZ],
    propRadius: spec.propRadius,
    transomZ: -cgZ,
    stemZ: L - cgZ,
    keelBodyY: -cgY,
    beam: B,
    drives: driveUnits(HULL_DATA, spec),
  };
}
