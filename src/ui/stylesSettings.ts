/**
 * Settings-screen stylesheet (§V21 — worn chart, brass fittings, engraved
 * rules). Control vocabulary, one family across the whole screen:
 *   range  = rope track, brass knob
 *   switch = brass lever thrown along a slot cut into the chart
 *   segment = engraved plate lit brass on the chosen cell
 * Injected by styles.ts as part of the single <style> tag.
 */

export const SETTINGS_CSS = /* css */ `
.smt-panel.is-settings {
  width: min(576px, calc(100vw - 40px));
  padding: 34px 40px 34px;
}
.smt-panel.is-settings .smt-seal { display: none; }
.smt-settings-head {
  display: flex; align-items: baseline; justify-content: space-between;
}
.smt-settings-title {
  font-weight: 400; font-variant-caps: small-caps;
  font-size: 24px; letter-spacing: 0.12em;
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

/* the list scrolls inside the chart; edges fade rather than being cut */
.smt-rows {
  margin-top: 6px; max-height: min(52vh, 420px); overflow-y: auto;
  padding-right: 12px;
  -webkit-mask-image: linear-gradient(180deg, transparent 0, #000 16px,
    #000 calc(100% - 16px), transparent 100%);
  mask-image: linear-gradient(180deg, transparent 0, #000 16px,
    #000 calc(100% - 16px), transparent 100%);
  scrollbar-width: thin;
  scrollbar-color: var(--brass) rgba(44, 33, 20, 0.16);
}
.smt-rows::-webkit-scrollbar { width: 7px; }
.smt-rows::-webkit-scrollbar-track {
  background: rgba(44, 33, 20, 0.14);
  box-shadow: inset 0 0 2px rgba(20, 12, 4, 0.5);
}
.smt-rows::-webkit-scrollbar-thumb {
  background: linear-gradient(180deg, var(--brass-hi), var(--brass) 60%, #6a5120);
  border-radius: 4px;
}
.smt-section { padding-bottom: 6px; }
.smt-section-head {
  display: flex; align-items: center; gap: 12px;
  margin: 20px 0 2px;
}
.smt-section:first-child .smt-section-head { margin-top: 12px; }
.smt-section-title {
  font-size: 11px; letter-spacing: 0.34em; text-indent: 0.34em;
  text-transform: uppercase; color: var(--ink-soft); white-space: nowrap;
}
.smt-section-rule {
  flex: 1; height: 1px;
  background: linear-gradient(90deg, rgba(44, 33, 20, 0.34), rgba(44, 33, 20, 0.06));
}

.smt-row { padding: 11px 2px 8px; border-bottom: 1px solid rgba(44, 33, 20, 0.12); }
.smt-row:last-child { border-bottom: 0; }
.smt-row.is-switch { display: flex; align-items: center; gap: 18px; }
.smt-row.is-nested { padding-left: 22px; position: relative; }
.smt-row.is-nested::before {
  content: ""; position: absolute; left: 6px; top: 0; bottom: 0; width: 1px;
  background: rgba(44, 33, 20, 0.2);
}
.smt-row.is-muted, .smt-row.is-unavailable { opacity: 0.42; }
.smt-row-top { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; }
.smt-row-text { flex: 1; min-width: 0; }
.smt-row-label {
  display: block; font-variant-caps: small-caps;
  font-size: 17px; letter-spacing: 0.09em; line-height: 1.2;
}
.smt-row-hint {
  display: block; margin-top: 1px; font-size: 12.5px; line-height: 1.35;
  color: rgba(44, 33, 20, 0.62);
}
.smt-row-value {
  font-family: var(--figures); font-size: 15px; color: var(--ink-soft);
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
.smt-badge {
  display: inline-block; margin-top: 5px; padding: 1px 7px 2px;
  font-size: 9.5px; letter-spacing: 0.2em; text-transform: uppercase;
  color: #5f4514; border: 1px solid rgba(157, 127, 54, 0.7);
  background: rgba(157, 127, 54, 0.16);
}
.smt-badge[hidden] { display: none; }
.smt-note {
  margin-top: 8px; font-size: 12.5px; font-style: italic;
  color: rgba(142, 43, 37, 0.85);
}
.smt-note[hidden] { display: none; }
.smt-note.is-quiet {
  font-style: normal; color: rgba(44, 33, 20, 0.55);
  font-family: var(--figures); font-size: 12.5px;
}

.smt-range {
  -webkit-appearance: none; appearance: none; width: 100%; height: 24px;
  background: transparent; cursor: pointer; margin-top: 6px;
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

.smt-seg { display: flex; margin-top: 8px; border: 1px solid var(--line); }
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

/* brass lever in a slot cut through the chart */
.smt-switch {
  appearance: none; background: none; border: 0; padding: 0; flex: none;
  position: relative; width: 48px; height: 22px; cursor: pointer;
}
.smt-switch::before {
  content: ""; position: absolute; inset: 4px 0; border-radius: 7px;
  background: linear-gradient(180deg, rgba(44, 33, 20, 0.34), rgba(44, 33, 20, 0.14));
  box-shadow: inset 0 1px 2px rgba(20, 12, 4, 0.6), 0 1px 0 rgba(255, 248, 224, 0.55);
  transition: background 0.18s ease;
}
.smt-switch::after {
  content: ""; position: absolute; top: 0; left: 0; width: 22px; height: 22px;
  border-radius: 50%; border: 1px solid #59431a;
  background: radial-gradient(circle at 34% 30%, #efdb98, var(--brass) 58%, #6a5120 100%);
  box-shadow: 0 1px 3px rgba(20, 12, 4, 0.5);
  filter: saturate(0.3) brightness(0.74);
  transition: transform 0.18s cubic-bezier(0.3, 0.85, 0.3, 1), filter 0.18s ease;
}
.smt-switch[aria-checked="true"]::before {
  background: linear-gradient(180deg, rgba(112, 84, 28, 0.55), rgba(157, 127, 54, 0.3));
}
.smt-switch[aria-checked="true"]::after { transform: translateX(26px); filter: none; }
.smt-switch:disabled { cursor: default; }
.smt-switch:focus-visible { outline: 2px solid var(--brass); outline-offset: 3px; }
`;
