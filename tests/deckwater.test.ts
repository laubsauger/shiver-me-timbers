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
import { generateDeckHeightfield } from '../src/deckwater/deckHeightfield';

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

describe('deck heightfield (§V9 data structure)', () => {
  const opts = { width: 64, height: 32, scupperCount: 2 };

  it('is deterministic (§V2: same inputs → identical field)', () => {
    expect(generateDeckHeightfield(opts)).toEqual(generateDeckHeightfield(opts));
    expect(generateDeckHeightfield(opts)).toHaveLength(64 * 32);
  });

  it('rails rise above the deck so water pools before draining', () => {
    const f = generateDeckHeightfield(opts);
    const interior = f[16 * 64 + 32];
    expect(f[0]).toBeGreaterThan(interior); // corner rail
    expect(f[16 * 64 + 0]).toBeGreaterThan(interior); // stern rail mid-beam
  });

  it('scuppers cut the side rails to base level — the drain path exists', () => {
    const f = generateDeckHeightfield(opts);
    const nearSide = [...f.slice(0, 64)]; // y = 0 rail row
    const farSide = [...f.slice(31 * 64, 32 * 64)]; // y = 31 rail row
    expect(nearSide.some((v) => v === 0)).toBe(true);
    expect(farSide.some((v) => v === 0)).toBe(true);
    expect(nearSide[0]).toBeGreaterThan(0); // corners stay closed
  });

  it('camber crowns at the beam center so water runs to the scuppers', () => {
    const f = generateDeckHeightfield(opts);
    const center = f[16 * 64 + 32];
    const nearRail = f[4 * 64 + 32];
    expect(center).toBeGreaterThan(nearRail);
  });

  it('plank grooves lower seam rows by exactly the groove depth', () => {
    const flat = generateDeckHeightfield({ ...opts, plankGrooveDepth: 0 });
    const grooved = generateDeckHeightfield({ ...opts, plankGrooveDepth: 0.01 });
    const seamRow = 8; // plankSpacing default 8 → seam at y=8
    // Float32Array storage rounds 0.01 to the nearest float32
    expect(flat[seamRow * 64 + 32] - grooved[seamRow * 64 + 32]).toBeCloseTo(0.01, 6);
    expect(flat[9 * 64 + 32]).toBe(grooved[9 * 64 + 32]); // plank face untouched
  });
});
