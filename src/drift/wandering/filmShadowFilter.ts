/**
 * THE FILM'S SUN-SHADOW FILTER (the 2026-10-29 reviews: shadows in every moving shot "horrendously flickery …
 * jumping left and right", on the raft and through the forest alike).
 *
 * three r186's PCF filter (nodes/lighting/ShadowFilterNode.js PCFShadowFilter) takes FIVE taps on a Vogel disk and
 * turns the disk per pixel by interleaved-gradient noise on the SCREEN coordinate. Five taps can only make six grey
 * levels, so every soft edge is dithered; and the dither is pinned to the screen (to each cube face's pixels) while
 * the edge moves through it with the raft, the swell and the eye — the edge's grain boils from frame to frame. It is
 * a pattern made for a temporal filter (TAA) to average away, and a film frame has none.
 *
 * This is the same idea without the noise: a fixed 4 × 4 grid of hardware-compared taps (each tap is itself a
 * bilinear 2 × 2 comparison: the depth texture is linear-filtered with a compare sampler whenever the PCF type is
 * on, ShadowNode.setupShadowFilter), spread over ± `radius` texels with tent weights. Sixteen bilinear taps give a
 * smooth edge that moves continuously with what casts it, the same on every face, in every frame. Cost: 16 compare
 * samples against 5, on the materials that receive the Sun's shadow.
 *
 * THE SUN IS A DISC, NOT A POINT (the 2026-10-29 review: a "dark rectangular shadow on the beach" at 568 s, the
 * raft's upper sail 7 m up throwing its outline 30 m across the shallows at the morning's 12° Sun, cut as sharply as
 * a crate's on the deck). Seen from a point in a shadow's edge, the Sun's 0.53° disc is partly hidden: the penumbra
 * is (distance to the caster along the light) × 2·tan(0.265°) wide — 5 cm under a rope 5 m up the light, 28 cm on
 * the sand under the sail, 0.6 m under a palm crown 65 m away. Contact shadows stay sharp, far ones go soft: what
 * makes a shadow read as cast by the thing it belongs to. So, PCSS-like, every receiver first looks for what lies
 * between it and the Sun, and filters at the width that says:
 *
 *   - THE BLOCKER SEARCH: point reads of the map's depth (no compare, no sampler) at the receiver and on RINGS
 *     around it, fixed in the map's texels — no per-pixel rotation, for the reason above. A depth nearer the Sun than
 *     the receiver counts only if it is inside (CONE ×) its own cone toward the Sun's disc: a caster 30 m up the light
 *     can shade a receiver up to 14 cm to its side, one 5 m up only 2.3 cm. Without that test the receiver's own
 *     ground counts: at a 12° Sun flat sand a few cm toward the light in the map is ~5× as many cm nearer it, and
 *     every receiver on the beach found itself a blocker. The distance is their HARMONIC mean: where a far caster
 *     and a near one are both in reach (a crate's foot by the sail's shadow on the deck) the near one wins and the
 *     contact shadow stays crisp; a plain mean sits between and blurs both.
 *   - THE FILTER: the 4 × 4 contact grid at `radius` as before (unchanged where nothing is far: the penumbra under
 *     2.5 texels is the contact filter's own), handing over to a WIDE × WIDE grid of point compares at the penumbra's
 *     half-width (in texels from the light camera's ortho extent, never wider than PENUMBRA_MAX) once that is twice
 *     the contact radius. The wide grid only where a far caster is in reach: point reads may run under a per-pixel
 *     branch, the compare sampler's derivative-taking reads may not (WGSL uniformity), which is why the contact grid
 *     runs everywhere and the wide one is loads.
 *
 * Measured at 568 s (the sail's shadow on the sand 45 m from the eye, a runtime A/B in one boot): its edge 14 cm →
 * 31 cm wide, the physical 28 cm; the deck's contact shadows (crates, rails, ropes) and the beach dressing's pebbles
 * at 604 s unchanged, nowhere more than 4 levels in 8 bits. Ashore nothing within 12 m of its caster changes at all:
 * its true penumbra is narrower than the contact filter's 2.5 texels (5.5 cm) already.
 *
 * Cost per receiving fragment: 16 compare samples (36 depth loads since the receiver's plane, below) + 17 depth loads for the search, + 36 loads where a
 * caster farther up the light than the contact radius resolves (6 m at sea, 12 m ashore: 2.5 texels / tan 0.265°)
 * shades it. Every frame a pure function of the map: no noise, no history.
 *
 * THE RECEIVER'S OWN PLANE (the 2026-11-01 review: "the stern tiller shadow is too far away"). A tap off to the side
 * of the receiver reads the map where the receiver's own surface is nearer to or farther from the Sun than the
 * receiver: on level deck under the morning's 12° Sun, 10.5 cm per 2.2 cm texel. Compared against the receiver's one
 * depth, the taps toward the Sun found the receiver's own surface and shadowed it (the 2026-10-29 acne), and the cure
 * was a constant bias as big as that drop (sea.ts: 15.8 cm along the light + 3.3 cm along the normal at 568 s) —
 * which also let the first 15–30 cm of every contact shadow go lit, the stern block's and the tiller's among them.
 * So every texel is now compared against the receiver's PLANE at that texel: the plane through the receiver
 * square to the mesh's own geometric normal, turned into the light camera's frame (exact on a flat face; on a
 * curved one off by the facets' bend, which the constant bias covers with the map's quantisation: sea.ts). The
 * contact grid is therefore no longer 16 hardware-compared bilinear taps (a bilinear compare uses one reference for
 * its 2 × 2 texels, up to a texel and a half apart: the very error the plane removes) but the texels themselves, a
 * 6 × 6 window of point reads each compared against its own plane depth, tent-weighted by its distance from the
 * receiver: as smooth as before (the weights move continuously with the receiver), the same width (±3 texels).
 * (Tried first: the plane from the screen derivatives of the shadow coordinate, exact on every triangle — but a
 * 2 × 2 pixel quad straddling two triangles or a silhouette gets neither's plane, and on the cabin's woven walls and
 * the low-poly crew those quads came out as a stipple of lit and dark pixels through every shadow; dropping such
 * quads back to the old constant bias lit them, 26 cm toward the Sun, inside a man's shadow on the wall behind him.)
 */
import { Fn, If, float, ivec2, mix, normalWorldGeometry, reference, renderGroup, select, smoothstep, step, textureLoad, vec2, vec4 } from 'three/tsl';
import { SUN_ANG } from '../getTheDrift/atmosphere';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node union (ShadowNode's filter contract)
type TslNode = any;

/** texels: the contact filter's tent half-width about the receiver (the texel window is twice this a side) */
const CONTACT_R = 3;
/** m of depth along the light per m across the map: the steepest receiver plane taken as it is (level ground under a
 * 1° Sun is 57); a surface within ~1° of edge-on to the Sun, which N·L leaves unlit anyway, is held at this */
const SLOPE_MAX = 60;
/** the Sun's angular radius (rad: the disc the sky draws, atmosphere.ts) as the tangent a penumbra grows by */
const SUN_TAN = Math.tan(SUN_ANG);
/** m: the search's rings about the receiver, four taps each, every other one turned 45° (eight bearings between two
 * rings). A caster's edge x to the side is found by a ring between ~1.41 x and CONE × its cone: with the rings a
 * factor 2 apart, always over the inner ~70% of a penumbra and mostly to its edge; where it is missed the filter falls
 * back to the contact width, on light already ~90% lit */
const RINGS = [0.05, 0.1, 0.2, 0.4];
/** how many times its own cone's radius off to the side a blocker still counts (the rings are a factor 2 apart) */
const CONE = 2;
/** m along the light: a depth nearer the Sun than the receiver by less than this is the receiver itself (the film's
 * depth bias, sea.ts, is ~1–20 cm with the Sun's elevation, and already moves the receiver toward the light by it) */
const SELF = 0.01;
/** m: the widest penumbra's half-width (a caster ~65 m up the light): the search reaches no further, and the wide
 * grid's 6 taps a side are 12 cm apart there */
const PENUMBRA_MAX = 0.3;
/** the wide grid's taps on each axis */
const WIDE = 6;

interface FilmShadow {
  mapSize: { x: number };
  radius: number;
  camera: object;
}

export const filmShadowFilter = Fn(({ depthTexture, shadowCoord, shadow, depthLayer }: { depthTexture: TslNode; shadowCoord: TslNode; shadow: FilmShadow; depthLayer?: TslNode }) => {
  // (held in vars up here: an expression first built inside the wide grid's branch is declared there, and read
  // outside it from a variable out of scope — the nightSky.ts trap)
  const z = float(shadowCoord.z).toVar();
  // (the map size and the contact radius are fixed for the film's light while a frame renders: read as constants at
  // build)
  const size = shadow.mapSize.x;
  const rMin = Math.max(shadow.radius, 1);

  // the light camera's scale, live (its extent is per world, sea.ts SHADOW_EXTENT): m per texel, m per unit of depth
  const cam = (name: string): TslNode => (reference(name, 'float', shadow.camera) as TslNode).setGroup(renderGroup);
  const texelM = cam('right').sub(cam('left')).div(size).toVar();
  const depthM = cam('far').sub(cam('near')).toVar();
  const at = shadowCoord.xy.mul(size).toVar();
  /** the map's depth `o` texels from the receiver (a point read: no compare, no filtering) */
  const load = (o: TslNode): TslNode => {
    let d = textureLoad(depthTexture, ivec2(at.add(o).floor().clamp(0, size - 1)));
    if (depthTexture.isArrayTexture) d = d.depth(depthLayer);
    return d;
  };

  // THE RECEIVER'S PLANE, from the mesh's own (interpolated, geometric: no normal map) normal turned into the light
  // camera's frame: n·dp = 0 there gives the depth's slope across the map, dd = (nx·W du − ny·H dv) / (nz·D) per uv
  // (W, H the camera's extent, D its depth range; v runs down the map, ShadowNode's flip), per texel / size. The
  // same plane whichever way the normal faces. Steeper than SLOPE_MAX (a surface the Sun all but grazes, N·L ≈ 0)
  // it is held at that.
  const view = (reference('matrixWorldInverse', 'mat4', shadow.camera) as TslNode).setGroup(renderGroup);
  const n = view.mul(vec4(normalWorldGeometry, 0)).xyz.toVar();
  const nz = select(n.z.lessThan(0), float(-1), float(1)).mul(n.z.abs().max(1e-4));
  const plane = vec2(n.x.mul(cam('right').sub(cam('left'))), n.y.negate().mul(cam('top').sub(cam('bottom')))).div(nz.mul(depthM)).div(size).toVar();
  // (as m along the light per m across, against SLOPE_MAX)
  const steep = plane.length().mul(depthM).div(texelM).toVar();
  const slope = plane.mul(float(SLOPE_MAX).div(steep.max(SLOPE_MAX))).toVar();
  /** the receiver's own depth `o` texels away, on its plane */
  const zAt = (o: TslNode): TslNode => z.add(slope.dot(o));

  // THE CONTACT FILTER: every texel within CONTACT_R of the receiver, compared against the plane's depth at it (lit
  // where the receiver is no farther from the light than what the map holds: the compare sampler's less-equal)
  const p = at.sub(0.5).toVar(); // texel-centre coordinates: texel i's centre at i
  const base = p.floor().sub(CONTACT_R - 1).toVar();
  let sum: TslNode = float(0);
  let wsum: TslNode = float(0);
  for (let j = 0; j < 2 * CONTACT_R; j++) {
    for (let i = 0; i < 2 * CONTACT_R; i++) {
      const d = base.add(vec2(i, j)).sub(p);
      // tent weights: the centre counts most, the edge of the window fades in as the receiver moves
      const w = float(CONTACT_R).sub(d.x.abs()).max(0).mul(float(CONTACT_R).sub(d.y.abs()).max(0));
      sum = sum.add(step(zAt(d), load(d)).mul(w));
      wsum = wsum.add(w);
    }
  }
  const contact = sum.div(wsum.max(1e-6)).toVar();

  // THE BLOCKER SEARCH: how many taps hold a caster within reach, and the sum of their inverse distances (1/m)
  const found = float(0).toVar();
  const inverse = float(0).toVar();
  const tap = (ox: number, oy: number): void => {
    const o = vec2(ox, oy).div(texelM);
    const toSun = zAt(o).sub(load(o)).mul(depthM);
    const counts = step(Math.max(Math.hypot(ox, oy) / (CONE * SUN_TAN), SELF), toSun);
    found.addAssign(counts);
    inverse.addAssign(counts.div(toSun.max(SELF)));
  };
  tap(0, 0);
  RINGS.forEach((r, k) => {
    for (let q = 0; q < 4; q++) {
      const a = ((q * 90 + (k % 2) * 45) * Math.PI) / 180;
      tap(r * Math.cos(a), r * Math.sin(a));
    }
  });
  // the penumbra's half-width, texels: the harmonic mean distance to the casters × tan of the Sun's radius
  const reach = found.div(inverse.max(1e-6)).mul(SUN_TAN).div(texelM).min(float(PENUMBRA_MAX).div(texelM)).max(rMin);
  const radius = select(found.greaterThan(0), reach, float(rMin)).toVar();

  // THE FILTER: the contact grid, handing over to the wide one as the penumbra outgrows it
  const wideness = smoothstep(rMin, 2 * rMin, radius).toVar();
  const wide = float(contact).toVar();
  If(wideness.greaterThan(0), () => {
    const spacing = radius.div((WIDE - 1) / 2);
    let lit: TslNode = float(0);
    let ws = 0;
    for (let j = 0; j < WIDE; j++) {
      for (let i = 0; i < WIDE; i++) {
        const ox = i - (WIDE - 1) / 2;
        const oy = j - (WIDE - 1) / 2;
        const w = (WIDE / 2 + 0.5 - Math.abs(ox)) * (WIDE / 2 + 0.5 - Math.abs(oy));
        // lit where the receiver is no farther from the light than what the map holds (the compare sampler's
        // less-equal, as a point read)
        const o = vec2(ox, oy).mul(spacing);
        lit = lit.add(step(zAt(o), load(o)).mul(w));
        ws += w;
      }
    }
    wide.assign(lit.div(ws));
  });
  return mix(contact, wide, wideness);
});
