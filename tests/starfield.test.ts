/**
 * §T.46 starfield + the moon disc's appearance.
 *
 * WHY THESE MATTER. A starfield is a field of SUB-PIXEL dots, which is the
 * single worst case §V.48 exists for, laid on a grid, which is the single
 * worst case §B.33 exists for. Both failure modes are invisible in a still and
 * obvious in motion — crawling dots, and eight knots of stars parked at the
 * cube corners — so neither can be caught by "it looked fine in a screenshot".
 * They are pinned here instead, against the CPU half of the transliteration
 * pair in src/sky/starfield.ts.
 *
 * HONEST SCOPE (§V.22): none of this proves the shader COMPILES, and none of
 * it proves the result looks right. The last test in the file builds the node
 * graph, which is as far as headless goes.
 */
import { describe, expect, it } from 'vitest';
import { skyParams } from '../src/params/sky';
import {
  CELL_CLEARANCE,
  bandLimitEnergy2D,
  cubeFace,
  faceDirection,
  pixelAngleFor,
  starDensityWeight,
  starForCell,
  starMagnitude,
  starPeakRadiance,
  starsPerSteradian,
} from '../src/sky/starfield';
import { moonIllumination, moonBrightness, keyLight, moonElevation } from '../src/sky/moonCycle';
import { sunDiscCosines } from '../src/sky/sunCycle';

const DEG = Math.PI / 180;
const P = skyParams;

/** every cell of every face, at a given grid resolution */
function* allCells(n: number): Generator<[number, number, number]> {
  for (let f = 0; f < 6; f++) {
    for (let cu = 0; cu < n; cu++) {
      for (let cv = 0; cv < n; cv++) yield [f, cu, cv];
    }
  }
}

const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe('cube-face addressing (the grid the whole field hangs on)', () => {
  it('round-trips every direction back to itself', () => {
    // deterministic quasi-random sweep over the sphere
    for (let i = 1; i <= 2000; i++) {
      const z = 1 - (2 * i) / 2001;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      const a = i * 2.399963229728653; // golden angle
      const d: [number, number, number] = [r * Math.cos(a), r * Math.sin(a), z];
      const { face, u, v } = cubeFace(d);
      const back = faceDirection(face, u, v).dir;
      expect(dot(back, d)).toBeCloseTo(1, 9);
    }
  });

  it('assigns every direction exactly one face, and all six get used', () => {
    const seen = new Set<number>();
    for (let i = 1; i <= 2000; i++) {
      const z = 1 - (2 * i) / 2001;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      const a = i * 2.399963229728653;
      const { face, u, v } = cubeFace([r * Math.cos(a), r * Math.sin(a), z]);
      expect(face).toBeGreaterThanOrEqual(0);
      expect(face).toBeLessThan(6);
      // inside the face, always — a uv outside [-1,1] means a cell that
      // belongs to a neighbour and a star drawn in the wrong place
      expect(Math.abs(u)).toBeLessThanOrEqual(1 + 1e-9);
      expect(Math.abs(v)).toBeLessThanOrEqual(1 + 1e-9);
      seen.add(face);
    }
    expect(seen.size).toBe(6);
  });
});

describe('density — the gnomonic Jacobian is not decoration (§B.33)', () => {
  it('is the same per steradian at a face CENTRE as at a cube CORNER', () => {
    // Two caps of identical solid angle: one on the +x face axis, one on the
    // (1,1,1) cube corner where the naive grid is 5.2x denser. Counting real
    // stars from the real hash — this is not the analytic identity restated.
    const n = 72;
    const centre: [number, number, number] = [1, 0, 0];
    const s = 1 / Math.sqrt(3);
    const corner: [number, number, number] = [s, s, s];
    const cosCap = Math.cos(20 * DEG);
    let atCentre = 0;
    let atCorner = 0;
    for (const [f, cu, cv] of allCells(n)) {
      const star = starForCell(f, cu, cv, n, P.starMagnitudePower);
      if (star.magnitude <= 0) continue;
      if (dot(star.dir, centre) >= cosCap) atCentre++;
      if (dot(star.dir, corner) >= cosCap) atCorner++;
    }
    // ~340 expected in each cap; Poisson noise alone is ±18 at 1 sigma
    expect(atCentre).toBeGreaterThan(150);
    expect(atCorner).toBeGreaterThan(150);
    expect(atCorner / atCentre).toBeGreaterThan(0.75);
    expect(atCorner / atCentre).toBeLessThan(1.33);
  });

  it('would FAIL without the Jacobian — this test can bite', () => {
    // the same count with the density gate removed (every cell holds a star)
    const n = 72;
    const s = 1 / Math.sqrt(3);
    const cosCap = Math.cos(20 * DEG);
    let atCentre = 0;
    let atCorner = 0;
    for (const [f, cu, cv] of allCells(n)) {
      const star = starForCell(f, cu, cv, n, P.starMagnitudePower);
      if (dot(star.dir, [1, 0, 0]) >= cosCap) atCentre++;
      if (dot(star.dir, [s, s, s]) >= cosCap) atCorner++;
    }
    // an ungated grid really is several times denser at the corner
    expect(atCorner / atCentre).toBeGreaterThan(2);
  });

  it('weights a corner cell at 0.192 of a centre cell — the exact ratio', () => {
    expect(starDensityWeight(faceDirection(0, 0, 0).invLen)).toBeCloseTo(1, 12);
    expect(starDensityWeight(faceDirection(0, 1, 1).invLen)).toBeCloseTo(3 ** -1.5, 12);
  });

  it('puts the reference number of stars in a default frame', () => {
    // 55° fov, 16:9 → 85.6° horizontal. Ω = 4·asin(sin(h/2)·sin(v/2)).
    const vfov = 55 * DEG;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * (16 / 9));
    const omega = 4 * Math.asin(Math.sin(hfov / 2) * Math.sin(vfov / 2));
    const inFrame = starsPerSteradian(P.starDensity) * omega;
    // measured off docs/inspo/night/: several hundred to ~1000 visible stars
    // in the sky half of a frame. Half the frame is sea, and the magnitude
    // curve leaves ~63% of candidates above a visible threshold.
    const visibleSky = inFrame * 0.5 * 0.63;
    expect(visibleSky).toBeGreaterThan(300);
    expect(visibleSky).toBeLessThan(1200);
  });
});

describe('a star never reaches its own cell wall (one cell is read per pixel)', () => {
  it('keeps every star inside the jitter bound', () => {
    const n = 72;
    let maxOffset = 0;
    for (const [f, cu, cv] of allCells(24)) {
      const star = starForCell(f, cu, cv, n, P.starMagnitudePower);
      maxOffset = Math.max(maxOffset, Math.abs(star.offsetU), Math.abs(star.offsetV));
    }
    expect(maxOffset).toBeLessThan(0.5 - CELL_CLEARANCE + 1e-9);
  });

  it('leaves more clearance than the drawn radius at 1080p AND 720p', () => {
    // cell size in radians at a face centre, where cells are largest
    const cellAngle = 2 / P.starDensity;
    const clearance = CELL_CLEARANCE * cellAngle;
    for (const height of [1080, 720]) {
      const drawn = Math.max(P.starSize * DEG, 2 * pixelAngleFor(55, height));
      expect(clearance).toBeGreaterThan(drawn);
    }
    // and it is a real margin at the shipped resolution, not a hair
    const drawn1080 = Math.max(P.starSize * DEG, 2 * pixelAngleFor(55, 1080));
    expect(clearance / drawn1080).toBeGreaterThan(1.5);
  });
});

describe('§V.48b — a sub-pixel star must converge, not crawl', () => {
  const r = P.starSize * DEG;

  it('conserves flux exactly as the disc is widened to the sample grid', () => {
    // flux ∝ peak × drawnRadius². If that moves, the star gets brighter or
    // dimmer purely because the window resized — which is the crawl.
    const flux = (px: number) => {
      const drawn = Math.max(r, 2 * px);
      return starPeakRadiance(P.starBrightness, 1, r, px) * drawn * drawn;
    };
    const ref = flux(1e-6);
    for (const height of [2160, 1440, 1080, 720, 480, 240]) {
      expect(flux(pixelAngleFor(55, height))).toBeCloseTo(ref, 12);
    }
  });

  it('fades the amplitude toward zero rather than leaving a step', () => {
    let prev = Infinity;
    for (const height of [4320, 2160, 1080, 540, 270, 135, 60]) {
      const peak = starPeakRadiance(P.starBrightness, 1, r, pixelAngleFor(55, height));
      expect(peak).toBeLessThan(prev);
      prev = peak;
    }
    expect(prev).toBeLessThan(0.02 * P.starBrightness);
  });

  it('stops fading once the star is genuinely resolved', () => {
    // a star two pixels across at 1080p pays nothing
    const big = 2 * pixelAngleFor(55, 1080);
    expect(bandLimitEnergy2D(big, pixelAngleFor(55, 1080))).toBeCloseTo(1, 12);
  });

  it('is SQUARED, not linear — a star is a disc, not an edge', () => {
    // the tell: halving the pixel size must quadruple the peak, not double it
    const px = pixelAngleFor(55, 1080);
    const ratio = bandLimitEnergy2D(r, px / 2) / bandLimitEnergy2D(r, px);
    expect(ratio).toBeCloseTo(4, 6);
  });

  it('renders the shipped default at the brightness it is documented at', () => {
    const px = pixelAngleFor(55, 1080);
    expect(bandLimitEnergy2D(r, px)).toBeCloseTo(0.131, 3);
    expect(starPeakRadiance(P.starBrightness, 1, r, px)).toBeCloseTo(1.57, 2);
    // median star: magnitude 0.125 at power 3
    expect(starPeakRadiance(P.starBrightness, 0.125, r, px)).toBeGreaterThan(0.15);
  });
});

describe('magnitude — one hash is both the density gate and the brightness', () => {
  it('is 0 for a cell above its threshold, so the gate needs no step', () => {
    expect(starMagnitude(0.7, 0.6, 3)).toBe(0);
    expect(starMagnitude(0.6, 0.6, 3)).toBe(0);
    expect(starMagnitude(0.5999, 0.6, 3)).toBeGreaterThan(0);
  });

  it('puts the FAINTEST stars nearest the cut, not the brightest', () => {
    // otherwise lowering the density blinks the brightest stars in and out
    expect(starMagnitude(0.01, 1, 3)).toBeGreaterThan(starMagnitude(0.5, 1, 3));
    expect(starMagnitude(0.99, 1, 3)).toBeLessThan(0.001);
  });

  it('is bottom-heavy — a few bright, very many faint (§V44 bounded 0..1)', () => {
    const n = 72;
    const mags: number[] = [];
    for (const [f, cu, cv] of allCells(20)) {
      const m = starForCell(f, cu, cv, n, P.starMagnitudePower).magnitude;
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThanOrEqual(1);
      if (m > 0) mags.push(m);
    }
    mags.sort((a, b) => a - b);
    const median = mags[Math.floor(mags.length / 2)];
    expect(median).toBeLessThan(0.25);
    expect(mags[mags.length - 1]).toBeGreaterThan(0.8);
  });

  it('holds density roughly at the Jacobian mean over the whole sky', () => {
    // mean of J over a face is 4π/6 / 4 = 0.5236 — i.e. about half the cells
    let held = 0;
    let total = 0;
    for (const [f, cu, cv] of allCells(30)) {
      total++;
      if (starForCell(f, cu, cv, 30, P.starMagnitudePower).magnitude > 0) held++;
    }
    expect(held / total).toBeGreaterThan(0.42);
    expect(held / total).toBeLessThan(0.62);
  });
});

describe('§B.4 — the twinkle must not have one shared phase', () => {
  const phases: number[] = [];
  const colours: number[] = [];
  for (const [f, cu, cv] of allCells(24)) {
    const s = starForCell(f, cu, cv, 72, P.starMagnitudePower);
    phases.push(s.phase);
    colours.push(s.colorMix);
  }

  it('spreads phase uniformly over the full cycle', () => {
    const bins = new Array(8).fill(0);
    for (const p of phases) bins[Math.min(7, Math.floor((p / (2 * Math.PI)) * 8))]++;
    const expected = phases.length / 8;
    for (const b of bins) {
      expect(b).toBeGreaterThan(expected * 0.8);
      expect(b).toBeLessThan(expected * 1.2);
    }
  });

  it('does NOT derive phase from the colour hash — warm stars must not blink together', () => {
    // the cheap "one hash, two uses" shortcut ties hue to beat, which puts
    // every amber star (the minority the eye picks out) on one pulse: §B.4
    // again, on the worst possible subset.
    const n = phases.length;
    const mp = phases.reduce((a, b) => a + b, 0) / n;
    const mc = colours.reduce((a, b) => a + b, 0) / n;
    let cov = 0;
    let vp = 0;
    let vc = 0;
    for (let i = 0; i < n; i++) {
      cov += (phases[i] - mp) * (colours[i] - mc);
      vp += (phases[i] - mp) ** 2;
      vc += (colours[i] - mc) ** 2;
    }
    expect(Math.abs(cov / Math.sqrt(vp * vc))).toBeLessThan(0.08);
  });

  it('keeps warm stars scattered across the whole cycle', () => {
    const warm = phases.filter((_, i) => colours[i] > 0.5);
    expect(warm.length).toBeGreaterThan(200);
    const mean = warm.reduce((a, b) => a + b, 0) / warm.length;
    const sd = Math.sqrt(warm.reduce((a, b) => a + (b - mean) ** 2, 0) / warm.length);
    // a uniform cycle has sd 2π/√12 = 1.814; a synchronised set has ~0
    expect(sd).toBeGreaterThan(1.5);
  });
});

describe('the night gate is nightFactor, NOT moonWeight', () => {
  it('shows stars on a NEW-MOON night — the night that has the most of them', () => {
    const newMoon = { ...P, moonPhase: 0 };
    const k = keyLight(19.25, newMoon);
    expect(k.moonWeight).toBe(0); // the gate we deliberately did not use
    expect(k.nightFactor).toBeGreaterThan(0.99);
  });

  it('is fully off in daylight and fully on after nautical twilight', () => {
    expect(keyLight(12, P).nightFactor).toBe(0);
    expect(keyLight(19.25, P).nightFactor).toBeGreaterThan(0.99);
  });

  it('never jumps — stars fade in through dusk rather than popping', () => {
    let prev = keyLight(16, P).nightFactor;
    for (let t = 16; t <= 21; t += 1 / 60) {
      const cur = keyLight(t, P).nightFactor;
      expect(Math.abs(cur - prev)).toBeLessThan(0.03);
      expect(cur).toBeGreaterThanOrEqual(prev - 1e-12); // monotone into night
      prev = cur;
    }
    expect(prev).toBeGreaterThan(0.99);
  });
});

describe('THE MOON DISC — a crescent, decoupled from the light (§T.46 refs)', () => {
  it('draws a crescent while the ORBIT stays full — that is the whole cheat', () => {
    // every one of the 12 references shows a crescent; we shipped a full disc
    expect(P.moonDiscPhase).toBeGreaterThan(0.05);
    expect(P.moonDiscPhase).toBeLessThan(0.3);
    const lit = moonIllumination(P.moonDiscPhase);
    expect(lit).toBeGreaterThan(0.1);
    expect(lit).toBeLessThan(0.45);
    // ...while the orbital phase is untouched, which is what keeps the moon
    // LOW at the Night preset and the key light at full strength
    expect(P.moonPhase).toBe(0.5);
    expect(moonBrightness(P.moonPhase)).toBe(1);
  });

  it('keeps the Night preset moon low enough to lay a glint road', () => {
    // the reason moonPhase could not simply be moved to 0.18: phase is an
    // hour-angle lag, so a crescent moon is a HIGH moon at this hour
    const low = (moonElevation(19.25, P.moonPhase) * 180) / Math.PI;
    const high = (moonElevation(19.25, P.moonDiscPhase) * 180) / Math.PI;
    expect(low).toBeLessThan(25);
    expect(high).toBeGreaterThan(40);
  });

  it('costs the key light nothing — MOON_SURGE never sees the crescent', () => {
    const k = keyLight(19.25, P);
    expect(k.moonWeight).toBeCloseTo(1, 6);
    expect(k.intensity).toBeCloseTo(P.moonIntensity, 6);
    // and the honest alternative really would have been unusable
    expect(moonBrightness(P.moonDiscPhase)).toBeLessThan(0.1);
  });

  it('weights the aura by lit AREA, holding the signed-off exposure', () => {
    // glow/halo now scale with moonIllumination(discPhase) rather than with
    // MOON_SURGE, and the strengths were re-authored so the PRODUCT lands
    // where the old full-moon values did — a change of shape, not exposure
    const w = moonIllumination(P.moonDiscPhase);
    expect(P.moonGlowStrength * w).toBeGreaterThan(0.2);
    expect(P.moonGlowStrength * w).toBeLessThan(0.32);
    expect(P.moonHaloStrength * w).toBeGreaterThan(0.045);
    expect(P.moonHaloStrength * w).toBeLessThan(0.075);
  });

  it('has no aura at all at new moon', () => {
    expect(moonIllumination(0)).toBeCloseTo(0, 12);
  });

  it('sizes the disc inside the band measured off the references', () => {
    // SoT shots put the disc at 3.1-4.7° across; moonDiscSize is a RADIUS
    expect(P.moonDiscSize * 2).toBeGreaterThan(3);
    expect(P.moonDiscSize * 2).toBeLessThan(4.8);
    const [outer, inner] = sunDiscCosines(P.moonDiscSize, P.moonDiscSoftness);
    expect(outer).toBeLessThan(inner); // smoothstep edges still ordered
  });

  it('keeps the terminator wider than a pixel before §V.48 has to rescue it', () => {
    // moonTerminatorSoftness is a fraction of the disc RADIUS, and the fwidth
    // floor in skyBackground.ts is what saves it when this is not enough.
    // Pinning the authored width means the floor stays a safety net, not the
    // thing that decides how soft the terminator is.
    const softDeg = P.moonTerminatorSoftness * P.moonDiscSize;
    expect(softDeg * DEG).toBeGreaterThan(2 * pixelAngleFor(55, 1080));
  });
});

describe('integration surface — the node graph builds (§V.22: not "it works")', () => {
  it('constructs the sky background with a starfield in colorNode only', async () => {
    const { createSkyBackground } = await import('../src/sky/skyBackground');
    const bg = createSkyBackground(P);
    expect(bg.colorNode).toBeTruthy();
    expect(bg.skyDomeColor).toBeTruthy();
    // update() must survive every hour of the day without throwing
    for (let t = 0; t < 24; t += 0.25) bg.update(keyLight(t, P));
  });
});
