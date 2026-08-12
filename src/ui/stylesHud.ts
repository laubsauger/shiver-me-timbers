/**
 * In-game HUD stylesheet (§V21). Compass is a masked engraved tape; the
 * bottom edge is a triptych of brass-edged plaques — wind to port, knots and
 * heading amidships, canvas to starboard — sharing one clipped-corner shape so
 * they read as three fittings on the same binnacle rather than three widgets.
 * Imported and injected by styles.ts (single <style> tag).
 */

export const HUD_CSS = /* css */ `
.smt-hud { position: absolute; inset: 0; opacity: var(--smt-hud-opacity, 0.92); }
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
