/**
 * §V.8 — THE SHIP FLOATS ON THE WAKE SHE IS DRAWN SITTING IN.
 *
 * `d9e8e22` added `flowFoam.wakeHeightNode` to the ocean material's
 * `positionNode`, so the DRAWN surface carries wake elevation. Until
 * `CpuOcean.setWakeField` existed, `cpuOcean` did not — which is §V.8's exact
 * failure mode (the ship floats on a different sea from the one drawn) and the
 * class of defect `f62e037` produced four separate user reports from in one day.
 *
 * WHAT EACH GROUP HERE ENCODES, and why a passing assertion means something:
 *
 * 1. AGREEMENT. The mirror is not "close to" the GPU field; it is the same two
 *    functions the TSL twins are, read through the same clamp, the same region
 *    edge fade and the same track AABB. The only thing the GPU adds is that it
 *    evaluates at TEXEL CENTRES and reconstructs bilinearly, so that is exactly
 *    what is reproduced and measured here — and it is measured DURING A
 *    MANOEUVRE, not at rest, because every one of the three ways the two sides
 *    can drift (lagged vs raw mound speed, wrapped vs raw odometer, near vs far
 *    texel) is invisible on a straight steady course.
 *
 * 2. THE GEOMETRY/FORCE SPLIT (§V.68). `heightAt` takes the wake whole because
 *    that is the surface the vertex stage drew. `pressureHeadAt` takes it
 *    attenuated by e^(−k·T) at each term's OWN wavenumber, because buoyancy
 *    integrates PRESSURE and a hull low-passes the sea by its own draft. No hull
 *    exclusion and no damping: `setShip` takes no y, no pitch and no roll, so
 *    the field cannot depend on any DOF buoyancy controls.
 *
 * 3. THE SWEEP. (2) is a structural argument, not an integration measurement,
 *    and the two are not the same claim. A hull can be handed a bounded forcing
 *    and still ring if the forcing is correlated with its own motion. So the
 *    hull is driven across sea states and speeds with the wake wired and with it
 *    absent, and asked whether she oscillates MORE.
 *
 * 4. THE CLOCK (§V.2). `advance()` used to run in main.ts's RENDER block on
 *    `frameDt`, so the cutwater track's spatial resolution was a function of
 *    frame rate — `52cd1b5` one field over. It is now `advanceWake`, called from
 *    the fixed tick, and the test is the one `52cd1b5` should have had: the
 *    trail must be IDENTICAL at 30, 60 and 144 fps, and the test proves it can
 *    tell the difference by showing the old placement fails it.
 */
import { describe, expect, it } from 'vitest';
import { createFlowFoam } from '../src/flowfoam/index';
import { createWakeInjector } from '../src/flowfoam/wakeInjection';
import { regionEdgeFadeCpu } from '../src/flowfoam/flowMath';
import { flowFoamParams } from '../src/params/flowfoam';
import { CpuOcean } from '../src/sea-physics/cpuOcean';
import { equilibriumDraft, stepShipBuoyancy } from '../src/sea-physics/buoyancy';
import { oceanParams, type OceanParams } from '../src/params/ocean';
import { seaPhysicsParams, type SeaPhysicsParams } from '../src/params/seaPhysics';
import { weatherPresets } from '../src/weather/presets';
import { GRAVITY } from '../src/ocean/oceanMath';
import { SIM_DT, advanceAccumulator } from '../src/core/loop';
import type { ShipState } from '../src/state/simState';

const DT = SIM_DT;
/** the shipped galleon's waterline loft (hullContact) — stem, transom, beam */
const BOW_Z = 21.0;
const STERN_Z = -17.5;
const BEAM = 8.5;
/** the depth §V.68 asks the pressure question at — `hullDraft · smithDepthScale` */
const SMITH_DEPTH = seaPhysicsParams.hullDraft * seaPhysicsParams.smithDepthScale;

function makeShip(): ShipState {
  return {
    id: 's',
    kind: 'player',
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    rudder: 0,
    sailTrim: 0,
    flood: 0,
    damage: {},
  };
}

/** smaller GPU grid so h0 generation is cheap; the mirror grid is untouched */
function testOceanParams(over: Partial<OceanParams> = {}): OceanParams {
  return { ...oceanParams, resolution: 128, ...over };
}

/** genuinely flat: `amplitude` alone leaves the swell train running */
function flatOceanParams(): OceanParams {
  return testOceanParams({ amplitude: 0, swellAmplitude: 0 });
}

/**
 * A MANOEUVRE, not a straight line. Accelerating from rest, holding, then a
 * hard turn: the accelerating leg is where `moundSpeed`'s lag decouples from
 * `pose.speed`, and the turn is where the track stops being a straight line and
 * the vortex street's odometer phase stops being trivially recoverable. A
 * mirror checked only on a steady course cannot fail on any of that.
 */
function poseAt(t: number): { x: number; z: number; yaw: number; speed: number } {
  const speed = Math.min(7, 1.2 * t);
  // integrate the course analytically so every schedule below gets the same
  // trajectory regardless of how it slices time
  const turnRate = t < 8 ? 0 : 0.22; // rad/s after 8 s
  const yaw = t < 8 ? 0 : turnRate * (t - 8);
  return { x: 0, z: 0, yaw, speed };
}

/** ship pose integrator shared by every harness here (sailing owns the plane) */
class Course {
  x = 0;
  z = 0;
  yaw = 0;
  speed = 0;
  t = 0;
  step(dt: number): void {
    this.t += dt;
    const p = poseAt(this.t);
    this.yaw = p.yaw;
    this.speed = p.speed;
    this.x += Math.sin(this.yaw) * this.speed * dt;
    this.z += Math.cos(this.yaw) * this.speed * dt;
  }
}

/* ───────────────────────── 1. §V.8 AGREEMENT ───────────────────────────── */

/**
 * WHAT THE GPU ACTUALLY DRAWS, reconstructed exactly.
 *
 * accumulation.ts's advect pass evaluates `wakeFieldNode` at each texel CENTRE
 * of the near region and stores `elev.clamp(-2, 2)` into `elevTexture`; the
 * ocean material then does `texture(elevTexture, regionUv(worldXZ)).r` — a
 * hardware BILINEAR fetch — and multiplies by the radial region edge fade.
 * Reproducing that here, off the same `elevationCpu` the shipped mirror calls,
 * isolates the ONE difference between the two sides: the GPU samples a grid,
 * the mirror evaluates the point. Everything else is shared code by
 * construction, which is the property being defended.
 */
function gpuDrawnElevation(
  inj: ReturnType<typeof createWakeInjector>,
  centerX: number,
  centerZ: number,
  size: number,
  res: number,
  x: number,
  z: number,
  smithDepth: number,
): number {
  const u = (x - centerX) / size + 0.5;
  const v = 0.5 - (z - centerZ) / size;
  const tx = u * res - 0.5;
  const ty = v * res - 0.5;
  const x0 = Math.floor(tx);
  const y0 = Math.floor(ty);
  const fx = tx - x0;
  const fy = ty - y0;
  const tap = (ix: number, iy: number): number => {
    if (ix < 0 || iy < 0 || ix >= res || iy >= res) return 0;
    const wx = centerX + ((ix + 0.5) / res - 0.5) * size;
    const wz = centerZ - ((iy + 0.5) / res - 0.5) * size;
    const e = inj.elevationCpu(wx, wz, smithDepth);
    return e < -2 ? -2 : e > 2 ? 2 : e;
  };
  const a = tap(x0, y0) * (1 - fx) + tap(x0 + 1, y0) * fx;
  const b = tap(x0, y0 + 1) * (1 - fx) + tap(x0 + 1, y0 + 1) * fx;
  return (a * (1 - fy) + b * fy) * regionEdgeFadeCpu(x - centerX, z - centerZ, size, flowFoamParams.edgeFade);
}

/**
 * Drive the shipped `FlowFoam` and a bare injector through the SAME tick
 * sequence. Both are deterministic functions of the call sequence, so the bare
 * one reproduces the state of the one inside `FlowFoam` exactly — which is what
 * lets the reconstruction above read texel centres the shipped object does not
 * expose.
 */
function sailWake(ticks: number) {
  const ff = createFlowFoam();
  const inj = createWakeInjector(flowFoamParams);
  const c = new Course();
  for (let i = 0; i < ticks; i++) {
    c.step(DT);
    ff.setCenter(c.x, c.z);
    ff.setShip([c.x, c.z], c.yaw, c.speed, BOW_Z, STERN_Z, BEAM);
    ff.advanceWake(DT);
    inj.setShip([c.x, c.z], c.yaw, c.speed, BOW_Z, STERN_Z, BEAM);
    inj.advance(DT);
  }
  return { ff, inj, c };
}

/**
 * Probes measured from the CUTWATER — `setShip` records the cutwater pose
 * (origin + forward·bowOffset), so the whole field hangs off a point 21 m ahead
 * of the ship's own origin and a probe ring centred on the origin misses the
 * bow mound entirely. `aft` is metres astern of the cutwater, negative ahead.
 */
function probePoints(
  c: Course,
  afts: number[],
  acrosses: number[] = [0, 1, 2.5, 6, 12],
): Array<{ x: number; z: number; aft: number }> {
  const fx = Math.sin(c.yaw);
  const fz = Math.cos(c.yaw);
  const hx = c.x + fx * BOW_Z;
  const hz = c.z + fz * BOW_Z;
  const pts: Array<{ x: number; z: number; aft: number }> = [];
  for (const aft of afts) {
    for (const across of acrosses) {
      for (const s of across === 0 ? [1] : [1, -1]) {
        pts.push({
          x: hx - fx * aft + fz * across * s,
          z: hz - fz * aft - fx * across * s,
          aft,
        });
      }
    }
  }
  return pts;
}

/** everything the hull and the eye read, apex included */
const AFTS = [-4, -2, -0.5, 0, 0.5, 1, 1.5, 2, 3, 5, 8, 12, 18, 25, 34, 45, 55];

describe('§V.8 the drawn wake and the floated wake are one field', () => {
  /**
   * WHAT THIS MEASURES, AND WHAT IT FOUND.
   *
   * The GPU stores the field at 0.234 m texel centres and reconstructs it
   * bilinearly; the mirror evaluates the point. Everything else is shared code,
   * so this residual IS the whole §V.8 exposure — and it is NOT uniformly
   * sub-millimetre, which is what the previous session's note claimed.
   *
   * MEASURED, worst over a full manoeuvre (accelerate → hold → hard turn):
   *   ahead of the cutwater      0.007 m
   *   0-2 m astern (the APEX)    0.311 m   ← sub-texel, see below
   *   2-4 m astern               0.043 m
   *   4 m and beyond             0.041 m
   *
   * THE APEX IS SUB-TEXEL AND IT IS A PROPERTY OF THE SHIPPED FIELD, not of the
   * mirror. The transverse train is confined to the Kelvin wedge by
   * `innerFade`, so its full-amplitude half-width is 0.265·d — at d = 0.5 m
   * that is 0.13 m, half a texel, while the elevation it carries there is the
   * full a/k ≈ 0.30 m. The accumulation grid cannot hold a 0.3 m notch 0.26 m
   * wide, so the drawn surface smooths it and the mirror does not. §V.48's own
   * cure (fade the term where its FEATURE goes sub-texel) would apply and would
   * be mirrorable — the texel is a property of the region, not of the camera —
   * but it changes the drawn bow wave, so it is REPORTED rather than taken.
   *
   * The bands below are therefore a measurement pinned as a ratchet, not a
   * tolerance anyone chose. A formula that drifts on one side moves them all.
   */
  it('mirror == the GPU-drawn surface, through a manoeuvre, not just at rest', () => {
    const size = flowFoamParams.regionSize;
    const res = flowFoamParams.resolution;
    let apex = 0;
    let near = 0;
    let far = 0;
    let ahead = 0;
    let peak = 0;
    let sum2 = 0;
    let n = 0;
    // sampled through the accelerating leg AND through the turn — see poseAt
    for (const ticks of [90, 300, 480, 600, 750]) {
      const { ff, inj, c } = sailWake(ticks);
      const cx = ff.regionUniforms.uCenter.value.x;
      const cz = ff.regionUniforms.uCenter.value.y;
      for (const { x, z, aft } of probePoints(c, AFTS)) {
        const mirror = ff.wakeHeightCpu(x, z);
        const drawn = gpuDrawnElevation(inj, cx, cz, size, res, x, z, 0);
        const d = Math.abs(mirror - drawn);
        peak = Math.max(peak, Math.abs(mirror));
        if (aft < 0) ahead = Math.max(ahead, d);
        else if (aft < 2) {
          apex = Math.max(apex, d);
          continue; // the sub-texel band is measured on its own, below
        } else if (aft < 4) near = Math.max(near, d);
        else far = Math.max(far, d);
        sum2 += d * d;
        n++;
      }
    }
    // the field is not trivially zero — a residual of 0 because both sides
    // returned 0 everywhere would prove nothing (§V.62)
    expect(peak).toBeGreaterThan(0.3);
    // AWAY FROM THE APEX the two sides are simply the same surface: RMS over
    // every probe outside the sub-texel band. Measured 0.0043 m.
    expect(Math.sqrt(sum2 / n)).toBeLessThan(0.01);
    expect(ahead).toBeLessThan(0.02);
    expect(apex).toBeLessThan(0.35); // the sub-texel wedge apex — see above
    expect(near).toBeLessThan(0.07);
    expect(far).toBeLessThan(0.06);
  });

  it('agrees under the §V.68 pressure question too, not only the geometric one', () => {
    const size = flowFoamParams.regionSize;
    const res = flowFoamParams.resolution;
    const { ff, inj, c } = sailWake(600);
    const cx = ff.regionUniforms.uCenter.value.x;
    const cz = ff.regionUniforms.uCenter.value.y;
    let worst = 0;
    let peak = 0;
    // the pressure field is the geometric one with every term scaled by its own
    // e^(−k·T), so the same bands apply, scaled down — the apex is excluded here
    // for the same reason and measured in the test above
    for (const { x, z } of probePoints(c, AFTS.filter((a) => a >= 2))) {
      const mirror = ff.wakeHeightCpu(x, z, SMITH_DEPTH);
      const drawn = gpuDrawnElevation(inj, cx, cz, size, res, x, z, SMITH_DEPTH);
      worst = Math.max(worst, Math.abs(mirror - drawn));
      peak = Math.max(peak, Math.abs(mirror));
    }
    expect(peak).toBeGreaterThan(0.01);
    expect(worst).toBeLessThan(0.05);
  });

  it('the ±2 m texture clamp is mirrored, so a param push cannot split the two', () => {
    // §V.62: a backstop that never fires at shipped params is exactly the kind
    // of thing a mirror silently omits, and then the two seas part company on
    // the first tweak that reaches it. Drive `moundSlope` past the clamp.
    const p = { ...flowFoamParams, moundSlope: 40 };
    const ff = createFlowFoam({ params: p });
    const inj = createWakeInjector(p);
    const c = new Course();
    for (let i = 0; i < 300; i++) {
      c.step(DT);
      ff.setCenter(c.x, c.z);
      ff.setShip([c.x, c.z], c.yaw, c.speed, BOW_Z, STERN_Z, BEAM);
      ff.advanceWake(DT);
      inj.setShip([c.x, c.z], c.yaw, c.speed, BOW_Z, STERN_Z, BEAM);
      inj.advance(DT);
    }
    const cx = ff.regionUniforms.uCenter.value.x;
    const cz = ff.regionUniforms.uCenter.value.y;
    let bothSaturated = 0;
    for (const { x, z } of probePoints(c, [-3, -2, -1, 0, 1], [0, 1, 2])) {
      const mirror = ff.wakeHeightCpu(x, z);
      // the mirror obeys the texture's own ceiling, everywhere
      expect(Math.abs(mirror)).toBeLessThanOrEqual(2 + 1e-9);
      const drawn = gpuDrawnElevation(inj, cx, cz, p.regionSize, p.resolution, x, z, 0);
      // deep inside the saturated plateau the two must be EXACTLY equal: both
      // are the clamp, and bilinear interpolation of a constant is that constant
      if (Math.abs(drawn) > 1.999) {
        expect(mirror).toBeCloseTo(drawn, 9);
        bothSaturated++;
      }
    }
    // the clamp really did engage — otherwise this test asserts nothing
    expect(bothSaturated).toBeGreaterThan(0);
  });

  it('is exactly 0 outside the track AABB on both sides', () => {
    // the shader's first test is the AABB early-out; a mirror that instead
    // carried the exponential tails of the aft features would disagree over the
    // whole far field, quietly and by a little
    const { ff, c } = sailWake(600);
    const far = 4000;
    expect(ff.wakeHeightCpu(c.x + far, c.z)).toBe(0);
    expect(ff.wakeHeightCpu(c.x, c.z - far)).toBe(0);
    expect(ff.wakeHeightCpu(c.x, c.z + far, SMITH_DEPTH)).toBe(0);
  });
});

/* ─────────────── 2. CpuOcean COMPOSITION + THE §V.68 SPLIT ─────────────── */

describe('§V.8 CpuOcean carries the wake, and §V.68 bounds what the hull feels', () => {
  it('a flat sea IS the wake: heightAt reproduces the drawn field exactly', () => {
    // flat + no seabed + no fetch ⟹ zero displacement, so the inverse-
    // displacement solve returns the query point itself and the composition can
    // be asserted EXACTLY rather than approximately
    const { ff, c } = sailWake(420);
    const ocean = new CpuOcean(11, flatOceanParams(), seaPhysicsParams);
    ocean.update(7);
    const bare = new CpuOcean(11, flatOceanParams(), seaPhysicsParams);
    bare.update(7);
    ocean.setWakeField(ff);
    let peak = 0;
    for (const { x, z } of probePoints(c, AFTS)) {
      const geo = ff.wakeHeightCpu(x, z, 0);
      const head = ff.wakeHeightCpu(x, z, SMITH_DEPTH);
      expect(ocean.heightAt(x, z, 7)).toBeCloseTo(bare.heightAt(x, z, 7) + geo, 12);
      expect(ocean.pressureHeadAt(x, z, 7)).toBeCloseTo(bare.pressureHeadAt(x, z, 7) + head, 12);
      peak = Math.max(peak, Math.abs(geo));
    }
    expect(peak).toBeGreaterThan(0.1);
  });

  it('reads the wake at the GRID coord, never at the query point (§V.72a, §B.34)', () => {
    // the vertex stage adds `wakeHeightNode(worldXZ)` at the UNDISPLACED grid
    // point and the cascades then carry that vertex sideways. A mirror that read
    // the wake at the query point would put the two seas 1-2 m apart
    // horizontally — the same failure as §B.34, arriving by a third route.
    const { ff, c } = sailWake(420);
    const op = testOceanParams({ ...weatherPresets.swell.ocean });
    const ocean = new CpuOcean(4, op, seaPhysicsParams);
    const bare = new CpuOcean(4, op, seaPhysicsParams);
    ocean.setWakeField(ff);
    let worstNaive = 0;
    for (const { x, z } of probePoints(c, AFTS)) {
      const added = ocean.heightAt(x, z, 9) - bare.heightAt(x, z, 9);
      const naive = ff.wakeHeightCpu(x, z, 0);
      worstNaive = Math.max(worstNaive, Math.abs(added - naive));
      // whatever coord it used, the contribution is a wake elevation and stays
      // inside the field's own bound
      expect(Math.abs(added)).toBeLessThanOrEqual(2 + 1e-9);
    }
    // reading at the query point is a DIFFERENT function on a displaced sea:
    // if this were ~0 the grid-coord solve would not be in the path at all
    expect(worstNaive).toBeGreaterThan(0.02);
  });

  it('the hull feels a fraction of her own wake, and geometry feels all of it', () => {
    const { ff, c } = sailWake(600);
    const fx = Math.sin(c.yaw);
    const fz = Math.cos(c.yaw);
    let geoPeak = 0;
    let headPeak = 0;
    // along the hull and just ahead of the stem, which is where the mound is
    for (let along = STERN_Z; along <= BOW_Z + 6; along += 0.5) {
      for (const across of [-3, -1.5, 0, 1.5, 3]) {
        const x = c.x + fx * along + fz * across;
        const z = c.z + fz * along - fx * across;
        geoPeak = Math.max(geoPeak, Math.abs(ff.wakeHeightCpu(x, z, 0)));
        headPeak = Math.max(headPeak, Math.abs(ff.wakeHeightCpu(x, z, SMITH_DEPTH)));
      }
    }
    // the geometric peak is why drawn-only was rejected: two thirds of sigma at
    // swell is not something a hull can be allowed to ignore
    expect(geoPeak).toBeGreaterThan(0.3);
    // and the force sees a fraction of it, purely from e^(−k·T). The bound IS
    // that law, not a number: the longest wave anywhere in the field is the
    // transverse train at the hull's own speed (λ = 2πv²/g, k = g/v²), and
    // every other feature is shorter, so nothing can reach the keel at more
    // than e^(−(g/v²)·T). A fixed fraction held only while the peak sat on the
    // 6.4 m mound (felt at 14%); §T.82 put the train's crest under the stem
    // where the mound is, and a 31 m wave at 7 m/s is legitimately felt at 67%.
    const kLongest = GRAVITY / (c.speed * c.speed);
    expect(headPeak).toBeLessThan(geoPeak * Math.exp(-kLongest * SMITH_DEPTH));
    expect(headPeak).toBeGreaterThan(0); // not silently switched off
  });

  it('smithDepth 0 is the identity, so every geometric reader is untouched', () => {
    const { ff, c } = sailWake(300);
    for (const { x, z } of probePoints(c, AFTS)) {
      expect(ff.wakeHeightCpu(x, z, 0)).toBe(ff.wakeHeightCpu(x, z));
    }
  });

  it('an unwired mirror is bit-identical to what it was before the wake existed', () => {
    const op = testOceanParams({ ...weatherPresets.swell.ocean });
    const a = new CpuOcean(21, op, seaPhysicsParams);
    const b = new CpuOcean(21, op, seaPhysicsParams);
    b.setWakeField(null);
    for (let i = 0; i < 12; i++) {
      const x = i * 7 - 40;
      expect(b.heightAt(x, 13, 5)).toBe(a.heightAt(x, 13, 5));
      expect(b.pressureHeadAt(x, 13, 5)).toBe(a.pressureHeadAt(x, 13, 5));
    }
  });
});

/* ──────────────────────── 3. THE STABILITY SWEEP ───────────────────────── */

interface RunStats {
  heaveRms: number;
  pitchRms: number;
  rollRms: number;
  heaveRmsLate: number;
  maxAbsPitch: number;
  maxAbsRoll: number;
  finite: boolean;
  meanY: number;
}

/**
 * Tow the hull at a fixed speed over a real sea and let heave/pitch/roll run
 * free, with the wake wired or absent, on an otherwise IDENTICAL trajectory.
 *
 * Surge is PINNED here on purpose: it is a different loop (speed → mound →
 * head gradient → surge force → speed) and it is measured separately below.
 * Pinning it makes the two runs share a trajectory exactly, so any difference
 * in the vertical/rotational channels is attributable to the wake alone.
 */
function towedRun(preset: 'calm' | 'swell' | 'storm', speed: number, wake: boolean, seconds = 22): RunStats {
  const op = testOceanParams({ ...weatherPresets[preset].ocean });
  const sp: SeaPhysicsParams = { ...seaPhysicsParams };
  const ocean = new CpuOcean(77, op, sp);
  const ff = wake ? createFlowFoam() : null;
  if (ff) ocean.setWakeField(ff);
  const ship = makeShip();
  ship.position[1] = equilibriumDraft(sp);
  const ys: number[] = [];
  const pitches: number[] = [];
  const rolls: number[] = [];
  let t = 0;
  const ticks = Math.round(seconds / DT);
  for (let i = 0; i < ticks; i++) {
    t += DT;
    // sailing owns the planar integration (§B.22) — reproduced, not invoked
    ship.position[0] += ship.velocity[0] * DT;
    ship.position[2] += ship.velocity[2] * DT;
    ocean.update(t);
    if (ff) {
      // main.ts's tick order exactly: pose, region, track, THEN buoyancy
      ff.setCenter(ship.position[0], ship.position[2]);
      ff.setShip([ship.position[0], ship.position[2]], 0, speed, BOW_Z, STERN_Z, BEAM);
      ff.advanceWake(DT);
    }
    stepShipBuoyancy(ship, ocean, DT, sp);
    // towed: the commanded speed is restored after buoyancy's surge force
    ship.velocity[0] = 0;
    ship.velocity[2] = speed;
    ys.push(ship.position[1]);
    const q = ship.quaternion;
    // small-angle read-off is enough for an amplitude statistic
    pitches.push(Math.asin(Math.max(-1, Math.min(1, 2 * (q[3] * q[0] - q[2] * q[1])))));
    rolls.push(Math.asin(Math.max(-1, Math.min(1, 2 * (q[3] * q[2] - q[0] * q[1])))));
  }
  // discard the first 4 s: the hull starts at the still-water draft and has to
  // find the wave surface, which is a transient, not a stability statement
  const warm = Math.round(4 / DT);
  const rms = (a: number[], from: number): number => {
    const s = a.slice(from);
    const m = s.reduce((x, y) => x + y, 0) / s.length;
    return Math.sqrt(s.reduce((x, y) => x + (y - m) * (y - m), 0) / s.length);
  };
  const late = warm + Math.round((ticks - warm) / 2);
  return {
    heaveRms: rms(ys, warm),
    heaveRmsLate: rms(ys, late),
    pitchRms: rms(pitches, warm),
    rollRms: rms(rolls, warm),
    maxAbsPitch: Math.max(...pitches.slice(warm).map(Math.abs)),
    maxAbsRoll: Math.max(...rolls.slice(warm).map(Math.abs)),
    finite: ys.every(Number.isFinite) && pitches.every(Number.isFinite) && rolls.every(Number.isFinite),
    meanY: ys.slice(warm).reduce((x, y) => x + y, 0) / (ys.length - warm),
  };
}

describe('§V.8/§V.68 stability sweep: the hull does not ring on her own wake', () => {
  const SEAS: Array<'calm' | 'swell' | 'storm'> = ['calm', 'swell', 'storm'];
  const SPEEDS = [0, 4, 7];

  for (const sea of SEAS) {
    for (const speed of SPEEDS) {
      it(`${sea} @ ${speed} m/s: wake adds no oscillation the sea did not already have`, () => {
        const control = towedRun(sea, speed, false);
        const withWake = towedRun(sea, speed, true);
        expect(control.finite).toBe(true);
        expect(withWake.finite).toBe(true);

        // 1. NOT DIVERGING. A feedback loop shows up as motion that is bigger in
        //    the second half of the run than the first, whatever its absolute
        //    size. This is the assertion the structural argument does not make.
        expect(withWake.heaveRmsLate).toBeLessThan(withWake.heaveRms * 1.6 + 0.02);

        // 2. NOT AMPLIFYING. Against the SAME sea, the SAME seed and the SAME
        //    trajectory, the wake may move where she sits; it may not make her
        //    move more. 15% + 2 cm of headroom covers the honest change of
        //    working point without admitting a resonance.
        expect(withWake.heaveRms).toBeLessThan(control.heaveRms * 1.15 + 0.02);
        expect(withWake.pitchRms).toBeLessThan(control.pitchRms * 1.15 + 0.005);
        expect(withWake.rollRms).toBeLessThan(control.rollRms * 1.15 + 0.005);

        // 3. STILL A SHIP. Nothing here may put her on her beam ends.
        expect(withWake.maxAbsPitch).toBeLessThan(0.6);
        expect(withWake.maxAbsRoll).toBeLessThan(0.6);

        // 4. SHE SITS IN HER OWN TROUGH, and by a bounded amount — the whole
        //    §V.68 claim in one number. Full amplitude would be ~0.47 m.
        expect(Math.abs(withWake.meanY - control.meanY)).toBeLessThan(0.12);
      });
    }
  }

  it('the surge loop is bounded: her own bow wave cannot push her along', () => {
    // The ONE loop the "no y, no pitch, no roll" argument does not close:
    // buoyancy adds a horizontal wave-slope force, so speed → mound → head
    // gradient → surge → speed is a real path at one tick of delay. Free the
    // horizontal channel entirely (no thrust, no drag — the harshest case) and
    // compare the speed excursion against the same sea with no wake.
    const run = (wake: boolean): number => {
      const op = testOceanParams({ ...weatherPresets.swell.ocean });
      const sp: SeaPhysicsParams = { ...seaPhysicsParams };
      const ocean = new CpuOcean(31, op, sp);
      const ff = wake ? createFlowFoam() : null;
      if (ff) ocean.setWakeField(ff);
      const ship = makeShip();
      ship.position[1] = equilibriumDraft(sp);
      ship.velocity[2] = 6;
      let t = 0;
      let worst = 0;
      for (let i = 0; i < Math.round(25 / DT); i++) {
        t += DT;
        ship.position[0] += ship.velocity[0] * DT;
        ship.position[2] += ship.velocity[2] * DT;
        ocean.update(t);
        const speed = Math.hypot(ship.velocity[0], ship.velocity[2]);
        if (ff) {
          ff.setCenter(ship.position[0], ship.position[2]);
          ff.setShip([ship.position[0], ship.position[2]], 0, speed, BOW_Z, STERN_Z, BEAM);
          ff.advanceWake(DT);
        }
        stepShipBuoyancy(ship, ocean, DT, sp);
        if (t > 4) worst = Math.max(worst, Math.abs(Math.hypot(ship.velocity[0], ship.velocity[2]) - 6));
      }
      expect(Number.isFinite(worst)).toBe(true);
      return worst;
    };
    const control = run(false);
    const withWake = run(true);
    // she must not be able to accelerate herself: the excursion stays the sea's
    expect(withWake).toBeLessThan(control * 1.25 + 0.25);
  });
});

/* ─────────────────── 4. §V.2 THE TRAIL HAS ONE CLOCK ───────────────────── */

type Clock = 'tick' | 'render';

/**
 * Run the real `GameLoop` accumulator at a given frame rate and drive the wake
 * either from the fixed tick (shipped) or from the render block (the defect
 * this replaces). The ship's POSITION always integrates in the tick, because
 * that is where sailing integrates it — the only variable is where the track is
 * aged.
 */
function runClock(fps: number, targetTicks: number, clock: Clock) {
  const inj = createWakeInjector(flowFoamParams);
  const c = new Course();
  const frameDt = 1 / fps;
  let acc = 0;
  let ticks = 0;
  let frames = 0;
  // run frames until the SAME amount of SIM time has passed at every rate. The
  // accumulator's own float drift is ±1 tick over ten seconds at 144 fps, which
  // is a property of `advanceAccumulator` and not of the wake — comparing at a
  // fixed tick count keeps that out of this test and it is asserted separately.
  while (ticks < targetTicks) {
    frames++;
    const r = advanceAccumulator(acc, frameDt);
    acc = r.accumulator;
    for (let i = 0; i < r.steps && ticks < targetTicks; i++) {
      c.step(DT);
      ticks++;
      if (clock === 'tick') {
        inj.setShip([c.x, c.z], c.yaw, c.speed, BOW_Z, STERN_Z, BEAM);
        inj.advance(DT);
      }
    }
    if (clock === 'render') {
      inj.setShip([c.x, c.z], c.yaw, c.speed, BOW_Z, STERN_Z, BEAM);
      inj.advance(frameDt);
    }
  }
  return { inj, c, ticks, frames };
}

/** the trail as a consumer sees it: the wake surface along and across it */
function trailProfile(r: ReturnType<typeof runClock>): number[] {
  const out: number[] = [];
  const fx = Math.sin(r.c.yaw);
  const fz = Math.cos(r.c.yaw);
  for (let along = 6; along >= -80; along -= 2) {
    for (const across of [-8, -3, 0, 3, 8]) {
      out.push(
        r.inj.elevationCpu(
          r.c.x + fx * along + fz * across,
          r.c.z + fz * along - fx * across,
        ),
      );
    }
  }
  return out;
}

describe('§V.2 the wake track advances on the sim clock, not the display clock', () => {
  /** 12 s of sailing — through the acceleration AND into the turn (poseAt) */
  const TICKS = 720;

  it('each display rate spends the same wall clock reaching those ticks', () => {
    // the §V.2 premise: sim rate is fps-independent. Frames differ 4.8×; the
    // wall clock they cover must not. ±1 frame because `advanceAccumulator`
    // carries a float remainder — 1729 frames at 144 fps against an exact
    // 1728 — which is the accumulator's property, not the wake's.
    for (const fps of [30, 60, 144]) {
      const r = runClock(fps, TICKS, 'tick');
      expect(Math.abs(r.frames - Math.ceil(TICKS * DT * fps))).toBeLessThanOrEqual(1);
    }
  });

  it('the trail is IDENTICAL at 30, 60 and 144 fps', () => {
    const a = runClock(30, TICKS, 'tick');
    const b = runClock(60, TICKS, 'tick');
    const d = runClock(144, TICKS, 'tick');
    // the recorded history itself, field by field — positions, headings, the
    // speed each sample was laid at, and both of its clocks
    expect(b.inj.trackSamples).toEqual(a.inj.trackSamples);
    expect(d.inj.trackSamples).toEqual(a.inj.trackSamples);
    // …and the lagged mound drive, which is the other piece of sim state
    expect(b.inj.moundDrive).toBe(a.inj.moundDrive);
    expect(d.inj.moundDrive).toBe(a.inj.moundDrive);
    // …and therefore the surface itself, which is what the hull and the vertex
    // stage actually read
    const pa = trailProfile(a);
    expect(trailProfile(b)).toEqual(pa);
    expect(trailProfile(d)).toEqual(pa);
    // the profile is not trivially flat
    expect(Math.max(...pa.map(Math.abs))).toBeGreaterThan(0.05);
  });

  it('…and the test can tell: aged in the render block it is NOT', () => {
    // WHY THIS EXISTS (§Rule 6). `advanceTrack` lays samples on distance
    // travelled, so a frame-rate-driven trail is not obviously wrong — it is
    // wrong by the QUANTISATION of where each sample lands and of when a turn
    // is noticed. Without this contrast the identity test above could pass on a
    // system where the clock does not matter at all, and would then be pinning
    // nothing. `52cd1b5` is what that costs.
    const a = runClock(30, TICKS, 'render');
    const d = runClock(144, TICKS, 'render');
    expect(d.inj.trackSamples).not.toEqual(a.inj.trackSamples);
    const pa = trailProfile(a);
    const pd = trailProfile(d);
    let worst = 0;
    for (let i = 0; i < pa.length; i++) worst = Math.max(worst, Math.abs(pa[i] - pd[i]));
    expect(worst).toBeGreaterThan(1e-4);
  });

  it('only advanceWake moves the track — the GPU step cannot', () => {
    // THE REGRESSION PIN. The split is worth nothing if `update()` quietly
    // keeps ageing the track too: main.ts would then drive it twice, once per
    // tick and once per frame, and the frame-rate dependence would be back with
    // no symptom but a slightly longer trail.
    const ff = createFlowFoam();
    const renderer = { compute: () => undefined } as never;
    const c = new Course();
    for (let i = 0; i < 200; i++) {
      c.step(DT);
      ff.setCenter(c.x, c.z);
      ff.setShip([c.x, c.z], c.yaw, c.speed, BOW_Z, STERN_Z, BEAM);
      ff.update(renderer, DT);
    }
    expect(ff.wakeTrack.length).toBe(0);
    expect(ff.bowDrive).toBe(0);
    expect(ff.wakeHeightCpu(c.x, c.z)).toBe(0);
    // …and the moment the sim tick drives it, it lives
    for (let i = 0; i < 200; i++) {
      c.step(DT);
      ff.setCenter(c.x, c.z);
      ff.setShip([c.x, c.z], c.yaw, c.speed, BOW_Z, STERN_Z, BEAM);
      ff.advanceWake(DT);
    }
    expect(ff.wakeTrack.length).toBeGreaterThan(3);
    expect(ff.bowDrive).toBeGreaterThan(1);
  });

  it('says so once when the sim tick never drove it, and never throws', () => {
    // §Rule 8 loud, but NOT by throwing: `GameLoop` renders while paused
    // (§V.21), so a pause taken before the first tick would otherwise kill
    // every frame — a worse failure than the one being guarded against.
    const ff = createFlowFoam();
    const renderer = { compute: () => undefined } as never;
    const seen: string[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => void seen.push(String(a[0]));
    try {
      for (let i = 0; i < 5; i++) ff.update(renderer, DT);
    } finally {
      console.error = original;
    }
    expect(seen.length).toBe(1);
    expect(seen[0]).toMatch(/advanceWake/);
  });
});
