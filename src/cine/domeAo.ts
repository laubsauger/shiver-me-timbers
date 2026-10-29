/**
 * AMBIENT OCCLUSION FOR THE DOME CAPTURE: contact and crevice darkening of the INDIRECT light, seam-free across
 * the cube faces (the user, 2026-10-29: "everything looks pasted on" — the trees, the raft; the film had no
 * occlusion term at all below the sun's shadow map's 7.8 cm texel).
 *
 * WHY NOT THE GAME'S GTAO (core/postPipeline.ts). It multiplies the finished, lit colour — sunlight, haze and all —
 * which is the "dirty halo" look: a sunlit crevice darkened as much as a shaded one. Occlusion of ambient light
 * belongs where the light is summed, on the indirect term alone. three does exactly that through the lighting
 * context's `getAO` (NodeMaterial.setupAmbientOcclusion: PhysicalLightingModel multiplies `indirectDiffuse` by it
 * and derives a specular occlusion from it), so the occlusion here is handed to every lit material's lighting,
 * and the direct sun keeps its own shadow. That needs the occlusion BEFORE the face is shaded: a depth pre-pass.
 *
 * WHY A GUARD BAND. Screen-space AO marches the depth buffer around each pixel; at a cube face's edge half of its
 * neighbourhood is on the next face, and two faces computing the same direction from different halves disagree —
 * a seam. So each face's pre-pass is drawn WIDER than the face: the same camera (same eye, same orientation) with
 * a field `BAND_DEG` larger on every side, into a square target exactly `band` px larger on each side, so its
 * pixel grid is the face's own grid extended (at full resolution face pixel (x, y) is pre-pass texel (x + band,
 * y + band): same rasterisation, same surface, no resampling). The march is clamped to `BAND_DEG` of arc from the pixel (the radius
 * shrinks for things nearer than radius / tan(BAND_DEG), ~5.7 m at 1 m), which keeps it inside the band, and the
 * clamp is an ANGLE, the same from every face — two faces seeing one point compute it from the same neighbourhood.
 * Slices are laid out around each pixel's own view ray in view space (not as screen directions), so the slices'
 * spread does not depend on where on a face the pixel falls either.
 *
 * THE ESTIMATOR is GTAO's (Jimenez et al. 2016, "Practical Real-Time Strategies for Accurate Indirect Occlusion"):
 * per slice the two horizons found by a march, the cosine-weighted visibility between them in closed form, weighted
 * by the projected normal; the falloff to the radius is XeGTAO's (the outer 61.5 % of it). Normals from the depth
 * (the side of the smaller step, so a silhouette does not tilt them). Interreflection is not ignored: the visibility
 * is lifted by the receiver's albedo with the paper's multi-bounce fit (sand and white sail barely darken; dark
 * bark does), so the term stays the physically small one — a darkening of the sky's light in contacts and creases.
 *
 * EVERY FRAME A PURE FUNCTION OF TIME: no temporal filter, no frame index in the noise. Each pixel takes `SLICES`
 * slices at one of 16 rotations (a 4×4 Bayer tile) and its steps at one of 16 offsets; a depth- and receiver-
 * aware 4×4 blur then averages every rotation once — `SLICES` × 16 slices a pixel, the same in every frame.
 *
 * WHO RECEIVES IT (`receivesDomeAo`): lit, opaque, depth-writing materials not marked exempt (core/aoReceiver.ts
 * markAoExempt, the game's B124 flag). So the ocean (transparent, and marked), the sky sphere (unlit: it writes no
 * depth either), the additive glows, the spray, the swash's sheet and the debris (all transparent) keep their light.
 * They still OCCLUDE where they write depth: the raft's logs keep their contact against the water, as in the game.
 *
 * COST: the pre-pass runs every material's vertex stage again over ~2× a face's area, its fragment stage with a
 * constant output (three's MRT: the lit colour is never read, so the shader compiler can drop it), plus the march
 * and the blur, per drawn face. Measured 2048², warm frames, wall time to the frame's readback (2026-10-29): the
 * open sea with the raft 180 → 190 ms, the beach and its forest 257 → 315 ms; at 1024² the beach's cost is nearly
 * the same (+54 ms), so it is mostly the pre-pass's geometry, little of it pixels. Faces wider than `FULL_RES_MAX`
 * (the 8K master's, ~4500 px; ~9000 supersampled) take it at HALF resolution — a metre of occlusion is still tens
 * of texels there, and at full resolution the pre-pass and its targets, with the ocean's framebuffer copies of
 * them, would be ~5 GB at 8K supersampled (estimated: 6 targets of ~12900² half-float). The colour pass then reads
 * the four nearest texels, each weighed by whether it saw the fragment's own surface.
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  abs,
  acos,
  clamp,
  context,
  cos,
  cross,
  diffuseColor,
  dot,
  float,
  ivec2,
  length,
  luminance,
  max,
  min,
  mix,
  mrt,
  normalize,
  output,
  positionView,
  screenCoordinate,
  select,
  sign,
  sin,
  smoothstep,
  texture,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { aoReceptivity } from '../core/aoReceiver';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node union
type TslNode = any;

/** how the occlusion is applied, per frame */
export interface DomeAoLook {
  /** 0..1, how much of the occlusion the indirect light takes (1: all of it; 0: none, and nothing is drawn for it) */
  strength: number;
  /** m, how far an occluder reaches (scene metres: the sea's acts are 1 unit = 1 m) */
  radius: number;
}

/** deg of arc each face's pre-pass reaches past the face on every side (see the header) */
const BAND_DEG = 10;
/** slices a pixel (× the 16 rotations of the blur's tile), and steps each way along one */
const SLICES = 4;
const STEPS = 8;
/** m: the occlusion fades out between these distances (a metre-scale term is sub-pixel past them, and the depth
 * buffer's precision there — ~2 cm at 300 m from the pre-pass's near plane — is the radius' order) */
const FADE: [number, number] = [150, 300];
/** m: the pre-pass's near plane (the faces' own is 5 cm; 30 cm gives the depth 6× the precision, and anything
 * nearer than this to the eye is simply not occluded — the colour pass checks it is looking at the pre-pass's
 * surface) */
const NEAR = 0.3;
/** the blur's relative depth tolerance: a neighbour further than this × the depth from the centre is not averaged */
const BLUR_DEPTH = 0.1;
/** the colour pass's check that its fragment is the surface the pre-pass saw: relative, plus m */
const SAME_SURFACE: [number, number] = [0.03, 0.02];
/** px: the widest face taken at full resolution; wider ones at half (see the header) */
const FULL_RES_MAX = 4096;

/**
 * Whether `material` takes the dome's occlusion: lit (not MeshBasic, whose whole colour three's basic lighting
 * model treats as "indirect"), opaque, depth-writing, and not marked exempt. Decided per material when its
 * pipeline is built.
 */
export function receivesDomeAo(material: THREE.Material | null | undefined): boolean {
  if (!material) return false;
  const m = material as THREE.Material & { lights?: boolean; isMeshBasicNodeMaterial?: boolean };
  return m.lights === true && m.isMeshBasicNodeMaterial !== true && !m.transparent && m.depthWrite && aoReceptivity(m) === 1;
}

/**
 * Face px of guard band each side of a face `size` px wide (tan grows past 45°: the band is widest in px at the
 * edge), a whole number of pre-pass texels of `scale` face px.
 */
export function domeAoBand(size: number, scale = 1): number {
  return Math.ceil((size * (Math.tan(((45 + BAND_DEG) * Math.PI) / 180) - 1)) / 2 / scale) * scale;
}

export class DomeAo {
  /** face px this was sized for; face px a pre-pass texel spans (1 or 2); the band (face px) and the pre-pass's
   * side (texels) */
  private size = 0;
  private scale = 1;
  private band = 0;
  private wide = 0;
  /** the pre-pass: colour = receptivity (r), depth = the face's surfaces; then the raw march, then the blur */
  private readonly prepass: THREE.RenderTarget;
  private readonly raw: THREE.RenderTarget;
  private readonly ao: THREE.RenderTarget;
  private readonly rawQuad: THREE.QuadMesh;
  private readonly blurQuad: THREE.QuadMesh;
  private readonly materials: THREE.NodeMaterial[] = [];
  /** the pre-pass MRT: its only output is the receptivity, so no material's lit colour is computed */
  private readonly prepassMrt: TslNode;
  /**
   * The colour pass's MRT: the material's own output, nothing else — there only to give the AO-shaded faces a render
   * context of their own. three r186 keys render contexts (and so RenderObjects) by the target's attachment FORMAT,
   * not by the target: the water's mirror (wandering/mirror.ts) draws the same scene into a cube target of the same
   * format with no `getAO`, and the two kept disposing and rebuilding each other's RenderObjects — every node
   * graph of the scene built twice a frame (measured: 2048² frames from 1.9 s to 6.6 s). A distinct MRT is a
   * distinct context. The faces' target must name its texture 'output' (three's MRT routes by attachment name).
   */
  readonly colourMrt: TslNode = mrt({ output });
  /** px: the pre-pass side and 2 / it; view x (y) per NDC unit per metre of depth; depth → metres (Z = d / (z + c)) */
  private readonly uWide = uniform(1);
  private readonly uInvHalf = uniform(2);
  private readonly uSx = uniform(1);
  private readonly uSy = uniform(1);
  private readonly uC = uniform(-1);
  private readonly uD = uniform(-NEAR);
  private readonly uRadius = uniform(1);
  private readonly uTanMax = uniform(Math.tan((BAND_DEG * Math.PI) / 180));
  /** the band in face px, and 1 / face px a texel */
  private readonly uBand = uniform(0);
  private readonly uInvScale = uniform(1);
  private readonly uStrength = uniform(1);
  private readonly depthNode: TslNode;
  private readonly recNode: TslNode;
  private readonly rawNode: TslNode;
  private readonly aoNode: TslNode;
  /** the colour pass's context (renderer's own context data plus `getAO`), rebuilt if the renderer's changes */
  private context: { base: unknown; node: TslNode } | null = null;
  private readonly fov = { fov: 0, near: 0 };

  constructor() {
    // (the colour attachment is half-float RGBA, not the red channel it carries: the ocean's refraction copies
    // the bound framebuffer mid-pass, here too, and the copy needs the format the faces have — a mismatched copy
    // is an error and a skipped copy. The depth is three's default, which the ocean's depth copy matches.)
    this.prepass = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(1, 1) });
    // three's MRT routes outputs by attachment NAME
    this.prepass.texture.name = 'output';
    this.raw = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, format: THREE.RGFormat, depthBuffer: false });
    this.ao = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, format: THREE.RGFormat, depthBuffer: false });
    this.depthNode = texture(this.prepass.depthTexture!);
    this.recNode = texture(this.prepass.texture);
    this.rawNode = texture(this.raw.texture);
    this.aoNode = texture(this.ao.texture);

    // the pre-pass's one output, per material: 1 for a receiver, 0 for a depth-writing non-receiver (the ocean), and
    // nothing at all (alpha 0, black: unchanged under every blending) for what writes no depth
    this.prepassMrt = mrt({
      output: Fn((builder: TslNode) => {
        const m = builder.material as THREE.Material;
        return m.depthWrite ? vec4(receivesDomeAo(m) ? 1 : 0, 0, 0, 1) : vec4(0);
      })(),
    });

    const raw = this.material('dome-ao-march');
    raw.fragmentNode = this.marchNode();
    this.rawQuad = new THREE.QuadMesh(raw);
    const blur = this.material('dome-ao-blur');
    blur.fragmentNode = this.blurNode();
    this.blurQuad = new THREE.QuadMesh(blur);
  }

  private material(name: string): THREE.NodeMaterial {
    const m = new THREE.NodeMaterial();
    m.depthTest = false;
    m.depthWrite = false;
    m.name = name;
    this.materials.push(m);
    return m;
  }

  /** metres from the eye along the view axis of a pre-pass depth sample */
  private linearZ(d: TslNode): TslNode {
    return this.uD.div(d.add(this.uC));
  }

  /** view-space position of pre-pass pixel centre `f` (px, float) at depth Z (m) */
  private viewPos(f: TslNode, Z: TslNode): TslNode {
    const nx: TslNode = f.x.mul(this.uInvHalf).sub(1);
    const ny: TslNode = float(1).sub(f.y.mul(this.uInvHalf));
    return vec3(nx.mul(this.uSx).mul(Z), ny.mul(this.uSy).mul(Z), Z.negate());
  }

  private pointAt(q: TslNode): TslNode {
    return this.viewPos(vec2(q).add(0.5), this.linearZ(this.depthNode.load(q)));
  }

  /** the march: raw visibility (r) and the depth (g, 0 for a non-receiver) of each pre-pass pixel */
  private marchNode(): TslNode {
    return Fn(() => {
      const q = ivec2(screenCoordinate.xy);
      const out = vec2(1, 0).toVar();
      const d0 = this.depthNode.load(q);
      If(this.recNode.load(q).x.greaterThan(0.5).and(d0.lessThan(1)), () => {
        const Z = this.linearZ(d0).toConst();
        const P = this.viewPos(screenCoordinate.xy, Z).toConst();
        const dist = length(P).toConst();
        const V = P.negate().div(dist).toConst();
        // the normal from the depth: on each axis the neighbour of the smaller step
        const Pl = this.pointAt(q.sub(ivec2(1, 0)));
        const Pr = this.pointAt(q.add(ivec2(1, 0)));
        const Pu = this.pointAt(q.sub(ivec2(0, 1)));
        const Pd = this.pointAt(q.add(ivec2(0, 1)));
        const dx: TslNode = select(abs(Pr.z.sub(P.z)).lessThan(abs(P.z.sub(Pl.z))), Pr.sub(P), P.sub(Pl));
        const dy: TslNode = select(abs(Pd.z.sub(P.z)).lessThan(abs(P.z.sub(Pu.z))), Pd.sub(P), P.sub(Pu));
        const n0 = normalize(cross(dx, dy)).toConst();
        const N = select(dot(n0, V).lessThan(0), n0.negate(), n0).toConst();
        // the radius: the scene's, held within BAND_DEG of arc (see the header); its falloff XeGTAO's
        const r = min(this.uRadius, dist.mul(this.uTanMax)).toConst();
        const falloffRange = r.mul(0.615);
        const falloffMul = float(-1).div(falloffRange).toConst();
        const falloffAdd = r.sub(falloffRange).div(falloffRange).add(1).toConst();
        // the first step a pixel and a half out (a step inside the pixel finds the pixel)
        const sMin = this.uSx.abs().mul(Z).mul(this.uInvHalf).mul(1.5).toConst();
        // a basis about the view ray (Duff et al. 2017; V.z > 0 always: P is in front)
        const a = float(-1).div(V.z.add(1));
        const b = V.x.mul(V.y).mul(a);
        const T1 = vec3(V.x.mul(V.x).mul(a).add(1), b, V.x.negate()).toConst();
        const T2 = vec3(b, V.y.mul(V.y).mul(a).add(1), V.y.negate()).toConst();
        // 4×4 Bayer: the slices' rotation and the steps' offset, each of 16 values across the blur's tile
        const bx = q.x.bitAnd(3);
        const by = q.y.bitAnd(3);
        const bxy = bx.bitXor(by);
        const rot = float(bxy.bitAnd(1).shiftLeft(3).bitOr(by.bitAnd(1).shiftLeft(2)).bitOr(bxy.bitAnd(2)).bitOr(by.bitAnd(2).shiftRight(1))).add(0.5).div(16).toConst();
        const jit = float(bxy.bitAnd(1).shiftLeft(3).bitOr(bx.bitAnd(1).shiftLeft(2)).bitOr(bxy.bitAnd(2)).bitOr(bx.bitAnd(2).shiftRight(1))).add(0.5).div(16).toConst();
        const vis = float(0).toVar();
        for (let i = 0; i < SLICES; i++) {
          const phi = float(i).add(rot).mul(Math.PI / SLICES);
          const D = T1.mul(cos(phi)).add(T2.mul(sin(phi))).toConst();
          // the slice's plane holds V and D; the normal projected into it, and its signed angle from V
          const axis = cross(D, V).toConst();
          const Np = N.sub(axis.mul(dot(N, axis))).toConst();
          const lenNp = length(Np).toConst();
          const cosN = clamp(dot(Np, V).div(max(lenNp, 1e-4)), 0, 1).toConst();
          const n = sign(dot(Np, D)).mul(acos(cosN)).toConst();
          const sinN = sin(n).toConst();
          // the horizons start at the tangent plane's, and rise with what the march finds
          const lowPos = sinN.negate().toConst();
          const lowNeg = sinN;
          const hcPos = lowPos.toVar();
          const hcNeg = lowNeg.toVar();
          Loop(STEPS, ({ i: j }: { i: TslNode }) => {
            const t = float(j).add(jit).div(STEPS);
            const s = sMin.add(t.mul(t).mul(max(r.sub(sMin), 0)));
            for (const side of [1, -1]) {
              const Q = P.add(D.mul(s.mul(side)));
              const w = float(-1).div(Q.z);
              const fx = Q.x.mul(w).div(this.uSx).add(1).mul(this.uWide).mul(0.5);
              const fy = float(1).sub(Q.y.mul(w).div(this.uSy)).mul(this.uWide).mul(0.5);
              const inside = fx.greaterThanEqual(0).and(fy.greaterThanEqual(0)).and(fx.lessThan(this.uWide)).and(fy.lessThan(this.uWide));
              If(inside, () => {
                const Ps = this.pointAt(ivec2(vec2(fx, fy)));
                const delta = Ps.sub(P);
                const L = length(delta);
                const shc = dot(delta, V).div(max(L, 1e-4));
                const weight = clamp(L.mul(falloffMul).add(falloffAdd), 0, 1);
                const hc = side > 0 ? hcPos : hcNeg;
                hc.assign(max(hc, mix(side > 0 ? lowPos : lowNeg, shc, weight)));
              });
            }
          });
          const h1 = n.add(min(acos(clamp(hcPos, -1, 1)).sub(n), Math.PI / 2));
          const h0 = n.add(max(acos(clamp(hcNeg, -1, 1)).negate().sub(n), -Math.PI / 2));
          const arc = (h: TslNode): TslNode => cosN.add(h.mul(2).mul(sinN)).sub(cos(h.mul(2).sub(n))).div(4);
          vis.addAssign(lenNp.mul(arc(h0).add(arc(h1))));
        }
        // (left unclamped until the blur: a slice of a tilted surface can sum past 1, the average is 1)
        const v = mix(vis.div(SLICES), float(1), smoothstep(FADE[0], FADE[1], dist));
        out.assign(vec2(v, Z));
      });
      return vec4(out, 0, 1);
    })();
  }

  /** the blur: every rotation of the tile once, receivers only, across no depth edge — visibility (r), depth (g) */
  private blurNode(): TslNode {
    return Fn(() => {
      const q = ivec2(screenCoordinate.xy);
      const c = this.rawNode.load(q);
      const Z0 = c.y.toConst();
      const out = vec2(1, 0).toVar();
      If(Z0.greaterThan(0), () => {
        const sum = float(0).toVar();
        const wsum = float(0).toVar();
        const tol = float(1).div(Z0.mul(BLUR_DEPTH)).toConst();
        for (let oy = -2; oy < 2; oy++) {
          for (let ox = -2; ox < 2; ox++) {
            const t = this.rawNode.load(q.add(ivec2(ox, oy)));
            const w = select(t.y.greaterThan(0), clamp(float(1).sub(abs(t.y.sub(Z0)).mul(tol)), 0, 1), float(0));
            sum.addAssign(t.x.mul(w));
            wsum.addAssign(w);
          }
        }
        out.assign(vec2(clamp(sum.div(max(wsum, 1e-4)), 0, 1), Z0));
      });
      return vec4(out, 0, 1);
    })();
  }

  /**
   * The colour pass's context: the renderer's own (`base`) plus `getAO`, which hands each receiving material the
   * blurred occlusion at its own pixel, lifted by the material's albedo (multi-bounce) and scaled by the strength.
   * The pixel's place in the pre-pass is (face px + band) / scale; the four texels round it are weighed bilinearly
   * and by whether each saw this fragment's surface (at full resolution the place is a texel centre: one texel, the
   * one rasterised from the same pixel; nearer than the pre-pass's near plane, none — no occlusion).
   */
  contextFor(base: TslNode): TslNode {
    if (this.context && this.context.base === base) return this.context.node;
    const aoAt = this.aoNode;
    const band = this.uBand;
    const invScale = this.uInvScale;
    const strength = this.uStrength;
    const node = context({
      ...base.getFlowContextData(),
      getAO: (input: TslNode, builder: TslNode) => {
        if (!receivesDomeAo(builder.material)) return input;
        const z = positionView.z.negate();
        const tol = z.mul(SAME_SURFACE[0]).add(SAME_SURFACE[1]);
        const p = screenCoordinate.xy.add(band).mul(invScale).sub(0.5);
        const p0 = p.floor();
        const f = p.sub(p0);
        const q = ivec2(p0);
        const sum = float(0).toVar();
        const wsum = float(0).toVar();
        for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const t = aoAt.load(q.add(ivec2(ox, oy)));
          const bilinear = (ox ? f.x : f.x.oneMinus()).mul(oy ? f.y : f.y.oneMinus());
          const w = select(abs(z.sub(t.y)).lessThan(tol), bilinear, float(0));
          sum.addAssign(t.x.mul(w));
          wsum.addAssign(w);
        }
        const v = select(wsum.greaterThan(1e-3), sum.div(max(wsum, 1e-3)), float(1));
        // Jimenez et al. 2016 §5: interreflection between surfaces of albedo ρ gives back part of what is occluded
        const rho = clamp(luminance(diffuseColor.rgb), 0, 1);
        const ka = rho.mul(2.0404).sub(0.3324);
        const kb = rho.mul(-4.7951).add(0.6417);
        const kc = rho.mul(2.7552).add(0.6903);
        const lifted = max(v, v.mul(ka).add(kb).mul(v).add(kc).mul(v));
        const ao = mix(float(1), lifted, strength);
        return input !== null && input !== undefined ? input.mul(ao) : ao;
      },
    });
    this.context = { base, node };
    return node;
  }

  /** size the targets for faces `size` px wide (2D targets resize correctly, unlike the cube's: domeCapture.ts) */
  setFaceSize(size: number): void {
    if (this.size === size) return;
    this.size = size;
    this.scale = size > FULL_RES_MAX ? 2 : 1;
    this.band = domeAoBand(size, this.scale);
    // (face sizes are whole multiples of 16: faceSizeFor)
    this.wide = Math.ceil((size + 2 * this.band) / this.scale);
    this.prepass.setSize(this.wide, this.wide);
    this.raw.setSize(this.wide, this.wide);
    this.ao.setSize(this.wide, this.wide);
    this.uWide.value = this.wide;
    this.uInvHalf.value = 2 / this.wide;
    this.uBand.value = this.band;
    this.uInvScale.value = 1 / this.scale;
  }

  setLook(look: DomeAoLook): void {
    this.uStrength.value = Math.min(1, Math.max(0, look.strength));
    this.uRadius.value = Math.max(0.01, look.radius);
  }

  /**
   * One face's occlusion, ready for its colour pass: the pre-pass from face camera `cam` widened by the band (the
   * same camera object, so its shadow maps are rendered here once for the frame and not again for the colour pass:
   * three renders a light's shadow once per camera per node frame), the march, the blur — each scissored to the
   * face's drawn rectangle `rect` (face px) and the band round it. Leaves the renderer's target and MRT as found.
   */
  draw(renderer: THREE.WebGPURenderer, scene: THREE.Scene, cam: THREE.PerspectiveCamera, rect: THREE.Vector4): void {
    const k = this.scale;
    // the band and the face's rectangle in pre-pass texels (the rectangle grown to whole texels)
    const B = this.band / k;
    const W = this.wide;
    const x0 = Math.floor(rect.x / k);
    const y0 = Math.floor(rect.y / k);
    const w = Math.ceil((rect.x + rect.z) / k) - x0;
    const h = Math.ceil((rect.y + rect.w) / k) - y0;
    const bound = renderer.getRenderTarget();
    const boundFace = renderer.getActiveCubeFace();
    const boundMip = renderer.getActiveMipmapLevel();
    const boundMrt = renderer.getMRT();
    this.fov.fov = cam.fov;
    this.fov.near = cam.near;
    try {
      // (the face camera's fov is −90°: three's cube cameras flip both axes; the widened one keeps the sign)
      cam.fov = Math.sign(cam.fov) * ((2 * Math.atan((W * k) / this.size) * 180) / Math.PI);
      cam.near = Math.max(cam.near, NEAR);
      cam.updateProjectionMatrix();
      const e = cam.projectionMatrix.elements;
      this.uSx.value = 1 / e[0];
      this.uSy.value = 1 / e[5];
      this.uC.value = e[10];
      this.uD.value = e[14];
      // the pre-pass: the face's rectangle and the band round it
      this.prepass.scissor.set(x0, y0, w + 2 * B, h + 2 * B);
      renderer.setRenderTarget(this.prepass);
      renderer.setMRT(this.prepassMrt);
      renderer.render(scene, cam);
      renderer.setMRT(boundMrt);
      // the blur over the rectangle and the texel round it the colour pass's lookup reaches; the march over that
      // and the blur's own reach (−2..+1) round it
      this.raw.scissor.set(x0 + B - 3, y0 + B - 3, w + 6, h + 6);
      renderer.setRenderTarget(this.raw);
      this.rawQuad.render(renderer);
      this.ao.scissor.set(x0 + B - 1, y0 + B - 1, w + 2, h + 2);
      renderer.setRenderTarget(this.ao);
      this.blurQuad.render(renderer);
    } finally {
      renderer.setMRT(boundMrt);
      cam.fov = this.fov.fov;
      cam.near = this.fov.near;
      cam.updateProjectionMatrix();
      this.prepass.scissor.set(0, 0, W, W);
      this.raw.scissor.set(0, 0, W, W);
      this.ao.scissor.set(0, 0, W, W);
      renderer.setRenderTarget(bound, boundFace, boundMip);
    }
  }

  dispose(): void {
    this.prepass.dispose();
    this.raw.dispose();
    this.ao.dispose();
    for (const m of this.materials) m.dispose();
  }
}
