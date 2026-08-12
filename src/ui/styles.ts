/**
 * UI stylesheet, part 1 of 2 (§V21: AAA pirate theme, no clipart/templated
 * look). Injected once via a single <style> tag; palette lives in CSS custom
 * properties derived from docs/ship-reference-schema.png (parchment, sepia
 * ink, aged brass, rope, wax) + final-full-result.png (deep sea teal).
 * System old-style serif stack only — no font fetches, CSP-clean.
 */
import { HUD_CSS } from './stylesHud';
import { SETTINGS_CSS } from './stylesSettings';

const BASE_CSS = /* css */ `
.smt-ui, .smt-ui * { margin: 0; padding: 0; box-sizing: border-box; }
.smt-ui {
  --ink: #2c2114;
  --ink-soft: rgba(44, 33, 20, 0.6);
  --line: rgba(44, 33, 20, 0.24);
  --parch: #e7d8ae;
  --parch-hi: #f3e9cd;
  --parch-lo: #cdb27f;
  --brass: #9d7f36;
  --brass-hi: #dfc06d;
  --rope: #7c6340;
  --rope-dark: #5e4a2d;
  --sea-ink: #071e24;
  --wax: #8e2b25;
  --serif: "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif;
  --figures: Georgia, "Times New Roman", serif;
  position: fixed; inset: 0; z-index: 20;
  pointer-events: none;
  font-family: var(--serif);
  color: var(--ink);
  -webkit-font-smoothing: antialiased;
}
@media (prefers-reduced-motion: reduce) {
  .smt-ui *, .smt-ui *::before, .smt-ui *::after {
    transition: none !important; animation: none !important;
  }
}
`;

const PAUSE_CSS = /* css */ `
.smt-backdrop {
  position: absolute; inset: 0; pointer-events: auto; cursor: pointer;
  background:
    radial-gradient(closest-side at 50% 44%, rgba(7, 30, 36, 0) 52%, rgba(4, 17, 21, 0.8) 100%),
    linear-gradient(rgba(7, 26, 31, var(--smt-dim, 0.5)), rgba(7, 26, 31, var(--smt-dim, 0.5)));
  opacity: 0; visibility: hidden;
  transition: opacity 0.26s ease, visibility 0s linear 0.26s;
}
.smt-ui.is-paused .smt-backdrop {
  opacity: 1; visibility: visible; transition-delay: 0s;
}
.smt-panel-wrap {
  position: absolute; inset: 0; display: flex;
  align-items: center; justify-content: center;
  opacity: 0; visibility: hidden; transform: translateY(14px);
  transition: opacity 0.26s ease, transform 0.3s cubic-bezier(0.2, 0.9, 0.3, 1),
    visibility 0s linear 0.26s;
}
.smt-ui.is-paused .smt-panel-wrap {
  opacity: 1; visibility: visible; transform: translateY(0); transition-delay: 0s;
}
.smt-panel-shadow { filter: drop-shadow(0 22px 44px rgba(3, 14, 17, 0.65)); }
.smt-panel {
  pointer-events: auto; position: relative;
  width: min(440px, calc(100vw - 48px));
  padding: 46px 48px 56px;
  background:
    radial-gradient(130% 90% at 18% 0%, rgba(255, 250, 229, 0.55) 0%, rgba(255, 250, 229, 0) 46%),
    radial-gradient(120% 120% at 86% 102%, rgba(112, 80, 34, 0.3) 0%, rgba(112, 80, 34, 0) 55%),
    repeating-linear-gradient(93deg, rgba(118, 88, 38, 0.05) 0 2px, rgba(255, 246, 220, 0.05) 2px 4px),
    linear-gradient(162deg, var(--parch-hi) 0%, var(--parch) 55%, var(--parch-lo) 100%);
  clip-path: polygon(
    1.2% 2.6%, 6% 0.7%, 14% 2.2%, 23% 0.8%, 33% 2.5%, 44% 0.5%, 55% 2%, 66% 0.8%,
    76% 2.4%, 87% 0.6%, 95% 2.6%, 99.4% 6.5%, 98.1% 15%, 99.6% 26%, 98.2% 38%,
    99.3% 52%, 98% 64%, 99.5% 76%, 98.2% 88%, 99% 95%, 93.5% 99.4%, 84% 97.8%,
    72% 99.3%, 60% 97.9%, 48% 99.5%, 36% 98%, 25% 99.3%, 14% 97.8%, 5.5% 99.2%,
    0.7% 94%, 2% 84%, 0.5% 72%, 1.8% 60%, 0.6% 47%, 2% 34%, 0.7% 21%, 1.7% 11%);
}
.smt-panel::before, .smt-panel::after {
  content: ""; position: absolute; pointer-events: none;
}
.smt-panel::before { inset: 12px; border: 1px solid rgba(44, 33, 20, 0.32); }
.smt-panel::after { inset: 16px; border: 1px solid rgba(44, 33, 20, 0.14); }
.smt-eyebrow {
  font-size: 11px; letter-spacing: 0.36em; text-transform: uppercase;
  text-align: center; color: var(--ink-soft); text-indent: 0.36em;
}
.smt-title {
  margin-top: 10px; text-align: center;
  font-size: 46px; line-height: 1.05; font-weight: 400;
  font-variant-caps: small-caps; letter-spacing: 0.07em;
  text-shadow: 0 1px 0 rgba(255, 249, 226, 0.7);
}
.smt-fleuron { display: block; width: 240px; margin: 16px auto 0; color: var(--ink); }
.smt-menu { margin-top: 30px; display: flex; flex-direction: column; }
.smt-menu-btn {
  appearance: none; background: none; border: 0; border-top: 1px solid var(--line);
  font-family: inherit; font-variant-caps: small-caps;
  font-size: 20px; letter-spacing: 0.15em; color: var(--ink);
  padding: 13px 26px; cursor: pointer; text-align: left; position: relative;
  display: flex; justify-content: space-between; align-items: baseline;
  transition: color 0.15s ease, background 0.15s ease;
}
.smt-menu-btn:last-child { border-bottom: 1px solid var(--line); }
.smt-menu-btn::before {
  content: "\\2014"; position: absolute; left: 2px; color: var(--brass);
  opacity: 0; transform: translateX(-5px); transition: opacity 0.15s, transform 0.15s;
}
.smt-menu-btn:hover:not([disabled]), .smt-menu-btn:focus-visible {
  color: #5f4514;
  background: linear-gradient(90deg, transparent, rgba(157, 127, 54, 0.16) 30%,
    rgba(157, 127, 54, 0.16) 70%, transparent);
}
.smt-menu-btn:hover:not([disabled])::before, .smt-menu-btn:focus-visible::before {
  opacity: 1; transform: translateX(0);
}
.smt-menu-btn:focus-visible { outline: 2px solid var(--brass); outline-offset: -2px; }
.smt-menu-btn[disabled] { opacity: 0.38; cursor: default; }
.smt-menu-tag {
  font-size: 10px; letter-spacing: 0.24em; text-transform: uppercase;
  color: var(--ink-soft); font-variant-caps: normal;
}
.smt-seal {
  position: absolute; right: 26px; bottom: 22px; width: 52px; height: 52px;
  border-radius: 46% 54% 51% 49% / 53% 47% 56% 44%;
  background: radial-gradient(circle at 34% 30%, #b04a3c, var(--wax) 55%, #641d18 100%);
  box-shadow: inset 0 2px 4px rgba(255, 190, 160, 0.35), inset 0 -3px 5px rgba(40, 6, 4, 0.55),
    0 2px 6px rgba(44, 33, 20, 0.4);
  display: flex; align-items: center; justify-content: center; pointer-events: none;
}
.smt-seal-emblem { width: 26px; height: 26px; }
`;

let injected = false;

/** inject the full overlay stylesheet exactly once */
export function ensureUiStyles(): void {
  if (injected || document.getElementById('smt-ui-styles')) return;
  const tag = document.createElement('style');
  tag.id = 'smt-ui-styles';
  tag.textContent = BASE_CSS + PAUSE_CSS + SETTINGS_CSS + HUD_CSS;
  document.head.appendChild(tag);
  injected = true;
}
