/**
 * HULL↔WATER CONTACT for the speedboat (§T.165 S1; docs/speedboat/tech-research.md
 * §2.1–2.7; docs/wake/wake-research.md §3.1–3.2, V-W2). Engine-free (§V3), pure TS,
 * allocation-free per call after construction. NOT wired into any mode.
 *
 * ONE CONTACT, EVERY CONSUMER (proposed V101 / V-W2). One `evaluate()` per hull per
 * substep clips the hull against the water and produces, in reused buffers:
 *  - wet triangles: centroid, outward normal, area, centroid depth, point velocity
 *    relative to the water, strip index, and the HydroSample fields the wake splats
 *    (fy = vertical force this sample carried, sigma = √A_plan/2)
 *  - waterline segments: the clipped cut edges with local normal velocity (spray root
 *    line, wake injection outline)
 *  - per-strip 2D+t data {c, d, V_n, dm_a/dt, sprayRoot, slam impulse}
 *  - totals: wetted area, displaced volume, slam impulse, patch misses, cap scale
 *  - the rigid6 load: force/torque about the CG + body-frame added mass/inertia
 * The force IS the sum of the samples: Σ wet.fy = load.force[1] (tested). wet.fy is SIGNED (a submerged
 * upward-facing face is pushed up); the WAKE reads `wake` instead — per-plan-column sums, every fy ≥ 0,
 * Σ = max(0, load.force[1]) — which is the wake doc's ∫ρg·h_P dA = ΣF_y (V-W2). A second sampler ⊥.
 *
 * HEIGHT SOURCE (§2.1). `samplePatch()` runs once per tick: a hull-aligned grid
 * (≤ 0.8 m spacing, footprint + tick sweep + margin; DEVIATION from the doc's 1.6 m, user decision:
 * 1.6 m misses the λ 8.3 m wave heave force by 17% of its amplitude, 0.8 m by 4%; ~140 samples) filled from a caller-supplied
 * `HeightSampler`; every substep reads the patch bilinearly. The sampler is an
 * interface on purpose — this module does not import CpuOcean. For FORCES the caller
 * should bind `ocean.pressureHeadAt(x, z, t)` (§V68: a hull answers the Smith-attenuated
 * pressure field; a mirror built with speedboat draft, proposed V105). The clipped
 * waterline is then the pressure waterline; a geometric spray line that must sit on the
 * DRAWN sea would need its own `heightAt` patch (not built here — flagged).
 *
 * FORCE MODEL (§2.2–2.3, D3 hybrid):
 *  - HYDROSTATIC (Kerner pt 1): F = −ρg·d_c·A·n̂ per wet triangle (exact Archimedes for a closed
 *    hull in flat water, divergence theorem). TORQUE at the true centre of pressure
 *    (∫d·r dA = A/12·[(Σd)(Σr) + Σd_i·r_i]) — DEVIATION from the doc's "centroid, add CoP only if
 *    the trim test fails": the centroid form made the mirror-symmetric hull YAW at rest (the
 *    clipped-quad split follows the mirrored winding; −70 N·m, 20° in 20 s).
 *  - VISCOUS: F = −½ρ·C_f·A_sr·|v_t|·v_t per wet triangle, C_f = ITTC-57 0.075/(log₁₀Rn − 2)² +
 *    ΔC_F 0.0004 (the roughness allowance of Savitsky's 1964 procedure), A_sr = clipped area scaled to
 *    the spray-root width (Wagner c / geometric c), Rn on the mean wetted length λb = A_plan/B.
 *  - GARME NEAR-TRANSOM REDUCTION on the STEADY sectional load (hydrostatic + steady lift):
 *    C_T = tanh(2.5·x_T/(a_non·B·Fn_B)). Formula NOT verified against the primary source (see
 *    `garmeANon`); a_non = Garme's 0.34 (not fitted).
 *  - 2D+t MOMENTUM STRIPS (Zarnick 1978 / Faltinsen 2005 ch. 9): per strip, from the
 *    clipped geometry — N̂ = normalised Σ(−n̂A) ⊥ body z, geometric wetted half-beam
 *    c_g = |Σ(−n̂A)|/(2Δz), Wagner c = min((π/2)·c_g, b_chine), m_a = k·ρ·(π/2)·c².
 *      lift      −U·∂(m_a·V_n)/∂ξ with M = m_a·V_n at strip centres: each centre-to-centre
 *                increase is placed at the shared boundary (half to each wet strip), the trailing
 *                half-strip to the transom is extrapolated, then the flux leaves with the wake
 *                (dry-transom Kutta). Clamped ≥ 0 (see ASSUMPTIONS).
 *      slam      the V_n·dm_a/dt term as an INELASTIC MOMENTUM EXCHANGE on entry (Δm_a > 0, V_n > 0),
 *                and as the shed momentum flux (Δm_a < 0) while the section still penetrates; Gauss–Seidel over strips against the body's effective
 *                mass at the strip point with the SAME 1/(m + min(A_old, A_new)) rigid6 divides by
 *                (rigidBody.ts FLUID MOMENTUM), so it can never reverse the strip's normal
 *                velocity and its total is h-independent (proposed V103).
 *      crossflow ½ρ·C_Dc·(2c)·V_n|V_n|·Δz along N̂ and ½ρ·C_Dc·A_side·V|V| along body x, as
 *                linearised-implicit impulses in the same Gauss–Seidel pass, i.e. on the
 *                POST-slam velocity. DEVIATION from an explicit force: the explicit form
 *                threw a 25 m/s flat landing back up at +20 m/s at one substep per tick.
 *                All impulses reach rigid6 as impulse/h, so it stays the only integrator (V100).
 *      added mass (§V69): diagonal body-frame terms from the SAME strips —
 *                A_x,y = Σ m_a·Δz·N_b², ΔI = Σ m_a·Δz·(r_b×N_b)² + roll plate term m_a·c²/8·Δz;
 *                surge 0.05·m ramped by displaced fraction (doc: constant — ramped so a flying
 *                hull has no water to drag).
 *  - BOUNDED AT RESULT (proposed V110, §V44): if |F|/m or |τ_b/I| exceeds its cap, force,
 *    torque and the wake samples are scaled by ONE factor together.
 *
 * ASSUMPTIONS (the doc does not pin these; each is a flagged choice, not a tuned knob):
 *  - k(β) = 1 (plain Wagner). The doc writes k(β) without a value.
 *  - lift clamped ≥ 0 per boundary: momentum that falls downstream is shed, no suction
 *    (the "dm_a/dt only while the wetted beam grows" convention of Zarnick-type models).
 *  - lateral crossflow reuses C_Dc (doc gives no C_D,lat value).
 *  - water particle velocity is zero: the sampler is height only, so wave orbital velocity
 *    does not enter V_n / v_t.
 *  - only running-surface strips get 2D+t terms: the deck lid, transom and stem cap get
 *    hydrostatics + viscous only (an INVERTED flat landing has no slam — known gap).
 *  - aero, Kerner suction (default 0 in the doc), skeg/drive foil: NOT here (out of scope).
 *
 * KNOWN LIMITS (measured): V104 at EQUILIBRIUM over Savitsky's valid range C_v 3.1–6.0. Added mass is
 * DIAGONAL about the CG: the heave–pitch term A₃₅ (0.36 of the mass matrix at C_v 3.1) is dropped; a
 * coupled 6×6 with per-strip keep was tried and was UNSTABLE at every C_v (open question, reported).
 * Free-running at C_v 3.5–3.9 a pitch limit cycle remains (0.28° at 14 strips, ~0.9° as the strips are
 * refined — so it is the continuous model, not discretisation), far below the doc's porpoising limit;
 * and a roll (chine-walk) limit cycle of ±30° appears at C_v ≥ 8. Both open, reported.
 * One GS sweep is not a converged solve —
 * at 100× C_Dc a 20° stern-first 30 m/s entry still rebounds.
 *
 * MEMORY (proposed V108): `prevMa` (per-strip added mass of the previous substep, for
 * dm_a/dt) is the only carried value. `resetMemory()` on any teleport/respawn/LOD handoff;
 * the first call after a reset exchanges no slam momentum.
 *
 * OWN-WAKE (proposed V111): the sampler handed to `samplePatch` must not include this hull's
 * own same-tick wake source. Not enforceable from here; stated for the wiring stage.
 */
import type { Quat, Vec3 } from '../state/simState';
import type { Rigid6ForceFn, Rigid6Load, Rigid6State } from './rigidBody';

/** water surface (or pressure head) elevation at world (x, z), m */
export type HeightSampler = (x: number, z: number) => number;

/** what the contact needs from a hull; `buildDeepVHull` (src/speedboat/hullMesh.ts) satisfies it */
export interface HullWaterMesh {
  positions: Float64Array;
  vertexCount: number;
  indices: Uint16Array | Uint32Array;
  triCount: number;
  triStrip: Int16Array;
  strips: {
    count: number;
    dz: number;
    zCentre: Float64Array;
    chineHalfBeam: Float64Array;
    keelY: Float64Array;
  };
  mass: number;
  inertia: Vec3;
  propPoint: Vec3;
  propRadius: number;
  /** transom z and stem z in the body frame (length = stemZ − transomZ) */
  transomZ: number;
  stemZ: number;
}

export interface HullWaterParams {
  /** sea water density, kg/m³ */
  rho: number;
  gravity: number;
  /** kinematic viscosity, m²/s (ITTC 15 °C sea water) */
  nu: number;
  /** k(β) in m_a = k·ρ·(π/2)·c² */
  addedMassCoeff: number;
  /** Zarnick crossflow drag coefficient C_Dc */
  crossflowDrag: number;
  /** surge added mass / m (doc §1.3) */
  surgeAddedMassRatio: number;
  /**
   * Garme near-transom reduction length a_non (0 = off): every sectional load (hydrostatic and
   * 2D+t) is multiplied by C_T = tanh(2.5·x_T/(a_non·B·Fn_B)), x_T = distance from the trailing
   * edge (transom), Fn_B = U/√(gB).
   * SOURCE — NOT VERIFIED AGAINST THE PRIMARY: Garme, K., "Improved time domain simulation of
   * planing hulls in waves by correction of the near-transom lift", Int. Shipbuild. Prog. 52(3)
   * 201–230, 2005 (paywalled; his thesis TRITA-AVE 2004:34 has no open full text). The formula and
   * Garme's 0.34 are taken from the reproduction in Niazmand Bilandi et al., J. Mar. Sci. Eng.
   * 2018, 6, 136, eq. (22).
   * APPLIED TO THE STEADY LOAD ONLY — hydrostatic pressure and the steady part of the 2D+t lift (the
   * momentum flux at the pose with the CG moving horizontally). The rate-dependent terms (lift from
   * heave/pitch rate, V_n·dm_a/dt, crossflow drag) keep their full 2D+t value: Garme's function was
   * chosen from steady pressures and running attitude, and applied to the rate terms it removed the
   * near-transom heave/pitch damping — a free-running limit cycle at C_v ≤ 3.7 (3.4° p2p).
   * NOT FITTED: Garme's own 0.34. On the signed-off hull (2.30 m chine, triple outboards, LCG 3.65 m)
   * it gives equilibrium trim within −0.48…−0.86° of Savitsky over the valid range.
   */
  garmeANon: number;
  /** skin-friction roughness allowance ΔC_F added to the ITTC-57 line (Savitsky 1964 procedure) */
  frictionAllowance: number;
  /** 2D+t strips on/off (off = hydrostatics + viscous only) */
  planing: boolean;
  viscous: boolean;
  /** V110 linear cap, m/s² — a SAFETY bound, not a feel knob */
  maxAccel: number;
  /** V110 angular cap, rad/s² */
  maxAngularAccel: number;
  /** patch grid spacing upper bound, m (0.8: wave heave force within 10% at λ 8.3 m, tested) */
  patchSpacing: number;
  /** patch margin around footprint + tick sweep, m */
  patchMargin: number;
  /** patch nodes per axis cap */
  patchMaxAxis: number;
}

export const HULL_WATER_DEFAULTS: Readonly<HullWaterParams> = Object.freeze({
  rho: 1025,
  gravity: 9.81,
  nu: 1.19e-6,
  addedMassCoeff: 1,
  crossflowDrag: 1,
  surgeAddedMassRatio: 0.05,
  garmeANon: 0.34,
  frictionAllowance: 0.0004,
  planing: true,
  viscous: true,
  maxAccel: 50 * 9.81,
  maxAngularAccel: 200,
  patchSpacing: 0.8,
  patchMargin: 1.0,
  patchMaxAxis: 48,
});

const HALF_PI = Math.PI / 2;

/**
 * Per-hull height grid, sampled once per tick and read bilinearly by every substep.
 * Hull-aligned (u along the hull's horizontal forward, w across), so a heading change
 * never inflates it; any axis choice is valid, only the size changes.
 */
export class WaterPatch {
  readonly heights: Float64Array;
  nu = 0;
  nw = 0;
  ox = 0;
  oz = 0;
  e1x = 1;
  e1z = 0;
  du = 1;
  dw = 1;
  /** queries that fell outside the grid since the last build (clamped to the edge) */
  outside = 0;
  sampleCount = 0;
  private built = false;

  constructor(readonly maxAxis: number) {
    this.heights = new Float64Array(maxAxis * maxAxis);
  }

  build(
    sampler: HeightSampler,
    mesh: HullWaterMesh,
    state: Readonly<Rigid6State>,
    dt: number,
    spacing: number,
    margin: number,
  ): void {
    const [qx, qy, qz, qw] = state.quaternion;
    const [px, , pz] = state.position;
    // world xz of body +z and body +x; pick the longer as the grid's long axis
    const fx = 2 * (qx * qz + qw * qy);
    const fz = 1 - 2 * (qx * qx + qy * qy);
    const rx = 1 - 2 * (qy * qy + qz * qz);
    const rz = 2 * (qx * qz - qw * qy);
    const fl = Math.hypot(fx, fz);
    const rl = Math.hypot(rx, rz);
    let e1x: number;
    let e1z: number;
    if (fl >= 0.2 || fl >= rl) {
      e1x = fl > 1e-9 ? fx / fl : 1;
      e1z = fl > 1e-9 ? fz / fl : 0;
    } else {
      e1x = rx / rl;
      e1z = rz / rl;
    }
    const e2x = -e1z;
    const e2z = e1x;
    let uMin = Infinity;
    let uMax = -Infinity;
    let wMin = Infinity;
    let wMax = -Infinity;
    const P = mesh.positions;
    // every vertex, plus the prop point (a setback bracket puts it beyond the hull's own footprint)
    for (let i = 0; i <= mesh.vertexCount; i++) {
      const last = i === mesh.vertexCount;
      const bx = last ? mesh.propPoint[0] : P[i * 3];
      const by = last ? mesh.propPoint[1] : P[i * 3 + 1];
      const bz = last ? mesh.propPoint[2] : P[i * 3 + 2];
      const tx = 2 * (qy * bz - qz * by);
      const ty = 2 * (qz * bx - qx * bz);
      const tz = 2 * (qx * by - qy * bx);
      const wx = bx + qw * tx + (qy * tz - qz * ty);
      const wz = bz + qw * tz + (qx * ty - qy * tx);
      const u = wx * e1x + wz * e1z;
      const w = wx * e2x + wz * e2z;
      if (u < uMin) uMin = u;
      if (u > uMax) uMax = u;
      if (w < wMin) wMin = w;
      if (w > wMax) wMax = w;
    }
    // sweep over the tick (substeps move the hull forward in time inside it)
    const sweepU = (state.velocity[0] * e1x + state.velocity[2] * e1z) * dt;
    const sweepW = (state.velocity[0] * e2x + state.velocity[2] * e2z) * dt;
    if (sweepU > 0) uMax += sweepU;
    else uMin += sweepU;
    if (sweepW > 0) wMax += sweepW;
    else wMin += sweepW;
    uMin -= margin;
    uMax += margin;
    wMin -= margin;
    wMax += margin;
    const nu = Math.min(this.maxAxis, Math.max(2, Math.ceil((uMax - uMin) / spacing) + 1));
    const nw = Math.min(this.maxAxis, Math.max(2, Math.ceil((wMax - wMin) / spacing) + 1));
    this.nu = nu;
    this.nw = nw;
    this.du = (uMax - uMin) / (nu - 1);
    this.dw = (wMax - wMin) / (nw - 1);
    this.e1x = e1x;
    this.e1z = e1z;
    this.ox = px + uMin * e1x + wMin * e2x;
    this.oz = pz + uMin * e1z + wMin * e2z;
    const H = this.heights;
    for (let j = 0; j < nw; j++) {
      const bx = this.ox + j * this.dw * e2x;
      const bz = this.oz + j * this.dw * e2z;
      for (let i = 0; i < nu; i++) {
        H[j * nu + i] = sampler(bx + i * this.du * e1x, bz + i * this.du * e1z);
      }
    }
    this.sampleCount = nu * nw;
    this.outside = 0;
    this.built = true;
  }

  heightAt(x: number, z: number): number {
    if (!this.built) throw new Error('WaterPatch.heightAt before build(): sample the patch once per tick first');
    const rx = x - this.ox;
    const rz = z - this.oz;
    let fu = (rx * this.e1x + rz * this.e1z) / this.du;
    let fw = (-rx * this.e1z + rz * this.e1x) / this.dw;
    const mu = this.nu - 1;
    const mw = this.nw - 1;
    if (fu < 0 || fu > mu || fw < 0 || fw > mw) {
      if (fu < -1e-6 || fu > mu + 1e-6 || fw < -1e-6 || fw > mw + 1e-6) this.outside++;
      fu = fu < 0 ? 0 : fu > mu ? mu : fu;
      fw = fw < 0 ? 0 : fw > mw ? mw : fw;
    }
    let iu = Math.floor(fu);
    let iw = Math.floor(fw);
    if (iu >= mu) iu = mu - 1;
    if (iw >= mw) iw = mw - 1;
    const tu = fu - iu;
    const tw = fw - iw;
    const H = this.heights;
    const r0 = iw * this.nu;
    const r1 = r0 + this.nu;
    return (
      (H[r0 + iu] * (1 - tu) + H[r0 + iu + 1] * tu) * (1 - tw) + (H[r1 + iu] * (1 - tu) + H[r1 + iu + 1] * tu) * tw
    );
  }
}

/** wet triangle buffers (capacity 2 × triCount) */
export interface WetTriangles {
  count: number;
  centroid: Float64Array;
  normal: Float64Array;
  area: Float64Array;
  depth: Float64Array;
  /** point velocity relative to the (still) water */
  vel: Float64Array;
  strip: Int16Array;
  /** HydroSample: vertical force this sample carried, N (signed; see report) */
  fy: Float64Array;
  /** HydroSample: plan footprint radius √(A·|n_y|)/2, m */
  sigma: Float64Array;
}

/**
 * WAKE LOAD SAMPLES (V101 / V-W2): the pressure the hull puts on the water, as ≥ 0 plan-column samples.
 * A wet triangle's own fy is SIGNED — an upward-facing submerged face (a buried deck, an inverted hull's
 * bottom) is pushed UP by the water, fy < 0 — and a clamp-at-0 consumer then integrates MORE load than
 * the contact carries. The water column under a plan point feels the NET of every face above it, and
 * hydrostatically that net is ρg × the column's submerged thickness ≥ 0. So the wet samples are summed
 * per hull-aligned plan cell of the height patch (≤ 0.8 m); cells still < 0 (dynamic suction, or a
 * face whose partner fell in the next cell) are clamped and the positive cells rescaled so that
 *   Σ fy = max(0, load.force[1])   exactly, with every fy ≥ 0.
 * A net DOWNWARD pull by the water (load.force[1] < 0) gives no wake load; `deficit` reports it.
 */
export interface WakeLoadSamples {
  count: number;
  /** plan position (world x, z) of the cell's load, plan-area weighted */
  x: Float64Array;
  z: Float64Array;
  /** vertical load the water carries in this cell, N, ≥ 0 */
  fy: Float64Array;
  /** plan footprint radius √(A_plan)/2, m */
  sigma: Float64Array;
  /** plan-area-weighted mean depth, m, ≥ 0 */
  depth: Float64Array;
  /** load.force[1] − Σ fy (≠ 0 only when the net vertical load is downward) */
  deficit: number;
  /** net load / Σ positive cell loads: 1 ⇔ no cell was negative, the columns are the physical split */
  rescale: number;
}

export interface WaterlineSegments {
  count: number;
  a: Float64Array;
  b: Float64Array;
  /** normal velocity (along the parent triangle's outward normal) at the segment midpoint */
  vn: Float64Array;
}

export interface HullSections {
  count: number;
  /** Wagner wetted half-beam, m */
  c: Float64Array;
  /** vertical keel immersion at the strip centre (signed, + = below the surface), m */
  d: Float64Array;
  /** penetration velocity along the strip normal, m/s */
  vn: Float64Array;
  /** forward speed along body z, m/s */
  u: Float64Array;
  /** sectional added mass, kg/m */
  ma: Float64Array;
  /** ∂m_a/∂t at the body-fixed strip over the last substep, kg/(m·s) */
  dmadt: Float64Array;
  /** (π/2)·c_g — spray root half-beam; > chine half-beam ⇒ sheet leaves the chine */
  sprayRoot: Float64Array;
  wetArea: Float64Array;
  /** slam impulse this substep, N·s */
  slam: Float64Array;
  /** world strip normal N̂ (into the hull) */
  normal: Float64Array;
  /** world wet centroid */
  centroid: Float64Array;
}

export class HullWater {
  readonly params: HullWaterParams;
  readonly patch: WaterPatch;
  readonly wet: WetTriangles;
  readonly waterline: WaterlineSegments;
  readonly sections: HullSections;
  /** ≥ 0 plan-column samples for the wake (see WakeLoadSamples); Σ fy = max(0, load.force[1]) */
  readonly wake: WakeLoadSamples;
  readonly load: Rigid6Load;
  /** totals of the last evaluate() */
  wettedArea = 0;
  /** hydrostatic displaced volume Σ d·A·(−n_y), m³ (exact submerged volume in flat water) */
  displacedVolume = 0;
  /** Σ slam impulse this substep, N·s */
  slamImpulse = 0;
  /** V110 scale applied (1 = uncapped) */
  capScale = 1;
  /** uncapped hydro force (world), N */
  readonly rawForce: Vec3 = [0, 0, 0];
  /** skin-friction share of the uncapped force and of the torque about the CG (world) */
  readonly frictionForce: Vec3 = [0, 0, 0];
  readonly frictionTorque: Vec3 = [0, 0, 0];
  propDepth = 0;
  propImmersion = 0;

  private readonly px: Float64Array;
  private readonly py: Float64Array;
  private readonly pz: Float64Array;
  private readonly pd: Float64Array;
  private readonly prevMa: Float64Array;
  /** previous substep's body-frame added mass [x,y,z] and added inertia [x,y,z] */
  private readonly prevAdded = new Float64Array(6);
  private hasPrev = false;
  // strip accumulators
  private readonly sSx: Float64Array;
  private readonly sSy: Float64Array;
  private readonly sSz: Float64Array;
  private readonly sLatP: Float64Array;
  private readonly sLatM: Float64Array;
  private readonly sForce: Float64Array;
  private readonly sLift: Float64Array;
  private readonly hArea: Float64Array;
  private readonly hCentroid: Float64Array;
  private readonly hNormal: Float64Array;
  private readonly hMa: Float64Array;
  private readonly hVn: Float64Array;
  private readonly hU: Float64Array;
  private readonly hCw: Float64Array;
  private readonly hCg: Float64Array;
  /** half-section index per wet triangle (−1 = not running surface) */
  private readonly wHalf: Int16Array;
  private readonly cellFy: Float64Array;
  private readonly cellA: Float64Array;
  private readonly cellAx: Float64Array;
  private readonly cellAz: Float64Array;
  private readonly cellAd: Float64Array;
  private readonly cellList: Int32Array;
  // Gauss–Seidel scratch: working velocities, inverse mass/inertia (body diag), body axes in world
  private readonly gv = new Float64Array(3);
  private readonly gw = new Float64Array(3);
  private readonly gsInvM = new Float64Array(3);
  private readonly gsInvI = new Float64Array(3);
  private readonly gsAxes = new Float64Array(9);
  private readonly j6 = new Float64Array(6);
  // per-call pose cache
  private cgx = 0;
  private cgy = 0;
  private cgz = 0;
  private vx = 0;
  private vy = 0;
  private vz = 0;
  private wx = 0;
  private wy = 0;
  private wz = 0;
  private bzX = 0;
  private bzY = 0;
  private bzZ = 1;
  private uForward = true;
  private beamMax = 0;
  /** 2.5/(a_non·B·Fn_B); 0 ⇒ no reduction (at rest, or disabled) */
  private garmeK = 0;
  private fX = 0;
  private fY = 0;
  private fZ = 0;
  private tX = 0;
  private tY = 0;
  private tZ = 0;

  constructor(
    readonly mesh: HullWaterMesh,
    params: Partial<HullWaterParams> = {},
  ) {
    this.params = { ...HULL_WATER_DEFAULTS, ...params };
    this.patch = new WaterPatch(this.params.patchMaxAxis);
    const nV = mesh.vertexCount;
    const cap = mesh.triCount * 2;
    const ns = mesh.strips.count;
    this.px = new Float64Array(nV);
    this.py = new Float64Array(nV);
    this.pz = new Float64Array(nV);
    this.pd = new Float64Array(nV);
    this.wet = {
      count: 0,
      centroid: new Float64Array(cap * 3),
      normal: new Float64Array(cap * 3),
      area: new Float64Array(cap),
      depth: new Float64Array(cap),
      vel: new Float64Array(cap * 3),
      strip: new Int16Array(cap),
      fy: new Float64Array(cap),
      sigma: new Float64Array(cap),
    };
    this.waterline = {
      count: 0,
      a: new Float64Array(mesh.triCount * 3),
      b: new Float64Array(mesh.triCount * 3),
      vn: new Float64Array(mesh.triCount),
    };
    this.sections = {
      count: ns,
      c: new Float64Array(ns),
      d: new Float64Array(ns),
      vn: new Float64Array(ns),
      u: new Float64Array(ns),
      ma: new Float64Array(ns),
      dmadt: new Float64Array(ns),
      sprayRoot: new Float64Array(ns),
      wetArea: new Float64Array(ns),
      slam: new Float64Array(ns),
      normal: new Float64Array(ns * 3),
      centroid: new Float64Array(ns * 3),
    };
    this.prevMa = new Float64Array(2 * ns);
    {
      const cells = this.params.patchMaxAxis * this.params.patchMaxAxis;
      this.wake = {
        count: 0,
        x: new Float64Array(cells),
        z: new Float64Array(cells),
        fy: new Float64Array(cells),
        sigma: new Float64Array(cells),
        depth: new Float64Array(cells),
        deficit: 0,
        rescale: 1,
      };
      this.cellFy = new Float64Array(cells);
      this.cellA = new Float64Array(cells);
      this.cellAx = new Float64Array(cells);
      this.cellAz = new Float64Array(cells);
      this.cellAd = new Float64Array(cells);
      this.cellList = new Int32Array(cells);
    }
    // per HALF-section (index 2·strip + side, side 0 = −x, 1 = +x)
    this.sSx = new Float64Array(2 * ns);
    this.sSy = new Float64Array(2 * ns);
    this.sSz = new Float64Array(2 * ns);
    this.sLatP = new Float64Array(2 * ns);
    this.sLatM = new Float64Array(2 * ns);
    this.sForce = new Float64Array(2 * ns * 3);
    this.sLift = new Float64Array(2 * ns);
    this.hArea = new Float64Array(2 * ns);
    this.hCentroid = new Float64Array(2 * ns * 3);
    this.hNormal = new Float64Array(2 * ns * 3);
    this.hMa = new Float64Array(2 * ns);
    this.hVn = new Float64Array(2 * ns);
    this.hU = new Float64Array(2 * ns);
    this.hCw = new Float64Array(2 * ns);
    this.hCg = new Float64Array(2 * ns);
    this.wHalf = new Int16Array(mesh.triCount * 2);
    this.load = { force: [0, 0, 0], torque: [0, 0, 0], addedMass: [0, 0, 0], addedInertia: [0, 0, 0] };
  }

  /** V108: forget every per-location memory (teleport, respawn, LOD handoff) */
  resetMemory(): void {
    this.prevMa.fill(0);
    this.prevAdded.fill(0);
    this.hasPrev = false;
  }

  /** once per tick, before the substeps */
  samplePatch(sampler: HeightSampler, state: Readonly<Rigid6State>, dt: number): void {
    this.patch.build(sampler, this.mesh, state, dt, this.params.patchSpacing, this.params.patchMargin);
  }

  /** a rigid6 force callback that evaluates this contact once per substep */
  forceFn(): Rigid6ForceFn {
    return (state, h, out) => this.evaluate(state, h, out);
  }

  /**
   * THE per-substep contact (V101). Fills every buffer and ACCUMULATES the hydro load
   * into `out` (also copied to `this.load`). Must be called exactly once per substep:
   * dm_a/dt is taken against the previous call.
   */
  evaluate(state: Readonly<Rigid6State>, h: number, out?: Rigid6Load): void {
    const mesh = this.mesh;
    const prm = this.params;
    const rho = prm.rho;
    const [qx, qy, qz, qw] = state.quaternion as Quat;
    const cgx = (this.cgx = state.position[0]);
    const cgy = (this.cgy = state.position[1]);
    const cgz = (this.cgz = state.position[2]);
    const vx = (this.vx = state.velocity[0]);
    const vy = (this.vy = state.velocity[1]);
    const vz = (this.vz = state.velocity[2]);
    const wx = (this.wx = state.angularVelocity[0]);
    const wy = (this.wy = state.angularVelocity[1]);
    const wz = (this.wz = state.angularVelocity[2]);
    const patch = this.patch;

    // ITTC-57 at the hull's speed through the water (one Rn per call)
    // Garme near-transom reduction: C_T(x_T) = tanh(garmeK·x_T), garmeK = 2.5/(a_non·B·Fn_B)
    {
      const zx = 2 * (qx * qz + qw * qy);
      const zy = 2 * (qy * qz - qw * qx);
      const zz = 1 - 2 * (qx * qx + qy * qy);
      this.bzX = zx;
      this.bzY = zy;
      this.bzZ = zz;
      const uCg = vx * zx + vy * zy + vz * zz;
      this.uForward = uCg >= 0;
      let bMax = 0;
      for (let i = 0; i < mesh.strips.count; i++) bMax = Math.max(bMax, 2 * mesh.strips.chineHalfBeam[i]);
      this.beamMax = bMax;
      const fnB = bMax > 0 ? Math.abs(uCg) / Math.sqrt(prm.gravity * bMax) : 0;
      const denom = prm.garmeANon * bMax * fnB;
      this.garmeK = prm.garmeANon > 0 && denom > 1e-9 ? 2.5 / denom : 0;
    }

    // ---- vertices → world, depth below the patch surface
    const P = mesh.positions;
    const PX = this.px;
    const PY = this.py;
    const PZ = this.pz;
    const PD = this.pd;
    for (let i = 0; i < mesh.vertexCount; i++) {
      const bx = P[i * 3];
      const by = P[i * 3 + 1];
      const bz = P[i * 3 + 2];
      const tx = 2 * (qy * bz - qz * by);
      const ty = 2 * (qz * bx - qx * bz);
      const tz = 2 * (qx * by - qy * bx);
      const x = cgx + bx + qw * tx + (qy * tz - qz * ty);
      const y = cgy + by + qw * ty + (qz * tx - qx * tz);
      const z = cgz + bz + qw * tz + (qx * ty - qy * tx);
      PX[i] = x;
      PY[i] = y;
      PZ[i] = z;
      PD[i] = patch.heightAt(x, z) - y;
    }

    // ---- reset accumulators
    const ns = mesh.strips.count;
    const S = this.sections;
    this.sSx.fill(0);
    this.sSy.fill(0);
    this.sSz.fill(0);
    this.sLatP.fill(0);
    this.sLatM.fill(0);
    S.wetArea.fill(0);
    S.centroid.fill(0);
    this.hArea.fill(0);
    this.hCentroid.fill(0);
    this.wet.count = 0;
    this.waterline.count = 0;
    this.fX = this.fY = this.fZ = 0;
    this.tX = this.tY = this.tZ = 0;
    this.wettedArea = 0;
    this.displacedVolume = 0;

    // body x̂ in world, for the lateral projected areas
    const bxx = 1 - 2 * (qy * qy + qz * qz);
    const bxy = 2 * (qx * qy + qw * qz);
    const bxz = 2 * (qx * qz - qw * qy);
    this.latX = bxx;
    this.latY = bxy;
    this.latZ = bxz;

    // ---- clip (Kerner 4 cases)
    const I = mesh.indices;
    for (let t = 0; t < mesh.triCount; t++) {
      const i0 = I[t * 3];
      const i1 = I[t * 3 + 1];
      const i2 = I[t * 3 + 2];
      const d0 = PD[i0];
      const d1 = PD[i1];
      const d2 = PD[i2];
      const nSub = (d0 > 0 ? 1 : 0) + (d1 > 0 ? 1 : 0) + (d2 > 0 ? 1 : 0);
      if (nSub === 0) continue;
      const strip = mesh.triStrip[t];
      if (nSub === 3) {
        this.emit(PX[i0], PY[i0], PZ[i0], PX[i1], PY[i1], PZ[i1], PX[i2], PY[i2], PZ[i2], d0, d1, d2, strip);
        continue;
      }
      // rotate (keeping winding) so the odd vertex is `a`
      let a = i0;
      let b = i1;
      let c = i2;
      const odd = nSub === 1 ? (d0 > 0 ? 0 : d1 > 0 ? 1 : 2) : d0 <= 0 ? 0 : d1 <= 0 ? 1 : 2;
      if (odd === 1) {
        a = i1;
        b = i2;
        c = i0;
      } else if (odd === 2) {
        a = i2;
        b = i0;
        c = i1;
      }
      const da = PD[a];
      const db = PD[b];
      const dc = PD[c];
      const tb = da / (da - db);
      const tc = da / (da - dc);
      const ibx = PX[a] + (PX[b] - PX[a]) * tb;
      const iby = PY[a] + (PY[b] - PY[a]) * tb;
      const ibz = PZ[a] + (PZ[b] - PZ[a]) * tb;
      const icx = PX[a] + (PX[c] - PX[a]) * tc;
      const icy = PY[a] + (PY[c] - PY[a]) * tc;
      const icz = PZ[a] + (PZ[c] - PZ[a]) * tc;
      this.pushSegment(ibx, iby, ibz, icx, icy, icz, PX[a], PY[a], PZ[a], PX[b], PY[b], PZ[b], PX[c], PY[c], PZ[c]);
      if (nSub === 1) {
        this.emit(PX[a], PY[a], PZ[a], ibx, iby, ibz, icx, icy, icz, da, 0, 0, strip);
      } else {
        this.emit(ibx, iby, ibz, PX[b], PY[b], PZ[b], PX[c], PY[c], PZ[c], 0, db, dc, strip);
        this.emit(ibx, iby, ibz, PX[c], PY[c], PZ[c], icx, icy, icz, 0, dc, 0, strip);
      }
    }

    // ---- 2D+t sections, split into PORT and STARBOARD HALF-SECTIONS (asymmetric wedge, doc §2.3
    //      "tilted by the local heel"). Each half carries its share of the section's added mass, its own
    //      normal velocity and upwind momentum flux, and acts at its own wet centroid along the SECTION
    //      normal. A symmetric section gives exactly the full-section 2D+t; a ROLLING section gets the
    //      lift difference across the keel that is its roll damping, a HEELED one the asymmetric-wedge
    //      restoring. The strip-mean form averaged the roll-rate normal velocity away across the keel:
    //      linearised roll damping −0.3 kN·m·s (now −5…−7) and roll stiffness turning positive at C_v 10
    //      (now −31…−59 kN·m/rad) — a ±27–31° roll limit cycle at C_v 8 and capsize at 9–10.
    const m = mesh.mass;
    // body axes in world
    const byx = 2 * (qx * qy - qw * qz);
    const byy = 1 - 2 * (qx * qx + qz * qz);
    const byz = 2 * (qy * qz + qw * qx);
    const bzx = 2 * (qx * qz + qw * qy);
    const bzy = 2 * (qy * qz - qw * qx);
    const bzz = 1 - 2 * (qx * qx + qy * qy);
    let Ax = 0;
    let Ay = 0;
    let dIx = 0;
    let dIy = 0;
    let dIz = 0;
    let slamJx = 0;
    let slamJy = 0;
    let slamJz = 0;
    let slamLx = 0;
    let slamLy = 0;
    let slamLz = 0;
    this.slamImpulse = 0;
    const SF = this.sForce;
    SF.fill(0);
    S.slam.fill(0);
    S.dmadt.fill(0);
    const dz = mesh.strips.dz;
    const k = prm.addedMassCoeff;
    const nh = 2 * ns;
    const HA = this.hArea;
    const HC = this.hCentroid;
    const HN = this.hNormal;
    const HMA = this.hMa;
    const HVN = this.hVn;
    const HU = this.hU;
    const HCW = this.hCw;
    const HCG = this.hCg;
    // strip totals and centroids from the halves
    for (let i = 0; i < ns; i++) {
      const A = HA[2 * i] + HA[2 * i + 1];
      S.wetArea[i] = A;
      if (A <= 1e-9) continue;
      S.centroid[i * 3] = (HC[i * 6] + HC[i * 6 + 3]) / A;
      S.centroid[i * 3 + 1] = (HC[i * 6 + 1] + HC[i * 6 + 4]) / A;
      S.centroid[i * 3 + 2] = (HC[i * 6 + 2] + HC[i * 6 + 5]) / A;
    }
    for (let hI = 0; hI < nh; hI++) {
      const A = HA[hI];
      if (A <= 1e-9) continue;
      HC[hI * 3] /= A;
      HC[hI * 3 + 1] /= A;
      HC[hI * 3 + 2] /= A;
    }
    HMA.fill(0);
    HVN.fill(0);
    HU.fill(0);
    HCW.fill(0);
    HCG.fill(0);
    if (prm.planing) {
      for (let i = 0; i < ns; i++) {
        let nX = 0;
        let nY = 0;
        let nZ = 0;
        let cgSum = 0;
        let maSum = 0;
        let vnW = 0;
        let uW = 0;
        let cRms = 0;
        if (S.wetArea[i] > 1e-9) {
          // SECTION normal from both halves (⊥ body z)
          let sx = this.sSx[2 * i] + this.sSx[2 * i + 1];
          let sy = this.sSy[2 * i] + this.sSy[2 * i + 1];
          let sz = this.sSz[2 * i] + this.sSz[2 * i + 1];
          const along = sx * bzx + sy * bzy + sz * bzz;
          sx -= along * bzx;
          sy -= along * bzy;
          sz -= along * bzz;
          const aProj = Math.sqrt(sx * sx + sy * sy + sz * sz);
          if (aProj > 1e-9) {
            nX = sx / aProj;
            nY = sy / aProj;
            nZ = sz / aProj;
            for (let side = 0; side < 2; side++) {
              const hI = 2 * i + side;
              HN[hI * 3] = nX;
              HN[hI * 3 + 1] = nY;
              HN[hI * 3 + 2] = nZ;
              if (HA[hI] <= 1e-9) continue;
              // The SECTION keeps the full-section Wagner c and m_a (so a symmetric section is exactly the
              // strip model and the chine cap acts on the section); each half takes the share c_g,half² /
              // Σ c_g² of it, from its own UNCAPPED wetted width projected on the section normal (the
              // lower half of a heeled wedge carries more — asymmetric-wedge restoring that survives a
              // wet chine). Measured alternatives: shares by wetted area lost roll stiffness at C_v ≥ 7
              // (capsize at 9); a per-half chine cap lost it at C_v ≤ 5 (13° loll).
              const cG = aProj / (2 * dz);
              const cW = Math.min(HALF_PI * cG, mesh.strips.chineHalfBeam[i]);
              const cgP = Math.max(0, (this.sSx[2 * i] * nX + this.sSy[2 * i] * nY + this.sSz[2 * i] * nZ) / dz);
              const cgS = Math.max(0, (this.sSx[2 * i + 1] * nX + this.sSy[2 * i + 1] * nY + this.sSz[2 * i + 1] * nZ) / dz);
              const cgH = side === 0 ? cgP : cgS;
              const share = cgP * cgP + cgS * cgS > 0 ? (cgH * cgH) / (cgP * cgP + cgS * cgS) : 0.5;
              const ma = k * rho * HALF_PI * cW * cW * share;
              const rx = HC[hI * 3] - cgx;
              const ry = HC[hI * 3 + 1] - cgy;
              const rz = HC[hI * 3 + 2] - cgz;
              const pvx = vx + (wy * rz - wz * ry);
              const pvy = vy + (wz * rx - wx * rz);
              const pvz = vz + (wx * ry - wy * rx);
              HCG[hI] = cG;
              HCW[hI] = cW;
              HMA[hI] = ma;
              HVN[hI] = -(pvx * nX + pvy * nY + pvz * nZ);
              HU[hI] = pvx * bzx + pvy * bzy + pvz * bzz;
              cgSum += cG;
              maSum += ma;
              vnW += ma * HVN[hI];
              uW += HA[hI] * HU[hI];
              cRms += cW * cW;
            }
          }
        }
        S.c[i] = Math.sqrt(cRms / 2);
        S.sprayRoot[i] = (HALF_PI * cgSum) / 2;
        S.ma[i] = maSum;
        S.vn[i] = maSum > 0 ? vnW / maSum : 0;
        S.u[i] = S.wetArea[i] > 1e-9 ? uW / S.wetArea[i] : 0;
        S.normal[i * 3] = nX;
        S.normal[i * 3 + 1] = nY;
        S.normal[i * 3 + 2] = nZ;
        // keel immersion at the strip centre
        {
          const bxk = 0;
          const byk = mesh.strips.keelY[i];
          const bzk = mesh.strips.zCentre[i];
          const tx = 2 * (qy * bzk - qz * byk);
          const ty = 2 * (qz * bxk - qx * bzk);
          const tz = 2 * (qx * byk - qy * bxk);
          const x = cgx + bxk + qw * tx + (qy * tz - qz * ty);
          const y = cgy + byk + qw * ty + (qz * tx - qx * tz);
          const z = cgz + bzk + qw * tz + (qx * ty - qy * tx);
          S.d[i] = patch.heightAt(x, z) - y;
        }
      }
      // added mass from the half-sections (diagonal about the CG, §V69)
      for (let hI = 0; hI < nh; hI++) {
        const ma = HMA[hI];
        if (ma <= 0) continue;
        const nX = HN[hI * 3];
        const nY = HN[hI * 3 + 1];
        const nZ = HN[hI * 3 + 2];
        const rx = HC[hI * 3] - cgx;
        const ry = HC[hI * 3 + 1] - cgy;
        const rz = HC[hI * 3 + 2] - cgz;
        const nbx = nX * bxx + nY * bxy + nZ * bxz;
        const nby = nX * byx + nY * byy + nZ * byz;
        const nbz = nX * bzx + nY * bzy + nZ * bzz;
        const rbx = rx * bxx + ry * bxy + rz * bxz;
        const rby = rx * byx + ry * byy + rz * byz;
        const rbz = rx * bzx + ry * bzy + rz * bzz;
        const mdz = ma * dz;
        Ax += mdz * nbx * nbx;
        Ay += mdz * nby * nby;
        const cxb = rby * nbz - rbz * nby;
        const cyb = rbz * nbx - rbx * nbz;
        const czb = rbx * nby - rby * nbx;
        dIx += mdz * cxb * cxb;
        dIy += mdz * cyb * cyb;
        dIz += mdz * (czb * czb + (HCW[hI] * HCW[hI]) / 8);
      }
    } else {
      S.c.fill(0);
      S.ma.fill(0);
      S.vn.fill(0);
      S.u.fill(0);
      S.sprayRoot.fill(0);
      S.d.fill(0);
    }
    const Az = prm.surgeAddedMassRatio * m * Math.min(1, (this.displacedVolume * rho) / m);

    if (prm.planing) {
      // ---- slam: inelastic momentum exchange, Gauss–Seidel over half-sections, with the SAME inverse
      //      mass rigid6 divides this substep's impulse by: m + min(A_old, A_new)
      const pa = this.prevAdded;
      const hp = this.hasPrev;
      this.gsInvM[0] = 1 / (m + (hp ? Math.min(pa[0], Ax) : Ax));
      this.gsInvM[1] = 1 / (m + (hp ? Math.min(pa[1], Ay) : Ay));
      this.gsInvM[2] = 1 / (m + (hp ? Math.min(pa[2], Az) : Az));
      this.gsInvI[0] = 1 / (mesh.inertia[0] + (hp ? Math.min(pa[3], dIx) : dIx));
      this.gsInvI[1] = 1 / (mesh.inertia[1] + (hp ? Math.min(pa[4], dIy) : dIy));
      this.gsInvI[2] = 1 / (mesh.inertia[2] + (hp ? Math.min(pa[5], dIz) : dIz));
      this.gsAxes[0] = bxx;
      this.gsAxes[1] = bxy;
      this.gsAxes[2] = bxz;
      this.gsAxes[3] = byx;
      this.gsAxes[4] = byy;
      this.gsAxes[5] = byz;
      this.gsAxes[6] = bzx;
      this.gsAxes[7] = bzy;
      this.gsAxes[8] = bzz;
      this.gv[0] = vx;
      this.gv[1] = vy;
      this.gv[2] = vz;
      this.gw[0] = wx;
      this.gw[1] = wy;
      this.gw[2] = wz;
      for (let hI = 0; hI < nh; hI++) {
        const ma = HMA[hI];
        const dA = (ma - this.prevMa[hI]) * dz;
        const strip = hI >> 1;
        if (hp) S.dmadt[strip] += (ma - this.prevMa[hI]) / h;
        if (!hp || dA === 0 || HA[hI] <= 1e-9) continue;
        const nX = HN[hI * 3];
        const nY = HN[hI * 3 + 1];
        const nZ = HN[hI * 3 + 2];
        const vn = -this.pointVelAlong(hI, nX, nY, nZ);
        if (vn <= 0) continue;
        const wInv = this.gsInvMass(hI, nX, nY, nZ);
        // V_n·dm_a/dt in BOTH directions while the section still penetrates (V_n > 0): a running
        // section whose wetted beam shrinks sheds the momentum flux it carried (a downward load). The
        // entry-only form halved the steady-flow heave/pitch damping U·sinτ·∂m_a/∂z and, with it,
        // left a 1.3 s limit cycle at C_v ≤ 3.7. A section moving OUT of the water (V_n ≤ 0) gets
        // nothing, so a landing still loses its momentum and is never handed it back (§V70).
        const J = dA > 0 ? (dA * vn) / (1 + dA * wInv) : dA * vn;
        S.slam[strip] += J;
        this.slamImpulse += J;
        this.gsApply(hI, nX, nY, nZ, J);
        const rx = HC[hI * 3] - cgx;
        const ry = HC[hI * 3 + 1] - cgy;
        const rz = HC[hI * 3 + 2] - cgz;
        const jx = J * nX;
        const jy = J * nY;
        const jz = J * nZ;
        slamJx += jx;
        slamJy += jy;
        slamJz += jz;
        slamLx += ry * jz - rz * jy;
        slamLy += rz * jx - rx * jz;
        slamLz += rx * jy - ry * jx;
        SF[hI * 3] += jx / h;
        SF[hI * 3 + 1] += jy / h;
        SF[hI * 3 + 2] += jz / h;
      }
      // ---- crossflow drag (normal ½ρ·C_Dc·c_half·V_n|V_n| per half, lateral ½ρ·C_Dc·A_side·V|V|) as
      //      velocity-level impulses in the SAME Gauss–Seidel pass: the explicit force form is stiff
      //      (a flat 25 m/s entry: B·h/m ≫ 2, measured bounce to +20 m/s at one substep).
      const halfRhoCd = 0.5 * rho * prm.crossflowDrag;
      for (let hI = 0; hI < nh; hI++) {
        if (HA[hI] <= 1e-9) continue;
        if (HMA[hI] > 0) this.gsDrag(hI, HN[hI * 3], HN[hI * 3 + 1], HN[hI * 3 + 2], halfRhoCd * 2 * HCW[hI] * (HMA[hI] / S.ma[hI >> 1]) * dz, h); // the half's share of ½ρ·C_Dc·2c
        const vLat = this.pointVelAlong(hI, bxx, bxy, bxz);
        const aSide = vLat > 0 ? this.sLatP[hI] : this.sLatM[hI];
        if (aSide > 0) this.gsDrag(hI, bxx, bxy, bxz, halfRhoCd * aSide, h);
      }
      for (let hI = 0; hI < nh; hI++) this.prevMa[hI] = HMA[hI];
      pa[0] = Ax;
      pa[1] = Ay;
      pa[2] = Az;
      pa[3] = dIx;
      pa[4] = dIy;
      pa[5] = dIz;
      this.hasPrev = true;
      this.fX += slamJx / h;
      this.fY += slamJy / h;
      this.fZ += slamJz / h;
      this.tX += slamLx / h;
      this.tY += slamLy / h;
      this.tZ += slamLz / h;

      // ---- ROTATING-FRAME ADDED-MASS LOAD: the m_a·∂V_n/∂t of a BODY-FIXED section includes the change
      //      of its normal velocity as the hull ROTATES in the stream, ∂V_n/∂t ⊃ N_b·(ω_b × v_b) — for
      //      pitch, m_a·q·u. rigid6 divides world accelerations by the added mass and cannot see it.
      //      Without it the heave–pitch mode had a limit cycle at C_v 3.5–3.9 that grew as the strips
      //      were refined (0.39° → 0.87°); with it the cycle is gone at every strip count. (Flipping its
      //      sign makes C_v 3–5 oscillate at 1.7–3.0°.)
      {
        const vbx = vx * bxx + vy * bxy + vz * bxz;
        const vby = vx * byx + vy * byy + vz * byz;
        const vbz = vx * bzx + vy * bzy + vz * bzz;
        const obx = wx * bxx + wy * bxy + wz * bxz;
        const oby = wx * byx + wy * byy + wz * byz;
        const obz = wx * bzx + wy * bzy + wz * bzz;
        const ocx = oby * vbz - obz * vby;
        const ocy = obz * vbx - obx * vbz;
        const ocz = obx * vby - oby * vbx;
        for (let hI = 0; hI < nh; hI++) {
          const ma = HMA[hI];
          if (ma <= 0) continue;
          const nX = HN[hI * 3];
          const nY = HN[hI * 3 + 1];
          const nZ = HN[hI * 3 + 2];
          const nbx = nX * bxx + nY * bxy + nZ * bxz;
          const nby = nX * byx + nY * byy + nZ * byz;
          const nbz = nX * bzx + nY * bzy + nZ * bzz;
          this.addHalfForce(hI, ma * dz * (nbx * ocx + nby * ocy + nbz * ocz));
        }
      }

      // ---- planing lift: −U·∂(m_a·V_n)/∂ξ per half-section, M sampled at half centroids, piecewise
      // linear. The momentum gained between two centres is placed at their shared boundary (half to each
      // wet neighbour). At the TRAILING section the half strip to the transom is extrapolated, then the
      // flux leaves with the wake (Kutta: nothing aft of the transom). Upwind direction = sign of the
      // CG's body-z speed; magnitude uses each half's own |u|.
      const LF = this.sLift;
      LF.fill(0);
      {
        const uCg = vx * bzx + vy * bzy + vz * bzz;
        const step = uCg >= 0 ? 1 : -1;
        const trail = uCg >= 0 ? 0 : ns - 1;
        for (let hI = 0; hI < nh; hI++) {
          if (HMA[hI] <= 0) continue;
          const i = hI >> 1;
          const side = hI & 1;
          const upS = i + step;
          const up = 2 * upS + side;
          const upWet = upS >= 0 && upS < ns && HMA[up] > 0;
          const mI = HMA[hI] * HVN[hI];
          const mUp = upWet ? HMA[up] * HVN[up] : 0;
          const lift = Math.abs(HU[hI]) * (mI - mUp);
          // steady part: V_n the section would have at this pose with the CG moving horizontally
          const vSt = -(vx * HN[hI * 3] + vz * HN[hI * 3 + 2]);
          const vStUp = upWet ? -(vx * HN[up * 3] + vz * HN[up * 3 + 2]) : 0;
          const liftSt = Math.abs(HU[hI]) * (HMA[hI] * vSt - (upWet ? HMA[up] * vStUp : 0));
          // share to the upwind section ramps with ITS wetted area (0 → ½): a hard ½/1 switch jumped the
          // pitch moment each time the keel entry point crossed a strip boundary
          const wUp = upWet ? 0.5 * Math.min(1, HA[up] / HA[hI]) : 0;
          const zc = mesh.strips.zCentre[i];
          // Garme on the STEADY part only (see `garmeANon`), evaluated where each piece of lift acts
          const cb = liftSt * this.transomFactor(zc + 0.5 * step * dz) + (lift - liftSt);
          if (cb > 0) {
            LF[hI] += (1 - wUp) * cb;
            if (upWet) LF[up] += wUp * cb;
          }
          if (i === trail) {
            const ext = wUp * (liftSt * this.transomFactor(zc - 0.25 * step * dz) + (lift - liftSt));
            if (ext > 0) LF[hI] += ext;
          }
        }
      }
      for (let hI = 0; hI < nh; hI++) {
        if (LF[hI] > 0 && HA[hI] > 1e-9) this.addHalfForce(hI, LF[hI]);
      }
    }

    // ---- SKIN FRICTION, ITTC-57 + ΔC_F on the SPRAY-ROOT-bounded wetted area (Savitsky 1964's
    //      pressure area S = λb²/cosβ): each running-surface triangle's clipped area is scaled by
    //      its strip's Wagner c / geometric c (≤ π/2, less once the chine is wet). Rn on the mean
    //      wetted length λb = A_plan/B, as Savitsky; the clipped (calm-water) area alone under-
    //      predicted friction by ~⅓ at planing speed.
    const FF = this.frictionForce;
    const FT = this.frictionTorque;
    FF[0] = FF[1] = FF[2] = FT[0] = FT[1] = FT[2] = 0;
    if (prm.viscous) {
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      let lRef = mesh.stemZ - mesh.transomZ;
      if (prm.planing && this.beamMax > 0) {
        let aPlan = 0;
        for (let i = 0; i < ns; i++) aPlan += 2 * S.c[i] * dz;
        if (aPlan > 0) lRef = Math.max(0.1 * lRef, aPlan / this.beamMax);
      }
      const Rn = (speed * lRef) / prm.nu;
      const lg = Math.log10(Rn) - 2;
      const cf = Rn > 1e5 ? 0.075 / (lg * lg) + prm.frictionAllowance : 0;
      const halfRhoCf = 0.5 * rho * cf;
      const W = this.wet;
      for (let j = 0; j < W.count; j++) {
        const hI = this.wHalf[j];
        let ratio = 1;
        if (prm.planing && hI >= 0 && this.hCg[hI] > 0) ratio = this.hCw[hI] / this.hCg[hI];
        const nnx = W.normal[j * 3];
        const nny = W.normal[j * 3 + 1];
        const nnz = W.normal[j * 3 + 2];
        const pvx = W.vel[j * 3];
        const pvy = W.vel[j * 3 + 1];
        const pvz = W.vel[j * 3 + 2];
        const vnn = pvx * nnx + pvy * nny + pvz * nnz;
        const tvx = pvx - vnn * nnx;
        const tvy = pvy - vnn * nny;
        const tvz = pvz - vnn * nnz;
        const tv = Math.sqrt(tvx * tvx + tvy * tvy + tvz * tvz);
        const c = -halfRhoCf * W.area[j] * ratio * tv;
        const fx = c * tvx;
        const fy = c * tvy;
        const fz = c * tvz;
        const rx = W.centroid[j * 3] - cgx;
        const ry = W.centroid[j * 3 + 1] - cgy;
        const rz = W.centroid[j * 3 + 2] - cgz;
        this.fX += fx;
        this.fY += fy;
        this.fZ += fz;
        this.tX += ry * fz - rz * fy;
        this.tY += rz * fx - rx * fz;
        this.tZ += rx * fy - ry * fx;
        FF[0] += fx;
        FF[1] += fy;
        FF[2] += fz;
        FT[0] += ry * fz - rz * fy;
        FT[1] += rz * fx - rx * fz;
        FT[2] += rx * fy - ry * fx;
        W.fy[j] += fy;
      }
    }

    // ---- V110 bound at the result, force and torque together
    this.rawForce[0] = this.fX;
    this.rawForce[1] = this.fY;
    this.rawForce[2] = this.fZ;
    const fMag = Math.sqrt(this.fX * this.fX + this.fY * this.fY + this.fZ * this.fZ);
    let s = 1;
    if (fMag > prm.maxAccel * m) s = (prm.maxAccel * m) / fMag;
    {
      const tbx = this.tX * bxx + this.tY * bxy + this.tZ * bxz;
      const tby = this.tX * byx + this.tY * byy + this.tZ * byz;
      const tbz = this.tX * bzx + this.tY * bzy + this.tZ * bzz;
      const alpha = Math.max(
        Math.abs(tbx) / mesh.inertia[0],
        Math.abs(tby) / mesh.inertia[1],
        Math.abs(tbz) / mesh.inertia[2],
      );
      if (alpha * s > prm.maxAngularAccel) s = prm.maxAngularAccel / alpha;
    }
    this.capScale = s;

    // ---- HydroSamples: each wet triangle carries its own hydrostatic+viscous fy plus its
    //      area share of its strip's dynamic force, all × s ⇒ Σ fy = load.force[1]
    const W = this.wet;
    for (let j = 0; j < W.count; j++) {
      const hI = this.wHalf[j];
      let fy = W.fy[j];
      if (hI >= 0 && this.hArea[hI] > 1e-9) fy += (SF[hI * 3 + 1] * W.area[j]) / this.hArea[hI];
      W.fy[j] = fy * s;
    }
    this.buildWakeLoad(this.fY * s);

    // ---- prop immersion (§3.1: s = smoothstep(−r, r, depth))
    {
      const [bx, by, bz] = mesh.propPoint;
      const tx = 2 * (qy * bz - qz * by);
      const ty = 2 * (qz * bx - qx * bz);
      const tz = 2 * (qx * by - qy * bx);
      const x = cgx + bx + qw * tx + (qy * tz - qz * ty);
      const y = cgy + by + qw * ty + (qz * tx - qx * tz);
      const z = cgz + bz + qw * tz + (qx * ty - qy * tx);
      this.propDepth = patch.heightAt(x, z) - y;
      const r = mesh.propRadius;
      const e = Math.min(1, Math.max(0, (this.propDepth + r) / (2 * r)));
      this.propImmersion = e * e * (3 - 2 * e);
    }

    const L = this.load;
    L.force[0] = this.fX * s;
    L.force[1] = this.fY * s;
    L.force[2] = this.fZ * s;
    L.torque[0] = this.tX * s;
    L.torque[1] = this.tY * s;
    L.torque[2] = this.tZ * s;
    L.addedMass[0] = Ax;
    L.addedMass[1] = Ay;
    L.addedMass[2] = Az;
    L.addedInertia[0] = dIx;
    L.addedInertia[1] = dIy;
    L.addedInertia[2] = dIz;
    if (out) {
      for (let c = 0; c < 3; c++) {
        out.force[c] += L.force[c];
        out.torque[c] += L.torque[c];
        out.addedMass[c] += L.addedMass[c];
        out.addedInertia[c] += L.addedInertia[c];
      }
    }
  }

  /** column-sum the signed wet samples into ≥ 0 plan-cell wake loads whose sum is max(0, netFy) */
  private buildWakeLoad(netFy: number): void {
    const W = this.wet;
    const K = this.wake;
    const patch = this.patch;
    const nu = patch.nu;
    const nw = patch.nw;
    const list = this.cellList;
    let n = 0;
    for (let j = 0; j < W.count; j++) {
      const x = W.centroid[j * 3];
      const z = W.centroid[j * 3 + 2];
      const rx = x - patch.ox;
      const rz = z - patch.oz;
      let iu = Math.floor((rx * patch.e1x + rz * patch.e1z) / patch.du);
      let iw = Math.floor((-rx * patch.e1z + rz * patch.e1x) / patch.dw);
      iu = iu < 0 ? 0 : iu >= nu ? nu - 1 : iu;
      iw = iw < 0 ? 0 : iw >= nw ? nw - 1 : iw;
      const c = iw * nu + iu;
      const aPlan = W.area[j] * Math.abs(W.normal[j * 3 + 1]);
      if (this.cellA[c] === 0 && this.cellFy[c] === 0) list[n++] = c;
      this.cellFy[c] += W.fy[j];
      // weight position/depth by plan area, with a floor so vertical faces still place their load
      const wgt = aPlan + 1e-6 * W.area[j];
      this.cellA[c] += wgt;
      this.cellAx[c] += wgt * x;
      this.cellAz[c] += wgt * z;
      this.cellAd[c] += wgt * Math.max(0, W.depth[j]);
    }
    let pos = 0;
    for (let k = 0; k < n; k++) {
      const f = this.cellFy[list[k]];
      if (f > 0) pos += f;
    }
    const target = netFy > 0 ? netFy : 0;
    const scale = pos > 0 ? target / pos : 0;
    let m = 0;
    let sum = 0;
    for (let k = 0; k < n; k++) {
      const c = list[k];
      const f = this.cellFy[c];
      const a = this.cellA[c];
      if (f > 0 && scale > 0) {
        K.x[m] = this.cellAx[c] / a;
        K.z[m] = this.cellAz[c] / a;
        K.fy[m] = f * scale;
        K.sigma[m] = 0.5 * Math.sqrt(a);
        K.depth[m] = this.cellAd[c] / a;
        sum += K.fy[m];
        m++;
      }
      this.cellFy[c] = 0;
      this.cellA[c] = 0;
      this.cellAx[c] = 0;
      this.cellAz[c] = 0;
      this.cellAd[c] = 0;
    }
    K.count = m;
    K.deficit = netFy - sum;
    K.rescale = scale;
  }

  /** GS working point velocity of half-section hI's wet centroid along world direction d */
  private pointVelAlong(hI: number, dx: number, dy: number, dz: number): number {
    const C = this.hCentroid;
    const rx = C[hI * 3] - this.cgx;
    const ry = C[hI * 3 + 1] - this.cgy;
    const rz = C[hI * 3 + 2] - this.cgz;
    const gv = this.gv;
    const gw = this.gw;
    const pvx = gv[0] + (gw[1] * rz - gw[2] * ry);
    const pvy = gv[1] + (gw[2] * rx - gw[0] * rz);
    const pvz = gv[2] + (gw[0] * ry - gw[1] * rx);
    return pvx * dx + pvy * dy + pvz * dz;
  }

  /** j6 ← body [d_b; r_b×d_b] at half-section hI; returns the effective inverse mass j6ᵀ·diag(invM, invI)·j6 */
  private gsInvMass(hI: number, dx: number, dy: number, dz: number): number {
    const C = this.hCentroid;
    const A = this.gsAxes;
    const rx = C[hI * 3] - this.cgx;
    const ry = C[hI * 3 + 1] - this.cgy;
    const rz = C[hI * 3 + 2] - this.cgz;
    const dbx = dx * A[0] + dy * A[1] + dz * A[2];
    const dby = dx * A[3] + dy * A[4] + dz * A[5];
    const dbz = dx * A[6] + dy * A[7] + dz * A[8];
    const rbx = rx * A[0] + ry * A[1] + rz * A[2];
    const rby = rx * A[3] + ry * A[4] + rz * A[5];
    const rbz = rx * A[6] + ry * A[7] + rz * A[8];
    const j = this.j6;
    j[0] = dbx;
    j[1] = dby;
    j[2] = dbz;
    j[3] = rby * dbz - rbz * dby;
    j[4] = rbz * dbx - rbx * dbz;
    j[5] = rbx * dby - rby * dbx;
    const iM = this.gsInvM;
    const iI = this.gsInvI;
    return j[0] * j[0] * iM[0] + j[1] * j[1] * iM[1] + j[2] * j[2] * iM[2] + j[3] * j[3] * iI[0] + j[4] * j[4] * iI[1] + j[5] * j[5] * iI[2];
  }

  /** apply impulse J along the direction of the last gsInvMass call to the GS working velocities */
  private gsApply(_hI: number, _dx: number, _dy: number, _dz: number, J: number): void {
    const A = this.gsAxes;
    const j = this.j6;
    const iM = this.gsInvM;
    const iI = this.gsInvI;
    const lvx = J * j[0] * iM[0];
    const lvy = J * j[1] * iM[1];
    const lvz = J * j[2] * iM[2];
    this.gv[0] += lvx * A[0] + lvy * A[3] + lvz * A[6];
    this.gv[1] += lvx * A[1] + lvy * A[4] + lvz * A[7];
    this.gv[2] += lvx * A[2] + lvy * A[5] + lvz * A[8];
    const awx = J * j[3] * iI[0];
    const awy = J * j[4] * iI[1];
    const awz = J * j[5] * iI[2];
    this.gw[0] += awx * A[0] + awy * A[3] + awz * A[6];
    this.gw[1] += awx * A[1] + awy * A[4] + awz * A[7];
    this.gw[2] += awx * A[2] + awy * A[5] + awz * A[8];
  }

  /** a force of magnitude f along half-section hI's normal, at its wet centroid, into totals and samples */
  private addHalfForce(hI: number, f: number): void {
    const N = this.hNormal;
    const C = this.hCentroid;
    const fx = f * N[hI * 3];
    const fy = f * N[hI * 3 + 1];
    const fz = f * N[hI * 3 + 2];
    this.addForceAt(hI, fx, fy, fz, C[hI * 3] - this.cgx, C[hI * 3 + 1] - this.cgy, C[hI * 3 + 2] - this.cgz);
  }

  private addForceAt(hI: number, fx: number, fy: number, fz: number, rx: number, ry: number, rz: number): void {
    const SF = this.sForce;
    SF[hI * 3] += fx;
    SF[hI * 3 + 1] += fy;
    SF[hI * 3 + 2] += fz;
    this.fX += fx;
    this.fY += fy;
    this.fZ += fz;
    this.tX += ry * fz - rz * fy;
    this.tY += rz * fx - rx * fz;
    this.tZ += rx * fy - ry * fx;
  }

  /**
   * Quadratic drag −coef·V|V| along world unit d at half-section hI's wet centroid, as a linearised
   * implicit impulse over h (never reverses the point). Applied to the GS velocities and accumulated
   * into the half-section force and the totals as impulse/h.
   */
  private gsDrag(hI: number, dx: number, dy: number, dz: number, coef: number, h: number): void {
    const V = this.pointVelAlong(hI, dx, dy, dz);
    if (V === 0) return;
    const w = this.gsInvMass(hI, dx, dy, dz);
    // linearised backward Euler on m_eff·dV/dt = −coef·|V|·V at this point: V' = V/(1 + coef·|V|·h·w).
    // It removes only a FRACTION of the point's velocity (an under-relaxed Gauss–Seidel step), so a
    // sweep over near-collinear sections does not overshoot the way a per-point "stop" clamp did
    // (measured: +11 m/s rebound at C_Dc 2000); at physical coefficients it equals the explicit drag.
    const k = coef * Math.abs(V) * h;
    const J = (-k * V) / (1 + k * w);
    this.gsApply(hI, dx, dy, dz, J);
    const C = this.hCentroid;
    this.addForceAt(hI, (J * dx) / h, (J * dy) / h, (J * dz) / h, C[hI * 3] - this.cgx, C[hI * 3 + 1] - this.cgy, C[hI * 3 + 2] - this.cgz);
  }

  /** Garme C_T at body-frame z (relative to CG); 1 when the reduction is off or the hull is at rest */
  private transomFactor(bodyZ: number): number {
    if (this.garmeK === 0) return 1;
    const xT = this.uForward ? bodyZ - this.mesh.transomZ : this.mesh.stemZ - bodyZ;
    return xT <= 0 ? 0 : Math.tanh(this.garmeK * xT);
  }

  private latX = 1;
  private latY = 0;
  private latZ = 0;

  private emit(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
    da: number,
    db: number,
    dc: number,
    strip: number,
  ): void {
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const qx = cx - ax;
    const qy = cy - ay;
    const qz = cz - az;
    const nx = uy * qz - uz * qy;
    const ny = uz * qx - ux * qz;
    const nz = ux * qy - uy * qx;
    const A2 = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (A2 < 1e-12) return;
    const A = 0.5 * A2;
    const nnx = nx / A2;
    const nny = ny / A2;
    const nnz = nz / A2;
    const depth = (da + db + dc) / 3;
    const gx = (ax + bx + cx) / 3;
    const gy = (ay + by + cy) / 3;
    const gz = (az + bz + cz) / 3;
    const rx = gx - this.cgx;
    const ry = gy - this.cgy;
    const rz = gz - this.cgz;
    const pvx = this.vx + (this.wy * rz - this.wz * ry);
    const pvy = this.vy + (this.wz * rx - this.wx * rz);
    const pvz = this.vz + (this.wx * ry - this.wy * rx);

    // hydrostatic (force at the centroid is exact; torque below uses the centre of pressure),
    // × Garme's near-transom reduction at this triangle's distance from the trailing edge
    const ct = this.transomFactor(rx * this.bzX + ry * this.bzY + rz * this.bzZ);
    const ps = -this.params.rho * this.params.gravity * depth * A * ct;
    const fx = ps * nnx;
    const fy = ps * nny;
    const fz = ps * nnz;
    this.fX += fx;
    this.fY += fy;
    this.fZ += fz;
    // hydrostatic torque at the TRUE centre of pressure: for pressure linear over the
    // triangle, ∫d·r dA = A/12·[(Σd)(Σr) + Σd_i·r_i]. The centroid form depends on how a
    // clipped quad was split, and the split follows the winding, which is MIRRORED port
    // vs starboard — it made a symmetric hull at rest yaw (measured −70 N·m, 20° in 20 s).
    {
      const sd = da + db + dc;
      const k12 = A / 12;
      const mx = k12 * (sd * (ax + bx + cx) + da * ax + db * bx + dc * cx) - depth * A * this.cgx;
      const my = k12 * (sd * (ay + by + cy) + da * ay + db * by + dc * cy) - depth * A * this.cgy;
      const mz = k12 * (sd * (az + bz + cz) + da * az + db * bz + dc * cz) - depth * A * this.cgz;
      // τ = (∫d·(r−cg) dA) × (−ρg·C_T·n̂)
      const k = -this.params.rho * this.params.gravity * ct;
      const hx = k * nnx;
      const hy = k * nny;
      const hz = k * nnz;
      this.tX += my * hz - mz * hy;
      this.tY += mz * hx - mx * hz;
      this.tZ += mx * hy - my * hx;
    }
    this.wettedArea += A;
    this.displacedVolume += -depth * A * nny;

    const W = this.wet;
    const j = W.count++;
    W.centroid[j * 3] = gx;
    W.centroid[j * 3 + 1] = gy;
    W.centroid[j * 3 + 2] = gz;
    W.normal[j * 3] = nnx;
    W.normal[j * 3 + 1] = nny;
    W.normal[j * 3 + 2] = nnz;
    W.area[j] = A;
    W.depth[j] = depth;
    W.vel[j * 3] = pvx;
    W.vel[j * 3 + 1] = pvy;
    W.vel[j * 3 + 2] = pvz;
    W.strip[j] = strip;
    W.fy[j] = fy;
    const half = strip >= 0 ? 2 * strip + (rx * this.latX + ry * this.latY + rz * this.latZ >= 0 ? 1 : 0) : -1;
    this.wHalf[j] = half;
    W.sigma[j] = 0.5 * Math.sqrt(A * Math.abs(nny));

    if (half >= 0) {
      this.sSx[half] -= nnx * A;
      this.sSy[half] -= nny * A;
      this.sSz[half] -= nnz * A;
      const lat = nnx * this.latX + nny * this.latY + nnz * this.latZ;
      if (lat > 0) this.sLatP[half] += lat * A;
      else this.sLatM[half] -= lat * A;
      this.hArea[half] += A;
      this.hCentroid[half * 3] += gx * A;
      this.hCentroid[half * 3 + 1] += gy * A;
      this.hCentroid[half * 3 + 2] += gz * A;
    }
  }

  private pushSegment(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    t0x: number,
    t0y: number,
    t0z: number,
    t1x: number,
    t1y: number,
    t1z: number,
    t2x: number,
    t2y: number,
    t2z: number,
  ): void {
    const S = this.waterline;
    const j = S.count++;
    S.a[j * 3] = ax;
    S.a[j * 3 + 1] = ay;
    S.a[j * 3 + 2] = az;
    S.b[j * 3] = bx;
    S.b[j * 3 + 1] = by;
    S.b[j * 3 + 2] = bz;
    const ux = t1x - t0x;
    const uy = t1y - t0y;
    const uz = t1z - t0z;
    const qx = t2x - t0x;
    const qy = t2y - t0y;
    const qz = t2z - t0z;
    const nx = uy * qz - uz * qy;
    const ny = uz * qx - ux * qz;
    const nz = ux * qy - uy * qx;
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    const rx = 0.5 * (ax + bx) - this.cgx;
    const ry = 0.5 * (ay + by) - this.cgy;
    const rz = 0.5 * (az + bz) - this.cgz;
    const pvx = this.vx + (this.wy * rz - this.wz * ry);
    const pvy = this.vy + (this.wz * rx - this.wx * rz);
    const pvz = this.vz + (this.wx * ry - this.wy * rx);
    S.vn[j] = (pvx * nx + pvy * ny + pvz * nz) / nl;
  }
}

/**
 * Adaptive substep count (§2.6): N = clamp(ceil(B₃₃·dt/(m_eff·0.8)), 2, 4) with the
 * planing heave damping B₃₃ ≈ |U|·max m_a read from the LAST contact (sim state only, §V2).
 */
export function planingSubsteps(hw: HullWater, state: Readonly<Rigid6State>, dt: number): number {
  let maMax = 0;
  for (let i = 0; i < hw.sections.count; i++) if (hw.sections.ma[i] > maMax) maMax = hw.sections.ma[i];
  const v = state.velocity;
  const U = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  const mEff = hw.mesh.mass + hw.load.addedMass[1];
  const n = Math.ceil((U * maMax * dt) / (mEff * 0.8));
  return n < 2 ? 2 : n > 4 ? 4 : n;
}
