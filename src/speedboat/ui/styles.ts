/**
 * "Stencil and signal" (design doc §9): flat, near-opaque stencil-black planes with one clipped
 * corner; spray-stencil numerals and calls (Saira Stencil One); condensed tracked labels (Saira
 * Condensed); LED amber dot meters from the raft radio's meter family; one signal orange for the
 * player and anything urgent; rival hues from their paint.
 *
 * Distinct from the pirate UI (parchment, brass, old-style serif, src/ui/styles.ts) and from the
 * raft (no UI in play, brush lettering). Scoped under `.sb-ui`, injected once.
 */
import { FONT_FACE_CSS } from './fonts';
import { CHASE_PANELS, COCKPIT_PANELS, MAX_ASPECT, hu, panelCss, u } from './layout';

const TOKENS = /* css */ `
.sb-ui {
  --u: min(calc(100vw / 1280), calc(100vh / 720));
  --plane: rgba(21, 27, 28, 0.82);
  --plane-solid: #151b1c;
  --orange: #ff6b1f;
  --amber: #f2b54a;
  --amber-dim: rgba(242, 181, 74, 0.22);
  --ink: #f2f4ef;
  --mute: #9fb2b0;
  --dim: rgba(242, 244, 239, 0.2);
  --good: #5fd39a;
  --lamp: #ff3b2a;
  --black-ink: #0b1516;
  --stencil: "SB Saira Stencil", "Saira Stencil One", "Arial Narrow", sans-serif;
  --cond: "SB Saira Condensed", "Saira Condensed", "Arial Narrow", sans-serif;
  --clip: ${u(16)};
  position: fixed; inset: 0; pointer-events: none; z-index: 30;
  color: var(--ink); font-family: var(--cond); font-weight: 600;
  -webkit-font-smoothing: antialiased; text-rendering: geometricPrecision;
  user-select: none;
}
.sb-ui *, .sb-ui *::before, .sb-ui *::after { box-sizing: border-box; margin: 0; padding: 0; }
.sb-ui svg { display: block; overflow: visible; }
/* the plane is painted by a clipped ::before so children may hang outside it (ghost chip, start rules) */
.sb-plane { isolation: isolate; --bg: var(--plane); }  /* every plane is positioned by its own rule */
.sb-plane::before {
  content: ""; position: absolute; inset: 0; z-index: -1; background: var(--bg);
  clip-path: polygon(0 0, calc(100% - var(--clip)) 0, 100% var(--clip), 100% 100%, 0 100%);
}
.sb-stencil { font-family: var(--stencil); font-weight: 400; font-variant-numeric: tabular-nums; line-height: 1; letter-spacing: 0.005em; text-transform: uppercase; }
.sb-label { font-family: var(--cond); font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; line-height: 1; white-space: nowrap; }
.sb-mute { color: var(--mute); }
.sb-amber { color: var(--amber); }
.sb-orange { color: var(--orange); }
.sb-good { color: var(--good); }
.sb-float { text-shadow: 0 0 ${u(3)} rgba(21, 27, 28, 0.55), 0 ${u(1)} ${u(1)} rgba(21, 27, 28, 0.45); }
@media (prefers-reduced-motion: reduce) {
  .sb-ui *, .sb-ui *::before, .sb-ui *::after { transition: none !important; animation: none !important; }
}
`;

const HUD = /* css */ `
.sbh {
  /* the race-HUD unit: the mockup unit × the player's HUD size option (pause → HUD size) */
  --hud-scale: 1;
  --hu: calc(var(--u) * var(--hud-scale));
  /* lighter than the mockup's .82: the planes sit over moving water (user feedback 2026-09-13) */
  --plane: rgba(21, 27, 28, 0.66);
  --clip: ${hu(11)};
}
.sbh-frame {
  position: absolute; top: env(safe-area-inset-top, 0px); bottom: env(safe-area-inset-bottom, 0px);
  left: 50%; transform: translateX(-50%);
  width: min(100vw - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px), 100vh * ${MAX_ASPECT.toFixed(6)});
}
.sbh-frame [data-panel] { position: absolute; }
.sbh [data-panel] { transition: opacity 0.22s ease; }
.sbh.is-hidden-race [data-panel]:not([data-panel="radio"]), .sbh.is-crash [data-panel] { opacity: 0; }
.sbh.is-cockpit [data-panel="timer"], .sbh.is-cockpit [data-panel="plotter"], .sbh.is-cockpit [data-panel="sea"],
.sbh.is-cockpit [data-panel="trim"], .sbh.is-cockpit [data-panel="surge"], .sbh.is-cockpit [data-panel="speed"] { display: none; }
${panelCss('.sbh.is-chase', CHASE_PANELS)}
${panelCss('.sbh.is-cockpit', COCKPIT_PANELS)}
.sbh .sb-float { text-shadow: 0 0 ${hu(3)} rgba(21, 27, 28, 0.6), 0 ${hu(1)} ${hu(1)} rgba(21, 27, 28, 0.5); }

/* position + lap */
.sbh-pos { display: flex; align-items: flex-end; padding: 0 0 ${hu(14)} ${hu(10)}; }
.sbh-pos::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: ${hu(3)}; background: var(--orange); }
.sbh-pos-p { font-size: ${hu(60)}; margin-bottom: ${hu(-4)}; }
.sbh-pos-n { font-size: ${hu(22)}; color: var(--mute); margin: 0 0 ${hu(1)} ${hu(2)}; }
.sbh-pos-trend { position: absolute; left: ${hu(124)}; top: ${hu(13)}; width: ${hu(10)}; height: ${hu(10)}; opacity: 0; transition: opacity 0.2s; }
.sbh-pos.is-gain .sbh-pos-trend, .sbh-pos.is-loss .sbh-pos-trend { opacity: 1; }
.sbh-pos-trend path { fill: var(--good); }
.sbh-pos.is-loss .sbh-pos-trend { transform: scaleY(-1); }
.sbh-pos.is-loss .sbh-pos-trend path { fill: var(--orange); }
.sbh-pos.is-gain::after { animation: sbh-bar 0.5s steps(2, jump-none) 3; }
@keyframes sbh-bar { 50% { background: var(--ink); } }
.sbh-lap { margin-left: auto; margin-right: ${hu(14)}; display: flex; flex-direction: column; align-items: flex-start; gap: ${hu(5)}; }
.sbh-lap-l { font-size: ${hu(9.5)}; color: var(--mute); }
.sbh-lap-v { font-size: ${hu(32)}; }
.sbh.is-cockpit .sbh-pos { padding: 0 0 ${hu(9)} ${hu(9)}; }
.sbh.is-cockpit .sbh-pos-p { font-size: ${hu(60)}; margin-bottom: ${hu(-4)}; }
.sbh.is-cockpit .sbh-pos-n { font-size: ${hu(18)}; }
.sbh.is-cockpit .sbh-pos-trend { left: ${hu(100)}; top: ${hu(10)}; width: ${hu(9)}; height: ${hu(9)}; }
.sbh.is-cockpit .sbh-lap { margin-right: ${hu(12)}; gap: ${hu(4)}; }
.sbh.is-cockpit .sbh-lap-v { font-size: ${hu(24)}; }
.sbh-ghost { position: absolute; left: 0; top: calc(100% + ${hu(4)}); display: flex; align-items: center; gap: ${hu(6)};
  padding: ${hu(3)} ${hu(8)}; background: var(--plane); font-size: ${hu(9.5)}; opacity: 0; transition: opacity 0.2s; }
.sbh-ghost.is-on { opacity: 1; }
.sbh-ghost-bar { width: ${hu(44)}; height: ${hu(3)}; background: var(--dim); overflow: hidden; }
.sbh-ghost-fill { height: 100%; background: var(--ink); transform-origin: left; }

/* standings */
.sbh-rows { display: flex; flex-direction: column; gap: ${hu(4)}; }
.sbh-row { position: relative; height: ${hu(22)}; display: flex; align-items: center; padding: 0 ${hu(9)} 0 ${hu(8)}; --clip: ${hu(6)}; }
.sbh-row.is-hidden { visibility: hidden; }
.sbh-row.is-you { --bg: var(--orange); color: var(--black-ink); }
.sbh-swatch { width: ${hu(9)}; height: ${hu(12)}; flex: none; box-shadow: inset 0 0 0 ${hu(2)} var(--ring, transparent); }
.sbh-row.is-you .sbh-swatch { background: var(--black-ink) !important; box-shadow: none; }
.sbh-row-p { font-size: ${hu(13)}; width: ${hu(26)}; margin-left: ${hu(8)}; }
.sbh-row-name { font-size: ${hu(9.5)}; flex: 1; overflow: hidden; text-overflow: ellipsis; }
.sbh-row-gap { font-size: ${hu(13)}; text-align: right; }
.sbh.is-cockpit .sbh-row { height: ${hu(20)}; }
.sbh.is-cockpit .sbh-row:nth-child(2) { display: none; }
.sbh.is-cockpit .sbh-row-p, .sbh.is-cockpit .sbh-row-gap { font-size: ${hu(12)}; }

/* lap clock */
.sbh-timer { display: flex; flex-direction: column; align-items: center; gap: ${hu(6)}; }
.sbh-timer-v { font-size: ${hu(30)}; }
.sbh-timer-sub { font-size: ${hu(9.5)}; color: var(--ink); }
.sbh-timer-sub .sep { color: var(--mute); padding: 0 ${hu(5)}; }

/* radio strip */
.sbh-radio { display: flex; align-items: center; padding: 0 ${hu(12)} 0 ${hu(11)}; --clip: ${hu(10)}; gap: ${hu(9)}; }
.sbh-radio-bars { display: flex; align-items: flex-end; gap: ${hu(1.5)}; height: ${hu(12)}; flex: none; }
.sbh-radio-bars i { width: ${hu(3)}; background: var(--amber); }
.sbh-radio-bars i:nth-child(1) { height: 25%; } .sbh-radio-bars i:nth-child(2) { height: 50%; }
.sbh-radio-bars i:nth-child(3) { height: 75%; } .sbh-radio-bars i:nth-child(4) { height: 100%; opacity: 0.3; }
.sbh-radio.is-live .sbh-radio-bars i:nth-child(4) { animation: sbh-flicker 0.9s steps(1, end) infinite; }
@keyframes sbh-flicker { 0% { opacity: 1; } 30% { opacity: 0.3; } 55% { opacity: 1; } 80% { opacity: 0.3; } }
.sbh-radio-ch { font-size: ${hu(9.5)}; color: var(--amber); flex: none; }
.sbh-radio-line { font-size: ${hu(12.5)}; font-weight: 600; letter-spacing: 0.01em; line-height: 1.1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sbh-radio.is-quiet .sbh-radio-line { color: var(--mute); }
.sbh-radio-sub { display: none; position: absolute; left: 50%; transform: translateX(-50%); top: calc(100% + ${hu(5)}); padding: ${hu(5)} ${hu(10)}; background: var(--plane); font-size: ${hu(9.5)}; color: var(--mute); text-shadow: none; }
.sbh.is-start .sbh-radio-sub { display: block; }
.sbh-radio-sub b { color: var(--orange); font-weight: 600; }

/* plotter */
.sbh-plot { padding: ${hu(10)} ${hu(12)} ${hu(9)} ${hu(10)}; display: flex; flex-direction: column; }
.sbh-plot svg { flex: 1; width: 100%; min-height: 0; }
.sbh-plot-line { fill: none; stroke: var(--amber); stroke-opacity: 0.85; stroke-linejoin: round; }
.sbh-plot-tick { stroke: var(--amber); stroke-opacity: 0.55; }
.sbh-plot-next { fill: none; stroke: var(--orange); }
.sbh-plot-sf { fill: var(--lamp); }
.sbh-plot-dot { stroke-width: 0; }
.sbh-plot-you { fill: var(--player, var(--orange)); stroke: var(--ink); }
.sbh-plot-label { font-size: ${hu(9.5)}; color: var(--amber); margin-top: ${hu(3)}; }

/* sea chip */
.sbh-sea { display: flex; align-items: center; gap: ${hu(6)}; padding: 0 ${hu(9)}; font-size: ${hu(9.5)}; --clip: ${hu(6)}; }
.sbh-sea svg { width: ${hu(7)}; height: ${hu(7)}; }
.sbh-sea svg path { fill: var(--orange); }

/* trim dial */
.sbh-trim-l { position: absolute; left: ${hu(11)}; top: ${hu(11)}; font-size: ${hu(9.5)}; color: var(--mute); }
.sbh-trim-v { position: absolute; left: ${hu(10)}; top: ${hu(26)}; font-size: ${hu(22)}; }
.sbh-trim-s { position: absolute; right: ${hu(11)}; top: ${hu(11)}; font-size: ${hu(9.5)}; }
.sbh-trim-s.is-in { color: var(--good); }
.sbh-trim-s.is-high, .sbh-trim-s.is-low { color: var(--orange); }
.sbh-trim-s.is-water { color: var(--mute); }
.sbh-trim svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.sbh-dot { fill: var(--ink); fill-opacity: 0.25; }
.sbh-dot.is-window { fill: var(--good); fill-opacity: 0.35; }
.sbh-dot.is-on { fill: var(--amber); fill-opacity: 1; }
.sbh-dot.is-window.is-on { fill: var(--good); }
.sbh-trim-band { fill: none; stroke: var(--good); stroke-opacity: 0.35; }
.sbh-trim.is-air .sbh-trim-band { stroke-opacity: 1; }
.sbh-trim-tick { fill: var(--mute); font-family: var(--stencil); }
.sbh-needle { stroke: var(--orange); stroke-linecap: round; }
.sbh-hub { fill: var(--orange); }
.sbh-horizon { stroke: var(--mute); stroke-dasharray: 4 4; }
.sbh-hull { fill: #e9e5da; }
.sbh-hull-band { fill: var(--orange); }

/* surge */
.sbh-surge { display: flex; align-items: center; gap: ${hu(7)}; padding: 0 ${hu(9)}; --clip: ${hu(6)}; }
.sbh-surge-l { font-size: ${hu(9.5)}; width: ${hu(44)}; }
.sbh-cell { position: relative; width: ${hu(46)}; height: ${hu(8)}; box-shadow: inset 0 0 0 ${hu(1.2)} var(--orange); background: rgba(255, 107, 31, 0.16); overflow: hidden; }
.sbh-cell i { position: absolute; inset: 0; background: var(--orange); transform-origin: left; }
.sbh-cell.is-full { box-shadow: inset 0 0 0 ${hu(1.2)} var(--orange), 0 0 ${hu(6)} rgba(255, 107, 31, 0.5); }
.sbh-cell.is-filling i { opacity: 0.7; }

/* speed + tach */
.sbh-speed svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.sbh-tach { fill: var(--ink); fill-opacity: 0.2; }
.sbh-tach.is-on { fill: var(--amber); fill-opacity: 1; }
.sbh-tach.is-red { fill: var(--lamp); fill-opacity: 0.35; }
.sbh-tach.is-red.is-on { fill: var(--lamp); fill-opacity: 1; }
.sbh-speed-v { position: absolute; left: 0; right: 0; top: ${hu(52)}; text-align: center; font-size: ${hu(44)}; }
.sbh-speed-l { position: absolute; left: 0; right: 0; top: ${hu(101)}; text-align: center; font-size: ${hu(9.5)}; color: var(--mute); }
.sbh-gov { position: absolute; right: ${hu(7)}; top: ${hu(11)}; font-size: ${hu(9.5)}; color: var(--amber); }
.sbh-gov.is-off { color: var(--mute); }
.sbh-speed.is-surging .sbh-speed-v { color: var(--orange); }

/* gate marker (viewport space; sizes set in px by RaceHud.resize/setScale) */
.sbh-gate { position: absolute; inset: 0; width: 100%; height: 100%; }
.sbh-gate-arrow { fill: var(--orange); filter: drop-shadow(0 0 ${hu(2)} rgba(21, 27, 28, 0.35)); }
.sbh-gate-text { font-family: var(--stencil); fill: var(--ink); filter: drop-shadow(0 0 ${hu(2)} rgba(21, 27, 28, 0.6)); }
.sbh-gate.is-hidden { visibility: hidden; }

/* toast */
.sbh-toast { position: absolute; left: 50%; top: ${hu(150)}; transform: translateX(-50%); text-align: center; opacity: 0; transition: opacity 0.18s ease; }
.sbh-toast.is-on { opacity: 1; }
.sbh-toast-t { font-size: ${hu(34)}; display: block; }
.sbh-toast-d { font-size: ${hu(11)}; color: var(--orange); display: block; margin-top: ${hu(6)}; }

/* rolling start + countdown */
.sbh-start { position: absolute; inset: 0; opacity: 0; transition: opacity 0.3s ease; }
.sbh.is-start .sbh-start { opacity: 1; }
.sbh-lamps { position: absolute; left: 50%; top: ${hu(18)}; transform: translateX(-50%); width: ${hu(178)}; height: ${hu(50)};
  padding: ${hu(6)} ${hu(12)} 0 ${hu(10)}; }
.sbh-lamps-l { font-size: ${hu(9.5)}; color: var(--mute); }
.sbh-lamps-row { display: flex; gap: ${hu(5)}; margin-top: ${hu(5)}; }
.sbh-lamp { width: ${hu(24)}; height: ${hu(24)}; border-radius: 50%; background: #2a3133; box-shadow: inset 0 ${hu(-2)} ${hu(3)} rgba(0,0,0,.35); }
.sbh-lamp.is-on { background: var(--lamp); box-shadow: 0 0 ${hu(11)} rgba(255, 59, 42, 0.65), inset 0 ${hu(-2)} ${hu(3)} rgba(120, 10, 0, .35); }
.sbh-count { position: absolute; left: 0; right: 0; top: ${hu(150)}; text-align: center; }
.sbh-count-v { font-size: ${hu(150)}; display: block; text-shadow: 0 0 ${hu(14)} rgba(21, 27, 28, 0.35), 0 ${hu(2)} ${hu(2)} rgba(21, 27, 28, 0.4) !important; }
.sbh-count-l { font-size: ${hu(16)}; display: block; margin-top: ${hu(10)}; }
.sbh-count.is-green .sbh-count-v { color: var(--good); }
.sbh-chip { position: absolute; top: ${hu(24)}; height: ${hu(48)}; padding: ${hu(9)} ${hu(14)} 0 ${hu(11)}; --clip: ${hu(10)}; }
.sbh-chip-l { font-size: ${hu(9.5)}; color: var(--mute); }
.sbh-chip-v { font-size: ${hu(22)}; margin-top: ${hu(5)}; }
.sbh-chip-t { font-size: ${hu(11.5)}; margin-top: ${hu(7)}; }
.sbh-chip.is-grid { left: ${hu(28)}; width: ${hu(196)}; }
.sbh-chip.is-cond { right: ${hu(24)}; width: ${hu(290)}; }

/* crash */
.sbh-crash { position: absolute; inset: 0; visibility: hidden; }
.sbh.is-crash .sbh-crash { visibility: visible; }
.sbh-letterbox { position: absolute; left: 0; right: 0; height: calc(100vh * 60 / 720); background: #000; transition: transform 0.35s cubic-bezier(.2,.8,.2,1); }
.sbh-letterbox.is-top { top: 0; transform: translateY(-100%); }
.sbh-letterbox.is-bottom { bottom: 0; transform: translateY(100%); }
.sbh.is-crash.is-crashcam .sbh-letterbox { transform: none; }
/* crash cam look (design doc §9: desaturated): the page's grade may do this better; the overlay
   carries a tint so the state reads even without it */
.sbh-crash-tint { position: absolute; inset: 0; background: rgba(11, 21, 22, 0.25); backdrop-filter: saturate(0.35); opacity: 0; transition: opacity 0.3s; }
.sbh.is-crashcam .sbh-crash-tint { opacity: 1; }
.sbh-crash-body { position: absolute; inset: 0; }
.sbh-crash-t { position: absolute; left: ${hu(48)}; top: ${hu(84)}; font-size: ${hu(84)}; }
.sbh-crash-c { position: absolute; left: ${hu(52)}; top: ${hu(170)}; font-size: ${hu(12.5)}; }
.sbh-crash-tag { position: absolute; right: ${hu(44)}; top: ${hu(78)}; height: ${hu(26)}; padding: ${hu(8)} ${hu(16)} 0 ${hu(12)}; background: var(--orange); color: var(--black-ink); font-size: ${hu(11)}; --clip: ${hu(10)};
  clip-path: polygon(0 0, calc(100% - var(--clip)) 0, 100% var(--clip), 100% 100%, 0 100%); }
.sbh-crash-tag.is-off { visibility: hidden; }
.sbh-crash-radio { position: absolute; left: ${hu(48)}; bottom: ${hu(148)}; width: ${hu(470)}; height: ${hu(32)}; display: flex; align-items: center; gap: ${hu(9)}; padding: 0 ${hu(12)}; --clip: ${hu(10)}; }
.sbh-crash-radio .sbh-radio-ch { font-size: ${hu(9.5)}; }
.sbh-crash-radio .sbh-radio-line { font-size: ${hu(12.5)}; }
.sbh-crash-gov { position: absolute; left: ${hu(50)}; bottom: ${hu(116)}; font-size: ${hu(11.5)}; }
.sbh-crash-bar { position: absolute; left: ${hu(50)}; bottom: ${hu(98)}; width: ${hu(340)}; height: ${hu(7)}; background: var(--dim); overflow: hidden; }
.sbh-crash-bar i { position: absolute; inset: 0; background: var(--orange); transform-origin: left; }
.sbh-crash-skip { position: absolute; left: ${hu(404)}; bottom: ${hu(97)}; font-size: ${hu(9.5)}; color: var(--mute); }
.sbh-crash-pos { position: absolute; right: ${hu(48)}; bottom: ${hu(90)}; font-size: ${hu(42)}; display: flex; align-items: center; gap: ${hu(11)}; }
.sbh-crash-pos svg { width: ${hu(28)}; height: ${hu(20)}; }
.sbh-crash-pos svg path { fill: var(--orange); }
.sbh-crash-pos.is-same svg, .sbh-crash-pos.is-same .to { display: none; }

/* finish call */
.sbh-finish { position: absolute; left: 0; right: 0; top: ${hu(130)}; text-align: center; opacity: 0; transition: opacity 0.3s; }
.sbh.is-finished .sbh-finish { opacity: 1; }
.sbh-finish-t { font-size: ${hu(96)}; display: block; }
.sbh-finish-l { font-size: ${hu(15)}; display: block; margin-top: ${hu(8)}; }
`;

const SCREENS = /* css */ `
.sbs { position: fixed; inset: 0; z-index: 40; pointer-events: auto; overflow: hidden; --plane: rgba(21, 27, 28, 0.82); }
.sbs[hidden] { display: none; }
.sbs-dim { position: absolute; inset: 0; background: rgba(8, 18, 19, var(--dim-a, 0.8)); backdrop-filter: blur(calc(8 * var(--u))) saturate(0.8); }
.sbs-frame { position: absolute; left: 50%; top: 50%; width: calc(1280 * var(--u)); height: calc(720 * var(--u)); transform: translate(-50%, -50%); }
.sbs-frame > * { position: absolute; }
.sbs-h1 { font-size: ${u(76)}; }
.sbs-sub { font-size: ${u(13)}; color: var(--mute); }
.sbs button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; text-align: left; outline: none; }

/* menu rows */
.sbs-item { position: relative; display: flex; align-items: center; width: 100%; height: ${u(48)}; padding: 0 ${u(18)}; font-size: ${u(22)}; color: var(--ink);
  --clip: ${u(14)}; clip-path: polygon(0 0, calc(100% - var(--clip)) 0, 100% var(--clip), 100% 100%, 0 100%); transition: background-color 0.12s, color 0.12s; }
.sbs-item .val { margin-left: auto; font-size: ${u(14)}; color: var(--mute); display: flex; align-items: center; gap: ${u(10)}; }
.sbs-item .val.sb-amber { color: var(--amber); }
.sbs-item .val svg { width: ${u(8)}; height: ${u(12)}; opacity: 0; }
.sbs-item .val svg path { fill: currentColor; }
.sbs-item.is-muted { color: var(--mute); }
.sbs-item:disabled { color: rgba(159, 178, 176, 0.45); cursor: default; }
.sbs-item.is-focus { background: var(--orange); color: var(--black-ink); }
.sbs-item.is-focus .val, .sbs-item.is-focus .val.sb-amber { color: var(--black-ink); }
.sbs-item.is-focus .val svg { opacity: 1; }
.sbs-item.is-open { box-shadow: inset ${u(5)} 0 0 var(--orange); color: var(--ink); }
.sbs-item:focus-visible { box-shadow: inset 0 0 0 ${u(2)} var(--ink); }

/* pause */
.sbs-pause .sbs-dim { --dim-a: 0.74; }
.sbs-menu { left: ${u(48)}; top: ${u(196)}; width: ${u(386)}; display: flex; flex-direction: column; gap: ${u(8)}; }
.sbs-side { left: ${u(690)}; top: ${u(196)}; width: ${u(534)}; height: ${u(444)}; padding: ${u(24)} ${u(24)}; --clip: ${u(16)}; }
.sbs-side h2 { font-size: ${u(13)}; display: flex; justify-content: space-between; align-items: baseline; padding-bottom: ${u(12)}; border-bottom: 1px solid var(--dim); }
.sbs-side h2 span { font-size: ${u(11)}; color: var(--mute); }
.sbs-keys { display: grid; grid-template-columns: 1fr ${u(170)} ${u(150)}; row-gap: ${u(12)}; margin-top: ${u(16)}; font-size: ${u(15)}; font-weight: 600; }
.sbs-keys .k { font-family: var(--stencil); font-weight: 400; font-size: ${u(14)}; letter-spacing: 0.04em; text-transform: uppercase; }
.sbs-keys .k:nth-child(3n) { text-align: right; }
.sbs-cond { position: absolute; left: ${u(24)}; right: ${u(24)}; bottom: ${u(18)}; padding-top: ${u(14)}; border-top: 1px solid var(--dim); }
.sbs-cond .sbs-sub { font-size: ${u(11)}; }
.sbs-cond div + div { margin-top: ${u(8)}; font-size: ${u(12)}; }
.sbs-dials { margin-top: ${u(10)}; display: flex; flex-direction: column; gap: ${u(4)}; }
.sbs-dials .sbs-item { font-size: ${u(17)}; height: ${u(42)}; }
.sbs-meter { display: flex; gap: ${u(3)}; }
.sbs-meter i { width: ${u(6)}; height: ${u(14)}; background: var(--dim); }
.sbs-meter i.is-on { background: var(--amber); }
.sbs-item.is-focus .sbs-meter i { background: rgba(11, 21, 22, 0.25); }
.sbs-item.is-focus .sbs-meter i.is-on { background: var(--black-ink); }
.sbs-hint { position: absolute; left: ${u(48)}; bottom: ${u(40)}; font-size: ${u(11)}; color: var(--mute); display: flex; gap: ${u(22)}; }
.sbs-hint b { font-family: var(--stencil); font-weight: 400; color: var(--ink); margin-right: ${u(6)}; letter-spacing: 0.04em; }

/* results */
.sbs-results .sbs-dim { --dim-a: 0.82; }
.sbs-table { left: ${u(52)}; top: ${u(160)}; width: ${u(790)}; }
.sbs-tr { position: relative; display: grid; align-items: center; height: ${u(48)}; padding: 0 ${u(12)}; font-size: ${u(16)};
  border-bottom: 1px solid rgba(242, 244, 239, 0.12); }
.sbs-tr.is-head { height: ${u(28)}; font-size: ${u(11)}; color: var(--mute); border-bottom: 2px solid var(--ink); }
.sbs-tr.is-you { background: var(--orange); color: var(--black-ink); border-bottom-color: transparent; --clip: ${u(12)}; clip-path: polygon(0 0, calc(100% - var(--clip)) 0, 100% var(--clip), 100% 100%, 0 100%); }
.sbs-tr .r { text-align: right; }
.sbs-tr .pos { font-family: var(--stencil); font-weight: 400; font-size: ${u(20)}; }
.sbs-tr .num { font-family: var(--stencil); font-weight: 400; font-variant-numeric: tabular-nums; font-size: ${u(15)}; }
.sbs-tr .lapc { font-size: ${u(12)}; color: var(--mute); }
.sbs-tr.is-you .lapc, .sbs-tr.is-you .sb-mute, .sbs-tr.is-you .pilot { color: rgba(11, 21, 22, 0.72); }
.sbs-tr .pilot { font-size: ${u(15)}; color: var(--mute); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sbs-tr .fast::before { content: ""; display: inline-block; width: ${u(7)}; height: ${u(7)}; border-radius: 50%; background: var(--amber); margin-right: ${u(6)}; vertical-align: ${u(2)}; }
.sbs-tr.is-you .fast::before { background: var(--black-ink); }
.sbs-note { left: ${u(64)}; top: ${u(586)}; font-size: ${u(11)}; color: var(--mute); }
.sbs-note::before { content: ""; display: inline-block; width: ${u(7)}; height: ${u(7)}; border-radius: 50%; background: var(--amber); margin-right: ${u(6)}; vertical-align: ${u(1)}; }
.sbs-stats { left: ${u(880)}; top: ${u(126)}; width: ${u(344)}; }
.sbs-stats h2 { font-size: ${u(13)}; padding-bottom: ${u(10)}; border-bottom: ${u(5)} solid var(--orange); }
.sbs-stat { display: flex; align-items: baseline; justify-content: space-between; height: ${u(44)}; padding-top: ${u(14)}; }
.sbs-stat .sb-label { font-size: ${u(11)}; color: var(--mute); }
.sbs-stat .sb-stencil { font-size: ${u(24)}; }
.sbs-broadcast { left: ${u(880)}; top: ${u(492)}; width: ${u(344)}; min-height: ${u(88)}; padding: ${u(14)} ${u(14)}; --clip: 0px; background: rgba(21,27,28,.9); }
.sbs-broadcast p { font-size: ${u(15)}; margin-top: ${u(8)}; line-height: 1.35; }
.sbs-actions { left: ${u(68)}; top: ${u(626)}; display: flex; gap: ${u(22)}; }
.sbs-btn { position: relative; height: ${u(48)}; padding: 0 ${u(30)}; font-size: ${u(16)}; display: flex; align-items: center; justify-content: center; min-width: ${u(130)};
  --clip: ${u(14)}; clip-path: polygon(0 0, calc(100% - var(--clip)) 0, 100% var(--clip), 100% 100%, 0 100%); box-shadow: inset 0 0 0 ${u(2)} rgba(242,244,239,.55); transition: background-color .12s, color .12s; }
.sbs-btn.is-primary { min-width: ${u(262)}; box-shadow: inset 0 0 0 ${u(2)} var(--orange); color: var(--orange); }
.sbs-btn.is-focus { background: var(--orange); color: var(--black-ink); box-shadow: none; }
.sbs-btn:disabled { opacity: 0.4; cursor: default; }

/* boat select */
.sbs-select .sbs-dim { --dim-a: 0.55; }
.sbs-select .sbs-rail { position: absolute; right: 0; top: 0; bottom: 0; width: calc(50% - 140 * var(--u)); background: rgba(8, 18, 19, 0.6); }
.sbs-hull-l { left: ${u(64)}; top: ${u(72)}; font-size: ${u(13)}; color: var(--mute); }
.sbs-hull-t { left: ${u(58)}; top: ${u(92)}; font-size: ${u(100)}; }
.sbs-hull-s { left: ${u(66)}; top: ${u(200)}; font-size: ${u(13)}; }
.sbs-preview { left: ${u(40)}; top: ${u(236)}; width: ${u(700)}; height: ${u(220)}; }
.sbs-preview > svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.sbs-preview.is-3d > svg { display: none; }
.sbs-preview-host { position: absolute; inset: 0; }
.sbs-spec { left: ${u(64)}; top: ${u(478)}; width: ${u(680)}; display: grid; grid-template-columns: ${u(260)} ${u(230)} ${u(190)}; row-gap: ${u(22)}; }
.sbs-spec .sb-label { font-size: ${u(11)}; color: var(--mute); }
.sbs-spec .sb-stencil { font-size: ${u(22)}; margin-top: ${u(8)}; white-space: nowrap; }
.sbs-pick { left: ${u(804)}; top: ${u(64)}; width: ${u(420)}; }
.sbs-pick-h { font-size: ${u(13)}; color: var(--mute); display: flex; justify-content: space-between; margin-bottom: ${u(14)}; }
.sbs-pick-h b { color: var(--ink); font-weight: 600; }
.sbs-paints { display: grid; grid-template-columns: repeat(2, ${u(200)}); gap: ${u(8)} ${u(16)}; }
.sbs-paint { position: relative; height: ${u(66)}; padding: ${u(4)} ${u(8)} ${u(6)}; display: flex; flex-direction: column; justify-content: space-between;
  --clip: ${u(12)}; clip-path: polygon(0 0, calc(100% - var(--clip)) 0, 100% var(--clip), 100% 100%, 0 100%); background: rgba(21, 27, 28, 0.5); }
.sbs-paint svg { width: 100%; height: ${u(40)}; }
.sbs-paint .sb-label { font-size: ${u(10)}; color: var(--mute); }
.sbs-paint.is-chosen::after { content: ""; position: absolute; inset: 0; box-shadow: inset 0 0 0 ${u(3)} var(--orange); }
.sbs-paint.is-chosen .sb-label { color: var(--ink); }
.sbs-paint.is-focus { background: rgba(255, 107, 31, 0.28); }
.sbs-paint.is-focus::after { content: ""; position: absolute; inset: 0; box-shadow: inset 0 0 0 ${u(3)} var(--ink); }
.sbs-paint.is-focus.is-chosen::after { box-shadow: inset 0 0 0 ${u(3)} var(--orange), inset 0 0 0 ${u(6)} var(--ink); }
.sbs-opts { margin-top: ${u(14)}; padding-top: ${u(6)}; border-top: 1px solid rgba(242,244,239,.15); display: flex; flex-direction: column; gap: ${u(2)}; }
.sbs-opts .sbs-item { height: ${u(35)}; font-size: ${u(11)}; color: var(--mute); }
.sbs-opts .sbs-item .val { font-size: ${u(16)}; color: var(--ink); }
.sbs-opts .sbs-item.is-focus, .sbs-opts .sbs-item.is-focus .val { color: var(--black-ink); }
.sbs-go { left: ${u(804)}; top: ${u(620)}; width: ${u(420)}; }
.sbs-go .sbs-btn { width: 100%; background: var(--orange); color: var(--black-ink); box-shadow: none; font-size: ${u(17)}; }
.sbs-go .sbs-btn.is-focus { background: var(--ink); }
`;

export const SPEEDBOAT_UI_CSS = FONT_FACE_CSS + TOKENS + HUD + SCREENS;

let injected = false;
export function injectSpeedboatUiCss(doc: Document = document): void {
  if (injected) return;
  injected = true;
  const style = doc.createElement('style');
  style.dataset.sb = 'speedboat-ui';
  style.textContent = SPEEDBOAT_UI_CSS;
  doc.head.appendChild(style);
}
