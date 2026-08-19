/**
 * §V12/§V42 rope compute pass. Dispatch model is unchanged and is the point of
 * §V12: ONE THREAD PER ROPE, looping its own samples. A rope's particles are a
 * serial chain — each distance constraint depends on its neighbour — so owning
 * the whole rope in one thread is what makes Gauss-Seidel legal here with no
 * barriers and no cross-thread hazard.
 *
 * TWO SOLVERS, ONE THREAD (§V42):
 *   NEAR  a Verlet particle chain: gravity + apparent wind, distance
 *         constraints, anchors pinned to the sockets.
 *   FAR   the analytic catenary — the old static solve, demoted to the LOD it
 *         is right for, matching the §V41 render regimes.
 * The thread always solves the catenary (it is one Newton solve per rope and
 * it is the rest state the chain is seeded from and leashed to), then runs the
 * chain only if the rope is close enough to be worth it.
 *
 * WHY VERLET IN WORLD SPACE. This is the whole trick, and the reason the old
 * canned sine read as dead: the anchors are pinned to sockets that MOVE with
 * the ship, while the particles between them carry their own momentum. When
 * the hull heaves, rolls or accelerates away, the rope is simply left behind
 * for a frame and then catches up. Ship acceleration is never computed, passed
 * in, or faked with a phase offset — it falls out of integrating in world
 * space, and it is what sells the whole effect. Integrating in ship-local
 * space would delete exactly this and put the sine wave back.
 *
 * This is render-side dressing, like the sway it replaces: it reads params and
 * the frame delta, never SimState, and writes only its own buffers (§V2/§V3
 * untouched — the sim does not know ropes exist).
 *
 * Buffers (all vec4 storage):
 *   descA[rope]                  xyz = anchor A, w = rope length L
 *   descB[rope]                  xyz = anchor B, w = tube radius
 *   simPos[rope*(segments+1)+i]  xyz = particle now,  w = seeded flag
 *   simPrev[same index]          xyz = particle last substep
 *   points[same index]           xyz = curve sample, w = tube radius (render)
 *   tangents[same index]         xyz = unit tangent (central difference)
 *
 * src/ropes/catenaryMath.ts and src/ropes/ropeDynamics.ts are the unit-tested
 * CPU mirrors of the two solvers; the GPU side cannot be tested directly.
 */
import {
  Fn,
  If,
  Loop,
  clamp,
  exp,
  float,
  instanceIndex,
  instancedArray,
  int,
  max,
  min,
  mix,
  normalize,
  pow,
  select,
  sin,
  smoothstep,
  sqrt,
  storage,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import { Vector3 } from 'three';
import type { Node } from 'three/webgpu';
import type { ShaderNodeObject } from 'three/tsl';
import {
  CATENARY_ITERATIONS,
  FPRIME_MIN,
  H_EPS,
  R_EPS,
  TAUT_EPS,
  Z_MAX,
  Z_MIN,
} from './catenaryMath';
import { DT_MAX, DT_MIN } from './ropeDynamics';
import { ropeParams } from '../params/ropes';
import { oceanParams } from '../params/ocean';

type N = ShaderNodeObject<Node>;

/** how far past the leash a particle must be to count as blown up rather than
 *  merely straying — also the NaN trap, since any comparison against NaN is
 *  false and sends the particle back to its rest position */
const SANITY_SCALE = 1e4;

/**
 * Push a live param into a scalar uniform (§V62: a knob that drives nothing is
 * a defect — every rope tunable is refreshed through here every frame).
 *
 * NON-FINITE VALUES ARE DROPPED, keeping the last good one (§V28). A param is
 * caller-fed — the panel binds it, and `__params.ropes.x = NaN` from the
 * console is one keystroke away — and these uniforms scale GEOMETRY (rope
 * radius, phone-wire widening), where a NaN is not a visual bug but a
 * NaN-sized primitive that wedges the GPU process (§B5).
 *
 * Cost is nil: three's UniformsGroup compares each value against its cached
 * copy and only writes the buffer when it actually moved (updateNumber /
 * updateColor), and a uniform write never touches the compiled pipeline. So
 * these run unconditionally rather than behind a change-check.
 */
export function pushParam(u: { value: number }, v: number): void {
  if (Number.isFinite(v)) u.value = v;
}

// Hyperbolics via exp so the GPU formulation matches the CPU reference
// exactly in shape (Math.sinh/cosh/asinh are the same expressions).
const sinhT = (x: N) => exp(x).sub(exp(x.negate())).mul(0.5);
const coshT = (x: N) => exp(x).add(exp(x.negate())).mul(0.5);
const asinhT = (x: N) => x.add(sqrt(x.mul(x).add(1))).log();

export function createRopeCompute(maxRopes: number, segments: number) {
  const pointsPerRope = segments + 1;
  const descA = instancedArray(maxRopes, 'vec4');
  const descB = instancedArray(maxRopes, 'vec4');
  const points = instancedArray(maxRopes * pointsPerRope, 'vec4');
  const tangents = instancedArray(maxRopes * pointsPerRope, 'vec4');
  const simPos = instancedArray(maxRopes * pointsPerRope, 'vec4');
  const simPrev = instancedArray(maxRopes * pointsPerRope, 'vec4');
  // per-LINK rest length, refreshed every frame from the rope's own catenary
  const simRest = instancedArray(maxRopes * pointsPerRope, 'float');
  // Read-only VIEWS for the vertex stage, over the same attributes. Calling
  // points.toReadOnly() would mutate the shared node (setAccess returns
  // `this`, it does not clone) and the compute kernel's writes would compile
  // against a read-only binding and vanish — see §B.8.
  const sampleCount = maxRopes * pointsPerRope;
  const pointsRead = storage(points.value, 'vec4', sampleCount).toReadOnly();
  const tangentsRead = storage(tangents.value, 'vec4', sampleCount).toReadOnly();

  const uRopeCount = uniform(0);
  const uDynamic = uniform(ropeParams.dynamic ? 1 : 0);
  const uGravity = uniform(ropeParams.gravity);
  const uDamping = uniform(ropeParams.damping);
  const uWindForce = uniform(ropeParams.windForce);
  const uGustSpeed = uniform(ropeParams.gustSpeed);
  const uGustDepth = uniform(ropeParams.gustDepth);
  const uMaxStray = uniform(ropeParams.maxStray);
  const uStrayFraction = uniform(ropeParams.strayFraction);
  const uTeleport = uniform(ropeParams.teleportDistance);
  /**
   * Camera position, and frame timing, as PLAIN UNIFORMS.
   *
   * A compute pass has no camera. Reading the `cameraPosition` /`deltaTime`
   * render-stage nodes from inside `Fn(...).compute()` makes the node builder
   * dereference a null camera while building the pass — `setupOutput →
   * isArrayCamera on null` — which kills the whole boot, not just the ropes.
   * `uCameraPos` is fed from the render side instead (see index.ts, via the
   * mesh's onBeforeRender), which is also the more correct shape: ONE distance
   * decision per rope per frame, not a per-invocation camera lookup. One frame
   * of staleness is irrelevant to an LOD gate.
   */
  const camPos = new Vector3();
  const uCameraPos = uniform(camPos);
  const uDeltaTime = uniform(1 / 60).onFrameUpdate((frame) => {
    const dt = (frame as { deltaTime?: number }).deltaTime;
    return Number.isFinite(dt) ? (dt as number) : 1 / 60;
  });
  const uTime = uniform(0).onFrameUpdate((frame) => {
    const t = (frame as { time?: number }).time;
    return Number.isFinite(t) ? (t as number) : 0;
  });
  const uSimDistance = uniform(ropeParams.simDistance);
  const uSimFadeBand = uniform(ropeParams.simFadeBand);
  // wind pulled straight from the ocean params every frame — the same source
  // the waves and the yard bracing read, so sea, sails and rig can never
  // disagree about which way the wind blows. Needs no main.ts plumbing:
  // UniformNode assigns whatever the callback returns to `.value`.
  const windVec = new Vector3();
  const uWind = uniform(windVec).onFrameUpdate(() => {
    // §V28: caller-fed uniforms are finite-guarded before reaching a shader
    const speed = Number.isFinite(oceanParams.windSpeed) ? oceanParams.windSpeed : 0;
    const dir = Number.isFinite(oceanParams.windDirection) ? oceanParams.windDirection : 0;
    return windVec.set(Math.cos(dir) * speed, 0, Math.sin(dir) * speed);
  });

  // literal loop bounds (§V28) — read once at construction, never live
  const ITERATIONS = Math.max(1, Math.round(ropeParams.constraintIterations));
  const SUBSTEPS = Math.max(1, Math.round(ropeParams.substeps));

  const computeNode = Fn(() => {
    If(float(instanceIndex).lessThan(uRopeCount), () => {
      const dA = descA.element(instanceIndex);
      const dB = descB.element(instanceIndex);
      const A = dA.xyz.toVar();
      const B = dB.xyz.toVar();
      const L = dA.w.toVar();
      const thickness = dB.w.toVar();

      const delta = B.sub(A).toVar();
      const v = delta.y;
      const h = delta.xz.length().toVar();
      const hSafe = max(h, H_EPS);
      const dist = delta.length();
      // taut/short rope OR vertical rope → straight line (CPU mirror)
      const straight = h
        .lessThan(H_EPS)
        .or(L.lessThanEqual(dist.mul(1 + TAUT_EPS)));

      // --- FAR solver: analytic catenary (§V12, unchanged) ------------------
      // Newton on f(z) = sinh(z) − r·z, z = h/(2a) — see catenaryMath.ts for
      // the convergence argument behind the fixed iteration count.
      const r = max(
        sqrt(max(L.mul(L).sub(v.mul(v)), 0)).div(hSafe),
        1 + R_EPS,
      ).toVar();
      const z = min(sqrt(r.sub(1).mul(6)), Z_MAX).toVar();
      Loop(CATENARY_ITERATIONS, () => {
        const f = sinhT(z).sub(r.mul(z));
        const fp = max(coshT(z).sub(r), FPRIME_MIN);
        z.assign(max(z.sub(f.div(fp)), Z_MIN));
      });
      const a = h.div(z.mul(2)).toVar();
      const span = a.mul(2).mul(sinhT(z)); // = sqrt(L² − v²) at convergence
      const xm = h.mul(0.5).sub(a.mul(asinhT(v.div(span)))).toVar();
      const y0 = coshT(xm.div(a)).mul(a).negate().toVar();
      const dirH = vec3(delta.x, 0, delta.z).div(hSafe).toVar();

      /** rest-state position of sample i — the catenary the chain hangs from */
      const catAt = (t: N): N => {
        const x = t.mul(h);
        const catY = coshT(x.sub(xm).div(a)).mul(a).add(y0);
        return select(straight, mix(A, B, t), A.add(dirH.mul(x)).add(vec3(0, catY, 0)));
      };

      const base = int(instanceIndex).mul(pointsPerRope).toVar();

      // --- LOD: how much of this rope is the dynamic chain ------------------
      // Distance in METRES is the honest currency here: this gates simulation
      // COST, not a rasterisation artefact. (The §V41 render split, which does
      // face an artefact, stays in pixels — §V36.) Camera-at-origin fallback
      // is benign: it simulates rather than freezing.
      const mid = mix(A, B, float(0.5));
      const camDist = mid.sub(uCameraPos).length();
      // reading: smoothstep(d0, d1, x) rises from 0 at d0 to 1 at d1 —
      // FUNCTIONAL 3-arg form (§V23/§B1). Inverted: far means less sim.
      const simWeight = smoothstep(
        uSimDistance,
        uSimDistance.add(max(uSimFadeBand, float(1))),
        camDist,
      ).oneMinus().mul(uDynamic).toVar();

      If(simWeight.greaterThan(0), () => {
        // RESEED — three failure modes, one condition, by design:
        //  1. never seeded: the buffers start zeroed and a chain released from
        //     the world origin would whip across the map. `w` is the flag.
        //  2. re-anchored: a mast breaking (§V14) teleports an anchor, and a
        //     chain still hanging off the old one would be snapped violently
        //     across the gap by its own distance constraints.
        //  3. NON-FINITE state: written so NaN takes this branch. `x <= t` is
        //     FALSE for NaN in WGSL, so `anchored` goes false and the chain is
        //     rebuilt from the catenary. That matters because the leash below
        //     cannot launder NaN on its own — NaN/NaN is NaN — and NaN reaching
        //     `points` becomes NaN-sized geometry and wedges the GPU process,
        //     which presents as a browser hang, not a shader bug (§B5/§V28).
        const anchored = simPos
          .element(base)
          .xyz.sub(A)
          .length()
          .lessThanEqual(uTeleport)
          .and(
            simPos
              .element(base.add(int(segments)))
              .xyz.sub(B)
              .length()
              .lessThanEqual(uTeleport),
          );
        If(simPos.element(base).w.lessThan(0.5).or(anchored.not()), () => {
          Loop({ start: int(0), end: int(segments), condition: '<=' }, ({ i }) => {
            const p = catAt(float(i).div(segments));
            simPos.element(base.add(i)).assign(vec4(p, 1));
            simPrev.element(base.add(i)).assign(vec4(p, 1));
          });
        });

        // frame delta clamped so a stall or a background tab cannot hand the
        // integrator a step it explodes on (§V28)
        const dt = clamp(uDeltaTime, float(DT_MIN), float(DT_MAX)).div(SUBSTEPS).toVar();
        // REST LENGTHS FROM THE CATENARY, not L/segments. solveCatenary
        // samples uniformly in horizontal x, so its links vary ~2.2× end to
        // end; a chain told to hold EQUAL links fights the very curve it was
        // seeded from and never settles (measured: still moving 0.06 m/frame
        // after 600 frames — a permanently twitching rig). Taking rest from
        // the curve makes the chain's equilibrium exactly what the far LOD
        // draws, so the §V42 crossfade has no shape mismatch either.
        //
        // Recomputed EVERY frame, not cached: reefing changes a rope's length
        // while its anchors stay put (§V46), so the rest state moves under the
        // chain. That is the mechanism that makes a hauled buntline visibly
        // snap taut, so it must not be frozen at seed time.
        Loop({ start: int(0), end: int(segments), condition: '<' }, ({ i }) => {
          const c0 = catAt(float(i).div(segments));
          const c1 = catAt(float(i).add(1).div(segments));
          simRest.element(base.add(i)).assign(c1.sub(c0).length());
        });
        // gust: one scalar for the whole rope, so a rope breathes as a unit
        const gust = float(1)
          .sub(uGustDepth)
          .add(sin(uTime.mul(uGustSpeed).add(float(instanceIndex))).mul(uGustDepth));
        const accel = vec3(0, uGravity.negate(), 0).add(uWind.mul(uWindForce).mul(gust)).toVar();

        Loop(SUBSTEPS, () => {
          // integrate: x' = x + (x − xPrev)·damping + a·dt²
          Loop({ start: int(0), end: int(segments), condition: '<=' }, ({ i }) => {
            const cur = simPos.element(base.add(i)).xyz;
            const prev = simPrev.element(base.add(i)).xyz;
            // damping quoted per 1/60 s and normalised to the step, so the
            // substep count cannot silently change the physics
            const vel = cur.sub(prev).mul(pow(uDamping, dt.mul(60)));
            const next = cur.add(vel).add(accel.mul(dt).mul(dt));
            simPrev.element(base.add(i)).assign(vec4(cur, 1));
            simPos.element(base.add(i)).assign(vec4(next, 1));
          });
          // anchors are pinned to their sockets — this is where ship motion
          // enters the simulation, and the only place it needs to
          simPos.element(base).assign(vec4(A, 1));
          simPos.element(base.add(int(segments))).assign(vec4(B, 1));

          // Gauss-Seidel distance constraints, sequential along the chain.
          // Legal without barriers precisely because this thread owns every
          // particle of this rope (§V12 dispatch model).
          Loop(ITERATIONS, () => {
            Loop({ start: int(0), end: int(segments), condition: '<' }, ({ i }) => {
              const p0 = simPos.element(base.add(i)).xyz;
              const p1 = simPos.element(base.add(i).add(1)).xyz;
              const d = p1.sub(p0);
              const len = max(d.length(), Z_MIN);
              const corr = d.mul(len.sub(simRest.element(base.add(i))).div(len).mul(0.5));
              simPos.element(base.add(i)).assign(vec4(p0.add(corr), 1));
              simPos.element(base.add(i).add(1)).assign(vec4(p1.sub(corr), 1));
            });
            simPos.element(base).assign(vec4(A, 1));
            simPos.element(base.add(int(segments))).assign(vec4(B, 1));
          });
        });
      });

      // --- write the render curve -------------------------------------------
      // Leash: a particle may never stray further than maxStray from where the
      // catenary says it belongs. This is the stability net — a blown-up or
      // NaN chain is pulled back to a sane rope instead of drawing NaN-sized
      // geometry and wedging the GPU process (§V28, §B5).
      Loop({ start: int(0), end: int(segments), condition: '<=' }, ({ i }) => {
        const t = float(i).div(segments);
        const restPos = catAt(t).toVar();
        const simmed = simPos.element(base.add(i)).xyz;
        const offset = simmed.sub(restPos);
        const stray = offset.length().toVar();
        // second net, and NaN-proof by construction: `stray <= maxStray*BIG` is
        // FALSE for NaN, so a poisoned particle collapses onto its rest
        // position rather than propagating (§V28 — see the reseed note above)
        // The leash is a SANITY net, not a shape constraint — the chain
        // already tracks the curve because its rest lengths come from it. It
        // scales with rope length so that a reef hauling several metres of sag
        // out of a line (§V46) is followed, not clipped into a pop.
        const leashMax = max(uMaxStray, L.mul(uStrayFraction)).toVar();
        const sane = stray.lessThanEqual(leashMax.mul(SANITY_SCALE));
        const dist2 = max(stray, Z_MIN);
        const pulled = restPos.add(offset.mul(min(dist2, leashMax).div(dist2)));
        const leashed = select(sane, pulled, restPos);
        simPos.element(base.add(i)).assign(vec4(leashed, 1));
        // crossfade the two solvers so a rope crossing the LOD boundary does
        // not snap from a swinging chain to a rigid curve
        points.element(base.add(i)).assign(vec4(mix(restPos, leashed, simWeight), thickness));
      });
      // endpoint snap — kills residual solver error at both anchors
      points.element(base).assign(vec4(A, thickness));
      points.element(base.add(int(segments))).assign(vec4(B, thickness));

      // tangents: central differences over the just-written samples — this
      // thread owns the whole rope slice, so no cross-thread hazard exists.
      Loop({ start: int(0), end: int(segments), condition: '<=' }, ({ i }) => {
        const i0 = max(int(i).sub(1), int(0));
        const i1 = min(int(i).add(1), int(segments));
        const d = points
          .element(base.add(i1))
          .xyz.sub(points.element(base.add(i0)).xyz);
        const tan = select(d.length().lessThan(Z_MIN), vec3(0, 1, 0), normalize(d));
        tangents.element(base.add(i)).assign(vec4(tan, 0));
      });
    });
  })().compute(maxRopes);

  return {
    descA,
    descB,
    points,
    tangents,
    simPos,
    simPrev,
    simRest,
    pointsRead,
    tangentsRead,
    uRopeCount,
    uDynamic,
    uGravity,
    uDamping,
    uWindForce,
    uGustSpeed,
    uGustDepth,
    uMaxStray,
    uStrayFraction,
    uTeleport,
    uSimDistance,
    uSimFadeBand,
    uWind,
    uCameraPos,
    camPos,
    computeNode,
    pointsPerRope,
    /**
     * Re-read every live rope tunable (§V62). Called once per frame from
     * ropes/index.ts `update()`, before the dispatch — the panel mutates
     * `ropeParams` in place, and `uniform(x)` COPIED x at construction, so
     * without this every slider in the `ropes` folder is dead.
     *
     * `constraintIterations` / `substeps` are deliberately absent: they are
     * literal TSL Loop bounds (§V28), fixed at construction, and params/ropes
     * already documents them as startup-only.
     */
    refresh(): void {
      // boolean → 0/1 at the refresh site, the same shape as the unit
      // conversion foam does when it pushes `1 / breakupMetres`
      uDynamic.value = ropeParams.dynamic ? 1 : 0;
      pushParam(uGravity, ropeParams.gravity);
      pushParam(uDamping, ropeParams.damping);
      pushParam(uWindForce, ropeParams.windForce);
      pushParam(uGustSpeed, ropeParams.gustSpeed);
      pushParam(uGustDepth, ropeParams.gustDepth);
      pushParam(uMaxStray, ropeParams.maxStray);
      pushParam(uStrayFraction, ropeParams.strayFraction);
      pushParam(uTeleport, ropeParams.teleportDistance);
      pushParam(uSimDistance, ropeParams.simDistance);
      pushParam(uSimFadeBand, ropeParams.simFadeBand);
    },
  };
}

export type RopeCompute = ReturnType<typeof createRopeCompute>;
