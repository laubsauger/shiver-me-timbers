/**
 * Post pipeline (§V.16, §V.22): AO + DoF + bloom + vignette + grade + dither.
 *
 * ORDER MATTERS, and the chain is split around the tone map on purpose:
 *
 *   scene (linear, HDR, pre-exposure)
 *     → ×AO            multiplicative occlusion, safe on unbounded values
 *     → DoF            lens focus, before any glare
 *     → +bloom         additive glare, bounded at source (§V.44)
 *     → +god rays      additive shafts, likewise bounded (src/core/postGodRays)
 *     → ×vignette      lens exposure falloff — a multiply, so the tone curve
 *                      still rolls the darkened highlights off gracefully
 *     → renderOutput   ACES + working→sRGB  (PostProcessing.outputColorTransform
 *                      is false so this happens HERE, not implicitly last)
 *     → vibrance       EXTRAPOLATING op — must see bounded 0..1 input
 *     → +dither        immediately before 8-bit quantisation
 *
 * The vibrance placement is a bug fix, not taste. `vibrance()` is
 * `mix(color, maxChannel, -3·adjustment·(max−avg))` — a mix with a NEGATIVE
 * factor, i.e. extrapolation away from the max channel, and its magnitude
 * scales with the input's dynamic range. Fed raw HDR it drives channels
 * negative (a linear (2.0, 0.3, 0.05) golden-hour pixel at adjustment 0.25
 * comes out green −1.25, blue −1.73), and both the ACES rational and the sRGB
 * transfer turn a negative into Inf/NaN. Post-tone-map the input is 0..1 and
 * the same operation is bounded by construction (§V.44).
 *
 * Two levels of control (§V.16): `*Enabled` are CONSTRUCTION gates that add or
 * omit whole nodes — a pass that renders wrong cannot be neutralised by
 * scaling its output, so bisecting a bad frame needs the node GONE, not
 * damped, and a disabled stage then also costs nothing at boot. The numeric
 * knobs are live uniforms with an exact identity value.
 */
import * as THREE from 'three/webgpu';
import {
  float,
  mix,
  pass,
  renderOutput,
  screenCoordinate,
  screenUV,
  smoothstep,
  uniform,
  vec2,
  vec3,
  vec4,
  vibrance,
} from 'three/tsl';
import type { Node, PassNode } from 'three/webgpu';
import type { ShaderNodeObject } from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { postParams as pp } from '../params/post';
import { skyParams } from '../params/sky';
import { sunDirection as solarDirection } from '../sky/sunCycle';
import { buildGodRays } from './postGodRays';

export interface PostOptions {
  /**
   * Underwater camera mode (§V.25). Passed in rather than built here because
   * it also owns a scene-pass mesh (the meniscus band) and a per-frame CPU
   * update, so main.ts has to hold the handle anyway.
   *
   * It gets the RAW scene colour and sits FIRST in the chain, ahead of bloom
   * and the god rays: the water absorbs light on its way to the lens, so every
   * additive stage downstream must see the already-extinguished image or it
   * blooms radiance the water removed. It is a no-op above the surface (its
   * submersion blend is 0), which is why it can sit unconditionally in the
   * graph instead of behind a construction gate.
   */
  underwater?: {
    buildStage(scenePass: ShaderNodeObject<PassNode>): {
      apply(rgb: ShaderNodeObject<Node>): ShaderNodeObject<Node>;
      additive: ShaderNodeObject<Node>;
      updateFromParams(): void;
    };
  };
  /**
   * Live sun direction (unit, world → sun) for the god rays. Defaults to the
   * same pure solar function the sky itself integrates, read off the same live
   * `skyParams` — so post needs no wiring and cannot drift from the sky by
   * being handed a stale vector. Pass `() => sky.sunDirection` to bind the
   * sky handle's own vector instead.
   */
  sunDirection?: () => THREE.Vector3;
}

export interface PostPipeline {
  /** call instead of renderer.render() */
  render(): void;
  /** push live params (call per frame) */
  updateFromParams(): void;
  /**
   * Build every post pipeline before the splash lifts (§T.40). Compiles only —
   * `presentAsync()` draws the frame, so boot can time the two separately.
   */
  warmup(): Promise<void>;
  /** render one frame through post and wait for it to be submitted (§V.39) */
  presentAsync(): Promise<void>;
  /**
   * Compile ONE object against the post scene pass's render context (§T.40).
   *
   * The object does NOT have to be in the scene yet — that is the point. A
   * deferred subsystem is built, warmed here while invisible, and only then
   * added, so it never compiles on its first draw (which is synchronous, i.e.
   * a visible hitch). `scene` is passed as the target scene so lights, fog and
   * environment match what the object will actually be drawn with.
   */
  warmObject(object: THREE.Object3D): Promise<void>;
}

/** §V.28: no caller-fed uniform reaches a shader unguarded. */
function finite(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

export function createPostPipeline(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  options: PostOptions = {},
): PostPipeline {
  const post = new THREE.PostProcessing(renderer);
  // we place the output transform ourselves (see header). PostProcessing then
  // publishes the renderer's toneMapping/outputColorSpace on the node context,
  // and the bare renderOutput() below picks them up from there.
  post.outputColorTransform = false;

  // MSAA: `PassNode.setup` copies `renderer.samples` (antialias:true → 4) onto
  // the pass render target unless told otherwise. Keep it — through post the
  // scene still rasterises into a real MSAA target and resolves, so ropes and
  // yards keep their edges — EXCEPT when a stage reads the pass DEPTH. WebGPU
  // cannot resolve a multisampled depth attachment, so AO/DoF would be
  // marching an unresolved buffer (§V.28). Those stages force samples: 0 and
  // pay for it in aliasing; that trade is documented at the param.
  const readsDepth = pp.aoEnabled || pp.dofEnabled;
  const scenePass = readsDepth
    ? pass(scene, camera, { samples: 0 })
    : pass(scene, camera);

  /**
   * §V.62 fail-loud. Every `*Enabled` below is read ONCE, here, into a baked
   * TSL graph — the single most repeated defect in this project (eleven
   * occurrences), and every one of them was found by a user reporting that a
   * fix "did not work". The gate is documented as needing a reload, but
   * nothing enforced it: whoever writes the param later (the settings bridge
   * writes ALL of them on every change) got no signal at all, and in the
   * `aoEnabled` case the divergence also changes the scene pass's SAMPLE
   * COUNT, i.e. it can invalidate the render pass rather than just look
   * wrong. So: name the gates, snapshot them, and say so once if they drift.
   */
  const gates: ReadonlyArray<[string, boolean, () => boolean]> = [
    ['aoEnabled', pp.aoEnabled, () => pp.aoEnabled],
    ['dofEnabled', pp.dofEnabled, () => pp.dofEnabled],
    ['bloomEnabled', pp.bloomEnabled, () => pp.bloomEnabled],
    ['godRaysEnabled', pp.godRaysEnabled, () => pp.godRaysEnabled],
    ['vignetteEnabled', pp.vignetteEnabled, () => pp.vignetteEnabled],
    ['vibranceEnabled', pp.vibranceEnabled, () => pp.vibranceEnabled],
    ['grainEnabled', pp.grainEnabled, () => pp.grainEnabled],
  ];
  const drifted = new Set<string>();
  const checkGateDrift = (): void => {
    for (const [name, built, read] of gates) {
      if (read() === built || drifted.has(name)) continue;
      drifted.add(name);
      console.warn(
        `[post] postParams.${name} changed to ${read()} AFTER the pipeline was built ` +
          `(built with ${built}). It is a CONSTRUCTION gate — the graph does not ` +
          `change until reload, and aoEnabled/dofEnabled additionally set the scene ` +
          `pass sample count. Reload to apply (§V.62).`,
      );
    }
  };
  const rawColor = scenePass.getTextureNode('output');

  // --- underwater volume + lens (§V.25) ---------------------------------
  // First in the chain, on the raw scene colour. See PostOptions.underwater.
  const underwater = options.underwater?.buildStage(scenePass) ?? null;
  const color =
    underwater === null
      ? rawColor
      : vec4(underwater.apply(rawColor.rgb), rawColor.a);

  // --- AO -------------------------------------------------------------
  // No MRT normal target, deliberately. This scene draws its principal
  // surfaces with MeshBasicNodeMaterial — the ocean (§V.20: PBR washed the
  // pigment grey), the sky dome and the cloud composite quad — so `normalView`
  // is the raw grid/dome vertex normal, not the shading normal the surface
  // displays. Passing null makes GTAO reconstruct normals from depth, which at
  // least agrees with what is actually in the depth buffer.
  const uAoAmount = uniform(0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lit: any = color;
  if (pp.aoEnabled) {
    // @types/three declares normalNode non-nullable, but GTAONode documents
    // and implements the null case ("normals can be automatically
    // reconstructed from depth"). Upstream typing gap, not a semantic one.
    const noNormals = null as unknown as Parameters<typeof ao>[1];
    const aoPass = ao(scenePass.getTextureNode('depth'), noNormals, camera);
    aoPass.resolutionScale = 0.5; // half-res AO, §V.17 render budget
    // clamp before use: an AO sample that ever reads garbage must not be able
    // to multiply the whole frame to black (§V.28).
    const aoRgb = aoPass.getTextureNode().rgb.clamp(0, 1);
    lit = vec4(color.rgb.mul(mix(vec3(1), aoRgb, uAoAmount)), color.a);
  }

  // --- depth of field --------------------------------------------------
  // Opt-in only (see params). Focus is a plain distance in metres along the
  // view axis; there is no autofocus because nothing in this module knows what
  // the camera is looking at — wire one from the follow cam if photo mode
  // wants it.
  const uDofFocus = uniform(pp.dofFocus);
  const uDofRange = uniform(pp.dofRange);
  const uDofBokeh = uniform(pp.dofBokeh);
  if (pp.dofEnabled) {
    lit = dof(lit, scenePass.getViewZNode(), uDofFocus, uDofRange, uDofBokeh);
  }

  // --- bloom ------------------------------------------------------------
  // §V.44: the additive term is bounded AT SOURCE. The beauty path keeps its
  // full range; only what feeds the blur chain is clamped, so a sun disc at
  // four digits still blooms hard without smearing four digits over a fifth of
  // the screen. threshold/knee are display-referred and converted against live
  // exposure in updateFromParams().
  const uBloomClamp = uniform(pp.bloomClamp);
  const bloomPass = pp.bloomEnabled
    ? bloom(vec4(lit.rgb.clamp(float(0), uBloomClamp), lit.a))
    : null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let hdr: any = bloomPass === null ? lit.rgb : lit.rgb.add(bloomPass.rgb);

  // --- god rays ---------------------------------------------------------
  // Fed the RAW scene colour, not `lit`: shafts are built from the sharp,
  // un-bloomed, un-defocused image, so DoF cannot soften the occluders that
  // cut them and bloom cannot be counted twice. That also keeps the stage
  // independently bisectable.
  const sunTmp = new THREE.Vector3();
  const sunDir =
    options.sunDirection ??
    ((): THREE.Vector3 => {
      const d = solarDirection(skyParams.timeOfDay, skyParams.latitude);
      return sunTmp.set(d[0], d[1], d[2]);
    });
  const godRays = pp.godRaysEnabled
    ? buildGodRays({ renderer, camera, scenePass, sunDirection: sunDir })
    : null;
  if (godRays !== null) hdr = hdr.add(godRays.node);

  // Underwater shafts are a SEPARATE additive term from the surface god rays:
  // they are masked by the submersion blend, so exactly one of the two is ever
  // contributing. Both are bounded at source (§V.44).
  if (underwater !== null) hdr = hdr.add(underwater.additive);

  // --- vignette (pre tone map: an exposure falloff, so a multiply) -------
  const uVigStrength = uniform(0);
  const uVigStart = uniform(pp.vignetteStart);
  const uVigEnd = uniform(pp.vignetteEnd);
  if (pp.vignetteEnabled) {
    // functional smoothstep(e0, e1, x) — §V.23, receiver-as-factor trap.
    // screenUV is 0..1 per axis regardless of aspect, so this is an ellipse
    // matching the frame, and the corner sits at exactly length(0.5,0.5).
    const dist = screenUV.sub(0.5).length();
    const vig = float(1).sub(smoothstep(uVigStart, uVigEnd, dist).mul(uVigStrength));
    hdr = hdr.mul(vig.clamp(0, 1));
  }

  // --- output transform: linear HDR → ACES → sRGB ------------------------
  // nulls = "take toneMapping and outputColorSpace from the PostProcessing
  // context", which is what outputColorTransform=false publishes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let graded: any = renderOutput(vec4(hdr, 1)).rgb;

  // --- grade (display space, bounded input) ------------------------------
  const uVibrance = uniform(0);
  if (pp.vibranceEnabled) graded = vibrance(graded, uVibrance);

  // --- dither ------------------------------------------------------------
  // Interleaved-gradient noise [Jimenez 2014]: better distributed than a
  // white-noise hash at the same cost, and screen-locked rather than animated
  // so a capture keeps its bitrate. The constants are the published IGN
  // magic numbers, not tunables.
  const uGrain = uniform(0);
  if (pp.grainEnabled) {
    const ign = float(52.9829189)
      .mul(screenCoordinate.dot(vec2(0.06711056, 0.00583715)).fract())
      .fract();
    graded = graded.add(ign.sub(0.5).mul(uGrain));
  }

  post.outputNode = vec4(graded.clamp(0, 1), 1);

  const updateFromParams = (): void => {
    checkGateDrift();
    uAoAmount.value = pp.aoEnabled ? finite(pp.aoStrength, 0) : 0;
    underwater?.updateFromParams();

    // must run before post.render(): it projects the sun for THIS frame and
    // resizes the ray targets. main.ts calls updateFromParams() then render().
    godRays?.update();

    if (bloomPass !== null) {
      // display-referred → scene-linear pre-exposure (§V.31b: the same maths
      // in the wrong space under-corrects silently). 1.0 means "the luminance
      // that tone-maps to white", which is what a bloom threshold should mean
      // and what keeps the knob honest when `sky.exposure` moves.
      const exposure = Math.max(finite(renderer.toneMappingExposure, 1), 1e-3);
      bloomPass.threshold.value = finite(pp.bloomThreshold, 1) / exposure;
      bloomPass.smoothWidth.value =
        Math.max(finite(pp.bloomKnee, 0.5), 0.01) / exposure;
      bloomPass.strength.value = pp.bloomEnabled ? finite(pp.bloomStrength, 0) : 0;
      bloomPass.radius.value = finite(pp.bloomRadius, 0);
      uBloomClamp.value = Math.max(finite(pp.bloomClamp, 12), 1e-3);
    }

    uDofFocus.value = Math.max(finite(pp.dofFocus, 28), 0.01);
    uDofRange.value = Math.max(finite(pp.dofRange, 45), 0.01);
    uDofBokeh.value = Math.max(finite(pp.dofBokeh, 2), 0);

    uVibrance.value = pp.vibranceEnabled ? finite(pp.vibrance, 0) : 0;
    uVigStrength.value = pp.vignetteEnabled ? finite(pp.vignetteStrength, 0) : 0;
    uVigStart.value = finite(pp.vignetteStart, 0.45);
    // keep the falloff monotonic: an end edge at or below the start edge makes
    // smoothstep a step function at the frame centre.
    uVigEnd.value = Math.max(finite(pp.vignetteEnd, 0.72), uVigStart.value + 1e-3);
    uGrain.value = pp.grainEnabled ? finite(pp.grainAmount, 0) : 0;
  };
  updateFromParams();

  /**
   * §T.40. `PassNode.setup()` copies the sample count and colour-buffer type
   * onto its render target — but setup runs on the first RENDER, which is
   * after every warm-up. A pipeline's cache key contains the sample count and
   * the colour/depth formats, so compiling against the target in its
   * construction-time state (samples 0) produces pipelines that are DISCARDED
   * and rebuilt synchronously on the first real frame — the whole compile
   * paid twice, the second time blocking. Mirror setup() first.
   */
  const syncPassTarget = (): void => {
    scenePass.renderTarget.samples = readsDepth ? 0 : renderer.samples;
    scenePass.renderTarget.texture.type = renderer.getColorBufferType();
  };

  return {
    render(): void {
      post.render();
    },
    updateFromParams,
    async warmup(): Promise<void> {
      // Warms the scene materials against the PASS target (which is where they
      // are actually drawn when post is on) plus the post quads themselves
      // (bloom alone adds ~12 pipelines, and they are full-screen quads that
      // live outside the scene graph, so `compileAsync(scene, camera)` never
      // sees them). That plain call also warms the CANVAS context — a
      // different sample count and colour format, therefore a different
      // pipeline cache key, therefore work the first post frame throws away
      // and redoes SYNCHRONOUSLY, right as the splash lifts.
      syncPassTarget();
      const prevTarget = renderer.getRenderTarget();
      const prevMRT = renderer.getMRT();
      renderer.setRenderTarget(scenePass.renderTarget);
      renderer.setMRT(scenePass.getMRT());
      // restore before yielding — see warmObject()
      const pending = renderer.compileAsync(scene, camera, scene);
      renderer.setRenderTarget(prevTarget);
      renderer.setMRT(prevMRT);
      await pending;
    },
    async presentAsync(): Promise<void> {
      await post.renderAsync();
    },
    async warmObject(object: THREE.Object3D): Promise<void> {
      syncPassTarget();
      const prevTarget = renderer.getRenderTarget();
      const prevMRT = renderer.getMRT();
      renderer.setRenderTarget(scenePass.renderTarget);
      renderer.setMRT(scenePass.getMRT());
      // compileAsync runs SYNCHRONOUSLY up to its final await, so restoring
      // the target before awaiting is both safe and REQUIRED: yielding with
      // the pass target still bound would send the next frame's render into
      // it. (PassNode.compileAsync gets this wrong; we do not call it here.)
      const pending = renderer.compileAsync(object, camera, scene);
      renderer.setRenderTarget(prevTarget);
      renderer.setMRT(prevMRT);
      await pending;
    },
  };
}
