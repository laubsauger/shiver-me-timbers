/**
 * The water's mirror for the dome: what floats on the sea (the raft, the debris, the rocks and the island)
 * reflected in it (v8 notes: "reflections seem missing… things look detached").
 *
 * The game's planar mirror pass (src/reflection) is screen-space, built for one camera: a second render per
 * camera, looked up at the fragment's screen position. The dome draws six cube faces a frame, and through them
 * its pass never reached the water (docs/drift/engine-findings.md). This is the dome's own form of the same
 * mirror: ONE cube capture from the eye mirrored under the water (x, −y, z), of everything but the sea and the
 * sky, cleared transparent. For flat water the scene a ray reflected up from the surface meets is exactly what
 * that capture sees along the reflected direction; waves bend the lookup with the facet's own normal, and blur
 * it with its tilt and the distance, and by the spread of the reflected rays across the pixel (`shade`).
 *
 * CLIPPED AT THE WATERLINE by an OBLIQUE NEAR PLANE (`clipToWater`): each face's near plane is the water, so
 * nothing under it is drawn — not the floating things' submerged halves (they had reflected as dark undersides
 * under every plank and crate), not the seabed. A ClippingGroup did the same and cost the sea 18× its frame
 * time (it re-plans its planes per camera and rebuilt every object below it on every face, engine-findings.md);
 * a projection matrix costs nothing per object. The face that looks straight down sees only what is under the
 * water, and is not drawn.
 * Where the capture saw nothing (alpha), the ocean's analytic sky stays — as the game's mirror composites.
 *
 * It plugs into the ocean through the same hook (ReflectionShadeInput → colour).
 */
import * as THREE from 'three/webgpu';
import { cubeTexture, dFdx, dFdy, dot, float, log2, mix, normalize, reflect, smoothstep, uniform, vec2, vec3 } from 'three/tsl';
import type { PlanarReflection } from '../../reflection';
import type { ReflectionShadeInput } from '../../reflection/reflectionShading';

const WATER = new THREE.Vector4(0, 1, 0, 0);
const _plane = new THREE.Vector4();
const _corner = new THREE.Vector4();
const _far = new THREE.Vector4();
const _toCamera = new THREE.Matrix4();

/**
 * Make face camera `cam`'s near plane the water (y = 0, keeping y > 0): Lengyel's oblique near plane, for
 * WebGPU's [0, 1] depth — the projection's z row becomes the plane, scaled so the far plane still passes
 * through the frustum's far corner on the kept side, so the new frustum holds all of the old one above the
 * water. The camera must be under the water. Returns false when the face sees nothing above it.
 */
export function clipToWater(cam: THREE.PerspectiveCamera): boolean {
  cam.updateProjectionMatrix();
  // the plane in camera space: a point's camera coordinates c map to world M·c, so P·(M·c) = (Mᵀ·P)·c
  _plane.copy(WATER).applyMatrix4(_toCamera.copy(cam.matrixWorld).transpose());
  let best = 0;
  for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    _corner.set(x, y, 1, 1).applyMatrix4(cam.projectionMatrixInverse);
    _corner.divideScalar(_corner.w);
    const above = _plane.dot(_corner);
    if (above > best) {
      best = above;
      _far.copy(_corner);
    }
  }
  if (best <= 0) return false;
  const e = cam.projectionMatrix.elements;
  const w = e[3] * _far.x + e[7] * _far.y + e[11] * _far.z + e[15] * _far.w;
  const k = w / best;
  e[2] = _plane.x * k;
  e[6] = _plane.y * k;
  e[10] = _plane.z * k;
  e[14] = _plane.w * k;
  cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
  return true;
}

/** m: the mirror holds full strength within this distance of the eye, and is gone past the second */
const FADE: [number, number] = [400, 2500];
/** mip levels of blur per unit of facet tilt (sin), and at the far fade */
const BLUR_TILT = 3;
const BLUR_FAR = 3;

/**
 * THE FIGURES' REFLECTIONS MEET THEIR FEET (the 2026-11-02 note on the beach walkers, 680–720 s: "the reflections of
 * the people on the wet sand film are detached from them in a weird way, offset too far").
 *
 * The capture is ONE cube from the eye mirrored under the sea's 0, looked up by direction. That is exact for a flat
 * mirror at y = 0 and for what is far off; it is wrong for something a few metres from the water that mirrors it, in
 * two ways. (1) The water is not at 0: the swash and the wet sand stand 0–0.3 m over it, and a mirror at height h
 * puts the image 2h higher than one at 0 — under a figure on the sand its reflection began 2h under its soles. (2) A
 * tilted facet turns the reflected ray by 2θ, and a direction lookup turns the whole image by 2θ as seen from the
 * eye, where a real facet moves the image of a thing s m beyond it by only 2θ·s: under a figure on rippled water
 * (the swash's slope is held to 0.15, its ripples on top) the lookup put the figure's copy metres off its feet, at
 * 20 m from the eye 2·0.15·20 ≈ 6 m. Both are a lookup that assumes the reflected thing at infinity.
 *
 * So for the few figures near the water (`setFigures`: their feet and height) the lookup is PARALLAX-CORRECTED: the
 * reflected ray from the shaded point p is tested against each figure (an upright cylinder of FIGURE_R m); where it
 * meets one t m along, the capture is read in the direction from the mirrored eye to p + t·r — exactly the point the
 * ray meets, whatever the water's height and however its facet tilts. Where the ray misses them all but the plain
 * direction lookup would land on one (the old displaced copy), the flat water's direction is read instead: the scene
 * behind, as unrippled water mirrors it there. Everything else (the palms, the raft, the islands, at sea) is read as
 * before.
 *
 * A thin film and wet sand do not hold a figure's whole image as glass does: the image blurs the further up the
 * figure the ray climbs (each facet's tilt moves it by 2θ·t: the blur below grows with t, not with the eye's
 * distance) and fades toward the head (FIGURE_FADE), so it is short and soft under each figure, broken by the ripples.
 */
/** m: a figure's radius for the reflected rays (its body, its arms and a stoop's reach), and the soft edge past it */
const FIGURE_R: [number, number] = [0.42, 0.7];
/** the share of a figure's image the thin water keeps at its head (1 at its feet): m up the figure from the full to it */
const FIGURE_FADE = { keep: 0.45, from: 0.25, to: 1.7 };
/** at most this many figures are corrected (props.ts: the three wanderers) */
export const MIRROR_FIGURES = 3;

export interface CubeMirror {
  /** for OceanSurface's `reflection` (only its shading hook is read) */
  readonly reflection: PlanarReflection;
  /** the figures standing near the water (x, the ground's y, z, height m; height 0 for none), up to MIRROR_FIGURES:
   * their reflections are read where the rays meet them (above) */
  setFigures(figures: ReadonlyArray<THREE.Vector4>): void;
  /** capture the scene from the eye mirrored under the water, with `hide` (the sea, the sky) left out */
  update(renderer: THREE.WebGPURenderer, scene: THREE.Scene, eye: THREE.Vector3, hide: THREE.Object3D[]): void;
}

export function createCubeMirror(size: number, far: number): CubeMirror {
  const target = new THREE.CubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  const camera = new THREE.CubeCamera(0.05, far, target);
  const active = uniform(0);
  const clear = new THREE.Color();
  // where the capture was taken from (the eye mirrored under 0), and the figures (setFigures)
  const mirroredEye = uniform(new THREE.Vector3());
  const figures = Array.from({ length: MIRROR_FIGURES }, () => uniform(new THREE.Vector4(0, 0, 0, 0)));
  type V3 = THREE.Node<'vec3'>;
  type F = THREE.Node<'float'>;
  /** the ray from `o` along `d` against figure `c` (x, y, z, height): how surely it meets it (0..1), the m along the
   * ray where it passes nearest its axis, and how far up the figure it is there (m over its feet) */
  const meet = (o: V3, d: V3, c: (typeof figures)[number]): { hit: F; t: F; up: F } => {
    const dh = vec2(d.x, d.z);
    const rel = vec2(c.x.sub(o.x), c.z.sub(o.z));
    const t = dot(rel, dh).div(dot(dh, dh).max(1e-6)).max(0.02) as F;
    const miss = rel.sub(dh.mul(t)).length();
    const up = o.y.add(d.y.mul(t)).sub(c.y) as F;
    const hit = smoothstep(FIGURE_R[1], FIGURE_R[0], miss)
      .mul(smoothstep(c.w.add(0.25), c.w, up))
      .mul(smoothstep(-0.3, 0, up))
      .mul(c.w.greaterThan(0).select(1, 0)) as F;
    return { hit, t, up };
  };
  /** the nearest figure the ray meets (the surest; ties to the nearer) */
  const nearest = (o: V3, d: V3): { hit: F; t: F; up: F } => {
    let best = meet(o, d, figures[0]);
    for (const c of figures.slice(1)) {
      const m = meet(o, d, c);
      const take = m.hit.greaterThan(best.hit.add(0.02)).or(m.hit.greaterThan(0.5).and(best.hit.greaterThan(0.5)).and(m.t.lessThan(best.t)));
      best = { hit: take.select(m.hit, best.hit) as F, t: take.select(m.t, best.t) as F, up: take.select(m.up, best.up) as F };
    }
    return best;
  };
  // three sizes a target's mip chain when it first creates the GPU texture, and CubeCamera switches
  // `generateMipmaps` off for its first five faces: created there, the mirror had ONE level and the blur below
  // read nothing (domeCapture.ts drawFaces). Created up front instead, on the first update.
  let initialised = false;

  const shade = (input: ReflectionShadeInput): THREE.Node<'vec3'> => {
    const r = reflect(input.viewDirection.negate(), input.normalWorld) as unknown as V3;
    // (the figures' parallax, above: the true ray's figure, the flat water's, and the plain lookup's)
    const p = input.surfacePosition as unknown as V3;
    const v = input.viewDirection as unknown as V3;
    const flat = vec3(v.x.negate(), v.y, v.z.negate()) as V3;
    const onRay = nearest(p, r);
    const onFlat = nearest(p, flat);
    const ghost = nearest(mirroredEye as unknown as V3, r).hit;
    const toward = (d: V3, t: F): V3 => normalize(p.add(d.mul(t)).sub(mirroredEye)) as V3;
    const flatDir = normalize(mix(flat, toward(flat, onFlat.t), onFlat.hit)) as V3;
    const missDir = normalize(mix(r, flatDir, ghost)) as V3;
    const q = normalize(mix(missDir, toward(r, onRay.t), onRay.hit)) as V3;
    // (a figure's image blurs by the facet's tilt over the m the ray climbs to it, not over the eye's distance)
    const near = onRay.t.div(onRay.t.add(input.camDist as F).max(1e-3));
    const tiltBlur = mix(float(1), near, onRay.hit);
    const fade = mix(float(1), float(1).sub(smoothstep(FIGURE_FADE.from, FIGURE_FADE.to, onRay.up).mul(1 - FIGURE_FADE.keep)), onRay.hit);
    const tilt = float(1).sub(input.normalWorld.y.clamp(0, 1).mul(input.normalWorld.y.clamp(0, 1))).max(0).sqrt();
    const far = smoothstep(FADE[0], FADE[1], input.camDist);
    // THE PIXEL'S OWN SPREAD OF REFLECTED RAYS (the 2026-10-29 AA review: "water seen past the raft deck is blocky",
    // before and after MSAA). The level was the facet's tilt and the distance alone, so where the ripples turn the
    // reflected ray faster than a mirror texel per pixel, each pixel took ONE texel of the beach, the forest or the
    // raft from wherever its facet pointed: the sand and the trees came back as hard-edged sand-coloured blocks and
    // flecks in the lagoon behind the raft (a 16:9 still at 545 s, fov 30, from the show's eye — unchanged with the
    // raft hidden, its aeration off or the refraction off; a 512 px face texel is 0.18°, 7–8 pixels of that view).
    // So the level is also the one the hardware would take from the ray's own derivatives — the spread across the
    // pixel in mirror texels (a face spends size/2 texels a radian at its centre) — and the larger of the two wins:
    // a choppy patch averages what its facets see, calm water stays as sharp as the capture.
    const spread = dFdx(q).length().max(dFdy(q).length()).mul(size / 2).max(1e-6);
    const s = cubeTexture(target.texture, q).level(log2(spread).max(tilt.mul(BLUR_TILT).mul(tiltBlur).add(far.mul(BLUR_FAR))).clamp(0, 6));
    const coverage = s.a.clamp(0, 1).mul(fade);
    // premultiplied: the transparent clear blended in under the geometry
    const seen = s.rgb.div(coverage.max(1e-3));
    return mix(input.skyColor, seen, coverage.mul(active).mul(far.oneMinus())) as THREE.Node<'vec3'>;
  };

  return {
    reflection: { shade } as unknown as PlanarReflection,
    setFigures(list) {
      figures.forEach((u, i) => (list[i] ? u.value.copy(list[i]) : u.value.set(0, 0, 0, 0)));
    },
    update(renderer, scene, eye, hide) {
      camera.position.set(eye.x, -eye.y, eye.z);
      camera.updateMatrixWorld();
      mirroredEye.value.copy(camera.position);
      const was = hide.map((o) => o.visible);
      hide.forEach((o) => (o.visible = false));
      const bg = scene.background;
      const bgNode = scene.backgroundNode;
      const autoClear = renderer.autoClear;
      renderer.getClearColor(clear);
      const alpha = renderer.getClearAlpha();
      scene.background = null;
      scene.backgroundNode = null;
      renderer.setClearColor(0x000000, 0);
      renderer.autoClear = true;
      const bound = renderer.getRenderTarget();
      const boundFace = renderer.getActiveCubeFace();
      const boundMip = renderer.getActiveMipmapLevel();
      const mips = target.texture.generateMipmaps;
      try {
        if (!initialised) {
          renderer.initRenderTarget(target);
          initialised = true;
        }
        if (camera.coordinateSystem !== renderer.coordinateSystem) {
          camera.coordinateSystem = renderer.coordinateSystem;
          camera.updateCoordinateSystem();
        }
        // CubeCamera.update with each face clipped to the water; the mip chain is built after the last face
        const faces = camera.children as THREE.PerspectiveCamera[];
        faces.forEach((cam, face) => {
          const seen = clipToWater(cam);
          target.texture.generateMipmaps = mips && face === faces.length - 1;
          renderer.setRenderTarget(target, face, 0);
          if (seen) renderer.render(scene, cam);
          else renderer.clear();
        });
      } finally {
        target.texture.generateMipmaps = mips;
        renderer.setRenderTarget(bound, boundFace, boundMip);
        hide.forEach((o, i) => (o.visible = was[i]));
        scene.background = bg;
        scene.backgroundNode = bgNode;
        renderer.autoClear = autoClear;
        renderer.setClearColor(clear, alpha);
      }
      active.value = eye.y > 0.05 ? 1 : 0;
    },
  };
}
