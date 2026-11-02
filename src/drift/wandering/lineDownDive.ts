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
  /** whether the eye's own way stops at the bottom (A: the descent's drift onto the rest taken back, so it hangs under
   * the raft's near side); a later dip rides on with the sailing raft instead (A2, B) */
  hang: true,
  /** m/s at the entry and the surfacing (the sign is the direction) */
  vDown: -4.5,
  vUp: 1.8,
  /** s either side of a nominal crossing the trough is looked for in, and the step it is looked for at */
  search: 1.2,
  step: 0.02,
};

export type DiveSpec = Omit<typeof DIVE, 'glide' | 'hang'> & { glide: [number, number]; hang: boolean; bandTime?: number; rest?: number };

/**
 * A2, PACED (`?linedown=paced`; the user, 2026-11-02, on A: "too abrupt: we barely get to realize there's a raft, then
 * we're suddenly underwater and don't get to appreciate that either, and then we're suddenly ripped above water …
 * slowing down, showing it, then dipping down, then giving it a nice little breather underwater, and then coming back
 * out" — and "not sure it has to be 15, but like 12"). The descent is the approved one to 327 s: it slows onto the
 * raft (7.7 m up at 325 s, 4.5 m at 328 s, the raft ahead in view from ~321 s), and from 327 s, still easing down, the eye
 * goes on down through the surface at ~1.8 m/s (~330.8 s; eased before and after it, no plunge), glides under the raft's near side and hangs there
 * — ~12 s of calm (~333–345 s) while the sail goes up overhead (the hoist, 337–344 s, seen from below: its cloth's box in
 * the window, lineDownWindow.ts) and the raft gets way on — and comes up at ~1.8 m/s (~346 s; slower, the eye rode the last quarter-metre under the surface for two or three
 * frames, the ceiling edge-on — a dark blink on the dome, measured 88 → 66 → 98 of 255 at 1.2 m/s) onto the follow's own
 * path, alongside the raft under way, matched by 349 s. NO BEAT MOVES: the dip lives inside c1's follow (C1_FOLLOW 20 s,
 * 335–355 s), so the hoist, the way and c2 keep their music; what changes is that the hoist is seen from under the
 * water. (The brief allowed taking a few seconds from c2's sunset frames; it was not needed.)
 */
export const DIVE_PACED: DiveSpec = { ...DIVE, from: -28, down: -24.5, bottom: -19, up: -10, to: -6, depth: 6.5, vDown: -1.8, vUp: 1.8, glide: [0, 0], hang: false };
/**
 * B, LATE (`?linedown=late`; the user, 2026-11-02: "first letting the people actually see the raft, and then doing the
 * dip afterwards, a bit closer to the actual dolphin action, before the sun gets too far down"). The landing is the
 * approved one; the dip is the latest the light allows. The Sun is time-lapsed from the landing's 11° to c2's 3° through
 * the follow (sea.ts LAPSE: 3–40 s into it, eased; computed from its two Suns, 2026-11-02): 11.0° at 340 s, 10.3° at
 * 345, 9.1° at 350, 7.5° at 355, 5.7° at 360, 4.1° at 365, 2.7° at 370, 1.6° at 385 — and 1.6 → −0.8° through c3 (the
 * dolphin's case at ~400 s: ~1°, the sunset the first look-dev found too dark under the water). So the dip ends by
 * ~358 s (≥6°): in at ~348.7 s (9.4°, at the sea's trough), ~9.3 s under, out at ~358.0 s (~6.4°), back on the sailing
 * path by 361.5 s. The dolphin leads it: it comes up beside
 * the raft as it gets under way and dives, and the eye follows (lineDown.ts LATE_DOLPHIN). c3 stays its surface scene.
 */
// (B's crossings at 1.8 m/s for the same reason as A2's: at 1.0 m/s up, 87 → 51 → 92 of 255 in three frames)
export const DIVE_LATE: DiveSpec = { ...DIVE, from: -10, down: -7.5, bottom: -2, up: 3.5, to: 6.5, depth: 6.5, vDown: -1.8, vUp: 1.8, glide: [0, 0], hang: false };

/**
 * A3 (`?linedown=a3`; the user, 2026-11-02, on A, A2 and B: "I like it paced, but A2 is a little too long … With A2
 * we're still dipping too fast: we're not giving the boat time to have an effect on the viewer … I do like the framing
 * on A … I really like seeing the furniture from under water"). The approved descent and landing in full — the raft
 * ahead from ~321 s, the eye easing onto its rest at 3 m by 335 s and drifting there, the raft and its crew held in
 * view ~17 s — then the dip from the rest itself.
 * ROUND 2 (the same evening, on A3's first clip: "we're falling down into the water way too hectic, way too fast … wait
 * a bit, a bit of time to breathe, then bring in the dolphins, and then go back up … no reason to be like 'oh, it's down
 * 10 metres'"): no plunge — a slow sink to the surface, eased in from the rest (in at ~338.5 s), a
 * (the sink eased from 333 s, as the landing settles: begun at 335 s it had to fall 3 m in 2.8 s, at up to 1.8 m/s,
 * the probe of A3's round-2 path) SHALLOW hang (3.5 m, not 7.5–8: the window ~4 m across the surface, the raft's near logs ~6 m off in it, the furniture
 * a few metres over the eye), a REST there (`rest`: 2 s still, eased in and out, a gentle sway — the user: "maybe we
 * can rest for a second or two at the bottom after we dove in"), the first ~5 s under with nothing but the water
 * (lineDown.ts A3_BREATHE), then the dolphins, and an unhurried rise (0.8 m/s at the surface, ~351.5 s) onto the
 * follow's path, matched by 357 s — two seconds into c2, where the follow runs on as one shot (one sea, no cut at the beat), so NO BEAT MOVES. The sail goes up
 * while we are under (the hoist, 337–344 s) and the eye comes up to the raft under sail, getting way on.
 */
/* (Through the surface itself, 1.2 m/s each way: at 0.7–0.8 m/s, A3's round-3 clip, the eye lingered with the surface
 * a hand's breadth off the lens for several frames — a dark wedge of the sheet edge-on, a flat blue frame — where at
 * 1.2 it is through in ~0.2 s, under the waterline's foam; the motion before and after it stays slow.) */
export const DIVE_A3: DiveSpec = { ...DIVE, from: -22, down: -16.5, bottom: -13.5, rest: 2, up: -3.5, to: 2, depth: 3.5, vDown: -1.2, vUp: 1.2, glide: [0, 0], hang: false, bandTime: 0.45 };

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
export function planDive(c2: number, drive: (t: number) => [number, number, number], sea: (x: number, z: number, t: number) => number, yaw = 0, spec: DiveSpec = DIVE): DivePlan {
  const from = c2 + spec.from;
  const to = c2 + spec.to;
  // (a slow crossing takes longer through the band: at 0.7 m/s, ~0.36 s each side)
  const bandTime = spec.bandTime ?? BAND_TIME;
  const driveY = (t: number): number => drive(t)[1];
  // THE GLIDE: the way past the descent's, in the rest's frame (right, ahead), out to `glide` by the bottom and back
  const bottom = c2 + spec.bottom;
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
  const gr = glideKeys(spec.glide[0], false);
  const ga = glideKeys(spec.glide[1], spec.hang);
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
    for (let t = nominal - spec.search; t <= nominal + spec.search + 1e-9; t += spec.step) {
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
    const bottom = c2 + spec.bottom;
    const kd: DiveKey = { t: down, y: seaAtEye(down), v: spec.vDown, a: 0 };
    const kb: DiveKey = { t: bottom, y: -spec.depth, v: 0, a: 0 };
    const ku: DiveKey = { t: up, y: seaAtEye(up), v: spec.vUp, a: 0 };
    // (`rest`: the eye held at the bottom that long, still — two keys, at rest, either end of it)
    const kr: DiveKey | null = spec.rest ? { t: bottom + spec.rest, y: -spec.depth, v: 0, a: 0 } : null;
    const kAfter = kr ?? kb;
    // the intermediate keys' accelerations: the speed's own slope across them (a Catmull–Rom estimate), so the
    // speed runs on through each key instead of kinking there (and none at a rest's ends: it eases in and out of it)
    kd.a = (kb.v - k0.v) / (kb.t - k0.t);
    if (!kr) kb.a = (ku.v - kd.v) / (ku.t - kd.t);
    ku.a = (k4.v - kAfter.v) / (k4.t - kAfter.t);
    return kr ? [k0, kd, kb, kr, ku, k4] : [k0, kd, kb, ku, k4];
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
      if (Math.abs(t - at) > bandTime && Math.abs(f) < BAND) return false;
    }
    return true;
  };
  const downs = troughs(c2 + spec.down);
  const ups = troughs(c2 + spec.up);
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
    if (Math.abs(t - keys[1].t) <= bandTime || Math.abs(t - keys[keys.length - 2].t) <= bandTime) continue;
    clearance = Math.min(clearance, Math.abs(over(keys, t)));
  }
  return {
    from,
    to,
    down: keys[1].t,
    up: keys[keys.length - 2].t,
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
 * dimmer light, over ADAPT_IN s after the entry (THE STEP AT EACH CROSSING: how the air comes back in). ADAPT_IN was 2.5 s in the first build: the first seconds under the
 * water were a dim, murky blue, and the user wanted the water "pretty immediately" at its beauty (2026-11-02, round 2);
 * 0.6 s is a quick opening of the eye, and going from the darker to the brighter it flashes nothing.
 */
export const ADAPT_IN = 0.6;
/**
 * THE STEP AT EACH CROSSING (round 2, measured on the row-8 seat clip without the first build's veil): the dome's mean
 * brightness fell 116 → 75 (of 255) in the one frame the eye went in, and rose 74 → 118 in the one it came up — the
 * whole dome 1.6× brighter at once. The water is darker than the air (its light is the window's, a 97° disc of sky),
 * so the eye's exposure meets each step: under the water it is never below WATER_FLOOR (the first frame under is
 * already opened up), it stays opened up to the surfacing (no ADAPT_OUT any more: closing the eye before the surface,
 * the first build's guard against a flash, made the water darkest exactly where the air broke in), and the air comes in
 * UNDER-exposed, at AIR_START, opening to 1 over AIR_IN s — the step comes up from below, never a flash. (A first try at
 * 1.3 under and 0.85 in the air still measured 68 → 108 on the display: AgX's curve is not linear.)
 */
export const WATER_FLOOR = 1.6;
export const AIR_START = 0.6;
export const AIR_IN = 1.2;
export function adaptAt(t: number, down: number, up: number, under: number): number {
  if (t <= down) return 1;
  if (t < up) return WATER_FLOOR + (under - WATER_FLOOR) * ease01((t - down) / ADAPT_IN);
  return AIR_START + (1 - AIR_START) * ease01((t - up) / AIR_IN);
}

/**
 * THE WATERLINE'S FOAM (0..1, lineDownVeil.ts) round each crossing: up over the last FOAM_DOWN[0] s before it, gone over
 * FOAM_DOWN[1] s after (and FOAM_UP the same coming up). Round 2 (2026-11-02): the first build's VEIL was up for 1–2 s
 * over the whole dome — "a gray screen with snow on it"; the foam is a band at the eye's level for a few tenths of a
 * second, the moment the surface passes through the eye, and nothing in the air before it.
 */
export const FOAM_DOWN: [number, number] = [0.12, 0.35];
export const FOAM_UP: [number, number] = [0.1, 0.3];
export function foamAt(t: number, down: number, up: number): number {
  const bump = (at: number, [rise, fall]: [number, number]): number => (t < at ? ease01((t - (at - rise)) / rise) : 1 - ease01((t - at) / fall));
  return Math.max(bump(down, FOAM_DOWN), bump(up, FOAM_UP));
}
