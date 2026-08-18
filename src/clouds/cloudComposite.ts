/**
 * Cloud composite (§V11 stage 3): camera-pinned quad ~quadDistance out on the
 * frustum, sampling the blurred cloud texture via screenUV. Colour is
 * reconstructed as sunColor*R + skyColor*G with alpha from B; edges are
 * distorted + eroded by tileable 3D value noise sampled along the view
 * direction and scrolled by time (the "distortion cubemap" role from the Rare
 * talk — a wrap-repeat Data3DTexture stands in for the cubemap, generated
 * once at init from the seed).
 */
import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  float,
  fwidth,
  mix,
  positionWorld,
  screenUV,
  select,
  smoothstep,
  texture,
  texture3D,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { ShaderNodeObject } from 'three/tsl';
import { createRng } from '../state/rng';
import type { CloudParams } from '../params/clouds';

type N = ShaderNodeObject<Node>;

/** the two channels of the packed RT the edge graph reads: B alpha, A depth */
interface PackedTexel {
  readonly a: N;
  readonly b: N;
  readonly r: N;
}

const NOISE_SIZE = 48;
const LATTICE = 8;

/** Tileable low-frequency RGB value noise, deterministic per seed. */
export function createNoiseTexture(seed: number): THREE.Data3DTexture {
  const rng = createRng(seed ^ 0x9e3779b9);
  const lat = new Float32Array(LATTICE * LATTICE * LATTICE * 3);
  for (let i = 0; i < lat.length; i++) lat[i] = rng();

  const latAt = (x: number, y: number, z: number, ch: number): number => {
    const xi = x % LATTICE;
    const yi = y % LATTICE;
    const zi = z % LATTICE;
    return lat[((zi * LATTICE + yi) * LATTICE + xi) * 3 + ch];
  };
  // trilinear-interpolated lattice lookup, wrapping for tileability
  const sample = (fx: number, fy: number, fz: number, ch: number): number => {
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const z0 = Math.floor(fz);
    const tx = fx - x0;
    const ty = fy - y0;
    const tz = fz - z0;
    let v = 0;
    for (let c = 0; c < 8; c++) {
      const cx = c & 1;
      const cy = (c >> 1) & 1;
      const cz = (c >> 2) & 1;
      const wgt =
        (cx ? tx : 1 - tx) * (cy ? ty : 1 - ty) * (cz ? tz : 1 - tz);
      v += wgt * latAt(x0 + cx, y0 + cy, z0 + cz, ch);
    }
    return v;
  };

  const data = new Uint8Array(NOISE_SIZE * NOISE_SIZE * NOISE_SIZE * 4);
  const freq = LATTICE / NOISE_SIZE;
  let o = 0;
  for (let z = 0; z < NOISE_SIZE; z++) {
    for (let y = 0; y < NOISE_SIZE; y++) {
      for (let x = 0; x < NOISE_SIZE; x++) {
        for (let ch = 0; ch < 3; ch++) {
          // two octaves of tileable value noise
          const n =
            sample(x * freq, y * freq, z * freq, ch) * 0.7 +
            sample(x * freq * 2, y * freq * 2, z * freq * 2, ch) * 0.3;
          data[o++] = Math.round(n * 255);
        }
        data[o++] = 255;
      }
    }
  }
  const tex = new THREE.Data3DTexture(data, NOISE_SIZE, NOISE_SIZE, NOISE_SIZE);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * The edge/alpha half of the composite, shared verbatim with the planar
 * reflection's cloud stand-in (src/reflection/cloudMirror.ts). It was
 * duplicated there, which meant every edge tweak had to be made twice or the
 * reflected sky would keep the old silhouette — one graph, two call sites.
 *
 * `viewDir` differs between the two (the mirror flips y), so it is a parameter.
 */
export function createCloudEdge(
  noiseTex: THREE.Data3DTexture,
  viewDir: N,
  p: CloudParams,
  /** LIVE world sun direction, held BY REFERENCE and mutated in place each
   *  frame by the clouds system — same contract as sunColorLive. */
  sunDirLive: THREE.Vector3,
) {
  const uTime = uniform(0);
  const uSunDir = uniform(sunDirLive);
  const uTransGain = uniform(p.transGain);
  const uTransPower = uniform(p.transPower);
  const uTransDepth = uniform(p.transDepth);
  const uDistortScale = uniform(p.distortScale);
  const uDistortStrength = uniform(p.distortStrength);
  const uEdgeErode = uniform(p.edgeErode);
  const uEdgeHiScale = uniform(p.edgeHiScale);
  const uEdgeHiErode = uniform(p.edgeHiErode);
  const uAlphaGain = uniform(p.alphaGain);
  const uAlphaDensity = uniform(p.alphaDensity);
  const uSoftNear = uniform(p.alphaSoftNear);
  const uSoftFar = uniform(p.alphaSoftFar);

  const scroll = vec3(uTime.mul(0.7), uTime.mul(0.43), uTime);
  const loCoord = viewDir.mul(uDistortScale).mul(0.5).add(0.5).add(scroll);
  const noiseLo = texture3D(noiseTex, loCoord, null).rgb;

  // The talk's SECOND noise (low frequency in RG, high in BA, blended by
  // depth). Without it the only edge noise in the whole pipeline has a period
  // of roughly half a cloud, so it slides a silhouette around as one piece and
  // never frays it — the edge stays as polygonal as the mesh under it.
  const hiCoord = viewDir
    .mul(uDistortScale.mul(uEdgeHiScale.max(1)))
    .mul(0.5)
    .add(0.5)
    .add(scroll.mul(1.7));
  const noiseHi = texture3D(noiseTex, hiCoord, null).r;
  // §V48: band-limited against its OWN feature size (one source lattice cell
  // = 1/LATTICE of the [0,1] domain), not against the texture repeat. Fade to
  // zero before a feature goes sub-pixel or the fray becomes edge speckle.
  const feature = float(1 / LATTICE);
  const hiFootprint = fwidth(hiCoord.x).max(fwidth(hiCoord.y)).max(fwidth(hiCoord.z));
  const hiFade = smoothstep(feature.mul(0.3), feature, hiFootprint).oneMinus();

  return {
    uTime,
    uDistortScale,
    uDistortStrength,
    uEdgeErode,
    uEdgeHiScale,
    uEdgeHiErode,
    uAlphaGain,
    uAlphaDensity,
    uSoftNear,
    uSoftFar,
    uSunDir,
    uTransGain,
    uTransPower,
    uTransDepth,
    /** low-frequency uv push, added to whatever UV the caller samples with */
    uvOffset: noiseLo.xy.sub(0.5).mul(uDistortStrength) as N,
    /**
     * Sun TRANSMITTED through a thin margin, in sunColor units, to be ADDED to
     * the sunlight term (transmitted sunlight is sun-coloured, so it needs no
     * fourth channel and no new binding — §V40 budget untouched).
     *
     * Three factors, all bounded in [0,1] and multiplied (§V44):
     *  - forward-scattering lobe: brightest looking THROUGH the cloud at the
     *    sun, falling off as you turn away. This is what stops it reading as
     *    an outline shader — a rim light would glow identically whatever the
     *    sun is doing.
     *  - Beer-Lambert on the coverage sum: exp(-transDepth * cov). Largest
     *    where the cloud is optically THIN, i.e. the feathered margin, and
     *    gone inside an anvil. It reaches a little way INSIDE the silhouette
     *    rather than tracing it, because coverage does.
     *  - complement of the directly-lit face: a face already taking sun head
     *    on is not a thin transmitting margin, and this is also what keeps
     *    sunColor*(R/B + trans) from climbing past the §B.19 summing ceiling.
     */
    transmission(packed: PackedTexel): N {
      const cov = packed.b;
      const sunFace = packed.r.div(cov.max(1e-4)).clamp(0, 1);
      const fwd = viewDir.dot(uSunDir).clamp(0, 1).pow(uTransPower.max(1));
      const through = cov.mul(uTransDepth.max(0)).negate().exp();
      return fwd
        .mul(through)
        .mul(sunFace.oneMinus())
        .mul(uTransGain.max(0)) as N;
    },
    /**
     * Opacity from one sampled texel of the packed RT.
     *
     * The RAMP WIDTH is the softening knob, and it has to be, because coverage
     * (B) is an additive SUM of premultiplied lobe alphas: a dense cluster runs
     * 3-6 in its interior while the alpha curve saturates by ~1.2, so widening
     * the blur kernel moves the ramp's tail and leaves the visible edge exactly
     * where it was. The old fixed 0.55 width also sat BELOW the exponential
     * body's own ~1.2, i.e. the gate was the sharpest thing in the chain.
     * Depth drives it: overhead soft and fuzzy, distant crisp (talk 00:20:57),
     * which is also the only place the packed A channel is read outside the
     * blur — it was computed, packed, blurred and then dropped.
     */
    alpha(packed: PackedTexel): N {
      const coverage = packed.b;
      const depthN = packed.a.div(coverage.max(1e-4)).clamp(0, 1);
      const cov = coverage.mul(uAlphaGain);
      const body = cov.mul(uAlphaDensity.max(0.01).negate()).exp().oneMinus();
      // threshold = whole-cloud wobble + high-frequency fray. Erosion only
      // ever REMOVES coverage, so empty sky stays at alpha 0 (an additive
      // erosion once tinted the entire sky grey).
      const rimT = noiseLo.z
        .mul(uEdgeErode.clamp(0, 1))
        .add(
          noiseHi
            .sub(0.5)
            .mul(uEdgeHiErode.max(0))
            .mul(hiFade)
            .mul(depthN.oneMinus()),
        );
      // CENTRED on rimT, not started at it. `smoothstep(rimT, rimT+soft, cov)`
      // conflates width with threshold: every pixel of extra softness also
      // pushes the 50% point half a pixel further into the cloud, so widening
      // it deletes exactly the low-coverage skirt it was meant to reveal
      // (measured: fluff skirt alpha 0.37 centred vs 0.04 one-sided, at the
      // same width). `body` is still the outer factor, so cov 0 is alpha 0 and
      // open sky can never be tinted even though edge0 goes negative.
      const half = mix(uSoftNear, uSoftFar, depthN).max(1e-3).mul(0.5);
      // smoothstep in functional form per §V23: smoothstep(edge0, edge1, x).
      return body.mul(smoothstep(rimT.sub(half), rimT.add(half), cov)).clamp(0, 1) as N;
    },
    push(cp: CloudParams): void {
      uDistortScale.value = cp.distortScale;
      uDistortStrength.value = cp.distortStrength;
      uEdgeErode.value = cp.edgeErode;
      uEdgeHiScale.value = cp.edgeHiScale;
      uEdgeHiErode.value = cp.edgeHiErode;
      uAlphaGain.value = cp.alphaGain;
      uAlphaDensity.value = cp.alphaDensity;
      uSoftNear.value = cp.alphaSoftNear;
      uSoftFar.value = cp.alphaSoftFar;
      uTransGain.value = cp.transGain;
      uTransPower.value = cp.transPower;
      uTransDepth.value = cp.transDepth;
    },
  };
}

export type CloudEdge = ReturnType<typeof createCloudEdge>;

/** one shaft slot: where it stands, how wide, how high its cloud base is */
export interface ShaftSlot {
  x: number;
  z: number;
  radius: number;
  /** cloud BASE altitude (m) — the shaft hangs from here, never from a
   *  constant. This is the vertical half of the §V.63 coupling. */
  base: number;
  /** 0..1 storm strength of the cluster overhead */
  strength: number;
}

/**
 * RAIN SHAFTS (§V.63) — the visible column of falling water under a storm
 * cloud, from its base down to the sea.
 *
 * WHY THIS IS THE PIECE THAT SELLS IT. Horizontal coupling (cloud over the
 * cell) and vertical coupling (rain from the base) can both be exactly right
 * and the weather will still read as two effects, because at any distance
 * beyond the ~130 m rain particle volume there is simply nothing between the
 * cloud and the water. A shaft is the connective tissue: it is what lets a
 * squall be SEEN from five kilometres off, sailed toward, and sailed out of.
 *
 * WHY IT LIVES IN THE COMPOSITE. The composite is already a full-screen
 * camera-pinned quad, so this adds ZERO draw calls and zero scene traversal —
 * the frame is CPU-bound at 19-24 ms encode against 6-10 ms of GPU, so
 * fragment work is the only currency we have. It is a closed-form ray/cylinder
 * chord, not a march: ~25 ALU per slot, unrolled over `shaftCount` slots.
 *
 * EXPORTED because the planar reflection builds its OWN instance of this graph
 * (src/reflection/cloudMirror.ts). A shaft is analytic world-space geometry —
 * a ray/cylinder chord — so unlike the cloud RT it has data for every
 * direction, and the mirror's straight ray from the mirrored eye IS the
 * unfolded reflected path. Sharing the FUNCTION rather than the composite is
 * the same lesson `createCloudEdge` already learned here: the reflection had a
 * hand-copy of the alpha construction and it drifted the moment either side
 * was tuned.
 *
 * WHY A CHORD AND NOT A BILLBOARD. The opacity of a real shaft is the depth of
 * water you are looking THROUGH, so it is thickest through the middle and
 * vanishes at the rim — which is exactly the chord of a vertical cylinder.
 * That comes out of the geometry for free, and it means the shaft's edge is a
 * silhouette rather than a drawn outline: no `step`, no `smoothstep`, nothing
 * on a spatial coordinate for §V.48 to catch.
 */
export function createShafts(count: number, viewDir: N, p: CloudParams) {
  const n = Math.min(Math.max(Math.floor(count) || 0, 0), 6);
  const uOpacity = uniform(p.shaftOpacity);
  const uDensityLen = uniform(p.shaftDensityLength);
  const uGroundFade = uniform(p.shaftGroundFade);
  const uTint = uniform(p.shaftTint);
  const uEdge = uniform(p.shaftEdge);
  const uTopFade = uniform(p.shaftTopFade);
  // one vec4 per slot: (x, z, radius, base). Strength rides its own float so
  // a slot can be switched off by zeroing ONE number without moving geometry.
  const uGeo = Array.from({ length: n }, () => uniform(new THREE.Vector4(0, 0, 0, 1)));
  const uStrength = Array.from({ length: n }, () => uniform(0));

  const camXZ = vec2(cameraPosition.x, cameraPosition.z);
  const dXZ = viewDir.xz;
  const a = dXZ.dot(dXZ);
  const aSafe = a.max(1e-6); // §V28: zero for a straight-up ray
  /**
   * SIGN-PRESERVING floor on the vertical slope. The naive `vy.max(1e-4)`
   * flips a downward ray to upward at grazing angles, and a `select` on
   * `|vy| < eps` puts a hard branch across the horizon line — a one-pixel band
   * straight through the middle of the image. Flooring the MAGNITUDE and
   * keeping the sign sends the slab parameters to ±1e6 instead, which is the
   * geometrically correct answer for a horizontal ray (either the whole ray is
   * inside the slab or none of it is) and has no edge anywhere.
   */
  const vy = viewDir.y;
  const vySafe = select(vy.greaterThanEqual(0), vy.max(1e-4), vy.min(-1e-4));

  /** 0..1 optical density of one shaft along this view ray */
  const densityOf = (geo: N, strength: N): N => {
    const o = camXZ.sub(vec2(geo.x, geo.y));
    const r = geo.z;
    const b = o.dot(dXZ);
    const c = o.dot(o).sub(r.mul(r));
    const disc = b.mul(b).sub(a.mul(c));
    // outside the cylinder the chord is 0 CONTINUOUSLY (disc → 0 ⇒ sq → 0 ⇒
    // t0 = t1), so clamping the discriminant is the whole silhouette — there
    // is no separate hit test to alias.
    const sq = disc.max(0).sqrt();
    const t0 = b.negate().sub(sq).div(aSafe);
    const t1 = b.negate().add(sq).div(aSafe);

    // the y-slab [0, base]: sea surface to cloud base
    const tA = cameraPosition.y.negate().div(vySafe);
    const tB = geo.w.sub(cameraPosition.y).div(vySafe);
    const lo = t0.max(tA.min(tB)).max(0); // .max(0): nothing behind the lens
    const hi = t1.min(tA.max(tB));
    const chord = hi.sub(lo).max(0);

    // Beer-Lambert on the chord: how much water this ray looks THROUGH.
    const dens = chord.div(uDensityLen.max(1)).negate().exp().oneMinus();

    /**
     * RADIAL PROFILE — and the chord alone cannot supply it. THE BUG THIS
     * FIXES, seen: the shaft rendered as a hard-edged BOX with straight
     * vertical sides. `1 − exp(−chord/L)` is saturating, and a cylinder's
     * chord rises like a square root at the rim, so even a ray clipping the
     * very edge already ran through hundreds of metres and came back ~0.5.
     * The exponential then flattened everything from there inward to ~1 and
     * the silhouette became the cylinder's own outline. "Thickest through the
     * middle" is only soft while you are on the LINEAR part of the curve, and
     * the whole point of a shaft is that it is optically thick.
     *
     * So the shape is carried by the ray's perpendicular distance to the axis
     * instead, which is scale-free and cannot saturate: `perp²` from the same
     * quadratic already solved above (o·o − b²/a), normalized on the radius.
     * The chord keeps its own job — how DEEP the column is at that point.
     */
    const perp2 = o.dot(o).sub(b.mul(b).div(aSafe)).max(0);
    const radial = perp2
      .div(r.mul(r).max(1))
      .oneMinus()
      .clamp(0, 1)
      .pow(uEdge.max(0.05));

    const yMid = cameraPosition.y.add(vy.mul(lo.add(hi).mul(0.5)));
    const hN = yMid.div(geo.w.max(1)).clamp(0, 1);
    // thin toward the water: virga that frays out above the surface reads far
    // better than a column with a sawn-off bottom, and it is what actually
    // happens as the drops evaporate and the shaft spreads
    const ground = mix(float(1).sub(uGroundFade.clamp(0, 1)), float(1), hN);
    /**
     * ...and fade out INTO the cloud base at the top, for the same reason from
     * the other end: the slab has one flat lid, the cloud above it does not,
     * so a shaft at full strength right up to `base` draws a dead straight
     * horizontal line across the sky wherever the cloud happens to be higher.
     * A clamped linear ramp, not a smoothstep — nothing here has an edge for
     * §V.48 to catch, and it must stay that way.
     */
    const top = hN.oneMinus().div(uTopFade.clamp(0.02, 1)).clamp(0, 1);
    return dens
      .mul(radial)
      .mul(ground)
      .mul(top)
      .mul(strength.clamp(0, 1)) as N;
  };

  // SOFT UNION, not a sum (§V44 bounded at source, same construction as the
  // storm field itself): two overlapping shafts saturate toward 1 instead of
  // stacking to an opaque grey wall.
  let miss: N = float(1) as N;
  for (let i = 0; i < n; i++) {
    miss = miss.mul(densityOf(uGeo[i] as unknown as N, uStrength[i] as unknown as N).oneMinus()) as N;
  }
  const alpha = (n === 0 ? float(0) : miss.oneMinus().mul(uOpacity.clamp(0, 1))).clamp(0, 1) as N;

  const scratch = new THREE.Vector4();
  return {
    /** 0..1 coverage of the shaft layer for this fragment */
    alpha,
    /** multiplier on skyColor for the shaft body */
    tint: uTint as unknown as N,
    slots: n,
    push(cp: CloudParams, list: readonly ShaftSlot[]): void {
      uOpacity.value = cp.shaftOpacity;
      uDensityLen.value = cp.shaftDensityLength;
      uGroundFade.value = cp.shaftGroundFade;
      uTint.value = cp.shaftTint;
      uEdge.value = cp.shaftEdge;
      uTopFade.value = cp.shaftTopFade;
      for (let i = 0; i < n; i++) {
        const s = list[i];
        if (!s || !Number.isFinite(s.strength) || s.strength <= 0) {
          uStrength[i].value = 0;
          continue;
        }
        // §V28: these come from a live field and feed divisors in the graph
        scratch.set(
          Number.isFinite(s.x) ? s.x : 0,
          Number.isFinite(s.z) ? s.z : 0,
          Math.max(Number.isFinite(s.radius) ? s.radius : 0, 0) * Math.max(cp.shaftRadius, 0),
          Math.max(Number.isFinite(s.base) ? s.base : 1, 1),
        );
        (uGeo[i].value as THREE.Vector4).copy(scratch);
        uStrength[i].value = Math.min(Math.max(s.strength, 0), 1);
      }
    },
  };
}

export function createCloudComposite(
  blurred: THREE.Texture,
  p: CloudParams,
  seed: number,
  sunDirLive: THREE.Vector3,
) {
  const noiseTex = createNoiseTexture(seed);

  const uSunColor = uniform(new THREE.Color(p.sunColor));
  const uSkyColor = uniform(new THREE.Color(p.skyColor));

  const material = new THREE.MeshBasicNodeMaterial();
  // scrolled view-direction noise lookup ("cubemap" role, see header)
  const viewDir = positionWorld.sub(cameraPosition).normalize();
  const edge = createCloudEdge(noiseTex, viewDir, p, sunDirLive);

  const packed = texture(blurred, screenUV.add(edge.uvOffset));
  const coverage = packed.b;
  // channel/B recovers the weighted average from the premultiplied pack
  const denom = coverage.max(1e-4);
  const cloudColor = uSunColor
    .mul(packed.r.div(denom).add(edge.transmission(packed)))
    .add(uSkyColor.mul(packed.g.div(denom)));
  const cloudAlpha = edge.alpha(packed);

  // §V.63 rain shafts, composited UNDER the cloud in the same fragment: a
  // shaft hangs from a cloud base, so wherever the cloud is opaque the shaft
  // is behind it. Standard over-operator, un-premultiplied because the
  // material blends normally — colour is divided back out by the total alpha.
  const shafts = createShafts(p.shaftCount, viewDir, p);
  const behind = shafts.alpha.mul(cloudAlpha.oneMinus());
  const totalAlpha = cloudAlpha.add(behind).clamp(0, 1);
  material.colorNode = cloudColor
    .mul(cloudAlpha)
    .add(uSkyColor.mul(shafts.tint).mul(behind))
    .div(totalAlpha.max(1e-4));
  material.opacityNode = totalAlpha;
  material.transparent = true;
  material.depthWrite = false;
  material.fog = false;

  const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  quad.frustumCulled = false;
  quad.renderOrder = 1000;

  return {
    quad,
    material,
    uTime: edge.uTime,
    uSunColor,
    uSkyColor,
    edge,
    shafts,
    /** pin the quad to the camera frustum at quadDistance, covering the view */
    fitToCamera(camera: THREE.PerspectiveCamera): void {
      const d = p.quadDistance;
      const height = 2 * d * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
      const margin = 1.1; // oversize so distortion never reveals the border
      quad.scale.set(height * camera.aspect * margin, height * margin, 1);
      camera.getWorldPosition(quad.position);
      camera.getWorldQuaternion(quad.quaternion);
      quad.translateZ(-d);
    },
    dispose(): void {
      quad.geometry.dispose();
      material.dispose();
      noiseTex.dispose();
    },
  };
}

export type CloudComposite = ReturnType<typeof createCloudComposite>;
