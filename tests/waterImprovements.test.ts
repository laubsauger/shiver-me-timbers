import { describe, expect, it } from 'vitest';
import { coverageWeightedAgeNode, foamSourceAgesNode } from '../src/flowfoam/foamAge';
import { uniform } from 'three/tsl';
import { contactFoamNode } from '../src/flowfoam/intersectionMask';
import { refractionDepthNode, snellLookupPoint } from '../src/ocean/surfaceRefraction';
import { reflectionSkyVisibilityNode, unresolvedSlopeVarianceNode } from '../src/ocean/surfaceFiltering';
import { breakupJitterAligned } from '../src/foam/foamMath';
import { OceanSimulation } from '../src/ocean/oceanCascades';
import { oceanParams } from '../src/params/ocean';
import { createFoamSim } from '../src/foam';
import { shoreOrigin, SHORE_REGION_METRES } from '../src/foam/shoreFoam';

// Evaluate the actual scalar contact graph, including float32 arithmetic.
function scalar(n: any): number {
  const f = Math.fround;
  if (n.isConstNode || n.isUniformNode) return f(n.value);
  if (n.condNode) return scalar(n.condNode) ? scalar(n.ifNode) : scalar(n.elseNode);
  if (n.isOperatorNode) {
    const a = scalar(n.aNode), b = scalar(n.bNode);
    switch (n.op) {
      case '+': return f(a + b);
      case '-': return f(a - b);
      case '*': return f(a * b);
      case '/': return f(a / b);
      case '>=': return Number(a >= b);
      case '>': return Number(a > b);
      case '<': return Number(a < b);
      case '&&': return Number(Boolean(a && b));
    }
  }
  if (n.isMathNode && n.method === 'smoothstep') {
    const a = scalar(n.aNode), b = scalar(n.bNode), x = scalar(n.cNode);
    const t = Math.max(0, Math.min(1, f(f(x - a) / f(b - a))));
    return f(f(t * t) * f(3 - f(2 * t)));
  }
  if (n.isMathNode && n.method === 'mix') {
    const a = scalar(n.aNode), b = scalar(n.bNode), t = scalar(n.cNode);
    return f(f(a * f(1 - t)) + f(b * t));
  }
  if (n.isMathNode && n.method === 'sqrt') return f(Math.sqrt(scalar(n.aNode)));
  if (n.isMathNode && n.method === 'max') return Math.max(scalar(n.aNode), scalar(n.bNode));
  if (n.isMathNode && n.method === 'oneMinus') return f(1 - scalar(n.aNode));
  if (n.node) return scalar(n.node);
  throw new Error(`Unsupported contact node: ${n.type} ${n.op ?? n.method}`);
}

describe('visible water contact', () => {
  const scene = uniform(0), water = uniform(0.01), far = uniform(1000);
  const node = contactFoamNode(scene, water, far, uniform(0.4), uniform(0.5));
  const at = (gap: number) => {
    scene.value = water.value + gap / far.value;
    return scalar(node);
  };

  it('rejects foreground depth, distant bottom, and the cleared background', () => {
    expect(at(-0.01)).toBe(0);
    expect(at(2)).toBe(0);
    scene.value = 1;
    expect(scalar(node)).toBe(0);
  });

  it('has a contact core and a monotone feather measured in metres', () => {
    expect(at(0)).toBe(1);
    expect(at(0.1)).toBe(1);
    expect(at(0.3)).toBeCloseTo(0.5, 3);
    expect(at(0.41)).toBe(0);
    let previous = 1;
    for (let gap = 0; gap <= 0.5; gap += 0.005) {
      const value = at(gap);
      expect(value).toBeLessThanOrEqual(previous);
      previous = value;
    }
  });
});

describe('refraction depth and color agree', () => {
  const straight = uniform(0.02), bent = uniform(0.03), water = uniform(0.01);
  const sample = refractionDepthNode(straight, bent, water);

  it('retains the submerged hull when a bent ray hits foreground', () => {
    straight.value = 0.02;
    bent.value = 0.005;
    expect(scalar(sample.useBent)).toBe(0);
    expect(scalar(sample.depth)).toBeCloseTo(0.02);
    expect(scalar(sample.visible)).toBe(1);
  });

  it('uses bent depth for a valid bent lookup', () => {
    bent.value = 0.03;
    expect(scalar(sample.useBent)).toBe(1);
    expect(scalar(sample.depth)).toBeCloseTo(0.03);
    expect(scalar(sample.visible)).toBe(1);
  });

  it('rejects foreground and cleared background as submerged geometry', () => {
    for (const depth of [0.005, 0.01, 1]) {
      straight.value = depth;
      bent.value = depth;
      expect(scalar(sample.useBent)).toBe(0);
      expect(scalar(sample.visible)).toBe(0);
    }
  });
});

it('foam birth noise travels downwind even in a rotated crest frame', () => {
  const frame = { cos: Math.cos(0.7), sin: Math.sin(0.7) };
  const frequency = 1 / 16;
  for (const angle of [0, 0.9, Math.PI, -Math.PI / 2]) {
    const direction = { x: Math.cos(angle), z: Math.sin(angle) };
    for (const drift of [0.1, 1, 5]) {
      for (const x of [-120, 0, 83]) {
        const before = breakupJitterAligned(x, 17, frame, 3, frequency, 1, 3);
        const after = breakupJitterAligned(
          x + drift * direction.x / frequency, 17 + drift * direction.z / frequency,
          frame, 3, frequency, 1, 3, drift, direction,
        );
        expect(after).toBeCloseTo(before, 10);
      }
    }
  }
});

it('submits three stable ordered FFT groups, retaining every stage', () => {
  const p = { ...oceanParams, resolution: 32 };
  const sea = new OceanSimulation(7, p);
  const groups: any[][] = [];
  const renderer = { compute: (nodes: any[]) => groups.push(nodes) };
  sea.update(renderer as never, 1, p);
  expect(groups).toHaveLength(3);
  const original = groups.slice();
  for (const nodes of groups) {
    expect(nodes).toHaveLength(2 + 2 * Math.log2(p.resolution));
    expect(new Set(nodes).size).toBe(nodes.length);
    expect(nodes.every(n => n.isComputeNode && n.count === p.resolution ** 2)).toBe(true);
  }
  groups.length = 0;
  sea.update(renderer as never, 2, p);
  expect(groups.every((nodes, i) => nodes === original[i])).toBe(true);
});

it('freezing simulation time freezes both whitecaps and shoreline history', () => {
  const sea = new OceanSimulation(7, { ...oceanParams, resolution: 32 });
  const foam = createFoamSim(sea.cascades, 32, sea);
  const calls: unknown[] = [];
  const renderer = { compute: (node: unknown) => calls.push(node) };
  foam.update(renderer as never, 0);
  expect(calls).toHaveLength(0);
  foam.update(renderer as never, 1 / 60);
  expect(calls.length).toBeGreaterThan(0);
  calls.length = 0;
  foam.update(renderer as never, 0);
  expect(calls).toHaveLength(0);
  expect(() => foam.update(renderer as never, Number.NaN)).toThrow(/frameDt/);
  expect(() => foam.update(renderer as never, -1)).toThrow(/frameDt/);
});

it('shoreline recentering preserves integer texels on both sides of world zero', () => {
  const texel = SHORE_REGION_METRES / 512;
  for (const center of [-1000.25, -0.01, 0, 15.9, 1024.3]) {
    const origin = shoreOrigin(center, texel);
    expect((origin + SHORE_REGION_METRES / 2) / texel).toBe(Math.floor(center / texel));
    expect(shoreOrigin(center + 7 * texel, texel) - origin).toBe(7 * texel);
    expect((123.5 - origin) / texel - (123.5 - (origin + 7 * texel)) / texel).toBe(7);
  }
});

it('reusable FFT plans preserve every float32 bit across different inputs', async () => {
  const { createCpuIFFT2D } = await import('../src/sea-physics/cpuFft');
  const { cpuButterflyIFFT, generateButterfly } = await import('../src/ocean/oceanMath');
  for (const n of [8, 64, 128]) {
    const table = generateButterfly(n);
    const transform = createCpuIFFT2D(table, n);
    for (const phase of [0, 0.8, -1]) {
      const make = () => ({ re: Float32Array.from({ length: n * n }, (_, i) => Math.sin(i * 1.7 + phase)),
        im: Float32Array.from({ length: n * n }, (_, i) => Math.cos(i * 0.31 + phase)) });
      const actual = make(), reference = make();
      // Original allocation-per-line path; independent of cpuIFFT2D's workspace.
      for (let row = 0; row < n; row++) {
        const out = cpuButterflyIFFT({ re: reference.re.slice(row * n, (row + 1) * n),
          im: reference.im.slice(row * n, (row + 1) * n) }, table, n);
        reference.re.set(out.re, row * n); reference.im.set(out.im, row * n);
      }
      for (let col = 0; col < n; col++) {
        const out = cpuButterflyIFFT({
          re: Float32Array.from({ length: n }, (_, row) => reference.re[row * n + col]),
          im: Float32Array.from({ length: n }, (_, row) => reference.im[row * n + col]),
        }, table, n);
        for (let row = 0; row < n; row++) {
          reference.re[row * n + col] = out.re[row]; reference.im[row * n + col] = out.im[row];
        }
      }
      transform(actual);
      expect(new Uint8Array(actual.re.buffer)).toEqual(new Uint8Array(reference.re.buffer));
      expect(new Uint8Array(actual.im.buffer)).toEqual(new Uint8Array(reference.im.buffer));
    }
  }
});

it('submits one stable ordered foam group per owed fixed step', () => {
  const sea = new OceanSimulation(7, { ...oceanParams, resolution: 32 });
  const foam = createFoamSim(sea.cascades, 32, sea);
  const calls: any[][] = [];
  const renderer = { compute: (nodes: any[]) => calls.push(nodes) };
  foam.update(renderer as never, 1 / 60);
  expect(calls).toHaveLength(1);
  const group = calls[0];
  // Each band injects then blurs; the first two also reduce to their coarse tier.
  expect(group.map(node => node.count)).toEqual([1024, 1024, 64, 1024, 1024, 64, 1024, 1024]);
  expect(new Set(group).size).toBe(8);
  calls.length = 0;
  foam.update(renderer as never, 2 / 60);
  expect(calls).toHaveLength(2);
  expect(calls.every(nodes => nodes === group)).toBe(true);
});


describe('wave detail hands removed variance to specular', () => {
  const amplitude = uniform(1), variance = uniform(0.5);
  const unresolved = unresolvedSlopeVarianceNode(amplitude, variance);

  it('preserves measured sine-wave variance throughout the distance fade', () => {
    // Integrate the resolved wave, rather than repeat the shader equation.
    // At half amplitude its measured variance is 0.125, so the missing part
    // must be 0.375. The former linear complement restored only 0.25.
    for (let step = 0; step <= 20; step++) {
      amplitude.value = step / 20;
      let measured = 0;
      const samples = 4096;
      for (let i = 0; i < samples; i++) {
        const slope = Math.cos(2 * Math.PI * i / samples) * amplitude.value;
        measured += slope * slope / samples;
      }
      expect(measured + scalar(unresolved)).toBeCloseTo(0.5, 6);
    }
  });

  it('composes amplitude fades before partitioning variance', () => {
    amplitude.value = 0.5 * 0.5;
    expect(scalar(unresolved)).toBe(0.46875);
    amplitude.value = 1;
    expect(scalar(unresolved)).toBe(0);
    amplitude.value = 0;
    expect(scalar(unresolved)).toBe(0.5);
  });
});


describe('water reflection sees sky above and sea below the horizon', () => {
  const height = uniform(0), footprint = uniform(0), variance = uniform(0);
  const visibility = reflectionSkyVisibilityNode(height, footprint, variance);
  const at = (y: number, width = 0, spread = 0) => {
    height.value = y;
    footprint.value = width;
    variance.value = spread;
    return scalar(visibility);
  };

  it('rejects below-horizon sky while retaining resolved upward reflection', () => {
    expect(at(-0.1)).toBe(0);
    expect(at(0.1)).toBe(1);
    expect(at(0)).toBe(0.5);
  });

  it('filters the crossing with complementary sky and sea shares', () => {
    for (const width of [0, 0.01, 0.1]) {
      for (const spread of [0, 0.0025, 0.04]) {
        let previous = 0;
        for (let i = -100; i <= 100; i++) {
          const value = at(i / 100, width, spread);
          expect(value).toBeGreaterThanOrEqual(previous - 1e-7);
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1);
          expect(value + at(-i / 100, width, spread)).toBeCloseTo(1, 6);
          previous = value;
        }
      }
    }
  });

  it('keeps unresolved wave spread after screen derivatives disappear', () => {
    const rough = at(0.05, 0, 0.01);
    expect(rough).toBeGreaterThan(0.5);
    expect(rough).toBeLessThan(0.8);
    expect(at(0.05, 0, 0)).toBe(1);
    expect(at(-0.05, 0, 0.01)).toBeCloseTo(1 - rough, 6);
  });
});


describe('wake age across near/far coverage handover', () => {
  const a = uniform(0), b = uniform(0), ageA = uniform(0), ageB = uniform(0);
  const node = coverageWeightedAgeNode(a, ageA, b, ageB);
  it('empty or disabled tiers cannot change the visible age', () => {
    for (const age of [0, 0.2, 0.8, 1]) {
      a.value = 0.2; b.value = 0; ageA.value = age; ageB.value = 1 - age;
      expect(scalar(node)).toBeCloseTo(age, 6);
      a.value = 0; b.value = 0.3; ageA.value = 1 - age; ageB.value = age;
      expect(scalar(node)).toBeCloseTo(age, 6);
    }
    a.value = b.value = 0;
    expect(scalar(node)).toBe(0);
  });
  it('preserves the fresh coverage contributed by unequal tiers', () => {
    ageA.value = 1; ageB.value = 0.1;
    for (let i = 0; i <= 100; i++) {
      const blend = i / 100;
      a.value = 0.8 * (1 - blend);
      b.value = 0.04 * blend;
      const age = scalar(node);
      expect(age).toBeGreaterThanOrEqual(0.1 - 1e-6);
      expect(age).toBeLessThanOrEqual(1 + 1e-6);
      expect(age * (a.value + b.value)).toBeCloseTo(a.value + b.value * 0.1, 6);
    }
  });
});


describe('contact and shore age only affect their own coverage', () => {
  const contact = uniform(0), shore = uniform(0), shoreAge = uniform(0.2);
  const unmeasured = foamSourceAgesNode(uniform(0.4), null, contact, shore, shoreAge);
  const measured = foamSourceAgesNode(uniform(0.4), uniform(0.3), contact, shore, shoreAge);
  it('empty shore support preserves all three analytic wake laws', () => {
    contact.value = shore.value = 0;
    expect(scalar(unmeasured.body)).toBeCloseTo(0.4);
    expect(scalar(unmeasured.edge)).toBe(1);
    expect(scalar(unmeasured.lighting)).toBe(0);
    for (const age of Object.values(measured)) expect(scalar(age)).toBeCloseTo(0.3);
  });
  it('fresh contact and aged shore replace only the covered source', () => {
    contact.value = 1; shore.value = 1;
    for (const age of Object.values(unmeasured)) expect(scalar(age)).toBe(1);
    contact.value = 0;
    for (const age of Object.values(unmeasured)) expect(scalar(age)).toBeCloseTo(0.2);
  });
  it('partial shore cannot turn an unmeasured wake into fresh whitecaps', () => {
    contact.value = 0; shore.value = 0.1;
    expect(scalar(unmeasured.lighting)).toBeCloseTo(0.02);
    expect(scalar(unmeasured.edge)).toBeCloseTo(0.92);
    expect(scalar(unmeasured.body)).toBeCloseTo(0.38);
  });
});

/**
 * B125 ("hovercraft" boats): with the reflection switched off, the outboard legs a metre under a boat at rest still
 * hung below her, because the see-through lookup followed the STRAIGHT view ray. At a low lens that ray runs nearly
 * flat under the surface and shows submerged geometry at its above-water size, right where her reflection lies.
 */
describe('B125 the see-through follows the refracted ray', () => {
  const IOR = 1.333;
  const eye = { x: 0, y: 0.25, z: 0 }; // the trailer's low lens, 25 cm over the water
  const leg = { x: 0, y: -0.7, z: 4.5 }; // a lower unit 70 cm down, 4.5 m off
  const unit = (v: { x: number; y: number; z: number }) => {
    const l = Math.hypot(v.x, v.y, v.z);
    return { x: v.x / l, y: v.y / l, z: v.z / l };
  };
  /** screen angle below the horizon, degrees, of a world point seen from the eye */
  const below = (p: { x: number; y: number; z: number }) => (Math.atan2(eye.y - p.y, p.z - eye.z) * 180) / Math.PI;

  it('the water pixel whose straight ray reached the leg now looks far deeper than the leg', () => {
    const t = (eye.y - 0) / (eye.y - leg.y);
    const surface = { x: 0, y: 0, z: eye.z + (leg.z - eye.z) * t };
    const pathLen = Math.hypot(leg.z - surface.z, leg.y - surface.y);
    const q = snellLookupPoint(surface, unit({ x: 0, y: -eye.y, z: surface.z }), pathLen, IOR);
    // the old lookup was the leg itself; the refracted one is metres under it, where there is no boat
    expect(q.y).toBeLessThan(leg.y - 1.5);
  });

  it("the leg's image moves up to the waterline instead of hanging under the hull", () => {
    // the water point whose REFRACTED ray reaches the leg: walk the surface toward the boat until it passes through it
    let apparent = Number.NaN;
    for (let z = 0.3; z < leg.z; z += 0.001) {
      const surface = { x: 0, y: 0, z };
      const d = unit({ x: 0, y: -eye.y, z });
      const q = snellLookupPoint(surface, d, 1, IOR);
      const slope = (q.z - z) / (surface.y - q.y); // horizontal metres per metre of depth
      if (Math.abs(z + slope * -leg.y - leg.z) < 0.01) { apparent = below(surface); break; }
    }
    const straight = below(leg);
    const waterline = below({ x: 0, y: 0, z: leg.z });
    expect(Number.isFinite(apparent)).toBe(true);
    // straight: 12° under the horizon, 9° under the waterline. Refracted: within a degree of the waterline
    expect(straight - waterline).toBeGreaterThan(8);
    expect(apparent - waterline).toBeLessThan((straight - waterline) / 8);
  });

  it('is the straight ray looking straight down, and never bends past the critical angle', () => {
    const q = snellLookupPoint({ x: 1, y: 0, z: 2 }, { x: 0, y: -1, z: 0 }, 3, IOR);
    expect(q.x).toBeCloseTo(1, 9);
    expect(q.z).toBeCloseTo(2, 9);
    expect(q.y).toBeCloseTo(-3, 9);
    for (const elevDeg of [0.5, 3, 10, 30, 60, 89]) {
      const e = (elevDeg * Math.PI) / 180;
      const p = snellLookupPoint({ x: 0, y: 0, z: 0 }, { x: 0, y: -Math.sin(e), z: Math.cos(e) }, 1, IOR);
      expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(1, 9); // unit ray: pathLen is a length along it
      expect(Math.atan2(p.z, -p.y)).toBeLessThanOrEqual(Math.asin(1 / IOR) + 1e-9);
    }
  });
});
