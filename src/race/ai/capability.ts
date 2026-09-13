/**
 * WHAT THE V-39 CAN DO, MEASURED (§T.186, tech-research §5.3). Committed output of `measure.ts#measureCapability`
 * — the real `HullWater` + `stepRigid6` on flat water, default params, the TEMPORARY stand-in thrust (T166).
 * `tests/raceAiCapability.test.ts` re-measures and fails when the physics moves away from these numbers: then
 * paste the new `measureCapability()` output here (the printed JSON is exactly `MEASURED`).
 *
 * Pure data + interpolation. No physics import, so the worker bundle carries only the table.
 *
 * Steer convention: the tables are in drive-angle MAGNITUDE. A positive drive angle turns the bow to PORT
 * (yaw rate < 0, measured `yawSign` −1; hullWater `setControls`: "+ turns the bow toward body −x").
 */

export const MEASURED = {
  topSpeed: 29.5,
  accel: [[4, 7.8021], [6, 7.1132], [8, 6.7951], [10, 6.7785], [12, 6.7698], [14, 5.9408], [16, 5.0875], [18, 3.5947], [20, 3.3734], [22, 2.1843], [24, 1.6019], [26, 1.0326], [27, 0.73299], [28, 0.43634], [29, 0.14416]],
  coast: [[4, 0.26266], [6, 0.87806], [8, 1.2036], [10, 1.3813], [12, 1.4848], [14, 1.5825], [16, 1.7244], [18, 1.9185], [20, 2.1632], [22, 2.4524], [24, 2.7884], [26, 3.1095], [27, 3.3164], [28, 3.4436], [29, 3.4136]],
  reverse: [[4, 2.6099], [6, 3.4093], [8, 3.6836], [10, 3.8474], [12, 3.9589], [14, 3.7658], [16, 3.6624], [18, 3.6578], [20, 3.745], [22, 3.902], [24, 4.103], [26, 4.3889], [27, 4.5133], [28, 4.5223], [29, 4.463]],
  turns: [
    { steerDeg: 0, rows: [[6.0057, 0.000023467, 0.10546], [10.003, 0.0000031069, 0.16694], [14.002, 1.2052e-7, 0.21702], [18, 6.1648e-7, 0.32894], [21.993, 6.7423e-7, 0.5081], [25.983, 5.9254e-7, 0.75209], [29.451, 5.0767e-7, 1]] },
    { steerDeg: 5, rows: [[6.0039, 0.009531, 0.10994], [10.003, 0.0071874, 0.16602], [14, 0.0051592, 0.22452], [17.993, 0.0040718, 0.34947], [21.982, 0.0035506, 0.54192], [25.964, 0.0031942, 0.80567], [28.665, 0.0028915, 1]] },
    { steerDeg: 10, rows: [[5.9979, 0.019445, 0.12428], [9.9914, 0.013625, 0.19862], [13.987, 0.0094527, 0.26411], [17.973, 0.0076402, 0.40982], [21.948, 0.0068514, 0.63278], [25.906, 0.0063256, 0.94324], [26.774, 0.0062131, 1]] },
    { steerDeg: 12.5, rows: [[5.9928, 0.024738, 0.13565], [9.9833, 0.016576, 0.221], [13.977, 0.011086, 0.29281], [17.959, 0.0087953, 0.44986], [21.924, 0.0079218, 0.69082], [25.607, 0.0075214, 1], [25.838, 0.00748, 1]] },
  ],
} as const;

const G = 9.81;
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
 * through the entry, 30°/s helm — worse than the controller ever does):
 *   default power, 6–29.5 m/s: 12.5° never departs (peak tilt 18.6–25.6° from 10 m/s up, 39.5° at 6 m/s);
 *   15° departs at 6 m/s; 17.5° departs at every speed.
 *   4 MW (C_v 6–10): 10° never departs; 12.5° departs from C_v 8; 15° from C_v 6.
 * physics-log envelope (T179 part 3): half lock (15°) hooks C_v ≥ 7, full lock (30°) C_v ≥ 3.
 * Hence: 10° at walking speed (tilt), 12.5° from 12 m/s to C_v 6.5, back to 10° by C_v 7.5 and above.
 */
export function lockLimit(v: number): number {
  const cv = v / Math.sqrt(G * CHINE_BEAM);
  const lo = 10 * DEG;
  const hi = 12.5 * DEG;
  if (v <= 6) return lo;
  if (v < 12) return lo + ((hi - lo) * (v - 6)) / 6;
  if (cv <= 6.5) return hi;
  if (cv >= 7.5) return lo;
  return hi + ((lo - hi) * (cv - 6.5)) / 1;
}

export const TOP_SPEED: number = MEASURED.topSpeed;

/**
 * NPC helm slew, rad/s. 15°/s, not the 30°/s the physics envelope was stated at: measured (drop-in at planing speed,
 * helm to 12.5° at full throttle), 30°/s peaks at 30–39° tilt while the hull is still heaving, 15°/s at 22–26°;
 * settled lock-to-lock reversals peak ≤ 20° at either rate (docs/speedboat/npc-ai.md).
 */
export const HELM_RATE = (15 * Math.PI) / 180;
