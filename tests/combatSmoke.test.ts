/**
 * POWDER SMOKE — behaviour, not appearance.
 *
 * User: "Not just circular puffs, but actually like smoke balls bellow out
 * and then that kinda moves towards the top." That is a description of
 * MOTION with a sequence in it, so these tests assert the sequence and the
 * limits it converges to, never a frame of pixels.
 *
 * The defect being guarded is subtle and was invisible to tuning: under
 * linear drag the steady climb is `buoyancy / drag`, and the old profile
 * paired buoyancy 0.6 with drag 1.6 for a terminal rise of 0.37 m/s — and at
 * the drag actually needed to stall a muzzle jet it would have been 0.13 m/s.
 * The smoke could not have risen AT ANY SETTING of the knobs that existed, so
 * "make it rise" was unreachable by tuning and no test would have said so.
 * `riseSpeed` states the terminal climb directly (§V.66: quote the dimension
 * that matters), which is what makes it assertable at all.
 */
import { describe, expect, it } from 'vitest';
import { createProfiles, fillProfiles } from '../src/combat/fxProfiles';
import {
  sizeAt, stepVelocity, particleAspect, ASPECT_MAX, brightnessAt,
  splinterAspect, splinterTumble, SPLINTER_ASPECT_MAX,
} from '../src/combat/fxMath';
import { combatFxParams, combatParams } from '../src/params/combat';
import { createCombatFx } from '../src/combat/combatFx';
import type { CombatFrame } from '../src/combat/combatSystem';
import type { FxProfile } from '../src/combat/fxMath';
import { Object3D } from 'three';

const DT = 1 / 60;

interface FxPool {
  position: Float32Array;
  size: Float32Array;
  aspect: Float32Array;
  /** the sprite's ROLL, in turns — the material multiplies it by 2*pi */
  seed: Float32Array;
  tear: Float32Array;
  kinds: string[];
}

function pool(root: Object3D): FxPool {
  const sprites = root.getObjectByName('combat-sprites');
  const p = (sprites as unknown as { userData?: { fxPool?: FxPool } })?.userData?.fxPool;
  if (p === undefined) throw new Error('no fxPool');
  return p;
}

/** fly one particle and report where it went and how fast it was going */
function fly(
  profile: FxProfile,
  seconds: number,
  windX = 0,
  windZ = 0,
): { pos: [number, number, number]; vel: [number, number, number] } {
  let v: [number, number, number] = [profile.speed, 0, 0];
  const pos: [number, number, number] = [0, 0, 0];
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    v = stepVelocity(v[0], v[1], v[2], profile, DT, windX, windZ);
    pos[0] += v[0] * DT;
    pos[1] += v[1] * DT;
    pos[2] += v[2] * DT;
  }
  return { pos, vel: v };
}

const profiles = (over: Partial<typeof combatFxParams> = {}) =>
  fillProfiles(createProfiles(), { ...combatFxParams, ...over });

describe('smoke bellows OUT, and then it rises', () => {
  it('the jet dominates early and is spent by the time the rise is visible', () => {
    // the two phases overlap in TIME and still read in SEQUENCE, because the
    // jet starts ~7x faster than the climb and decays to nothing while the
    // climb only grows. That ratio is the whole effect.
    const smoke = profiles().smoke;
    const early = fly(smoke, 0.1);
    expect(Math.abs(early.vel[0]) / Math.max(early.vel[1], 1e-6)).toBeGreaterThan(4);

    const late = fly(smoke, 2.5);
    // by the end the outward jet is gone: what horizontal motion remains is
    // the wind carrying it, which in still air is zero
    expect(Math.abs(late.vel[0])).toBeLessThan(0.2);
    expect(late.vel[1]).toBeGreaterThan(1);
  });

  it('throws a readable distance before it stalls — a puff that does not move is not a jet', () => {
    const smoke = profiles().smoke;
    const { pos } = fly(smoke, 0.25);
    expect(pos[0]).toBeGreaterThan(1.5);
    expect(pos[0]).toBeLessThan(6); // ...but it is a gun, not a flamethrower
  });

  it('ends up HIGHER than it started, by metres', () => {
    const smoke = profiles().smoke;
    const { pos } = fly(smoke, combatFxParams.smokeLife);
    expect(pos[1]).toBeGreaterThan(3);
  });

  it('THE OLD SCHEME COULD NOT RISE — terminal climb is buoyancy/drag', () => {
    // The regression this whole rework exists for, stated as the arithmetic
    // that makes it unfixable by tuning. Under linear drag the steady climb
    // is buoyancy/drag; the shipped pair was 0.6 against 1.6.
    const oldTerminal = 0.6 / 1.6;
    expect(oldTerminal).toBeLessThan(0.4); // barely creeps

    // and raising drag to stall the jet makes it strictly WORSE, which is the
    // trap: the two things you would tune fight each other
    const atJetDrag = 0.6 / combatFxParams.smokeDrag;
    expect(atJetDrag).toBeLessThan(oldTerminal);
    expect(atJetDrag).toBeLessThan(0.2);

    // the new parameterisation is immune: the knob IS the terminal speed
    expect(profiles().smoke.riseSpeed).toBeGreaterThan(1);
  });

  it('the rise knob keeps its meaning as drag moves (§V.66)', () => {
    // THE POINT: an ACCELERATION knob divides by drag, so it silently changes
    // meaning every time drag moves — and drag here is doing real work (it is
    // what stalls the jet). Quoting the terminal SPEED decouples them.
    //
    // Not exact: the discrete fixed point is `b·dt·k/(1−k)`, which sits a few
    // percent under the continuous `b/c` and drifts further as `c·dt` grows.
    // That is a real, bounded, ~4% discretisation bias at the shipped drag —
    // recorded rather than papered over, because the CLAIM is invariance, not
    // exactness, and the tolerance has to say which.
    const drags = [2, 4.5, 9];
    const realised = drags.map((smokeDrag) => fly(profiles({ smokeDrag }).smoke, 3).vel[1]);

    for (const v of realised) {
      expect(v / combatFxParams.smokeRiseSpeed).toBeGreaterThan(0.88);
      expect(v / combatFxParams.smokeRiseSpeed).toBeLessThan(1.02);
    }
    // ...and it is the PARAMETERISATION that buys that, not luck: holding a
    // fixed buoyancy across the same drag range spreads the climb by the full
    // 4.5x drag ratio, which is exactly the trap the old profile was in.
    const spreadNew = Math.max(...realised) / Math.min(...realised);
    const spreadOld = Math.max(...drags) / Math.min(...drags);
    expect(spreadNew).toBeLessThan(1.15);
    expect(spreadOld).toBeGreaterThan(4);
  });
});

describe('smoke is carried by the LIVE wind', () => {
  it('drifts downwind, converging on the air it sits in', () => {
    const smoke = profiles().smoke;
    const wind = 8;
    const { vel, pos } = fly(smoke, 3, wind, 0);
    // drag acts on velocity RELATIVE to the air, so the parcel ends up
    // travelling with it, scaled by how completely it is coupled
    expect(vel[0]).toBeCloseTo(wind * combatFxParams.smokeWind, 1);
    expect(pos[0]).toBeGreaterThan(10);
  });

  it('blows the OTHER way when the wind reverses — not a baked-in direction', () => {
    const smoke = profiles().smoke;
    const withWind = fly(smoke, 3, 8, 0).pos[0];
    const against = fly(smoke, 3, -8, 0).pos[0];
    expect(withWind).toBeGreaterThan(0);
    expect(against).toBeLessThan(0);
  });

  it('a splinter does NOT blow away — mass is not smoke', () => {
    // windCoupling 0 must leave the old integrator behaviour EXACTLY intact
    const { splinter } = profiles();
    expect(splinter.windCoupling).toBe(0);
    const still = fly(splinter, 1, 0, 0);
    const gale = fly(splinter, 1, 30, 0);
    expect(gale.pos[0]).toBeCloseTo(still.pos[0], 10);
    expect(gale.pos[1]).toBeCloseTo(still.pos[1], 10);
  });

  it('every kind with MASS is untouched by the air model', () => {
    // The line is mass, not "is it smoke". A splinter, a spark, a cannonball
    // trail and a wall of bulk water all carry their own momentum and are not
    // carried by the air; powder smoke and the fine MIST left hanging over a
    // water entry are both suspensions and both are. `splash` is deliberately
    // absent from this list — see the next test, which pins the reason.
    const p = profiles();
    for (const kind of ['flash', 'spark', 'splinter', 'trail', 'impactFlash', 'column', 'crown'] as const) {
      expect(p[kind].windCoupling, `${kind} windCoupling`).toBe(0);
      expect(p[kind].riseSpeed, `${kind} riseSpeed`).toBe(0);
      expect(p[kind].growthExp, `${kind} growthExp`).toBe(1);
    }
  });

  it('the water-entry MIST blows away; the column and crown do not', () => {
    // WHY these differ: the column and the crown are bulk sea thrown by the
    // impact, and bulk water does not blow sideways in a breeze. The mist is
    // what has already atomised, and it does — it is the same physical
    // distinction §V.55 draws for spray, and getting it wrong in either
    // direction is immediately readable (water that drifts like smoke, or a
    // haze that hangs dead still in a gale).
    const p = profiles();
    expect(p.splash.windCoupling).toBeGreaterThan(0);
    expect(p.column.windCoupling).toBe(0);
    expect(p.crown.windCoupling).toBe(0);

    const still = fly(p.splash, 1, 0, 0);
    const gale = fly(p.splash, 1, 20, 0);
    expect(gale.pos[0]).toBeGreaterThan(still.pos[0] + 1);
  });

  it('a water particle NEVER paints darker than the sea behind it', () => {
    /**
     * THE BUG THIS EXISTS FOR, found on screen and not by any test that
     * existed. `colArr` carries colour already multiplied by the age fade,
     * because for an ADDITIVE particle the fade IS the brightness. The first
     * cut of the alpha-blended water path left the alpha at a flat per-kind
     * constant, so the blender got a nearly OPAQUE fragment whose colour had
     * been faded toward black — and the column rendered as a dark bruise on
     * the sea, hardest in the first 80 ms where `brightnessAt` is still
     * ramping in from zero and the particle is at its largest.
     *
     * Stated as the property rather than as the fix: over a DARK sea, at
     * every point in a water particle's life, the composite must be at least
     * as bright as the sea it covers. That is what "this is white water"
     * means, and it is false for any implementation that fades one channel
     * without the other.
     *
     * The blend is combatFx's, restated here so the test fails if the
     * material's contract changes rather than only if the numbers do:
     *     out = colour·cover + dst·(1 − cover·alpha)
     */
    const p = profiles();
    const sea = [0.02, 0.12, 0.13]; // linear open ocean, the darkest realistic dst
    for (const kind of ['column', 'crown', 'splash'] as const) {
      const pr = p[kind];
      for (let t = 0; t < 1; t += 0.01) {
        const fade = brightnessAt(t);
        for (const cover of [0.15, 0.5, 1]) {
          const alpha = pr.alpha * fade;
          for (let c = 0; c < 3; c++) {
            const out = pr.color[c] * fade * cover + sea[c] * (1 - cover * alpha);
            expect(out, `${kind} c${c} t=${t.toFixed(2)} cover=${cover}`)
              .toBeGreaterThanOrEqual(sea[c] - 1e-9);
          }
        }
      }
    }
  });

  it('the additive kinds are BIT-IDENTICAL under the new blend function', () => {
    // The one-pool/two-blend-models trick is only safe if `alpha` 0 reduces
    // the custom blend exactly to three's AdditiveBlending. Additive is
    // (SrcAlpha, One) with colour = tint and opacity = cover; the new function
    // is (One, OneMinusSrcAlpha) with colour = tint·cover and alpha = cover·0.
    // Those are the same expression, and this pins it so a future edit to
    // either half cannot silently regrade the flash.
    // `splinter` left this list first, and the three SMOKE kinds left it on
    // §T.87: a list that pinned "smoke must stay additive" was pinning the
    // very decision that made the muzzle cloud invisible (§V.80) — additive
    // grey over a bright sky occludes nothing. What remains is genuinely
    // LIGHT: the flash, the strike, the sparks.
    const p = profiles();
    const sea = [0.02, 0.12, 0.13];
    for (const kind of ['flash', 'spark', 'impactFlash'] as const) {
      const pr = p[kind];
      expect(pr.alpha, `${kind} must stay additive`).toBe(0);
      for (const cover of [0.15, 0.5, 1]) {
        for (let c = 0; c < 3; c++) {
          const oldAdditive = pr.color[c] * cover + sea[c] * 1;
          const newCustom = pr.color[c] * cover + sea[c] * (1 - cover * pr.alpha);
          expect(newCustom).toBe(oldAdditive);
        }
      }
    }
  });

  it('SUBSTANCE is OPAQUE and LIGHT is ADDITIVE (the blend split)', () => {
    // WHY: additive can only ever brighten what is behind it. An additive
    // splash column reads as a glow latched onto the sea and disappears
    // outright against a bright sky, which is exactly the angle it is seen
    // from on a deck — verbatim the user's "latched on top / doesn't look
    // like it interacts with the water". The SAME failure, one system over,
    // was the muzzle cloud (§T.87: "almost not visible at all") — powder
    // smoke is a substance too, and it was shipped as light. Flame IS light
    // and must stay at 0, or the flash stops glaring.
    const p = profiles();
    for (const kind of ['column', 'crown', 'splash', 'smoke', 'breech', 'impactSmoke'] as const) {
      expect(p[kind].alpha, `${kind} alpha`).toBeGreaterThan(0);
    }
    for (const kind of ['flash', 'spark', 'impactFlash'] as const) {
      expect(p[kind].alpha, `${kind} alpha`).toBe(0);
    }
    // the crown is bulk sea and the mist is half-atomised: the ORDER is the
    // physical claim, not the individual numbers
    expect(p.crown.alpha).toBeGreaterThan(p.column.alpha);
    expect(p.column.alpha).toBeGreaterThan(p.splash.alpha);
  });

  it('a splinter OCCLUDES — it is a piece of the ship, not a glow over it', () => {
    /**
     * THE USER REPORT THIS EXISTS FOR: "hits don't really feel like they
     * register", "I'd expect wood splintering and breaking and flying off".
     * The splinter burst was firing on every hit the whole time — it was
     * simply invisible, for exactly the reason the water column was before
     * §T.16: `alpha` 0 is ADDITIVE, and additive can only ever BRIGHTEN what
     * is behind it. A brown sprite that can only brighten is a faint warm
     * smudge over a sunlit hull and nothing at all against a bright sky.
     *
     * Stated as the property, not the number: there must exist a background
     * bright enough that a splinter DARKENS it. That is false for every
     * additive kind at every setting, and it is what "solid object" means.
     * The FLASH must NOT satisfy it — a flash that can darken a sky is not a
     * flash — so the same assertion is run in reverse on `flash` to pin the
     * split. (It used to be run on `smoke`, which pinned the muzzle cloud
     * to the additive family that made it invisible — §T.87, §V.80.)
     */
    const p = profiles();
    const sky = [0.9, 0.95, 1]; // linear bright overcast — the worst case
    const cover = 1;
    const fade = brightnessAt(0.3); // near the peak of a shard's visible life

    const composite = (pr: { color: number[]; alpha: number }, c: number): number =>
      pr.color[c] * fade * cover + sky[c] * (1 - cover * pr.alpha * fade);

    let splinterDarkens = false;
    for (let c = 0; c < 3; c++) {
      if (composite(p.splinter, c) < sky[c] - 1e-6) splinterDarkens = true;
      // the flash is light: it may never subtract from the sky
      expect(composite(p.flash, c), `flash must stay additive c${c}`)
        .toBeGreaterThanOrEqual(sky[c] - 1e-9);
    }
    expect(splinterDarkens, 'a splinter must be able to darken a bright sky').toBe(true);
  });

  it('a splinter is a SLIVER and it TUMBLES — the two halves of reading as wood', () => {
    /**
     * Opacity alone is not enough: an opaque round dot is a mud pellet. Wood
     * blown out of a plank is long, thin and spinning, and both of those are
     * silhouette properties (§V.65 — the eye reads the outline).
     *
     * Both knobs are checked at their NEUTRAL value too, because a knob whose
     * off position does not restore the old behaviour is not a knob, it is a
     * hardcode with a slider on it (§V.62).
     */
    // one-sided: a splinter is never squatter than square, unlike a smoke puff
    for (let i = 0; i < 200; i++) {
      const a = splinterAspect(i * 7919, i, 4.5);
      expect(a).toBeGreaterThanOrEqual(1);
      expect(a).toBeLessThanOrEqual(4.5 + 1e-9);
    }
    // …and it is genuinely LONG on average, not nominally over 1
    let sum = 0;
    for (let i = 0; i < 400; i++) sum += splinterAspect(i * 2654435761, i, 4.5);
    expect(sum / 400).toBeGreaterThan(2.5);

    // the ratio is bounded at source, so no params edit can thin a shard to
    // nothing (the `s/a` divisor is floored — §V.28)
    expect(splinterAspect(1, 1, 1e9)).toBeLessThanOrEqual(SPLINTER_ASPECT_MAX);
    expect(splinterAspect(1, 1, NaN)).toBe(1);
    // neutral: ratio 1 is exactly the round sprite it replaced
    for (let i = 0; i < 20; i++) expect(splinterAspect(i, i, 1)).toBe(1);

    // TUMBLE: both directions must occur, or the burst rotates as one body
    let cw = 0;
    let ccw = 0;
    for (let i = 0; i < 400; i++) {
      const s = splinterTumble(i * 40503, i, 7);
      expect(Math.abs(s)).toBeGreaterThan(0); // no shard is frozen mid-burst
      expect(Math.abs(s)).toBeLessThanOrEqual(7 + 1e-9);
      if (s > 0) cw++;
      else ccw++;
    }
    expect(Math.min(cw, ccw) / 400).toBeGreaterThan(0.3);
    // neutral: rate 0 freezes the roll exactly, so `update`'s tumble branch is
    // provably a no-op and the seed buffer is never re-uploaded
    for (let i = 0; i < 20; i++) expect(splinterTumble(i, i, 0)).toBe(0);
  });
});

describe('growth is front-loaded (a puff is not a balloon)', () => {
  it('a quarter of the way through life, MORE than a quarter of the growth is done', () => {
    // sqrt(t) vs linear, stated as the property rather than as numbers: at
    // t=0.25 the linear curve is at exactly 25% by definition, so anything
    // above it is the turbulent-puff law doing its job
    const smoke = profiles().smoke;
    const span = smoke.sizeEnd - smoke.sizeStart;
    const quarter = (sizeAt(smoke, 0.25) - smoke.sizeStart) / span;
    expect(quarter).toBeGreaterThan(0.45);
  });

  it('a kind that did not opt in grows exactly linearly, as it always did', () => {
    const { splinter } = profiles();
    const span = splinter.sizeEnd - splinter.sizeStart;
    for (const t of [0.25, 0.5, 0.75]) {
      expect((sizeAt(splinter, t) - splinter.sizeStart) / span).toBeCloseTo(t, 10);
    }
  });

  it('growth stays monotone and never returns a degenerate size', () => {
    const smoke = profiles().smoke;
    let last = -1;
    for (let t = 0; t < 1; t += 0.02) {
      const s = sizeAt(smoke, t);
      expect(Number.isFinite(s)).toBe(true);
      expect(s).toBeGreaterThan(0);
      expect(s).toBeGreaterThanOrEqual(last);
      last = s;
    }
    expect(sizeAt(smoke, 1)).toBe(0); // §V.28 dead is zero SIZE
  });
});

describe('the silhouette is not a disc (§V.65)', () => {
  it('aspect is bounded and AREA-PRESERVING, so a stretch is not a mass gain', () => {
    // the sprite is scaled (s·a, s/a): the product is s² whatever a is, which
    // is what stops the stretch from doubling as a brightness knob
    for (let i = 0; i < 200; i++) {
      const a = particleAspect(i * 7919, i, 1);
      expect(a).toBeGreaterThanOrEqual(1 / ASPECT_MAX - 1e-9);
      expect(a).toBeLessThanOrEqual(ASPECT_MAX + 1e-9);
      expect(a * (1 / a)).toBeCloseTo(1, 12);
    }
  });

  it('stretch and squash are symmetric — not biased toward wide', () => {
    // exponential about 1, so 2:1 wide and 2:1 tall are equally far from round
    let wide = 0;
    let tall = 0;
    for (let i = 0; i < 400; i++) {
      const a = particleAspect(i * 2654435761, i, 1);
      if (a > 1) wide++;
      else tall++;
    }
    expect(Math.abs(wide - tall) / 400).toBeLessThan(0.15);
  });

  it('zero spread restores perfectly round sprites, so the knob is provable', () => {
    for (let i = 0; i < 20; i++) expect(particleAspect(i, i, 0)).toBeCloseTo(1, 12);
  });

  it('the shard stretch and tumble REACH THE POOL, not just the params (§V.62)', () => {
    /**
     * The gap this closes was found by mutation: `splinterAspect` could be
     * taken from 4.5 to 1 — deleting the entire silhouette change — and every
     * test still went green, because they all called the math directly with a
     * literal instead of going through the spawn boundary. A knob nothing
     * observes is the §V.62 defect wearing a slider.
     *
     * So this drives a real HIT through `createCombatFx` and reads the
     * PUBLISHED buffers, which are the bytes the GPU is handed.
     */
    const fx = createCombatFx();
    const frame: CombatFrame = {
      muzzles: [],
      hits: [{ shipIndex: 0, pieceId: 'hull-port-mid', point: [3, 2, 1], projectileId: 7 }],
      projectiles: [], destruction: [], detached: [],
    };
    fx.emit(frame);
    fx.update(1 / 60, []);

    const { kinds, aspect, size, seed, tear } = pool(fx.group);
    const shards: number[] = [];
    for (let i = 0; i < size.length; i++) {
      if (size[i] > 0 && kinds[i] === 'splinter') shards.push(i);
    }
    expect(shards.length, 'a hit must throw splinters').toBeGreaterThan(4);

    for (const i of shards) {
      // LONG, and one-sided: a shard is never squatter than square
      expect(aspect[i], 'a splinter must be a sliver').toBeGreaterThan(1);
      // …but never torn. `tornAlpha` is the only per-fragment cost in this
      // system and chewing holes in a ~1.5 px sliver would spend fill rate to
      // delete it.
      expect(tear[i], 'a splinter must not be torn').toBe(0);
    }
    // they must not all be the SAME sliver, or the burst is one shape stamped
    const distinct = new Set(shards.map((i) => aspect[i].toFixed(4)));
    expect(distinct.size, 'shards must differ in shape').toBeGreaterThan(3);

    // TUMBLE: the roll must actually advance between frames. A per-particle
    // roll written once at spawn reads as decals sliding through the air, and
    // it is invisible to any test that only looks at one frame.
    const before = shards.map((i) => seed[i]);
    fx.update(1 / 60, []);
    const after = shards.map((i) => seed[i]);
    expect(after.some((v, k) => v !== before[k]), 'shards must tumble').toBe(true);
    // and the roll stays in [0,1) turns, so a long-lived shard cannot drift
    // the float into a range where 2*pi*seed loses angular precision
    for (const v of after) expect(v).toBeGreaterThanOrEqual(0);
    for (const v of after) expect(v).toBeLessThan(1);
    fx.dispose();
  });

  it('SMOKE gets stretched and torn; sparks do NOT', () => {
    // an elliptical spark is just a wrong-shaped spark, and tearing a point
    // of light does nothing but cost fill rate. NOTE: splinters used to be
    // asserted round here too — they are now deliberately the most stretched
    // thing in the pool, which is what the test above pins. This frame is
    // muzzle-only, so no splinter reaches it either way.
    const fx = createCombatFx();
    const frame: CombatFrame = {
      muzzles: [{
        shipIndex: 0, socketId: 'g0', position: [0, 3, 0], direction: [1, 0, 0], seed: 12345,
      }],
      hits: [], projectiles: [], destruction: [], detached: [],
    };
    fx.emit(frame);
    fx.update(DT, []);

    const { kinds, aspect, tear, size } = pool(fx.group);
    let smokeVaried = 0;
    for (let i = 0; i < size.length; i++) {
      if (size[i] <= 0) continue;
      const smoky = kinds[i] === 'smoke' || kinds[i] === 'breech' || kinds[i] === 'impactSmoke';
      if (smoky) {
        if (Math.abs(aspect[i] - 1) > 1e-6) smokeVaried++;
        expect(tear[i]).toBeGreaterThan(0);
      } else {
        expect(aspect[i], `${kinds[i]} must stay round`).toBe(1);
        expect(tear[i], `${kinds[i]} must not be torn`).toBe(0);
      }
    }
    expect(smokeVaried).toBeGreaterThan(4);
    fx.dispose();
  });
});

describe('the breech vents too — and its position is DERIVED', () => {
  const muzzleFrame = (direction: [number, number, number]): CombatFrame => ({
    muzzles: [{
      shipIndex: 0, socketId: 'g0', position: [10, 3, 0], direction, seed: 999,
    }],
    hits: [], projectiles: [], destruction: [], detached: [],
  });

  it('puts a puff behind the muzzle, back along the barrel', () => {
    const fx = createCombatFx();
    fx.emit(muzzleFrame([1, 0, 0]));
    fx.update(1 / 600, []);
    const { kinds, position, size } = pool(fx.group);

    let breechCount = 0;
    for (let i = 0; i < size.length; i++) {
      if (size[i] <= 0 || kinds[i] !== 'breech') continue;
      breechCount++;
      // firing to +x from x=10, so the vent must be INBOARD of the muzzle
      expect(position[i * 3]).toBeLessThan(10);
    }
    expect(breechCount).toBeGreaterThan(0);
    fx.dispose();
  });

  it('rides the barrel length rather than a literal of its own', () => {
    // SINGLE OWNER. `combatParams.muzzleForward` is mount → muzzle; the vent
    // is the mount. A second literal for the far end of the same gun is the
    // bug that put a lantern beside a post it did not reach.
    const original = combatParams.muzzleForward;
    try {
      const at = (forward: number): number => {
        combatParams.muzzleForward = forward;
        const fx = createCombatFx();
        fx.emit(muzzleFrame([1, 0, 0]));
        fx.update(1 / 600, []);
        const { kinds, position, size } = pool(fx.group);
        let minX = Infinity;
        for (let i = 0; i < size.length; i++) {
          if (size[i] > 0 && kinds[i] === 'breech') minX = Math.min(minX, position[i * 3]);
        }
        fx.dispose();
        return minX;
      };
      const near = at(1);
      const far = at(3);
      // a longer barrel must put the vent further back, by about the delta
      expect(near - far).toBeGreaterThan(1.5);
    } finally {
      combatParams.muzzleForward = original;
    }
  });

  it('vents UPWARD off the breech, not back down the bore', () => {
    const fx = createCombatFx();
    fx.emit(muzzleFrame([1, 0, 0]));
    // let it fly a moment so the jet direction shows in the positions
    for (let i = 0; i < 12; i++) fx.update(DT, []);
    const { kinds, position, size } = pool(fx.group);
    let rose = 0;
    let total = 0;
    for (let i = 0; i < size.length; i++) {
      if (size[i] <= 0 || kinds[i] !== 'breech') continue;
      total++;
      if (position[i * 3 + 1] > 3) rose++;
    }
    expect(total).toBeGreaterThan(0);
    expect(rose / total).toBeGreaterThan(0.7);
    fx.dispose();
  });
});
