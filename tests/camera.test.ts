/**
 * T10 follow camera — WHY these tests: only the pure math half (camMath,
 * no three imports) is testable headless, and it carries the guarantees
 * the feel depends on: exp damping must be frame-rate independent (same
 * half-life at any dt, else camera feel changes with fps), must never
 * overshoot (chase cam oscillation reads as bug), pitch/zoom clamps keep
 * the user inside sane orbit limits, and min-height keeps the lens out of
 * the water for any injected ocean height sampler.
 */
import { describe, expect, it } from 'vitest';
import {
  clamp,
  dampAngle,
  dampFactor,
  enforceMinHeight,
  expDamp,
  sphericalOffset,
  wrapAngle,
} from '../src/camera/camMath';
import { cameraParams } from '../src/params/camera';

describe('exponential damping', () => {
  it('converges monotonically toward the target without overshoot', () => {
    let x = 0;
    let prevDist = 10;
    for (let i = 0; i < 200; i++) {
      x = expDamp(x, 10, 0.2, 1 / 60);
      const dist = Math.abs(10 - x);
      expect(dist).toBeLessThan(prevDist); // strictly approaching
      expect(x).toBeLessThanOrEqual(10); // never past the target
      prevDist = dist;
    }
    expect(prevDist).toBeLessThan(0.01);
  });

  it('halves the remaining distance every halfLife regardless of step size', () => {
    // one step of dt = halfLife → half the gap
    expect(expDamp(0, 1, 0.25, 0.25)).toBeCloseTo(0.5, 10);
    // two half-life steps ≡ one double step → frame-rate independence
    const twoSteps = expDamp(expDamp(0, 1, 0.25, 0.25), 1, 0.25, 0.25);
    expect(twoSteps).toBeCloseTo(expDamp(0, 1, 0.25, 0.5), 10);
    expect(twoSteps).toBeCloseTo(0.75, 10);
  });

  it('halfLife 0 snaps to the target', () => {
    expect(dampFactor(0, 1 / 60)).toBe(1);
    expect(expDamp(3, 7, 0, 1 / 60)).toBe(7);
  });

  it('dampAngle takes the short way across the ±π seam', () => {
    // 3.0 → -3.0 rad is 0.28 rad through π, not 6 rad back through 0
    const next = dampAngle(3.0, -3.0, 0.2, 1 / 60);
    expect(next).toBeGreaterThan(3.0);
    expect(wrapAngle(next)).toBeGreaterThan(0); // still shy of the seam
  });
});

describe('orbit limits', () => {
  it('pitch clamps to the configured window', () => {
    const p = cameraParams;
    expect(clamp(99, p.pitchMin, p.pitchMax)).toBe(p.pitchMax);
    expect(clamp(-99, p.pitchMin, p.pitchMax)).toBe(p.pitchMin);
    const inside = (p.pitchMin + p.pitchMax) / 2;
    expect(clamp(inside, p.pitchMin, p.pitchMax)).toBe(inside);
  });

  it('zoom radius clamps to min/max', () => {
    const p = cameraParams;
    expect(clamp(0.1, p.minRadius, p.maxRadius)).toBe(p.minRadius);
    expect(clamp(1e6, p.minRadius, p.maxRadius)).toBe(p.maxRadius);
  });

  it('sphericalOffset keeps the camera on the orbit sphere', () => {
    const [x, y, z] = sphericalOffset(1.1, 0.6, 25);
    expect(Math.hypot(x, y, z)).toBeCloseTo(25, 10);
    // pitch 0 = horizontal, yaw 0 = behind along +z
    expect(sphericalOffset(0, 0, 10)[1]).toBeCloseTo(0, 10);
    expect(sphericalOffset(0, 0, 10)[2]).toBeCloseTo(10, 10);
    // positive pitch raises the camera
    expect(sphericalOffset(0, 0.5, 10)[1]).toBeGreaterThan(0);
  });
});

describe('min height above water', () => {
  it('lifts the camera above the sampled ocean height', () => {
    const swell = (x: number, z: number): number => 2 + Math.sin(x * 0.1) + Math.cos(z * 0.1);
    const x = 3;
    const z = -7;
    const floor = swell(x, z) + cameraParams.minHeightAboveWater;
    expect(enforceMinHeight(-5, x, z, cameraParams.minHeightAboveWater, swell)).toBe(floor);
    // already high enough → untouched (no sticky snapping to the floor)
    expect(enforceMinHeight(floor + 4, x, z, cameraParams.minHeightAboveWater, swell)).toBe(
      floor + 4,
    );
  });

  it('defaults to the y=0 plane when no height sampler is provided', () => {
    expect(enforceMinHeight(-1, 0, 0, 1.5)).toBe(1.5);
    expect(enforceMinHeight(9, 0, 0, 1.5)).toBe(9);
  });
});
