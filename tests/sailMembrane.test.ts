/**
 * §T.74 — THE SAIL IS A SHEET IN TENSION, NOT A BULGE PUSHED INTO A PLATE.
 *
 * User: "it feels like we're pushing a bulge into a concrete plate instead of
 * the cloth stretching as a whole and really shaping the bulge FROM THE CORNERS
 * where force is applied… they should only be anchored where it makes sense,
 * and in this case only at the corners with the ropes — that's where the
 * tension point should be."
 *
 * A square sail is an INEXTENSIBLE MEMBRANE whose boundary is fixed only at the
 * head (bent to its yard along the whole length) and at the two CLEWS.
 * Everything else is free edge. Four observables follow, and each is a separate
 * test below because each can be lost independently:
 *
 *   (a) the belly is not authored depth — it is what a sheet does when it holds
 *       MORE CLOTH than the chord between its fixed points, so depth follows
 *       from EXCESS LENGTH, and the cloth does not stretch;
 *   (b) the leeches and foot pull inward in catenaries between attachments —
 *       the scalloped foot is the signature and a straight edge is the tell;
 *   (c) tension CONCENTRATES at the corners, so cloth near a clew is flat and
 *       taut while the belly is slack — the opposite of a uniform field;
 *   (d) the whole sheet moves, so filling a sail shortens its projected extent.
 *
 * EVERY BAR HERE IS A RATIO OR A SHAPE, NEVER A PINNED MAGNITUDE (§Rule 6,
 * §V.66). A test that asserts "the belly is 1.8 m deep" passes on a fixed quad
 * with a displacement painted into it, which is the exact defect being fixed.
 *
 * WHERE THE NUMBERS COME FROM: tests/zzScratchSailMembrane.test.ts is the
 * harness that measured all of them, before and after. Bars are set clear of
 * the measured value, not on it.
 */
import { describe, expect, it } from 'vitest';
import { shipMaterialParams } from '../src/params/ship';
import {
  SAIL_ARC_COEFF,
  SAIL_BELLY_REF,
  arcShorten,
  sailCamberRatio,
  sailClothOffset,
  sailClothPoint,
  type SailClothState,
} from '../src/ship/sailShape';
import { sailDrive } from '../src/ship/sailDynamics';
import { autoBrace } from '../src/sailing/shipKinematics';

const FLAT_SHEETS = {
  sheetLeadPort: [0, 0, 0] as [number, number, number],
  sheetLeadStarboard: [0, 0, 0] as [number, number, number],
};
/** the galleon's main course */
const WIDTH = 12.17;
const DROP = 6.3;
/** flutter and quilt off: these are all statements about the STANDING shape,
 *  and a travelling ripple would make every one of them sampling-dependent */
const P = { ...shipMaterialParams, sailFlutterAmp: 0, sailSeamQuilt: 0, sailSlackFold: 0 };
/** roach off where the assertion is about the MEMBRANE — the roach is a static
 *  cut and would otherwise be credited to the wind */
const P_CUT = { ...P, sailFootRoach: 0 };

type V3 = [number, number, number];
const st = (drive: number): SailClothState => ({
  drive, luff: 0, skew: 0, dropScale: 1, flutterPhase: 0, ...FLAT_SHEETS,
});
const pt = (u: number, v: number, drive: number, p = P_CUT): V3 =>
  sailClothPoint(u, v, WIDTH, DROP, st(drive), p);
const dist = (a: V3, b: V3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** the sail's own deepest cloth, over the whole panel */
function peakDepth(drive: number, p = P_CUT): number {
  let z = 0;
  for (let i = 0; i <= 48; i++) {
    for (let j = 0; j <= 48; j++) z = Math.max(z, pt(i / 48, j / 48, drive, p)[2]);
  }
  return z;
}

/** 3D arc length of one strip of cloth */
function stripLength(
  at: (t: number) => V3,
  N = 400,
): number {
  let L = 0;
  let prev = at(0);
  for (let i = 1; i <= N; i++) {
    const q = at(i / N);
    L += dist(prev, q);
    prev = q;
  }
  return L;
}

describe('§T.74a — the belly is the CONSEQUENCE of excess cloth, not an authored depth', () => {
  /**
   * WHY THIS MATTERS AND WHAT IT WOULD CATCH. `sailCamber` was a depth: a
   * number of hundredths of a chord, multiplied by the drive and pushed into
   * the panel. Nothing in the sail could disagree with it, which is exactly why
   * the outline and the cloth were free to drift apart — the arc-length shrink
   * spent one coefficient while the depth was set by an unrelated knob.
   *
   * Making depth the INVERSE of the same arc-length relation removes that
   * freedom by construction. These tests assert the round trip, not the value.
   */
  it('camber is the exact inverse of the arc-length relation it is shortened by', () => {
    // a strip that bows by this camber must carry EXACTLY the excess it was cut
    // with — that is what "the belly is the excess showing" means, stated as
    // an equation. Two independent constants could never satisfy it.
    for (const excess of [0.01, 0.03, 0.065, 0.12]) {
      const p = { ...P, sailClothExcess: excess, sailCamberMax: 1 };
      const k = sailCamberRatio(1, p);
      // arcShorten(k) = 1/(1 + COEFF·k²) = 1/(1 + excess)
      expect(1 / arcShorten(k) - 1).toBeCloseTo(excess, 12);
    }
  });

  it('excess is a LENGTH, so doubling it does NOT double the depth', () => {
    // THE TEST THAT SEPARATES A LENGTH FROM A DEPTH. A camber parameter is
    // linear in itself; an excess is not, because arc length grows with the
    // SQUARE of the bow. Doubling the cloth buys √2 of belly, and any future
    // change that quietly reintroduces a depth knob fails right here.
    const p = (e: number) => ({ ...P, sailClothExcess: e, sailCamberMax: 1 });
    const single = sailCamberRatio(1, p(0.04));
    const double = sailCamberRatio(1, p(0.08));
    expect(double / single).toBeCloseTo(Math.SQRT2, 6);
    expect(single).toBeCloseTo(Math.sqrt(0.04 / SAIL_ARC_COEFF), 12);
  });

  it('camber is LINEAR in the fullness the driver hands it, and C1 through zero', () => {
    // §T.85 RE-CUT. This used to assert CONCAVITY in `drive` ("fills early,
    // then stops deepening"), which combined with a front-loaded load curve put
    // the cloth at 61% of full camber in 2 kn of wind — the binary has-wind /
    // no-wind the user then reported. The saturation now lives in ONE place,
    // sailDrive's pressure curve (asserted in §T.85 below), and `drive` IS the
    // fullness; camber follows it linearly so a half-loaded sail shows half.
    const camber = (d: number): number => sailCamberRatio(d, { ...P, sailCamberMax: 1 });
    const full = camber(1);
    for (let i = 0; i <= 20; i++) {
      expect(camber(i / 20)).toBeCloseTo(full * (i / 20), 12);
      expect(camber(-i / 20)).toBeCloseTo(-full * (i / 20), 12); // aback: same law, other way
    }
    expect(camber(0)).toBeCloseTo(0, 12); // becalmed is genuinely flat
    // bounded by construction, whatever the driver hands it (§V44)
    expect(camber(7)).toBeCloseTo(full, 12);
    expect(camber(-7)).toBeCloseTo(-full, 12);
  });

  it('THE CLOTH DOES NOT STRETCH: every strip keeps the length it was cut with', () => {
    /**
     * THE OBSERVABLE THAT DEFINES AN INEXTENSIBLE MEMBRANE, and the one the old
     * shape failed hardest. Measured on the shape before this task, worst
     * |L/cut − 1| over these strips was 8.00% AND IT SIGN-FLIPPED: the foot
     * GAINED 5.22% of cloth while the strip at the draft height lost 2.40%.
     * A sheet that grows in one place and shrinks in another is not bowing, it
     * is being stretched — which is what "concrete plate" feels like from the
     * outside.
     *
     * The bar is a RATIO of the cloth's own length so it survives any resize of
     * any sail, and it is set at 3.5% against a measured 3.17% — deliberately
     * not tighter, because the residual is a KNOWN limitation of a first-order
     * arc coefficient (see SAIL_ARC_COEFF / SAIL_ARC_COEFF_V) and tightening it
     * would be asserting the fit rather than the physics. §T.85 re-measured:
     * 2.83% worst, and NO strip reads short — the sign flip is what the
     * vertical strips' own coefficient removed (1.9 on them read 9% short).
     */
    let worst = 0;
    let where = '';
    for (const drive of [0.25, 0.5, 0.75, 1]) {
      for (const v of [0, 0.15, 0.3, 0.45, 0.6, 0.8]) {
        const err = stripLength((t) => pt(t, v, drive)) / WIDTH - 1;
        if (Math.abs(err) > worst) { worst = Math.abs(err); where = `u-strip v=${v} drive=${drive}`; }
      }
      for (const u of [0, 0.15, 0.25, 0.4, 0.5, 0.6, 0.75, 0.85, 1]) {
        const err = stripLength((t) => pt(u, t, drive)) / DROP - 1;
        if (Math.abs(err) > worst) { worst = Math.abs(err); where = `v-strip u=${u} drive=${drive}`; }
      }
    }
    expect(worst, `worst strip at ${where}`).toBeLessThan(0.035);
  });
});

describe('§T.74c — tension CONCENTRATES at the clews: flat and taut there, slack in the belly', () => {
  /**
   * THE HEADLINE OF §T.74 AND THE USER'S ACTUAL WORDS. The load on every
   * element of cloth in the lower sail has to be routed to one of exactly two
   * pinned points, so the tension per unit length about a clew grows as 1/r and
   * the cloth there cannot bow. The old field was a product of two profiles
   * that knew nothing about the pins: at 5% of the way from a clew toward the
   * centre it still carried 23.0% of the sail's peak depth, and the cloth was
   * measurably SLACKER at the clew than in the belly.
   */
  it('the cloth at a clew carries almost none of the sail\'s depth', () => {
    const peak = peakDepth(1);
    // the ray from the port clew toward the sail's centre, in the cut panel
    const ray = (t: number, p = P_CUT): number => pt(t * 0.5, t * 0.5, 1, p)[2];
    // measured: 2.3% at t = 0.05 and 6.3% at t = 0.1, against 23.0% and 41.8%
    // on the shape before this task. Bars sit between the two, so they fail on
    // the old field and are not pinned to the new one.
    expect(ray(0.05) / peak).toBeLessThan(0.08);
    expect(ray(0.1) / peak).toBeLessThan(0.15);
    // …and the belly is genuinely there, so this is not a flat sail passing
    expect(peak / WIDTH).toBeGreaterThan(0.1);
  });

  it('leaves the clew along a FLAT ramp, not a straight one', () => {
    /**
     * THE SHAPE OF THE FALLOFF, WHICH IS WHAT SEPARATES THE TWO MODELS.
     *
     * A uniform-tension field pinned at a point leaves it LINEARLY: double the
     * distance, double the displacement. A field whose tension goes as 1/r
     * leaves it at least QUADRATICALLY, because the membrane equation
     * ∇·(T∇w) = −p with T ∝ 1/r gives w ∝ r³ at the corner against r² in the
     * field. So the test is the exponent, not the value.
     *
     * Measured along the foot: z(0.1)/z(0.05) was 1.82 (sub-linear — the old
     * field actually flattened OUT of the corner) and is now 2.77.
     */
    for (const drive of [0.5, 1]) {
      const z = (u: number): number => pt(u, 0, drive)[2];
      expect(z(0.1) / z(0.05)).toBeGreaterThan(2.2);
      expect(z(0.05) / z(0.025)).toBeGreaterThan(2.2);
    }
  });

  it('is DRIVEN BY sailCornerGrip, and grip 0 is exactly the old flat-plate field (§V.62)', () => {
    /**
     * §V.62 — A KNOB THAT DRIVES NOTHING IS A DEFECT, and this project makes
     * them faster than it finds them. This proves the parameter reaches the
     * geometry, proves the direction, and proves the CONTROL: at grip 0 the
     * tension field collapses to 1 everywhere and the shape is the separable
     * product it replaced, which is why the same assertions above fail here.
     */
    const at = (grip: number): number => {
      const p = { ...P_CUT, sailCornerGrip: grip };
      return pt(0.025, 0.025, 1, p)[2] / peakDepth(1, p);
    };
    const off = at(0);
    // monotone: more grip, flatter corner, at every step
    let prev = off;
    for (const g of [0.09, 0.18, 0.28, 0.45]) {
      const now = at(g);
      expect(now).toBeLessThan(prev);
      prev = now;
    }
    // and the effect is LARGE, not a rounding difference
    expect(at(0.28)).toBeLessThan(off * 0.5);
    // the control: with the knob off, the corner-flatness assertion above fails
    const p0 = { ...P_CUT, sailCornerGrip: 0 };
    const zRatio = pt(0.1, 0, 1, p0)[2] / pt(0.05, 0, 1, p0)[2];
    expect(zRatio).toBeLessThan(2.2);
  });
});

describe('§T.74b/d — the free edges pull in and the whole sheet moves', () => {
  /**
   * These two were already largely delivered before §T.74 (the outline stopped
   * being a rectangle in an earlier pass), so these are REGRESSION GUARDS
   * rather than new ground — the corner tension field takes depth away from the
   * strips near the clews, which is precisely the region that scallops the
   * foot, so it is the change most able to flatten these back out.
   */
  it('(b) scallops the FOOT and draws the LEECH in, in the silhouette', () => {
    const clewP = pt(0, 0, 1);
    const clewS = pt(1, 0, 1);
    // the foot climbs above the line joining its two clews — this is the
    // reference's scalloped foot (docs/inspo/ship/ref-sail-scalloped-foot.png)
    let rise = 0;
    for (let i = 1; i < 40; i++) {
      const u = i / 40;
      const q = pt(u, 0, 1);
      const onChord = clewP[1] + (clewS[1] - clewP[1]) * ((q[0] - clewP[0]) / (clewS[0] - clewP[0]));
      rise = Math.max(rise, q[1] - onChord);
    }
    // §T.85: measured 0.46 m = 3.8% of chord (was 1.14 m = 9.4% — that figure
    // was the horizontal arc coefficient over-shortening the vertical strips
    // by 3×, see SAIL_ARC_COEFF_V). 0.46 m is what the centre strip's own
    // length demands: √(6.3² − 2.05²) is 0.44 m short of 6.3. Asserted as a
    // fraction so it survives any resize, and it is the EDGE that must not be
    // straight.
    expect(rise / WIDTH).toBeGreaterThan(0.025);
    // and the leech is NOT a straight vertical line: the clew is drawn inboard
    // of the yardarm, most where the cloth bows most (the foot), and the edge
    // between flies forward of the yard plane (asserted in §T.85 below)
    const yarm = pt(0, 1, 1);
    expect(clewP[0] - yarm[0]).toBeGreaterThan(0.01 * WIDTH); // measured 3.0%
    let prev = yarm[0];
    for (let i = 1; i <= 40; i++) {
      const x = pt(0, 1 - i / 40, 1)[0];
      expect(x).toBeGreaterThanOrEqual(prev - 1e-9); // monotone toward the clew
      prev = x;
    }
  });

  it('(d) filling the sail SHRINKS its projected extent, monotonically', () => {
    /**
     * The outline's overall SPAN cannot shrink and must not be asserted to: the
     * head is bent to its yard along its whole length, so the widest part of a
     * square sail is fixed by the spar in every wind. What moves is everything
     * below it. The honest measures are the silhouette AREA and the distance
     * between the two clews, and both must fall as she fills.
     */
    const footSpan = (d: number): number => pt(1, 0, d)[0] - pt(0, 0, d)[0];
    const area = (d: number): number => {
      const N = 40;
      let a = 0;
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          const q0 = pt(i / N, j / N, d);
          const q1 = pt((i + 1) / N, j / N, d);
          const q2 = pt(i / N, (j + 1) / N, d);
          a += Math.abs((q1[0] - q0[0]) * (q2[1] - q0[1]) - (q1[1] - q0[1]) * (q2[0] - q0[0]));
        }
      }
      return a;
    };
    let prevSpan = Infinity;
    let prevArea = Infinity;
    for (const d of [0, 0.25, 0.5, 0.75, 1]) {
      const s = footSpan(d);
      const a = area(d);
      expect(s).toBeLessThan(prevSpan + 1e-9);
      expect(a).toBeLessThan(prevArea + 1e-9);
      prevSpan = s;
      prevArea = a;
    }
    // and by an amount that reads, not by a rounding: measured 5.7% of area
    // (§T.85; was 13.1% with the vertical strips over-shortened, see (b))
    expect(area(1) / area(0)).toBeLessThan(0.95);
    // the head itself is untouched — it is laced to the yard and cannot move
    expect(pt(0, 1, 1)[0]).toBeCloseTo(-WIDTH / 2, 9);
    expect(pt(1, 1, 1)[0]).toBeCloseTo(WIDTH / 2, 9);
  });
});

describe('§T.74 — the anchors ropes hang from ride the LIVE shape (§V.71)', () => {
  /**
   * §V.71: a part positioned against another system's surface must resolve
   * against that surface's LIVE shape. §T.71's cringles and §T.72's reeving are
   * downstream of this file, so the seam has to stay clean — the attachment
   * points are PUBLISHED through the same evaluator the vertex stage runs, not
   * baked.
   *
   * The corner tension field is the change most likely to break that quietly:
   * it is the first term in this file that reads the sail's DROP as well as its
   * width, so a consumer that passed only the width would silently get a
   * different sail's tension field.
   */
  it('every sail-attached anchor MOVES with the fill, and moves smoothly', () => {
    // SAIL_ANCHOR_UV's stations, resolved through the live shape
    for (const [u, v] of [[0, 0], [1, 0], [0.3, 0], [0.7, 0], [0.3, 0.34], [0.7, 0.62]]) {
      const slack = pt(u, v, 0);
      const full = pt(u, v, 1);
      // it is on cloth, so it has to have gone somewhere
      expect(dist(slack, full)).toBeGreaterThan(0.01);
      // …continuously, with no step across the whole travel (§V.71's bound)
      let prev = slack;
      for (let i = 1; i <= 100; i++) {
        const q = pt(u, v, i / 100);
        expect(dist(prev, q)).toBeLessThan(0.01 * DROP);
        prev = q;
      }
    }
  });

  it('the shape reads the sail\'s own DROP, not just its width (§V.66)', () => {
    // two sails of the same chord and different drop must NOT get the same
    // cloth: the corner tension field is a field in metres over the cut panel,
    // so aspect is part of it. A consumer that dropped the drop argument would
    // pass every other test in this file and fail here.
    const tall = sailClothPoint(0.15, 0.1, WIDTH, 12, st(1), P_CUT)[2];
    const squat = sailClothPoint(0.15, 0.1, WIDTH, 4, st(1), P_CUT)[2];
    expect(Math.abs(tall - squat)).toBeGreaterThan(0.01);
  });

  it('camber still means camber on a sail of ANY size and aspect', () => {
    // the tension field is normalised at the belly's own reference station, so
    // `sailCamberRatio` keeps meaning "peak camber as a fraction of chord" —
    // the property the previous pass established and this one must not spend
    const deepest = (w: number, h: number): number => {
      let z = 0;
      for (let i = 0; i <= 60; i++) {
        for (let j = 0; j <= 60; j++) {
          z = Math.max(z, sailClothPoint(i / 60, j / 60, w, h, st(1), P_CUT)[2]);
        }
      }
      return z / w;
    };
    const k = sailCamberRatio(1, P_CUT);
    for (const [w, h] of [[6, 6], [18, 6], [12.17, 6.3], [8.7, 3]]) {
      expect(deepest(w, h)).toBeGreaterThan(k * 0.9);
      expect(deepest(w, h)).toBeLessThanOrEqual(k * 1.02);
    }
    // and it never exceeds the §V44 ceiling, which is what makes it a bound
    expect(k).toBeLessThanOrEqual(P_CUT.sailCamberMax);
  });
});

describe('§T.74 — the belly is at the reference station, so the peak is where it is claimed', () => {
  it('the deepest cloth sits at mid-width and the draft height', () => {
    // if the tension field moved the peak, `sailCamberRatio` would stop being
    // the peak and every bound expressed through it would be off by whatever
    // the field did — a §V.44 hole that no depth assertion would catch
    let best = { u: 0, v: 0, z: -Infinity };
    for (let i = 0; i <= 80; i++) {
      for (let j = 0; j <= 80; j++) {
        const z = pt(i / 80, j / 80, 1)[2];
        if (z > best.z) best = { u: i / 80, v: j / 80, z };
      }
    }
    expect(best.u).toBeGreaterThan(0.3);
    expect(best.u).toBeLessThan(0.7);
    expect(Math.abs(best.v - SAIL_BELLY_REF)).toBeLessThan(0.15);
  });
});

/**
 * §T.85 — THE SAIL READS AS A MEMBRANE UNDER PRESSURE, AND FULLNESS IS THE LOAD.
 *
 * User, with a screenshot at ~15 kn apparent on a beam reach: "the bulge on
 * our sail still seems very much centralized in the middle — it doesn't look
 * like the whole fabric as a thing is stretching forward… And we don't see the
 * amount of force we're catching: it should be much fuller, fully stretched
 * out at 20 knots and above, and as the wind power we're capturing lowers we
 * should visually see that — not a binary has-wind / has-no-wind."
 *
 * Every bar is a property (§V.80): monotone, saturating, ordered, signed,
 * different-per-sail, finite. Numbers in comments are what the shipped params
 * measure; the bars sit clear of them.
 */
const KN = 0.5144;
/** fullness the driver hands the cloth for a sail square to `kn` of apparent wind */
const driveAt = (kn: number, over: Partial<typeof shipMaterialParams> = {}): number =>
  sailDrive(
    { forwardX: 0, forwardZ: 1, windDirection: 0, windSpeed: kn * KN, yawRate: 0 },
    { ...shipMaterialParams, ...over },
  ).drive;
/** the sail's deepest cloth at that wind, as a fraction of chord */
const camberAtKn = (kn: number): number => {
  const d = driveAt(kn);
  let z = 0;
  for (let i = 0; i <= 32; i++) for (let j = 0; j <= 32; j++) z = Math.max(z, pt(i / 32, j / 32, d)[2]);
  return z / WIDTH;
};

describe('§T.85 — LOAD → FULLNESS: camber is a continuous, saturating function of dynamic pressure', () => {
  it('is monotone in wind speed and saturates — the gain from 20→25 kn is small beside 5→10', () => {
    // measured: 0.5% at 2 kn, 3.1% at 5, 9.7% at 10, 15.0% at 15, 17.5% at
    // 20, 18.3% at 25 (camber of chord). The old law: 11.3% at 2 kn, 14.9% at 5.
    const c = [2, 5, 8, 10, 12, 15, 20, 25, 30].map(camberAtKn);
    for (let i = 1; i < c.length; i++) expect(c[i]).toBeGreaterThan(c[i - 1]);
    const full = sailCamberRatio(1, P_CUT);
    expect(camberAtKn(2)).toBeLessThan(0.01); // ~0 at 2 kn
    expect(camberAtKn(5)).toBeLessThan(0.3 * full); // slack at 5
    expect(camberAtKn(10)).toBeGreaterThan(0.4 * full); // about half at 10-12…
    expect(camberAtKn(12)).toBeLessThan(0.75 * full);
    expect(camberAtKn(20)).toBeGreaterThan(0.9 * full); // …drum-tight by 20
    expect(camberAtKn(25) - camberAtKn(20)).toBeLessThan(0.25 * (camberAtKn(10) - camberAtKn(5)));
  });

  it('becalmed is slack: no apparent wind, no fullness', () => {
    expect(driveAt(0)).toBeCloseTo(0, 9);
    // and a ship running at wind speed feels nothing — her canvas goes soft
    const running = sailDrive(
      { forwardX: 0, forwardZ: 1, windDirection: 0, windSpeed: 8, shipVelZ: 8, yawRate: 0 },
      shipMaterialParams,
    ).drive;
    expect(running).toBeLessThan(0.02);
  });

  it('ABACK flips the sign: the cloth presses the other way, same law', () => {
    const irons = sailDrive(
      { forwardX: 0, forwardZ: 1, windDirection: Math.PI, windSpeed: 20 * KN, yawRate: 0 },
      shipMaterialParams,
    );
    expect(irons.drive).toBeLessThan(0);
    // the foot centre, the deepest cloth, goes BEHIND the yard plane…
    expect(pt(0.5, 0, irons.drive)[2]).toBeLessThan(0);
    // …and the shape is the mirror of the drawing one, not a different sail
    // (to the twist, which migrates the draft the other way when backed)
    expect(pt(0.5, 0, -0.6)[2] / -pt(0.5, 0, 0.6)[2]).toBeCloseTo(1, 1);
  });

  it('TWO SAILS braced differently in the SAME wind are visibly different sails', () => {
    // beam reach, 15 kn apparent: the crew's own brace vs half of it vs square.
    // `braceGain` is the hull's own number (shipKinematics, §V.77), so the
    // cloth and the thrust flatten together. Measured 0.81 / 0.47 / 0.00.
    const gamma = Math.PI / 2;
    const at = (beta: number): number =>
      sailDrive(
        {
          forwardX: Math.sin(beta), forwardZ: Math.cos(beta),
          shipForwardX: 0, shipForwardZ: 1,
          windDirection: gamma, windSpeed: 15 * KN, yawRate: 0,
        },
        shipMaterialParams,
      ).drive;
    const best = at(autoBrace(gamma));
    const half = at(autoBrace(gamma) / 2);
    const square = at(0);
    expect(best).toBeGreaterThan(half + 0.1);
    expect(half).toBeGreaterThan(square + 0.1);
    // and the difference reaches the CLOTH, not just the number
    expect(pt(0.5, 0, best)[2] - pt(0.5, 0, half)[2]).toBeGreaterThan(0.02 * WIDTH);
  });
});

describe('§T.85 — SHAPE: a membrane bent to the yard, sheeted at the clews, free everywhere else', () => {
  it('the belly is LOW: the foot centre stands further forward than mid-height, the head not at all', () => {
    // measured (chord %): foot 17.3, mid-height 14.6, v=0.9 4.1, head 0
    const foot = pt(0.5, 0, 1)[2];
    const mid = pt(0.5, 0.5, 1)[2];
    const head = pt(0.5, 1, 1)[2];
    expect(head).toBeCloseTo(0, 9);
    expect(foot).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(0.5 * foot);
    // the realised peak sits in the LOWEST QUARTER (the clews' grip lifts it
    // just off the foot edge, measured v ≈ 0.04), and above it the centre
    // line comes back to the yard monotonically: no dome in the middle
    const zs = Array.from({ length: 41 }, (_, j) => pt(0.5, j / 40, 1)[2]);
    const arg = zs.indexOf(Math.max(...zs));
    expect(arg / 40).toBeLessThan(0.25);
    for (let j = arg + 1; j < zs.length; j++) expect(zs[j]).toBeLessThanOrEqual(zs[j - 1] + 1e-9);
  });

  it('the LEECH flies forward between yardarm and clew — the edges are not pinned flat', () => {
    // measured 0.45 m (3.7% of chord) at mid-leech, both sides
    for (const u of [0, 1]) {
      expect(pt(u, 0.5, 1)[2]).toBeGreaterThan(0.02 * WIDTH);
      expect(Math.abs(pt(u, 0, 1)[2])).toBeLessThan(1e-6); // the clew is sheeted
      expect(Math.abs(pt(u, 1, 1)[2])).toBeLessThan(1e-6); // the yardarm
      expect(pt(u, 0.5, 0)[2]).toBeCloseTo(0, 9); // and it is the WIND that does it
    }
    // the foot between the clews is one clean arc: rising to a single maximum
    const zs = Array.from({ length: 41 }, (_, i) => pt(i / 40, 0, 1)[2]);
    const arg = zs.indexOf(Math.max(...zs));
    for (let i = 1; i <= arg; i++) expect(zs[i]).toBeGreaterThanOrEqual(zs[i - 1] - 1e-9);
    for (let i = arg + 1; i < zs.length; i++) expect(zs[i]).toBeLessThanOrEqual(zs[i - 1] + 1e-9);
    expect(zs[arg] / WIDTH).toBeGreaterThan(0.1); // a real camber at the foot (10-15%+)
  });

  it('the deepest cloth is within 10% of what the cut excess allows — no more, no less', () => {
    // the belly is the EXCESS showing: √(e/COEFF) of chord (measured 0.977 of it)
    const implied = Math.sqrt(P_CUT.sailClothExcess / SAIL_ARC_COEFF);
    expect(peakDepth(1) / WIDTH).toBeGreaterThan(0.9 * implied);
    expect(peakDepth(1) / WIDTH).toBeLessThanOrEqual(1.02 * implied);
  });

  it('SLACK canvas hangs in folds that the wind takes OUT', () => {
    const folded = { ...P_CUT, sailSlackFold: shipMaterialParams.sailSlackFold };
    const at = (d: number, u: number, v: number): number =>
      sailClothPoint(u, v, WIDTH, DROP, st(d), folded)[2];
    // becalmed is not flat…
    let slackAmp = 0;
    for (let i = 0; i <= 40; i++) slackAmp = Math.max(slackAmp, Math.abs(at(0, i / 40, 0.2)));
    expect(slackAmp).toBeGreaterThan(0.05);
    // …the folds are zero at the head and die at the sheeted clews…
    expect(Math.abs(at(0, 0.3, 1))).toBeLessThan(1e-9);
    expect(Math.abs(at(0, 0, 0))).toBeLessThan(1e-9);
    expect(Math.abs(at(0, 1, 0))).toBeLessThan(1e-9);
    // …and a full sail has none: the shape at drive 1 is the membrane alone
    for (let i = 0; i <= 40; i++) {
      expect(at(1, i / 40, 0.2)).toBeCloseTo(pt(i / 40, 0.2, 1)[2], 9);
    }
  });

  it('the FLUTTER fades as she fills: a drum-tight sail does not ripple', () => {
    const flap = { ...P_CUT, sailFlutterAmp: shipMaterialParams.sailFlutterAmp };
    const z = (d: number, phase: number): number =>
      sailClothOffset(0.5, 0.2, WIDTH, DROP, { ...st(d), luff: 1, flutterPhase: phase }, flap);
    const ripple = (d: number): number => Math.abs(z(d, 0) - z(d, Math.PI));
    expect(ripple(0)).toBeGreaterThan(0.05); // luffing, slack: shaking
    expect(ripple(0.5)).toBeLessThan(ripple(0));
    expect(ripple(1)).toBeCloseTo(0, 9); // full: still
  });

  it('is NaN-safe at every input (§V.28) — a NaN here is a NaN rope and a NaN vertex', () => {
    const bad = sailDrive(
      { forwardX: NaN, forwardZ: NaN, shipForwardX: NaN, shipForwardZ: NaN, windDirection: NaN, windSpeed: NaN, shipVelX: NaN, shipVelZ: NaN, yawRate: NaN },
      shipMaterialParams,
    );
    expect(Number.isFinite(bad.drive)).toBe(true);
    expect(Number.isFinite(bad.luff)).toBe(true);
    const nanState: SailClothState = {
      drive: NaN, luff: NaN, skew: NaN, dropScale: NaN, flutterPhase: NaN,
      sheetLeadPort: [NaN, NaN, NaN], sheetLeadStarboard: [NaN, NaN, NaN],
    };
    for (const q of [
      sailClothPoint(NaN, NaN, NaN, NaN, nanState, P_CUT),
      sailClothPoint(0.5, 0.2, WIDTH, DROP, nanState, { ...P_CUT, sailLeechOpen: NaN, sailSlackFold: NaN, sailClothExcess: NaN }),
      sailClothPoint(-3, 7, 0, -1, st(Infinity), P_CUT),
    ]) {
      for (const x of q) expect(Number.isFinite(x)).toBe(true);
    }
  });
});
