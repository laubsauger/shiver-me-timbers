# speedboat (working title): design doc, draft 2

Mirror of the design decisions and open questions. The full doc, with the AD board and UI mockups, is the artifact:
https://claude.ai/code/artifact/9820b95d-858e-4402-8af3-1144a4d21ff3

Tech is covered elsewhere and is not repeated here: `docs/speedboat/tech-research.md`, `docs/wake/wake-research.md`.
Numbers marked *tuning* are playtest starting points.

## Decisions 2026-09-13
- **World:** 2100 flooded-world tie-in, same world and era as Raft 2100, but an action mode. The early-80s offshore setting and the "three eras on one sea" framing are deleted. New fiction: courier league.
- **Name:** decide later. Working title "speedboat". Rooster Tail dropped. Candidates in Q1.
- **Islands:** new race island kit (sandbars, rock gardens, drowned structures, channel markers). Neither the pirate kit nor the Sierra kit.
- **Landmark:** drowned radio tower at start/finish (recommended, Q3). The 1720 galleon wreck is removed.
- **Crew:** solo pilot, visible. The Throttleman assist becomes **the Governor**, a salvaged throttle-governor module.
- **Cockpit camera is in the first playable,** with a cockpit HUD variant. Built in P2.
- **Numbers:** top speed ~80 kn (42 m/s class), Surge to ~90 kn. Every boat samples the sea at 0.8 m (engine side).
- **Reworked:** liveries → community paint; AD; HUD language → "stencil and signal"; sound → ethanol V8s + one turbine + one electric; radio becomes a core system.
- **Confirmed as recommended:** knots; Surge earned only, 3 segments, no overheat; rolling start behind a pace boat; cosmetic damage + 1.5 s stall; no speed rubber-banding (trailing NPCs take more risk); lee swell shadow (engine task); Working sea default, Calm/Breeze/Squall selectable, Gale/Storm locked; right-stick trim + invert; assist defaults, Pro preset all off; music in menus/results only, no commentary, race-control radio calls.
- **Loop diagram** is now inline SVG, not mermaid.
- **Tech alignment needed:** tech-research §0 row 5 / §5 still proposes a ±8% power-only rubber band (contradicts "no speed banding"). Row 4 respawns at the last gate; the design respawns on the racing line ≥ 60 m behind the crash.

## 1. Pitch, pillars, world
- **Pitch:** courier racing in the flooded world of 2100. The swell is the track, the physics punishes, the game forgives, and the whole archipelago is listening on the radio.
- **Fantasy:** island communities trade by radio and boat. Urgent cargo goes by courier in pre-flood deep-V offshore hulls salvaged from drowned marinas, rebuilt many times, burning island-distilled ethanol. Once a season couriers race for the route contracts. You're a solo pilot in a 39 ft hull older than your grandmother.
- **Pillars:** the sea is the track; weight, then violence; physics punishes, the game forgives; race the water others leave.
- **Same world, other tempo:** shared sea, sky, LUT-per-hour grade and Firewatch-flattened far planes. Raft = 3 kn, granite high country, balsa and linen, no in-play UI. speedboat = 80 kn, drowned foothill line (towns, power lines, roads), fibreglass, aluminium, reflective tape and stencil paint, "stencil and signal" HUD. Neither has grime: the speedboat world is patched, not ruined.
- **Fiction (rec):** courier league with a festival mood. No villains, raiders or combat. Alternatives: salvage-rights league (pulls toward Waterworld grime), festival regatta (no stakes).
- **Where (rec):** a different stretch of the same flood. No shared islands or characters with Raft; raft mode untouched.
- **Isolation:** `speedboat.html` + `src/main-speedboat.ts`, with a transitive isolation test like `raftIsolation`.

## 2. Core loop
- Tune in (title = race channel, static resolves to race control during load) → hull & paint → circuit & conditions → rolling start → race (3 laps) → results → race again (reversed grid) / replay (P5) / menu. Crash → crash cam → reset on line → race.
- Later: Race Weekend (practice ghost, one-lap qualifier, race); the Season (3 circuits, points 20-15-12-10-8-6-4-3, champion holds the routes); P6 courier runs (point-to-point with cargo).
- **Slice:** Tower Reach (2.2 nm, 9 gates + 3 turn marks) on the race kit; V-39 salvage class (12 m / 39 ft, 24°, ~5.8 t pending hull rebeam, 3 × ethanol V8 outboards on a setback bracket, 80 kn / Surge 90); 8 community paints + number + eyewear; 7 NPCs, Club + National; Calm/Breeze/Working sea/Squall; 06:30/12:00/17:30; cameras chase, near chase, cockpit, look-back, crash; chase + cockpit HUDs, start, crash overlay, results, hull select, pause; race-control radio. Load to green ≤ 45 s cold, race again ≤ 5 s.

## 3. Moment to moment
- **Controls:** throttle W/RT; off/reverse S/LT; steer A D / LS↔; trim ↑ bow down ↓ bow up / RS↕ (invert); Surge Shift/A; look back C / RS click (cockpit: hoop mirror); camera V/Y (chase → near → cockpit); reset hold R / View 1 s; pause Esc/Menu.
- **Trim** is persistent drive angle. Airborne: throttle pitches the boat (motocross rule, a deliberate arcade liberty). Props leaving the water → over-rev.
- **Heading vs swell:** head sea (plus the breaking sandbar) = air / blow-over; beam = hops / barrel roll; following = speed / stuff; lee = max speed / hook, chine walk.
- **Wakes:** prop wash directly astern is slow; wake crests are ramps (+⅓ Surge); outside the V is clean.
- **The Governor:** salvaged throttle-governor module with a physical OFF · AIR · FULL dial in the cockpit. Maps to tech-research's assist dial *a* = 0 / ≈0.5 / 1. AIR (default) feathers throttle airborne and applies landing assist 0.5. FULL also trims. Pro preset = all off. Auto reset on by default.
- **Surge = the Governor letting go:** +⅓ per clean landing after ≥ 0.6 s air, wake jump, or exposed sector with no hard landing. Max 3. One segment = 3 s over-rev, 80 → ~90 kn, bow trims up (risky on exposed water, safe in the lee). No overheat meter, no pickups, no passive recharge, no catch-up boost.
- **Landings (tuning):** Clean pitch −2..+7°, roll < 10° → 97%. Hard → 80%. Stuffed → ~35% + Governor fuel cut, 1.5 s stall, can pitchpole above 60 kn. Roll > 25° or airborne pitch > +35° → crash.
- **Crashes:** stuff, blow-over, barrel roll, hook, chine walk (warning only), boat contact, drowned structure/rock (> 20 kn → reset), sandbar (never grounds, ≥ 1.5 m water), gate pole (flexible, −10%).
- **Respawn:** auto after 1.2 s capsized / 1.0 s bow under / structure hit > 20 kn / 3 s off corridor. Racing line ≥ 60 m back, ≥ 40 m clear, planing at max(25 kn, 50%). 2 s ghost. Cost 4–6 s. Missed gate +5 s (called on radio); two missed in a chicane → last gate.
- **Damage:** cosmetic for the race (scuffs, tape peeling, windscreen crack, bent hoop brace, missing hatch) + Governor fuel cut, re-fire after 1.5 s.

## 4. Rivals
- #9 Crosswind · J. Reyes · Dome Ten: Rival, adaptive, grudge, twin V8.
- #3 Longhaul · R. Castellane · Bench Hollow: Veteran, never crashes, big-block lope.
- #11 Shine · D. Kowalczyk · The Stills: Hothead, salvaged turboshaft, crashes ~1 in 3.
- #22 Breakwater · M. Okafor · Levee Town: Wall, lays wake, straight-cut gear whine.
- #44 White Horses · A. Lindqvist · Outer Bar: swell specialist.
- #56 Flat Jack · S. Moreau · Pine Cut: lee specialist, triple two-stroke outboards.
- #27 Spark · T. Varga · Solar Ridge: Rookie, the only electric hull (inverter whine).
- **Banding:** no speed banding; risk budget only. Target median P1–P8 gap ≤ 25 s at National. Distant-NPC on-rails LOD is fine as long as boats near the player or the camera never run on rails.
- **Tiers (tuning):** lookahead 60/140/240 m, trim ±5/±2.5/±1°, line ±18/±9/±4 m, reaction 450/250/120 ms.
- **Rivalry beats via radio:** grid read-out, "side by side at the Bar", rival crash call (+ optional pole-cam picture-in-picture), grudge on contact, session head-to-head on results.

## 5. Circuit and race island kit
- **Kit:** sandbar (ramp and lee-maker, breakers via shoaling), sand cay (shelter, anchorage), rock garden (hazard edge + shelter), drowned town (Main Street chicane, hard walls), transmission line (pylon gate row, cables high and harmless), levee/roadbed (breakwater for long lee straights, later), channel markers (gates: ■ board = left pole, ▲ board = right pole, strobe = next gate, reflective tape, flexible poles).
- **Landmark (rec):** 120 m guyed radio tower at start/finish. Race control shack bolted on, start lamps hang on it, start straight between guy anchors, red lamps visible from every sector. Alternatives: half-sunk dam (held for a later circuit), town roofs (kept as the Main Street sector).
- **Tower Reach:** Tower straight (lee) → G1/T1 hairpin → The Bar G2–G3 (head sea over a breaking sandbar, biggest air) → Pylon Row T2–G4–T3 (beam sea, drowned power line) → Stuff Run G5 (following sea) → Main Street → lee chicane G6–G8 (roofs, rock garden, 40 m gates). ≈ 4.1 km, ~2:13 at a 60 kn average.
- **Sea state:** Working sea default; Calm/Breeze/Squall; Gale/Storm locked; Glass = later time trial. Hero hour 17:30. Hours reuse Raft's LUT-per-hour grade. Lee needs the swell-shadow engine task.

## 6. Camera
- Chase (default, 7.5 m / 2.4 m, FOV 60→76, ≤ 30% roll follow, heave low-pass 0.8 s); near chase (4 m / 1.5 m, FOV 68→82).
- **Cockpit (slice, P2):** pilot eye 0.9 m above the sole, FOV 72→86; head a damped spring (100% pitch/roll to 12°, then lag); landing dip 6 cm; roll hoop, windscreen frame and dash in frame; spray sheets on glass, no wipers. Look back = hoop mirror.
- Crash cam: world-locked orbit, 0.35× for 1.2 s, skippable, player only, 20 s cooldown. From cockpit it cuts outside.
- P5: tower cam (broadcast view, replay default), pole cam, photo mode via `.is-photo` + `src/cine`. Replays need a deterministic wake sim.

## 7. Audio and radio
- Player: triple rebuilt ethanol V8 outboards (dry crackle, lumpy cam, three slightly detuned voices beating against each other, burble underwater at idle, bark on the plane, airborne over-rev + ventilation howl, Governor limiter bounce and fuel-cut re-fire).
- Fleet voices: V8 (most), turbine (Shine), triple two-stroke (Flat Jack), inverter whine (Spark). Doppler via DelayNode (tech).
- Hull/water: landing boom 60–120 Hz, chop chatter, wake double-knock, sandbar breaker roar. Salvage: rattles, buzzing tape, hoop hum (loudest in cockpit). World: guy wires singing, tower start siren, a few horns.
- **Race control radio (core):** one voice on ch 16, band-limited, squelch tails, static growing with distance from the tower, same DSP family as the raft radio. Calls: grid, lamps and green, missed gates, crashes, lead changes, last lap, finish. Subtitled in the HUD radio strip. At the finish, island stations cut in to call the result (the only crowd). P5: rival pilots on an open channel.
- No commentary and no in-race music. Menus/results music (rec): Raft's instruments played fast (taiko/frame drums, distorted koto, motorik synth bass, shakuhachi breath).

## 8. Art direction
- "Same light, faster things in it." Ghibli colour and Firewatch planes from Raft, with salvaged machines at 80 kn. Closest reference: Porco Rosso. Heavy salvage wear, but not dirty: patched, chipped, salt-crusted, still cared for *(changed 2026-09-13, user chose heavy wear)*.
- **Palette:** shared with Raft: deep water #2F6E70, lagoon #6FB2B0, granite #A9A39A, Kon-Tiki red #B2472A. Own: signal orange #FF6B1F, hi-vis yellow #E8B420, LED amber #F2B54A, reflective tape #DCE2E3, old gelcoat #E9E5DA, stencil black #151B1C.
- **Community paint:** painted by a community, not a sponsor (reference: Ghanaian fishing canoes, Indonesian perahu). One band or pattern + one sigil, number hand-painted straight onto the hull, weathered, no disc (user pick 2026-09-13), optional reflective tape, mismatched salvaged panels kept as they are, one dominant hue per boat (HUD/plotter colour), faded not dirty. Systems: band + sigil / marker diagonals / patchwork.
- **Hull and pilot:** pre-flood 39 ft deep-V, welded roll hoop + brace, low salvaged windscreen, open cockpit with roll arch + radio antenna, single centreline seat, triple outboards on a setback bracket, hoop mirror. Solo pilot, bare-headed (no helmet; strap goggles — user pick 2026-09-13 — headset), face visible at chase distance, strapped in through every crash. *(Changed 2026-09-13, user: no helmet; see Q6/Q9 and `concept/STYLE-SPEC.md` §8.)*
- **Furniture:** channel-marker gate pairs; drowned transmission pylons as turn marks (hazard paint at the waterline, checker band); radio tower start/finish (shack, lamps, checker banner, guy anchors).
- **VFX:** rooster tail, bow sheets (reuse T161), breaker line on sandbars, mist veil, ethanol pop (pale blue flame on lift-off), floating debris (hatch, jerrycan, cushions, taped panel), spray on glass (cockpit only).
- **Grade moods:** race dusk 17:30 (Raft's dusk band, warmer), noon (clean cyan), squall steel (only the markers and tower lamps stay saturated).
- **Touchstones:** Porco Rosso, Future Boy Conan, Raft's Ghibli + Firewatch/Olly Moss rules; Wave Race 64, Hydro Thunder, Burnout 3, Pacific Drive, Sea of Thieves; hand-painted canoes and perahu, reservoir drawdowns resurfacing drowned towns, Burtynsky's *Water*, offshore-racing helicopter photography. Not: Waterworld, Mad Max, neon.

## 9. HUD and screens
- **"Stencil and signal":** spray-stencil lettering (Saira Stencil One for numbers and calls, Saira Condensed for labels) + amber LED dot meters (the raft radio meter's family). Flat near-opaque stencil-black planes with one clipped corner. Signal orange for the player and anything urgent. Rival hues from their paint.
- **Chase HUD:** position/lap and splits top left, lap timer + race-control radio strip top centre, amber plotter minimap top right, sea-heading chip + trim inclinometer bottom left, Surge cells + LED speed/rpm arc + Governor state bottom right, gate marker (edge arrow off-screen), short toasts.
- **Cockpit HUD variant:** dashboard carries plotter, rpm needle, LED speed + three Surge lamps, trim bubble level, Governor dial on hand-lettered tape, radio with channel LED. Hoop mirror = look back. Overlay keeps only position/lap, gate marker, radio subtitle.
- Mocked: chase HUD, cockpit HUD, rolling start (tower lamps + radio count), crash overlay (radio call + Governor fuel cut), results (pilot · community, skill stats, tower broadcast), hull & paint select (built 2031, rebuilt 2094), pause.
- **Rules:** speed ≥ 64 px, position ≥ 88 px at 1080p; central 40% clear; signed deltas; reduced motion = no shake, slow-mo zoom or head bob; desktop only.

## 10. Roadmap
- P0 doc/AD + lookdev (one hull by the tower at 17:30) → P1 entry, one V-39 on real swell, Governor, chase cam, engine audio v1 → **P2 race kit v1 + Tower Reach + timing + cockpit camera/model/HUD + chase HUD v1 + lee swell shadow + race-control radio v1** → P3 7 NPC couriers on the wake sim, rolling start, results → P4 juice (crash cam, VFX, doppler, rumble, grade, menus, damage) = **first playable** → P5 replay, Race Weekend, time trial, World tier, rival chatter, second class → P6 courier runs, more circuits (levee, dam), the Season.
- **Exit criteria:** new player finishes 3 laps at Club < 10 min; ≥ 6 airs > 0.5 s per lap on exposed water, ≤ 1 in the lee, the Bar gives the longest jump; full race playable in cockpit with no missing info vs chase; crash → racing speed ≤ 6 s; 20 AI races with no stuck boats and Shine crashing ≥ 3× Longhaul; 8 boats + wakes within the frame budget; pirate/raft unchanged, suite green, all entries build.

## 11. Open questions (recommendation in bold)
1. Name (decide later): Relay 2100, Deadrise, Highwater, Fast Water, Courier → **lean Relay 2100 (pairs with Raft 2100); Deadrise if it should stand alone.**
2. Who races and why → **courier league with a festival mood.**
3. Landmark → **radio tower at start/finish; roofs as the Main Street chicane; dam for a later circuit.**
4. Engines and fuel → **mixed fleet: ethanol V8s, one turbine, one electric.**
5. Where relative to Raft 2100 → **different stretch of the same flood (drowned foothill line), nothing shared.**
6. Crash taste with a visible solo pilot → **strapped in and visible through every crash, cockpit crashes cut to the outside cam, nothing gory.** *(Changed 2026-09-13, user decision: no helmet, face shown; was "face never shown".)*
7. Governor reframe → **yes, "Governor", physical OFF · AIR · FULL dial, and it explains why Surge is earned.**
8. Menu/results music style → **Raft's instruments played fast (taiko, distorted koto, motorik bass, shakuhachi breath).**
9. Player identity → **pilot with a visible face; paint, number and eyewear (helmet only as an optional later cosmetic); called by number on the radio.** *(Changed 2026-09-13, user decision: no helmet.)*
10. Crossing sandbars → **crossable, biggest jump on the lap, never grounds.**
