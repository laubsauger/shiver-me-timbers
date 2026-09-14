/**
 * The in-game driver of the GPU wake (§T W2b, docs/wake/w2b-integration.md):
 * the one place the sim tick and the render frame meet the solver.
 *
 *   tick(pose, samples, bowAhead, dt)   FIXED TICK (§V2). Anchors the domain on
 *                                       the hero vessel's SIM pose (§V105, never
 *                                       the camera), uploads that tick's
 *                                       HydroSamples, and banks the sim time.
 *   step(renderer)                      RENDER FRAME. At most ONE splat + ONE
 *                                       compute group (§V104), advanced by the
 *                                       sim time banked since the last dispatch,
 *                                       and nothing at all when no tick ran.
 *
 * WHY THE SPLIT. §V2 wants the wake advanced by sim time, §V104 wants one
 * compute group per frame, and the loop runs 0..N ticks per frame. Stepping
 * inside the tick would dispatch N groups on a slow frame; stepping on frame
 * time would make the pattern a function of the frame rate. Banking tick dt
 * and dispatching once gives both: the GPU integrates exactly the sim seconds
 * that elapsed, in one group. The integrator is exact for any Δt (§V103), so
 * merging ticks changes quality (forcing held over the merged step), not
 * physics. A frame slower than WAKE_MAX_DT (10 fps) drops the excess — the
 * wake is visual-only (§V8 amendment), so a hitch cannot desync a hull.
 *
 * §V28: a non-finite pose leaves the centre where it was (`setCenter` guards)
 * and a vessel with any non-finite sample is dropped whole
 * (`WakeSourceBuffer.pushVessel`); a non-finite or negative dt banks nothing.
 *
 * §T.180: the tick also measures the domain's own velocity (the unsnapped
 * anchor's motion per tick) for the moving-domain sponge
 * (`spongeAdvectionScale`), and takes the hero's prop jets (`propWash.ts`) as
 * signed non-hull sources.
 */
import type * as THREE from 'three/webgpu';
import { rotateVec } from '../core/quat';
import { WakeSolverGpu } from './wakeSolverPasses';
import { WAKE_SPLAT_RADIUS_SIGMAS, WakeSourceBuffer, splatSigma, vesselDomainWeight, wakeAnchor, type HydroSample } from './wakeSolverMath';
import { propJetSample, type PropWashInput } from './propWash';

/** §T.195: vessels one domain draws — the hero and up to 7 rivals (the sim foam compiles this many slots) */
export const WAKE_MAX_VESSELS = 8;

/**
 * §T.195 one NON-HERO vessel's wake input for this tick: its hull wake load samples, prop jets and plan pose, ALL of
 * one step of that vessel (a rival: the fleet's last collected step, `BoatFleet.effects`). Visual-only (§V8a).
 */
export interface VesselWakeInput {
  readonly samples: readonly HydroSample[];
  readonly jets: readonly PropWashInput[];
  /** plan position and velocity of that step (m, m/s) */
  readonly x: number;
  readonly z: number;
  readonly vx: number;
  readonly vz: number;
}

/** what the domain took of one vessel this tick (slot 0 = the hero) — the sim foam's per-vessel churn reads it */
export interface WakeVesselSlot {
  x: number;
  z: number;
  vx: number;
  vz: number;
  /** plan radius that holds every sample and its splat reach (m) */
  radius: number;
  /** domain-edge weight its fy were scaled by (1 for the hero) */
  weight: number;
  /** deepest force-carrying hull sample (m) */
  depth: number;
}

/** a domain moving faster than this between ticks was teleported, not sailed (m/s) */
export const WAKE_SIM_MAX_DOMAIN_SPEED = 120;

export interface WakeSimTier {
  /** grid resolution (power of two) */
  n: number;
  /** texel size (m) */
  texel: number;
  /**
   * §T.199 NEAR-HULL TIER: a second solver on a finer texel, anchored on the hero's own hull (not `bowAhead`), fed the
   * same sources, stepped in the SAME compute group (§V104). The drawn surface and the sim foam cross-fade to it inside
   * its interior (flowfoam simInjection/simFoam). Absent: the single-tier graph, bit-identical (docs/wake/w7-speedboat-look.md §3).
   */
  near?: { readonly n: number; readonly texel: number };
}

/** §T.199 how fast (m/s) the near tier's held stem may walk aft when the wetted stem does (a flying bow) */
const NEAR_STEM_RELAX = 2;

/** §T.199 the near tier's blend: 0 at the inner edge of its sponge, 1 once this many sponge widths further in */
export const WAKE_NEAR_BLEND_WIDTHS = 0.5;

/**
 * §T.199 where the near tier puts the hero's stem: at the FORWARD EDGE of its full-weight interior, so the bow wave lip
 * is drawn by the near tier and the whole rest of the full-weight region lies astern (a planing hull, Fr_L > 1,
 * radiates nothing ahead of her stem). Distance of the stem ahead of the domain centre (m).
 */
export function wakeNearStemLead(n: number, texel: number, spongeWidth: number): number {
  return (0.5 - spongeWidth * (1 + WAKE_NEAR_BLEND_WIDTHS)) * n * texel;
}

/** the hero pose the domain anchors on — ShipState's own fields */
export interface WakeSimPose {
  readonly position: readonly number[];
  readonly quaternion: readonly number[];
  /** §T.195 world velocity (m/s) — her churn slot; absent = at rest */
  readonly velocity?: readonly number[];
}

export class WakeSim {
  readonly solver: WakeSolverGpu;
  readonly sources: WakeSourceBuffer;
  /** sim seconds banked by ticks since the last dispatch */
  private pendingDt = 0;
  /** a tick ran since the last dispatch (a centre move needs its scroll dispatched) */
  private dirty = false;
  /** last tick's unsnapped anchor — the domain velocity is its motion per tick */
  private anchorX = Number.NaN;
  private anchorZ = Number.NaN;
  /** the domain's velocity (m/s) the sponge was last scaled for */
  readonly domainVelocity = { x: 0, z: 0 };
  private readonly jetScratch: HydroSample = { x: 0, z: 0, fy: 0, footprint: 0, depth: 0 };
  /** §T.195 the vessels this tick drew, hero first; `vesselCount` live */
  readonly vessels: WakeVesselSlot[] = Array.from({ length: WAKE_MAX_VESSELS }, () => ({ x: 0, z: 0, vx: 0, vz: 0, radius: 0, weight: 0, depth: 0 }));
  vesselCount = 0;
  /** §T.195 per tick: rivals outside the domain (weight 0), and rivals skipped whole for want of source capacity */
  vesselsCulled = 0;
  vesselsOverflowed = 0;
  private readonly order: number[] = [];

  /** §T.199 the near-hull tier's solver and its own source buffer (rivals weighted against ITS domain), or null */
  readonly near: WakeSolverGpu | null;
  readonly nearSources: WakeSourceBuffer | null;
  private nearAnchorX = Number.NaN;
  /** §T.199 the held wetted-stem distance ahead of the hero origin (m) the near tier leads with */
  private nearStem = Number.NaN;
  private nearAnchorZ = Number.NaN;
  /** §T.199 debug/cost A/B only: false skips the near solver's dispatches (its surface then freezes) */
  nearStepping = true;
  /** both tiers' dispatches, concatenated once (one group, §V104) */
  private readonly groupNodes: readonly unknown[];

  constructor(tier: WakeSimTier) {
    this.solver = new WakeSolverGpu({ n: tier.n, texel: tier.texel });
    this.sources = new WakeSourceBuffer();
    this.near = tier.near ? new WakeSolverGpu({ n: tier.near.n, texel: tier.near.texel }) : null;
    this.nearSources = tier.near ? new WakeSourceBuffer() : null;
    this.groupNodes = this.near ? [...this.solver.computeNodes, ...this.near.computeNodes] : this.solver.computeNodes;
  }

  /** §T.199 boot warm-up of every solver's pipelines (flowfoam `warmAsync`) */
  compileAsync(renderer: THREE.WebGPURenderer): Promise<unknown> {
    return this.near ? Promise.all([this.solver.compileAsync(renderer), this.near.compileAsync(renderer)]) : this.solver.compileAsync(renderer);
  }

  /**
   * FIXED TICK. `bowAhead` is the stem's distance forward of the vessel origin
   * along her hull axis (m) — the anchor keeps the bow wave out of the front
   * sponge (`wakeAnchor`). The domain is a function of sim state only.
   */
  tick(
    pose: WakeSimPose,
    samples: readonly HydroSample[],
    bowAhead: number,
    dt: number,
    jets: readonly PropWashInput[] = [],
    others: readonly VesselWakeInput[] = [],
  ): void {
    const { solver } = this;
    const fwd = rotateVec(pose.quaternion as [number, number, number, number], [0, 0, 1]);
    const clearance = 4 * splatSigma(0, solver.texel, solver.n);
    const c = wakeAnchor(pose.position[0], pose.position[2], fwd[0], fwd[2], bowAhead, solver.domain, solver.sponge, clearance);
    if (Number.isFinite(c.x) && Number.isFinite(c.z) && Number.isFinite(dt) && dt > 0) {
      let vx = (c.x - this.anchorX) / dt;
      let vz = (c.z - this.anchorZ) / dt;
      // first tick, or a teleport faster than anything that floats: the domain is at rest this tick
      if (!Number.isFinite(vx) || !Number.isFinite(vz) || Math.hypot(vx, vz) > WAKE_SIM_MAX_DOMAIN_SPEED) vx = vz = 0;
      this.anchorX = c.x;
      this.anchorZ = c.z;
      this.domainVelocity.x = vx;
      this.domainVelocity.z = vz;
      solver.setDomainVelocity(vx, vz);
    }
    solver.setCenter(c.x, c.z);
    this.sources.clear();
    this.sources.pushVessel(samples);
    for (const j of jets) {
      const q = propJetSample(j, this.jetScratch);
      if (q) this.sources.pushJet(q.x, q.z, q.fy, q.footprint, q.depth);
    }
    const v = pose.velocity;
    this.recordVessel(0, pose.position[0], pose.position[2], v ? v[0] : 0, v ? v[2] : 0, samples, 1);
    this.vesselCount = 1;
    const counts = this.pushOthers(pose.position[0], pose.position[2], others, solver, this.sources, true);
    this.vesselsCulled = counts.culled;
    this.vesselsOverflowed = counts.overflowed;
    solver.setSources(this.sources);
    if (this.near && this.nearSources) this.tickNear(pose, fwd, samples, bowAhead, dt, jets, others);
    if (Number.isFinite(dt) && dt > 0) this.pendingDt += dt;
    this.dirty = true;
  }

  /**
   * §T.199 THE NEAR TIER'S TICK. Its anchor is the hero's STEM as her own samples put it (the forward-most sample
   * centre plus its footprint along her heading), capped at `bowAhead` — a page that pushes `bowAhead` forward to keep
   * rivals ahead in the 448 m domain (speedboatFrame: stem + 120 m) would otherwise leave her outside a 128 m near
   * domain — placed `wakeNearStemLead` ahead of the centre. Same hero samples and jets; rivals by their weight
   * against THIS domain. §V105: sim pose and sim samples only.
   */
  private tickNear(
    pose: WakeSimPose,
    fwd: readonly number[],
    samples: readonly HydroSample[],
    bowAhead: number,
    dt: number,
    jets: readonly PropWashInput[],
    others: readonly VesselWakeInput[],
  ): void {
    const near = this.near!;
    const buf = this.nearSources!;
    const flen = Math.hypot(fwd[0], fwd[2]);
    const fx = flen > 1e-9 ? fwd[0] / flen : 0;
    const fz = flen > 1e-9 ? fwd[2] / flen : 1;
    // a hull is far smaller than a quarter of the near domain: a sample further than that from her origin is not her
    // wetted stem (a stale contact across a teleport/respawn) and is not read
    const bound = near.domain / 4;
    let stem = -Infinity;
    for (const q of samples) {
      if (!(Math.hypot(q.x - pose.position[0], q.z - pose.position[2]) <= bound)) continue;
      const a = (q.x - pose.position[0]) * fx + (q.z - pose.position[2]) * fz + Math.max(0, q.footprint);
      if (Number.isFinite(a) && a > stem) stem = a;
    }
    // a hull that flies (few or no wet samples: measured live, 3 of ~30 at a wave jump) must not drag the domain after
    // its wet transom or out to `bowAhead` — that jump scrolled the whole grid out and wiped it. The wetted stem is
    // HELD and only walks aft at NEAR_STEM_RELAX m/s, so a bow that lifts for a moment leaves the domain where it was.
    const cap = Math.min(bound, Number.isFinite(bowAhead) ? bowAhead : bound);
    const held = Number.isFinite(this.nearStem) ? this.nearStem - NEAR_STEM_RELAX * (Number.isFinite(dt) && dt > 0 ? dt : 0) : -Infinity;
    const est = Math.max(-bound, Math.min(cap, Math.max(stem, held)));
    const ahead = Number.isFinite(est) ? est : Math.min(cap, 0);
    this.nearStem = ahead;
    const lead = ahead - wakeNearStemLead(near.n, near.texel, near.sponge.width);
    const c = { x: pose.position[0] + fx * lead, z: pose.position[2] + fz * lead };
    if (Number.isFinite(c.x) && Number.isFinite(c.z) && Number.isFinite(dt) && dt > 0) {
      let vx = (c.x - this.nearAnchorX) / dt;
      let vz = (c.z - this.nearAnchorZ) / dt;
      if (!Number.isFinite(vx) || !Number.isFinite(vz) || Math.hypot(vx, vz) > WAKE_SIM_MAX_DOMAIN_SPEED) {
        vx = vz = 0;
        // a teleport: the held stem belongs to the place she left — re-lead from this tick's own samples
        if (Number.isFinite(this.nearAnchorX) && Number.isFinite(stem)) {
          this.nearStem = Math.max(-bound, Math.min(cap, stem));
          const relead = this.nearStem - wakeNearStemLead(near.n, near.texel, near.sponge.width);
          c.x = pose.position[0] + fx * relead;
          c.z = pose.position[2] + fz * relead;
        }
      }
      this.nearAnchorX = c.x;
      this.nearAnchorZ = c.z;
      near.setDomainVelocity(vx, vz);
    }
    near.setCenter(c.x, c.z);
    buf.clear();
    buf.pushVessel(samples);
    for (const j of jets) {
      const q = propJetSample(j, this.jetScratch);
      if (q) buf.pushJet(q.x, q.z, q.fy, q.footprint, q.depth);
    }
    this.pushOthers(pose.position[0], pose.position[2], others, near, buf, false);
    near.setSources(buf);
  }

  /**
   * §T.195 THE RIVALS, into the SAME source buffer as the hero (one splat, one group, §V104). Nearest the hero first
   * (ties by index — deterministic), at most WAKE_MAX_VESSELS − 1; each scaled by `vesselDomainWeight` against the
   * centre this tick just snapped to, dropped whole at weight 0 or when her samples + jets would not all fit.
   */
  private pushOthers(
    hx: number,
    hz: number,
    others: readonly VesselWakeInput[],
    solver: WakeSolverGpu,
    sources: WakeSourceBuffer,
    record: boolean,
  ): { culled: number; overflowed: number } {
    const counts = { culled: 0, overflowed: 0 };
    if (others.length === 0) return counts;
    const { order } = this;
    let taken = record ? this.vesselCount : 1;
    order.length = 0;
    for (let i = 0; i < others.length; i++) order.push(i);
    const d2 = (i: number): number => {
      const d = (others[i].x - hx) ** 2 + (others[i].z - hz) ** 2;
      return Number.isFinite(d) ? d : Infinity;
    };
    order.sort((a, b) => d2(a) - d2(b) || a - b);
    for (const i of order) {
      const o = others[i];
      if (taken >= WAKE_MAX_VESSELS) {
        counts.overflowed++;
        continue;
      }
      const { radius } = vesselExtent(o.x, o.z, o.samples);
      const reach = WAKE_SPLAT_RADIUS_SIGMAS * splatSigma(maxFootprint(o.samples, o.jets), solver.texel, solver.n);
      const weight = vesselDomainWeight(o.x, o.z, radius, reach, solver.centerX, solver.centerZ, solver.domain, solver.sponge);
      if (!(weight > 0)) {
        counts.culled++;
        continue;
      }
      if (sources.count + sources.jetCount + o.samples.length + o.jets.length > sources.capacity) {
        counts.overflowed++;
        continue;
      }
      if (sources.pushVessel(o.samples, weight) === 0 && o.samples.length > 0) {
        counts.culled++;
        continue;
      }
      for (const j of o.jets) {
        const q = propJetSample(j, this.jetScratch);
        if (q) sources.pushJet(q.x, q.z, q.fy * weight, q.footprint, q.depth);
      }
      if (record) {
        this.recordVessel(this.vesselCount, o.x, o.z, o.vx, o.vz, o.samples, weight);
        this.vesselCount++;
      }
      taken++;
    }
    return counts;
  }

  private recordVessel(k: number, x: number, z: number, vx: number, vz: number, samples: readonly HydroSample[], weight: number): void {
    const slot = this.vessels[k];
    const ext = vesselExtent(x, z, samples);
    slot.x = x;
    slot.z = z;
    slot.vx = Number.isFinite(vx) ? vx : 0;
    slot.vz = Number.isFinite(vz) ? vz : 0;
    slot.radius = ext.radius;
    slot.weight = weight;
    slot.depth = ext.depth;
  }

  /** RENDER FRAME: one splat + one compute group if a tick ran; returns whether it dispatched */
  step(renderer: THREE.WebGPURenderer): boolean {
    if (!this.dirty) return false;
    if (this.near && this.nearStepping) WakeSolverGpu.stepGroup(renderer, [this.solver, this.near], this.groupNodes, this.pendingDt);
    else this.solver.step(renderer, this.pendingDt);
    this.pendingDt = 0;
    this.dirty = false;
    return true;
  }

  dispose(): void {
    this.solver.dispose();
    this.near?.dispose();
  }
}

/** plan radius about (x, z) holding every sample's centre plus its footprint, and the deepest force-carrying sample */
export function vesselExtent(x: number, z: number, samples: readonly HydroSample[]): { radius: number; depth: number } {
  let r = 0;
  let depth = 0;
  for (const s of samples) {
    const d = Math.hypot(s.x - x, s.z - z) + Math.max(0, s.footprint);
    if (d > r && Number.isFinite(d)) r = d;
    if (s.fy > 0 && s.depth > depth) depth = s.depth;
  }
  return { radius: r, depth };
}

function maxFootprint(samples: readonly HydroSample[], jets: readonly PropWashInput[]): number {
  let f = 0;
  for (const s of samples) if (s.footprint > f) f = s.footprint;
  // a jet's splat width is max(r, d) (propJetSample); a disc of ≤ 1 m² never exceeds a metre
  for (const j of jets) {
    const w = Math.max(Math.sqrt(Math.max(0, j.discArea) / Math.PI), Math.max(0, j.depth));
    if (w > f && Number.isFinite(w)) f = w;
  }
  return f;
}
