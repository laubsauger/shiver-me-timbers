/**
 * WHAT THE V-39 CAN DO, MEASURED (§T.186, tech-research §5.3). Committed output of `measure.ts#measureCapability`
 * — the real `HullWater` + `stepRigid6` on flat water, default params, the engine + prop model (T189 engine.ts; re-measured
 * T196: the stand-in thrust's 29.5 m/s top speed and 7.8 m/s² hole shot are gone; radiation damping, drives in the transom
 * wake and the prop calibrated at running immersion re-measured too).
 * Turning columns re-measured 2026-09-16 after separating topsides from planing bottoms.
 * `tests/raceAiCapability.test.ts` re-measures and fails when the physics moves away from these numbers: then
 * paste the new `measureCapability()` output here (the printed JSON is exactly `MEASURED`).
 *
 * Pure data + interpolation. No physics import, so the worker bundle carries only the table.
 *
 * Steer convention: the tables are in drive-angle MAGNITUDE. A positive drive angle turns the bow to PORT
 * (yaw rate < 0, measured `yawSign` −1; hullWater `setControls`: "+ turns the bow toward body −x").
 */

export const MEASURED = {
  topSpeed: 33.912,
  accel: [[4, 3.3127], [6, 4.1225], [8, 3.9423], [10, 3.4166], [12, 3.2936], [14, 3.3634], [16, 3.3003], [18, 3.0976], [20, 2.86], [22, 2.5858], [24, 2.1529], [26, 1.7537], [27, 1.5673], [28, 1.3664], [29, 1.1535], [30, 0.93284], [31, 0.7071], [32, 0.47172], [33, 0.22869]],
  coast: [[4, 1.6337], [6, 0.87944], [8, 1.1477], [10, 1.311], [12, 1.3825], [14, 1.4374], [16, 1.5308], [18, 1.665], [20, 1.8525], [22, 2.074], [24, 2.3258], [26, 2.5642], [27, 2.6789], [28, 2.7985], [29, 2.9204], [30, 3.0267], [31, 3.1706], [32, 3.3494], [33, 3.3382]],
  reverse: [[4, 1.7377], [6, 0.98961], [8, 1.253], [10, 1.4156], [12, 1.4884], [14, 1.5451], [16, 1.6393], [18, 1.7759], [20, 1.9614], [22, 2.184], [24, 2.4348], [26, 2.6774], [27, 2.7905], [28, 2.9071], [29, 3.0206], [30, 3.1198], [31, 3.2409], [32, 3.4026], [33, 3.3733]],
  turns: [
    { steerDeg: 0, rows: [[5.9995, 2.9035e-08, 0.50051], [9.9938, 6.8816e-08, 0.59939], [13.994, 2.254e-07, 0.6245], [17.992, 4.6173e-07, 0.66465], [21.989, 1.7502e-07, 0.73343], [25.986, 3.0494e-08, 0.81744], [29.983, 1.4722e-07, 0.90351], [33.838, 1.7417e-07, 1.0]] },
    { steerDeg: 5, rows: [[5.9964, 0.011653, 0.50558], [10.0, 0.0069959, 0.58148], [13.993, 0.0050485, 0.62484], [17.988, 0.0040927, 0.6804], [21.982, 0.0037055, 0.75795], [25.978, 0.0032606, 0.84846], [29.972, 0.0028413, 0.94422], [32.239, 0.0026439, 1.0]] },
    { steerDeg: 10, rows: [[5.9913, 0.019858, 0.51858], [9.996, 0.013158, 0.59804], [13.986, 0.0096913, 0.65271], [17.973, 0.0085203, 0.73134], [21.963, 0.0077638, 0.82583], [25.955, 0.0069275, 0.93794], [28.104, 0.0065185, 1.0], [28.439, 0.0064452, 1.0]] },
    { steerDeg: 15, rows: [[5.9835, 0.02983, 0.53772], [9.9866, 0.019035, 0.63919], [13.97, 0.014241, 0.71143], [17.949, 0.012319, 0.81423], [21.948, 0.011307, 0.9639], [22.97, 0.011012, 1.0], [23.38, 0.010924, 1.0], [23.679, 0.010874, 1.0]] },
    { steerDeg: 19, rows: [[5.9727, 0.038574, 0.56123], [9.9779, 0.024116, 0.68732], [13.965, 0.018007, 0.77975], [17.921, 0.015139, 0.9338], [19.577, 0.014287, 1.0], [19.967, 0.01405, 1.0], [20.235, 0.013866, 1.0], [20.383, 0.013651, 1.0]] },
  ],
} as const;

/** chine beam, m (deepV12.hull.json `chineHalfBeam` × 2) — the C_v the physics-log envelope is stated in */
export const CHINE_BEAM = 2.3;
export const DEG = Math.PI / 180;

type Pairs = readonly (readonly [number, number])[];

function interp(t: Pairs, x: number): number {
  if (x <= t[0][0]) return t[0][1];
  const n = t.length - 1;
  if (x >= t[n][0]) return t[n][1];
  let k = 1;
  while (t[k][0] < x) k++;
  const [x0, y0] = t[k - 1];
  const [x1, y1] = t[k];
  return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
}

/** column c, field f (1 = curvature, 2 = throttle), interpolated in steady speed and clamped at the ends */
function column(c: number, f: 1 | 2, v: number): number {
  const rows = MEASURED.turns[c].rows;
  if (v <= rows[0][0]) return rows[0][f];
  const n = rows.length - 1;
  if (v >= rows[n][0]) return rows[n][f];
  let k = 1;
  while (rows[k][0] < v) k++;
  const a = rows[k - 1];
  const b = rows[k];
  return a[f] + ((b[f] - a[f]) * (v - a[0])) / (b[0] - a[0]);
}

const STEER_COLS = MEASURED.turns.map((t) => t.steerDeg * DEG);
/** the largest drive angle the table covers; the lock schedule never asks for more */
export const TABLE_MAX_STEER = STEER_COLS[STEER_COLS.length - 1];

/** steady path curvature (1/m, magnitude) at speed v with the drives at |steer| rad */
export function curvatureAt(v: number, steer: number): number {
  const d = Math.min(Math.abs(steer), TABLE_MAX_STEER);
  let c = 1;
  while (c < STEER_COLS.length - 1 && STEER_COLS[c] < d) c++;
  const d0 = STEER_COLS[c - 1];
  const d1 = STEER_COLS[c];
  const k0 = c - 1 === 0 ? 0 : column(c - 1, 1, v);
  const k1 = column(c, 1, v);
  return k0 + ((k1 - k0) * (d - d0)) / (d1 - d0);
}

/** drive angle (rad, magnitude) that holds curvature |kappa| at speed v; saturates at TABLE_MAX_STEER */
export function steerForCurvature(v: number, kappa: number): number {
  const k = Math.abs(kappa);
  let prevK = 0;
  for (let c = 1; c < STEER_COLS.length; c++) {
    const kc = column(c, 1, v);
    if (k <= kc) return STEER_COLS[c - 1] + ((STEER_COLS[c] - STEER_COLS[c - 1]) * (k - prevK)) / Math.max(1e-9, kc - prevK);
    prevK = kc;
  }
  return TABLE_MAX_STEER;
}

/** throttle that holds speed v at drive angle |steer| (measured hold loop), may exceed 1 ⇒ not holdable */
export function holdThrottle(v: number, steer: number): number {
  const d = Math.min(Math.abs(steer), TABLE_MAX_STEER);
  let c = 1;
  while (c < STEER_COLS.length - 1 && STEER_COLS[c] < d) c++;
  const t0 = column(c - 1, 2, v);
  const t1 = column(c, 2, v);
  return t0 + ((t1 - t0) * (d - STEER_COLS[c - 1])) / (STEER_COLS[c] - STEER_COLS[c - 1]);
}

/** steady speed at full throttle with the drives held at |steer| (the drag of the turn is the limit) */
export function turnTopSpeed(steer: number): number {
  const d = Math.min(Math.abs(steer), TABLE_MAX_STEER);
  const tops = MEASURED.turns.map((t, c) => [STEER_COLS[c], t.rows[t.rows.length - 1][0]] as const);
  return interp(tops, d);
}

/** full-throttle acceleration (m/s²) at v, shifted so it reaches 0 at the turn's own top speed */
export function accelAt(v: number, steer = 0): number {
  const shift = MEASURED.topSpeed - turnTopSpeed(steer);
  return v + shift >= MEASURED.topSpeed ? 0 : interp(MEASURED.accel, v + shift);
}

/** deceleration (m/s², positive) at v: `brake` 0 = throttle off (coast), 1 = full reverse (−0.3) */
export function decelAt(v: number, brake: number): number {
  const c = interp(MEASURED.coast, v);
  return c + (interp(MEASURED.reverse, v) - c) * Math.max(0, Math.min(1, brake));
}

/**
 * THE NPC LOCK SCHEDULE (rad), the no-hook guarantee. Measured with `measureLockEntry` (full throttle held
 * through the entry, 15°/s helm = HELM_RATE — worse than the controller ever does). Re-derived T196 (peak tilt °,
 * D = departed; default drives):
 *   6 m/s:  15° 30, 17.5° 40, 20° 44, 22.5° D          10 m/s: 20° 34, 25° 42, 30° D
 *   14–33 m/s: 20° 15–22, 25° 22–41, 30° D
 *   4 MW (C_v 6–10): 20° steady (tilt 15–19°); 25° departs at C_v 6/7/10, 27.5° at C_v 8.
 * History: T186 (stand-in thrust) 12.5° was the edge from 10 m/s; T196 part A (T189 physics) 20–25°; the drives now running
 * in the transom wake (hullWater `transomWake`: gearcases part-surfaced at speed) moved the edge to 30°.
 * Hence 14.5° at walking speed (tilt), ramping to 19° by 10 m/s and 19° above.
 * Bottom-only planing (2026-09-16): the same schedule peaks at 15–26° tilt; 1.6× now stays upright on stock drives.
 * The 4 MW stress mutation at 1.5× still departs at C_v 7/8/10, so the limit remains conservative and non-vacuous.
 */
export function lockLimit(v: number): number {
  const lo = 14.5 * DEG;
  const hi = 19 * DEG;
  if (v <= 6) return lo;
  if (v < 10) return lo + ((hi - lo) * (v - 6)) / 4;
  return hi;
}

export const TOP_SPEED: number = MEASURED.topSpeed;

/**
 * NPC helm slew, rad/s. 15°/s, not the 30°/s the physics envelope was stated at: measured (drop-in at planing speed,
 * helm to 12.5° at full throttle), 30°/s peaks at 30–39° tilt while the hull is still heaving, 15°/s at 22–26°;
 * settled lock-to-lock reversals peak ≤ 20° at either rate (docs/speedboat/npc-ai.md).
 */
export const HELM_RATE = (15 * Math.PI) / 180;
