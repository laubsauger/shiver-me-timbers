/**
 * The Drift — fulldome origin story (drift.html). Act 1 "Undertime" tunables.
 *
 * Content and treatment: /Users/flo/work/code/drift-narrative/undertime/treatment.md.
 * Direction: drift-narrative/undertime/direction.md. The beats run in this order; each value is that
 * beat's length in seconds:
 *
 *   first   black; one hero pair overhead, its light shell sweeps the dome (the first light)
 *   arise   pairs ignite, a few then everywhere, until the dome boils
 *   cool    time slows: fewer, slower, longer pairs; the field turns; text windows
 *   wave    an annihilation front sweeps front → zenith → back; nothing is born behind it
 *   remain  darkness; one warm grain in front, then a few more; text
 *   zoom    pull back through orders of magnitude; the grains are seen to lie on a web
 *   gather  the web's knots ignite as the first stars; the signature
 *
 * Colour script: matter is warm amber-gold, antimatter cool cyan-violet, their light neutral gold-white. What
 * remains is matter, so it stays amber (`grainWarmth` tints it a little toward starlight) — the warm thing on
 * the dome is the thing that will become us; the first stars light amber to white and blue-white.
 *
 * Reload-scoped: `pairSlots`, `grainCount` (instance counts, baked into the draw).
 */
import { registerParams } from './registry';

export interface DriftParams {
  first: number;
  arise: number;
  cool: number;
  wave: number;
  remain: number;
  zoom: number;
  gather: number;
  /** field-s per act-s once cooled: how far "time slows" */
  slowRate: number;
  /** 0..1 pair density at the end of the cooling (what the wave front finds) */
  coolDensity: number;
  /** deg, field lean at the end of the cooling (it turns from `fieldTilt`) */
  fieldTiltEnd: number;
  /** m/s, top speed of the forward drift through the field (arise → cool) */
  driftSpeed: number;
  /** m, the slow approach toward the hero grain in the remain beat */
  approach: number;
  /** s, act time the hero pair is born (after the black) */
  heroBirth: number;
  /** m/s, hero pair launch speed (its spirals' size) */
  heroSpeed: number;
  /** m/s, speed of the hero's light shells (they pass the audience) */
  heroShellSpeed: number;
  heroShellRadiance: number;
  /** deg / m, where the hero grain sits in front (the zoom's pivot) */
  heroGrainEl: number;
  heroGrainDist: number;
  /** 0..1, grains' colour from matter toward starlight */
  grainWarmth: number;
  starRadiance: number;
  /** linear radiance of the wave front's band of light (U3) */
  waveRadiance: number;
  /** linear radiance of the wave front's sparks (U3) */
  sparkRadiance: number;
  /**
   * THE LIGHT WAVE AS A COLLAPSE (the 2026-10-30 review: "a better ramp into intensity … a total collapse of space
   * and time … too tame"). s of tension before the front rises, taken from the end of the cooling once its last
   * phrase has gone (32.3 s with the default text): births gather low in front, quicken and brighten, and a glow
   * comes up under the front horizon. The beat lengths are unchanged.
   */
  waveBuild: number;
  /** deg, the most the front pulls the field toward itself as it passes (space folding onto the front line) */
  waveLens: number;
  /** deg, how far either side of the front its pull reaches (the e-fold of the pinch) */
  waveLensWidth: number;
  /** linear radiance of the front itself: its white core (the shoulder rolls it off; its fringes are fractions) */
  frontRadiance: number;
  /**
   * 0..0.9, how hard the front STALLS over the audience (the held climax: the 2026-10-30 story note — the separate
   * dome-wide "glowing network" flashed up while the front was still climbing and lit the spent region behind it
   * again). The sweep's speed dips by this fraction as the front crosses the zenith, so it rushes up from the
   * horizon, hangs over the audience in its brightest light, and rushes away. 0 by default since the 2026-11-01 note
   * ("it kind of loses its swoosh a bit in the end before reaching the top"): the front accelerates into the zenith.
   */
  waveStall: number;
  /** linear radiance of the front's CREST: the broad band of light, textured as a caustic web, it carries as it
   * crosses overhead (ahead of its line mostly; behind it the dome is spent) */
  crestRadiance: number;
  /** s, e-fold of the afterglow: what the front froze (the field's last instant) cooling white → amber → ember */
  afterglow: number;
  /** how many grains the front leaves behind besides the hero grain (survivors.ts). 0: the hero grain alone is the
   * one in a billion (the 2026-11-01 note: "I liked this better when it really was just one that remained"; 16 in
   * the 2026-10-30 story pass). Reload-scoped */
  survivors: number;
  /** "a few more shades" (the 2026-10-30 review): each family's range, either side of its base colour.
   * Matter runs deep ember ← amber → pale gold; antimatter cyan ← azure → violet-magenta (direction.md's cooling
   * already names cyan and magenta tracks). Products of annihilation take the families' rose and teal. */
  matterDeep: number;
  matterPale: number;
  antiCyan: number;
  antiMagenta: number;
  productWarm: number;
  productCool: number;
  /**
   * THE PARTICLES' GLOW PROFILE (the 2026-10-30 note: "the particles' bloom falloff … a little bit thick and doesn't
   * have a smooth enough falloff … too thick in the inner and outer parts, just a smidge"). Each trail, bead and
   * flash is a sharp core plus a halo, both Gaussians, the halo windowed to exactly zero (with zero slope) at its
   * quad's edge. `glowCore` scales the core's width (1: ~10 % thinner than before, its energy kept, so it is
   * brighter at the centre), `glowHalo` the halo's width (1: ~25 % wider than before, lower so its energy is ~0.9 of
   * before), `glowHaloGain` the halo's energy.
   */
  glowCore: number;
  glowHalo: number;
  glowHaloGain: number;
  /** 1: the event grammar (photon collisions, looping pairs, plasma); 0: the spiral tracks (look-dev A/B) */
  grammar: number;
  /** concurrent pair slots; each draws two tracks and seven light sprites */
  pairSlots: number;
  /** quads per track ribbon */
  trackSegments: number;
  /** s of history a track shows behind its head */
  trackTail: number;
  /** m, track ribbon half-width at the head */
  trackWidth: number;
  /** m/s, launch speed of a pair's particles */
  trackSpeed: number;
  /** rad/s, how fast tracks curl around the field */
  trackCurl: number;
  /** 1/s, energy loss: how fast a track spirals in */
  trackDrag: number;
  /** deg, the field leans this far from the zenith toward the front */
  fieldTilt: number;
  /** linear radiance of a track at its head */
  trackRadiance: number;
  /** m, annihilation core sprite size */
  coreSize: number;
  coreRadiance: number;
  /** m/s, how fast an annihilation's light shell expands */
  shellSpeed: number;
  shellRadiance: number;
  /** m, size of the lingering haze an annihilation leaves */
  hazeSize: number;
  hazeRadiance: number;
  /** bloom on the finished frame (master or flat view) */
  bloomStrength: number;
  bloomRadius: number;
  bloomThreshold: number;
  /** leftover grains of matter, over all zoom levels */
  grainCount: number;
  /** m — pairs are scattered in a shell around the camera, this is its outer radius */
  fieldRadius: number;
  /** m — sprite size of one particle */
  particleSize: number;
  /** s — one pair's life, birth to flash (jittered ±30 % per slot) */
  pairLife: number;
  /** orders of magnitude the zoom beat pulls back through */
  zoomDecades: number;
  /** the web (webVolume.ts): box units the eye ends from the hero knot; deg the flight line turns through (by
   * the gather beat + 1 s, where the dive into the web begins: under 1°/s); the gas's radiance. The dive's target
   * filament was picked for these two (getTheDrift/webDive.ts): change them and the web's frame follows, but the
   * dive may miss its filament */
  webReach: number;
  webTurn: number;
  webRadiance: number;
  matterColor: number;
  antimatterColor: number;
  /** annihilation light, the flashes and the dome-wide glow */
  lightColor: number;
  /** first starlight */
  starColor: number;
  /** linear exposure into the ACES tone map */
  exposure: number;
  /** linear radiance of matter/antimatter sprites (HDR, before the tone map) */
  particleRadiance: number;
  /** deg, elevation of a text phrase's first line as it appears (keep text at 25–40° in front) */
  crawlElTop: number;
  /** deg, how far a phrase sinks while it is read */
  crawlSink: number;
  /** deg, where "the Drift" settles and holds */
  crawlHoldEl: number;
  /** deg, where the END title ("the Drift" again, over W6's night) settles: under the Rose's beams and the coast
   * towers' lamps (main-drift.ts endTitle), not at crawlHoldEl, where the beams crossed it */
  endTitleEl: number;
  /** text height (the body's em) as a fraction of the master width. 0.038 in EB Garamond Italic is a 2.9° x-height, a
   * shade over Avenir Next's at 0.033 (its x-height is 12 % larger: 0.474 em against 0.424): the 2026-10-31 type change
   * kept the letters' size, the brief's "not smaller than today's" */
  crawlSize: number;
  /** rad, the widest a line may span in azimuth (±50° safe zone ≈ 1.75) */
  crawlMaxArc: number;
  /** linear radiance the crawl is composited at (before the tone map) */
  crawlRadiance: number;
  /** 0..1, how strongly the field stays out of the sky the crawl is passing through */
  crawlPocket: number;
  /** deg, azimuth half-width of that pocket (the crawl spans at most ±crawlMaxArc/2) */
  crawlPocketAz: number;
  /** deg — tilt of the dome's zenith toward the front (Horizon 18: 15) */
  domeTilt: number;
  /** px — cube face resolution for dome capture */
  domeFace: number;
  /** 0..1 — the sea acts' ambient occlusion (cine/domeAo.ts): how much of it their indirect light takes (0: off) */
  seaAo: number;
  /** m — how far an occluder reaches in the sea acts (contact and crevice scale: a log's girth, a trunk's foot) */
  seaAoRadius: number;
  /**
   * THE RADIO STORY IN ACT 3, three pieces (the 2026-11-02 next-level review, drift-narrative/next-level-2026-11-02.md),
   * read every frame. radioCall is ON by default since the spine review of 2026-11-02 ("everything lost, a few remain,
   * they find each other", approved with it in); the other two stay OFF, so a master render leaves them out until the
   * user has chosen them. Switched for a review with `--setup 'd.params.radioCall = false'` (or `= true` for the
   * others), or for a page and a render lane with `drift.html?radioCall=0` (the review scripts' and drift-render.mjs's
   * `--query radioCall=0`: c4's old wake, the one the approved cut had):
   *
   *   radioCall      move 1, c4: the dial wakes, our masthead lamp calls and nothing answers, ~8 s of stars and surf,
   *                  a second, shorter call, and one lamp low ahead answers the same rhythm on the music's step
   *                  (447.93 s); the raft turns its bow toward it and the Rose wakes outward from it, high overhead
   *                  (roseTraffic.ts CALL, ANSWER, CASCADE; props.ts)
   *   radioOperator  open question 6, a prototype: one of the three kneels at the dial on deck, lit by it (crew.ts
   *                  'kneel')
   *   radioEnding    move 7, w6, a prototype (it commits the game's lore): our island's dark mast lights, the far
   *                  rafts' lanterns drift in toward our beach, the Rose's traffic turns seaward and falls quiet, and
   *                  on the music's decay one faint pulse in Act 1's two colours climbs from the sea to the one place;
   *                  every lamp flares once in answer and gets nothing back (roseTraffic.ts ENDING)
   */
  radioCall: boolean;
  radioOperator: boolean;
  radioEnding: boolean;
  /**
   * BIOLUMINESCENT SURF on the dark beach at the end (the user, 2026-11-02, after the spine review: glowing plankton
   * "could be a nice thing for maybe when they walk also through the rather dark beach section at the end";
   * wandering/biolum.ts). OFF by default, so a master leaves it out until the user has chosen it. It is BUILT or not
   * at load — the swash sim's glow field, the shoreline's glow and the footprints' mesh exist only when it is on, so
   * off, every shader is the one the approved cut drew — so it is switched by the page's query alone: `drift.html?biolum=1`
   * (the review scripts' and drift-render.mjs's `--query biolum=1`); a --setup after boot cannot build it.
   *
   * It comes up with the dark (biolum.ts BIOLUM_DARK: from the Sun at −5° to −12°, so in w6's night, through its
   * dissolve, and never in w5's dusk): each breaking wave's face and its foam flash and fade over a second or two,
   * the run-up's leading edge sparkles as it runs and goes out as it drains, sparse points twinkle in the shallows,
   * and where the wanderers step on the wet sand or in the shallows, their prints and small splashes glow and fade
   * over a few seconds
   */
  biolum: boolean;
  /** linear radiance of the glow at full excitation: a breaking lip's soft wash (its grain's points, up close, a few
   * times it) */
  biolumRadiance: number;
  /** its colour, sRGB (dinoflagellates' light, ~475–490 nm: cyan to blue-green, out of sRGB's gamut — this its edge) */
  biolumColor: number;
  /**
   * THE DISTANT STORM, move 4 phase 1 of the 2026-11-02 next-level review ("The near miss: weather as radio
   * interference"; wandering/stormCell.ts): a cumulonimbus on the horizon from c2, 40° right, that flickers silently
   * inside itself from c3's last light into c4 (each flash stuttering the dial's glow, props.ts) and dies away before the
   * dial wakes. OFF by default, so a master leaves it out until the user has chosen it. BUILT or not at load (its march
   * is in the sky's shader only when it is on: off, the sky is the one the approved cut drew), so switched by the page's
   * query: `drift.html?distantStorm=1` (the review scripts' and drift-render.mjs's `--query distantStorm=1`); once built,
   * `d.params.distantStorm = false` in a --setup hides it again
   */
  distantStorm: boolean;
  /**
   * TWO PIECES TO MAKE THE BEACH "FEEL MORE ALIVE … WITHOUT ADDING A WHOLE LOT OF ACTUAL ACTION" (the user, 2026-11-02,
   * after the spine review). Both OFF by default, so a master leaves them out until the user has chosen them; both
   * BUILT or not at load (their keys and meshes exist only when on), so switched by the page's query —
   * `drift.html?flockSilence=1&beachCrabs=1` (the review scripts' and drift-render.mjs's `--query …`):
   *
   *   flockSilence  move 5 of the next-level review: the flock lifts at once in the score's one silence (~652 s) and
   *                 is routed to the front right, against the darker east sky out of the Sun's glare, and over the
   *                 dome's zenith as the music comes back (~676 s) — the eighth bake's alternate keys
   *                 (scripts/drift-flock-bake.py --silence, flock-keys-silence.*), and the eye holds through w4
   *                 instead of turning left after the flock (beats.ts coastLook). Read once at load: the keys are
   *                 loaded by it, so a --setup cannot switch it
   *   beachCrabs    ghost crabs on the walk beach (wandering/crabs.ts, the user's idea: "a walking crab on the beach
   *                 once they land could be interesting"): one that comes out of its burrow in w3, scuttles down to
   *                 the wet sand, raises its claws and runs back in as a wave comes up; a few at the waterline from w4
   *                 on, running in and out with the swash, that scatter as the wanderers come up the beach in w5.
   *                 Once built, `d.params.beachCrabs = false` in a --setup hides them
   */
  flockSilence: boolean;
  beachCrabs: boolean;
}

export const driftParams: DriftParams = registerParams(
  'drift',
  {
    first: 7,
    arise: 11,
    cool: 20,
    wave: 7,
    remain: 10,
    zoom: 18,
    gather: 13,
    slowRate: 0.4,
    coolDensity: 0.3,
    fieldTiltEnd: 70,
    driftSpeed: 0.35,
    approach: 1.2,
    heroBirth: 1.4,
    heroSpeed: 12,
    heroShellSpeed: 7,
    heroShellRadiance: 3,
    heroGrainEl: 52,
    heroGrainDist: 7,
    grainWarmth: 0.3,
    starRadiance: 40,
    waveRadiance: 0.6,
    sparkRadiance: 8,
    waveBuild: 5.5,
    waveLens: 6,
    waveLensWidth: 14,
    frontRadiance: 7,
    // (0.72 from the 2026-10-30 story note to the 2026-11-01 one: the stall over the top lost the front's swoosh)
    waveStall: 0,
    crestRadiance: 1.1,
    // (0.9 s in the first rounds: the frozen field burned on behind the front; the region it passes stays spent)
    afterglow: 0.35,
    survivors: 0,
    matterDeep: 0xff6224,
    matterPale: 0xffe2a0,
    antiCyan: 0x52dcff,
    antiMagenta: 0xc77bff,
    productWarm: 0xff8f86,
    productCool: 0x5fe8d2,
    // (the 1:1 sweep of 2026-10-30, four profiles at 1920: the core a further 10 % thinner and the halo's light 0.8 —
    // between the first default and the leanest — read "a smidge" thinner inside and out without going wiry)
    // (0.9 / 1 / 0.8 until the 2026-11-01 note on the tracks: "thinner and crisper, with less halo (the same 'glow too
    // thick' complaint)": the core a further 15 % thinner, the halo 20 % narrower at a little over half its light)
    glowCore: 0.75,
    glowHalo: 0.8,
    glowHaloGain: 0.45,
    grammar: 1,
    pairSlots: 2600,
    trackSegments: 40,
    trackTail: 2,
    trackWidth: 0.016,
    trackSpeed: 4.5,
    trackCurl: 3.4,
    trackDrag: 0.4,
    fieldTilt: 25,
    trackRadiance: 5,
    coreSize: 0.22,
    coreRadiance: 14,
    shellSpeed: 12,
    shellRadiance: 0,
    hazeSize: 3,
    hazeRadiance: 0.01,
    bloomStrength: 0.12,
    bloomRadius: 0.25,
    bloomThreshold: 1.4,
    grainCount: 6000,
    fieldRadius: 30,
    particleSize: 0.22,
    pairLife: 3.2,
    zoomDecades: 2,
    webReach: 0.3,
    webTurn: 14,
    webRadiance: 3,
    matterColor: 0xffb44c,
    antimatterColor: 0x6e9cff,
    lightColor: 0xfff0d8,
    starColor: 0xffd394,
    exposure: 1,
    particleRadiance: 2.4,
    crawlElTop: 37,
    crawlSink: 5,
    crawlHoldEl: 30,
    endTitleEl: 18,
    crawlSize: 0.038,
    crawlMaxArc: 1.6,
    crawlRadiance: 1.4,
    crawlPocket: 1,
    crawlPocketAz: 40,
    domeTilt: 15,
    domeFace: 1024,
    seaAo: 1,
    // (1.8 m, not the 1 m it was built at: at 1 m it darkened by at most 20/255, and the trees and the raft still
    // read "pasted on" — the reach of a crown's or a cabin's shade is metres, 2026-10-29)
    seaAoRadius: 1.8,
    // (?radioCall=0: c4's old wake for a page or a render lane, which take no --setup — read once at load, as
    // getTheDrift.ts reads ?lightsOut=0; a --setup may still switch it either way after boot)
    radioCall: typeof location === 'undefined' || new URLSearchParams(location.search).get('radioCall') !== '0',
    radioOperator: false,
    radioEnding: false,
    // (on in the film since the 2026-11-02 render (the user: "bioluminescence … needs to be in"); ?biolum=0 leaves it
    // out — read once at load, as ?radioCall=0 is: the glow's materials are only built when it is on)
    biolum: typeof location === 'undefined' || new URLSearchParams(location.search).get('biolum') !== '0',
    biolumRadiance: 0.25,
    biolumColor: 0x38ccf5,
    // (on in the film since the 2026-11-02 render (the user: the storm and the drowned line "go in"); ?distantStorm=0
    // leaves it out — read once at load: the cell's march is only built into the sky when it is on)
    distantStorm: typeof location === 'undefined' || new URLSearchParams(location.search).get('distantStorm') !== '0',
    // (the flock's lift in the silence is in the film since the 2026-11-02 render, ?flockSilence=0 leaves it out; the
    // crabs stay out, ?beachCrabs=1 — both read once at load)
    flockSilence: typeof location === 'undefined' || new URLSearchParams(location.search).get('flockSilence') !== '0',
    beachCrabs: typeof location !== 'undefined' && ['1', ''].includes(new URLSearchParams(location.search).get('beachCrabs') ?? 'off'),
  },
  {
    first: { min: 0, max: 60, step: 0.5 },
    arise: { min: 0, max: 60, step: 0.5 },
    cool: { min: 0, max: 60, step: 0.5 },
    wave: { min: 0.5, max: 60, step: 0.5 },
    remain: { min: 0, max: 60, step: 0.5 },
    zoom: { min: 0, max: 60, step: 0.5 },
    gather: { min: 0, max: 60, step: 0.5 },
    slowRate: { min: 0.05, max: 1, step: 0.01 },
    coolDensity: { min: 0, max: 1, step: 0.01 },
    fieldTiltEnd: { min: 0, max: 90, step: 1 },
    driftSpeed: { min: 0, max: 2, step: 0.01 },
    approach: { min: 0, max: 5, step: 0.05 },
    heroBirth: { min: 0, max: 6, step: 0.05 },
    heroSpeed: { min: 0.5, max: 30, step: 0.25 },
    heroShellSpeed: { min: 0.5, max: 30, step: 0.25 },
    heroShellRadiance: { min: 0, max: 10, step: 0.05 },
    heroGrainEl: { min: 10, max: 80, step: 1 },
    heroGrainDist: { min: 2, max: 30, step: 0.25 },
    grainWarmth: { min: 0, max: 1, step: 0.01 },
    starRadiance: { min: 0, max: 100, step: 0.5 },
    waveRadiance: { min: 0, max: 10, step: 0.05 },
    sparkRadiance: { min: 0, max: 60, step: 0.5 },
    waveBuild: { min: 0, max: 15, step: 0.25 },
    waveLens: { min: 0, max: 20, step: 0.25 },
    waveLensWidth: { min: 2, max: 60, step: 0.5 },
    frontRadiance: { min: 0, max: 40, step: 0.1 },
    waveStall: { min: 0, max: 0.9, step: 0.01 },
    crestRadiance: { min: 0, max: 6, step: 0.05 },
    afterglow: { min: 0.05, max: 4, step: 0.05 },
    glowCore: { min: 0.3, max: 3, step: 0.05 },
    glowHalo: { min: 0.3, max: 3, step: 0.05 },
    glowHaloGain: { min: 0, max: 3, step: 0.05 },
    fieldRadius: { min: 2, max: 200, step: 1 },
    particleSize: { min: 0.01, max: 1, step: 0.01 },
    pairLife: { min: 0.3, max: 10, step: 0.1 },
    zoomDecades: { min: 0, max: 6, step: 0.25 },
    webReach: { min: 0.01, max: 0.6, step: 0.005 },
    webTurn: { min: 0, max: 60, step: 1 },
    webRadiance: { min: 0, max: 20, step: 0.05 },
    exposure: { min: 0.05, max: 8, step: 0.05 },
    particleRadiance: { min: 0, max: 40, step: 0.1 },
    trackTail: { min: 0.05, max: 4, step: 0.05 },
    trackWidth: { min: 0.002, max: 0.2, step: 0.001 },
    trackSpeed: { min: 0.1, max: 20, step: 0.1 },
    trackCurl: { min: 0, max: 12, step: 0.05 },
    trackDrag: { min: 0.05, max: 5, step: 0.05 },
    fieldTilt: { min: 0, max: 90, step: 1 },
    trackRadiance: { min: 0, max: 30, step: 0.1 },
    coreSize: { min: 0.01, max: 3, step: 0.01 },
    coreRadiance: { min: 0, max: 100, step: 0.5 },
    shellSpeed: { min: 0, max: 40, step: 0.25 },
    shellRadiance: { min: 0, max: 20, step: 0.05 },
    hazeSize: { min: 0, max: 40, step: 0.25 },
    hazeRadiance: { min: 0, max: 2, step: 0.005 },
    bloomStrength: { min: 0, max: 3, step: 0.01 },
    bloomRadius: { min: 0, max: 1, step: 0.01 },
    bloomThreshold: { min: 0, max: 4, step: 0.01 },
    crawlElTop: { min: 10, max: 60, step: 1 },
    crawlSink: { min: 0, max: 20, step: 0.5 },
    crawlHoldEl: { min: 0, max: 60, step: 1 },
    endTitleEl: { min: 0, max: 60, step: 0.5 },
    crawlSize: { min: 0.005, max: 0.1, step: 0.001 },
    crawlMaxArc: { min: 0.3, max: 3.1, step: 0.05 },
    crawlRadiance: { min: 0, max: 10, step: 0.05 },
    crawlPocket: { min: 0, max: 1, step: 0.01 },
    crawlPocketAz: { min: 10, max: 120, step: 1 },
    domeTilt: { min: 0, max: 30, step: 0.5 },
    seaAo: { min: 0, max: 1, step: 0.01 },
    seaAoRadius: { min: 0.1, max: 4, step: 0.05 },
    biolumRadiance: { min: 0, max: 2, step: 0.005 },
  },
);
