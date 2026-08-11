/**
 * UI stylesheet, part 2 of 2 (§V21) — settings screen + in-game HUD.
 * Sliders are rope tracks with brass knobs; the status plate is an
 * elongated brass-edged plaque; the compass is a masked engraved tape.
 * Imported and injected by styles.ts (single <style> tag).
 */

export const SETTINGS_CSS = /* css */ `
.smt-settings-head {
  margin-top: 26px; display: flex; align-items: baseline; justify-content: space-between;
}
.smt-settings-title {
  font-weight: 400; font-variant-caps: small-caps;
  font-size: 22px; letter-spacing: 0.12em;
  text-shadow: 0 1px 0 rgba(255, 249, 226, 0.7);
}
.smt-back-btn {
  appearance: none; background: none; border: 0; cursor: pointer;
  font-family: inherit; font-variant-caps: small-caps;
  font-size: 15px; letter-spacing: 0.12em; color: var(--ink-soft);
  transition: color 0.15s ease;
}
.smt-back-btn:hover, .smt-back-btn:focus-visible { color: #5f4514; }
.smt-back-btn:focus-visible { outline: 2px solid var(--brass); outline-offset: 2px; }
.smt-tabs { display: flex; margin-top: 14px; border: 1px solid var(--line); }
.smt-tab {
  appearance: none; background: none; border: 0; flex: 1; cursor: pointer;
  font-family: inherit; font-variant-caps: small-caps;
  font-size: 16px; letter-spacing: 0.18em; color: var(--ink-soft);
  padding: 9px 0; transition: color 0.15s, background 0.15s, box-shadow 0.15s;
}
.smt-tab + .smt-tab { border-left: 1px solid var(--line); }
.smt-tab.is-active {
  color: var(--ink);
  background: linear-gradient(180deg, rgba(157, 127, 54, 0.24), rgba(157, 127, 54, 0.1));
  box-shadow: inset 0 0 0 1px rgba(157, 127, 54, 0.55);
}
.smt-tab:focus-visible { outline: 2px solid var(--brass); outline-offset: -3px; }
.smt-rows { margin-top: 8px; min-height: 208px; }
.smt-row { padding: 13px 2px 4px; border-bottom: 1px solid rgba(44, 33, 20, 0.12); }
.smt-row:last-child { border-bottom: 0; }
.smt-row-top { display: flex; justify-content: space-between; align-items: baseline; }
.smt-row-label {
  font-variant-caps: small-caps; font-size: 16px; letter-spacing: 0.1em;
}
.smt-row-value {
  font-family: var(--figures); font-size: 15px; color: var(--ink-soft);
  font-variant-numeric: tabular-nums;
}
.smt-range {
  -webkit-appearance: none; appearance: none; width: 100%; height: 24px;
  background: transparent; cursor: pointer; margin-top: 2px;
}
.smt-range::-webkit-slider-runnable-track {
  height: 6px;
  background: repeating-linear-gradient(115deg, var(--rope) 0 5px, var(--rope-dark) 5px 10px);
  box-shadow: inset 0 1px 2px rgba(20, 12, 4, 0.55), 0 1px 0 rgba(255, 248, 224, 0.5);
}
.smt-range::-webkit-slider-thumb {
  -webkit-appearance: none; width: 17px; height: 17px; margin-top: -5.5px;
  border-radius: 50%; border: 1px solid #59431a;
  background: radial-gradient(circle at 34% 30%, #efdb98, var(--brass) 58%, #6a5120 100%);
  box-shadow: 0 1px 3px rgba(20, 12, 4, 0.5);
}
.smt-range::-moz-range-track {
  height: 6px;
  background: repeating-linear-gradient(115deg, var(--rope) 0 5px, var(--rope-dark) 5px 10px);
  box-shadow: inset 0 1px 2px rgba(20, 12, 4, 0.55), 0 1px 0 rgba(255, 248, 224, 0.5);
}
.smt-range::-moz-range-thumb {
  width: 15px; height: 15px; border-radius: 50%; border: 1px solid #59431a;
  background: radial-gradient(circle at 34% 30%, #efdb98, var(--brass) 58%, #6a5120 100%);
  box-shadow: 0 1px 3px rgba(20, 12, 4, 0.5);
}
.smt-range:focus-visible { outline: 2px solid var(--brass); outline-offset: 2px; }
.smt-seg { display: flex; margin-top: 6px; border: 1px solid var(--line); }
.smt-seg-btn {
  appearance: none; background: none; border: 0; flex: 1; cursor: pointer;
  font-family: inherit; font-variant-caps: small-caps;
  font-size: 14px; letter-spacing: 0.14em; color: var(--ink-soft);
  padding: 7px 0; transition: color 0.15s, background 0.15s, box-shadow 0.15s;
}
.smt-seg-btn + .smt-seg-btn { border-left: 1px solid var(--line); }
.smt-seg-btn.is-active {
  color: var(--ink);
  background: linear-gradient(180deg, rgba(157, 127, 54, 0.26), rgba(157, 127, 54, 0.12));
  box-shadow: inset 0 0 0 1px rgba(157, 127, 54, 0.55);
}
.smt-seg-btn:focus-visible { outline: 2px solid var(--brass); outline-offset: -3px; }
`;

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
.smt-plate {
  position: absolute; bottom: 18px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 16px; padding: 9px 30px;
  background: linear-gradient(180deg, rgba(26, 18, 10, 0.82), rgba(13, 9, 5, 0.88));
  clip-path: polygon(14px 0, calc(100% - 14px) 0, 100% 50%, calc(100% - 14px) 100%, 14px 100%, 0 50%);
  box-shadow: inset 0 0 0 1px rgba(223, 192, 109, 0.38), inset 0 0 22px rgba(0, 0, 0, 0.6);
  color: var(--parch);
}
.smt-plate-cell { text-align: center; min-width: 78px; }
.smt-plate-value {
  font-family: var(--figures); font-size: 24px; line-height: 1.1;
  font-variant-numeric: tabular-nums; color: var(--parch-hi);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.65);
}
.smt-plate-label {
  margin-top: 1px; font-size: 9px; letter-spacing: 0.32em; text-indent: 0.32em;
  text-transform: uppercase; color: rgba(231, 216, 174, 0.55);
}
.smt-plate-sep {
  width: 1px; height: 30px;
  background: linear-gradient(180deg, transparent, rgba(223, 192, 109, 0.5), transparent);
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
