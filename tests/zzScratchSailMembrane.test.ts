/**
 * SCRATCH — §T.74 diagnosis. Measures the four observables of an inextensible
 * membrane against the CURRENT sailShape.ts. No assertions that gate anything;
 * this prints the before/after evidence.
 */
import { describe, it } from 'vitest';
import { shipMaterialParams } from '../src/params/ship';
import { sailClothPoint } from '../src/ship/sailShape';

const FLAT_SHEETS = {
  sheetLeadPort: [0, 0, 0] as [number, number, number],
  sheetLeadStarboard: [0, 0, 0] as [number, number, number],
};
const WIDTH = 12.17;
const DROP = 6.3;
// isolate the membrane: no flutter, no quilt ripple, no static roach cut
const P = { ...shipMaterialParams, sailFlutterAmp: 0, sailSeamQuilt: 0 };
const P_NOROACH = { ...P, sailFootRoach: 0 };
const P_CUT2 = P_NOROACH;

type V3 = [number, number, number];
const st = (drive: number) => ({
  drive, luff: 0, skew: 0, dropScale: 1, flutterPhase: 0, ...FLAT_SHEETS,
});
const pt = (u: number, v: number, drive: number, p = P): V3 =>
  sailClothPoint(u, v, WIDTH, DROP, st(drive), p);
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** arc length of the v = const strip, N segments */
function stripLenU(v: number, drive: number, N = 400, p = P): number {
  let L = 0;
  let prev = pt(0, v, drive, p);
  for (let i = 1; i <= N; i++) {
    const q = pt(i / N, v, drive, p);
    L += dist(prev, q);
    prev = q;
  }
  return L;
}
/** arc length of the u = const strip */
function stripLenV(u: number, drive: number, N = 400, p = P): number {
  let L = 0;
  let prev = pt(u, 0, drive, p);
  for (let i = 1; i <= N; i++) {
    const q = pt(u, i / N, drive, p);
    L += dist(prev, q);
    prev = q;
  }
  return L;
}

/** max perpendicular deviation of an edge polyline from its own end-to-end chord */
function edgeInset(a: V3, b: V3, sample: (t: number) => V3, N = 200): number {
  const ab: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = Math.hypot(...ab);
  let worst = 0;
  for (let i = 1; i < N; i++) {
    const q = sample(i / N);
    const aq: V3 = [q[0] - a[0], q[1] - a[1], q[2] - a[2]];
    const t = (aq[0] * ab[0] + aq[1] * ab[1] + aq[2] * ab[2]) / (len * len);
    const proj: V3 = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
    worst = Math.max(worst, dist(q, proj));
  }
  return worst;
}

/**
 * LOCAL SLACK at (u,v) along the u direction: (arc length over a window) /
 * (straight distance between the window's ends) − 1. Zero = locally straight
 * and taut; large = the cloth is bagging there. This is the direct expression
 * of "tension concentrates at the corners, the belly is slack".
 */
function slackU(u: number, v: number, drive: number, h = 0.06, p = P): number {
  const N = 40;
  const u0 = Math.max(0, u - h);
  const u1 = Math.min(1, u + h);
  let L = 0;
  let prev = pt(u0, v, drive, p);
  for (let i = 1; i <= N; i++) {
    const q = pt(u0 + ((u1 - u0) * i) / N, v, drive, p);
    L += dist(prev, q);
    prev = q;
  }
  const D = dist(pt(u0, v, drive, p), pt(u1, v, drive, p));
  return L / Math.max(1e-9, D) - 1;
}

function outline(drive: number, p = P) {
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  const N = 64;
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const q = pt(i / N, j / N, drive, p);
      xmin = Math.min(xmin, q[0]); xmax = Math.max(xmax, q[0]);
      ymin = Math.min(ymin, q[1]); ymax = Math.max(ymax, q[1]);
    }
  }
  // projected area of the panel in its own x-y plane, by summing quad cross
  // products — this is the SILHOUETTE area, the thing that must shrink as she
  // fills (§T.74d), and it is invariant to where the outline's extremes sit
  let area = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const a = pt(i / N, j / N, drive, p);
      const b = pt((i + 1) / N, j / N, drive, p);
      const c = pt((i + 1) / N, (j + 1) / N, drive, p);
      const d2 = pt(i / N, (j + 1) / N, drive, p);
      area += Math.abs((b[0] - a[0]) * (d2[1] - a[1]) - (b[1] - a[1]) * (d2[0] - a[0])) / 2;
      area += Math.abs((c[0] - b[0]) * (d2[1] - b[1]) - (c[1] - b[1]) * (d2[0] - b[0])) / 2;
    }
  }
  const footSpan = pt(1, 0, drive, p)[0] - pt(0, 0, drive, p)[0];
  return { span: xmax - xmin, height: ymax - ymin, area, footSpan };
}

const f = (x: number, n = 4) => x.toFixed(n);

describe('§T.74 DIAGNOSIS — current sailShape.ts', () => {
  const drives = [0, 0.25, 0.5, 0.75, 1];

  it('(a) is the cloth INEXTENSIBLE? strip arc length vs fill', () => {
    console.log('\n(a) CLOTH LENGTH CONSERVATION  [cut length at drive 0 = 1.0000]');
    console.log('  horizontal strips (length across the sail, m):');
    for (const v of [0, 0.25, 0.45, 0.7, 1]) {
      const L0 = stripLenU(v, 0, 400, P_NOROACH);
      const row = drives.map((d) => f(stripLenU(v, d, 400, P_NOROACH) / L0, 4)).join('  ');
      console.log(`    v=${v.toFixed(2)}  L0=${f(L0, 3)}m   ratio: ${row}`);
    }
    console.log('  vertical strips (length down the sail, m):');
    for (const u of [0, 0.25, 0.5, 0.75, 1]) {
      const L0 = stripLenV(u, 0, 400, P_NOROACH);
      const row = drives.map((d) => f(stripLenV(u, d, 400, P_NOROACH) / L0, 4)).join('  ');
      console.log(`    u=${u.toFixed(2)}  L0=${f(L0, 3)}m   ratio: ${row}`);
    }
    console.log('  drives:                                    ' + drives.map((d) => f(d, 2).padEnd(6)).join(''));
  });

  it('(b) do the FOOT and LEECHES pull inward in catenaries?', () => {
    console.log('\n(b) FREE-EDGE INSET — IN THE SILHOUETTE (the x-y outline), roach OFF');
    console.log('    footRise  = how far the foot climbs above the clew-to-clew line at its worst');
    console.log('    leechIn   = how far the leech draws in from the yardarm-to-clew line');
    for (const d of drives) {
      const cp = pt(0, 0, d, P_NOROACH);
      const cs = pt(1, 0, d, P_NOROACH);
      const footRise = edgeInset(
        [cp[0], cp[1], 0], [cs[0], cs[1], 0],
        (t) => { const q = pt(t, 0, d, P_NOROACH); return [q[0], q[1], 0]; },
      );
      const ya = pt(0, 1, d, P_NOROACH);
      const leechIn = edgeInset(
        [ya[0], ya[1], 0], [cp[0], cp[1], 0],
        (t) => { const q = pt(0, 1 - t, d, P_NOROACH); return [q[0], q[1], 0]; },
      );
      console.log(
        `    drive=${f(d, 2)}  footRise=${f(footRise, 4)}m (${f((100 * footRise) / WIDTH, 2)}% of chord)` +
        `   leechIn=${f(leechIn, 4)}m (${f((100 * leechIn) / DROP, 2)}% of drop)`,
      );
    }
    console.log('  foot outline y(u) at drive=1 (roach off), relative to the clew:');
    const cy = pt(0, 0, 1, P_NOROACH)[1];
    console.log('    ' + [0, 0.05, 0.1, 0.2, 0.35, 0.5].map((u) =>
      `u=${u}:${f(pt(u, 0, 1, P_NOROACH)[1] - cy, 3)}`).join('  '));
  });

  it('(margins) the property-test bars', () => {
    const peak = (() => { let z=0; for(let i=0;i<=48;i++) for(let j=0;j<=48;j++) z=Math.max(z, pt(i/48,j/48,1,P_CUT2)[2]); return z; })();
    const ray = (t: number) => pt(t*0.5, t*0.5, 1, P_CUT2)[2];
    console.log(`
(MARGINS) ray(0.05)/peak = ${f(ray(0.05)/peak,4)} (bar <0.08, HEAD 0.1014)`);
    console.log(`          ray(0.10)/peak = ${f(ray(0.1)/peak,4)} (bar <0.15)`);
    const z=(u:number,d:number)=>pt(u,0,d,P_CUT2)[2];
    for (const d of [0.5,1]) console.log(`          drive=${d}: z(.1)/z(.05)=${f(z(0.1,d)/z(0.05,d),3)}  z(.05)/z(.025)=${f(z(0.05,d)/z(0.025,d),3)} (bar >2.2, HEAD 1.84)`);
    console.log(`          peak/WIDTH = ${f(peak/WIDTH,4)} (bar >0.1)`);
  });

  it('(c2) corner flatness and radial straightness', () => {
    // the ray from the port clew toward the sail's centre, in the CUT panel's
    // own metres — (u, v) = t·(0.5, 0.5), so t is the fraction of the way in
    const ray = (t: number, d: number, pp = P_NOROACH): V3 => pt(t * 0.5, t * 0.5, d, pp);
    const peak = (d: number, pp = P_NOROACH): number => {
      let z = 0;
      for (let i = 0; i <= 40; i++) for (let j = 0; j <= 40; j++) z = Math.max(z, pt(i / 40, j / 40, d, pp)[2]);
      return z;
    };
    console.log('\n(c2) DEPTH SURVIVING NEAR THE CLEW, as a fraction of the sail\'s own peak');
    for (const g of [0, 0.09, 0.18, 0.3, 0.45]) {
      const pp = { ...P_NOROACH, sailCornerGrip: g };
      const pk = peak(1, pp);
      const row = [0.02, 0.05, 0.1, 0.2]
        .map((t) => `t=${t}:${f((100 * ray(t, 1, pp)[2]) / pk, 1)}%`).join('  ');
      console.log(`    grip=${f(g, 2)}  peak=${f(pk, 3)}m   ${row}`);
    }
    console.log('  RADIAL STRAIGHTNESS: deviation of the cloth along that ray from');
    console.log('  its own chord, over the first 20% — a taut corner is nearly RULED');
    for (const g of [0, 0.09, 0.18, 0.3, 0.45]) {
      const pp = { ...P_NOROACH, sailCornerGrip: g };
      const a = ray(0, 1, pp);
      const b = ray(0.2, 1, pp);
      const dev = edgeInset(a, b, (t) => ray(t * 0.2, 1, pp), 60);
      console.log(`    grip=${f(g, 2)}  deviation=${f(dev, 4)}m  = ${f((100 * dev) / dist(a, b), 2)}% of the segment`);
    }
  });

  it('(c) does TENSION concentrate at the corners?', () => {
    console.log('\n(c) LOCAL SLACK  (arc/chord − 1 over a ±0.06u window; 0 = taut & straight)');
    for (const d of [0.5, 1]) {
      const corner = slackU(0.08, 0.03, d, 0.06, P_NOROACH);
      const nearClew = slackU(0.15, 0.08, d, 0.06, P_NOROACH);
      const belly = slackU(0.5, 0.45, d, 0.06, P_NOROACH);
      const midfoot = slackU(0.5, 0.0, d, 0.06, P_NOROACH);
      console.log(
        `    drive=${f(d, 2)}  clew(0.08,0.03)=${f(corner, 5)}  near(0.15,0.08)=${f(nearClew, 5)}` +
        `  belly(0.5,0.45)=${f(belly, 5)}  midfoot(0.5,0)=${f(midfoot, 5)}`,
      );
      console.log(`             belly/clew slack ratio = ${f(belly / Math.max(1e-9, corner), 2)}`);
    }
    console.log('  normal displacement z along the foot (v=0), drive=1:');
    console.log(
      '    ' +
      [0, 0.05, 0.1, 0.2, 0.35, 0.5].map((u) => `u=${u}:${f(pt(u, 0, 1, P_NOROACH)[2], 3)}`).join('  '),
    );
    console.log('  z along the diagonal from the port clew toward the centre, drive=1:');
    console.log(
      '    ' +
      [0.02, 0.05, 0.1, 0.2, 0.35, 0.5]
        .map((t) => `t=${t}:${f(pt(t, t * 0.52, 1, P_NOROACH)[2], 3)}`)
        .join('  '),
    );
  });

  it('(d) does the PROJECTED SPAN shrink as she fills?', () => {
    console.log('\n(d) PROJECTED OUTLINE vs fill (roach off)');
    const o0 = outline(0, P_NOROACH);
    for (const d of drives) {
      const o = outline(d, P_NOROACH);
      console.log(
        `    drive=${f(d, 2)}  span=${f(o.span, 4)}m (${f((100 * (o.span / o0.span - 1)), 2)}%)` +
        `   footSpan=${f(o.footSpan, 4)}m (${f(100 * (o.footSpan / o0.footSpan - 1), 2)}%)` +
        `   height=${f(o.height, 4)}m (${f(100 * (o.height / o0.height - 1), 2)}%)` +
        `   AREA=${f(o.area, 3)}m² (${f(100 * (o.area / o0.area - 1), 2)}%)`,
      );
    }
    console.log('  clew corner travel (u=1,v=0) from becalmed to full:');
    const a = pt(1, 0, 0, P_NOROACH);
    const b = pt(1, 0, 1, P_NOROACH);
    console.log(`    ${a.map((x) => f(x, 3)).join(', ')}  ->  ${b.map((x) => f(x, 3)).join(', ')}   |Δ|=${f(dist(a, b), 4)}m`);
  });
});
