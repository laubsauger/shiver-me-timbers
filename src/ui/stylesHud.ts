/**
 * In-game HUD stylesheet (§V21). Compass is a masked engraved tape; the
 * bottom edge is a triptych of brass-edged plaques — wind to port, knots and
 * heading amidships, canvas to starboard — sharing one clipped-corner shape so
 * they read as three fittings on the same binnacle rather than three widgets.
 * Imported and injected by styles.ts (single <style> tag).
 *
 * POSITIONING RULE (§B.50). Exactly two things in this file are absolutely
 * positioned against the frame: `.smt-compass` at the top and `.smt-binnacle`
 * at the bottom. Everything else stacks in the binnacle's flow column. Four
 * elements here used to carry hand-measured `top:`/`bottom:` offsets and three
 * of the six pairs overlapped, because every one of those offsets was tuned
 * against a row whose height is set by its own text — one emoji glyph falling
 * back to a taller font moved the plaque row 26px and ate two of them.
 */

export const HUD_CSS = /* css */ `
.smt-hud {
  position: absolute; inset: 0; opacity: var(--smt-hud-opacity, 0.92);
  transition: opacity 0.4s ease, visibility 0s linear 0s;
}
/* photo mode (§I ui/cinematic): nothing over the render. Fades rather than
   cutting, so entering it mid-recording is not a one-frame pop. */
.smt-ui.is-photo .smt-hud {
  opacity: 0; visibility: hidden; transition-delay: 0s, 0.4s;
}
/* the one thing photo mode keeps: the line telling you how to get back out.
   It sits outside .smt-hud on purpose and fades itself after a few seconds. */
.smt-caption {
  position: absolute; bottom: 26px; left: 50%; transform: translateX(-50%) translateY(6px);
  padding: 7px 18px 8px; max-width: min(520px, 82vw); text-align: center;
  font-size: 13px; letter-spacing: 0.09em; font-variant-caps: small-caps;
  color: var(--parch-hi); background: rgba(10, 7, 4, 0.72);
  box-shadow: inset 0 0 0 1px rgba(223, 192, 109, 0.3);
  clip-path: polygon(10px 0, calc(100% - 10px) 0, 100% 50%, calc(100% - 10px) 100%,
    10px 100%, 0 50%);
  opacity: 0; visibility: hidden;
  transition: opacity 0.45s ease, transform 0.45s ease, visibility 0s linear 0.45s;
}
.smt-caption.is-on {
  opacity: 1; visibility: visible; transform: translateX(-50%) translateY(0);
  transition-delay: 0s;
}

/* voyage-start essentials: a torn chart slip, not a generic tutorial toast */
.smt-quick-controls {
  position: absolute; top: 50%; left: 28px; width: 268px;
  padding: 22px 22px 17px; pointer-events: none;
  color: var(--ink);
  background:
    radial-gradient(115% 80% at 15% 0%, rgba(255, 251, 230, 0.62), transparent 54%),
    repeating-linear-gradient(93deg, rgba(118, 88, 38, 0.045) 0 2px,
      rgba(255, 246, 220, 0.04) 2px 4px),
    linear-gradient(158deg, rgba(243, 233, 205, 0.96), rgba(205, 178, 127, 0.95));
  clip-path: polygon(2% 4%, 12% 1%, 25% 3%, 39% 0, 53% 3%, 68% 1%, 82% 3%,
    97% 1%, 100% 12%, 98% 26%, 100% 42%, 98% 58%, 100% 74%, 97% 97%,
    84% 99%, 70% 97%, 55% 100%, 41% 97%, 27% 99%, 12% 97%, 1% 99%, 3% 82%,
    1% 66%, 3% 50%, 1% 34%);
  filter: drop-shadow(0 13px 22px rgba(2, 14, 18, 0.52));
  opacity: 0; visibility: hidden;
  transform: translate(-18px, -50%);
  transition: opacity 0.65s ease, transform 0.75s cubic-bezier(0.2, 0.85, 0.3, 1),
    visibility 0s linear 0.75s;
}
.smt-quick-controls::before {
  content: ""; position: absolute; inset: 9px;
  border: 1px solid rgba(44, 33, 20, 0.24); pointer-events: none;
}
.smt-quick-controls.is-visible {
  opacity: 1; visibility: visible; transform: translate(0, -50%);
  transition-delay: 0s;
}
.smt-quick-controls.is-leaving { transform: translate(-10px, -50%); }
.smt-ui.is-paused .smt-quick-controls,
.smt-ui.is-photo .smt-quick-controls { opacity: 0; visibility: hidden; }
.smt-quick-eyebrow {
  position: relative; font-size: 9px; letter-spacing: 0.3em; text-transform: uppercase;
  color: var(--ink-soft);
}
.smt-quick-title {
  position: relative; margin-top: 3px; padding-bottom: 11px;
  border-bottom: 1px solid rgba(44, 33, 20, 0.25);
  font-size: 23px; font-weight: 400; font-variant-caps: small-caps;
  letter-spacing: 0.09em;
}
.smt-quick-row {
  position: relative; display: grid; grid-template-columns: 76px 1fr;
  align-items: center; gap: 10px; min-height: 48px;
  border-bottom: 1px solid rgba(44, 33, 20, 0.12);
}
.smt-quick-keys { display: flex; gap: 5px; }
.smt-quick-controls .smt-key { min-width: 28px; }
.smt-quick-copy { display: flex; flex-direction: column; }
.smt-quick-action {
  font-size: 15px; font-variant-caps: small-caps; letter-spacing: 0.08em;
}
.smt-quick-hint { margin-top: 1px; font-size: 10.5px; color: var(--ink-soft); }
.smt-quick-foot {
  position: relative; margin-top: 11px; text-align: center;
  font-size: 9.5px; color: var(--ink-soft); letter-spacing: 0.035em;
}

@media (max-width: 760px) {
  .smt-quick-controls {
    top: auto; bottom: 88px; left: 50%; width: min(320px, calc(100vw - 36px));
    transform: translate(-50%, 12px);
  }
  .smt-quick-controls.is-visible { transform: translate(-50%, 0); }
  .smt-quick-controls.is-leaving { transform: translate(-50%, 8px); }
}
/* The heading band, and nothing else in it. The tape needs a ground: it sits
   permanently against sky — cream at timeOfDay 17.6, mid-blue at 15.0 — and
   1px pale ticks over pale sky are invisible at both. The wash is masked by
   the same horizontal gradient as the ticks, so it has no edges of its own and
   still fades into the view rather than sitting on it as a bar (§V21). */
.smt-compass {
  position: absolute; top: 12px; left: 50%; transform: translateX(-50%);
  width: min(460px, 62vw); height: 46px; overflow: hidden;
  background: linear-gradient(180deg,
    rgba(6, 14, 18, 0) 0%, rgba(6, 14, 18, 0.5) 20%,
    rgba(6, 14, 18, 0.58) 86%, rgba(6, 14, 18, 0) 100%);
  -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 18%, #000 82%, transparent 100%);
  mask-image: linear-gradient(90deg, transparent 0, #000 18%, #000 82%, transparent 100%);
}
.smt-compass-tape { position: absolute; top: 16px; left: 50%; height: 28px; will-change: transform; }
/* a 1px pale tick over a pale sky is nothing at all — every mark on this band
   carries its own dark halo so the tape survives a cream sunset (§V21) */
.smt-tick {
  position: absolute; bottom: 2px; width: 1px; background: rgba(240, 230, 200, 0.85);
  box-shadow: 0 0 2px rgba(4, 18, 22, 0.9);
}
.smt-tick.is-minor { height: 5px; opacity: 0.5; }
.smt-tick.is-mid { height: 8px; opacity: 0.75; }
.smt-tick.is-major { height: 12px; }
.smt-tick-label {
  position: absolute; bottom: 15px; transform: translateX(-50%);
  font-size: 13px; letter-spacing: 0.08em; font-variant-caps: small-caps;
  color: #f0e6c8;
  text-shadow: 0 0 5px rgba(4, 18, 22, 1), 0 1px 2px rgba(4, 18, 22, 0.95);
}
.smt-tick-label.is-cardinal { color: var(--brass-hi); font-size: 15px; }
/* §T.156 — the radio's fixes. A brass pip on the heading tape with the
   station's name under it, placed against the lubber line rather than carried
   by the tape's translate. Deliberately quieter than the cardinal letters
   (§V21): it is a bearing you have earned, not a quest marker. */
.smt-compass-marks {
  position: absolute; top: 10px; left: 50%; height: 46px; width: 0;
  pointer-events: none;
}
.smt-radio-mark {
  position: absolute; top: 0; left: 0; width: 0; height: 100%;
  display: flex; flex-direction: column; align-items: center;
}
.smt-radio-pip {
  width: 7px; height: 7px; flex: 0 0 auto;
  background: var(--brass-hi);
  clip-path: polygon(50% 100%, 0 0, 100% 0);
  box-shadow: 0 1px 3px rgba(4, 18, 22, 0.8);
}
.smt-radio-name {
  margin-top: 1px; white-space: nowrap;
  font-size: 10px; letter-spacing: 0.1em; font-variant-caps: small-caps;
  color: var(--brass-hi); opacity: 0.9;
  text-shadow: 0 0 5px rgba(4, 18, 22, 1), 0 1px 2px rgba(4, 18, 22, 0.95);
}
/* §T.160 — the look ray's own point. 3 px, brass, with a dark halo so it
   survives a cream sunset the way the compass ticks do, and 0.5 opacity so it
   never competes with the thing it is pointed at (§V21). */
.smt-cursor {
  position: absolute; top: 50%; left: 50%; width: 3px; height: 3px;
  transform: translate(-50%, -50%); border-radius: 50%;
  background: var(--brass-hi); opacity: 0.5;
  box-shadow: 0 0 3px rgba(4, 18, 22, 0.95);
  pointer-events: none;
}
.smt-lubber {
  position: absolute; top: 0; left: 50%; transform: translateX(-50%);
  width: 9px; height: 46px; pointer-events: none;
}
.smt-lubber::before {
  content: ""; position: absolute; top: 0; left: 50%; transform: translateX(-50%) rotate(45deg);
  width: 7px; height: 7px; background: var(--brass-hi);
  box-shadow: 0 1px 3px rgba(4, 18, 22, 0.7);
}
.smt-lubber::after {
  content: ""; position: absolute; top: 9px; bottom: 0; left: 50%; width: 1px;
  background: linear-gradient(180deg, var(--brass-hi), rgba(223, 192, 109, 0));
}

/* the binnacle: the ONE absolutely-positioned box at the bottom of the frame.
   Its children stack bottom-up, so the plaque row stays pinned 18px off the
   edge while the seal, the diamonds and the true-wind line grow upward off it
   and can never reach it. */
.smt-binnacle {
  position: absolute; bottom: 18px; left: 50%; transform: translateX(-50%);
  display: flex; flex-direction: column; align-items: center; gap: 9px;
}
.smt-bottom { display: flex; align-items: stretch; gap: 10px; }
.smt-plate {
  display: flex; align-items: center; gap: 16px; padding: 9px 30px;
  background: linear-gradient(180deg, rgba(26, 18, 10, 0.82), rgba(13, 9, 5, 0.88));
  clip-path: polygon(14px 0, calc(100% - 14px) 0, 100% 50%, calc(100% - 14px) 100%, 14px 100%, 0 50%);
  box-shadow: inset 0 0 0 1px rgba(223, 192, 109, 0.38), inset 0 0 22px rgba(0, 0, 0, 0.6);
  color: var(--parch);
}
.smt-plate-side { padding: 7px 20px; gap: 10px; }
.smt-plate-side .smt-plate-value { font-size: 19px; }
.smt-plate-side .smt-plate-cell { min-width: 62px; }
.smt-plate-cell { text-align: center; min-width: 78px; }
/* names the quantity when the same unit appears twice on screen — see
   plaqueCell(). Dimmer and smaller than the label so it reads as a heading
   over the figure, not as a second reading. */
.smt-plate-key {
  margin-bottom: 1px; font-size: 8px; letter-spacing: 0.3em; text-indent: 0.3em;
  text-transform: uppercase; color: rgba(231, 216, 174, 0.4);
  white-space: nowrap;
}
.smt-plate-value {
  font-family: var(--figures); font-size: 24px; line-height: 1.1;
  font-variant-numeric: tabular-nums; color: var(--parch-hi);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.65);
}
.smt-plate-label {
  margin-top: 1px; font-size: 9px; letter-spacing: 0.32em; text-indent: 0.32em;
  text-transform: uppercase; color: rgba(231, 216, 174, 0.55);
  white-space: nowrap;
}
.smt-plate-sep {
  width: 1px; height: 30px;
  background: linear-gradient(180deg, transparent, rgba(223, 192, 109, 0.5), transparent);
}

/* THE SAILING GIZMO (§T.84, drawn in windDial.ts). 96px so the yard bar and
   the ghost yard separate from a couch at 1080p; every state also has a
   SHAPE — bars converge, sail flips, wedge is a wedge — so the colour is a
   second channel, never the only one. Palette: brass for "drawing well",
   amber for "could be better", wax red for "backed / no drive". */
.smt-wind-dial { width: 96px; height: 96px; flex: none; overflow: visible; }
.smt-plate.is-wind { padding: 5px 18px 5px 10px; }
.smt-wind-ring { fill: none; stroke: rgba(223, 192, 109, 0.42); stroke-width: 1; }
.smt-wind-nogo { fill: rgba(142, 43, 37, 0.34); stroke: rgba(216, 87, 76, 0.35); stroke-width: 0.6; }
.smt-wind-nogo.is-ramp { fill: rgba(142, 43, 37, 0.16); stroke: none; }
.smt-wind-tick { stroke: rgba(231, 216, 174, 0.45); stroke-width: 1; }
.smt-wind-tick.is-major { stroke: rgba(223, 192, 109, 0.85); stroke-width: 1.4; }
.smt-wind-hull {
  fill: rgba(231, 216, 174, 0.2); stroke: rgba(231, 216, 174, 0.55); stroke-width: 1;
}
/* the ghost yard: where the crew would brace. Dashed + chevron caps so it
   reads as a TARGET rather than a second yard */
.smt-wind-ghost { transition: transform 0.12s linear; }
.smt-wind-ghost-bar {
  stroke: rgba(223, 192, 109, 0.55); stroke-width: 1.2; stroke-dasharray: 3 2.2;
}
.smt-wind-ghost-cap { fill: none; stroke: rgba(223, 192, 109, 0.7); stroke-width: 1.1; }
/* the yards, coloured by drive — and glowed, because a thin brass bar over a
   brass ghost bar is a weak signal on its own */
.smt-wind-yard { transition: transform 0.12s linear; }
.smt-wind-yard-bar {
  stroke: var(--brass-hi); stroke-width: 3; stroke-linecap: round;
  transition: stroke 0.2s ease, filter 0.2s ease;
}
.smt-wind-mast { fill: #0d0905; stroke: var(--brass-hi); stroke-width: 1; }
.smt-wind-sail-cloth {
  fill: rgba(231, 216, 174, 0.55); stroke: rgba(231, 216, 174, 0.7); stroke-width: 0.6;
  transition: fill 0.2s ease;
}
.smt-wind-dial.is-good .smt-wind-yard-bar {
  filter: drop-shadow(0 0 2.5px rgba(223, 192, 109, 0.95));
}
.smt-wind-dial.is-fair .smt-wind-yard-bar { stroke: #e8a24a; }
.smt-wind-dial.is-fair .smt-wind-sail-cloth { fill: rgba(232, 162, 74, 0.42); }
.smt-wind-dial.is-poor .smt-wind-yard-bar { stroke: #d8574c; }
.smt-wind-dial.is-poor .smt-wind-sail-cloth { fill: rgba(216, 87, 76, 0.38); }
.smt-wind-dial.is-aback .smt-wind-yard-bar {
  stroke: #d8574c; filter: drop-shadow(0 0 3px rgba(216, 87, 76, 0.9));
}
.smt-wind-dial.is-aback .smt-wind-sail-cloth {
  fill: rgba(216, 87, 76, 0.55); stroke: #f0d9a6;
}
/* becalmed or furled: no verdict — the bar is plain brass, the sail pale */
.smt-wind-dial.is-slack .smt-wind-yard-bar {
  stroke: rgba(231, 216, 174, 0.65); filter: none;
}
.smt-wind-dial.is-slack .smt-wind-sail-cloth { fill: rgba(231, 216, 174, 0.3); stroke: rgba(231, 216, 174, 0.5); }
/* the vane: an arrow from the rim toward the hull, longer in a blow */
.smt-wind-vane { transition: transform 0.08s linear; }
.smt-wind-flag {
  fill: var(--brass-hi);
  opacity: calc(0.35 + 0.65 * var(--smt-vane, 0));
}
.smt-wind-staff {
  stroke: var(--brass-hi); stroke-width: 1.6; stroke-linecap: round;
  opacity: calc(0.35 + 0.65 * var(--smt-vane, 0));
}
.smt-wind-head { fill: var(--brass-hi); opacity: calc(0.35 + 0.65 * var(--smt-vane, 0)); }
/* caption: "aback" is a warning, and gets the seal's wax colour */
.smt-plate-label.is-aback { color: #f0a89c; font-weight: 600; }

/* the column-stacked plates need their own main-axis centring now that
   .smt-bottom stretches every plaque to one height */
.smt-plate.is-canvas {
  flex-direction: column; justify-content: center; gap: 4px; align-items: stretch;
}
.smt-canvas-bar {
  height: 3px; width: 62px; margin: 0 auto;
  background: rgba(231, 216, 174, 0.16);
  box-shadow: inset 0 0 0 1px rgba(223, 192, 109, 0.22);
}
.smt-canvas-fill {
  height: 100%; width: 100%;
  background: linear-gradient(90deg, rgba(223, 192, 109, 0.55), var(--brass-hi));
  transition: width 0.2s ease;
}

/* TRUE wind, the small line under the apparent figure in the gizmo's caption.
   The sky's wind lines already point at the bearing, so this carries only what
   the sky cannot say: strength. Was its own engraved row above the plaques
   until §T.84 folded it in here. */
.smt-truewind {
  margin-top: 3px; padding-top: 3px; white-space: nowrap;
  border-top: 1px solid rgba(223, 192, 109, 0.22);
  font-family: var(--figures); font-size: 10.5px; letter-spacing: 0.08em;
  font-variant-numeric: tabular-nums; color: rgba(231, 216, 174, 0.62);
}

/* WHY she is not making way (§B.49). A wax-red seal above the binnacle: it is
   the one thing on the HUD that means "you cannot sail until you fix this",
   so it must not read as another brass gauge. Absent when she IS sailing. */
.smt-stalled {
  transform: translateY(4px);
  padding: 4px 15px 5px; white-space: nowrap;
  font-size: 11px; letter-spacing: 0.26em; text-indent: 0.26em;
  text-transform: uppercase; font-variant-caps: small-caps;
  color: #f0d9a6; background: rgba(112, 32, 27, 0.82);
  box-shadow: inset 0 0 0 1px rgba(216, 87, 76, 0.55);
  clip-path: polygon(8px 0, calc(100% - 8px) 0, 100% 50%, calc(100% - 8px) 100%,
    8px 100%, 0 50%);
  opacity: 0; visibility: hidden;
  transition: opacity 0.25s ease, transform 0.25s ease, visibility 0s linear 0.25s;
}
.smt-stalled.is-on {
  opacity: 1; visibility: visible; transform: translateY(0);
  transition-delay: 0s;
}

/* the anchor: the HUD's only button, so it has to LOOK pressable without
   becoming a web widget sitting on a ship's binnacle */
.smt-anchor {
  flex-direction: column; justify-content: center; gap: 2px; padding: 7px 16px;
  font: inherit; color: var(--parch); cursor: pointer;
  border: 0; pointer-events: auto;
  transition: box-shadow 0.18s ease, background 0.18s ease;
}
.smt-anchor:hover { box-shadow: inset 0 0 0 1px rgba(223, 192, 109, 0.72), inset 0 0 22px rgba(0, 0, 0, 0.5); }
.smt-anchor:focus-visible { outline: 1px solid var(--brass-hi); outline-offset: 2px; }
.smt-anchor-glyph {
  font-size: 19px; line-height: 1.1; color: rgba(231, 216, 174, 0.45);
  transition: color 0.18s ease, text-shadow 0.18s ease;
}
.smt-anchor.is-down .smt-anchor-glyph {
  color: var(--brass-hi); text-shadow: 0 0 9px rgba(223, 192, 109, 0.55);
}
.smt-anchor.is-down { background: linear-gradient(180deg, rgba(46, 32, 14, 0.9), rgba(20, 14, 7, 0.92)); }

.smt-damage { display: flex; gap: 9px; }
.smt-damage-slot {
  width: 10px; height: 10px; transform: rotate(45deg);
  border: 1px solid rgba(231, 216, 174, 0.45); background: rgba(13, 9, 5, 0.45);
  transition: background 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
}
.smt-damage-slot.is-lvl1 { background: #b98f3e; border-color: #dfc06d; }
.smt-damage-slot.is-lvl2 { background: #bc5f28; border-color: #e8935a; }
.smt-damage-slot.is-lvl3 {
  background: var(--wax); border-color: #d8574c;
  box-shadow: 0 0 8px rgba(216, 87, 76, 0.55);
}

/* Narrow frames. The plaque row is 696px of fixed padding and min-widths, so
   below ~700px of viewport it hung 28px off BOTH edges — measured on main, not
   introduced here, but it is the same defect as the one this pass is fixing
   and the row is the thing that now carries the wind. Trimming the padding
   buys ~100px and keeps every plaque whole down to 600px; the true-wind line
   and the seal are their own rows and were never the problem.
   Breakpoint matches the quick-controls block above — one in this file. */
@media (max-width: 760px) {
  .smt-bottom { gap: 7px; }
  .smt-plate { padding: 9px 18px; gap: 12px; }
  .smt-plate-side { padding: 7px 11px; gap: 8px; }
  .smt-plate-cell { min-width: 66px; }
  .smt-plate-side .smt-plate-cell { min-width: 54px; }
  .smt-anchor { padding: 7px 10px; }
}
`;
