/**
 * Sky + lighting tunables (§V16: every tunable lives in a params module and
 * appears in Tweakpane; no shader magic constants). Consumed by src/sky/*.
 *
 * COLOUR AUTHORING CONTRACT: every hex here is an sRGB colour picked against
 * docs/final-full-result.png. The sky modules convert sRGB → linear working
 * space at the uniform boundary (Color.setRGB(..., SRGBColorSpace)). Feeding
 * raw sRGB numbers into a linear pipeline is what made the whole sky read as
 * washed-out white (§B9) — the values below are what you should SEE on
 * screen, not what the shader multiplies.
 */
import { registerParams } from './registry';

export interface SkyParams {
  /** simulated hour 0..24 — drives sun direction and every light ramp */
  timeOfDay: number;
  /** observer latitude in degrees; tropics keep the noon sun near zenith */
  latitude: number;
  /** deep blue straight up */
  zenithColor: number;
  /** blue of the main sky body (~20-40° above the horizon) */
  midColor: number;
  /** horizon haze band color (pale cyan-white in the reference shots) */
  horizonColor: number;
  /** 0..1 how completely the haze band takes over at eye level */
  hazeStrength: number;
  /** vertical thickness of the haze band (viewDir.y units, exp decay) */
  hazeFalloff: number;
  /** extra haze lift on the sun's side of the sky (forward scattering) */
  sunHazeStrength: number;
  /**
   * GOLDEN HOUR palette (§T39). The day hexes above are crossfaded to these
   * by lowSunWarmth(), so one weight moves the sky, the fog and the ambient
   * together — that shared weight is what gives the reference shot its
   * single warm key instead of a warm sky over a cold scene.
   */
  sunsetZenithColor: number;
  sunsetMidColor: number;
  sunsetHorizonColor: number;
  /** sea bounce at golden hour — the water throws back the orange sky */
  sunsetGroundColor: number;
  /** 0..1 master on the whole crossfade; 0 = no sunset grade at all */
  sunsetStrength: number;
  /**
   * GOLDEN-HOUR BAND GEOMETRY. The sunset needs a different SHAPE of sky, not
   * just different colours: the day's broad pale haze wedge and its
   * high-biased zenith curve between them hold the whole 0-30° window — the
   * only part of the sky a camera framing the sea ever sees — inside one
   * hue. Measured at warm=1 with the day geometry, that window runs #ffc26f →
   * #c17063: cream to terracotta, every stop an orange, with the rose-indigo
   * zenith stranded overhead where the shot never looks. That is the user's
   * "feels like a very bit single-coloured".
   *
   * These two crossfade by the SAME `warm` weight as the colours (§T39, one
   * weight moves everything), so at warm=0 the signed-off midday look from
   * docs/final-full-result.png is bit-for-bit what it always was.
   */
  sunsetHazeFalloff: number;
  sunsetGradientCurve: number;
  /** warm tint blended into the haze around the sun's side */
  horizonWarmColor: number;
  /** 0..1 peak warm-tint amount (scaled up as the sun drops) */
  horizonWarmStrength: number;
  /** sun light color at the horizon (warm) and at noon (white-gold) */
  sunColorLow: number;
  sunColorNoon: number;
  /** zenith tint multiplier endpoints for the night→day ramp */
  nightTint: number;
  /**
   * MOONLIGHT (see src/sky/moonCycle.ts for the whole argument).
   *
   * `moonPhase` 0..1: 0 = new, 0.25 = first quarter, 0.5 = FULL, 0.75 = last
   * quarter. It is the moon's ELONGATION around its own orbit (phase·360°
   * from the sun), so it moves WHEN the moon is up as well as how lit it is —
   * a full moon rises at sunset and is overhead at midnight, a crescent
   * trails the sun and has set by the small hours.
   *
   * `moonInclination` (deg) tilts that orbit off the sun's track and
   * `moonNodeOffset` (deg) says where along the track the two planes cross
   * (§V91). Together they are why the moon is never ON the sun's path: at
   * the default node (90°) the full moon passes `moonInclination` above or
   * below the anti-sun point instead of through it, and the new moon passes
   * the same distance beside the sun. 5.1° is the real orbit's tilt.
   *
   * `moonGlareAngle` / `moonGlareSoftness` (deg): a moon closer to the sun
   * than the glare angle is not drawn at all — it is a sliver of a few
   * percent lit, lost in the sun's forward scatter (the youngest crescent
   * ever sighted was ~7.5° out; 15° is a comfortable "nobody sees it"). This
   * is what stops a near-new moon sitting beside the setting sun as a second
   * disc (§B63). Ramps to full visibility over the softness.
   *
   * `bodyHorizonMargin` (deg): the sun and moon discs (plus glow and halo)
   * are gated to exactly 0 once the body is this far below the horizon PLUS
   * its own radius, and full once its radius clears it. No body is drawn
   * from under the sea (§V91).
   *
   * `moonIntensity` IS THE MOON'S BRIGHTNESS — all of it, one knob. It keys
   * the ship, and (through `KeyLight.radianceScale`) it sets how bright the
   * moon's road burns on the sea and how much moonlight the water scatters.
   * `moonColor` is HUE ONLY and carries no level.
   *
   * That is a correction, and the docstring it replaces is why this bug
   * happened. The ocean used to copy the key's COLOUR and not its intensity,
   * so `moonColor`'s luminance WAS the road's brightness — and at 0.390
   * against a noon sun's 0.904 the moon laid a road at 43% of noon's while
   * keying the ship at 0.75/3.4 = 22%. Two knobs, 2.5x apart, and the one
   * named for hue won: "it's like the same size as what the sun is doing".
   * `caustics/waterLighting.ts` had the right expression the whole time.
   * Do not put level back into the colour; turn `moonIntensity` down instead.
   *
   * `moonColor` is a deliberate PURKINJE STYLISATION. Real moonlight is
   * reflected sunlight off a grey body — ~4100 K, if anything WARMER than
   * daylight. The blue is in the observer's rods, not in the beam. Named here
   * so it reads as an art choice rather than as a physics error.
   */
  moonPhase: number;
  moonInclination: number;
  moonNodeOffset: number;
  moonGlareAngle: number;
  moonGlareSoftness: number;
  bodyHorizonMargin: number;
  /**
   * THE DISC'S APPEARANCE ONLY — a deliberate, named cheat. Read this before
   * "unifying" it with `moonPhase`; it was one knob and the single knob could
   * not satisfy the references.
   *
   * `moonPhase` is an HOUR-ANGLE LAG, so it drives three things at once:
   * WHERE the moon is, HOW MUCH light it delivers (via MOON_SURGE), and what
   * the disc looks like. Every one of the twelve night references in
   * docs/inspo/night/ pairs a CRESCENT with a LOW moon over a dense starfield
   * — and those two are mutually exclusive under one knob:
   *   - a low moon at the Night preset needs the full-moon lag (0.5): a full
   *     moon is antipodal to the sun, so it rises AS the sun sets and is the
   *     only phase that is low at 19:15. At 0.35 the moon still sits at 72°
   *     at 21:00 (measured), which lays no glint road at all.
   *   - MOON_SURGE is brutally non-linear: at phase 0.35 the key is already
   *     down to 0.42 of full, and a reference-accurate 0.18 would leave 0.044
   *     — a night too dark to read, with the ship a black cut-out.
   * So the ORBIT and the LIGHT keep the full-moon phase and only the drawn
   * disc is given a crescent. Cost of the cheat, stated plainly: the moon's
   * lit limb no longer agrees with where the sun is. At a 3.6° disc, over
   * water, nobody but an astronomer can see that; a dark night and a road-less
   * moon are visible to everyone. The references are the authority on the look.
   *
   * Same 0..1 convention as `moonPhase` (0 new, 0.25 first quarter, 0.5 full)
   * and it drives the terminator AND the glow/halo weight, so the aura always
   * matches the disc that is actually drawn.
   */
  moonDiscPhase: number;
  moonColor: number;
  moonIntensity: number;
  /** night tint at FULL moon — crossfades from nightTint by moon weight */
  moonlitNightTint: number;
  /** 0..1 ambient lift a full moon adds on top of nightAmbientFloor */
  moonAmbient: number;
  /**
   * 0..1 moonless-night ambient floor. Was a hardcoded 0.15 in lighting.ts;
   * it keeps silhouettes readable after dark with no moon in the sky, and
   * every value of it is visible only at night, so leave it where it is
   * unless you are looking at a new-moon frame.
   */
  nightAmbientFloor: number;
  /**
   * Analytic moon disc in the sky background. Deliberately much SHARPER than
   * the sun's: the sun is an overexposed blob whose edge is pure bloom, while
   * the moon has a hard limb you can see craters against. Hence a small
   * softness and a low intensity — the moon must NOT clip to white, or the
   * phase terminator below it is invisible.
   */
  moonDiscSize: number;
  moonDiscSoftness: number;
  moonDiscIntensity: number;
  /**
   * Softness of the phase TERMINATOR, as a fraction of the disc radius.
   * §V48: this is the sharpest feature on the disc and the disc is a few
   * pixels across, so the edge is band-limited by an explicit width rather
   * than left as a step.
   */
  moonTerminatorSoftness: number;
  /** tight glow hugging the moon, and the (much tighter than the sun) halo */
  moonGlowPower: number;
  moonGlowStrength: number;
  moonHaloPower: number;
  moonHaloStrength: number;
  /**
   * STARFIELD (§T.46 — src/sky/starfield.ts holds the whole argument).
   *
   * `starDensity` is cells per cube-face edge, so the sky holds 6·N² candidate
   * cells; the count is uniform per steradian, not per cell, because the
   * gnomonic Jacobian gates it. `starSize` is the TRUE angular radius in
   * degrees — the drawn radius is floored at 2 px of the view ray's own
   * footprint (§V.48) and the amplitude is scaled by (true/drawn)², so what
   * this knob really sets is a star's FLUX, and the drawn peak at 1080p / 55°
   * fov is about 0.15 of `starBrightness`.
   *
   * `starMagnitudePower` shapes the brightness distribution (3 → the median
   * star is at 1/8 of peak: a few bright, very many faint, as the references
   * are). `starTwinkleRate` is rad/s and is an ART CONSTANT — see the §V.55
   * note in starfield.ts before making anything in the sim drive it.
   */
  starDensity: number;
  starSize: number;
  starBrightness: number;
  starMagnitudePower: number;
  starTwinkleAmount: number;
  starTwinkleRate: number;
  starColorCool: number;
  starColorWarm: number;
  /** viewDir.y at which the field has fully faded into the haze band */
  starHorizonFade: number;
  /**
   * WIND LINES (§T.47 — src/sky/windLines.ts holds the whole argument).
   *
   * Streaks running across the sky and converging on the point the wind blows
   * TOWARD, so the bearing can be read without looking down at the HUD dial.
   * They are a PENCIL OF GREAT CIRCLES about the wind axis, so the convergence
   * is genuine perspective and the vanishing points sit on the horizon.
   *
   * `windLineCount` is streaks around that axis and is FORCED ODD, which puts
   * the atan2 seam on a cell wall instead of through a streak; at 49 they are
   * 7.3° apart overhead. `windLineWidth` is a DUTY CYCLE — a fraction of the
   * spacing, not an angle — which is what makes the pattern go sub-pixel
   * together and dissolve cleanly at the pinch (§V.48b) instead of knotting.
   *
   * `windLineOnset` is Beaufort 3, where the sea itself first shows the wind,
   * and below it the sky is bare. `windLineFull` is the sea-state ladder's top
   * rung, so the shipped F6 default sits near half and a storm has room to
   * fill the sky in. `windLineDriftRate` is radians of travel per second per
   * m/s of wind, and it is why the phases are ACCUMULATED (§V.55): the rate is
   * live, so `time × rate` would be unbounded.
   */
  windLineCount: number;
  windLineWidth: number;
  windLineBrightness: number;
  windLineWaveAmount: number;
  windLineWaveFreq: number;
  windLineGustFreq: number;
  windLineGustDepth: number;
  windLineDriftRate: number;
  windLineOnset: number;
  windLineFull: number;
  windLineDensityPower: number;
  windLineWhiteness: number;
  windLineNightDim: number;
  /** viewDir.y over which the streaks fade in above the horizon */
  windLineHorizonFade: number;
  /** analytic sun disc angular radius (degrees) and its soft edge (degrees) */
  sunDiscSize: number;
  sunDiscSoftness: number;
  /** HDR multiplier on the disc — >1 clips it to white so it reads as a sun */
  sunDiscIntensity: number;
  /** tight glow hugging the disc: exponent shapes it, strength scales it */
  sunGlowPower: number;
  sunGlowStrength: number;
  /** wide atmospheric halo around the sun (low power = very broad) */
  sunHaloPower: number;
  sunHaloStrength: number;
  /**
   * §V92 GLARE radius (degrees) added to `sunDiscSize` to make the SOURCE
   * WIDTH every sun-originated effect inherits: the ocean's glint road is
   * floored at this angular radius (the road at the horizon starts as a bar
   * this wide, never a point) and the god rays fan from a disc of this
   * radius on screen rather than from the sun's centre pixel. Reference: the
   * drawn glow `cos^sunGlowPower` has its half-maximum at
   * acos(0.5^(1/240)) = 4.4°, so 1.5° is the bright inner third of the
   * perceived ring, not the whole aura. The real sun is 0.265°; the DRAWN
   * disc is `sunDiscSize` (1.1°), and §V66 says scale by the dimension the
   * user sees, which is the drawn one.
   */
  sunGlareRadiusDeg: number;
  /** shape of the mid→zenith gradient (higher = blue stays low longer) */
  gradientCurve: number;
  /** DirectionalLight peak intensity and its distance from origin (m) */
  sunIntensity: number;
  sunDistance: number;
  /**
   * Sun shadow map. `shadowNormalBias` is in WORLD METRES along the receiver
   * normal, so it deletes the contact shadow of any object thinner than
   * itself — keep it under the smallest caster that matters (deck rail posts
   * are 0.09 m) and near one shadow texel, which is 2*extent/mapSize.
   * `shadowExtent` is the ortho half-width IN THE LIGHT'S OWN uv PLANE, and
   * that is not the same thing as the length of the shadow on the ground.
   * This comment used to claim "a 40 m mast at a 20° sun throws ~110 m, so an
   * extent below ~70 truncates the ship's shadow", and it is WRONG in a way
   * that costs real money: it sent a reader toward cascades and a 4096 map to
   * chase a 526 m shadow at a 4.35° sun. A caster and the shadow it casts are
   * displaced from each other ALONG THE LIGHT AXIS, which is the shadow
   * camera's DEPTH axis — so they land on the same (u,v), i.e. the same texel
   * column of the map, at every elevation. Measured at 17.7: du = dv = 0,
   * dw = -527.8. The extent never clipped it. Length of shadow is bounded by
   * near/far (50..2600 against sunDistance 1200), never by extent.
   * What the extent must actually cover is the CASTER's own light-space
   * footprint — about max(halfLength, height * cos(elevation)) — plus the
   * receiver swath you want shadowed. That term GROWS as the sun drops (the
   * mast turns side-on to the light) but is bounded above by the mast HEIGHT,
   * 40 m, never by the 526 m shadow. Worst case over the whole day is a sun
   * on the horizon, and even that needs half of 80. Coverage on the water is a strip
   * ±extent crosswind by ±extent/sin(elevation) along the sun azimuth: at
   * 4.35° that is ±80 m by ±1056 m, against the 526 m the ship needs.
   *
   * BUT DO NOT GENERALISE THAT TO "THE EXTENT IS FINE" — that was the second
   * wrong conclusion drawn here. du = dv = 0 holds for a caster and ITS OWN
   * shadow; it says nothing about casters displaced sideways from the
   * frustum centre, and the centre is the PLAYER. The ±extent/sin(elevation)
   * reach exists ONLY along the sun azimuth, so at a low sun the covered
   * water is a long thin STRIP, not a disc — measured at 17.7 with extent 80:
   * 1055 m along the sun line, 160 m at 30° off it, 80 m crosswind. Any
   * caster off that strip is absent from the map and casts NOTHING: the
   * enemy ship landed at u = -146 and was excluded when this was measured, at
   * the hardcoded [190, -150] she used to spawn on. That constant is gone —
   * `ai/enemySpawn.ts` now berths her 150-220 m from the player instead of the
   * ~1000 m that was — so the NUMBER is historical; the anisotropy it
   * demonstrates is not.
   * That anisotropy is visible to the user as "islands cast no shadow, but it
   * does receive shadow at some point very far away". Fixing it is a
   * cascade/coverage problem and CANNOT be solved by raising this number —
   * an extent of 500 costs 0.49 m texels at 2048, which deletes every deck
   * fixture (rail posts are 0.09 m). One frustum cannot serve both jobs.
   * `shadowMapSize` is read once at construction (reload to change).
   */
  shadowNormalBias: number;
  shadowBias: number;
  shadowExtent: number;
  shadowMapSize: number;
  /**
   * How dark a full sun shadow gets, scene-wide: 1 = the raw PCF result, 0 =
   * no shadow at all. Applied on `sunLight.shadow.intensity`, which
   * `uncoloredShadowNode` already folds in as `mix(1, pcf, intensity)` — so
   * this is ONE value reaching every receiver through the one shared shadow
   * node, at no extra binding (§V.40).
   *
   * §V.33 SINGLE OWNER, and it was not one until now. The ocean carried its own
   * `oceanSurfaceParams.shadowStrength` at 0.85 while every lit material took
   * three's default 1.0, so a single ship shadow crossing the waterline STEPPED
   * in darkness — 15% lighter on the water than on the beach or the sea floor
   * it continued onto. That seam runs right through the shallow-water shot this
   * whole feature exists to make good, so the scene-wide value lives here and
   * the ocean's knob is now a trim on top of it (default 1 = no trim).
   *
   * Below 1 on purpose: a shadow on water is never fully dark. Skylight arrives
   * from the whole dome and the ship blocks a small solid angle of it, so the
   * shadowed sea should go bluer and dimmer, not black — the same reason the
   * shadowed sea floor keeps its hemisphere ambient.
   */
  shadowIntensity: number;
  /** hemisphere ambient peak intensity */
  ambientIntensity: number;
  /** what the sea/sand LOOKS like — the bounce's hue before washout */
  groundBounceColor: number;
  /**
   * 0..1 how far both hemisphere halves are pulled toward neutral before
   * they light anything. Ambient here is irradiance, not paint: a whole-sky
   * integral and a diffuse sea bounce are both far less saturated than the
   * surfaces they came from. At 0 the hull's shaded side renders as a flat
   * teal slab, because an unshadowed light with red at 10% of blue simply
   * overrides albedo hue — shaded oak needs the ambient's R/G above ~0.54
   * and R/B above ~0.27 to still read as timber, and 0.5 clears both with
   * margin. Mixing toward luminance, so raising this desaturates shade
   * without brightening it.
   */
  ambientDesaturation: number;
  /**
   * Scene fog range (m) — atmospheric distance haze, NOT a view-distance cap
   * (§V30). The OCEAN no longer uses scene fog (its material sets
   * fog = false and runs its own 900→4600 m haze on a 1.7 curve, copying
   * scene.fog.color as the target), so this range now governs OBJECTS only:
   * ship, islands, spray. It must fade them at a rate close to the water's
   * curve or an island reads sharper or softer than the sea it sits in.
   * The water curve is smoothstep(900, 4600, d)^1.7 — Hermite, so it stays
   * clear to ~2 km then steepens hard; a linear ramp matched at mid-field
   * (1200/6500) falls 0.35 behind AT THE RIM, which is a dark island against
   * near-white sea exactly where it shows. 1800/4900 tracks within 0.12
   * everywhere and saturates just before the 4600 m sea rim, so geometry
   * melts where the water does. Move these whenever the rim moves.
   * scene.fog.color stays load-bearing regardless: the water copies it as
   * its own haze target, so deleting the fog costs the sea its day tint.
   */
  fogNear: number;
  fogFar: number;
  /** tone mapping exposure applied via configureRenderer */
  exposure: number;
}

export const skyParams: SkyParams = registerParams(
  'sky',
  {
    // GOLDEN HOUR (§T39) — the showcase/recording default. Sun at 10.14°.
    //
    // Was 16.4 (23.13°), where the sun sat three hundredths of a radian PAST
    // lowSunWarmth()'s 0.4 upper edge, so warm was exactly 0 and the whole
    // sunset palette below multiplied by zero and had never once rendered.
    //
    // Then 17.7 (4.35°), chosen because warm saturates at 1.000 there. That
    // was too low, for two measured reasons that both key off N·L on flat
    // water = sin(elevation):
    //   - 4.35° gives N·L 0.0758. Sun*N·L = 0.240, and that product is the
    //     ONLY thing a shadow on the water can darken, so ship and island
    //     shadows were invisible (user: "still missing a proper shadow cast
    //     on the water"). At 10.14°, N·L 0.1760 → 0.599: 2.49x.
    //     Under the storm preset (sunIntensity 3.4 → 1.6) 17.7 falls to
    //     0.113 — "in the storm we see nothing at all" — while 17.3 holds
    //     0.282, still above CLEAR-sky 17.7. Shadows survive the weather.
    //   - warm 1.000 made every surface maximally molten (user: "golden hour
    //     but not insane all the time"). 0.780 keeps the grade clearly warm
    //     without saturating it.
    // And it costs almost nothing: because bandGeometry() crossfades on the
    // same weight, warm 0.78 still yields hazeFalloff 0.118 / curve 0.80,
    // holding 97% of 17.7's vertical gradient (spread 0.545 vs 0.561) with
    // slightly BETTER azimuthal variety. The 0-30° ramp reads
    // #f2c885 → #8e6879: cream through rose, less molten than 17.7's
    // #ffc26f → #985f69.
    // Trade-off accepted: warm 0.78 is on a slope, not the plateau, so the
    // grade does move if this number moves. Keep nudges under ~0.1 h.
    // Alternatives: 17.6 (5.79°, warm 0.987) for a more saturated grade at
    // half the shadow visibility. Do not go past ~17.9 — sunset is 18.0.
    timeOfDay: 15.0,
    latitude: 15,
    // Sampled from docs/final-full-result.png: horizon band (219,236,240),
    // sky body at ~20° (105,165,201), extrapolated zenith (47,127,196).
    // These hexes are PRE-COMPENSATED for ACESFilmic @ exposure 1.1, which
    // lifts and desaturates everything it touches — feed it the reference
    // values literally and the horizon lands on neutral grey and the blues
    // go milky (that plus §B9 is the "blown out white" report). Authored
    // deeper/more saturated, they tonemap ONTO the reference numbers.
    zenithColor: 0x336cb1, // → (44,120,192) on screen
    midColor: 0x558fbe, //    → (105,165,201)
    horizonColor: 0xa1e7ff, // → (196,222,228): pale, still cyan, not white
    hazeStrength: 0.9,
    hazeFalloff: 0.18,
    sunHazeStrength: 0.3,
    // golden hour, same ACES pre-compensation as the day set:
    // → screen (122,86,128) deep rose-indigo overhead, (232,138,102)
    // orange-rose through the body, (231,214,168) pale cream at the horizon
    sunsetZenithColor: 0x6f5473,
    sunsetMidColor: 0xe37156,
    sunsetHorizonColor: 0xffd183,
    sunsetGroundColor: 0x6d5b53,
    sunsetStrength: 1,
    // 0.18 → 0.10: a real horizon band ~4° tall instead of a wedge that
    // washes the whole lower sky to cream. Not smaller: the band has to stay
    // wide enough to cover the steep region of lift^0.6 near the horizon,
    // where a sub-1 exponent rises very fast, and 0.06 also deletes the
    // bright horizon glow the reference has.
    sunsetHazeFalloff: 0.1,
    // 1.5 → 0.60: the dominant lever. `height = lift^curve` with lift =
    // sin(elevation), so at 30° lift is only 0.5 and the shipped 1.5 leaves
    // height at 0.35 — the sky is still 65% midColor at the top of frame and
    // the zenith hue never arrives. At 0.60 the 0-30° window runs
    // #ffc26f → #985f69, cream → orange → dusty rose.
    // Measured RGB spread across the 0-30° window a sea-framing camera sees:
    //   day geometry .18/1.5   0.411   (every stop an orange)
    //   haze wedge alone .10   0.446   (+8%)
    //   curve alone 0.60       0.514   (+25%)
    //   both, as shipped here  0.561   (+36%)
    // Both are needed; neither alone clears the bar the test pins.
    sunsetGradientCurve: 0.6,
    horizonWarmColor: 0xffaf57,
    horizonWarmStrength: 0.45,
    sunColorLow: 0xff9440,
    sunColorNoon: 0xfff3da,
    nightTint: 0x16263e,
    // FULL MOON — and it stays full, because this knob is the ORBIT and the
    // LIGHT, not the picture. See moonDiscPhase for the whole argument.
    moonPhase: 0.5,
    // The real orbit's tilt against the ecliptic. The sun's own track stands
    // in for the ecliptic here (declination-0 sun), so this is the whole of
    // "the moon is not on the sun's path". At the Night preset (19:15, full
    // moon) it moves the moon's rise ~5° along the horizon and ~0.3° in
    // elevation — the glint road is untouched.
    moonInclination: 5.1,
    // 90°: the planes cross a quarter-orbit from the sun, so the full moon
    // sits at the FULL tilt above/below the anti-sun point rather than on it
    // (0° would be the eclipse geometry, a moon exactly antipodal). Slowly
    // regresses in reality (18.6 yr); a static knob here.
    moonNodeOffset: 90,
    // Below 15° elongation the disc is ≤1.7% lit and inside the sun's glare;
    // drawing it there is precisely the "sun beside a moon" report (§B63).
    moonGlareAngle: 15,
    moonGlareSoftness: 10,
    // 1°: gate reaches 0 at -(radius + 1°) so a body that has just set does
    // not keep a glow on the horizon, and nothing is ever drawn below the sea.
    bodyHorizonMargin: 1.0,
    // Waxing crescent, 28.7% lit. Measured off the references: the moon spans
    // 3.1-4.7° in docs/inspo/night/ (cgi7573…, sovereigns, images 1-4) and is
    // a crescent in every one, from a thin sliver (~12% lit) to a fat one
    // (~40%). 0.18 sits in the middle of that band and is wide enough that the
    // terminator survives its own §V.48 floor at 1080p.
    moonDiscPhase: 0.18,
    // Pale cool blue-white — HUE ONLY. Unchanged in value, but no longer
    // load-bearing for brightness: the paragraph that stood here chose this
    // luminance "against the glint road, not against the light" and read the
    // result as "~41% of the noon sun's", which is precisely the disproportion
    // the user reported. The road's level is `moonIntensity` now (§V.72), so
    // this is free to be the Purkinje stylisation it is named as. It is still
    // 0.390 linear luminance against sunColorNoon's 0.904 and that ratio is a
    // COLOUR ratio: it tints, it does not brighten.
    moonColor: 0x8ea9d6,
    // Derived, not guessed. Target: the moonlit side of the hull lands near
    // 0.04 linear so it tonemaps to a clearly-visible dark blue-grey rather
    // than to black. radiance = albedo(0.20) x intensity x moonColor's linear
    // luminance(0.38) x N.L(~0.7) = 0.04 at intensity 0.75. The physical
    // sun:moon ratio of 400,000:1 would give 8.5e-6 and a black frame — see
    // moonCycle.ts's header for why a fixed exposure forbids using it.
    // THIS IS THE KNOB. It now sets the road, the sea's moonlit diffuse, the
    // caustics and the ship together, in one ratio — `moonIntensity /
    // sunIntensity` — so "the moon is too bright" is one slider and no longer
    // needs `moonColor` touched. 0.75 is kept because the hull target above is
    // still the binding constraint; if a night still reads too bright after
    // this, lower THIS, and expect the road to follow it linearly.
    moonIntensity: 0.75,
    // roughly 2x nightTint's luminance and a little less saturated: a moonlit
    // sky is a deep blue you can read cloud shapes against, not a flat navy
    moonlitNightTint: 0x304c74,
    // 0.30 → 0.22, and the number is READ OFF THE KEY rather than dialled.
    // `ambientLevel()` puts this in the same slot as `daylight()`, whose peak
    // is 1 = full sun, so this IS "the moon's ambient as a fraction of the
    // sun's" and it can be checked against the key's own fraction:
    // moonIntensity/sunIntensity = 0.75/3.4 = 0.221. At 0.30 the moon lifted
    // ambient to 40.5% of a full day's while keying at 22% — an unshadowed
    // term, applied to every pixel in the frame, running ~1.4x the directional
    // light it is meant to accompany. That is the "washes stuff out" half of
    // the report, and 1.4x is the whole of the correction.
    //
    // NOT a double count, which is worth stating because it looks like one:
    // `ambientLevel` is `floor + (1 - floor) * max(day, moonAmbient * moonW)`
    // — a max inside a lerp toward 1, so the moon never ADDS on top of
    // `nightAmbientFloor` and §V.74 is not in play here. It was simply too big.
    moonAmbient: 0.22,
    nightAmbientFloor: 0.15,
    // The real moon is 0.26° in radius. Enlarged like the sun disc is (1.1
    // against a real 0.27°), and a good deal more, because the PHASE has to be
    // legible — a physically-sized crescent is one pixel of one pixel.
    // 1.4 → 1.8 measured against the references: at 55° fov / 16:9 our
    // horizontal fov is 85.6°, and the SoT shots put the disc at 47-58 px on a
    // 1024-1600 px frame, i.e. 3.1-4.7° across. 1.8 is a 3.6° disc, mid-band.
    moonDiscSize: 1.8,
    moonDiscSoftness: 0.12,
    // NOT an HDR value like sunDiscIntensity's 14. Above ~3 the disc clips to
    // flat white and the terminator vanishes with it.
    moonDiscIntensity: 2.2,
    // 0.06 → 0.09 of the disc radius. At the shipped 1.8° disc, 0.06 is 0.108°
    // — BELOW the 2-px §V.48 floor at 1080p (0.110°), so the floor, not the
    // author, was deciding how soft the terminator is, and the authored value
    // was dead. 0.09 is 0.162°, comfortably above it, and a crescent wants the
    // softer edge anyway: it is the disc's defining feature now, and a hard
    // one reads as a bitten biscuit rather than as a moon.
    moonTerminatorSoftness: 0.09,
    // GLOW/HALO ARE WEIGHTED BY THE DISC'S ILLUMINATED FRACTION, not by
    // MOON_SURGE. The surge is a REFLECTANCE law about light leaving the
    // moon's regolith; an aura is bloom off the disc you can see, so it scales
    // with lit AREA. At the shipped moonDiscPhase 0.18 that weight is 0.287,
    // and these two strengths are authored so the product lands where the old
    // full-moon values did (0.9 × 0.287 = 0.258 vs 0.25; 0.20 × 0.287 = 0.057
    // vs 0.06) — i.e. the crescent is a change of SHAPE, not of exposure.
    // 900 → 400 widens the glow from ~2 disc radii to ~4, which is what the
    // references show around a crescent (docs/inspo/night/images (1).jpeg).
    moonGlowPower: 400,
    moonGlowStrength: 0.9,
    moonHaloPower: 24,
    moonHaloStrength: 0.2,
    // ── STARFIELD ─────────────────────────────────────────────────────────
    // 72 cells per cube-face edge = 31,104 candidate cells over the sphere,
    // 1.59° apart at a face centre, 1296 per steradian. At 55° fov / 16:9 the
    // frame is 1.28 sr, so ~1660 candidates are in frame and ~830 of those
    // above the horizon — the density measured off
    // docs/inspo/night/this-game-is-so-beautiful…webp. Do NOT raise it without
    // looking at JITTER: a denser grid is a smaller cell, and the clearance a
    // star needs to avoid being clipped by its own cell wall is in DEGREES.
    starDensity: 72,
    // TRUE radius. The drawn radius is floored at 2 px (§V.48), so at 1080p
    // this is 0.04/0.110 = 0.36 of what is drawn and the energy factor is
    // 0.131 — the star is ~4 px across with a ~2 px core, and gets no bigger
    // as the window shrinks, only fainter.
    starSize: 0.04,
    // Peak for a magnitude-1 star BEFORE the §V.48b energy factor. 12 × 0.131
    // = 1.57 linear at 1080p, which ACES at exposure 1.1 puts at ~221 on
    // screen against a night zenith of ~(0,1,17): the brightest stars read
    // near-white, the median (mag 0.125) lands at ~72 — dim but present.
    starBrightness: 12,
    starMagnitudePower: 3,
    starTwinkleAmount: 0.35,
    starTwinkleRate: 1.6,
    // Blue-white and a pale amber; the mix is squared toward the cool end, so
    // amber is the minority the references show it to be.
    starColorCool: 0xcfe0ff,
    starColorWarm: 0xffd7a8,
    // ~5.7°: the references keep stars out of the horizon haze entirely
    starHorizonFade: 0.1,
    // ── WIND LINES ────────────────────────────────────────────────────────
    // 49 streaks about the wind axis: 7.3° apart at the axis's own equator
    // (the great circle through the zenith and the two crosswind horizon
    // points), so a 55° vertical fov holds about seven of them stacked. Odd on
    // purpose — see the param docstring and windLines.ts.
    windLineCount: 49,
    // Duty cycle, so 0.09 is 0.66° of drawn width at the equator: ~12 px at
    // 1080p and ~8 px at 720p, comfortably above §V.48's 2 px floor, which
    // means the AUTHOR owns the width rather than the floor. (That is the
    // mistake `moonTerminatorSoftness` records: 0.06 was BELOW the floor, so
    // the authored value had never once rendered.)
    windLineWidth: 0.09,
    // Peak additive LINEAR radiance for a full-weight streak before the §V.48b
    // energy factor. Deliberately tiny: the day sky body is ~0.14/0.37/0.60
    // linear, so this is a ~10% lift on the blue channel at the very peak of a
    // streak and less than that everywhere else — the "gentle,
    // semi-transparent" the request asks for. UNSEEN AS SHIPPED: nothing here
    // has been rendered yet, and this is the first number to look at.
    windLineBrightness: 0.06,
    // Lateral swing, in spacings: 0.12 + its 0.06 second harmonic is ±1.3° of
    // wander against a 0.66° wide streak — a gentle wave, not a zigzag. The
    // sum plus the half-width must stay under WIND_LINE_CLEARANCE (0.4) or a
    // streak starts being clipped by its own cell wall; a test pins it.
    windLineWaveAmount: 0.12,
    // Cycles per radian along the streak: 0.75 is one undulation every 76°, so
    // a streak running the full 180° from vanishing point to vanishing point
    // carries about two and a half of them.
    windLineWaveFreq: 0.75,
    // The gust envelope is much longer than the wave — one lull every ~164° —
    // so a streak brightens and fades ALONG its length rather than flickering.
    windLineGustFreq: 0.35,
    windLineGustDepth: 0.7,
    // rad/s of travel toward the vanishing point per m/s of wind. At the F6
    // default (11 m/s) a crest covers one undulation in ~8 s: air moving, not
    // a conveyor belt.
    windLineDriftRate: 0.015,
    // Beaufort 3 / Beaufort 8 — the first rung with whitecaps and the ladder's
    // top rung. At the shipped 11 m/s the gate is 0.53.
    windLineOnset: 3.4,
    windLineFull: 18,
    // Lower than the starfield's 3: stars want "a few bright, very many faint",
    // while a wind line that is too faint to see is just a missing wind line.
    windLineDensityPower: 1.5,
    // Mostly white, but carrying a third of the live horizon haze, so the
    // streaks warm with the sky at golden hour instead of staying chalk (§T39)
    windLineWhiteness: 0.65,
    // lit air, and there is almost nothing lighting it after dark
    windLineNightDim: 0.15,
    // ~1.7°: shallow on purpose. The vanishing point sits ON the horizon and
    // is the most legible part of the bearing read, so unlike the starfield
    // this must NOT fade the bottom of the sky away.
    windLineHorizonFade: 0.03,
    sunDiscSize: 1.1,
    sunDiscSoftness: 0.35,
    sunDiscIntensity: 14,
    sunGlowPower: 240,
    sunGlowStrength: 1.2,
    sunHaloPower: 6,
    sunHaloStrength: 0.16,
    sunGlareRadiusDeg: 1.5,
    gradientCurve: 1.5,
    sunIntensity: 3.4,
    sunDistance: 1200,
    shadowNormalBias: 0.04,
    shadowBias: -0.0004,
    shadowExtent: 80,
    shadowMapSize: 2048,
    // 0.85 is the ocean's long-standing shadowStrength, promoted to the whole
    // scene rather than retuned — the water is bit-identical after the move and
    // the terrain/ship stop being 15% darker than the water beside them.
    shadowIntensity: 0.85,
    // 0.85 → 0.70: the sky half moved from zenithColor to the lighter
    // midColor, which lifted total ambient ~38%; this holds shade at roughly
    // its previous brightness so only the HUE changes, not the exposure
    ambientIntensity: 0.7,
    groundBounceColor: 0x2e6d78,
    ambientDesaturation: 0.5,
    fogNear: 1800,
    fogFar: 4900,
    exposure: 1.1,
  },
  {
    timeOfDay: { min: 0, max: 24, step: 0.05 },
    latitude: { min: -60, max: 60, step: 1 },
    sunsetStrength: { min: 0, max: 1, step: 0.01 },
    hazeStrength: { min: 0, max: 1, step: 0.01 },
    hazeFalloff: { min: 0.02, max: 1, step: 0.01 },
    sunsetHazeFalloff: { min: 0.02, max: 1, step: 0.01 },
    sunsetGradientCurve: { min: 0.2, max: 4, step: 0.01 },
    sunHazeStrength: { min: 0, max: 1, step: 0.01 },
    horizonWarmStrength: { min: 0, max: 1, step: 0.01 },
    moonPhase: { min: 0, max: 1, step: 0.01 },
    moonInclination: { min: 0, max: 30, step: 0.1 },
    moonNodeOffset: { min: 0, max: 360, step: 1 },
    moonGlareAngle: { min: 0, max: 45, step: 0.5 },
    moonGlareSoftness: { min: 0.5, max: 45, step: 0.5 },
    bodyHorizonMargin: { min: 0, max: 5, step: 0.1 },
    moonDiscPhase: { min: 0, max: 1, step: 0.01 },
    moonIntensity: { min: 0, max: 4, step: 0.01 },
    moonAmbient: { min: 0, max: 1, step: 0.01 },
    nightAmbientFloor: { min: 0, max: 1, step: 0.01 },
    moonDiscSize: { min: 0.2, max: 6, step: 0.05 },
    moonDiscSoftness: { min: 0.02, max: 3, step: 0.02 },
    moonDiscIntensity: { min: 0, max: 8, step: 0.05 },
    moonTerminatorSoftness: { min: 0.01, max: 0.5, step: 0.01 },
    moonGlowPower: { min: 1, max: 2000, step: 5 },
    moonGlowStrength: { min: 0, max: 4, step: 0.01 },
    moonHaloPower: { min: 1, max: 64, step: 0.5 },
    moonHaloStrength: { min: 0, max: 1, step: 0.01 },
    starDensity: { min: 8, max: 160, step: 1 },
    starSize: { min: 0.005, max: 0.3, step: 0.005 },
    starBrightness: { min: 0, max: 60, step: 0.5 },
    starMagnitudePower: { min: 0.5, max: 8, step: 0.1 },
    starTwinkleAmount: { min: 0, max: 1, step: 0.01 },
    starTwinkleRate: { min: 0, max: 8, step: 0.05 },
    starHorizonFade: { min: 0.01, max: 0.6, step: 0.01 },
    windLineCount: { min: 7, max: 151, step: 2 },
    windLineWidth: { min: 0.01, max: 0.4, step: 0.005 },
    windLineBrightness: { min: 0, max: 0.5, step: 0.005 },
    windLineWaveAmount: { min: 0, max: 0.3, step: 0.005 },
    windLineWaveFreq: { min: 0.05, max: 3, step: 0.05 },
    windLineGustFreq: { min: 0.05, max: 2, step: 0.05 },
    windLineGustDepth: { min: 0, max: 1, step: 0.01 },
    windLineDriftRate: { min: 0, max: 0.1, step: 0.001 },
    windLineOnset: { min: 0, max: 20, step: 0.1 },
    windLineFull: { min: 1, max: 30, step: 0.5 },
    windLineDensityPower: { min: 0.2, max: 6, step: 0.1 },
    windLineWhiteness: { min: 0, max: 1, step: 0.01 },
    windLineNightDim: { min: 0, max: 1, step: 0.01 },
    windLineHorizonFade: { min: 0.005, max: 0.3, step: 0.005 },
    sunDiscSize: { min: 0.2, max: 6, step: 0.05 },
    sunDiscSoftness: { min: 0.05, max: 3, step: 0.05 },
    sunDiscIntensity: { min: 1, max: 40, step: 0.5 },
    sunGlowPower: { min: 1, max: 600, step: 1 },
    sunGlowStrength: { min: 0, max: 4, step: 0.01 },
    sunHaloPower: { min: 1, max: 32, step: 0.5 },
    sunHaloStrength: { min: 0, max: 1, step: 0.01 },
    sunGlareRadiusDeg: { min: 0, max: 6, step: 0.05 },
    gradientCurve: { min: 0.2, max: 4, step: 0.01 },
    sunIntensity: { min: 0, max: 8, step: 0.05 },
    sunDistance: { min: 100, max: 4000, step: 10 },
    shadowNormalBias: { min: 0, max: 0.5, step: 0.005 },
    shadowBias: { min: -0.005, max: 0, step: 0.0001 },
    shadowExtent: { min: 20, max: 200, step: 5 },
    shadowMapSize: { min: 1024, max: 4096, step: 1024 },
    shadowIntensity: { min: 0, max: 1, step: 0.01 },
    ambientIntensity: { min: 0, max: 3, step: 0.01 },
    ambientDesaturation: { min: 0, max: 1, step: 0.01 },
    fogNear: { min: 0, max: 8000, step: 10 },
    fogFar: { min: 200, max: 30000, step: 50 },
    exposure: { min: 0.3, max: 3, step: 0.01 },
  },
);
