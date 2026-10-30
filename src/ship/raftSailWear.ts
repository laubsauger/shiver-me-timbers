/**
 * THE RAFT'S SAILS AS SEWN CANVAS — the game's cloth (sailMaterial.ts: its shape, its billow, its lacing and its
 * backlit glow, all kept) built the way a sail is, and worn the way one is that has crossed an ocean. The user,
 * 2026-10-29: "too regular … so it doesn't look fresh out of an IKEA bag", and then, against two photographs of
 * the Kon-Tiki's sail in the museum: "still very homogeneous, like they're made from exactly one roll of the same
 * stuff, instead of sewn together. The original has more structure — reefing lines or something going through it."
 *
 * What the photographs show, and what is here (through the material's own hook, SailDecal — "a hook, not a fork";
 * the game's own seams are turned off for this sail, `sailSeamDarken` 1 and `sailSeamRidge` 0, and drawn here):
 *
 *   CLOTHS: vertical bolts on the lacing grid (sailClothNodes' panelCoord: the cloth's folds stand on its seams),
 *     most of them one length head to foot and a few pieced once part way down — each its own tone and age, from a
 *     pale newer bolt to a dark ochre old one.
 *   THE SET: the head scalloped between the robands with a fan of creases off each, long creases up from the clews
 *     along the sheets' strain, soft vertical folds where the cloth hangs undrawn.
 *   SEAMS: a flat-felled overlap ~3 cm wide, two rows of stitching, a dark line in the fold, and the cloth PUCKERED
 *     along it where the stitching drew it in; a double thickness, so it shows dark against a backlit sail.
 *   THE HEAD BAND: a doubled tabling under the yard with its roband eyes; the BOLT ROPE sewn all round the edge.
 *   REEF BANDS: two doubled strips across the lower sail, each with a row of reef points — short tie lines hanging
 *     from grommets, in pairs, a cord's thickness proud of the cloth (the "reefing lines" the user saw).
 *   PATINA: a strong, irregular yellow-brown mottle, darker stains, tide lines where it dried, streaks from the
 *     yard, mildew along the foot, a couple of patches.
 *   THE FIGURE (our own: raftSailFace.ts's primitives — not the museum sail's painted face or its marks):
 *     hand-painted, the brush edge wobbling, pigment bled into the weave, brush drag, cracks, flakes, faded.
 *
 * The sails' sun (their lee darkening and backlit glow) is the scene's own light: raftLook.ts keeps
 * sailMaterial.shipSunDirectionOverride on it.
 */
import * as THREE from 'three/webgpu';
import { cross, dFdx, dFdy, float, mix, positionView, select, smoothstep, uniform, vec2, vec3 } from 'three/tsl';
import { createSailClothMaterial, type SailDecal } from './sailMaterial';
import type { ShipMaterialHandle } from './woodMaterial';
import { konTikiFaceApplies, konTikiFaceNodes, konTikiFacePrimitives } from './raftSailFace';
import { createRaftPieceUniforms } from './raftMaterialNodes';
import { coordFilter } from './bandLimit';
import { fbm2, hash2 } from '../terrain/noise';
import { raftMaterialParams } from '../params/raftMaterials';
import { raftParams } from '../params/raft';
import { shipMaterialParams, type ShipMaterialParams } from '../params/ship';
import { SAIL_LACE_MARGIN, SAIL_LACE_SPAN } from './sailShapeProfiles';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL nodes
type N = any;

/** patches a sail carries (each seeded: where, how big, how much newer or older than the cloth) */
const PATCHES = 2;
/** reef bands (v up the sail, 0 the foot) and the spacing of their points (m) */
const REEFS = [0.19, 0.36];
const REEF_POINT = 0.32;
/** m: the head band's depth under the yard, a seam's overlap, a reef band's height */
const HEAD_BAND = 0.16;
const SEAM = 0.03;
const REEF_BAND = 0.07;

const luminance = (c: N): N => c.dot(vec3(0.2126, 0.7152, 0.0722));

/** a feature `size` m across is resolved while a pixel is under half of it: 1 → 0 as it goes sub-pixel */
const resolvedAt = (size: number, px: N): N => float(1).sub(smoothstep(size * 0.25, size * 0.6, px));

/**
 * The cloth's own normal `n` (view space) bent by a height field `h` (m): Mikkelsen's surface gradient
 * (surfaceRelief.ts) on the given normal rather than the geometry's, so it rides the billow the sail's
 * material built.
 */
function bumped(n: N, h: N): N {
  const sx = positionView.dFdx();
  const sy = positionView.dFdy();
  const r1 = cross(sy, n);
  const r2 = cross(n, sx);
  const det = sx.dot(r1);
  const grad = det.sign().mul(r1.mul(dFdx(h)).add(r2.mul(dFdy(h))));
  return det.abs().max(1e-9).mul(n).sub(grad).normalize();
}

export function createWornSail(): ShipMaterialHandle {
  const p = raftMaterialParams;
  const uFill = uniform(new THREE.Color(p.faceFill));
  const uOutline = uniform(new THREE.Color(p.faceOutline));
  const uWidth = uniform(raftParams.mainSailWidth);
  const uDrop = uniform(raftParams.mainSailDrop);
  const uCentreV = uniform(p.faceCentreV);
  const uStroke = uniform(p.faceStroke);
  const uLaces = uniform(shipMaterialParams.sailLacingPoints);
  const piece = createRaftPieceUniforms({ variantOf: (id, width) => (konTikiFaceApplies(id, width, p) ? 1 : 0) });
  const prims = konTikiFacePrimitives(p);
  // what the decal works out, kept for the transmission and the relief laid on after the material is built
  const out: { thickness: N; height: N } = { thickness: float(1), height: float(0) };

  const decal: SailDecal = {
    apply(color: N, cloth: N, clothWeight: N): N {
      const u = cloth.x;
      const v = cloth.y;
      // metres on the cloth (the main course's; the other sails' features are as good at their own scale)
      const q = vec2(u.mul(uWidth), v.mul(uDrop));
      const px = coordFilter(q.x).max(coordFilter(q.y));
      const s = piece.seed.mul(17.3);
      const on = clothWeight;

      // THE CLOTHS: vertical bolts on the lacing grid, most of them one length from the head to the foot, a few
      // pieced once part way down. (Each bolt was joined at two heights at first — 0.27–0.45 and 0.6–0.76 of the drop
      // — and with the two reef bands and the head band that drew a sail-wide GRID of rectangles, which backlit at
      // 370 s read as tiles, not cloth: the 2026-10-30 triage, against the museum's sail, whose cloths run the whole
      // drop. A canvas bolt is tens of metres long; a sail this size is pieced only where a cloth was short.)
      const laces = uLaces.max(2);
      const pc = u.sub(SAIL_LACE_MARGIN).div(SAIL_LACE_SPAN).mul(laces.sub(1));
      const col = pc.floor();
      const boltW = uWidth.mul(SAIL_LACE_SPAN).div(laces.sub(1));
      const hcol = (n: number): N => hash2(vec2(col.add(piece.seed.mul(31)), n));
      // (about two cloths in five, each at its own height between a fifth and three quarters of the drop)
      const pieced = hcol(3).lessThan(0.4);
      const join = hcol(1).mul(0.53).add(0.21);
      const row = select(pieced, smoothstep(join.sub(0.0005), join.add(0.0005), v), float(0));
      const age = hash2(vec2(col.mul(7.1).add(row.mul(3.3)), piece.seed.mul(13)));
      // (a pale newer bolt … an old dark-ochre one; their weave a touch different)
      const boltTone = mix(vec3(1.06, 1.04, 1.0), vec3(0.78, 0.66, 0.46), age.pow(1.3));
      // distances to the seams (m): the bolts' sides, and the join in this bolt if it has one
      const fx = pc.add(0.5).fract().sub(0.5).abs().mul(boltW);
      const fy = select(pieced, v.sub(join).abs().mul(uDrop), float(1e3));
      const seamD = fx.min(fy);
      // along the seam (m), for its stitches and its puckers: along y on a vertical one, x on a horizontal
      const vertical = smoothstep(-0.002, 0.002, fy.sub(fx));
      const along = mix(q.x, q.y, vertical);
      const seamOn = float(1).sub(smoothstep(SEAM * 0.5, SEAM * 0.5 + 0.004, seamD));
      const fold = float(1).sub(smoothstep(0.0, 0.003, seamD)).mul(resolvedAt(0.004, px));
      const stitchRow = float(1).sub(smoothstep(0.0015, 0.003, seamD.sub(SEAM * 0.35).abs()));
      const stitchDash = smoothstep(0.3, 0.5, along.mul(90).fract().sub(0.5).abs()).oneMinus();
      const stitch = stitchRow.mul(stitchDash).mul(resolvedAt(0.004, px));
      const pucker = along.mul(Math.PI * 2 / 0.05).add(fbm2(vec2(along.mul(9), seamD.mul(40)), 2).mul(4)).sin()
        .mul(float(1).sub(smoothstep(0.0, 0.05, seamD))).mul(resolvedAt(0.02, px));

      // THE HEAD BAND under the yard, its roband eyes; the BOLT ROPE all round
      const fromHead = uDrop.sub(q.y);
      const head = float(1).sub(smoothstep(HEAD_BAND - 0.006, HEAD_BAND, fromHead));
      const headEdge = float(1).sub(smoothstep(0.002, 0.005, fromHead.sub(HEAD_BAND).abs()));
      const eyeAt = vec2(q.x.div(0.35).add(0.5).fract().sub(0.5).mul(0.35), fromHead.sub(HEAD_BAND * 0.5));
      const eye = float(1).sub(smoothstep(0.009, 0.014, eyeAt.length())).mul(resolvedAt(0.02, px));
      const edgeDist = q.x.min(uWidth.sub(q.x)).min(q.y).min(uDrop.sub(q.y));
      const tabling = float(1).sub(smoothstep(0.05, 0.065, edgeDist));
      const rope = float(1).sub(smoothstep(0.014, 0.022, edgeDist));
      const lay = q.x.add(q.y).mul(140).sin().mul(0.5).add(0.5).mul(resolvedAt(0.01, px));

      // REEF BANDS, each a doubled strip with a row of points: a grommet, and a pair of tie lines hanging
      let reefBand: N = float(0);
      let reefCord: N = float(0);
      let grommet: N = float(0);
      REEFS.forEach((rv, i) => {
        const y = q.y.sub(uDrop.mul(rv));
        reefBand = reefBand.max(float(1).sub(smoothstep(REEF_BAND * 0.5 - 0.004, REEF_BAND * 0.5, y.abs())));
        // the points: one every REEF_POINT m, each cord hanging ~0.24 m below the band, a little swayed
        const k = q.x.div(REEF_POINT).add(i * 0.37).floor();
        const lx = q.x.sub(k.sub(i * 0.37).add(0.5).mul(REEF_POINT));
        const g = vec2(lx, y);
        grommet = grommet.max(float(1).sub(smoothstep(0.007, 0.011, g.length())));
        const hang = hash2(vec2(k, i * 9 + 1)).mul(0.08).add(0.2);
        const sway = hash2(vec2(k, i * 9 + 2)).sub(0.5).mul(0.07);
        const t = y.negate().div(hang).clamp(0, 1);
        // the pair, a finger apart, the tails parting and swaying as they hang
        const cx = sway.mul(t.mul(t));
        const d1 = lx.sub(cx).sub(0.008).abs();
        const d2 = lx.sub(cx).add(0.008).sub(t.mul(0.012)).abs();
        const inLen = smoothstep(0.0, 0.01, y.negate()).mul(float(1).sub(smoothstep(hang.sub(0.01), hang, y.negate())));
        reefCord = reefCord.max(float(1).sub(smoothstep(0.005, 0.008, d1.min(d2))).mul(inLen));
      });
      const cords = reefCord.mul(resolvedAt(0.008, px));

      // THE CLOTH'S SET (the 2026-10-30 triage: front-lit at 545 s and backlit at 370 s the course still read as one
      // flat printed board — "fresh out of an IKEA bag"). A square sail laced to a bamboo yard and sheeted at its two
      // clews never lies smooth: the head sags in a shallow scallop between each pair of robands, with a short fan of
      // creases running down from every roband where the lacing pulls; the sheets pull long creases up from each clew
      // along the line of the strain (toward the far end of the yard); and the cloth between hangs in a few soft
      // vertical folds where it is not quite drawn. Heights in metres on the cloth's own normal (`bumped`), each faded
      // as its own width goes sub-pixel: millimetres, which under a low Sun or against it are what tell canvas from card.
      // @band-limited-elsewhere: the lacing's own phase (a 0.8 m period); every fold built on it is × resolvedAt(px)
      const lace = pc.add(0.5).fract().sub(0.5); // (bolts from the nearest roband, −½…½)
      const scallop = lace.mul(Math.PI * 2).cos().oneMinus().mul(fromHead.div(0.18).negate().exp()).mul(-0.003);
      const fan = lace.mul(boltW).div(fromHead.mul(0.7).add(0.06)).mul(Math.PI * 2 * 1.3).cos()
        // @band-limited-elsewhere: a window on the lacing phase; the fan is × resolvedAt(0.06, px) below
        .mul(float(1).sub(smoothstep(0.25, 0.5, lace.abs())))
        .mul(fromHead.div(0.45).negate().exp())
        .mul(0.0035)
        .mul(resolvedAt(0.06, px));
      const clew = (cx: N, toward: N): N => {
        const dir = vec2(toward, uDrop).normalize();
        const d = q.sub(vec2(cx, 0));
        const along = d.dot(dir);
        const across = d.x.mul(dir.y).sub(d.y.mul(dir.x));
        const wob = fbm2(vec2(along.mul(0.9), across.mul(0.5)).add(s), 2).sub(0.5).mul(0.07);
        // (three or four creases ~0.22 m apart either side of the strain line, gone ~0.45 m off it and ~1.7 m up it;
        // 6 mm deep)
        return across.add(wob).mul(Math.PI * 2 / 0.22).sin()
          .mul(across.mul(across).div(0.2).negate().exp())
          .mul(along.max(0).div(1.7).negate().exp())
          // @band-limited-elsewhere: a 0.3 m ramp up from the clew; the creases are × resolvedAt(0.11, px)
          .mul(smoothstep(0.0, 0.3, along))
          .mul(0.006);
      };
      const clews = clew(float(0), uWidth.mul(0.7)).add(clew(uWidth, uWidth.mul(-0.7))).mul(resolvedAt(0.11, px));
      const hang = q.x.mul(Math.PI * 2 / 0.62).add(fbm2(vec2(q.x.mul(0.7), q.y.mul(0.35)).add(s.mul(0.3)), 3).mul(5)).sin()
        // @band-limited-elsewhere: metre-scale ramps over the drop; the folds are × resolvedAt(0.3, px)
        .mul(smoothstep(0.1, 0.4, v).mul(float(1).sub(smoothstep(0.75, 0.95, v))))
        // (1 cm over a 0.62 m fold, a slope of 0.1: at the first try's 3.5 mm the folds did not show at 545 s)
        .mul(0.01)
        .mul(resolvedAt(0.3, px));
      const folds = scallop.add(fan).add(clews).add(hang);

      // PATINA: the cloth on its bolt's tone, then a strong irregular yellow-brown mottle, darker stains with tide
      // lines, streaks from the yard, mildew along the foot
      const broad = fbm2(q.mul(0.42).add(s), 3);
      const mottle = fbm2(q.mul(1.3).add(s.mul(2.1)), 4);
      let c: N = color.mul(boltTone);
      const ochre = vec3(0.62, 0.48, 0.26);
      c = mix(c, c.mul(ochre).mul(1.6), mottle.mul(0.9).add(broad.mul(0.4)).sub(0.35).clamp(0, 1).mul(0.55));
      // where the sun has bleached it, PALE AND COOL (the user: the sail, the poles and the roof had bled into one
      // tan): toward a light grey-white, not toward yellow
      const bleach = v.mul(0.3).add(broad.sub(0.5).mul(0.6)).add(0.15).clamp(0, 1);
      c = mix(c, vec3(luminance(c)).mul(vec3(0.98, 1.0, 1.02)).mul(1.3), bleach.mul(0.5));
      const stainN = fbm2(q.mul(0.9).add(s.mul(3.7)), 4);
      const stain = smoothstep(0.6, 0.7, stainN);
      const tide = float(1).sub(smoothstep(0.0, 0.012, stainN.sub(0.6).abs())).mul(resolvedAt(0.01, px));
      c = c.mul(mix(vec3(1), vec3(0.72, 0.6, 0.45), stain.mul(0.7))).mul(mix(float(1), float(0.72), tide.mul(0.6)));
      const runs = smoothstep(0.56, 0.8, fbm2(vec2(q.x.mul(6.5), q.y.mul(0.32)).add(s.mul(1.3)), 3)).mul(smoothstep(0.15, 0.95, v));
      c = c.mul(mix(vec3(1), vec3(0.78, 0.68, 0.55), runs.mul(0.55)));
      const mild = smoothstep(0.6, 0.82, fbm2(q.mul(2.6).add(s.mul(0.7)), 3)).mul(float(1).sub(smoothstep(0.0, 0.3, v)));
      c = c.mul(mix(vec3(1), vec3(0.6, 0.62, 0.55), mild.mul(0.6)));

      // PATCHES, seeded per sail: another cloth sewn on askew, its edge not quite straight
      let patch: N = float(0);
      for (let k = 0; k < PATCHES; k++) {
        const h = (n: number): N => hash2(vec2(piece.seed.mul(91.7).add(k * 13.1), n));
        const centre = vec2(h(1).mul(0.7).add(0.15).mul(uWidth), h(2).mul(0.6).add(0.3).mul(uDrop));
        const half = vec2(h(3).mul(0.18).add(0.1), h(4).mul(0.2).add(0.09));
        const ang: N = h(8).sub(0.5).mul(0.25);
        const rel: N = q.sub(centre);
        const rot = vec2(rel.x.mul(ang.cos()).add(rel.y.mul(ang.sin())), rel.y.mul(ang.cos()).sub(rel.x.mul(ang.sin())));
        const d = rot.abs().sub(half).add(fbm2(rot.mul(9).add(h(9).mul(30)), 2).sub(0.5).mul(0.025));
        const sd = d.max(0).length().add(d.x.max(d.y).min(0));
        patch = patch.max(float(1).sub(smoothstep(-0.004, 0.004, sd)).mul(smoothstep(0.3, 0.31, h(5))));
      }
      c = mix(c, c.mul(vec3(1.04, 1.02, 0.97)), patch);

      // the sewing on top of the cloth: the overlap a shade darker, the fold dark, the stitching
      c = c.mul(mix(float(1), float(0.9), seamOn)).mul(mix(float(1), float(0.68), fold)).mul(mix(float(1), float(0.7), stitch));
      c = c.mul(mix(float(1), float(0.86), head.max(reefBand).max(tabling))).mul(mix(float(1), float(0.6), headEdge.mul(resolvedAt(0.006, px))));
      c = c.mul(mix(float(1), float(0.35), eye.max(grommet.mul(resolvedAt(0.02, px)))));
      c = mix(c, vec3(0.32, 0.26, 0.18).mul(mix(float(0.75), float(1.1), lay)), rope);
      c = mix(c, vec3(0.2, 0.16, 0.11), cords.mul(0.9));

      // THE FIGURE, hand-painted: the brush edge wobbles, the pigment bled along the weave, the brush dragged,
      // the sun faded it toward the canvas, it cracked, and in places it flaked off to bare cloth
      const pt = vec2(u.sub(0.5).mul(uWidth), v.sub(uCentreV).mul(uDrop));
      const wobble = vec2(fbm2(pt.mul(5.1).add(3.3), 2), fbm2(pt.mul(5.1).add(7.9), 2)).sub(0.5).mul(0.035);
      const fd = konTikiFaceNodes(pt.add(wobble), prims, uStroke);
      const wick = fbm2(vec2(pt.x.mul(70), pt.y.mul(9)), 2).mul(0.5).add(fbm2(vec2(pt.x.mul(9), pt.y.mul(70)), 2).mul(0.5));
      const bleed = wick.mul(0.022).add(0.004);
      const fillA = float(1).sub(smoothstep(bleed.negate().mul(0.4), bleed, fd.fill));
      const strokeA = float(1).sub(smoothstep(bleed.negate().mul(0.3), bleed.mul(0.7), fd.stroke));
      const drag = fbm2(vec2(pt.x.add(pt.y).mul(2.2), pt.x.sub(pt.y).mul(14)).add(1.7), 3);
      const density = mix(float(0.6), float(1), drag);
      const crack = smoothstep(0.6, 0.66, fbm2(pt.mul(16), 3)).mul(resolvedAt(0.03, px));
      const flaked = smoothstep(0.6, 0.7, fbm2(pt.mul(2.3).add(11.1), 3));
      // faded toward the cloth — a little less than it was (the user's call, 2026-10-29)
      const fade = float(0.26).add(v.mul(0.14)).add(broad.sub(0.5).mul(0.25)).clamp(0.15, 0.6);
      const keep = density.mul(float(1).sub(crack.mul(0.7))).mul(float(1).sub(flaked.mul(0.85))).mul(float(1).sub(fade));
      const face = piece.variant.mul(on);
      const fill: N = uFill;
      const fillCol = mix(fill, vec3(luminance(fill)).mul(vec3(1.3, 1.0, 0.8)), 0.25).mul(mix(float(0.85), float(1.05), drag));
      const paint = fillA.mul(keep).mul(face);
      c = mix(c, fillCol, paint);
      const ink = strokeA.mul(keep.mul(0.75).add(0.15)).mul(face);
      const outline: N = uOutline;
      c = mix(c, outline.mul(1.4), ink);

      // what the light through it sees: a double cloth at every seam, band, patch and the tabling; the bolt rope
      // and the paint on top
      out.thickness = float(1)
        .sub(seamOn.mul(0.45))
        .mul(float(1).sub(head.max(reefBand).max(tabling).mul(0.45)))
        .mul(float(1).sub(patch.mul(0.35)))
        .mul(float(1).sub(rope.mul(0.6)))
        .mul(float(1).sub(cords.mul(0.6)))
        .mul(float(1).sub(paint.max(ink).mul(0.45)))
        // (and the dirt in it: a stained or mildewed cloth passes less — against the Sun its stains show as shadows)
        // (lightly: at 0.3 the mizzen's stains went near-black against the 370 s sunset)
        .mul(float(1).sub(stain.mul(0.15)))
        .mul(float(1).sub(mild.mul(0.12)));
      // and what stands proud of it (m): the overlaps and bands, the puckers along the seams, the fold, the
      // stitches, the bolt rope and the reef points, the canvas's slub
      const slub = fbm2(vec2(q.x.mul(40), q.y.mul(6)), 2).mul(0.0006).mul(resolvedAt(0.02, px));
      out.height = seamOn.mul(0.0012)
        .add(pucker.mul(0.0016))
        .sub(fold.mul(0.001))
        .sub(stitch.mul(0.0005))
        .add(head.max(reefBand).max(tabling).mul(0.0012))
        .add(patch.mul(0.0012))
        .add(rope.mul(0.004).mul(lay.mul(0.3).add(0.7)))
        .add(cords.mul(0.003))
        .add(slub)
        .add(folds)
        .mul(on);
      // (the robands and the furled bundle: the game's cloth, on the old canvas's tone rather than its new white)
      return mix(color.mul(vec3(0.86, 0.8, 0.68)), c, on);
    },
    refresh(): void {
      uFill.value.set(p.faceFill);
      uOutline.value.set(p.faceOutline);
      uWidth.value = raftParams.mainSailWidth;
      uDrop.value = raftParams.mainSailDrop;
      uCentreV.value = p.faceCentreV;
      uStroke.value = p.faceStroke;
      uLaces.value = shipMaterialParams.sailLacingPoints;
    },
  };

  // the game's params, live, but its own seams off: this sail draws its seams (above)
  const params: ShipMaterialParams = Object.create(shipMaterialParams, {
    sailSeamDarken: { get: () => 1, enumerable: true },
    sailSeamRidge: { get: () => 0, enumerable: true },
  });
  const handle = createSailClothMaterial(params, decal);
  const m = handle.material as THREE.MeshStandardNodeMaterial;
  m.name = 'raft-sail-worn';
  // (as the game's sail: both faces cast, so the cloth shades what is under it whichever way it faces the sun)
  m.shadowSide = THREE.DoubleSide;
  m.emissiveNode = (m.emissiveNode as N).mul(out.thickness);
  m.normalNode = bumped(m.normalNode as N, out.height);
  return handle;
}
