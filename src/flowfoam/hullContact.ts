/**
 * THE WATER A SLOW HULL WORKS — an opt-in near field for the flowfoam advect pass (`createFlowFoam({ hull })`),
 * built for the Drift's raft (drift/wandering/sea.ts) and absent from every game page (no `hull`, no node: the
 * pirate, raft and speedboat graphs are byte-identical).
 *
 * WHY THE WAKE WAS NOT ENOUGH. The analytic wake (wakeInjection.ts) is a ship's: Kelvin arms, a bow mound, a stern
 * churn, a slick lane, all ramped on speed through the water and hung off the cutwater's track. A balsa raft makes
 * 0.2–1.9 m/s (Fr ≈ 0.1 on its 13.7 m logs): its Kelvin crests are 0.9 m long and millimetres high, and the raft
 * floated in "a completely unimpressed liquid" (the user, 2026-10-29). Then, of each attempt: a trail of foam and
 * slick round it read "painted-on, almost oil-trail … way too stripey"; and a trail drawn in the hull's own frame
 * "looks like it's pointing to wherever the boat is NOW, instead of being historically printed". So, the rule this
 * file keeps: ONLY THE NEAR FIELD IS THE HULL'S; EVERYTHING ASTERN IS DEPOSITED where and when the hull was, and
 * lives on in the world.
 *   1. THE LOGS IN THE WATER (the hull's, instantaneous): the short chop the raft is too big to follow runs up its
 *      windward faces — the water riding up the logs (ELEVATION within a metre of them) — and, while the raft lies
 *      still, slaps them white (FOAM, short-lived). Under way the hull lays no foam: a source riding the hull draws
 *      its track as a line (the "comb" of streaks off every log end), and the ocean draws a wake's thin foam through
 *      its lace art as hair.
 *   2. DISPLACEMENT AT THE HULL (the hull's, instantaneous: it is steady in the hull's frame, as it is in life): the
 *      stagnation heap at the bow face and a trough opening out alongside — never at the logs themselves, which
 *      float on a sea that knows nothing of this field; short rings off the logs where they work (SLOPE only).
 *   3. THE WATER PUSHED ASIDE (deposited): every `pushEvery` s a displacement wave is launched from where the hull
 *      is and stays where it was launched, an arc spreading at its group speed to the sides of the heading it had,
 *      fading over `pushDecay` s — the trail's arms are the sum of those launches along the track (GEOMETRY + SLOPE).
 *   4. THE STIRRED BAND (deposited): eddies shed off the stern corners, port and starboard in turn, each fixed where
 *      it was shed and spreading and fading over a minute. Their induced velocity is ADDED TO THE ADVECTION
 *      (`flowNode` → accumulation `extraFlow`), so what the band banks — roughness (a NEGATIVE slick: the sea's own
 *      fine ripples raised) and glassy slick on the boils' tops — is wound round them. The water they stir heaves into
 *      lumps and boils (GEOMETRY + SLOPE, world-anchored noise and cells) and its normal is broken up, wound into
 *      spiral arms about each eddy — so the sky's mirror and the Sun's glitter break and swirl along the track.
 *
 * Everything is a function of the replayed state: the pose and speed the page hands over at each step, the step's
 * own time, and what `advance` deposits (eddies off the odometer, launches on the absolute clock) — so a page that
 * replays its wake from a fixed start (sea.ts `wakeTo`) gets the same water however a frame was reached. World-space
 * by construction (one region texture, no camera), so the dome's six faces see one sea.
 *
 * NOT MIRRORED ON THE CPU (`FlowFoam.wakeHeightCpu`): visual only. The film's raft is posed from the CpuOcean alone
 * (raft.ts); every lowering of the water here keeps off the logs' first metre for that reason.
 *
 * §V28: every divisor floored; §V44: rates, heights and slopes bounded at source (the advect pass clamps .ba to ±1
 * and the elevation to ±2 m as backstops); §V48: every periodic term is band-limited against the tier's texel.
 */
import * as THREE from 'three/webgpu';
import { If, Loop, atan, float, int, mix, select, smoothstep, uniform, uniformArray, vec2, vec4 } from 'three/tsl';
import { cellular2, fbm2, gradNoise2 } from '../terrain/noise';

/** one log in plan, in the hull's own frame (m: x to starboard, z toward the bow) */
export interface HullLog {
  x: number;
  r: number;
  zStern: number;
  zBow: number;
}

/** the look, all live (pushed every `advance`) */
export interface HullContactParams {
  /** white water per second where a crest of the chop slaps a log face, at the chop's full rise speed; and per m/s of
   * way at the bow face (the water piled against the logs) */
  slapFoam: number;
  bowFoam: number;
  /** m: the collar's reach off the logs (the foam rate falls by e over it) */
  collarWidth: number;
  /** the chop that slaps the logs (a stand-in for the sea's own short waves): rad off the wind its three trains
   * run, m their lengths, and m of run-up at a log face (all three at their crests, doubled by the reflection) */
  chopSpread: number;
  chopLengths: [number, number, number];
  runup: number;
  /** m: the run-up's reach off the logs (e-folding) */
  runupReach: number;
  /** × U²/2g at the bow (the stagnation heap), the sides (Cp, the trough) and the transom (base pressure), and the
   * heap's cap (m) */
  pressureGain: number;
  sideCp: number;
  sternCp: number;
  heapMax: number;
  /** m: how far off the logs the heap and the trough reach (e-folding) */
  pressureReach: number;
  /** m of the ripple rings at full lapping, their lengths (m) and reach off the logs (m) */
  rippleHeight: number;
  rippleLengths: [number, number];
  rippleReach: number;
  /** turbulence alongside and astern of the logs: its reach (m) and its share of the stir per m/s of way */
  churnReach: number;
  churnWay: number;
  /** m travelled between eddies shed off the stern corners (port, starboard, port…) */
  shedSpacing: number;
  /** circulation of a fresh eddy per m/s of way per m of beam (m²/s per m²/s) */
  shedStrength: number;
  /** m: a fresh eddy's core radius, and m/s it spreads by */
  eddyCore: number;
  eddySpread: number;
  /** s: an eddy's circulation falls by e over this, and it is gone (faded) by `eddyLife` */
  eddyDecay: number;
  eddyLife: number;
  /** m: a fresh eddy's dimple per m/s of way it was shed at */
  eddyDimple: number;
  /** m: the stirred water's radius about a fresh eddy, and m/s it widens by; s its stir falls by e over */
  stirRadius: number;
  stirSpread: number;
  stirDecay: number;
  /** the churned water's roughness: peak slope of its boils, and their two lengths (m) */
  roughSlope: number;
  roughLengths: [number, number];
  /** 0..1: how much of the roughness astern is wound into spiral arms round the eddies (0: even boils) */
  spiral: number;
  /**
   * THE SEA'S OWN RIPPLES, ROUGHENED: per second, how fast churned water banks roughness at full stir (a NEGATIVE
   * slick, .g < 0: accumulated, advected round the eddies and fading with the slick's half-life like any slick), and
   * the gain it puts on the ocean's fine cascade, its micro-wavelets and its glitter per unit banked (flowfoam
   * `wakeSmoothNode`: 1 + gain·roughness, where a slick damps 1 − damp·slick). The boils above are this field's
   * own detail; this is the sea's, so the disturbed band is the same water, choppier.
   */
  roughen: number;
  roughGain: number;
  /**
   * THE TRAIL AS SHAPE (the 2026-10-29 review: "a believable DISPLACEMENT, not a streaky painting on top … 'a boat
   * just passed through here'"): the stirred water's lumps — mounds and dimples of the turbulent wake — as real
   * elevation (m, peak) at their length (m: kept ≥ ~2 vertex spacings of the ocean mesh near the eye, so it draws as
   * geometry), and a finer octave (m, length) that only tilts the normal (under the mesh's spacing it would alias)
   */
  lumpHeight: number;
  lumpLength: number;
  lumpFineHeight: number;
  lumpFineLength: number;
  /**
   * THE BOILS: upwellings in the stirred band, each a smooth dome of water (m, peak) a cell across (m), rising and
   * settling over its own period (s, each at its own phase), their tops glassy — a slick, .g > 0 — and the water
   * between them choppy (the banked roughness). In a sea already rippled all over, a lumpy band alone did not read as
   * a trail; smooth domes ringed by chop do: the sky's mirror holds together on them and breaks between
   */
  boilHeight: number;
  boilCell: number;
  boilPeriod: number;
  /** slick per second banked on a boil's top at full stir */
  boilSlick: number;
  /**
   * THE WAKE SCAR (the 2026-10-29 review: "the boat goes over it and the water doesn't care"): turbulence under and
   * just astern of the hull damps the short ripples, and the water it has crossed is left a GLASSY LANE — slick, .g,
   * laid per second under the logs and over `laneApron` m astern while the raft makes way (full by 0.5 m/s), the lane's
   * half-width the logs' own ± `laneRagged` m of world-anchored raggedness. Deposited: the lane is where the raft WAS,
   * and the eddies' flow eats its edges from there (its life is the page's slickHalfLife)
   */
  laneSlick: number;
  laneApron: number;
  laneRagged: number;
  /**
   * AERATED WATER: foam coverage (.r) per second per m/s of way laid in boiling clumps over the first `aerReach` m
   * astern of the transom (world-anchored cells pick where, so they stay where they were laid) — drawn as bubbles
   * under the surface, a milky turquoise (ocean params wakeAeration), not as white paint
   */
  aerFoam: number;
  aerReach: number;
  aerCell: number;
  /** foam per second laid in a broken ring round each young eddy (its first ~3 s), wound round by its own flow so the
   * eddy's turning shows */
  ringFoam: number;
  /** foam per second per m/s at the bow's face under way: the white curl where it pushes water (centre logs only) */
  curlFoam: number;
  /**
   * THE WATER PUSHED ASIDE, as the world keeps it (the 2026-10-29 review: the trail "looks like it's pointing to
   * wherever the boat is NOW, instead of being historically printed"): every `pushEvery` s the hull launches a
   * displacement wave from where it IS, and that wave stays where it was launched — an arc spreading outward at its
   * group speed, to the sides of the heading it had then, fading over `pushDecay` s. The arms of the trail are the
   * sum of those launches, laid along the track and spreading in the world; none of it is pinned to the hull now.
   * m of crest per m/s of way at launch, m its length (kept ≥ ~3 ocean-mesh spacings: it is geometry), s
   */
  pushHeight: number;
  pushLength: number;
  pushDecay: number;
  pushEvery: number;
}

export const HULL_CONTACT_DEFAULTS: HullContactParams = {
  // (low: with the foam's 7 s life a raft lying still built a solid collar, drawn as a teal pool round it at nightfall)
  slapFoam: 0.12,
  bowFoam: 0.06,
  collarWidth: 0.1,
  chopSpread: 0.45,
  chopLengths: [6.5, 4.2, 2.8],
  runup: 0.07,
  runupReach: 0.8,
  pressureGain: 6,
  sideCp: -0.25,
  sternCp: -0.1,
  heapMax: 0.25,
  pressureReach: 1.8,
  rippleHeight: 0.01,
  rippleLengths: [1.1, 0.7],
  rippleReach: 1,
  churnReach: 0.8,
  churnWay: 1,
  // (a blunt body sheds an eddy off each side in turn, ~1.5 beams apart: Strouhal ≈ 0.2 on its 5.4 m beam)
  shedSpacing: 8,
  shedStrength: 0.8,
  // (a core a third of the beam: turns once in ~25 s at landing speed; a 0.9 m core spun foam into hair)
  eddyCore: 1.9,
  eddySpread: 0.04,
  eddyDecay: 22,
  eddyLife: 75,
  eddyDimple: 0.04,
  // (the turbulent wake as wide as the beam, its eddies 8 m apart: blobs of half a beam overlap into one band)
  stirRadius: 3,
  stirSpread: 0.06,
  stirDecay: 30,
  roughSlope: 0.5,
  roughLengths: [0.8, 0.55],
  spiral: 0.4,
  roughen: 0.12,
  roughGain: 2.2,
  lumpHeight: 0.045,
  lumpLength: 1.5,
  lumpFineHeight: 0.02,
  lumpFineLength: 0.7,
  boilHeight: 0.05,
  boilCell: 2.4,
  boilPeriod: 12,
  boilSlick: 0.12,
  laneSlick: 2,
  laneApron: 2.5,
  laneRagged: 0.9,
  // (0.05: at 0.25 the clumps saturated, and dense coverage is drawn through the ocean's white lace art — long thin
  // curved hairs in the clear lagoon at 518 s. The one-boot A/B, 2026-10-29: with the seabed's shadow lookup off, the
  // slick off, the coast hidden, the eddies' flow off or the bow's curl off they stayed; with these clumps off they
  // went; at 0.04/0.08 per m/s they were gone/faint. Kept under the lace's 0.35 coverage they are the milky tint alone)
  // (OFF, 2026-10-30: the clumps' coverage drew the fanned straight smears behind the stern — a farm A/B at 545 s, clumps
  // off removed them, the eddies, rings, roughness and push waves off did not; cause not yet found)
  aerFoam: 0,
  aerReach: 6,
  aerCell: 1.7,
  // (0: the rings, wound by their eddies' shear, were the fanned straight streaks off the stern corners at 545 s — the
  // 2026-10-30 farm A/B: rings off or eddies off removed them, the clumps and the push waves did not)
  ringFoam: 0,
  // (0: the bow's curl was laid as a central streak the raft then sailed over and left astern)
  curlFoam: 0,
  // (0.05: a physical bow wave's few centimetres at this Froude number — at 0.14 the launches summed into big V-arms of
  // crests, the Kelvin wake faked; the 2026-10-30 review: "the Kelvin wake stays physically tiny")
  pushHeight: 0.05,
  pushLength: 2.2,
  pushDecay: 10,
  pushEvery: 0.4,
};

/** eddy slots (at 1.9 m/s and 3.2 m apart, a minute of eddies would be 36: the oldest go first, already faint) */
export const HULL_EDDIES = 40;
/** push-aside launches kept (at `pushEvery` 0.4 s, the last 19 s of them; older ones have faded by then) */
export const HULL_PUSHES = 48;
/** m/s² */
const G = 9.81;
/** floor for divisors and smoothstep spans (§V28) */
const EPS = 1e-6;
/** m: the logs are blended into one outline over this (it closes the 2–3 cm chinks and rounds the stagger's steps) */
const BLEND = 0.2;
/** m: past this off the logs the near terms are not evaluated (each is e-folded well inside it) */
const REACH = 5;
/** the share of the chop's slaps that lay white water off the sides under way (see the collar). 0: laid continuously
 * as the raft moves, they drew a line along each side of its track (2026-10-30) */
const UNDER_WAY_SLAP = 0;
/** m: the forward-difference step of the boils' slope (a dome is ~2 m across) */
const BOIL_STEP = 0.25;
/** m off the logs over which the pressure field's troughs open out (none at the logs: see the displacement term) */
const PRESS_CLEAR = 0.8;

interface Eddy {
  x: number;
  z: number;
  /** signed circulation (m²/s), + turning from +x toward +z */
  gamma: number;
  born: number;
}

export function createHullContact(logs: readonly HullLog[], params: Partial<HullContactParams> = {}) {
  if (logs.length === 0) throw new Error('hullContact: no logs');
  /** live: `advance` pushes it every step (assign to it to tune) */
  const p: HullContactParams = { ...HULL_CONTACT_DEFAULTS, ...params };
  const stern = Math.min(...logs.map((l) => l.zStern));
  const bow = Math.max(...logs.map((l) => l.zBow));
  const halfBeam = Math.max(...logs.map((l) => Math.abs(l.x) + l.r));
  // the CORE the hull's flow is oriented by: its centreline less a half-beam at each end, so the end caps of the
  // capsule round it are the bow and stern faces (the bow's 4 m stagger is near enough a half-beam's semicircle)
  const coreAft = Math.min(0, stern + halfBeam);
  const coreFwd = Math.max(coreAft, bow - halfBeam);

  /** (x, z, forward x, forward z) */
  const uPose = uniform(new THREE.Vector4(0, 0, 0, 1));
  /** (U m/s, step time s, chop toward x, z) */
  const uMotion = uniform(new THREE.Vector4(0, 0, 0, -1));
  /** the stern's centre (x, z) and the direction it moves through the water (unit x, z): where the wake is LAID */
  const uCourse = uniform(new THREE.Vector4(0, 0, 0, 1));
  /** (slapFoam, bowFoam, collarWidth, chopSpread) */
  const uFoam = uniform(new THREE.Vector4());
  /** (runup, runupReach, churnReach, churnWay) */
  const uRun = uniform(new THREE.Vector4());
  /** (pressureGain, sideCp, sternCp, pressureReach) */
  const uPress = uniform(new THREE.Vector4());
  /** (heapMax, 0, 0, spiral) */
  const uMisc = uniform(new THREE.Vector4());
  /** (rippleHeight, length 1, rippleReach, length 2) */
  const uRipple = uniform(new THREE.Vector4());
  const uChopLen = uniform(new THREE.Vector3());
  /** (eddyCore, eddySpread, stirRadius, stirSpread) */
  const uEddyShape = uniform(new THREE.Vector4());
  /** (stirDecay, roughSlope, roughLength 1, roughLength 2) */
  const uStir = uniform(new THREE.Vector4());
  /** per eddy: (x, z, circulation now, age) */
  const eddyVecs = Array.from({ length: HULL_EDDIES }, () => new THREE.Vector4(0, 0, 0, 0));
  /** per eddy: (dimple depth now, 0, 0, 0) */
  const dimpleVecs = Array.from({ length: HULL_EDDIES }, () => new THREE.Vector4(0, 0, 0, 0));
  const uEddies = uniformArray<'vec4'>(eddyVecs);
  const uDimples = uniformArray<'vec4'>(dimpleVecs);
  const uEddyCount = uniform(0);
  /** per launch: (x, z, its right x, its right z) and (age s, crest m now, 0, 0) */
  const pushPosVecs = Array.from({ length: HULL_PUSHES }, () => new THREE.Vector4(0, 0, 1, 0));
  const pushMetaVecs = Array.from({ length: HULL_PUSHES }, () => new THREE.Vector4());
  const uPushPos = uniformArray<'vec4'>(pushPosVecs);
  const uPushMeta = uniformArray<'vec4'>(pushMetaVecs);
  const uPushCount = uniform(0);
  /** the push wave's length (m) */
  const uPushLength = uniform(2.2);
  const uRoughen = uniform(0);
  const uRoughGain = uniform(0);
  /** (lumpHeight, lumpLength, lumpFineHeight, lumpFineLength) */
  const uLump = uniform(new THREE.Vector4());
  /** (laneSlick, laneApron, laneRagged, gate on way 0..1) and (aerFoam, aerReach, aerCell, ringFoam) and curlFoam */
  const uLane = uniform(new THREE.Vector4());
  const uAer = uniform(new THREE.Vector4());
  const uCurl = uniform(0);
  /** (boilHeight, boilCell, boilSlick, boilPeriod) */
  const uBoil = uniform(new THREE.Vector4());

  const pose = { x: 0, z: 0, fx: 0, fz: 1, speed: 0, t: 0, cx: 0, cz: 1 };
  /** m/s: the water's own drift this step (the current that carries the raft and its wake alike) */
  const drift = { x: 0, z: 0 };
  let odo = 0;
  let shed = 0;
  const eddies: Array<Eddy & { dimple: number }> = [];
  const pushes: Array<{ x: number; z: number; rx: number; rz: number; born: number; amp: number }> = [];
  /** the last launch slot (floor(t / pushEvery)); NaN until the first step after a reset */
  let lastPush = Number.NaN;

  /**
   * The logs' outline: signed distance (m, + outside) and its gradient (local u = starboard, v = bow), as the
   * polynomial smooth-min of one capsule per log. smin's exact gradient is mix(∇b, ∇a, h) (the h-derivative terms
   * cancel), so the normal is continuous round the stagger's concave corners — no seams in the heap or the rings.
   */
  const outline = (u: any, v: any): { d: any; gu: any; gv: any } => {
    let d: any = null;
    let gu: any = null;
    let gv: any = null;
    for (const l of logs) {
      const a = l.zStern + l.r;
      const b = Math.max(a, l.zBow - l.r);
      const du = u.sub(l.x);
      const dv = v.sub(v.clamp(a, b));
      const len = vec2(du, dv).length().max(EPS);
      const di = len.sub(l.r);
      const gui = du.div(len);
      const gvi = dv.div(len);
      if (d === null) {
        d = di;
        gu = gui;
        gv = gvi;
        continue;
      }
      // smin(d, di): h → 1 where di is the nearer
      const h = d.sub(di).mul(0.5 / BLEND).add(0.5).clamp(0, 1);
      d = mix(d, di, h).sub(h.mul(h.oneMinus()).mul(BLEND));
      gu = mix(gu, gui, h);
      gv = mix(gv, gvi, h);
    }
    return { d, gu, gv };
  };

  /** §V48 keep-weight of a periodic term of length `len` (m) on a grid of `texel` (m): 0 under 2.5 texels, 1 by 6 */
  const bandKeep = (len: any, texel: any): any => smoothstep(2.5, 6, len.div(texel.max(EPS)));

  return {
    /** the live look (see HullContactParams) */
    params: p,
    /** the logs' extent the near field is laid round (m, hull frame) */
    extent: { stern, bow, halfBeam },
    /** the gain the banked roughness (−.g) puts on the sea's fine ripples (flowfoam `wakeSmoothNode`) */
    roughGainNode: uRoughGain,

    /**
     * The near field at a world-XZ node, in the analytic wake's own shape: `rate` = (foam/s, slick/s, slopeX,
     * slopeZ), `elev` = m. `detail` false (the far tier) carries the collar's dose only — its 2.5 m texels hold no
     * shape at all (§V48). No slick: a damped lane astern of a slow hull read as an oil trail.
     */
    fieldNode(worldXZ: any, detail: boolean, texel: any = float(0.125)): { rate: any; elev: any } {
      const foam = float(0).toVar();
      /** slick (.g) laid this step: the wake scar's lane, then the boils' tops */
      const slick = float(0).toVar();
      const slope = vec2(0, 0).toVar();
      const elev = float(0).toVar();
      /** how churned the water is (0..∞, saturated below): alongside and just astern, from the near block */
      const churn = float(0).toVar();
      /** 0..~1: the water worked alongside the logs (roughened, `roughen`) */
      const alongside = float(0).toVar();
      /** m off the logs (large away from the raft): the trail's lumps keep clear of them (see the lumps below) */
      const offLogs = float(REACH).toVar();
      const rel = worldXZ.sub(vec2(uPose.x, uPose.y));
      const fx: any = uPose.z;
      const fz: any = uPose.w;
      const U: any = uMotion.x;
      const t: any = uMotion.y;
      // hull frame: u to starboard (right = (fz, −fx)), v toward the bow
      const u = rel.x.mul(fz).sub(rel.y.mul(fx)).toVar();
      const v = rel.x.mul(fx).add(rel.y.mul(fz)).toVar();
      const near = u.abs().lessThan(halfBeam + REACH).and(v.greaterThan(stern - REACH)).and(v.lessThan(bow + REACH));
      If(near, () => {
        const o = outline(u, v);
        const d = o.d.toVar();
        offLogs.assign(d);
        const out = d.max(0);
        // the outline's outward normal, local and world
        const nLen = vec2(o.gu, o.gv).length().max(EPS);
        const nu = o.gu.div(nLen).toVar();
        const nv = o.gv.div(nLen).toVar();
        const nWorld = vec2(nu.mul(fz).add(nv.mul(fx)), nu.mul(fx).negate().add(nv.mul(fz))).toVar();
        const chopDir = vec2(uMotion.z, uMotion.w);

        // ── 1. THE LOGS IN THE WATER ─────────────────────────────────────────────────────────────────────────
        // Three short trains about the wind (a stand-in for the sea's chop: the raft is posed on the long waves
        // only, so it is these it cannot follow). Each arrives on the faces turned to it: there the water runs up
        // (its height, doubled by the reflection) and, while it RISES fast, slaps — 0..1 per train
        const slap = float(0).toVar();
        const level = float(0).toVar();
        const kick = float(0).toVar();
        const lens = [uChopLen.x, uChopLen.y, uChopLen.z];
        const angles = [-1, 0.35, 1];
        lens.forEach((len, i) => {
          const ang = uFoam.w.mul(angles[i]);
          const c = ang.cos();
          const s = ang.sin();
          const k = vec2(chopDir.x.mul(c).sub(chopDir.y.mul(s)), chopDir.x.mul(s).add(chopDir.y.mul(c)));
          const kn = float(2 * Math.PI).div(len.max(0.1));
          const w = kn.mul(G).sqrt();
          const phase = worldXZ.dot(k).mul(kn).sub(t.mul(w)).add(i * 2.1);
          const facing = smoothstep(-0.25, 0.6, nWorld.dot(k).negate());
          // the rise, sharpened: a slap is the fast part of it, not the whole half-period
          const rise = phase.cos().negate().max(0);
          slap.addAssign(rise.mul(rise).mul(rise).mul(facing));
          level.addAssign(phase.sin().mul(facing.mul(0.75).add(0.25)).mul(2 / 3));
          kick.addAssign(phase.sin().mul(1 / 3));
        });
        // white water: where it slaps, and at the bow face under way; broken into patches (a collar, not a line)
        const np = worldXZ.mul(2.1).add(vec2(t.mul(0.21), t.mul(-0.15)));
        const patch = smoothstep(0.48, 0.7, fbm2(np, 2)).toVar();
        const bowFace = smoothstep(0.2, 0.85, nv).mul(U);
        // under way the transom's faces draw AWAY from the water (separated, not slapped): left on, every log end
        // laid its own line of white astern as the raft moved on — the streaks fanning from the stern (2026-10-29)
        const lee = smoothstep(0.15, 0.6, U).mul(smoothstep(0.1, 0.6, nv.negate())).oneMinus();
        // NONE UNDER WAY (the 2026-10-29 review: "stripey stuff in the foam … pointing to wherever the boat is NOW"):
        // a source riding the hull lays a LINE along its track however it is broken up — each staggered log end at the
        // bow drew its own, nine parallel streaks combing out astern. The slaps' white water is for a raft lying still
        // (drifting, aground); under way the foam is the stern's churned patches (`patchFoam`), laid where a
        // world-anchored pattern says, not where the hull's edges are
        // Under way the SIDES still slap (the 2026-10-29 review of 545 s: the contact line "artificial and very straight
        // … too intense", where it should be "thin, broken, intermittent … where the chop slaps"): a share of the slaps,
        // off the sides only (|nv| small: a bow or stern face under way lays a line astern), each a dash of white the
        // raft leaves behind a metre or two long — intermittent with the chop's own rise, broken by the patches
        const still = smoothstep(0.6, 0.25, U);
        const sideFace = smoothstep(0.45, 0.2, nv.abs());
        const slapsUnderWay = slap.mul(sideFace).mul(UNDER_WAY_SLAP).mul(still.oneMinus());
        const white = slap.mul(lee).mul(uFoam.x).add(bowFace.mul(uFoam.y)).mul(still).add(slapsUnderWay.mul(uFoam.x));
        const collar = out.div(uFoam.z.max(0.03)).negate().exp().mul(smoothstep(-0.25, 0, d));
        foam.assign(white.mul(collar).mul(patch));
        // THE BOW'S CURL under way (`curlFoam`): white where the leading logs' faces push into the water — the centre
        // logs only (|u| < ½ half-beam), whose foam the raft then covers as it moves on, so it never trails a line
        const curl = smoothstep(0.55, 0.9, nv).mul(smoothstep(halfBeam * 0.55, halfBeam * 0.35, u.abs()))
          .mul(smoothstep(bow - 3, bow - 1.5, v)).mul(U).mul(uCurl);
        foam.addAssign(curl.mul(collar).mul(patch.mul(0.6).add(0.4)));
        // THE WAKE SCAR's source (`laneSlick`): over the apron ASTERN of the transom only, its edge ragged in the world.
        // Not under and alongside the logs: laid there, the water beside the hull was glassy — "very plasticky" round the
        // nearest logs (the 2026-10-29 review); alongside, the water the hull works is ROUGHENED instead (`roughen`)
        const ragged = fbm2(worldXZ.mul(0.18).add(vec2(3.1, 17.9)), 2).sub(0.5).mul(2).mul(uLane.z);
        const laneHalf = float(halfBeam).add(ragged);
        // (the zones astern in the frame of the stern's MOTION through the water, from its centre: the trail is laid
        // where the stern has been, along its course — a raft crabbing 20° through its turn in to the beach laid it
        // off to one side in the hull's own frame, 2026-10-30)
        const sr = worldXZ.sub(vec2(uCourse.x, uCourse.y));
        const vC = sr.dot(vec2(uCourse.z, uCourse.w));
        const uC = sr.dot(vec2(uCourse.w, uCourse.z.negate()));
        const laneArea = smoothstep(laneHalf.add(0.5), laneHalf.sub(0.5), uC.abs())
          .mul(smoothstep(uLane.y.negate().sub(0.5), uLane.y.negate().add(0.5), vC))
          .mul(smoothstep(0.3, -0.5, vC));
        slick.assign(uLane.x.mul(uLane.w).mul(laneArea));
        // AERATED CLUMPS (`aerFoam`): over the first `aerReach` m astern, where world-anchored cells say
        const behind = vC.negate();
        const aerZone = smoothstep(-0.6, 0.6, behind).mul(smoothstep(uAer.y, uAer.y.mul(0.4), behind))
          .mul(smoothstep(halfBeam + 1, halfBeam - 0.5, uC.abs()));
        const cell = cellular2(worldXZ.div(uAer.z).add(vec2(7.7, 2.3)));
        const clumps = smoothstep(0.42, 0.12, cell.x).mul(cell.z.mul(0.6).add(0.4));
        foam.addAssign(uAer.x.mul(U).mul(aerZone).mul(clumps));
        // the logs' working, for the rings: the slaps, the way, and a floor (the logs never quite still)
        const working = slap.add(U.mul(0.4)).add(0.25).min(2);
        churn.assign(smoothstep(stern + 2, stern - 1, v).mul(0.5).add(0.5)
          .mul(out.div(uRun.z.max(0.1)).negate().exp()).mul(U.mul(uRun.w)));
        // the water the hull works ALONGSIDE (within churnReach of the logs, ahead of the transom), roughened: the
        // slaps' chop and ripples, at rest as under way — never calmer than the open sea round it
        alongside.assign(out.div(uRun.z.max(0.1)).negate().exp().mul(smoothstep(-0.5, 0.2, d)).mul(smoothstep(float(stern).sub(0.5), float(stern).add(0.5), v))
          .mul(working.mul(0.5).add(0.4)));
        if (detail) {
          // ── 2. DISPLACEMENT: η = min(gain·U²/2g, heapMax)·Cp(c)·e^(−d⁺/reach), c = the core's normal on the bow axis
          // Cp: 1 at the stem (stagnation), sideCp abeam (the flow speeding past), sternCp at the transom
          // (separated: the base pressure). Quadratic in c either side of 0, so Cp'(0) = 0 and the side region
          // (where c ≡ 0) joins the caps with a continuous gradient.
          const qv = v.clamp(coreAft, coreFwd);
          const cv = v.sub(qv);
          const cLen = vec2(u, cv).length().max(EPS);
          const cc = cv.div(cLen);
          const inCap = v.greaterThan(coreFwd).or(v.lessThan(coreAft));
          // ∇c in the caps: (f − c·n)/|p − q|; 0 abeam
          const dcu = select(inCap, cc.mul(u).div(cLen).negate().div(cLen), float(0));
          const dcv = select(inCap, float(1).sub(cc.mul(cc)).div(cLen), float(0));
          const sideCp = uPress.y;
          const fwdK = float(1).sub(sideCp);
          const aftK = uPress.z.sub(sideCp);
          const ahead = cc.greaterThanEqual(0);
          const cp = select(ahead, sideCp.add(fwdK.mul(cc).mul(cc)), sideCp.add(aftK.mul(cc).mul(cc)));
          const dcp = select(ahead, fwdK.mul(cc).mul(2), aftK.mul(cc).mul(2));
          const amp = uPress.x.mul(U).mul(U).div(2 * G).min(uMisc.x);
          const reachP = uPress.w.max(0.1);
          const fall0 = out.div(reachP).negate().exp();
          const dFall0 = select(d.greaterThan(0), fall0.div(reachP).negate(), float(0));
          // NO TROUGH AT THE LOGS THEMSELVES. The raft is posed on the CpuOcean, which knows nothing of this field: a
          // depression reaching the logs dropped the drawn water under them and they stood on it (545 s, with the
          // run-up's troughs, 0.2–0.3 m of air under the stern — the 2026-10-29 review). The side trough and the
          // transom's hollow open out from the logs over the first PRESS_CLEAR m; the heap (raised water) may touch
          const lowered: any = cp.lessThan(0);
          const xq = out.div(PRESS_CLEAR).clamp(0, 1);
          const xs: any = xq;
          const clear = select(lowered, xs.mul(xs).mul(float(3).sub(xs.mul(2))), float(1));
          const dClear = select(lowered.and(d.greaterThan(0)).and(d.lessThan(PRESS_CLEAR)), xs.mul(xs.oneMinus()).mul(6 / PRESS_CLEAR), float(0));
          const fall = fall0.mul(clear);
          const dFall = dFall0.mul(clear).add(fall0.mul(dClear));
          // + the run-up at the faces: level·e^(−d⁺/runupReach), its slope along the normal only — the water RIDING UP
          // the logs at full height, drawing down from them at a quarter (the same reason: the logs float on a sea that
          // does not draw down)
          const reachU = uRun.y.max(0.1);
          const lift = level.max(0).add(level.min(0).mul(0.25));
          const run = uRun.x.mul(lift).mul(out.div(reachU).negate().exp());
          const dRun = select(d.greaterThan(0), run.div(reachU).negate(), float(0));
          const hu: any = amp.mul(dcp.mul(dcu).mul(fall).add(cp.mul(dFall).mul(nu))).add(dRun.mul(nu));
          const hv: any = amp.mul(dcp.mul(dcv).mul(fall).add(cp.mul(dFall).mul(nv))).add(dRun.mul(nv));
          elev.assign(amp.mul(cp).mul(fall).add(run));
          // local gradient → world: right·hu + forward·hv
          slope.assign(vec2(hu.mul(fz).add(hv.mul(fx)), hu.mul(fx).negate().add(hv.mul(fz))));
          // ── 2b. RIPPLE RINGS off the logs, outgoing (phase k·d − ωt): slope only (see the header) ──────────────
          // Their height follows the logs' working at the nearest stretch, broken by the collar's own patches and
          // their phase by the chop's (a ring all round the hull at one height read as a drawn contour)
          const reachR = uRipple.z.max(0.1);
          const env = out.div(reachR).negate().exp().mul(smoothstep(0, 0.15, d));
          const ring = (len: any, seed: number): any => {
            const kn = float(2 * Math.PI).div(len.max(0.1));
            const w = kn.mul(G).sqrt();
            const ph = d.mul(kn).sub(t.mul(w)).add(kick.mul(2.5)).add(seed);
            // dη/dd of sin(ph)·env (the envelope's own slope kept: past the first crest it is the larger term)
            return ph.cos().mul(kn).sub(ph.sin().div(reachR)).mul(bandKeep(len, texel));
          };
          const rd = uRipple.x.mul(working).mul(env).mul(patch.mul(0.6).add(0.4))
            .mul(ring(uRipple.y, 0).add(ring(uRipple.w, 1.7)).mul(0.5));
          slope.addAssign(nWorld.mul(rd));
        }
      });

      // ── 3. TURBULENCE: the churned water alongside and astern, and the water the shed eddies stir ─────────────
      // stir ∈ [0, 1): 1 − e^(−Σ) over Gaussian blobs round each eddy, widening and fading with its age, plus the
      // churn by the logs. Round each eddy the roughness winds into two spiral arms (phase: twice the angle, plus
      // the log of the radius turned with the eddy's own sense), so the band shows the eddies turning in it
      const sum = float(0).toVar();
      const arms = float(0).toVar();
      const dimple = float(0).toVar();
      const dimpleSlope = vec2(0, 0).toVar();
      Loop(HULL_EDDIES, ({ i }) => {
        If(float(i).lessThan(uEddyCount), () => {
          const e = uEddies.element(int(i));
          const age = e.w;
          const rad = uEddyShape.z.add(uEddyShape.w.mul(age));
          const dp = worldXZ.sub(vec2(e.x, e.y));
          const r2 = dp.dot(dp);
          const life = age.div(uStir.x.max(EPS)).negate().exp().mul(age.min(1));
          const wgt = r2.div(rad.mul(rad).max(EPS)).negate().exp().mul(life);
          sum.addAssign(wgt);
          const rc = uEddyShape.x.add(uEddyShape.y.mul(age));
          const r = r2.sqrt().max(EPS);
          const turn = select(e.z.greaterThanEqual(0), float(1), float(-1));
          const psi = atan(dp.y, dp.x).mul(2).add(r.div(rc.max(EPS)).add(1).log().mul(3).mul(turn)).sub(t.mul(0.25).mul(turn));
          arms.addAssign(wgt.mul(psi.cos().mul(0.5).add(0.5)));
          if (detail) {
            // the broken ring of bubbles round a young eddy (`ringFoam`): its gaps world-anchored, so once laid the
            // eddy's own flow turns them about it
            const ringR = rc.mul(1.35);
            const ring = float(1).sub(r.sub(ringR).abs().div(0.35)).clamp(0, 1);
            const gaps = smoothstep(0.45, 0.65, fbm2(worldXZ.mul(1.3).add(vec2(11.3, 4.9)), 2));
            const young = age.div(2.5).negate().exp().mul(age.min(1)).mul(e.z.abs().div(1.5).min(1));
            foam.addAssign(uAer.w.mul(ring).mul(gaps).mul(young));
            // the core's dimple, −depth·e^(−r²/rc²), and its gradient
            const bell = r2.div(rc.mul(rc).max(EPS)).negate().exp();
            const depth = uDimples.element(int(i)).x;
            dimple.subAssign(depth.mul(bell));
            dimpleSlope.addAssign(dp.mul(depth.mul(bell).mul(2).div(rc.mul(rc).max(EPS))));
          }
        });
      });
      const stir = sum.add(churn).negate().exp().oneMinus().toVar();
      // THE BOILS (see `boilHeight`): domes on a drifting cellular field, each cell pulsing at its own phase; kept off
      // the logs' first metre as the lumps are. Their share of the stirred water also decides where it is glassy (on a
      // dome) and where it banks roughness (between them)
      const boilTop = float(0).toVar();
      If(stir.greaterThan(0.002), () => {
        const drift = vec2(t.mul(0.02), t.mul(-0.015));
        const domeAt = (xz: any): any => {
          const c = cellular2(xz.div(uBoil.y).add(drift).add(13.7));
          const pulse = c.z.add(t.div(uBoil.w)).mul(2 * Math.PI).sin().mul(0.5).add(0.5);
          return smoothstep(0.45, 0.05, c.x).mul(pulse);
        };
        const dome0 = domeAt(worldXZ).toVar();
        boilTop.assign(dome0.mul(stir).mul(smoothstep(0.3, 1.2, offLogs)));
        if (detail) {
          // η = H·dome·stir, and its slope by forward differences over BOIL_STEP (a dome is ~2 m across)
          const step = BOIL_STEP;
          const dx = domeAt(worldXZ.add(vec2(step, 0))).sub(dome0).div(step);
          const dz = domeAt(worldXZ.add(vec2(0, step))).sub(dome0).div(step);
          const k = uBoil.x.mul(stir).mul(smoothstep(0.3, 1.2, offLogs));
          elev.addAssign(dome0.mul(k));
          slope.addAssign(vec2(dx, dz).mul(k));
        }
      });
      if (detail) {
        elev.addAssign(dimple);
        slope.addAssign(dimpleSlope);
        If(stir.greaterThan(0.002), () => {
          // the spiral share: arms where the eddies' stir dominates, even boils where the logs' churn does
          const spiral = arms.div(sum.add(churn).max(EPS)).mul(uMisc.w).add(uMisc.w.oneMinus());
          // patchy at a larger scale: some of the band boils hard, some is only ruffled
          const pp = worldXZ.mul(0.25).add(vec2(t.mul(0.02), t.mul(-0.015)));
          const patches = smoothstep(0.25, 0.7, fbm2(pp, 2)).mul(0.4).add(0.6);
          // the boils: two octaves of gradient noise, each scrolling its own way (so the surface churns rather than
          // slides); slope = amplitude × the noise's analytic gradient, §V48 per octave against the texel
          const boil = (len: any, dir: [number, number], seed: number): any => {
            const q = worldXZ.div(len.max(0.1)).add(vec2(t.mul(dir[0]), t.mul(dir[1]))).add(seed);
            const g = gradNoise2(q);
            // (kept down to 2.2 texels, not the rings' 2.5–6: a lump field, not a wave train, it has no period to
            // alias into a moiré, and the ocean's own footprint gate takes it out where a pixel outgrows it)
            return vec2(g.y, g.z).mul(smoothstep(2.2, 4.5, len.div(texel.max(EPS))));
          };
          const rough = boil(uStir.z, [0.11, -0.07], 0).add(boil(uStir.w, [-0.19, 0.13], 17.3).mul(0.7));
          // (rough only where the logs churn it, just astern: the lane the eddies stir is GLASSY, the wake scar, and
          // its boils are smooth domes)
          const churnShare = churn.div(sum.add(churn).max(EPS));
          slope.addAssign(rough.mul(uStir.y).mul(stir).mul(spiral).mul(patches).mul(churnShare));
          // THE LUMPS (see `lumpHeight`): the stirred band's surface heaved into mounds and dimples, drifting and
          // boiling slowly. η = H·n(x/L) with n gradient noise in [−1, 1], so ∇η = H·∇n/L exactly — the shape the eye
          // sees in the mesh IS the shape the normal shades. Kept off the logs' first metre: the raft is posed on a sea
          // without them (raft.ts floats on the CpuOcean), so a dimple under a log would stand it on air
          const clear = smoothstep(0.3, 1.2, offLogs);
          const lumpEnv = stir.mul(patches).mul(clear).mul(churnShare);
          const qa = worldXZ.div(uLump.y).add(vec2(t.mul(0.03), t.mul(-0.022))).add(5.1);
          const ga = gradNoise2(qa);
          const qb = worldXZ.div(uLump.w).add(vec2(t.mul(-0.07), t.mul(0.05))).add(41.7);
          const gb = gradNoise2(qb);
          elev.addAssign(ga.x.mul(uLump.x).mul(lumpEnv));
          slope.addAssign(vec2(ga.y, ga.z).mul(uLump.x.div(uLump.y)).add(
            vec2(gb.y, gb.z).mul(uLump.z.div(uLump.w)).mul(smoothstep(2.2, 4.5, uLump.w.div(texel.max(EPS)))),
          ).mul(lumpEnv));
        });
      }
      if (detail) {
        // ── 4. THE WATER PUSHED ASIDE, launched from where the hull WAS (see `pushHeight`) ───────────────────────
        // Each launch an outgoing packet: centred on the hull's half-beam plus its group speed × age, its crests
        // running at the phase speed inside it, weighted to the sides of the heading it had then (cos² off the
        // beam), spreading as 1/√r. η and its radial slope, summed over the launches; kept off the logs' first metre
        const kP = float(2 * Math.PI).div(uPushLength);
        const wP = kP.mul(G).sqrt();
        const cg = wP.div(kP).mul(0.5);
        const pushEta = float(0).toVar();
        const pushSlope = vec2(0, 0).toVar();
        Loop(HULL_PUSHES, ({ i }) => {
          If(float(i).lessThan(uPushCount), () => {
            const a = uPushPos.element(int(i));
            const m = uPushMeta.element(int(i));
            const age = m.x;
            const dp = worldXZ.sub(vec2(a.x, a.y));
            const r = dp.length().max(EPS);
            const rc = cg.mul(age).add(halfBeam);
            const w = age.mul(0.08).add(0.7);
            const xr = r.sub(rc).div(w);
            If(xr.abs().lessThan(3), () => {
              const env = xr.mul(xr).negate().exp();
              const side = dp.dot(vec2(a.z, a.w)).div(r);
              const amp = m.y.mul(env).mul(side.mul(side)).div(rc.div(3).add(1).sqrt());
              const ph = kP.mul(r.sub(halfBeam)).sub(wP.mul(age));
              pushEta.addAssign(amp.mul(ph.cos()));
              const dr = amp.mul(kP.mul(ph.sin()).negate().sub(xr.mul(2).div(w).mul(ph.cos())));
              pushSlope.addAssign(dp.div(r).mul(dr));
            });
          });
        });
        const clearP = smoothstep(0.3, 1.2, offLogs);
        elev.addAssign(pushEta.mul(clearP));
        slope.addAssign(pushSlope.mul(clearP).mul(bandKeep(uPushLength, texel)));
      }
      // the churned water banks roughness (a negative slick: see `roughen`) — between the boils; glassy on their tops
      const banked = slick.add(uBoil.z.mul(boilTop)).sub(uRoughen.mul(stir.mul(0.3).add(alongside)).mul(boilTop.oneMinus()));
      // (the far tier takes the slick alone: its 2.5 m texels and 12 s foam life turned the bubbles into a broad milky
      // sheet with angular edges; bubbles are near-field, seconds old)
      return { rate: vec4(detail ? foam : float(0), banked, slope.x, slope.y), elev };
    },

    /**
     * The eddies' induced velocity (m/s, world XZ) at a node: Lamb–Oseen cores, Γ/(2πr)·(1 − e^(−r²/rc²)) round
     * each (rc widening with age). For the advect pass's `extraFlow`.
     */
    flowNode(worldXZ: any): any {
      const vel = vec2(0, 0).toVar();
      Loop(HULL_EDDIES, ({ i }) => {
        If(float(i).lessThan(uEddyCount), () => {
          const e = uEddies.element(int(i));
          const rc = uEddyShape.x.add(uEddyShape.y.mul(e.w));
          const dp = worldXZ.sub(vec2(e.x, e.y));
          const r2 = dp.dot(dp).max(EPS);
          const k = e.z.div(r2.mul(2 * Math.PI)).mul(float(1).sub(r2.div(rc.mul(rc).max(EPS)).negate().exp()));
          vel.addAssign(vec2(dp.y.negate(), dp.x).mul(k));
        });
      });
      return vel;
    },

    /** this step's pose: centre (m), heading (rad, 0 = bow toward +z), way through the water (m/s), sea time (s),
     * the heading the wind's chop runs toward (rad), and the COURSE through the water (rad; default the heading) —
     * where the stern actually goes, which the wake astern is laid along */
    setPose(x: number, z: number, heading: number, speed: number, t: number, chopTo: number, course = heading): void {
      pose.x = x;
      pose.z = z;
      pose.fx = Math.sin(heading);
      pose.fz = Math.cos(heading);
      pose.cx = Math.sin(course);
      pose.cz = Math.cos(course);
      uCourse.value.set(x + pose.fx * stern, z + pose.fz * stern, pose.cx, pose.cz);
      pose.speed = Number.isFinite(speed) ? Math.max(0, speed) : 0;
      pose.t = t;
      uPose.value.set(x, z, pose.fx, pose.fz);
      uMotion.value.set(pose.speed, t, Math.sin(chopTo), Math.cos(chopTo));
    },

    /** the water's own drift (m/s, world) for the steps that follow: the eddies and the launched waves ride it, as the
     * accumulation's foam and slick do (the page sets the same as flowfoam's base flow) */
    setCurrent(x: number, z: number): void {
      drift.x = Number.isFinite(x) ? x : 0;
      drift.z = Number.isFinite(z) ? z : 0;
    },

    /** one replay step of `dt` s at the pose last set: the odometer, the eddies shed off the stern corners, the uniforms */
    advance(dt: number): void {
      // what was laid drifts with the water
      for (const e of eddies) {
        e.x += drift.x * dt;
        e.z += drift.z * dt;
      }
      for (const q of pushes) {
        q.x += drift.x * dt;
        q.z += drift.z * dt;
      }
      const prev = odo;
      odo += pose.speed * Math.max(0, dt);
      const spacing = Math.max(0.5, p.shedSpacing);
      // shed at each multiple of the spacing passed (port first), from the corners a little outboard and astern
      for (let n = Math.floor(prev / spacing) + 1; n * spacing <= odo; n++) {
        const side = shed++ % 2 === 0 ? -1 : 1;
        const off = halfBeam + 0.3;
        eddies.push({
          x: pose.x + pose.fz * side * off + pose.fx * stern - pose.cx * 0.6,
          z: pose.z - pose.fx * side * off + pose.fz * stern - pose.cz * 0.6,
          // port (side −1) turns +x → +z: the water by the hull dragged forward, the water outboard still
          // Γ such that the water at the core's edge turns at shedStrength·U·0.3 (a bluff wake's eddies run at ~¼ of the
          // way): Lamb–Oseen's v(rc) = 0.72·Γ/(2π·rc)
          gamma: (-side * p.shedStrength * 0.3 * pose.speed * 2 * Math.PI * p.eddyCore) / 0.72,
          dimple: p.eddyDimple * pose.speed,
          born: pose.t,
        });
      }
      while (eddies.length > 0 && (eddies.length > HULL_EDDIES || pose.t - eddies[0].born > p.eddyLife)) eddies.shift();
      // a push wave launched each `pushEvery` s of sea time (slots on the absolute clock: the same launches however
      // the replay is stepped) from where the hull is, to the sides of the heading it has
      const every = Math.max(0.05, p.pushEvery);
      const slot = Math.floor(pose.t / every);
      if (Number.isNaN(lastPush)) lastPush = slot;
      else if (slot > lastPush) {
        lastPush = slot;
        // (each launch its own height, 0.3–1× — a hash of its slot: launches of one height every 0.4 s summed into a
        // regular train of concentric arcs, drawn in the glitter as ruled stripes near the eye, 2026-10-29)
        const h = Math.abs(Math.sin(slot * 12.9898) * 43758.5453) % 1;
        if (pose.speed > 0.05) pushes.push({ x: pose.x, z: pose.z, rx: pose.cz, rz: -pose.cx, born: pose.t, amp: p.pushHeight * pose.speed * (0.3 + 0.7 * h * h) });
      }
      const pushLife = HULL_PUSHES * every;
      while (pushes.length > 0 && (pushes.length > HULL_PUSHES || pose.t - pushes[0].born > pushLife)) pushes.shift();
      for (let i = 0; i < HULL_PUSHES; i++) {
        const q = pushes[i];
        if (!q) {
          pushPosVecs[i].set(0, 0, 1, 0);
          pushMetaVecs[i].set(0, 0, 0, 0);
          continue;
        }
        const age = Math.max(0, pose.t - q.born);
        // fading by `pushDecay`, and gone smoothly before its slot is reused
        const fade = Math.exp(-age / Math.max(EPS, p.pushDecay)) * smooth01((pushLife - age) / (pushLife * 0.3));
        pushPosVecs[i].set(q.x, q.z, q.rx, q.rz);
        pushMetaVecs[i].set(age, q.amp * fade, 0, 0);
      }
      uPushCount.value = Math.min(pushes.length, HULL_PUSHES);
      uPushLength.value = Math.max(0.5, p.pushLength);
      for (let i = 0; i < HULL_EDDIES; i++) {
        const e = eddies[i];
        if (!e) {
          eddyVecs[i].set(0, 0, 0, 0);
          dimpleVecs[i].set(0, 0, 0, 0);
          continue;
        }
        const age = Math.max(0, pose.t - e.born);
        const fade = Math.min(1, age) * smooth01((p.eddyLife - age) / (p.eddyLife * 0.3));
        const left = Math.exp(-age / Math.max(EPS, p.eddyDecay)) * fade;
        eddyVecs[i].set(e.x, e.z, e.gamma * left, age);
        dimpleVecs[i].set(e.dimple * left, 0, 0, 0);
      }
      uEddyCount.value = Math.min(eddies.length, HULL_EDDIES);
      uFoam.value.set(p.slapFoam, p.bowFoam, p.collarWidth, p.chopSpread);
      uRun.value.set(p.runup, p.runupReach, p.churnReach, p.churnWay);
      uPress.value.set(p.pressureGain, p.sideCp, p.sternCp, p.pressureReach);
      uMisc.value.set(p.heapMax, 0, 0, p.spiral);
      uRipple.value.set(p.rippleHeight, p.rippleLengths[0], p.rippleReach, p.rippleLengths[1]);
      uChopLen.value.set(...p.chopLengths);
      uEddyShape.value.set(p.eddyCore, p.eddySpread, p.stirRadius, p.stirSpread);
      // (the stirred water fades with the eddies: past eddyLife they are dropped, so their stir must be gone by then)
      uStir.value.set(Math.min(p.stirDecay, p.eddyLife / 2.5), p.roughSlope, p.roughLengths[0], p.roughLengths[1]);
      uRoughen.value = Math.max(0, p.roughen);
      uRoughGain.value = Math.max(0, p.roughGain);
      // (the scar's dose with the way the raft makes as it is laid: the newest wake fades as it slows)
      uLane.value.set(p.laneSlick, p.laneApron, p.laneRagged, Math.min(1.5, pose.speed / 1.2));
      uAer.value.set(p.aerFoam, p.aerReach, Math.max(0.3, p.aerCell), p.ringFoam);
      uCurl.value = p.curlFoam;
      uLump.value.set(p.lumpHeight, Math.max(0.1, p.lumpLength), p.lumpFineHeight, Math.max(0.1, p.lumpFineLength));
      uBoil.value.set(p.boilHeight, Math.max(0.3, p.boilCell), p.boilSlick, Math.max(1, p.boilPeriod));
    },

    /** back to calm water: no eddies, the odometer at 0 (a page that replays its wake from a fixed start) */
    reset(): void {
      drift.x = 0;
      drift.z = 0;
      odo = 0;
      shed = 0;
      eddies.length = 0;
      uEddyCount.value = 0;
      pushes.length = 0;
      lastPush = Number.NaN;
      uPushCount.value = 0;
    },
  };
}

function smooth01(x: number): number {
  const k = Math.min(1, Math.max(0, x));
  return k * k * (3 - 2 * k);
}

export type HullContact = ReturnType<typeof createHullContact>;
