/**
 * T27 terrain noise — CPU mirror tests (§V16 spirit: proven math, no magic).
 *
 * WHY: src/terrain/noise.ts (TSL) and src/terrain/noiseCpu.ts implement the
 * SAME formulas; the shader side cannot run under vitest, so these tests pin
 * the shared math. NaN or out-of-range noise on the GPU = black holes /
 * garbage tint on the island terrain — the sweeps below (negative and large
 * coordinates included) are the guard against that.
 *
 * Documented ranges: hash / valueNoise / fbm all return values in [0, 1].
 */
import { describe, expect, it } from 'vitest';
import { bandLimitEnergy, periodResolvedValue } from '../src/ship/bandLimit';
import { getParamsEntry } from '../src/params/registry';
import { Color } from 'three/webgpu';
import { oceanSurfaceParams } from '../src/params/oceanSurface';
import {
  aerialHazeFactorCpu,
  createAerialUniforms,
  updateAerialUniforms,
} from '../src/terrain/aerialPerspective';
import {
  rippleBedGateEdges,
  rippleReliefFilterGain,
  rippleSlope,
  rippleSlopeVariance,
  roughnessWithSlopeVariance,
  terrainBlendMaterial,
} from '../src/terrain/sandMaterial';
import {
  fadeCpu,
  fbm2Cpu,
  fractCpu,
  hash2Cpu,
  hash3Cpu,
  valueNoise2Cpu,
} from '../src/terrain/noiseCpu';

/** sweep incl. negatives, zero, fractions, large coords (GPU danger zones) */
const SWEEP = [-1e5, -1234.56, -7.25, -1, -0.5, 0, 0.5, 1, 7.25, 1234.56, 1e5];

describe('hash (determinism + range)', () => {
  it('same input → same output, bit-identical', () => {
    for (const x of SWEEP) {
      for (const y of SWEEP) {
        expect(hash2Cpu(x, y)).toBe(hash2Cpu(x, y));
        expect(hash3Cpu(x, y, x - y)).toBe(hash3Cpu(x, y, x - y));
      }
    }
  });

  it('outputs stay in [0, 1) and are never NaN across the sweep', () => {
    for (const x of SWEEP) {
      for (const y of SWEEP) {
        for (const h of [hash2Cpu(x, y), hash3Cpu(x, y, x * 0.7 + y)]) {
          expect(Number.isNaN(h)).toBe(false);
          expect(h).toBeGreaterThanOrEqual(0);
          expect(h).toBeLessThan(1);
        }
      }
    }
  });

  it('decorrelates neighbours (not constant, not linear)', () => {
    const values = new Set<number>();
    for (let i = 0; i < 100; i++) values.add(hash2Cpu(i, i * 3 + 1));
    expect(values.size).toBeGreaterThan(95); // collisions ≈ none
  });
});

describe('fade curve', () => {
  it('fixes endpoints (0→0, 1→1) and is monotone inside', () => {
    expect(fadeCpu(0)).toBe(0);
    expect(fadeCpu(1)).toBe(1);
    let prev = 0;
    for (let t = 0.05; t <= 1.0001; t += 0.05) {
      const f = fadeCpu(t);
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
  });
});

describe('value noise (range + determinism + continuity)', () => {
  it('deterministic and bounded [0, 1], no NaN, dense grid sweep', () => {
    for (let ix = -30; ix <= 30; ix++) {
      for (let iy = -30; iy <= 30; iy++) {
        const x = ix * 37.31; // covers negative, fractional, far-out coords
        const y = iy * 21.77;
        const n = valueNoise2Cpu(x, y);
        expect(n).toBe(valueNoise2Cpu(x, y));
        expect(Number.isNaN(n)).toBe(false);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is continuous: tiny step → tiny change (no lattice seams)', () => {
    const eps = 1e-4;
    for (const x of [-5.5, -1, 0, 0.999, 3.14, 42]) {
      const a = valueNoise2Cpu(x, x * 0.5);
      const b = valueNoise2Cpu(x + eps, x * 0.5 + eps);
      expect(Math.abs(a - b)).toBeLessThan(0.01);
    }
  });
});

describe('fbm (octave behaviour, §V16 mirror of shader fbm)', () => {
  const sample = (oct: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < 900; i++) {
      const x = (i % 30) * 1.37 - 20; // includes negative region
      const y = Math.floor(i / 30) * 2.11 - 30;
      out.push(fbm2Cpu(x, y, oct));
    }
    return out;
  };
  const variance = (v: number[]): number => {
    const mean = v.reduce((s, x) => s + x, 0) / v.length;
    return v.reduce((s, x) => s + (x - mean) * (x - mean), 0) / v.length;
  };

  it('deterministic, bounded [0, 1], NaN-free for 1..4 octaves', () => {
    for (let oct = 1; oct <= 4; oct++) {
      const v = sample(oct);
      for (const n of v) {
        expect(Number.isNaN(n)).toBe(false);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(1);
      }
      expect(fbm2Cpu(-7.7, 13.3, oct)).toBe(fbm2Cpu(-7.7, 13.3, oct));
    }
  });

  it('more octaves add detail: higher octave output differs from base and variance stays bounded', () => {
    const v1 = sample(1);
    const v4 = sample(4);
    // detail added: the 4-octave field is not the 1-octave field
    let maxDiff = 0;
    for (let i = 0; i < v1.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(v1[i] - v4[i]));
    }
    expect(maxDiff).toBeGreaterThan(0.05);
    // normalization keeps energy bounded: variance finite, positive, ≤ 1-oct
    // variance + slack (fbm averages octaves, it must not blow up)
    const var1 = variance(v1);
    const var4 = variance(v4);
    expect(var1).toBeGreaterThan(0);
    expect(var4).toBeGreaterThan(0);
    expect(Number.isFinite(var4)).toBe(true);
    expect(var4).toBeLessThanOrEqual(var1 * 1.5);
  });

  it('extreme coords (±1e5) produce finite in-range output', () => {
    for (const x of [-1e5, 1e5]) {
      for (const y of [-1e5, -3.3, 0, 1e5]) {
        const n = fbm2Cpu(x, y, 4);
        expect(Number.isFinite(n)).toBe(true);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(1);
      }
    }
  });

  it('fract matches GLSL/WGSL semantics (negative inputs wrap into [0,1))', () => {
    expect(fractCpu(-0.25)).toBeCloseTo(0.75, 12);
    expect(fractCpu(3.5)).toBeCloseTo(0.5, 12);
    expect(fractCpu(-3)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T33 shore swash — CPU mirror of the timing in src/terrain/shoreRunup.ts.
//
// WHY these properties: "waves lapping on the beach" is a TIMING read, not a
// texture. If the tongue rushed up and drained at the same rate it reads as a
// pulsing ring; if the wet band could sit below the water's current reach the
// sand would dry AHEAD of the wave, which is the one artefact that instantly
// kills the illusion. Those are the invariants pinned here.
// ---------------------------------------------------------------------------
import { swashShapeCpu, wetLevelCpu } from '../src/terrain/shoreRunup';
import { terrainParams } from '../src/params/terrain';

const RISE = terrainParams.runupRiseFraction;

describe('swash tongue shape (rush up, drain back)', () => {
  it('starts dry, peaks exactly at the rise phase, and fully retreats', () => {
    expect(swashShapeCpu(0, RISE)).toBeCloseTo(0, 9);
    expect(swashShapeCpu(RISE, RISE)).toBeCloseTo(1, 9);
    expect(swashShapeCpu(1, RISE)).toBeCloseTo(0, 9);
  });

  it('rises monotonically then falls monotonically — one tongue per cycle', () => {
    let prev = -1;
    for (let p = 0; p <= RISE; p += RISE / 40) {
      const v = swashShapeCpu(p, RISE);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = v;
    }
    prev = 2;
    for (let p = RISE; p <= 1; p += (1 - RISE) / 40) {
      const v = swashShapeCpu(p, RISE);
      expect(v).toBeLessThanOrEqual(prev + 1e-12);
      prev = v;
    }
  });

  it('runs up faster than it drains back (that asymmetry IS the lapping)', () => {
    const d = 1e-4;
    const upSpeed = (swashShapeCpu(RISE, RISE) - swashShapeCpu(RISE - d, RISE)) / d;
    const downSpeed = (swashShapeCpu(RISE, RISE) - swashShapeCpu(RISE + d, RISE)) / d;
    // both ~0 at the smooth peak, so compare over the half-way points instead
    const upMid = swashShapeCpu(RISE * 0.5, RISE);
    const downMid = swashShapeCpu(RISE + (1 - RISE) * 0.5, RISE);
    expect(upMid).toBeCloseTo(downMid, 6); // same 0.5 at each half-way point
    expect(RISE).toBeLessThan(0.5); // …reached in less than half the cycle
    expect(Number.isFinite(upSpeed) && Number.isFinite(downSpeed)).toBe(true);
  });

  it('stays in [0,1] and NaN-free for degenerate rise fractions', () => {
    for (const rise of [-5, 0, 0.001, 0.5, 1, 7]) {
      for (let p = 0; p <= 1; p += 0.05) {
        const v = swashShapeCpu(p, rise);
        expect(Number.isNaN(v)).toBe(false);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('wet-sand memory (darkens where water was, dries behind it)', () => {
  const P = terrainParams.runupPeriod;
  const DRY = terrainParams.dryTime;

  it('never sits below the water level the tongue has already reached', () => {
    // sand drying AHEAD of the wave is the artefact that kills the read
    for (let p = 0; p <= 1; p += 0.02) {
      const level = 1.2 * swashShapeCpu(p, RISE);
      const wet = wetLevelCpu(p, P, DRY, RISE, 1.2, 0.9, 0.6);
      expect(wet).toBeGreaterThanOrEqual(level - 1e-9);
    }
  });

  it('the previous wave\'s mark fades as the cycle progresses', () => {
    // no current wave (a0 = 0): all that is left is the drying memory
    const early = wetLevelCpu(0.05, P, DRY, RISE, 0, 1, 0);
    const late = wetLevelCpu(0.95, P, DRY, RISE, 0, 1, 0);
    expect(late).toBeLessThan(early);
    expect(late).toBeGreaterThan(0); // still damp — it dries, it doesn't blink
  });

  it('a shorter drying time leaves less residue', () => {
    const slow = wetLevelCpu(0.6, P, 30, RISE, 0, 1, 1);
    const fast = wetLevelCpu(0.6, P, 1, RISE, 0, 1, 1);
    expect(fast).toBeLessThan(slow);
  });

  it('is NaN-free with a zero drying time (§V28 floored divisor)', () => {
    expect(Number.isNaN(wetLevelCpu(0.5, P, 0, RISE, 1, 1, 1))).toBe(false);
    expect(Number.isNaN(wetLevelCpu(0.5, 0, 0, 0, 1, 1, 1))).toBe(false);
  });
});

describe('material construction (node graph builds without a renderer)', () => {
  it('terrainBlendMaterial builds with the swash wired in', async () => {
    // catches TSL misuse at graph-build time (wrong arg counts, chained math
    // on plain numbers) without needing a GPU — the shader itself still needs
    // the browser check (§V22)
    const { terrainBlendMaterial } = await import('../src/terrain/sandMaterial');
    const handle = terrainBlendMaterial();
    expect(handle.shore).not.toBeNull();
    expect(handle.material.colorNode).toBeTruthy();
    expect(handle.material.roughnessNode).toBeTruthy();
    // the three per-frame swash inputs must all exist for the island to wire
    handle.setTime(3.5);
    handle.setSwell(2.1);
    handle.setWaterline(0.4);
    expect(handle.shore?.time.value).toBe(3.5);
    expect(handle.shore?.swell.value).toBe(2.1);
    expect(handle.uniforms.sand.waterline.value).toBe(0.4);
    handle.updateFromParams();
    handle.dispose();
  });

  it('exposes the waterline gate that keeps §V34 caustics off dry land', async () => {
    // causticsNode hard-codes `submerged = 1` for mode:'below', and its only
    // depth budget (maxDepth) culls water that is too DEEP — so nothing in the
    // module stops a 35 m hilltop being lit as if it sat just under the
    // surface. One material shades our seabed AND our peak, so the gate has to
    // live here. §V16: it is a tunable, so it is a param.
    const { getParamsEntry } = await import('../src/params/registry');
    expect(getParamsEntry('terrain')?.params).toBe(terrainParams);
    expect(terrainParams.causticsWaterlineBand).toBeGreaterThan(0);
    const { createSandUniforms, updateSandUniforms } = await import('../src/terrain/sandMaterial');
    const u = createSandUniforms();
    expect(u.causticsBand.value).toBe(terrainParams.causticsWaterlineBand);
    const prev = terrainParams.causticsWaterlineBand;
    terrainParams.causticsWaterlineBand = 1.25;
    try {
      updateSandUniforms(u);
      expect(u.causticsBand.value).toBe(1.25); // live, not baked
    } finally {
      terrainParams.causticsWaterlineBand = prev;
    }
  });

  it('falls back to the flat waterline when no caustics instance is bound', async () => {
    // §V34 receivers must degrade, not explode: with nothing bound the sea
    // height is the uniform the island drives from CpuOcean, and waterLighting
    // returns identity nodes. This is also the `receiveCaustics = false`
    // bisect path (§V17) — the beach still shades, just without caustics.
    const { buildSandNodes, createSandUniforms } = await import('../src/terrain/sandMaterial');
    const nodes = buildSandNodes(createSandUniforms(), 2, null);
    expect(nodes.liveWaterHeight).toBe(false);
    expect(nodes.depthBelow).toBeTruthy(); // still supplied to the receiver hook
    expect(nodes.color).toBeTruthy();
  });

  it('runupEnabled = false builds a plain beach with no swash uniforms', async () => {
    const { createSandMaterial } = await import('../src/terrain/sandMaterial');
    const prev = terrainParams.runupEnabled;
    terrainParams.runupEnabled = false;
    try {
      const handle = createSandMaterial();
      expect(handle.shore).toBeNull();
      expect(handle.material.colorNode).toBeTruthy();
      handle.setTime(1); // no-op, must not throw
      handle.dispose();
    } finally {
      terrainParams.runupEnabled = prev;
    }
  });
});

describe('§V.48 band limits on the terrain material (the §B.20 shape, again)', () => {
  // src/terrain, src/island and src/vegetation contained ZERO band limiting —
  // no fwidth, no dFdx, no reference to src/ship/bandLimit — while carrying
  // three procedural terms measurably finer than a pixel at island range.
  // A TSL graph cannot be evaluated headless, so this drives the CPU mirrors
  // in bandLimit.ts (the same transliteration-pair convention as
  // tests/shipDetail.test.ts) at the feature widths the material actually has.
  //
  // Pixel footprint: 1440p, 75° horizontal ⇒ 1955 px/rad, so one pixel spans
  // dist/1955 metres head-on and ~10× that on a beach seen from a deck.
  const PX_PER_RAD = 2560 / ((75 * Math.PI) / 180);
  const metresPerPixel = (dist: number, grazing = 1): number => (dist / PX_PER_RAD) * grazing;

  /**
   * §B.43 — CPU mirror of the sparkle cell sizing in `buildSandNodes`.
   * `cellTarget = max(pixWorld · cellPixels, minCell)`, quantised down to an
   * octave. Change one side, change the other (the noise.ts/noiseCpu.ts and
   * shoreRunup.ts conventions).
   */
  const sparkleCellSize = (pixWorld: number): number => {
    const p = terrainParams;
    const target = Math.max(pixWorld * p.sparkleCellPixels, p.sparkleMinCell);
    return Math.max(2 ** Math.floor(Math.log2(target)), p.sparkleMinCell);
  };

  it('the sand SPARKLE holds a fixed PIXEL size at every distance (§B.43)', () => {
    // THE DEFECT: cells used to be world-locked at 1/sparkleDensity = 0.167 m,
    // which is ~11 px from the deck (fat bright dots — the user's "dense
    // speckle of small bright dots") and a quarter of a pixel at 300 m (a
    // per-pixel coin flip on a binary step — stipple). ONE world size cannot
    // be right at both ends. Sizing the cell from the pixel's own footprint
    // is what makes it right at all of them, so this is no longer a "fades
    // before it aliases" test — the cells CANNOT go sub-pixel by construction.
    const p = terrainParams;
    // every viewing case in the reports, from standing on the sand to a beach
    // a kilometre off seen at grazing incidence from a deck
    const cases: [number, number][] = [
      [3, 1], [30, 1], [30, 10], [120, 4], [300, 10], [1200, 1], [1200, 10],
    ];
    for (const [dist, grazing] of cases) {
      const pixWorld = metresPerPixel(dist, grazing);
      const cellPix = sparkleCellSize(pixWorld) / pixWorld;
      // the octave quantisation makes this a sawtooth between cellPixels and
      // half of it — i.e. 1.3-2.6 px at the shipped 2.6. Never a fat blob,
      // never sub-pixel. The 0.167 m world cell was 11.3 px at [30,1].
      expect(cellPix).toBeGreaterThanOrEqual(p.sparkleCellPixels * 0.5 - 1e-6);
      expect(cellPix).toBeLessThanOrEqual(p.sparkleCellPixels + 1e-6);
    }
  });

  it('the sand SPARKLE keeps its MEAN across an octave boundary (§V.48b)', () => {
    // The ocean measured a hard 2.52× step in this term's own mean at every
    // octave doubling, because a CONSTANT pixel radius against an
    // octave-quantised cell makes `coverage` = ½π(rad/cell)² discontinuous.
    // Sizing the glint as a FRACTION of its cell removes it: `coverage`
    // becomes a function of `radiusPixels / cellPixels` alone, which does not
    // move with the octave at all. This pins that the sand carries the same
    // cure, since it is the reason the fix preserves brightness instead of
    // making the beach flash at visibility rings.
    const p = terrainParams;
    const coverageAt = (pixWorld: number): number => {
      const cellPix = sparkleCellSize(pixWorld) / pixWorld;
      const radPix = Math.max(cellPix * (p.sparkleRadiusPixels / p.sparkleCellPixels), 0.02);
      return Math.min(1, (radPix * radPix * Math.PI * 0.5) / Math.max(cellPix * cellPix, 1e-4));
    };
    // sweep a full octave of footprint and straddle the boundary
    const samples: number[] = [];
    for (let i = 0; i <= 24; i++) samples.push(coverageAt(0.004 * 2 ** (i / 12)));
    const lo = Math.min(...samples);
    const hi = Math.max(...samples);
    // constant to within float noise — no step, and therefore no visible ring
    expect(hi - lo).toBeLessThan(1e-6);
  });

  it('the sand GRAIN fades before its period goes sub-pixel', () => {
    const feature = 1 / terrainParams.sandGrainScale;
    expect(periodResolvedValue(metresPerPixel(20, 1) / feature)).toBeGreaterThan(0.9);
    expect(periodResolvedValue(metresPerPixel(200, 10) / feature)).toBe(0);
  });

  it('the ROCK posterize edge keeps ≥2 px of transition, then loses amplitude', () => {
    // §B.20's lesson verbatim: measure the SHARPEST FEATURE, not the repeat.
    // The rock fbm's finest octave is ~1.56 m but the band edge inside it is
    // ~0.09 m — it goes sub-pixel about seventeen times sooner, and the whole
    // distance band between the two is where the speckle lives.
    const edge = 0.09;
    const repeat = 1.56;
    // near: full contrast survives
    expect(bandLimitEnergy(edge, metresPerPixel(40, 1))).toBeGreaterThan(0.9);
    // a cliff face 400 m off: the edge is long gone…
    expect(bandLimitEnergy(edge, metresPerPixel(400, 1))).toBeLessThan(0.5);
    // …while a limit measured against the REPEAT would still read as fine,
    // which is exactly the mistake that left the hull speckling
    expect(bandLimitEnergy(repeat, metresPerPixel(400, 1))).toBeGreaterThan(0.9);
  });

  it('every band limit reaches exactly zero contribution, never a floor', () => {
    // a limit that asymptotes to a small non-zero value still speckles; it
    // just takes a bigger screen to notice
    expect(periodResolvedValue(50)).toBe(0);
    expect(bandLimitEnergy(0.09, 100)).toBeLessThan(0.001);
  });
});

describe('the sand bedform gives the seabed a NORMAL (§V.48/§V.64, ba4eae5\'s lesson)', () => {
  // Same pixel model as the band-limit block above.
  const PX_PER_RAD = 2560 / ((75 * Math.PI) / 180);
  const metresPerPixel = (dist: number, grazing = 1): number => (dist / PX_PER_RAD) * grazing;
  /** the ripple coordinate counts CRESTS, so its footprint is pixels/λ */
  const rippleFilterAt = (dist: number, grazing = 1): number =>
    metresPerPixel(dist, grazing) / terrainParams.rippleWavelength;

  it('is authored inside the physical wave-ripple height:wavelength band', () => {
    // Real wave-formed bedforms run 1:7 (steep, fresh) to 1:10 (relict). This
    // is not decoration: the height is the ONLY input to the shading normal,
    // so a number picked for looks is a lie about a quantity with units. If
    // someone later dials `rippleHeight` for taste, this is what tells them
    // they have left the physics — and the two traps on either side of the
    // dial (`ba4eae5` moiré above, `bb5b3cb` glare above) are why that matters.
    const ratio = terrainParams.rippleWavelength / terrainParams.rippleHeight;
    expect(ratio).toBeGreaterThanOrEqual(7);
    expect(ratio).toBeLessThanOrEqual(10);
  });

  it('a flank swings N·L enough for a caustic filament to graze across it', () => {
    // The REASON this work was done: `aa8a9cb` made the caustics sparse and
    // structural, which exposed the seabed's flatness rather than hiding it.
    // A normal that does not move the diffuse term buys nothing.
    const s = rippleSlope(terrainParams.rippleHeight, terrainParams.rippleWavelength);
    const tilt = Math.atan(s);
    // sun 45° from vertical in air refracts to ~32° underwater (Snell, n=1.33)
    const sunUnderwater = Math.asin(Math.sin(Math.PI / 4) / 1.33);
    const near = Math.cos(sunUnderwater - tilt);
    const far = Math.cos(sunUnderwater + tilt);
    // a flank-to-flank contrast of at least 1.35× — below that the relief is
    // present in the buffer and absent to the eye
    expect(near / far).toBeGreaterThan(1.35);
  });

  it('the NORMAL retires earlier in distance than the COLOUR — the whole of ba4eae5', () => {
    // §V.48 band-limits the HEIGHT field and says NOTHING about the normal,
    // whose per-pixel excursion is far larger. `periodResolved` starts fading
    // at 2.5 samples per period, which is fine for a ±0.11 albedo modulation
    // and is a moiré generator for a 17° normal swing. So the relief consumer
    // measures the same footprint at an inflated gain, and the colour consumer
    // keeps the uninflated gate.
    const gain = rippleReliefFilterGain(
      terrainParams.rippleHeight,
      terrainParams.rippleWavelength,
    );
    expect(gain).toBeGreaterThan(1);
    // both reach exactly zero at filter 1.1, so the ratio of the distances at
    // which they die IS the gain: the normal goes 1.31× nearer than the tint
    const dies = (g: number): number => {
      let d = 1;
      while (periodResolvedValue(rippleFilterAt(d, 10) * g) > 0 && d < 1e5) d += 1;
      return d;
    };
    expect(dies(1) / dies(gain)).toBeCloseTo(gain, 1);
    // and in the band between them the colour is still fully present while the
    // normal has already begun to go — which is the point, not a side effect
    const mid = (dies(gain) + dies(1)) / 2;
    expect(periodResolvedValue(rippleFilterAt(mid, 10))).toBeGreaterThan(0);
    expect(periodResolvedValue(rippleFilterAt(mid, 10) * gain)).toBe(0);
  });

  it('a flat bedform inflates nothing — the gate reduces to plain §V.48', () => {
    // COMPATIBILITY, and the reason the form is `1 + S` rather than a tuned
    // multiplier: with no relief authored there is no normal to protect and
    // the colour term must land exactly where it always did.
    expect(rippleReliefFilterGain(0, terrainParams.rippleWavelength)).toBe(1);
    expect(rippleSlopeVariance(0, terrainParams.rippleWavelength)).toBe(0);
  });

  it('§V.64: the retired slope becomes ROUGHNESS, and cannot be swallowed', () => {
    // `bb5b3cb` measured what a too-smooth submerged seabed costs: at
    // roughness 0.066 the sun's disc landed on the sea floor whole, 363
    // scene-linear. The floor at 0.3 is what stopped it, and a normal map on a
    // 0.3 surface is a glint generator — so as the bedform's normal retires
    // with distance its variance has to arrive somewhere that SPREADS the
    // lobe, not vanish.
    const floor = terrainParams.underwaterRoughnessFloor;
    const variance = rippleSlopeVariance(
      terrainParams.rippleHeight,
      terrainParams.rippleWavelength,
    );
    // identity when nothing has been lost — no tuning back to neutral
    expect(roughnessWithSlopeVariance(floor, 0)).toBeCloseTo(floor, 12);
    // monotone, and it can only ever roughen
    const full = roughnessWithSlopeVariance(floor, variance);
    expect(full).toBeGreaterThan(floor);
    expect(roughnessWithSlopeVariance(floor, variance * 0.5)).toBeLessThan(full);
    // the carry has to CLEAR the floor to mean anything. Folded in before the
    // floor it would be multiplied by the caustics module's 0.22 wet gloss and
    // then thrown straight back to 0.3 — a silent no-op, which is why the
    // material applies it last.
    expect(full).toBeGreaterThan(floor * 1.5);
    expect(full).toBeLessThan(1);
  });

  it('the bedform is exactly zero everywhere rock can win — the normal leak', () => {
    // `material.normalNode` is set for the WHOLE blend material, so
    // `normalWorld` in the rock and ground-cover branches reads the perturbed
    // normal too. Nothing weights it down per-layer, and nothing can: the
    // layer weights key on the slope, so a weighted normal would depend on
    // itself. The bed-flatness gate is what closes it, and it closes it by
    // geometry — this asserts the two thresholds cannot drift into overlap.
    const p = terrainParams;
    const [lo, hi] = rippleBedGateEdges(p.rippleBedSlopeMax);
    expect(lo).toBeLessThan(hi);
    const gate = (ny: number): number => {
      const t = Math.min(1, Math.max(0, (ny - lo) / (hi - lo)));
      return t * t * (3 - 2 * t);
    };
    // rock exists below slopeThreshold + slopeBlendWidth; the bedform is gone
    // well above that, so no fragment gets both
    expect(gate(p.slopeThreshold + p.slopeBlendWidth)).toBe(0);
    // and it is still fully present on the gentle shelf the ripples live on
    expect(gate(Math.cos((5 * Math.PI) / 180))).toBeCloseTo(1, 6);
  });
});

describe('§V43 ground cover (an island is not a sand dune)', () => {
  it('registers every cover tunable with the params registry (§V16)', () => {
    const entry = getParamsEntry('terrain');
    expect(entry).toBeDefined();
    for (const key of [
      'shoreBandHeight',
      'shoreBandFade',
      'vegBaseColor',
      'vegShadeColor',
      'vegDryColor',
      'vegScale',
      'vegDryStrength',
      'vegSlopeThreshold',
      'vegRoughness',
    ]) {
      expect(entry!.params).toHaveProperty(key);
    }
  });

  it('cover holds a stricter slope than sand, so walls stay bare rock', () => {
    // this is what makes a headland wall and a sea stack read as ROCK rather
    // than a grassy ramp — the whole reason those walls went into the height
    // field. If someone ever loosens it below sand's threshold the silhouette
    // work goes green and mushy without anything failing.
    expect(terrainParams.vegSlopeThreshold).toBeGreaterThan(terrainParams.slopeThreshold);
  });

  it('sand is a SHORE BAND, not the default surface', () => {
    // THE DEFECT: split on slope alone at 0.72 (44°) against a measured mean
    // terrain slope of 19-23°, sand took 82-98% of every island — one tan
    // albedo from the waterline to the summit, and no green on an island at
    // all. The band has to stay a skirt: tens of metres of elevation here
    // would hand the whole island back to sand.
    expect(terrainParams.shoreBandHeight).toBeLessThan(8);
    expect(terrainParams.shoreBandFade).toBeGreaterThan(0.5); // never a contour line
  });

  it('the cover clump noise is band-limited too, not merely coarse (§V.48)', () => {
    // "coarse" is not "exempt", and it was the first answer here — measured,
    // the finest clump octave is ~9 m, which at 4 km and 10× grazing is
    // comfortably UNDER one 20 m pixel. Coarseness is also just a params
    // value anyone can raise. So the limit exists, and this pins the two ends
    // of it through the CPU mirror of the same gate the shader uses.
    const finest = 1 / (terrainParams.vegScale * terrainParams.noiseLacunarity);
    const mpp = (dist: number, grazing: number): number =>
      (dist / (2560 / ((75 * Math.PI) / 180)))* grazing;
    // a hillside 200 m off: the clumps are the read, keep them
    expect(periodResolvedValue(mpp(200, 1) / finest)).toBeGreaterThan(0.9);
    // the same hillside at 4 km seen edge-on: gone, so it cannot shimmer
    expect(periodResolvedValue(mpp(4000, 10) / finest)).toBe(0);
  });

  it('the blend material builds with the cover layer wired in', async () => {
    const { terrainBlendMaterial } = await import('../src/terrain/sandMaterial');
    const handle = terrainBlendMaterial();
    expect(handle.uniforms.cover).toBeDefined();
    expect(handle.material.colorNode).toBeTruthy();
    // live Tweakpane edits reach the GPU uniforms
    const before = handle.uniforms.cover.scale.value;
    terrainParams.vegScale = before + 0.01;
    handle.updateFromParams();
    expect(handle.uniforms.cover.scale.value).toBeCloseTo(before + 0.01);
    terrainParams.vegScale = before;
    handle.updateFromParams();
    handle.dispose();
  });
});

describe('§V30/§V43 aerial perspective: land and sea melt into ONE atmosphere', () => {
  // The islands were on `scene.fog` (linear 1800→4900) while the water had
  // already left it — `surfaceMaterial` sets `material.fog = false` and runs
  // pow(smoothstep(900, 4600, d), 1.7). Measured at 4 km that is 71% haze on
  // the land against 88% on the water it stands in: a 17-point step along
  // every coastline, in the exact horizon band the wide shots are taken in.
  const ocean = oceanSurfaceParams;
  const haze = (d: number): number =>
    aerialHazeFactorCpu(d, ocean.hazeStart, ocean.hazeEnd, ocean.hazeCurve, ocean.hazeStrength);

  it('reads the OCEAN\'s curve rather than a second copy of the numbers', () => {
    // The single-owner point, and the whole reason this is a test: two
    // hand-matched copies of a curve agree on the day they are written and
    // drift the first time either is tuned (§V33/§V51, and `waterline` inside
    // this same material). Retuning the sea must move the land with it.
    const u = createAerialUniforms();
    expect(u.range.value.x).toBe(ocean.hazeStart);
    expect(u.range.value.y).toBe(ocean.hazeEnd);
    expect(u.curve.value).toBe(ocean.hazeCurve);

    const before = ocean.hazeStart;
    ocean.hazeStart = before + 250;
    updateAerialUniforms(u);
    expect(u.range.value.x).toBe(before + 250);
    ocean.hazeStart = before;
    updateAerialUniforms(u);
  });

  it('is the SAME function the water uses, not merely a similar shape', () => {
    // transliteration of the shader ramp; if either side is edited alone the
    // numbers below stop matching the water and the seam comes back
    expect(haze(ocean.hazeStart)).toBe(0);
    expect(haze(ocean.hazeEnd)).toBeCloseTo(ocean.hazeStrength, 5);
    // hermite, then the exponent — a LINEAR model of this is ~3x off midfield
    const mid = (ocean.hazeStart + ocean.hazeEnd) / 2;
    const linear = 0.5;
    expect(haze(mid)).toBeLessThan(linear * 0.7);
  });

  it('never exceeds full haze or goes negative (§V44 bounded at source)', () => {
    for (const d of [-100, 0, 500, 2000, 9000, 1e9]) {
      const v = haze(d);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('degenerate ranges do not divide by zero (§V28)', () => {
    expect(Number.isFinite(aerialHazeFactorCpu(1000, 2000, 2000, 1.7, 1))).toBe(true);
  });

  it('the blend material owns its haze and disables scene fog — both, or it doubles', () => {
    const handle = terrainBlendMaterial();
    expect(handle.material.fog).toBe(false);
    expect(handle.material.outputNode).toBeTruthy();
    expect(handle.uniforms.aerial).toBeDefined();
    // the colour is pushed, not baked: the sky rig retints the atmosphere
    // every frame and the land must follow the same source the sea copies
    handle.setHazeColor(new Color(0x123456));
    expect(handle.uniforms.aerial.color.value.getHex()).toBe(0x123456);
    handle.dispose();
  });
});
