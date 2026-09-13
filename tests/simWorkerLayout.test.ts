/**
 * §T.178 — the boat sim buffer layout and the params vector.
 *
 * WHY: the layout is the ONLY contract between the main thread and a stepper that may be on
 * another thread with no shared objects. An offset that overlaps a neighbour's is a silent
 * cross-boat corruption (boat 3's velocity quietly becoming boat 4's controls) that no physics
 * test would attribute to the transport. And a params leaf that fails to round-trip is a rival
 * floating on a different sea (§V110). Both fail loud here instead.
 */
import { describe, expect, it } from 'vitest';
import { oceanParams } from '../src/params/ocean';
import { seaPhysicsParams } from '../src/params/seaPhysics';
import {
  B,
  BOAT_FIXED,
  BoatSimLayout,
  CONTROL_LEN,
  F,
  H,
  HEADER_I32,
  POSE_LEN,
  WAKE_SAMPLE_LEN,
  boatBlockLength,
  hashBoatOutput,
  layoutByteLength,
  type LayoutSpec,
} from '../src/sim-worker/layout';
import { paramsLength, readParams, writeParams } from '../src/sim-worker/paramsVector';
import { shardRanges } from '../src/sim-worker/transport';

const SPEC: LayoutSpec = { boats: 8, wakeCap: 16, oceanLen: paramsLength(oceanParams), seaLen: paramsLength(seaPhysicsParams) };

describe('BoatSimLayout', () => {
  it('every region is disjoint and inside the buffer: header, params, world, each boat block', () => {
    const L = new BoatSimLayout(new SharedArrayBuffer(layoutByteLength(SPEC)), SPEC);
    const regions: [string, number, number][] = [
      ['i32 header', 0, HEADER_I32 / 2],
      ['f64 header', F.TIME, L.oceanOffset],
      ['ocean', L.oceanOffset, L.seaOffset],
      ['sea', L.seaOffset, L.worldOffset],
      ...Array.from({ length: SPEC.boats }, (_, i) => [`world ${i}`, L.worldPoseOffset(i), L.worldPoseOffset(i) + POSE_LEN] as [string, number, number]),
      ...Array.from({ length: SPEC.boats }, (_, i) => [`boat ${i}`, L.boatOffset(i), L.boatOffset(i) + L.blockLength] as [string, number, number]),
    ];
    regions.sort((a, b) => a[1] - b[1]);
    for (let k = 1; k < regions.length; k++) {
      expect(regions[k][1], `${regions[k][0]} starts inside ${regions[k - 1][0]}`).toBeGreaterThanOrEqual(regions[k - 1][2]);
    }
    expect(regions[regions.length - 1][2] * 8).toBe(layoutByteLength(SPEC));
    // the i32 header really fits in front of the first f64 slot
    expect(HEADER_I32 * 4).toBeLessThanOrEqual(F.TIME * 8);
    // block slots: IN before OUT, wake samples last, nothing past the block
    expect(B.RESET_POSE + POSE_LEN).toBeLessThanOrEqual(B.POSE);
    expect(B.CONTROLS + CONTROL_LEN).toBeLessThanOrEqual(B.RESET_SEQ);
    expect(B.POSE + POSE_LEN).toBeLessThanOrEqual(B.SUBSTEPS);
    expect(BOAT_FIXED).toBe(B.WAKE);
    expect(boatBlockLength(SPEC.wakeCap)).toBe(B.WAKE + SPEC.wakeCap * WAKE_SAMPLE_LEN);
  });

  it('round-trips every slot of every boat with no aliasing (write one boat, every other boat is untouched)', () => {
    const L = new BoatSimLayout(new ArrayBuffer(layoutByteLength(SPEC)), SPEC);
    const fill = (i: number, tag: number): void => {
      const o = L.boatOffset(i);
      for (let k = 0; k < L.blockLength; k++) L.f64[o + k] = tag * 1e6 + k + 0.25;
      const w = L.worldPoseOffset(i);
      for (let k = 0; k < POSE_LEN; k++) L.f64[w + k] = -(tag * 1e6 + k);
    };
    for (let i = 0; i < SPEC.boats; i++) fill(i, i + 1);
    const hashes = Array.from({ length: SPEC.boats }, (_, i) => hashBoatOutput(L, i));
    for (let i = 0; i < SPEC.boats; i++) {
      const o = L.boatOffset(i);
      for (let k = 0; k < L.blockLength; k++) expect(L.f64[o + k]).toBe((i + 1) * 1e6 + k + 0.25);
      for (let k = 0; k < POSE_LEN; k++) expect(L.f64[L.worldPoseOffset(i) + k]).toBe(-((i + 1) * 1e6 + k));
    }
    // rewrite boat 3 only: exactly boat 3's hash moves
    fill(3, 99);
    for (let i = 0; i < SPEC.boats; i++) {
      if (i === 3) expect(hashBoatOutput(L, i)).not.toBe(hashes[i]);
      else expect(hashBoatOutput(L, i)).toBe(hashes[i]);
    }
    // the header survives all of it
    expect(L.i32[H.BOATS]).toBe(SPEC.boats);
    expect(L.i32[H.WAKE_CAP]).toBe(SPEC.wakeCap);
  });

  it('the stepper side adopts the layout from the header alone, and a rebind (transferable) sees the same bytes', () => {
    const buf = new ArrayBuffer(layoutByteLength(SPEC));
    const main = new BoatSimLayout(buf, SPEC);
    main.f64[main.boatOffset(5) + B.POSE + 2] = 42.5;
    const worker = new BoatSimLayout(buf);
    expect(worker.spec).toEqual(SPEC);
    expect(worker.boatOffset(5)).toBe(main.boatOffset(5));
    expect(worker.f64[worker.boatOffset(5) + B.POSE + 2]).toBe(42.5);
    const copy = buf.slice(0);
    main.bind(copy);
    expect(main.f64[main.boatOffset(5) + B.POSE + 2]).toBe(42.5);
  });

  it('fails loud on a short buffer, a foreign buffer and an out-of-range boat', () => {
    expect(() => new BoatSimLayout(new ArrayBuffer(layoutByteLength(SPEC) - 8), SPEC)).toThrow(/B </);
    expect(() => new BoatSimLayout(new ArrayBuffer(layoutByteLength(SPEC)))).toThrow(/magic/);
    const L = new BoatSimLayout(new ArrayBuffer(layoutByteLength(SPEC)), SPEC);
    expect(() => L.boatOffset(SPEC.boats)).toThrow(/out of/);
    expect(() => L.worldPoseOffset(-1)).toThrow(/out of/);
  });

  it('shards cover every boat exactly once, contiguously, whatever the worker count', () => {
    for (const boats of [1, 7, 8]) {
      for (const shards of [1, 2, 3, 16]) {
        const r = shardRanges(boats, shards);
        const seen = new Array<number>(boats).fill(0);
        for (const [a, b] of r) for (let i = a; i < b; i++) seen[i]++;
        expect(seen.every((n) => n === 1)).toBe(true);
        expect(r.length).toBeLessThanOrEqual(Math.max(1, boats));
      }
    }
  });
});

describe('params vector (the sea crosses the transport as numbers)', () => {
  it('round-trips the real OceanParams and SeaPhysicsParams, nested arrays included, into an independent copy', () => {
    const vec = new Float64Array(SPEC.oceanLen + SPEC.seaLen);
    writeParams(oceanParams, vec, 0);
    writeParams(seaPhysicsParams, vec, SPEC.oceanLen);
    const o = structuredClone(oceanParams);
    const s = structuredClone(seaPhysicsParams);
    // scramble the copy so a no-op read cannot pass
    o.windSpeed = -1;
    o.cascades[1].domain = -1;
    o.splitWavelengths[0] = -1;
    s.hullDraft = -1;
    readParams(o, vec, 0);
    readParams(s, vec, SPEC.oceanLen);
    expect(o).toEqual(oceanParams);
    expect(s).toEqual(seaPhysicsParams);
  });

  it('reports a change only when a leaf moved, so PARAMS_VERSION bumps on real edits', () => {
    const p = structuredClone(oceanParams);
    const vec = new Float64Array(SPEC.oceanLen);
    expect(writeParams(p, vec, 0)).toBe(true);
    expect(writeParams(p, vec, 0)).toBe(false);
    p.cascades[2].domain += 0.5;
    expect(writeParams(p, vec, 0)).toBe(true);
  });

  it('booleans travel; strings refuse to (a leaf that cannot cross is a sea that can disagree)', () => {
    const v = new Float64Array(3);
    const src = { a: true, b: [false, 2] as [boolean, number] };
    writeParams(src, v, 0);
    const dst = { a: false, b: [true, 0] as [boolean, number] };
    readParams(dst, v, 0);
    expect(dst).toEqual(src);
    expect(() => paramsLength({ name: 'storm' })).toThrow(/string/);
  });
});
