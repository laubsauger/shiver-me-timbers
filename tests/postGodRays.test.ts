/**
 * God-ray sun projection (§T.39, §V.16).
 *
 * WHY THIS FILE EXISTS. Everything else about screen-space god rays needs a
 * GPU to judge, but the one thing that reliably makes the technique look
 * BROKEN is pure CPU arithmetic: the fade as the sun leaves the frame. Two
 * specific discontinuities are the classic failures —
 *
 *   * `Vector3.project()` mirrors points behind the camera to the opposite
 *     side of the screen, so an unguarded projection makes the shafts jump
 *     across the frame and streak from a phantom sun;
 *   * cutting the effect at the frame border pops it off instead of letting
 *     it trail away, which is exactly the "lighting disappears entirely when
 *     I turn away from the sun" the user already complained about.
 *
 * So these tests assert CONTINUITY under camera rotation, not just endpoint
 * values: a test that only checked "vis is 1 facing the sun, 0 facing away"
 * would pass with a hard cut in between, which is the bug.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { updateSunScreen, type SunScreenState } from '../src/core/postGodRays';
import godRaysSource from '../src/core/postGodRays.ts?raw';
import { postParams } from '../src/params/post';
import { getParamsEntry } from '../src/params/registry';

const FADE_DEG = 25;

function camera(yaw: number): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 8000);
  cam.position.set(0, 12, 0);
  // yaw 0 looks down −Z, three's default forward
  cam.rotation.set(0, yaw, 0, 'YXZ');
  cam.updateMatrixWorld(true);
  return cam;
}

/** a low sun to the −Z side, roughly the §T.39 golden-hour setup */
const SUN = new THREE.Vector3(0, 0.35, -1).normalize();

const fresh = (): SunScreenState => ({ x: 0.5, y: 0.9, vis: 0 });

describe('god-ray sun projection (§T.39)', () => {
  it('puts the sun where the camera is looking, at full strength', () => {
    const s = updateSunScreen(fresh(), camera(0), SUN, FADE_DEG);
    expect(s.vis).toBeCloseTo(1, 5);
    // dead ahead horizontally, above centre because the sun is above the
    // view axis — screen UV, so y grows upward
    expect(s.x).toBeCloseTo(0.5, 5);
    expect(s.y).toBeGreaterThan(0.5);
  });

  it('contributes nothing when the sun is behind the camera', () => {
    const s = updateSunScreen(fresh(), camera(Math.PI), SUN, FADE_DEG);
    expect(s.vis).toBe(0);
  });

  it('leaves the screen position ALONE when the sun is unprojectable', () => {
    // Behind the camera, project() mirrors. If we wrote that mirrored point
    // through, the shafts would be aimed at a phantom sun on the wrong side
    // of the frame the moment vis rose again. Holding the last good value
    // means there is nothing to snap back from.
    const s = updateSunScreen(fresh(), camera(0), SUN, FADE_DEG);
    const held = { x: s.x, y: s.y };
    updateSunScreen(s, camera(Math.PI), SUN, FADE_DEG);
    expect(s.vis).toBe(0);
    expect(s.x).toBe(held.x);
    expect(s.y).toBe(held.y);
  });

  it('fades continuously through a full 360° turn — no pop, ever', () => {
    const s = fresh();
    const seen: number[] = [];
    let maxJump = 0;
    let prev: number | null = null;
    // 0.5° steps: finer than any real camera slew, so a genuine
    // discontinuity cannot hide between samples
    for (let deg = 0; deg <= 360; deg += 0.5) {
      updateSunScreen(s, camera((deg * Math.PI) / 180), SUN, FADE_DEG);
      expect(Number.isFinite(s.vis)).toBe(true);
      expect(s.vis).toBeGreaterThanOrEqual(0);
      expect(s.vis).toBeLessThanOrEqual(1);
      if (prev !== null) maxJump = Math.max(maxJump, Math.abs(s.vis - prev));
      prev = s.vis;
      seen.push(s.vis);
    }
    // the effect really does turn fully on and fully off over the sweep,
    // so the continuity check below is not passing on a flat line
    expect(Math.max(...seen)).toBeGreaterThan(0.99);
    expect(Math.min(...seen)).toBe(0);
    // a hard cut at the frame border would show up here as a jump of ~1
    expect(maxJump).toBeLessThan(0.05);
  });

  it('keeps rays alive just past the border, then lets them go', () => {
    // sample outward from centred until the sun is well behind: vis must
    // decrease monotonically once it starts falling, never rise again
    const s = fresh();
    const vals: number[] = [];
    for (let deg = 0; deg <= 120; deg += 1) {
      updateSunScreen(s, camera((deg * Math.PI) / 180), SUN, FADE_DEG);
      vals.push(s.vis);
    }
    for (let i = 1; i < vals.length; i++) {
      expect(vals[i]).toBeLessThanOrEqual(vals[i - 1] + 1e-9);
    }
    // and it is a fade, not a cliff: several intermediate values exist
    const partial = vals.filter((v) => v > 0.02 && v < 0.98).length;
    expect(partial).toBeGreaterThan(3);
  });

  it('survives a garbage edge width instead of dividing by zero (§V.28)', () => {
    const s = updateSunScreen(fresh(), camera(0), SUN, 0);
    expect(Number.isFinite(s.vis)).toBe(true);
    expect(s.vis).toBeGreaterThanOrEqual(0);
    expect(s.vis).toBeLessThanOrEqual(1);
  });

  /**
   * THE OFF-SCREEN STREAK (user: "projected in a very weird direction… changes
   * very dramatically depending on the angle of the camera").
   *
   * Two correct decisions combined into a defect. `updateSunScreen` deliberately
   * HOLDS the sun's screen position outside 0..1 while `vis` is still positive,
   * because real shafts keep coming when the source is just off-screen and
   * cutting at the border is what makes this technique snap (the test above
   * pins that behaviour and it must stay). Meanwhile `rtt()` targets are
   * ClampToEdge. So every march tap that walked out of the frame returned the
   * EDGE TEXEL and smeared one row or column of the image along the whole ray:
   * a bright streak with no source, swinging and vanishing as the sun crossed
   * the border.
   *
   * This asserts the state that makes the bug REACHABLE, so the shader-side
   * guard can never be removed while the condition still occurs. It cannot
   * execute the WGSL, so the guard's presence is checked lexically alongside.
   */
  it('holds the sun off-screen while still visible — so taps MUST be gated', () => {
    // just past the frame corner: vis is deliberately still high here, so the
    // effect is at nearly full strength while every tap marches off the frame
    const s = updateSunScreen(fresh(), camera(0.9), SUN, FADE_DEG);
    expect(s.vis).toBeGreaterThan(0.5);
    const outside = s.x < 0 || s.x > 1 || s.y < 0 || s.y > 1;
    expect(outside).toBe(true);
    // and not marginally outside — far enough that a large share of every
    // ray's taps land beyond the border
    expect(s.x).toBeGreaterThan(1.1);
  });

  it('the march drops out-of-frame taps instead of smearing the edge texel', () => {
    // lexical, because the Loop body is WGSL by the time it could be run
    expect(godRaysSource).toContain('const inFrame = walk.x');
    expect(godRaysSource).toContain('inFrame.select(float(1), float(0))');
  });

  /**
   * `screenUV` is 0..1 per axis whatever the viewport shape, so a raw UV length
   * is an ELLIPSE on screen — the falloff reached further sideways than
   * vertically and changed shape with the window.
   *
   * The half that is NOT a bug, recorded so it is not "fixed" later: the march
   * DIRECTION was never skewed. Marching along the segment from a pixel to the
   * sun is affine-invariant, so `stepUv` needs no aspect correction and adding
   * one would bend every ray away from the sun.
   */
  it('measures the radial falloff in a round metric, not in raw UV', () => {
    expect(godRaysSource).toContain('toSun.mul(uAspect).length()');
    // the march itself stays in plain UV — a straight line is affine-invariant
    expect(godRaysSource).toContain('const stepUv = toSun.mul(uLength.div(TAPS))');
  });

  it('the falloff radius is small enough to actually bite', () => {
    // At the old 0.9 this term read ≈1 everywhere the march has any energy —
    // the smear only reaches 1/(1−length) times the bright region's radius —
    // so it was inert and the comment claiming it "hugs the sun" was describing
    // an intention. It must stay comparable to the march's own reach.
    const reach = 1 / (1 - postParams.godRayLength);
    expect(postParams.godRayLength).toBeLessThan(0.4);
    expect(reach).toBeLessThan(1.8);
    expect(postParams.godRayFalloff).toBeLessThan(0.5);
  });

  it('registers every post tunable with the panel (§V.16)', () => {
    const entry = getParamsEntry('post');
    expect(entry).toBeDefined();
    for (const key of Object.keys(postParams)) {
      expect(entry!.params).toHaveProperty(key);
    }
    // the UI graphics switches bind these by name — renaming one silently
    // detaches a settings toggle from the thing it claims to switch
    for (const key of [
      'enabled',
      'aoEnabled',
      'bloomEnabled',
      'vibranceEnabled',
      'vignetteEnabled',
    ]) {
      expect(postParams).toHaveProperty(key);
    }
  });
});
