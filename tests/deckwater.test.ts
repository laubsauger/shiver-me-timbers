/**
 * §V9 deck water invariants, verified against the CPU mirror (fluxMath) of
 * the GPU compute passes. Each test encodes WHY the behavior matters for the
 * look: water must run downhill and slosh with ship tilt (deck feels alive),
 * outflow may never exceed a cell's volume (negative water = visual garbage),
 * evaporation must dry the deck, and wetness must outlive the puddle so
 * planks keep their wet sheen after the water drains — then dry too.
 */
import { describe, expect, it } from 'vitest';
import {
  applyInflow,
  computeOutflow,
  gatherInflow,
  EDGE_DRAIN_HEAD,
  type Flux4,
  type OutflowParams,
  type ResolveParams,
} from '../src/deckwater/fluxMath';
import {
  deckFieldFromSource,
  frameFromSource,
  syntheticDeckField,
  validateDeckField,
} from '../src/deckwater/deckHeightfield';
import { deckTiltGradient, deckUv, isValidDeckFrame } from '../src/deckwater/deckFrame';
import {
  createBowWaterSensor,
  type BowWaterSample,
} from '../src/deckwater/bowWaterSensor';
import { deckWaterParams } from '../src/params/deckwater';
// the shader's uniform-array capacity, imported rather than assumed: the
// sensor keeps its own copy so it can run without the TSL import graph, and
// this is what stops the two drifting apart
import { MAX_SPLASHES } from '../src/deckwater/inflowPass';

const flow: OutflowParams = { fluxRate: 0.2, tiltBiasStrength: 0.5 };
const resolve: ResolveParams = { evapVolume: 0.01, evapWetness: 0.002, wetnessGain: 30 };
const noTilt: [number, number] = [0, 0];
const WALL = 10; // blocking neighbor head (higher than any test water level)

describe('outflow pass (§V9 Mei pass 1)', () => {
  it('water flows downhill: flux goes to lower-head neighbors only', () => {
    // N neighbor lower, E neighbor higher — water must move toward N only,
    // otherwise pooling would ignore the deck's camber and look wrong.
    const f = computeOutflow(0.5, 0.2, [0.1, 2.0, WALL, WALL], noTilt, flow);
    expect(f[0]).toBeGreaterThan(0); // toward low N
    expect(f[1]).toBe(0); // never uphill toward E
    expect(f[2]).toBe(0);
    expect(f[3]).toBe(0);
  });

  it('level water does not move without tilt (stable puddle)', () => {
    const head = 0.1 + 0.2; // deck + volume everywhere (bit-exact fp sum)
    const f = computeOutflow(0.1, 0.2, [head, head, head, head], noTilt, flow);
    expect(f).toEqual([0, 0, 0, 0]);
  });

  it('tilt bias pushes water toward the low side even on a flat deck', () => {
    // §V9 crucial logic: ship roll must make water slide although the local
    // heightfield is level — this is what sells the rocking ship.
    const head = 0.1 + 0.2; // bit-exact fp sum of deck + volume
    const f = computeOutflow(0.1, 0.2, [head, head, head, head], [1, 0], flow);
    expect(f[1]).toBeGreaterThan(0); // +x (E) = downhill under tilt
    expect(f[3]).toBe(0); // nothing uphill (W)
    expect(f[0]).toBe(0);
    expect(f[2]).toBe(0);
  });

  it('total outflow never exceeds available volume (no negative water)', () => {
    const huge: OutflowParams = { fluxRate: 50, tiltBiasStrength: 0.5 };
    const f = computeOutflow(1.0, 0.05, [0, 0, 0, 0], [1, 1], huge);
    const total = f[0] + f[1] + f[2] + f[3];
    expect(total).toBeLessThanOrEqual(0.05 + 1e-12);
    expect(f.every((v) => v >= 0)).toBe(true);
  });

  it('an empty cell emits nothing, even under strong tilt', () => {
    const f = computeOutflow(0.5, 0, [0, 0, 0, 0], [3, 3], flow);
    expect(f).toEqual([0, 0, 0, 0]);
  });

  it('deck edges leak: off-deck neighbors drain standing water (§V9)', () => {
    // "leaky deck" assumption — water reaching the border must leave the sim
    // or scuppers could never empty the deck.
    const f = computeOutflow(EDGE_DRAIN_HEAD, 0.3, [null, null, null, null], noTilt, flow);
    expect(f[0] + f[1] + f[2] + f[3]).toBeGreaterThan(0);
  });
});

describe('inflow pass (§V9 Mei pass 2)', () => {
  it('water actually moves cell to cell: high cell loses, low cell gains', () => {
    // 1×2 walled grid; also proves the N/E/S/W flux packing and the gather
    // direction mapping agree — a mismatch here would teleport water.
    const noEvap: ResolveParams = { ...resolve, evapVolume: 0, evapWetness: 0 };
    const leftOut = computeOutflow(0, 0.5, [WALL, 0, WALL, WALL], noTilt, flow);
    const rightOut = computeOutflow(0, 0, [WALL, WALL, WALL, 0.5], noTilt, flow);
    expect(rightOut).toEqual([0, 0, 0, 0]); // nothing flows uphill

    const rightIn = gatherInflow([null, null, null, leftOut]); // W neighbor = left
    expect(rightIn).toBe(leftOut[1]); // left's E flux arrives as right's W inflow
    const left = applyInflow(0.5, 0, leftOut, 0, noEvap);
    const right = applyInflow(0, 0, rightOut, rightIn, noEvap);
    expect(left.volume).toBeLessThan(0.5);
    expect(right.volume).toBeGreaterThan(0);
    expect(left.volume + right.volume).toBeCloseTo(0.5, 12); // walls: conserved
  });

  it('evaporation dries the deck: volume reaches exactly 0, never below', () => {
    let volume = 0.05;
    let wetness = 0;
    let steps = 0;
    const still: Flux4 = [0, 0, 0, 0];
    while (volume > 0 && steps < 1000) {
      ({ volume, wetness } = applyInflow(volume, wetness, still, 0, resolve));
      expect(volume).toBeGreaterThanOrEqual(0);
      steps++;
    }
    expect(volume).toBe(0); // deck dries (§V9), no residual film
    expect(steps).toBeLessThan(1000);
  });

  it('wetness persists after the water is gone, then dries later', () => {
    // The wet-plank look: G channel must outlive B, or planks would snap
    // from soaked to bone dry the moment the puddle evaporates.
    const still: Flux4 = [0, 0, 0, 0];
    let volume = 0.05;
    let wetness = 0;
    while (volume > 0) {
      ({ volume, wetness } = applyInflow(volume, wetness, still, 0, resolve));
    }
    expect(wetness).toBeGreaterThan(0); // planks still wet after drain
    let steps = 0;
    while (wetness > 0 && steps < 10000) {
      ({ volume, wetness } = applyInflow(volume, wetness, still, 0, resolve));
      steps++;
    }
    expect(wetness).toBe(0); // eventually bone dry
    expect(steps).toBeGreaterThan(0);
  });

  it('standing water ratchets wetness up to its cap', () => {
    const r = applyInflow(0.2, 0, [0, 0, 0, 0], 0, resolve);
    expect(r.wetness).toBeCloseTo(1 - resolve.evapWetness, 12); // capped at 1
    const dryer = applyInflow(0, 0.5, [0, 0, 0, 0], 0, resolve);
    expect(dryer.wetness).toBeLessThan(0.5); // never ratchets without water
  });
});

/**
 * The hand-off from src/ship's generated deck heightfield. This module
 * AUTHORS no deck shape — it adapts the ship's, so that water pools exactly
 * where the timber dishes. Everything that can silently go wrong lives in
 * this adapter: the axis convention, the coverage → drain classification, and
 * arrays that do not match their own declared dimensions.
 */
describe('deck field hand-off (§T31, one field two consumers)', () => {
  const source = () => syntheticDeckField({ width: 32, height: 64, portCount: 2 });

  it('keeps src/ship axes: width across the beam, height along the length', () => {
    // A transpose here is invisible until the deck is on screen, and it is
    // right in three places and wrong in the fourth (the field, the uv, the
    // tilt gradient, the splash). Pinning the orientation pins all four.
    const s = source();
    expect(s.width).toBe(32); // ship x
    expect(s.height).toBe(64); // ship z
    expect(s.data).toHaveLength(32 * 64);
  });

  it('is deterministic (§V2: same inputs → identical field)', () => {
    expect(source().data).toEqual(source().data);
    expect(source().mask).toEqual(source().mask);
  });

  it('classifies texels outboard of the planking as drains, not as deck', () => {
    // The grid is a rectangle and the deck is not: the corners abreast of the
    // stem are thin air. Without this the solve pools water in them forever.
    const f = deckFieldFromSource(source());
    expect(f.drain[0]).toBe(1); // aft corner, outboard of the outline
    expect(f.drain[32 * 32 + 16]).toBe(0); // midships centreline holds water
    expect(f.drain.some((v: number) => v === 1)).toBe(true);
  });

  it('treats a hole in the coverage mask as off-deck, never as a hoarding cell', () => {
    const s = source();
    s.mask[32 * 32 + 16] = NaN;
    expect(deckFieldFromSource(s).drain[32 * 32 + 16]).toBe(1);
  });

  it('the bulwark stands proud so water pools in the waterway (§V9)', () => {
    // The three features that make a deck hold water at all: a raised border,
    // a gutter inboard of it, and a crown that sheds toward the gutter. On a
    // flat plane the solve produces a uniform sheet that slides bodily around
    // and reads as a decal, which is the whole reason the field exists.
    const s = source();
    const at = (x: number, y: number) => s.data[y * s.width + x];
    const all = Array.from(s.data);
    expect(Math.max(...all)).toBeGreaterThan(0.5); // bulwark ring
    expect(Math.min(...all)).toBeLessThan(0); // waterway + freeing ports
    const mid = Math.floor(s.height / 2);
    const centre = at(Math.floor(s.width / 2), mid);
    expect(centre).toBeGreaterThan(0); // camber crown at the centreline
    expect(centre).toBeGreaterThan(at(2, mid)); // ...falling away outboard
  });

  it('rejects arrays that do not match the declared dimensions (Rule 8)', () => {
    const s = source();
    expect(() => deckFieldFromSource({ ...s, data: s.data.slice(0, 10) })).toThrow();
    expect(() => deckFieldFromSource({ ...s, mask: s.mask.slice(0, 10) })).toThrow();
    const f = deckFieldFromSource(s);
    expect(() => validateDeckField({ ...f, drain: f.drain.slice(0, 10) })).toThrow();
  });

  it('derives the frame from the field, so the two can never disagree', () => {
    // The frame used to be restated by the caller. Deriving it means the deck
    // material's uv and the solver's grid are the same rectangle by
    // construction rather than by everybody remembering the same four numbers.
    const s = { ...source(), minX: -4, maxX: 4, minZ: -17, maxZ: 18, deckY: 2.6 };
    expect(frameFromSource(s)).toEqual({
      minX: -4, maxX: 4, minZ: -17, maxZ: 18, planeY: 2.6,
    });
  });
});

/**
 * Grid-level solve. The single-cell tests above cannot see the one mistake
 * that would break everything and still look plausible: a mismatch between
 * the flux PACKING (outflow RGBA = N/E/S/W) and the gather mapping, which
 * teleports water sideways. Stepping a real grid is what pins that.
 */
interface Grid {
  w: number;
  h: number;
  deck: Float64Array;
  vol: Float64Array;
  wet: Float64Array;
  drain: Uint8Array;
}

function makeGrid(w: number, h: number, fill = 0): Grid {
  return {
    w,
    h,
    deck: new Float64Array(w * h),
    vol: new Float64Array(w * h).fill(fill),
    wet: new Float64Array(w * h),
    drain: new Uint8Array(w * h),
  };
}

const DIRS = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
] as const;

/**
 * One full Mei step over a grid, using the exact CPU mirror the GPU passes
 * are written from. `walled` closes the boundary (nothing leaves) so
 * conservation is testable; open boundaries are the shipped "leaky deck".
 */
function stepGrid(
  g: Grid,
  tilt: readonly [number, number],
  fp: OutflowParams,
  rp: ResolveParams,
  walled: boolean,
): void {
  const { w, h } = g;
  const flux: Flux4[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const heads = DIRS.map(([dx, dy]) => {
        const nx = x + dx;
        const ny = y + dy;
        const inside = nx >= 0 && nx < w && ny >= 0 && ny < h;
        if (inside) return g.deck[ny * w + nx] + g.vol[ny * w + nx];
        return walled ? WALL : null; // null → fluxMath's EDGE_DRAIN_HEAD
      });
      flux.push(computeOutflow(g.deck[i], g.vol[i], heads, tilt, fp));
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const neighbours = DIRS.map(([dx, dy]) => {
        const nx = x + dx;
        const ny = y + dy;
        return nx >= 0 && nx < w && ny >= 0 && ny < h ? flux[ny * w + nx] : null;
      });
      const r = applyInflow(
        g.vol[i], g.wet[i], flux[i], gatherInflow(neighbours), rp, g.drain[i] === 1,
      );
      g.vol[i] = r.volume;
      g.wet[i] = r.wetness;
    }
  }
}

const total = (a: Float64Array): number => a.reduce((s, v) => s + v, 0);

/** volume-weighted mean grid x — "where has the water gone" */
function centroidX(g: Grid): number {
  let sum = 0;
  let mass = 0;
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      const v = g.vol[y * g.w + x];
      sum += x * v;
      mass += v;
    }
  }
  return mass > 0 ? sum / mass : 0;
}

describe('Mei solve over a grid (§V9 two-pass)', () => {
  const noEvap: ResolveParams = { ...resolve, evapVolume: 0, evapWetness: 0 };

  it('conserves volume exactly inside a closed deck, tilted and sloshing', () => {
    // Water appearing or vanishing shows up as puddles that grow out of
    // nothing or drain with no scupper — and it compounds, so a 1e-6 leak per
    // step floods the deck in a minute. This also proves the N/E/S/W packing
    // and the gather mapping agree: any mismatch loses or duplicates flux.
    const g = makeGrid(9, 7);
    for (let i = 0; i < g.vol.length; i++) g.vol[i] = ((i * 37) % 11) / 40;
    const start = total(g.vol);
    for (let s = 0; s < 200; s++) {
      // tilt swings, so the bias reverses mid-run — a sign error in the
      // reversed direction would show as a one-sided leak
      stepGrid(g, [Math.sin(s * 0.11), Math.cos(s * 0.07)], flow, noEvap, true);
      expect(g.vol.every((v) => v >= 0)).toBe(true);
    }
    expect(total(g.vol)).toBeCloseTo(start, 9);
  });

  it('tilt bias piles water on the low side, not just anywhere', () => {
    // §V9's "crucial logic" at grid scale: a steady heel must MOVE the sheet
    // to the low rail. A sheet that only jitters in place reads as a decal.
    const g = makeGrid(16, 8, 0.05);
    const before = centroidX(g);
    for (let s = 0; s < 300; s++) stepGrid(g, [1, 0], flow, noEvap, true);
    expect(centroidX(g)).toBeGreaterThan(before + 2);
    expect(total(g.vol)).toBeCloseTo(0.05 * 16 * 8, 9); // still conserved
  });

  it('drain cells hold no water and pull the deck dry through them', () => {
    // The DeckField drain mask IS the deck outline, the scuppers and the open
    // hatchways. Without it the solve pools water in the rectangle's corners,
    // which on a tapered hull is thin air.
    const g = makeGrid(12, 6, 0.1);
    for (let y = 0; y < g.h; y++) g.drain[y * g.w + (g.w - 1)] = 1; // scupper column
    for (let s = 0; s < 400; s++) stepGrid(g, [0, 0], flow, noEvap, true);
    for (let y = 0; y < g.h; y++) expect(g.vol[y * g.w + (g.w - 1)]).toBe(0);
    // walls everywhere else, so the ONLY way out is the drain — the deck
    // must actually empty through it, not merely stop filling it
    expect(total(g.vol)).toBeLessThan(0.1 * 12 * 6 * 0.5);
  });

  it('an open (leaky) deck empties and then reads bone dry', () => {
    const g = makeGrid(8, 6, 0.08);
    for (let s = 0; s < 600; s++) stepGrid(g, [0, 0], flow, resolve, false);
    expect(total(g.vol)).toBe(0);
  });

  it('the waterway drains even though it lies BELOW the deck datum', () => {
    // The ship's field measures height relative to the deck plane, so the
    // gutter inboard of the bulwark is negative. A drain left at datum stands
    // HIGHER than the gutter: water runs into the waterway correctly and then
    // sits there forever, and the deck never empties. The drain head has to
    // be below the lowest point of the deck, not at zero.
    const gutter = -0.028;
    const build = (drainHead: number) => {
      const g = makeGrid(10, 6, 0.02);
      for (let i = 0; i < g.deck.length; i++) g.deck[i] = gutter;
      return { g, fp: { ...flow, drainHead } };
    };
    const naive = build(0); // EDGE_DRAIN_HEAD — above the gutter
    const correct = build(gutter - 0.05);
    for (let s = 0; s < 400; s++) {
      stepGrid(naive.g, [0, 0], naive.fp, { ...resolve, evapVolume: 0 }, false);
      stepGrid(correct.g, [0, 0], correct.fp, { ...resolve, evapVolume: 0 }, false);
    }
    expect(total(naive.g.vol)).toBeCloseTo(0.02 * 10 * 6, 6); // nothing left
    expect(total(correct.g.vol)).toBeLessThan(1e-6); // ran out the ports
  });
});

const FRAME = { minX: -4.25, maxX: 4.25, minZ: -17.5, maxZ: 17.5, planeY: 2.6 };

describe('deck frame (§V9 rotation bias, §T31 grid ↔ ship mapping)', () => {
  const HALF = Math.SQRT1_2;

  it('a level ship has no tilt gradient (water follows the camber alone)', () => {
    expect(deckTiltGradient([0, 0, 0, 1])).toEqual([0, 0]);
  });

  it('heel to starboard runs the water to port, and vice versa', () => {
    // The single sign that decides whether the deck reads right or exactly
    // backwards — water sliding UPHILL as she rolls is the classic tell.
    const angle = 0.3;
    const stbdUp: [number, number, number, number] =
      [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)]; // +z rotation lifts +x
    const t = deckTiltGradient(stbdUp);
    expect(t[0]).toBeCloseTo(-Math.sin(angle), 12); // downhill = ship −x = port
    expect(t[1]).toBeCloseTo(0, 12); // nothing along the length
    expect(deckTiltGradient([0, 0, -Math.sin(angle / 2), Math.cos(angle / 2)])[0])
      .toBeCloseTo(Math.sin(angle), 12);
  });

  it('bow-down pitch runs the water forward', () => {
    const angle = 0.2;
    const bowDown: [number, number, number, number] =
      [Math.sin(angle / 2), 0, 0, Math.cos(angle / 2)]; // +x rotation drops +z
    const t = deckTiltGradient(bowDown);
    expect(t[0]).toBeCloseTo(0, 12);
    expect(t[1]).toBeCloseTo(Math.sin(angle), 12); // downhill = grid +y = bow
  });

  it('gradient magnitude is sin(tilt): flat at upright, max on her beam ends', () => {
    const onBeamEnds: [number, number, number, number] = [0, 0, HALF, HALF]; // 90°
    expect(Math.hypot(...deckTiltGradient(onBeamEnds))).toBeCloseTo(1, 12);
  });

  it('a non-finite pose reads as level, never as NaN (§V28/§B.5)', () => {
    // A NaN tilt uniform multiplies into every cell of the solve and the whole
    // deck goes NaN — the failure mode that presented as a browser hang.
    expect(deckTiltGradient([NaN, 0, 0, 1])).toEqual([0, 0]);
  });

  it('uv maps port→starboard onto u and stern→bow onto v (src/ship axes)', () => {
    expect(deckUv(FRAME.minX, 0, FRAME)).toEqual([0, 0.5]);
    expect(deckUv(FRAME.maxX, 0, FRAME)).toEqual([1, 0.5]);
    expect(deckUv(0, FRAME.minZ, FRAME)).toEqual([0.5, 0]);
    expect(deckUv(0, FRAME.maxZ, FRAME)).toEqual([0.5, 1]);
  });

  it('rejects a degenerate frame instead of mapping the deck onto one cell', () => {
    expect(isValidDeckFrame(FRAME)).toBe(true);
    expect(isValidDeckFrame({ ...FRAME, maxZ: FRAME.minZ })).toBe(false);
    expect(isValidDeckFrame({ ...FRAME, maxX: FRAME.minX })).toBe(false);
    expect(isValidDeckFrame({ ...FRAME, planeY: NaN })).toBe(false);
  });
});

describe('bow water sensor (§V27 event-driven, §V36 σ-relative)', () => {
  const frame = FRAME;
  const p = deckWaterParams;
  const SIGMA = 1.0; // σ = 1 m → gates land on their raw multiples

  /** a stem driving hard under: every gate satisfied */
  const burying = (over: Partial<BowWaterSample['cutwater']> = {}): BowWaterSample => ({
    cutwater: {
      inContact: true,
      depth: p.immersionFullSigma * SIGMA,
      rate: p.burialRateFull,
      localZ: frame.maxZ - 1,
      halfWidth: 2.0,
      ...over,
    },
    speed: p.speedFull,
    seaSigma: SIGMA,
  });

  it('fires on a hard burial, laying a row of splats across the bow', () => {
    const s = createBowWaterSensor();
    const out = s.update(burying(), 1 / 60, p, frame);
    expect(out).toHaveLength(p.splashCount);
    const volume = out.reduce((a, b) => a + b.amount, 0);
    expect(volume).toBeCloseTo(p.splashVolume, 6); // full strength = full volume
    for (const q of out) {
      expect(q.v).toBeGreaterThan(0.5); // forward third — this is green water
      expect(q.v).toBeLessThanOrEqual(1);
      expect(q.u).toBeGreaterThanOrEqual(0);
      expect(q.u).toBeLessThanOrEqual(1);
    }
    // a row, not a bucket: the splats must actually differ across the beam
    expect(new Set(out.map((q) => q.u)).size).toBe(p.splashCount);
  });

  it('a bow that is merely immersed at speed splashes NOTHING (§V27)', () => {
    // THE invariant this module exists for. hullContact measures the stem wet
    // on ~55% of ticks at cruising speed, so gating on immersion + speed alone
    // would fire almost every tick — a passive emitter wearing an event's
    // clothing, which §V27 forbids outright.
    const s = createBowWaterSensor();
    for (let i = 0; i < 500; i++) {
      expect(s.update(burying({ rate: 0 }), 1 / 60, p, frame)).toEqual([]);
    }
  });

  it('fires once per burial, not once per tick', () => {
    const s = createBowWaterSensor();
    expect(s.update(burying(), 1 / 60, p, frame).length).toBeGreaterThan(0);
    for (let i = 0; i < 120; i++) {
      expect(s.update(burying(), 1 / 60, p, frame)).toEqual([]);
    }
  });

  it('rearms when the stem lifts clear, then fires on the next wave', () => {
    const s = createBowWaterSensor();
    s.update(burying(), 1 / 60, p, frame);
    // ride out the refractory with the bow in the air (rate 0 there anyway)
    for (let i = 0; i < 60; i++) {
      s.update({ ...burying(), cutwater: { ...burying().cutwater, inContact: false } }, 1 / 60, p, frame);
    }
    expect(s.armed).toBe(true);
    expect(s.update(burying(), 1 / 60, p, frame).length).toBe(p.splashCount);
  });

  it('the immersion gate is σ-relative: the same metres, a different sea (§V36)', () => {
    // An absolute metre gate silently changes meaning when the spectrum moves
    // — §B.12 twice over. Identical hull telemetry must ship water in a calm
    // and not in a gale, because in a gale that is an ordinary wave.
    const depth = 0.9;
    const calm = createBowWaterSensor();
    const gale = createBowWaterSensor();
    const sample = (sigma: number): BowWaterSample => ({
      ...burying({ depth }),
      seaSigma: sigma,
    });
    expect(calm.update(sample(0.5), 1 / 60, p, frame).length).toBeGreaterThan(0);
    expect(gale.update(sample(4.0), 1 / 60, p, frame)).toEqual([]);
  });

  it('a stem clear of the water cannot ship any (and rearms)', () => {
    const s = createBowWaterSensor();
    const airborne = burying();
    airborne.cutwater.inContact = false;
    expect(s.update(airborne, 1 / 60, p, frame)).toEqual([]);
    expect(s.armed).toBe(true);
  });

  it('below the speed gate she shoulders water aside instead of scooping it', () => {
    const s = createBowWaterSensor();
    expect(s.update({ ...burying(), speed: 0 }, 1 / 60, p, frame)).toEqual([]);
  });

  it('event volume scales with how hard she buried, not on/off', () => {
    const hard = createBowWaterSensor().update(burying(), 1 / 60, p, frame);
    const soft = createBowWaterSensor().update(
      burying({
        depth: (p.immersionSigma + p.immersionFullSigma) / 2,
        rate: (p.burialRate + p.burialRateFull) / 2,
      }),
      1 / 60,
      p,
      frame,
    );
    const sum = (a: { amount: number }[]) => a.reduce((s, q) => s + q.amount, 0);
    expect(sum(soft)).toBeGreaterThan(0);
    expect(sum(soft)).toBeLessThan(sum(hard));
  });

  it('a fine entry throws a narrower sheet than a bluff bow', () => {
    const narrow = createBowWaterSensor().update(burying({ halfWidth: 0.4 }), 1 / 60, p, frame);
    const wide = createBowWaterSensor().update(burying({ halfWidth: 4.0 }), 1 / 60, p, frame);
    const span = (a: { u: number }[]) => Math.max(...a.map((q) => q.u)) - Math.min(...a.map((q) => q.u));
    expect(span(narrow)).toBeLessThan(span(wide));
  });

  it('never emits more splats than the shader has slots, or off-grid uv', () => {
    // MAX_SPLASHES is the uniform-array capacity; a longer row would silently
    // drop its tail, and off-grid uv would splash into a clamped corner cell.
    const s = createBowWaterSensor();
    const out = s.update(
      burying({ halfWidth: 100 }),
      1 / 60,
      { ...p, splashCount: 40 },
      { ...frame, minX: -0.5, maxX: 0.5 },
    );
    expect(out.length).toBeLessThanOrEqual(MAX_SPLASHES);
    for (const q of out) {
      expect(q.u).toBeGreaterThanOrEqual(0);
      expect(q.u).toBeLessThanOrEqual(1);
      expect(q.v).toBeGreaterThanOrEqual(0);
      expect(q.v).toBeLessThanOrEqual(1);
    }
  });

  it('non-finite telemetry cannot fire an event (§V28)', () => {
    const s = createBowWaterSensor();
    expect(s.update(burying({ depth: NaN }), 1 / 60, p, frame)).toEqual([]);
    expect(s.update({ ...burying(), speed: NaN }, 1 / 60, p, frame)).toEqual([]);
  });
});
