/**
 * In-game HUD stylesheet (§V21). Compass is a masked engraved tape; the
 * bottom edge is a triptych of brass-edged plaques — wind to port, knots and
 * heading amidships, canvas to starboard — sharing one clipped-corner shape so
 * they read as three fittings on the same binnacle rather than three widgets.
 * Imported and injected by styles.ts (single <style> tag).
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
.smt-compass {
  position: absolute; top: 12px; left: 50%; transform: translateX(-50%);
  width: min(460px, 62vw); height: 46px; overflow: hidden;
  -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 18%, #000 82%, transparent 100%);
  mask-image: linear-gradient(90deg, transparent 0, #000 18%, #000 82%, transparent 100%);
}
.smt-compass-tape { position: absolute; top: 16px; left: 50%; height: 28px; will-change: transform; }
.smt-tick { position: absolute; bottom: 2px; width: 1px; background: rgba(240, 230, 200, 0.85); }
.smt-tick.is-minor { height: 5px; opacity: 0.5; }
.smt-tick.is-mid { height: 8px; opacity: 0.75; }
.smt-tick.is-major { height: 12px; }
.smt-tick-label {
  position: absolute; bottom: 15px; transform: translateX(-50%);
  font-size: 13px; letter-spacing: 0.08em; font-variant-caps: small-caps;
  color: #f0e6c8; text-shadow: 0 1px 2px rgba(4, 18, 22, 0.85);
}
.smt-tick-label.is-cardinal { color: var(--brass-hi); font-size: 15px; }
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

.smt-bottom {
  position: absolute; bottom: 18px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 10px;
}
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

.smt-wind-dial { width: 44px; height: 44px; flex: none; }
.smt-wind-ring { fill: none; stroke: rgba(223, 192, 109, 0.42); stroke-width: 1; }
.smt-wind-nogo { fill: rgba(142, 43, 37, 0.28); stroke: rgba(216, 87, 76, 0.3); stroke-width: 0.6; }
.smt-wind-tick { stroke: rgba(231, 216, 174, 0.45); stroke-width: 1; }
.smt-wind-tick.is-major { stroke: rgba(223, 192, 109, 0.85); stroke-width: 1.4; }
.smt-wind-hull {
  fill: rgba(231, 216, 174, 0.22); stroke: rgba(231, 216, 174, 0.5); stroke-width: 0.9;
}
.smt-wind-vane { transition: transform 0.08s linear; }
.smt-wind-flag {
  fill: var(--brass-hi);
  opacity: calc(0.32 + 0.68 * var(--smt-vane, 0));
}
.smt-wind-staff { stroke: rgba(223, 192, 109, 0.7); stroke-width: 1; }

.smt-plate.is-canvas { flex-direction: column; gap: 4px; align-items: stretch; }
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

.smt-damage {
  position: absolute; bottom: 78px; left: 50%; transform: translateX(-50%);
  display: flex; gap: 9px;
}
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
`;
