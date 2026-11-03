/**
 * THE PLANKTON'S LIGHT, as the surf and the footprints draw it (params biolum, off by default; the user, 2026-11-02, after
 * the spine review: glowing plankton "could be a nice thing for maybe when they walk also through the rather dark beach
 * section at the end"). The shoreline (shoreline.ts) and the wanderers' prints (biolum.ts) each work out how stirred the
 * water or the wet sand is — the EXCITATION, 0..1 — and draw it here, so the two are one light.
 *
 * FROM THE REFERENCES (drift-narrative/references/bioluminescence/README.md: San Diego and Carlsbad red tides,
 * Lingulodinium; Kamakura and Norderney, Noctiluca; real-time video of a San Diego night against the long exposures):
 *   - it lives where the water is stirred — a breaking wave's lip as a thin line along the section that breaks, the
 *     white water behind it dimmer and gone within a second or so, the run-up's leading edge — and calm water between
 *     the breakers stays dark;
 *   - seen by the eye (real-time video, not the long exposures that pile seconds of it into one bright sheet) it is a
 *     soft, dim glow with fine grain in it: up close, tiny points, millimetres across; from tens of metres a smooth
 *     thin line. Never a field of glitter, never blotches.
 *
 * So: THE WASH, a soft light ∝ excitation^RESPONSE (the freshest-stirred water, the lip, carries it; the trail behind it
 * falls off faster than the excitation itself) — and THE GRAIN on it, points in cells of fixed WORLD size (GRAIN_CELLS,
 * 1.2 and 3.5 cm), each lit with a chance that grows with the excitation and flashing at its own rate with a sharp rise
 * and a fast fall (a cell's flash is a tenth of a second). The grain only modulates the wash and keeps its mean, and it
 * is drawn only where its cells are resolved — a cell under ~3 pixels fades to its mean before it can alias — so from
 * the walk's distances it is the smooth line the references show, and the points come in only as the eye comes near.
 * (The first round's sparks were cells sized to the PIXEL, 2.5 px wherever the view was: from the wide shots that was
 * centimetre-to-metre glitter over the whole shallows, a uniform field — "too large, too blotchy … really, really bad
 * in the distance", the user, 2026-11-02)
 *
 * And in the distance less, and thinner (DISTANCE_FADE, DISTANCE_THIN, by the distance from the eye): the far breakers'
 * lines stay a faint broken thread, as they are to the eye, rather than a bright rule along the far beach.
 *
 * The darkness it shows in (biolumDark) is read from the Sun of the pass being drawn (shoreline.ts swashLight.dir), so
 * through w6's dissolve the night's pass carries it and w5's dusk does not: it comes up with the night, as the stars do.
 */
import * as THREE from 'three/webgpu';
import { exp, float, mix, smoothstep, uniform, vec2, vec3 } from 'three/tsl';
import { driftParams } from '../../params/drift';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;

/** the wash's response to the excitation (its power): the lip carries the light, the fading trail less */
const RESPONSE = 1.8;
/** m: the grain's cells (fixed in the world: a point is a fifth of its cell — 2.4 mm, 7 mm) */
const GRAIN_CELLS = [0.012, 0.035];
/** the share of the light the grain carries where it is resolved (the rest stays wash), and the most a point may
 * take of its pixel's mean (no hot pixels) */
const GRAIN = 0.7;
const GRAIN_PEAK = 6;
/** a cell is drawn whole while a pixel spans ≤ GRAIN_RESOLVE[1] of it, gone to its mean by GRAIN_RESOLVE[0] of it */
const GRAIN_RESOLVE: [number, number] = [1, 0.33];
/** /s: a lit cell's flashes, its slowest and fastest rate; and the flash's decay (its share of a cycle: exp(−k·phase)) */
const FLASH_RATE: [number, number] = [0.8, 2.4];
const FLASH_DECAY = 9;
/** m from the eye where the light starts to thin, where it is down to the share left (by distance, not by the pixel's
 * footprint: by footprint the dome's 2048² seat view, its pixels four times a 1280 still's, lost the mid-distance
 * swash altogether — the look must not change with the delivery size) */
const DISTANCE_FADE = { from: 50, to: 220, left: 0.3 } as const;
/** and over the same distance the excitation a pixel must reach to light at all, up to this: the far lines thin to
 * where the water is breaking now (the 2026-11-02 note on the far end of the beach: "too intense, too bright and too
 * cheap … kind of bulky" — a fat saturated stroke along the far breakers; far off the real thing is a faint, broken
 * thread with gaps where no wave is breaking just then) */
const DISTANCE_THIN = 0.35;
/** sin of the Sun's elevation the glow starts to show at and is whole by, in the pass being drawn (0°, −6°). (−5° to
 * −12° until the 2026-11-03 note on the master: "visible a bit earlier at night. It needs to fade in slowly and
 * smoothly, instead of suddenly appearing" — w5's own Sun never gets below −3°, so the glow came only with w6's pass,
 * through the middle of its dissolve, most of it within ~10 s)
 */
const BIOLUM_DARK: [number, number] = [0, Math.sin((-6 * Math.PI) / 180)];
/**
 * THE ONSET, in show time (BIOLUM_ONSET: s from w6's start it begins, and its length): the glow comes up with the night
 * over a minute, from w5's last half minute (its Sun at the horizon, going) to w6's held vista, on a smootherstep —
 * no slope at either end, so nothing starts or arrives. It multiplies every term — the swash's, the stranded sparks',
 * the prints' — so none has an onset of its own. Set each pass by the prints' update (biolum.ts), a pure function of t.
 * As the frame shows it (each pass's own gate × its share of w6's dissolve × this): 5 % at w6 − 9.6 s, 95 % at
 * w6 + 18.7 s, no frame stepping it by more than 0.2 % (tests/driftBiolum.test.ts); it had come up from w6 − 8.7 s to
 * w6 + 8.8 s, with the dissolve alone
 */
export const BIOLUM_ONSET = { from: -30, length: 60 } as const;
export const biolumFade = uniform(0);
/** 0 … 1: the onset at sea time t, w6 starting at `w6` (s) */
export function biolumOnset(t: number, w6: number): number {
  const u = Math.min(1, Math.max(0, (t - w6 - BIOLUM_ONSET.from) / BIOLUM_ONSET.length));
  return u * u * u * (u * (u * 6 - 15) + 10);
}
/** 0 … 1 over the Sun's height `sunY` in a pass (sin of its elevation): CPU twin of `biolumDark`'s gate */
export function biolumSunGate(sunY: number): number {
  const k = Math.min(1, Math.max(0, (sunY - BIOLUM_DARK[0]) / (BIOLUM_DARK[1] - BIOLUM_DARK[0])));
  return k * k * (3 - 2 * k);
}

/** the glow's colour, linear (params biolumColor: sRGB), × its radiance (params biolumRadiance), live */
export const biolumLight = (() => {
  const u = uniform(new THREE.Vector3());
  const c = new THREE.Color();
  u.onRenderUpdate(() => {
    c.setHex(driftParams.biolumColor);
    (u.value as THREE.Vector3).set(c.r, c.g, c.b).multiplyScalar(driftParams.biolumRadiance);
  });
  return u as unknown as V3;
})();

/** 0 … 1: how dark it is for the glow to show, from the Sun's height `sunY` (sin of its elevation), × the onset */
export const biolumDark = (sunY: F): F => smoothstep(BIOLUM_DARK[0], BIOLUM_DARK[1], sunY).mul(biolumFade) as F;

/** a sin-free hash of a cell (the sea glitter's, shoreline.ts: a cell index far out in 32-bit floats came out as moiré
 * through sin) */
const hashCell = (c: V2, salt: number): F => {
  const p3 = vec3(c.x, c.y, c.x).mul(vec3(0.1031, 0.103, 0.0973)).add(salt).fract() as V3;
  const p4 = p3.add(p3.dot(vec3(p3.y, p3.z, p3.x).add(33.33))) as V3;
  return p4.x.add(p4.y).mul(p4.z).fract() as F;
};

/** the mean of one lit cell's point: its flash (∫exp(−k·φ)dφ), its spot's area (π·0.2²) and brightness (mean 0.8) */
const POINT_MEAN = ((1 - Math.exp(-FLASH_DECAY)) / FLASH_DECAY) * (Math.PI * 0.2 * 0.2) * 0.8;

/**
 * The plankton's light at `q` (m, a local plane: metres from the beach's middle, or a print's own frame — never a
 * world position 40 km out), stirred to `excite` (0..1), where a pixel spans `footprint` m, at `time` s: × biolumLight
 * for radiance (0 … 1 in the wash, its points up to GRAIN_PEAK × it), `dist` m from the eye. `salt` keeps two users'
 * grain apart.
 */
export function biolumSparkle(q: V2, excite: F, footprint: F, time: F, salt = 0, dist: F = float(0) as F): F {
  const farness = smoothstep(DISTANCE_FADE.from, DISTANCE_FADE.to, dist) as F;
  const e = excite.clamp(0, 1) as F;
  const wash = smoothstep(farness.mul(DISTANCE_THIN), float(1), e).pow(RESPONSE) as F;
  // (each octave's points normalised to a mean of 1, less 1: its deviation, × how resolved its cells are)
  let grain: F = float(0) as F;
  GRAIN_CELLS.forEach((cell, k) => {
    const s = salt + 3 * k;
    const cq = q.div(cell) as V2;
    const ci = cq.floor() as V2;
    const hB = hashCell(ci, 0.41 + s);
    const hC = hashCell(ci, 0.67 + s);
    // (each flash its own draw: a new threshold and a new place in the cell every cycle, so at a steady stir the
    // points fall in new places, not on the same few cells over and over)
    const cycle = hB.add(time.mul(mix(float(FLASH_RATE[0]), float(FLASH_RATE[1]), hC))) as F;
    const n = cycle.floor() as F;
    const cn = ci.add(vec2(n.mul(7.13), n.mul(3.71))) as V2;
    const hA = hashCell(cn, 0.13 + s);
    const hD = hashCell(cn, 0.89 + s);
    const hE = hashCell(cn, 0.29 + s);
    // (a share of the cells lit, more as it is stirred more — and a few even at a faint stir, so a faint wash keeps
    // its grain)
    const lit = e.mul(0.85).add(0.1) as F;
    const on = smoothstep(hA.sub(0.03), hA.add(0.03), lit) as F;
    const flash = exp(cycle.fract().mul(-FLASH_DECAY)) as F;
    const pt = vec2(hE, hD).mul(0.6).add(0.2) as V2;
    const d = cq.sub(ci).sub(pt).length().div(0.2) as F;
    const spot = exp(d.mul(d).negate()) as F;
    const bright = hD.mul(hD).mul(1.2).add(0.4) as F;
    const point = on.mul(flash).mul(spot).mul(bright).div(lit.mul(POINT_MEAN)).min(GRAIN_PEAK) as F;
    const resolved = smoothstep(GRAIN_RESOLVE[0], GRAIN_RESOLVE[1], footprint.div(cell)) as F;
    grain = grain.add(point.sub(1).mul(resolved)) as F;
  });
  const far = mix(float(1), float(DISTANCE_FADE.left), farness) as F;
  // (the grain's mean is 0: the wash's light kept, only gathered into points where they can be seen)
  return wash.mul(grain.mul(GRAIN / GRAIN_CELLS.length).add(1).max(0)).mul(far) as F;
}
