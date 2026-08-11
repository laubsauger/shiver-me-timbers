/**
 * §V12 rope catenary compute pass. Dispatch model: ONE THREAD PER ROPE — the
 * sag parameter `a` is identical for every sample on a rope, so each thread
 * runs the Newton solve once and then loops its segment samples (cheaper than
 * ropeCount×segments threads each re-solving the same transcendental). The
 * kernel mirrors src/ropes/catenaryMath.ts term-for-term; that CPU file is
 * the unit-tested ground truth (tests/ropes.test.ts). CPU code only edits the
 * rope descriptor buffer when rigging changes — no per-frame rope math on CPU.
 *
 * Buffers (all vec4 storage):
 *   descA[rope]                  xyz = anchor A, w = rope length L
 *   descB[rope]                  xyz = anchor B, w = tube radius
 *   points[rope*(segments+1)+i]  xyz = curve sample, w = tube radius
 *   tangents[same index]         xyz = unit tangent (central difference)
 *
 * Wind sway is a small perpendicular offset with a sin(πt) envelope so the
 * anchors stay pinned. It is render-side dressing driven by the TSL `time`
 * node — it never touches SimState (§V2/§V3 untouched).
 */
import {
  Fn,
  If,
  Loop,
  PI,
  cross,
  exp,
  float,
  instanceIndex,
  instancedArray,
  int,
  max,
  min,
  mix,
  normalize,
  select,
  sin,
  sqrt,
  storage,
  time,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
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
import { ropeParams } from '../params/ropes';

type N = ShaderNodeObject<Node>;

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
  // Read-only VIEWS for the vertex stage, over the same attributes. Calling
  // points.toReadOnly() would mutate the shared node (setAccess returns
  // `this`, it does not clone) and the compute kernel's writes would compile
  // against a read-only binding and vanish — see §B.8.
  const sampleCount = maxRopes * pointsPerRope;
  const pointsRead = storage(points.value, 'vec4', sampleCount).toReadOnly();
  const tangentsRead = storage(tangents.value, 'vec4', sampleCount).toReadOnly();

  const uRopeCount = uniform(0);
  const uSwayAmplitude = uniform(ropeParams.swayAmplitude);
  const uSwaySpeed = uniform(ropeParams.swaySpeed);
  const uSwayPhaseStep = uniform(ropeParams.swayPhaseStep);

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

      // sway basis: horizontal unit ⊥ chord; vertical ropes fall back to +x
      const flat = cross(delta, vec3(0, 1, 0));
      const perp = select(
        flat.length().lessThan(H_EPS),
        vec3(1, 0, 0),
        normalize(flat),
      ).toVar();
      const phase = float(instanceIndex).mul(uSwayPhaseStep);

      const base = int(instanceIndex).mul(pointsPerRope).toVar();
      Loop({ start: int(0), end: int(segments), condition: '<=' }, ({ i }) => {
        const t = float(i).div(segments);
        const x = t.mul(h);
        const catY = coshT(x.sub(xm).div(a)).mul(a).add(y0);
        const pCat = A.add(dirH.mul(x)).add(vec3(0, catY, 0));
        const p = select(straight, mix(A, B, t), pCat).toVar();
        // sin(πt) envelope pins both anchors; phase decorrelates ropes
        const sway = uSwayAmplitude
          .mul(sin(t.mul(PI)))
          .mul(sin(time.mul(uSwaySpeed).add(phase)));
        p.addAssign(perp.mul(sway));
        points.element(base.add(i)).assign(vec4(p, thickness));
      });
      // endpoint snap — kills the residual Newton error (CPU mirror)
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
    pointsRead,
    tangentsRead,
    uRopeCount,
    uSwayAmplitude,
    uSwaySpeed,
    uSwayPhaseStep,
    computeNode,
    pointsPerRope,
  };
}

export type RopeCompute = ReturnType<typeof createRopeCompute>;
