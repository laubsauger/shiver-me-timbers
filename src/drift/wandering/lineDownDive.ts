/**
 * THE DIVE OF THE DAYLIGHT LINE DOWN (`?linedown=day`, lineDown.ts): the descent's last eighteen seconds re-blocked so
 * the eye does not stop three metres over the sea but goes on down INTO it, glides under the flood's debris, and comes
 * back up to the very place, height and moment the landing comes to rest — the frame c1's follow starts from — so the
 * cut to c1 is no cut at all. Built after the 2026-11-02 review of the look-dev ("water scenes start to look
 * interesting, some more polish and lets go"), where the eye simply WAS under the water from 319 to 335 s: a cut in
 * and a cut out.
 *
 * WHAT IS RE-BLOCKED, AND WHAT IS NOT. The eye's place, from `from` (315 s, in the hand-over's 3 s crossfade into the
 * sea's scene: the re-block leaves the descent with its height, speed and acceleration, so by 317 s, where Act 2's
 * scene is gone, the two eyes differ by ~1 m at ~55 m up) to `to` (335 s, where c1's follow begins): its height dives,
 * its way over the ground glides (THE GLIDE). Its turn (the flare's last few degrees up to level, done by ~330 s) is the
 * descent's own, untouched — so before 315 s nothing changes (the continuous dive of 367627d), and at 335 s the eye is
 * where, and as, it always was.
 *
 * THE GLIDE, AND WHY NOT RIGHT UNDER THE RAFT (the look-dev's shot: 5 m behind the raft's centre, 4.5 m down, its logs
 * overhead). The landing comes to rest 18 m from the raft (sea.ts RAFT_DISTANCE), ahead and 15° right, and the
 * descent's track only ever moves forward onto that rest. Kept to that track (this file's first build), the eye met the
 * raft 20 m off through the water — and the first stills (2026-11-02, linedown_build_r1/r2) showed nothing there: a
 * raft's dark logs seen across 20 m of sunlit water, against the dark ceiling outside the window, are lost in the
 * shafts' haze. So the eye's way is carried on: the descent's forward glide (5.6 m/s at 315 s) does not brake onto
 * the rest but runs on under the water to ~8 m past it (`glide`), and hangs there, 7–8 m down, ~10 m short of the
 * raft's centre — its near logs inside the window's rim, its rig refracted in the window above them — then drifts
 * back as it rises, through the surface, onto the rest at 335 s. One turn of its way (forward → hang → back, at most
 * ~1.8 m/s back, its acceleration under 1.6 m/s² throughout): not the "back and forth" of the 2026-10-30 review
 * (a track that surged, stopped dead and slid back in two seconds), but its cost is a pull-back to review from the
 * seats. Right under the raft would need ~17 m more glide and twice the speed back, or the rest moved (sea.ts, the
 * whole follow with it).
 *
 * THE CROSSINGS. A level sea projects to the dome's horizon, so going through it changes the whole dome at once: sky
 * and sea above and below become window, ceiling and deep. Each crossing is therefore made
 *   - FAST, ~3.5 m/s down and ~1.8 m/s up, so the eye is within the ocean's waterline band (params
 *     undersideEyeBand, ±0.25 m: where the face, not the eye, picks top or underside) for well under a tenth of a
 *     second, under a veil of bubbles and foam (lineDownVeil.ts) that is up for 1–2 s;
 *   - ONCE: timed to a TROUGH of the wave at the eye's own place (the CpuOcean the rafts float on, the sea the GPU
 *     draws: §V.8). Down at a trough, the water then rises round the eye as it goes on down; up at a trough, the water
 *     falls away from it as it comes up, and the next crest is a swell-period away. Crossing on a crest's flank, a
 *     rising sea can meet a rising eye twice — the dome flipping over and back, a strobe. `planDive` searches the
 *     sea's own heights for the trough nearest each nominal time and checks that the eye crosses the drawn surface
 *     exactly once there, with the band cleared within `BAND_TIME` s either side: a pure function of the sea, so every
 *     frame of every lane agrees on it.
 *   - SMOOTH: the height is a chain of quintic Hermite segments through keys of height, speed and acceleration, so
 *     speed and acceleration are continuous everywhere (no lurch), and the first and last keys are the descent's own
 *     height, speed and acceleration.
 *
 * Every number here is in metres and seconds; times are the sea's clock (s from the hand-over), as beats.ts.
 */

/** one key of the eye's height: sea s, m above the mean sea, m/s, m/s² */
export interface DiveKey {
  t: number;
  y: number;
  v: number;
  a: number;
}

/**
 * THE DIVE'S SHAPE (s relative to c2's start, which is 355 s of the show; m; m/s; m/s²):
 *   from      317 s: the re-block starts (the end of the hand-over's crossfade)
 *   down      321.5 s nominal: the entry, at V_DOWN — the descent's last ~4 s still read as coming down to the sea
 *             (the water rising to meet it), not as a plunge from height
 *   bottom    326 s at DEPTH: the deepest, under the debris, the raft low ahead
 *   up        331.5 s nominal: the surfacing, at V_UP
 *   to        335 s: the descent's rest (3 m, still), c1's follow
 */
export const DIVE = {
  from: -40,
  down: -33,
  bottom: -28.5,
  up: -24,
  to: -20,
  /** m under the mean sea at the bottom: deep enough that the window (radius depth·tan 48.6° on the surface, 9 m)
   * spans the debris over the eye's few metres of way, and the raft's logs stand ~20° up ahead (atan(7.5/21)) instead
   * of lying on the horizon; shallow enough that the sea's blue holds (K_blue 0.02/m) and the climb back is gentle */
  depth: 8,
  /** m (right, ahead of the eye's rest frame) the eye's way is carried on past the descent's by the bottom: the
   * glide under the raft's near side (see THE GLIDE) */
  glide: [1.9, 12] as [number, number],
  /** m/s at the entry and the surfacing (the sign is the direction) */
  vDown: -4.5,
  vUp: 1.8,
  /** s either side of a nominal crossing the trough is looked for in, and the step it is looked for at */
  search: 1.2,
  step: 0.02,
};

/** m: the ocean's waterline band (params/oceanSurface undersideEyeBand) the crossing must clear */
export const BAND = 0.25;
/** s: the eye must be clear of the band this soon either side of a crossing (it is through it in ~0.07 s at 3.5 m/s) */
export const BAND_TIME = 0.35;

/** height at t on the quintic Hermite segment k0 → k1 */
export function quintic(k0: DiveKey, k1: DiveKey, t: number): number {
  const h = k1.t - k0.t;
  const s = Math.min(1, Math.max(0, (t - k0.t) / h));
  const s2 = s * s;
  const s3 = s2 * s;
  const s4 = s3 * s;
  const s5 = s4 * s;
  return (
    k0.y * (1 - 10 * s3 + 15 * s4 - 6 * s5) +
    k0.v * h * (s - 6 * s3 + 8 * s4 - 3 * s5) +
    k0.a * h * h * (0.5 * s2 - 1.5 * s3 + 1.5 * s4 - 0.5 * s5) +
    k1.a * h * h * (0.5 * s3 - s4 + 0.5 * s5) +
    k1.v * h * (-4 * s3 + 7 * s4 - 3 * s5) +
    k1.y * (10 * s3 - 15 * s4 + 6 * s5)
  );
}

/** the height at t along the keys (held at the ends) */
export function heightOn(keys: readonly DiveKey[], t: number): number {
  if (t <= keys[0].t) return keys[0].y;
  for (let i = 1; i < keys.length; i++) if (t <= keys[i].t) return quintic(keys[i - 1], keys[i], t);
  return keys[keys.length - 1].y;
}

/** the descent's height, speed and acceleration at t, by central differences of its height (m, s) */
export function keyOf(y: (t: number) => number, t: number, h = 0.05): DiveKey {
  const [a, b, c] = [y(t - h), y(t), y(t + h)];
  return { t, y: b, v: (c - a) / (2 * h), a: (c - 2 * b + a) / (h * h) };
}

export interface DivePlan {
  /** sea s: the re-block's span (the eye's height is the dive's from `from` to `to`) */
  from: number;
  to: number;
  /** sea s the eye goes through the drawn surface, down and up (each at a trough of the wave at the eye) */
  down: number;
  up: number;
  /** the keys: from, down, bottom, up, to */
  keys: DiveKey[];
  /** the eye's height (m) at sea s t, inside the span */
  y(t: number): number;
  /** the eye's place over the ground (x, z m) at sea s t: the descent's, carried on by the glide */
  xz(t: number): [number, number];
  /** the check: whether each crossing is single and clears the band in BAND_TIME, and the least clearance (m) the eye
   * keeps from the surface outside the crossings' BAND_TIME */
  check: { down: boolean; up: boolean; clearance: number };
}

/**
 * The dive for the beats at `starts` (c2's start, sea s): `drive(t)` the descent's eye (x, y, z m) at sea s t,
 * `sea(x, z, t)` the drawn sea's height there (m), `yaw` the rest's heading (rad, 0 looking toward −z: the frame the
 * glide is laid in). Pure: the same sea and drive give the same plan.
 */
export function planDive(c2: number, drive: (t: number) => [number, number, number], sea: (x: number, z: number, t: number) => number, yaw = 0): DivePlan {
  const from = c2 + DIVE.from;
  const to = c2 + DIVE.to;
  const driveY = (t: number): number => drive(t)[1];
  // THE GLIDE: the way past the descent's, in the rest's frame (right, ahead), out to `glide` by the bottom and back
  const bottom = c2 + DIVE.bottom;
  const f = [-Math.sin(yaw), -Math.cos(yaw)];
  const r = [Math.cos(yaw), -Math.sin(yaw)];
  const aheadOf = (t: number): number => {
    const [x, , z] = drive(t);
    return x * f[0] + z * f[1];
  };
  const glideKeys = (extra: number, stop: boolean): [DiveKey, DiveKey, DiveKey] => {
    // (ahead: at the bottom the eye's own way stops — the descent's drift onto the rest taken back — and hangs)
    const v = stop ? -(aheadOf(bottom + 0.05) - aheadOf(bottom - 0.05)) / 0.1 : 0;
    return [{ t: from, y: 0, v: 0, a: 0 }, { t: bottom, y: extra, v, a: 0 }, { t: to, y: 0, v: 0, a: 0 }];
  };
  const gr = glideKeys(DIVE.glide[0], false);
  const ga = glideKeys(DIVE.glide[1], true);
  const xz = (t: number): [number, number] => {
    const [x, , z] = drive(t);
    if (t <= from || t >= to) return [x, z];
    const right = heightOn(gr, t);
    const ahead = heightOn(ga, t);
    return [x + r[0] * right + f[0] * ahead, z + r[1] * right + f[1] * ahead];
  };
  const seaAtEye = (t: number): number => {
    const [x, z] = xz(t);
    return sea(x, z, t);
  };
  const k0 = keyOf(driveY, from);
  const k4 = keyOf(driveY, to);
  /** the troughs of the sea at the eye near `nominal`, nearest first */
  const troughs = (nominal: number): number[] => {
    const ts: number[] = [];
    const hs: number[] = [];
    for (let t = nominal - DIVE.search; t <= nominal + DIVE.search + 1e-9; t += DIVE.step) {
      ts.push(t);
      hs.push(seaAtEye(t));
    }
    const found: number[] = [];
    for (let i = 1; i < ts.length - 1; i++) if (hs[i] <= hs[i - 1] && hs[i] < hs[i + 1]) found.push(ts[i]);
    // (no trough within reach — a long swell's slope: the lowest point of the reach, at one of its ends)
    if (!found.length) found.push(ts[hs.indexOf(Math.min(...hs))]);
    return found.sort((a, b) => Math.abs(a - nominal) - Math.abs(b - nominal));
  };
  const build = (down: number, up: number): DiveKey[] => {
    const bottom = c2 + DIVE.bottom;
    const kd: DiveKey = { t: down, y: seaAtEye(down), v: DIVE.vDown, a: 0 };
    const kb: DiveKey = { t: bottom, y: -DIVE.depth, v: 0, a: 0 };
    const ku: DiveKey = { t: up, y: seaAtEye(up), v: DIVE.vUp, a: 0 };
    // the intermediate keys' accelerations: the speed's own slope across them (a Catmull–Rom estimate), so the
    // speed runs on through each key instead of kinking there
    kd.a = (kb.v - k0.v) / (kb.t - k0.t);
    kb.a = (ku.v - kd.v) / (ku.t - kd.t);
    ku.a = (k4.v - kb.v) / (k4.t - kb.t);
    return [k0, kd, kb, ku, k4];
  };
  /** f(t) = the eye over the drawn surface (m) for keys `keys` */
  const over = (keys: DiveKey[], t: number): number => heightOn(keys, t) - seaAtEye(t);
  /** a crossing at `at` in direction `sign` (−1 down) is single, and clear of the band beyond BAND_TIME */
  const clean = (keys: DiveKey[], at: number, sign: number): boolean => {
    for (let t = at - 1.5; t <= at + 1.5 + 1e-9; t += 0.01) {
      const f = over(keys, t) * sign;
      // (before the crossing the eye is on its first side, after it on the other: f < 0 before, > 0 after)
      if (t < at - 1e-6 && f > 0) return false;
      if (t > at + 1e-6 && f < 0) return false;
      if (Math.abs(t - at) > BAND_TIME && Math.abs(f) < BAND) return false;
    }
    return true;
  };
  const downs = troughs(c2 + DIVE.down);
  const ups = troughs(c2 + DIVE.up);
  let keys = build(downs[0], ups[0]);
  let ok = { down: false, up: false };
  search: for (const d of downs)
    for (const u of ups) {
      const k = build(d, u);
      const c = { down: clean(k, d, -1), up: clean(k, u, 1) };
      if (c.down && c.up) {
        keys = k;
        ok = c;
        break search;
      }
      if (!ok.down && !ok.up) {
        keys = k;
        ok = c;
      }
    }
  // the clearance outside the crossings: from the span's start to the entry, between them, and to its end
  let clearance = Infinity;
  for (let t = from; t <= to + 1e-9; t += 0.05) {
    if (Math.abs(t - keys[1].t) <= BAND_TIME || Math.abs(t - keys[3].t) <= BAND_TIME) continue;
    clearance = Math.min(clearance, Math.abs(over(keys, t)));
  }
  return {
    from,
    to,
    down: keys[1].t,
    up: keys[3].t,
    keys,
    y: (t) => heightOn(keys, t),
    xz,
    check: { ...ok, clearance },
  };
}

/** 0..1 eased (smoothstep) */
export const ease01 = (x: number): number => {
  const k = Math.min(1, Math.max(0, x));
  return k * k * (3 - 2 * k);
};

/**
 * THE EYE'S ADAPTATION ACROSS THE CROSSINGS (× the show's exposure): 1 in the air, `under` once adapted to the water's
 * dimmer light. Going down it comes up AFTER the entry, over ADAPT_IN s (the first second under the water is darker
 * than the air, as a camera's is, then the eye opens); coming up it goes back down BEFORE the surfacing, over
 * ADAPT_OUT s — eased the other way round the air would break through at 2× the exposure, a white flash over the
 * whole dome (the brief: "no hard flash").
 */
export const ADAPT_IN = 2.5;
export const ADAPT_OUT = 2.2;
export function adaptAt(t: number, down: number, up: number, under: number): number {
  if (t <= down || t >= up) return 1;
  const k = Math.min(ease01((t - down) / ADAPT_IN), ease01((up - t) / ADAPT_OUT));
  return 1 + (under - 1) * k;
}

/**
 * THE VEIL (0..1) over each crossing: the bubbles and foam the eye goes through. Down: up over the last VEIL_DOWN[0] s
 * above the water (the splash it makes), full through the band, gone over VEIL_DOWN[1] s under it as the bubbles rise
 * away; up: up over the last VEIL_UP[0] s under the surface (the bubbles it rises through, the bright aerated skin),
 * gone over VEIL_UP[1] s in the air (the water running off: 0.8 s in the first round, a beige haze over the whole
 * sunlit dome — the spray is brief).
 */
export const VEIL_DOWN: [number, number] = [0.35, 1.6];
export const VEIL_UP: [number, number] = [0.6, 0.5];
export function veilAt(t: number, down: number, up: number): number {
  const bump = (at: number, [rise, fall]: [number, number]): number =>
    t < at ? ease01((t - (at - rise)) / rise) : 1 - ease01((t - at - 0.08) / fall);
  return Math.max(bump(down, VEIL_DOWN), bump(up, VEIL_UP));
}
