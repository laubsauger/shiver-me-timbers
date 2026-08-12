/**
 * Screen-space god rays / fake volumetric light (§T.39, §V.43).
 *
 * A radial blur of a bright-pass of the frame, marched from every pixel toward
 * the sun's projected screen position. Wherever something dark interrupts the
 * bright surround of the sun — masts, yards, 48 ropes, 162 ratline rungs, a
 * sail edge, an island silhouette — the march loses those taps and a shaft
 * appears. Nothing needs to be authored per-occluder; the ship's own rigging is
 * the shaft generator, which is why this technique fits this scene so well.
 *
 * WHY A BRIGHT PASS AND NOT DEPTH. The obvious occlusion source is the depth
 * buffer (sky = light, geometry = shadow), and it would give crisper shafts.
 * It is rejected because WebGPU cannot resolve a multisampled depth attachment,
 * so reading pass depth forces the whole scene pass to `samples: 0` — the frame
 * loses MSAA, and this ship is made of exactly the thin geometry that MSAA
 * exists for. Luminance costs no depth and no MSAA. The sun is drawn on
 * `scene.backgroundNode` at infinity (§V.32) and has no depth of its own
 * anyway, so a depth-based mask would have had to special-case it.
 *
 * RESOLUTION (§V.48). Shafts are inherently low-frequency, so the march runs at
 * a fraction of the frame. But a single tap of the full-res scene at half rate
 * is minified sampling of an image full of one-pixel ropes — per-pixel speckle,
 * the symptom §V.48 names. The bright pass therefore does a 4-tap box reduction
 * on the way down instead of a point sample, and the march reads THAT.
 *
 * The two RTTs cost, at scale 0.5 and 32 taps, about 9 full-res taps of work.
 * Both are tunable; measure before assuming (§V.17).
 */
import * as THREE from 'three/webgpu';
import type { Node, PassNode } from 'three/webgpu';
import {
  Fn,
  Loop,
  float,
  luminance,
  rtt,
  smoothstep,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { ShaderNodeObject } from 'three/tsl';
import { postParams as pp } from '../params/post';

export interface PostGodRays {
  /** vec3 ADDITIVE term in scene-linear space — add before the tone map */
  node: ShaderNodeObject<Node>;
  /** per-frame: sun projection, live uniforms, render-target sizing */
  update(): void;
}

/** smoothstep on the CPU, clamped — same curve the shader would use */
function smoothstep01(x: number): number {
  if (!(x > 0)) return 0; // also catches NaN
  if (x >= 1) return 1;
  return x * x * (3 - 2 * x);
}

function finite(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

/** where the sun is on screen this frame, and how much it may contribute */
export interface SunScreenState {
  /**
   * Sun position in screen UV (0..1). HELD at its last valid value whenever
   * the sun is not projectable, rather than reset — see below.
   */
  x: number;
  y: number;
  /** 0..1 fade applied to the whole effect */
  vis: number;
}

const _sunWorld = /*@__PURE__*/ new THREE.Vector3();
const _forward = /*@__PURE__*/ new THREE.Vector3();

/**
 * Project the sun and decide how much of the effect survives, mutating and
 * returning `state`. Pure with respect to everything except `state`, so the
 * one property that actually matters here is testable without a GPU.
 *
 * THAT PROPERTY IS CONTINUITY. Naive god rays fail in two specific ways and
 * both are discontinuities:
 *
 *  1. `Vector3.project()` MIRRORS a point behind the camera to the opposite
 *     side of the screen. Projecting unconditionally makes shafts jump across
 *     the frame and streak from a phantom sun the moment the real one passes
 *     behind you. So the projection is gated on `facing`, and when it is
 *     refused the last good position is LEFT ALONE — a stale position at
 *     vis 0 is invisible, whereas resetting it to a default would snap the
 *     instant vis rises again.
 *  2. Cutting the effect at the frame border. Real shafts keep coming when
 *     the source is just off-screen, so the fade begins where the sun reaches
 *     the frame CORNER and runs `fadeDeg` further out.
 *
 * The fade is measured in ANGLE off the view axis, not in NDC. NDC was the
 * obvious choice and it is the wrong one: it is `tan(θ)/tan(halfFov)`, which
 * runs to infinity at the frustum plane, so a fade authored as "0.35 NDC past
 * the edge" silently compresses into ~8° of camera rotation and the tests
 * below measured it stepping 0.09 per half-degree. In angle the same knob is
 * uniform everywhere and the aspect ratio comes from the camera itself.
 *
 * The user has already reported lighting that "disappears entirely" when
 * rotating away from the sun; a hard edge in either of these is that same
 * complaint wearing a different hat.
 */
export function updateSunScreen(
  state: SunScreenState,
  camera: THREE.PerspectiveCamera,
  sunDir: THREE.Vector3,
  fadeDeg: number,
): SunScreenState {
  camera.getWorldDirection(_forward);
  const facing = _forward.dot(sunDir);

  if (facing > 1e-4) {
    // The sun sits at infinity (§V.32), so any positive distance along the
    // direction projects to the same screen point.
    _sunWorld.copy(camera.position).addScaledVector(sunDir, 100);
    _sunWorld.project(camera);
    state.x = _sunWorld.x * 0.5 + 0.5;
    state.y = _sunWorld.y * 0.5 + 0.5;
  }

  // cos of the half-angle to the frame CORNER — full strength anywhere inside
  const tanY = Math.tan((camera.fov * Math.PI) / 360);
  const tanX = tanY * camera.aspect;
  const cosCorner = 1 / Math.sqrt(1 + tanX * tanX + tanY * tanY);
  const fade = Math.max(fadeDeg, 0.1) * (Math.PI / 180);
  const cosOut = Math.cos(Math.min(Math.acos(cosCorner) + fade, Math.PI));

  // functional smoothstep, ascending: cosOut < cosCorner because cos falls
  // as the angle grows. Reversing these two silently inverts the fade.
  state.vis = smoothstep01((facing - cosOut) / Math.max(cosCorner - cosOut, 1e-6));
  return state;
}

export function buildGodRays(opts: {
  renderer: THREE.WebGPURenderer;
  camera: THREE.PerspectiveCamera;
  /** the scene pass — the god rays read its full-res, scene-linear, pre-exposure colour */
  scenePass: ShaderNodeObject<PassNode>;
  /** live sun direction, unit, pointing FROM the world TOWARD the sun */
  sunDirection: () => THREE.Vector3;
}): PostGodRays {
  const { renderer, camera, scenePass, sunDirection } = opts;
  const sceneColor = scenePass.getTextureNode('output');

  // Loop bound must be a literal (§V.28), so the tap count is snapshotted at
  // build time — changing it in the panel needs a reload, like the *Enabled
  // gates. Everything else below is a live uniform.
  const TAPS = Math.max(4, Math.min(128, Math.round(finite(pp.godRayTaps, 32))));
  const scale = Math.min(1, Math.max(0.1, finite(pp.godRayScale, 0.5)));

  const uSunScreen = uniform(new THREE.Vector2(0.5, 0.9));
  const uSunVis = uniform(0);
  const uThreshold = uniform(1);
  const uKnee = uniform(0.5);
  const uClamp = uniform(pp.godRayClamp);
  const uDecay = uniform(pp.godRayDecay);
  const uLength = uniform(pp.godRayLength);
  const uFalloff = uniform(pp.godRayFalloff);
  const uIntensity = uniform(0);
  /** 1 / Σ decay^i — CPU-computed so decay changes shaft SHAPE, not brightness */
  const uNorm = uniform(1 / TAPS);
  /** one texel of the reduced target, in UV */
  const uTexel = uniform(new THREE.Vector2(1 / 640, 1 / 360));

  // --- bright pass, reduced ---------------------------------------------
  // §V.44: the clamp happens HERE, before anything is masked or accumulated,
  // so every tap the march can ever read is bounded at source. The sun disc
  // runs far past this; it still saturates the mask, it just cannot smear a
  // four-digit value along the whole ray.
  const brightFn = Fn(() => {
    const p = uv();
    const o = uTexel.mul(0.25);
    const box = sceneColor
      .sample(p.add(vec2(o.x.negate(), o.y.negate())))
      .add(sceneColor.sample(p.add(vec2(o.x, o.y.negate()))))
      .add(sceneColor.sample(p.add(vec2(o.x.negate(), o.y))))
      .add(sceneColor.sample(p.add(vec2(o.x, o.y))))
      .mul(0.25).rgb;
    const bounded = box.clamp(float(0), uClamp);
    // functional smoothstep(e0, e1, x) — §V.23, receiver-as-factor trap.
    // Threshold is display-referred; update() divides it by live exposure.
    const mask = smoothstep(uThreshold, uThreshold.add(uKnee), luminance(bounded));
    return vec4(bounded.mul(mask), 1);
  });

  const brightTex = rtt(brightFn(), 2, 2);

  // --- radial march ------------------------------------------------------
  const raysFn = Fn(() => {
    const p = uv();
    const toSun = uSunScreen.sub(p);
    const stepUv = toSun.mul(uLength.div(TAPS));

    const acc = vec3(0).toVar();
    const walk = p.toVar();
    const weight = float(1).toVar();
    Loop(TAPS, () => {
      walk.addAssign(stepUv);
      weight.mulAssign(uDecay);
      acc.addAssign(brightTex.sample(walk).rgb.mul(weight));
    });

    // Radial falloff so the shafts hug the sun instead of streaking the whole
    // frame (the ocean glint road is bright too, and would otherwise smear).
    // functional smoothstep(e0, e1, x), then inverted — ascending edges only,
    // a descending pair reads as a bug at the call site (§V.23).
    const falloff = float(1).sub(smoothstep(float(0), uFalloff, toSun.length()));

    // acc ≤ clamp·Σdecay^i, and uNorm is exactly 1/Σdecay^i, so the product is
    // bounded by clamp·intensity — provably, not by hoping (§V.44).
    return vec4(
      acc.mul(uNorm).mul(uIntensity).mul(falloff.clamp(0, 1)).mul(uSunVis),
      1,
    );
  });

  const raysTex = rtt(raysFn(), 2, 2);

  // --- CPU per-frame -----------------------------------------------------
  const sunState: SunScreenState = { x: 0.5, y: 0.9, vis: 0 };
  const size = new THREE.Vector2();
  let rtW = 0;
  let rtH = 0;

  const update = (): void => {
    // resolution: both targets track the drawing buffer, resized only on a
    // real change (RenderTarget.setSize reallocates).
    renderer.getDrawingBufferSize(size);
    const w = Math.max(2, Math.round(size.width * scale));
    const h = Math.max(2, Math.round(size.height * scale));
    if (w !== rtW || h !== rtH) {
      rtW = w;
      rtH = h;
      brightTex.setSize(w, h);
      raysTex.setSize(w, h);
      uTexel.value.set(1 / w, 1 / h);
    }

    // --- sun screen position + visibility (see updateSunScreen) ---
    // NOTE: no elevation gate. §T.39 is a SUNSET showcase — the sun sitting on
    // the horizon is the money shot, not an edge case. Below the horizon the
    // sky stops drawing a sun disc, so the bright pass finds nothing and the
    // rays fade on their own.
    updateSunScreen(sunState, camera, sunDirection(), finite(pp.godRayEdgeFade, 25));
    uSunScreen.value.set(sunState.x, sunState.y);
    uSunVis.value = sunState.vis;

    // display-referred → scene-linear pre-exposure, same convention as bloom
    // (§V.31b: the same maths in the wrong space under-corrects silently)
    const exposure = Math.max(finite(renderer.toneMappingExposure, 1), 1e-3);
    uThreshold.value = finite(pp.godRayThreshold, 1) / exposure;
    uKnee.value = Math.max(finite(pp.godRayKnee, 0.6), 0.01) / exposure;

    uClamp.value = Math.max(finite(pp.godRayClamp, 12), 1e-3);
    uLength.value = Math.max(finite(pp.godRayLength, 0.6), 0);
    uFalloff.value = Math.max(finite(pp.godRayFalloff, 0.9), 1e-3);
    uIntensity.value = Math.max(finite(pp.godRayIntensity, 0), 0);

    // Σ_{i=1..TAPS} decay^i, so `decay` reshapes the shaft without changing
    // how bright the effect is overall — otherwise every decay tweak needs an
    // intensity tweak to undo it.
    const decay = Math.min(Math.max(finite(pp.godRayDecay, 0.96), 0), 1);
    uDecay.value = decay;
    let sum = 0;
    let term = 1;
    for (let i = 0; i < TAPS; i++) {
      term *= decay;
      sum += term;
    }
    uNorm.value = sum > 1e-6 ? 1 / sum : 0;
  };

  update();

  return { node: raysTex.rgb, update };
}
