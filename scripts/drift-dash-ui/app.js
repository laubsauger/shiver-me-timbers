/**
 * THE STUDIO CONSOLE'S SCRIPT (served by scripts/drift-dash.mjs; the /api contract is the JSDoc block at the top of
 * that file). One screen: the fleet's tiles, the render queue (this Mac's slots, the farm's jobs, a box's own
 * drift-node run, all in one manager), the agents' work streams, what waits on the user, the newest outputs.
 *
 * LIGHT ON THE MACHINE (the user, 2026-10-29: "doesn't take enough resources"): plain JS, no framework, no build, no
 * CDN (it must work offline on the tailnet). GET /api every 3 s, GET /api/history every 15 s (the machines over the
 * last 30 min, this Mac's finished jobs), the log of an opened job row with each poll; none of it while the tab is
 * hidden. Each section is rendered to an HTML string and MORPHED into the page (morph() below): only the text and
 * attributes that changed are touched, rows are matched by data-key, so a thumbnail's <img> is never rebuilt, a
 * progress bar's width animates instead of jumping, and an opened row stays open.
 *
 * IN LINE (the user, 2026-10-30: "make sure that stuff is in line … everything is all over the place, depending on
 * which kind of stuff is available and which is not"): every fleet tile has the same seven rows in the same order —
 * head, metrics (GPU · Temp · Power · CPU · RAM), memory, others on the GPU, the last 30 min, our job, footer — laid on
 * one CSS subgrid, so a row sits at the same height in every tile, and a value a box does not report is "—", never a
 * missing cell. The queue's rows likewise: fixed columns per tab, "—" where there is nothing.
 *
 * A RENDER MANAGER (the user, 2026-10-30: "clearer about the queue, what is waiting, what is done, time, processing,
 * FPS … a studio hub that tries to gather render jobs"): tabs Queued · Running · Done · Failed with counts, a strip of
 * today's numbers, per job its id, name, submitter, type and settings, machine, times, waits, frames, fps now and on
 * average, s/frame, ETA, outputs and exit; running jobs with their fps over the last minutes and their newest log line.
 *
 * WORDS, NOT COMMANDS (the user, on the first page: "raw command lines as titles"): a job is named by humanJob(), e.g.
 * "Waterline clip 642–650 s · 1280 px"; the full command, its paths and its log are in the opened row.
 *
 * ?mock fakes the machines, slots, farm jobs and history (mock.js) to judge the design before the boxes report;
 * ?mock=yield a second set of states (syncing, waiting, offline). The work streams and outputs stay real.
 */

const POLL_MS = 3000;
/** ms between /api/history requests */
const HISTORY_MS = 15000;
/** ms without an answer before the header says the data is stale */
const STALE_MS = 9000;
/** finished jobs listed per tab (the newest) */
const FINISHED_MAX = 150;
/** a job the page was asked to show (the timeline's "Show in the queue"): listed even past FINISHED_MAX */
let SHOW_JOB = null;
const MOCK = new URLSearchParams(location.search).get('mock');
/** the viewer asked for less motion: no rolling numbers, no sliding, no breathing (app.css does the same for CSS) */
const CALM = matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * THE CONTROL ROOM'S LAYOUT (the user, 2026-10-30: "I want to have the screen on my ultrawide screen without having
 * to scroll, at least the relevant bits"): this script lays out <main> itself, so a page and its script always change
 * together (index.html keeps the header, the icons, the viewer). On a big screen (app.css: ≥ 1600 × 900 px) the
 * regions are a grid that fills the window — the long lists (the queue, the streams) scroll inside their own panels
 * and push nothing down; a smaller screen stacks them and scrolls.
 */
const SKELETON = `
<section class="p hero" id="hero" aria-label="The farm at a glance"></section>
<section class="p fleet" aria-labelledby="h-fleet"><div class="ph"><h2 id="h-fleet">Fleet</h2><span class="sec-meta" id="fleet-meta"></span></div><div id="fleet-note"></div><div class="tiles" id="tiles"></div></section>
<section class="p time" aria-labelledby="h-time"><div class="ph"><h2 id="h-time">The last hours</h2><span class="sec-meta" id="time-meta"></span><div class="tl-ctl" id="tl-ctl"></div></div><div class="agents" id="agents" role="group" aria-label="Agents: click to dim or show"></div><div class="tl" id="tl"></div></section>
<section class="side">
  <div class="p outs" aria-labelledby="h-outs"><div class="ph"><h2 id="h-outs">Latest outputs</h2><span class="sec-meta">click one to open it</span></div><div class="thumbs" id="outs"></div></div>
</section>
<section class="p jobs" aria-labelledby="h-jobs"><div class="ph"><h2 id="h-jobs">Render queue</h2><span class="sec-meta" id="jobs-meta"></span></div><div class="tabs" id="tabs" role="tablist" aria-label="Jobs by state"></div><div class="jt-wrap"><div class="jt" id="jobs" role="table" aria-labelledby="h-jobs"></div></div></section>
<section class="p streams" aria-labelledby="h-streams"><div class="you you-sec" aria-labelledby="h-you"><div class="ph"><h2 id="h-you">Waiting on you</h2><span class="you-n" id="you-n"></span></div><ul id="you"></ul></div><div class="ph"><h2 id="h-streams">Work streams</h2><span class="sec-meta" id="streams-meta"></span></div><div class="st-wrap" id="streams"></div></section>`;
{
  const main = document.querySelector('main');
  main.className = 'console';
  main.innerHTML = SKELETON;
  document.querySelector('body > svg')?.insertAdjacentHTML('beforeend', '<symbol id="i-bolt" viewBox="0 0 16 16"><path d="M9.4 1.4 3.4 9.1h4l-1.2 5.5 6.4-7.9H8.5z"/></symbol>');
}

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const DASH = '—';
/** seconds as "1 h 05 m", "47 m", "3 m 20 s", "42 s" (seconds only while they matter) */
const dur = (s) => {
  if (!fin(s)) return '';
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const x = s % 60;
  return h ? `${h} h ${String(m).padStart(2, '0')} m` : m >= 10 ? `${m} m` : m ? `${m} m ${String(x).padStart(2, '0')} s` : `${x} s`;
};
/** an age or a wait, coarser: "1 h 05 m", "6 m", "42 s" (seconds are noise once it is minutes) */
const durCoarse = (s) => (fin(s) && s >= 60 && s < 3600 ? `${Math.floor(s / 60)} m` : dur(s));
const clock = (ms, secs) => (fin(ms) ? new Date(ms).toLocaleTimeString([], secs ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' }) : '');
const stamp = (ms) => (fin(ms) ? new Date(ms).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
const toMs = (t) => (typeof t === 'number' ? t : t ? Date.parse(t) : NaN);
/** GB to one decimal, a whole number without its ".0" */
const gb = (x) => (fin(x) ? String(Math.round(x * 10) / 10) : DASH);
const num = (x, d = 0) => (fin(x) ? x.toLocaleString([], { maximumFractionDigits: d, minimumFractionDigits: d }) : DASH);
const pct = (part, whole) => (fin(part) && fin(whole) && whole > 0 ? Math.max(0, Math.min(100, (100 * part) / whole)) : 0);
const base = (p) => String(p ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';
const parent = (p) => base(String(p ?? '').replace(/[\\/][^\\/]*$/, ''));
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
/** inline `code` in work.json's free text */
const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
const fileUrl = (p, v) => `/file?p=${encodeURIComponent(p)}${v ? `&v=${Math.round(v)}` : ''}`;
const isMedia = (p) => /\.(png|jpe?g|webp|mp4)$/i.test(String(p ?? ''));
const isVideo = (p) => /\.mp4$/i.test(String(p ?? ''));
/** a value or the dash, escaped */
const or = (v) => (v == null || v === '' ? DASH : esc(v));

// ------------------------------------------------------------------------------------------------------ the states
/** every state's chip: [colour class, glyph, word, what it means] — the same hue wherever the state shows */
const STATES = {
  rendering: ['rendering', 'play', 'Rendering', 'our render runs here'],
  'rendering+shared': ['rendering', 'play', 'Rendering', 'our render, beside someone else’s load'],
  running: ['rendering', 'play', 'Rendering', 'running'],
  ready: ['ready', 'dot', 'Ready', 'free for a render'],
  idle: ['ready', 'dot', 'Ready', 'free for a render'],
  'busy-foreign': ['busy', 'diamond', 'Busy', 'someone else’s load is over what a render starts beside'],
  'waiting-foreign': ['yield', 'pause', 'Waiting', 'our job waits for someone else’s GPU use to end'],
  waiting: ['yield', 'pause', 'Waiting', 'waiting for someone else’s GPU use to end'],
  syncing: ['sync', 'sync', 'Syncing', 'pulling code and assets'],
  uploading: ['sync', 'sync', 'Uploading', 'sending its code and inputs to the hub'],
  preparing: ['sync', 'sync', 'Preparing', 'the box is getting its code and assets'],
  queued: ['queued', 'queue', 'Queued', 'in line'],
  done: ['done', 'check', 'Done', 'finished'],
  failed: ['failed', 'x', 'Failed', 'failed'],
  cancelled: ['done', 'x', 'Cancelled', 'cancelled'],
  offline: ['offline', 'off', 'Offline', 'not reporting'],
  coding: ['coding', 'pen', 'Coding', 'an agent is working on it'],
  blocked: ['blocked', 'block', 'Blocked', 'stuck: needs something'],
  review: ['you', 'ask', 'Needs you', 'waits for your review'],
};
const stateOf = (s) => STATES[s] ?? ['queued', 'dot', String(s ?? 'unknown'), String(s ?? '')];
const chip = (s, tip, big) => {
  const [cls, ic, word, means] = stateOf(s);
  return `<span class="chip s-${cls}${big ? ' big' : ''}" title="${esc(tip || means)}">${icon(ic)}${esc(word)}</span>`;
};

// ------------------------------------------------------------------------------------------------- job names
/** the topic of an output file: "waterline_642-650_1280.mp4" → "waterline", "tower_lamp_4kpx_745.8.png" → "tower lamp" */
function subject(p) {
  if (!p) return '';
  const words = base(p)
    .replace(/\.[a-z0-9]+$/i, '')
    .split(/[_\-\s.]+/)
    .filter((w) => w && !/^\d+(px|k|kpx|p|s|fps)?$/i.test(w) && !/^(clip|clips|stills?|shots?|review|out|frames?|final|test|\{\{out:\d+\}\}|\{\{in:\d+\}\})$/i.test(w));
  return words.join(' ');
}
const span = (a, b) => (a != null && b != null ? `${a}–${b} s` : '');
const joinDot = (...p) => p.filter(Boolean).join(' · ');
const words = (src) => (Array.isArray(src) ? src.map(String) : String(src ?? '').trim().split(/\s+/));
const flagOf = (src, k) => {
  const w = words(src);
  const i = w.indexOf(`--${k}`);
  if (i >= 0 && w[i + 1] != null) return w[i + 1];
  return w.find((x) => x.startsWith(`--${k}=`))?.slice(k.length + 3);
};

/**
 * a job in a few words, from its command (a string or an argv list), or the server's short label: what it makes, of
 * what, over which span and at what size. Never a path: those are in the row's details.
 */
function humanJob(src) {
  const s = (Array.isArray(src) ? src.join(' ') : String(src ?? '')).replace(/^\d{4}-\d\d-\d\dT\S+\s+/, '').trim(); // (a slot log's first line: its timestamp, then the command)
  // (the server's label of an unknown command is its first three words: after the timestamp only "node" may be left)
  if (!s || /^(node|python3?|bash|sh|npx|npm)$/.test(s)) return 'A script (its command was not recorded)';
  const f = (k) => flagOf(s, k);
  const px = (w) => (w && w !== '?' ? `${w} px` : '');
  let m;
  // the server's own labels, when that is all a row carries
  if ((m = s.match(/^review clip (\S+?)–(\S+?) s, (\S+) px(?:\s+→\s+(\S+))?/))) return joinDot(`${cap(subject(m[4]) || 'review')} clip ${span(m[1], m[2])}`, px(m[3]));
  if ((m = s.match(/^review stills \(?([^)\s]+)\)?(?:\s+→\s+(\S+))?/))) return `${cap(subject(m[1]) || subject(m[2]) || 'review')} stills`;
  if ((m = s.match(/^render (\S*?)–(\S*?) s (\S*)(?:\s+→\s+(\S+))?/))) return joinDot(`${cap(subject(m[4]) || 'film')} render ${span(m[1], m[2])}`, px(m[3]));
  // commands
  if (s.includes('drift-review-clip')) return joinDot(`${cap(subject(f('out')) || 'review')} clip ${span(f('from'), f('to'))}`, px(f('width')));
  if (s.includes('drift-review-stills')) {
    const w = s.split(/\s+/);
    const args = w.slice(w.findIndex((x) => x.includes('drift-review-stills')) + 1);
    const shots = args.find((x) => /\.json$/.test(x));
    return joinDot(`${cap(subject(shots) || subject(f('out')) || 'review')} stills`, px(f('width') ?? args.find((x) => /^\d{3,5}$/.test(x))));
  }
  if (s.includes('drift-render')) return joinDot(`${cap(subject(f('out')) || 'film')} render ${span(f('from'), f('to'))}`, px(f('size')));
  if (s.includes('drift-gpu-check')) return 'GPU check';
  if (s.includes('drift-stills')) return joinDot(`${cap(subject(f('out')) || 'film')} stills`, px(f('width')));
  // any other script: its folder and name, and its first argument's file name
  if ((m = s.match(/(?:^|\s)(\S+\.(?:mjs|cjs|js|ts|py))(?:\s+(\S+))?/))) {
    const name = base(m[1]).replace(/\.\w+$/, '');
    const dir = parent(m[1]);
    const arg = m[2] && !m[2].startsWith('-') ? base(m[2]) : '';
    return joinDot(`${cap(dir && !/^(scripts|scratchpad|\.)$/.test(dir) ? `${dir} ${name}` : name)} script`, arg);
  }
  return cap(s.split(/\s+/).slice(0, 4).map(base).join(' '));
}

/** what kind of job a command is: still, clip, or a long render (a master chunk when it is 2048 px and up) */
function kindOf(src, given) {
  const s = Array.isArray(src) ? src.join(' ') : String(src ?? '');
  const k = given ?? (/drift-(review-)?stills/.test(s) ? 'still' : /drift-(render|queue|node)\.mjs/.test(s) ? 'long' : /drift-review-clip/.test(s) ? 'clip' : 'other');
  const size = Number(flagOf(s, 'size') ?? flagOf(s, 'width'));
  const word = k === 'still' ? 'Stills' : k === 'clip' ? 'Clip' : k === 'long' ? (size >= 2048 ? 'Master chunk' : 'Long render') : 'Script';
  return { kind: k, word };
}

/** a job's key settings, short: size, frames, supersampling, codec, quality, lanes */
function settingsOf(src, info, total, unit) {
  const f = (k) => flagOf(src, k);
  const out = [];
  const w = (info?.width ?? Number(f('width') ?? f('size'))) || null;
  if (info?.width && info?.height) out.push(`${info.width}×${info.height}`);
  else if (w) out.push(`${w} px`);
  if (f('dome') !== undefined || words(src).includes('--dome')) out.push('dome');
  const frames = info?.frames ?? (unit === 'frames' ? total : null);
  if (fin(frames)) out.push(`${frames} f`);
  else if (unit === 'stills' && fin(total)) out.push(`${total} stills`);
  const ss = (info?.ss ?? Number(f('ss'))) || null;
  if (fin(ss) && ss) out.push(`ss ${Math.round(ss * 10) / 10}`);
  if (f('codec')) out.push(f('codec'));
  if (f('crf')) out.push(`crf ${f('crf')}`);
  if (f('lanes')) out.push(`${f('lanes')} lanes`);
  return out;
}

/**
 * who sent a job: the agent its client names (drift-farm-client's `submitter`), else the scratchpad folder its output
 * goes to — each agent works in its own ("sim4", "sky"): { who, guessed }
 */
function submitterOf(sub, src) {
  if (typeof sub === 'string' && sub) return { who: sub, guessed: false };
  const named = sub?.agent ?? sub?.name ?? sub?.session;
  if (named) return { who: String(named), guessed: false };
  const out = flagOf(src, 'out');
  const m = out && String(out).match(/scratchpad[\\/]([^\\/]+)[\\/]/);
  if (m) return { who: m[1], guessed: true };
  if (out && /out[\\/]drift[\\/]review/.test(out)) return { who: 'review', guessed: true };
  return { who: null, guessed: true };
}

/** a machine's name and its tag: "Mac · this Mac" → Mac, this Mac */
const splitName = (n) => {
  const [name, ...rest] = String(n ?? '?').split(' · ');
  return { name, tag: rest.join(' · ') };
};
/** "NVIDIA GeForce RTX 4090" → "RTX 4090", "Apple M3 Max" → "M3 Max" */
const gpuShort = (n) => String(n ?? '').replace(/^NVIDIA\s+(GeForce\s+)?/i, '').replace(/^Apple\s+/, '').replace(/\s+GPU$/, '').replace(/,.*$/, '');
const osName = (o) => ({ linux: 'Linux', windows: 'Windows', win32: 'Windows', macOS: 'macOS', darwin: 'macOS' })[o] ?? o;

// ------------------------------------------------------------------------------------------------- DOM morphing
/** make el's children match the HTML, touching only what differs (rows matched by data-key) */
function morph(el, html) {
  const t = document.createElement('template');
  t.innerHTML = html;
  patchChildren(el, t.content);
}
function patchChildren(parentEl, next) {
  const want = [...next.childNodes];
  const keyed = want.length > 0 && want.every((n) => n.nodeType === 1 && n.dataset.key != null);
  if (keyed) {
    const have = new Map();
    for (const c of [...parentEl.childNodes]) {
      if (c.nodeType === 1 && c.dataset.key != null && !have.has(c.dataset.key)) have.set(c.dataset.key, c);
      else c.remove();
    }
    let ref = parentEl.firstChild;
    for (const n of want) {
      let cur = have.get(n.dataset.key);
      if (cur) {
        have.delete(n.dataset.key);
        patchNode(cur, n);
      } else cur = n;
      if (cur === ref) ref = ref.nextSibling;
      else parentEl.insertBefore(cur, ref);
    }
    for (const c of have.values()) c.remove();
    return;
  }
  const have = [...parentEl.childNodes];
  want.forEach((n, i) => (have[i] ? patchNode(have[i], n) : parentEl.appendChild(n)));
  for (let i = want.length; i < have.length; i++) have[i].remove();
}
function patchNode(cur, n) {
  if (cur.nodeType !== n.nodeType || cur.nodeName !== n.nodeName) {
    cur.replaceWith(n);
    return;
  }
  if (cur.nodeType !== 1) {
    if (cur.nodeValue !== n.nodeValue) cur.nodeValue = n.nodeValue;
    return;
  }
  // (an element the page manages itself, data-own: its data attributes follow the HTML, its own classes stay)
  const own = cur.hasAttribute('data-own');
  for (const a of [...cur.attributes]) if (!n.hasAttribute(a.name) && !(own && a.name === 'class')) cur.removeAttribute(a.name);
  for (const a of n.attributes) if (cur.getAttribute(a.name) !== a.value && !(own && a.name === 'class')) cur.setAttribute(a.name, a.value);
  // (a thumbnail's media: same src, same element — never reloaded)
  if (cur.nodeName === 'IMG' || cur.nodeName === 'VIDEO' || cur.hasAttribute('data-own')) return;
  patchChildren(cur, n);
}

/** rows the user opened, by key (kept across polls) */
const OPEN = new Set();
/** the queue's tab the user chose (kept in this browser), or null: the busiest */
let TAB = null;
try {
  TAB = localStorage.getItem('drift-console-tab');
} catch {
  // (a private window: the default)
}

// ------------------------------------------------------------------------------------------------- small charts
/**
 * a sparkline of fps over the last minutes: one line, its newest point marked. Single series, so no legend: the
 * column says what it is, the title has the numbers.
 */
function sparkline(values, tip) {
  const v = values.filter(fin);
  if (v.length < 2) return `<span class="spark none" title="${esc(tip ?? 'not enough samples yet')}"></span>`;
  const W = 64;
  const H = 18;
  const hi = Math.max(...v);
  const lo = Math.min(...v);
  const range = Math.max(hi - lo, hi * 0.1, 1e-6);
  const mid = (hi + lo) / 2;
  const pts = v.map((y, i) => `${((i / (v.length - 1)) * (W - 3) + 1.5).toFixed(1)},${(H / 2 - ((y - mid) / range) * (H - 5)).toFixed(1)}`);
  const [lx, ly] = pts.at(-1).split(',');
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(tip ?? '')}"><title>${esc(tip ?? '')}</title><polyline points="${pts.join(' ')}"/><circle cx="${lx}" cy="${ly}" r="2"/></svg>`;
}

/**
 * a machine's last 30 min (History.util): one bar per sample, its height the GPU use, its colour whose load it was —
 * ours (teal: our job rendering there), someone else's (amber), nobody's to speak of (grey) — and a gap where the box
 * was offline. The bar's title has the numbers. So a box that sat idle shows as a flat grey floor.
 */
function utilStrip(samples, stepS) {
  const N = Math.round(1800 / (stepS || 15));
  const s = (samples ?? []).slice(-N);
  const W = 240;
  const H = 26;
  const bw = W / N;
  let bars = '';
  let idle = 0;
  let online = 0;
  s.forEach(([t, u, ours, others, badge], i) => {
    const x = (N - s.length + i) * bw;
    if (badge === 'offline' || !fin(u)) return;
    online += 1;
    const who = /^rendering|^syncing|^waiting/.test(badge) && badge !== 'waiting-foreign' ? 'ours' : badge === 'busy-foreign' || badge === 'waiting-foreign' || (u >= 10 && (others ?? 0) > 1) ? 'foreign' : 'idle';
    if (who === 'idle' && u < 10) idle += 1;
    const h = Math.max(1.5, (u / 100) * (H - 2));
    bars += `<rect class="${who}" x="${(x + 0.4).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${Math.max(0.6, bw - 0.8).toFixed(2)}" height="${h.toFixed(1)}"><title>${clock(t)}  GPU ${u}%${fin(ours) ? `, ours ${gb(ours)} GB` : ''}${fin(others) ? `, others ${gb(others)} GB` : ''} (${badge})</title></rect>`;
  });
  const idlePct = online ? Math.round((100 * idle) / online) : null;
  const svg = `<svg class="ustrip" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="GPU use over the last 30 minutes">${bars}<line x1="0" x2="${W}" y1="${H - 0.5}" y2="${H - 0.5}"/></svg>`;
  return { svg, idlePct, minutes: Math.round((s.length * (stepS || 15)) / 60) };
}

// ---------------------------------------------------------------------------------------------------- the fleet
function machinesOf(d) {
  if (Array.isArray(d.machines)) return d.machines;
  return d.fleet?.cards ?? []; // (a server from before machines[])
}

/** one metrics cell: label, value (or the dash), a meter slot (empty when the value has none) */
// (the number sits in a box three figures wide, right-aligned, so "97" → "100" moves neither it nor its unit)
const cell = (k, v, unit, meterPct, hot, tip, small) =>
  `<div class="g${hot ? ' hot' : ''}${v == null ? ' nil' : ''}"${tip ? ` title="${esc(tip)}"` : ''}><span class="g-k">${esc(k)}</span><span class="g-v"><span class="v">${v == null ? DASH : v}</span>${small && v != null ? `<small class="lim">${small}${unit ?? ''}</small>` : ''}<small class="u">${v == null ? '' : unit ?? ''}</small></span><span class="meter${meterPct == null ? ' empty' : ''}"><b style="transform:scaleX(${((meterPct ?? 0) / 100).toFixed(4)})"></b></span></div>`;

/** the Mac's busiest processes, one entry per name ("Loom MCP server ×3, 128 % CPU") */
function macProcs(top) {
  const by = new Map();
  for (const p of top ?? []) {
    const e = by.get(p.name) ?? { name: p.name, n: 0, cpu: 0, memMB: 0 };
    e.n += 1;
    e.cpu += p.cpu;
    e.memMB += p.memMB;
    by.set(p.name, e);
  }
  return [...by.values()].sort((a, b) => b.cpu - a.cpu);
}

/**
 * STABLE LISTS (the user, 2026-10-30: "the busiest processes are jumping around, causing layout shifts … the lists
 * are lists"): a tile's "others" list ranks by a moving average over ~RANK_TAU_S, and two rows swap — or a newcomer
 * takes the weakest row — only when one leads the other by RANK_LEAD× plus a margin: a lasting, clear change, not a
 * 3 s flicker. A row that drops out of the server's list (ps reports only the top six) stays while its average decays,
 * so a process hovering at sixth place does not blink in and out. One pass per poll: a row moves one place at most.
 */
const RANK_TAU_S = 30;
const RANK_LEAD = 1.3;
const RANKS = new Map();
function stableTop(key, items, n, margin, floor, now) {
  let s = RANKS.get(key);
  const first = !s;
  if (!s) RANKS.set(key, (s = { order: [], ema: new Map(), seen: new Map(), t: now }));
  const a = first ? 1 : 1 - Math.exp(-Math.max(0, now - s.t) / 1000 / RANK_TAU_S);
  s.t = now;
  const present = new Map(items.map((x) => [x.id, x]));
  for (const [id, x] of present) {
    const p = s.ema.get(id);
    s.ema.set(id, p == null ? x.v : p + a * (x.v - p));
    s.seen.set(id, x);
  }
  for (const [id, p] of s.ema) {
    if (present.has(id)) continue;
    const v = p * (1 - a);
    if (v < floor) {
      s.ema.delete(id);
      s.seen.delete(id);
    } else s.ema.set(id, v);
  }
  const e = (id) => s.ema.get(id) ?? 0;
  const beats = (x, y) => e(x) > e(y) * RANK_LEAD + margin;
  s.order = s.order.filter((id) => s.ema.has(id));
  for (const c of [...s.ema.keys()].filter((id) => !s.order.includes(id)).sort((x, y) => e(y) - e(x))) {
    if (s.order.length < n) s.order.push(c);
    else {
      const weakest = s.order.reduce((w, id) => (e(id) < e(w) ? id : w), s.order[0]);
      if (beats(c, weakest)) s.order[s.order.indexOf(weakest)] = c;
    }
  }
  for (let i = 1; i < s.order.length; i++) if (beats(s.order[i], s.order[i - 1])) [s.order[i - 1], s.order[i]] = [s.order[i], s.order[i - 1]];
  return { rows: s.order.map((id) => ({ ...s.seen.get(id), avg: e(id), live: present.has(id) })), total: s.ema.size };
}

/**
 * the fixed "others" list of a tile: a heading line and OTHERS_ROWS rows, always (empty ones padded), each a name and
 * two numbers in fixed columns. The last row counts what did not fit.
 */
const OTHERS_ROWS = 4;
function othersList(title, cols, rows, total, tip) {
  const shown = total > OTHERS_ROWS ? rows.slice(0, OTHERS_ROWS - 1) : rows.slice(0, OTHERS_ROWS);
  let body = shown.map((r) => `<div class="ol${r.live === false ? ' fading' : ''}"><span class="one" title="${esc(r.tip ?? r.name)}">${esc(r.name)}</span><span>${r.a ?? DASH}</span><span>${r.b ?? DASH}</span></div>`).join('');
  if (total > OTHERS_ROWS) body += `<div class="ol more" title="${esc(tip)}"><span class="one">+${total - shown.length} more</span><span></span><span></span></div>`;
  for (let i = Math.max(shown.length + (total > OTHERS_ROWS ? 1 : 0), shown.length === 0 ? 1 : 0); i < OTHERS_ROWS; i++) body += '<div class="ol pad"><span></span><span></span><span></span></div>';
  if (shown.length === 0) body = `<div class="ol none"><span class="one">none</span><span></span><span></span></div>${body}`;
  return `<div class="r-oth" title="${esc(tip)}"><div class="ol oh"><span class="one">${esc(title)}</span><span>${esc(cols[0])}</span><span>${esc(cols[1])}</span></div>${body}</div>`;
}

/**
 * one machine's tile: SEVEN ROWS, ALWAYS, in this order — the subgrid lines them up across the fleet (the user,
 * 2026-10-30: "make sure that stuff is in line")
 */
function tile(m, d) {
  const now = d.now;
  const [cls] = stateOf(m.badge);
  const { name, tag } = splitName(m.name);
  const g = m.gpu ?? {};
  const self = m.self === true;
  const mc = self ? d.machine ?? {} : null;
  const sub = [gpuShort(g.name || m.hint?.gpu), osName(m.os), m.tailnet].filter(Boolean);
  const subTip = [g.name || m.hint?.gpu, osName(m.os), m.tailnet && `tailnet ${m.tailnet}`, m.hint?.speed && `renders at ${m.hint.speed}× a 4090`, m.hint?.battery && 'a laptop: renders on AC power only'].filter(Boolean).join(', ');
  const badgeTip = [stateOf(m.badge)[3], m.why, m.waiting?.why].filter(Boolean).join(': ');
  const on = m.online;
  let h = `<article class="tile s-${cls}${on ? '' : ' off'}" data-key="${esc(m.key)}">`;

  // 1. head
  h += `<header class="r-head"><div class="t-name"><h3 title="${esc(m.name)}"><i class="live-dot${/^rendering/.test(m.badge) ? ' on' : ''}" aria-hidden="true"></i>${esc(name)}${self ? '<span class="tag">this Mac</span>' : tag ? `<span class="tag">${esc(tag)}</span>` : ''}</h3>`;
  h += `<div class="t-sub" title="${esc(subTip)}">${sub.map(esc).join('<span class="sep">·</span>')}</div></div><div class="t-chips">${chip(m.badge, badgeTip, true)}${self ? '' : farmChip(m)}</div></header>`;

  // 2. metrics: GPU · Temp · Power · CPU · RAM, in every tile (the Mac reports no temperature; its power is AC/battery)
  const load = mc?.load?.[0];
  const cpu = fin(m.cpuPct) ? m.cpuPct : self && fin(load) && mc.cores ? (100 * load) / mc.cores : null;
  const ram = fin(m.ramPct) ? m.ramPct : self && fin(mc.memFreePct) ? 100 - mc.memFreePct : null;
  const u = on && fin(g.utilPct) ? g.utilPct : null;
  let met = cell('GPU', u == null ? null : Math.round(u), '%', u, false);
  met += cell('Temp', on && fin(g.tempC) ? Math.round(g.tempC) : null, ' °<span class="c">C</span>', null, g.tempC >= 83, self ? 'macOS does not report the GPU temperature without root' : '');
  if (self) met += cell('Power', mc.power ? esc(mc.power.startsWith('battery') ? mc.power.replace(/^battery /, '') : 'AC') : null, mc.power?.startsWith('battery') ? ' batt' : '', null, mc.power?.startsWith('battery'), mc.power ? `power: ${mc.power}` : '');
  else met += cell('Power', on && fin(g.powerW) ? Math.round(g.powerW) : null, ' W', on && fin(g.powerW) && fin(g.powerLimitW) ? pct(g.powerW, g.powerLimitW) : null, false, fin(g.powerLimitW) ? `power limit ${Math.round(g.powerLimitW)} W` : '', fin(g.powerLimitW) ? ` / ${Math.round(g.powerLimitW)}` : '');
  met += cell('CPU', on && fin(cpu) ? Math.round(cpu) : null, '%', on && fin(cpu) ? Math.min(100, cpu) : null, cpu > 100 || cpu >= 95, self && fin(load) ? `load ${load} on ${mc.cores} cores (5 min ${mc.load?.[1]}, 15 min ${mc.load?.[2]})` : '');
  met += cell('RAM', on && fin(ram) ? Math.round(ram) : null, '%', on && fin(ram) ? ram : null, ram >= 90, [fin(m.ramTotalGB) ? `${m.ramTotalGB} GB` : '', self && fin(mc.memFreePct) ? `memory free ${mc.memFreePct}% (memory_pressure)` : ''].filter(Boolean).join(', '));
  h += `<div class="r-met">${met}</div>`;

  // 3. memory: VRAM ours | others | free; this Mac's unified memory, GPU | the rest | free, and its pressure
  if (self) {
    const total = mc.ramTotalGB ?? m.ramTotalGB;
    const gpuGB = fin(g.usedGB) ? g.usedGB : null;
    const usedGB = fin(total) && fin(ram) ? (ram / 100) * total : null;
    const restGB = fin(usedGB) ? Math.max(0, usedGB - (gpuGB ?? 0)) : null;
    const pressure = fin(mc.memFreePct) && mc.memFreePct < 15;
    h += `<div class="r-mem"><div class="vk"><span class="g-k">Memory, unified${pressure ? ` <b class="warn">${icon('warn')}pressure: ${mc.memFreePct}% free</b>` : ''}</span><span class="g-v">${fin(usedGB) ? gb(usedGB) : DASH}<small> / ${fin(total) ? gb(total) : DASH} GB</small></span></div>`;
    h += `<div class="vbar"><b class="unified" style="width:${pct(gpuGB, total).toFixed(1)}%"></b><b class="rest" style="width:${pct(restGB, total).toFixed(1)}%"></b></div>`;
    h += `<div class="legend"><span><i class="unified"></i>GPU <b>${gb(gpuGB)}</b></span><span><i class="rest"></i>other <b>${gb(restGB)}</b></span><span><i></i>free <b>${fin(usedGB) ? gb(total - usedGB) : DASH}</b></span></div></div>`;
  } else {
    const has = on && fin(g.totalGB) && g.totalGB > 0 && fin(g.usedGB);
    const ours = has ? (fin(g.oursGB) ? g.oursGB : 0) : null;
    const others = has ? (fin(g.othersGB) ? g.othersGB : Math.max(0, g.usedGB - ours)) : null;
    const free = has ? Math.max(0, g.totalGB - ours - others) : null;
    h += `<div class="r-mem"><div class="vk"><span class="g-k">VRAM</span><span class="g-v">${has ? gb(g.usedGB) : DASH}<small> / ${fin(g.totalGB) ? gb(g.totalGB) : DASH} GB</small></span></div>`;
    h += `<div class="vbar" role="img" aria-label="VRAM: ours ${gb(ours)} GB, others ${gb(others)} GB, free ${gb(free)} GB"><b class="ours" style="width:${pct(ours, g.totalGB).toFixed(1)}%"></b><b class="foreign" style="width:${pct(others, g.totalGB).toFixed(1)}%"></b></div>`;
    h += `<div class="legend"><span><i class="ours"></i>ours <b>${gb(ours)}</b></span><span><i class="foreign"></i>others <b>${gb(others)}</b></span><span><i></i>free <b>${gb(free)}</b></span></div></div>`;
  }

  // 4. others on the machine: a fixed list — this Mac's busiest processes (CPU, RAM), a box's services and whom we
  // yield to (VRAM, state), in a stable order (stableTop)
  if (self) {
    const procs = macProcs(mc.top).filter((p) => !/render\)$/.test(p.name)).map((p) => ({ id: p.name, v: p.cpu, name: `${p.name}${p.n > 1 ? ` ×${p.n}` : ''}`, memMB: p.memMB }));
    const { rows, total } = stableTop(`procs:${m.key}`, procs, OTHERS_ROWS, 8, 0.5, now);
    h += othersList('Busiest processes', ['CPU', 'RAM'], rows.map((r) => ({ ...r, a: `${Math.round(r.avg)}%`, b: r.memMB >= 1024 ? `${gb(r.memMB / 1024)} GB` : `${r.memMB} MB`, tip: `${r.name}: ${Math.round(r.avg)}% CPU (30 s average), ${r.memMB} MB` })), total,
      `this Mac’s busiest processes, by CPU averaged over ~30 s (our renders are left out)\n${procs.map((p) => `${p.name}: ${Math.round(p.v)}% CPU now`).join('\n')}`);
  } else {
    const why = [m.why, m.waiting?.why].filter(Boolean).join('; ');
    const svcs = (on ? m.services ?? [] : []).map((s) => ({ id: s.name, v: fin(s.vramGB) ? s.vramGB : 0, name: s.name, state: s.state, vramGB: s.vramGB }));
    for (const f of m.waiting?.foreign ?? []) if (!svcs.some((s) => s.id === f.name)) svcs.push({ id: f.name, v: f.memGB ?? 0, name: f.name, state: 'on the GPU', vramGB: f.memGB });
    const { rows, total } = stableTop(`svcs:${m.key}`, svcs, OTHERS_ROWS, 0.3, 0.01, now);
    h += othersList(m.badge === 'waiting-foreign' ? 'Yielding to' : 'Others on the box', ['VRAM', 'State'], rows.map((r) => ({ ...r, a: fin(r.vramGB) ? `${gb(r.vramGB)} GB` : DASH, b: r.state ?? DASH, tip: `${r.name}: ${r.state ?? ''}${fin(r.vramGB) ? `, ${gb(r.vramGB)} GB of VRAM` : ''}` })), total,
      [why, ...svcs.map((s) => `${s.name} (${s.state}${fin(s.vramGB) ? `, ${gb(s.vramGB)} GB` : ''})`)].filter(Boolean).join('\n') || (on ? 'nothing else running' : 'offline'));
  }

  // (5. the last 30 min: moved to the timeline, every machine on one time axis)

  // 6. our job there, over its newest frame (previewOf: the "now rendering" mosaic is the fleet's row of these)
  const pv = `<div class="pv" data-own="1" data-src="${esc(previewOf(m, d) ?? '')}" aria-hidden="true"></div>`;
  if (self) {
    const held = d.slots?.held ?? [];
    const lim = d.slots?.limit;
    const waiting = d.slots?.waiting?.length ?? 0;
    // (one job in full; a second slot's and the waiting ones in the reserved fourth line, so the row never grows)
    const s = held[0];
    const extra = [held.length > 1 ? `slot ${held[1].slot}: ${humanJob(held[1].cmd || held[1].label)}` : '', waiting ? `${waiting} waiting for a slot` : ''].filter(Boolean).join('; ');
    h += s
      ? `<div class="r-job">${pv}${tileJob({ name: humanJob(s.cmd || s.label), tip: s.cmd, done: s.done, total: s.total, unit: s.unit, rate: slotFps(s).now, etaS: s.etaS, label: `Slot ${s.slot}` }, extra)}</div>`
      : `<div class="r-job none">${pv}<span>No render of ours${fin(lim) ? `: ${lim} slot${lim > 1 ? 's' : ''} free` : ''}</span><span class="x one">${esc(extra)}</span></div>`;
  } else {
    const fj = m.farm;
    const j = m.job;
    if (fj) h += `<div class="r-job">${pv}${tileJob({ name: humanJob(fj.argv?.length ? fj.argv : fj.label), tip: fj.label, done: fj.progress?.done, total: fj.progress?.total, unit: fj.progress?.unit, rate: fin(fj.progress?.fps) && fj.progress.fps > 0 ? fj.progress.fps : null, etaS: fj.progress?.etaS, label: `Farm ${shortId(fj.id)}` })}</div>`;
    else if (j) h += `<div class="r-job">${pv}${tileJob({ name: cap(j.name), tip: j.out, done: j.frames, total: j.framesTotal, unit: 'frames', rate: fin(j.fps) && j.fps > 0 ? +j.fps : null, etaS: j.etaS, label: j.chunks ? `Chunk ${j.chunk} of ${j.chunks}` : 'Our job' })}</div>`;
    else h += `<div class="r-job none">${pv}<span>${on ? (m.badge === 'ready' ? 'Free: no job of ours' : 'No job of ours') : DASH}</span><span class="x"></span></div>`;
  }

  // 7. footer: where the numbers come from, when we last heard, our last run there
  const bits = [];
  bits.push(self ? 'this Mac’s own probes' : m.source === 'agent' ? 'its studio-manager agent' : m.source === 'hub' ? 'studio-manager’s hub' : m.seen ? 'our heartbeat' : 'no source');
  if (m.seen) bits.push(`heard ${durCoarse((now - m.seen) / 1000)} ago`);
  if (m.lastRun) bits.push(`last run ${m.lastRun.job ?? 'a job'} ${m.lastRun.state}${m.lastRun.seen ? ` ${durCoarse((now - m.lastRun.seen) / 1000)} ago` : ''}`);
  if (m.commit) bits.push(`at ${m.commit}`);
  const err = m.agentError ? `agent: ${m.agentError}` : m.error ? `error: ${m.error}` : '';
  h += `<footer class="r-foot">${self ? '' : farmControls(m)}<span class="src one${err ? ' err' : ''}" title="${esc([...bits, err].filter(Boolean).join(', '))}">${esc([err, ...bits].filter(Boolean).join(', '))}</span></footer>`;
  return h + '</article>';
}

/** one job in a tile: its name, a bar, frames · fps · time left in fixed columns, and a reserved fourth line */
function tileJob(j, extra = '') {
  const p = fin(j.total) && j.total > 0 ? pct(j.done ?? 0, j.total) : null;
  const count = fin(j.total) ? `${j.done ?? 0} / ${j.total} ${j.unit ?? ''}` : fin(j.done) && j.done > 0 ? `${j.done} ${j.unit ?? ''} done` : 'starting';
  return `<div class="tj-1"><span class="k one">${esc(j.label)}</span><span class="name one" title="${esc(j.tip ?? j.name)}">${esc(j.name)}</span></div>`
    + `<div class="pbar${p == null ? ' idle' : ''}"><b style="transform:scaleX(${((p ?? 0) / 100).toFixed(4)})"></b></div>`
    + `<div class="meta"><span class="one">${esc(count)}</span><span>${fin(j.rate) ? `${j.rate.toFixed(2)} fps` : DASH}</span><span class="eta">${fin(j.etaS) ? `${dur(j.etaS)} left` : DASH}</span></div>`
    + `<div class="x one" title="${esc(extra)}">${esc(extra)}</div>`;
}

function renderFleet(d) {
  const ms = machinesOf(d);
  morph($('tiles'), ms.length ? ms.map((m) => tile(m, d)).join('') : '<div class="note" data-key="none">No machines listed (scripts/drift-farm-nodes.json).</div>');
  const online = ms.filter((m) => m.online).length;
  const ready = ms.filter((m) => m.badge === 'ready' || m.badge === 'idle').length;
  const ours = ms.filter((m) => /^rendering/.test(m.badge)).length;
  $('fleet-meta').textContent = ms.length ? `${online} of ${ms.length} online, ${ready} ready, ${ours} rendering ours` : '';
  // (machines[]: the hub is only asked when a box's own agent does not answer; the older fleet{}: always)
  const hub = d.sources?.hub ?? d.fleet?.hub;
  const hubDown = d.sources ? hub?.used === true && hub.ok === false : hub?.ok === false;
  morph($('fleet-note'), hubDown
    ? `<div class="note">studio-manager’s hub isn’t answering at <code>${esc(hub.url)}</code>${hub.error ? ` (${esc(hub.error)})` : ''}: a box whose own agent is silent shows only our heartbeats. To start it: <code>cd ../studio-manager &amp;&amp; yarn studio</code></div>`
    : '');
}

// ------------------------------------------------------------------------------------------------ the queue's jobs
const shortId = (id) => String(id ?? '').split('-').pop().slice(0, 6);
const FINISHED = new Set(['done', 'failed', 'cancelled']);
const LANE_OF = { uploading: 'queued', queued: 'queued', preparing: 'running', syncing: 'running', running: 'running', waiting: 'running', done: 'done', cancelled: 'done', failed: 'failed' };

/** a clip's fps now and on average, from its progress lines' running averages (drift-review-clip prints got/elapsed) */
function slotFps(s) {
  const f = (s.fpsHistory ?? []).filter(fin);
  if (!f.length) return { now: null, avg: null, series: [] };
  // frames at each line: one line per 30 frames, the last at `done`; elapsed render time t = frames / running fps
  const L = f.length;
  const n = f.map((_, i) => (i === L - 1 ? s.done : Math.floor((s.done - 1) / 30) * 30 - 30 * (L - 2 - i)));
  const series = [];
  for (let i = 1; i < L; i++) {
    const dt = n[i] / f[i] - n[i - 1] / f[i - 1];
    if (dt > 0 && n[i] > n[i - 1]) series.push((n[i] - n[i - 1]) / dt);
  }
  return { now: series.at(-1) ?? f.at(-1), avg: f.at(-1), series: series.length ? series : f };
}

/** a farm job's fps now (the newest interval of its samples) and over its samples */
function farmFps(j) {
  const s = j.samples ?? [];
  const series = [];
  for (let i = 1; i < s.length; i++) {
    const [t0, , d0] = s[i - 1];
    const [t1, f1, d1] = s[i];
    series.push(fin(d0) && fin(d1) && t1 > t0 && d1 >= d0 ? (d1 - d0) / ((t1 - t0) / 1000) : f1);
  }
  return { now: series.at(-1) ?? (fin(j.progress?.fps) ? j.progress.fps : null), series: series.length ? series : s.map((x) => x[1]) };
}

/**
 * every job, one shape: this Mac's slots (held, waiting, finished — the slot logs and history.jsonl), the farm's
 * (running, queued, the finished of the last 24 h) and a box's own drift-node run
 */
function allJobs(d) {
  const now = d.now;
  const out = [];
  const ms = machinesOf(d);
  const mac = ms.find((m) => m.self);
  const macName = mac ? splitName(mac.name).name : 'this Mac';
  const sl = d.slots ?? {};
  const job = (o) => {
    const { kind, word } = kindOf(o.src, o.kind);
    const sub = submitterOf(o.submitter, o.src);
    const renderS = fin(o.startedAt) ? ((o.endedAt ?? now) - o.startedAt) / 1000 : null;
    const avg = fin(o.avgFps) ? o.avgFps : o.unit === 'frames' && fin(o.done) && renderS > 0 && o.done > 0 ? o.done / renderS : null;
    const perUnit = o.unit === 'frames' ? (fin(avg) && avg > 0 ? 1 / avg : null) : fin(o.done) && o.done > 0 && renderS > 0 ? renderS / o.done : null;
    return {
      ...o, kind, kindWord: word, submitter: sub.who, guessed: sub.guessed, renderS, avgFps: avg, perUnit, lane: LANE_OF[o.state] ?? 'running',
      waitS: fin(o.submittedAt) ? ((o.startedAt ?? (FINISHED.has(o.state) ? o.endedAt : now)) - o.submittedAt) / 1000 : null,
      settings: settingsOf(o.src, o.info, o.total, o.unit),
    };
  };
  for (const h of sl.held ?? []) {
    const f = slotFps(h);
    out.push(job({
      key: `slot:${h.slot}:${h.started}`, id: `M${h.slot}-${clock(h.started, true).replace(/\D/g, '')}`, source: 'slot', name: humanJob(h.cmd || h.label), src: h.cmd || h.label,
      machine: macName, where: `slot ${h.slot}`, state: 'running', startedAt: h.started, done: h.done, total: h.total, unit: h.unit, info: h.info, fpsNow: f.now, avgFps: f.avg, series: f.series,
      etaS: h.etaS, last: h.last, logRef: `slot=${h.slot}`, outs: [flagOf(h.cmd, 'out')].filter(Boolean),
      detail: [['Command', h.cmd], ['Process', `pid ${h.pid}, slot ${h.slot}`]],
    }));
  }
  (sl.waiting ?? []).forEach((w, i) => {
    out.push(job({
      key: `wait:${w.pid}`, id: `M-${w.pid}`, source: 'slot', name: humanJob(w.cmd || w.label), src: w.cmd || w.label, machine: macName, where: 'waits for a slot', state: 'queued',
      submittedAt: w.since, position: i + 1, queueName: 'this Mac’s slots', likely: macName, why: `${sl.held?.length ?? 0} of ${sl.limit ?? '?'} slots in use`,
      detail: [['Command', w.cmd || w.label], ['Process', `pid ${w.pid}`]],
    }));
  });
  // finished slot jobs: the slot logs' newest and the history file, one each
  const seen = new Set();
  for (const r of [...(sl.recent ?? []), ...(hist?.jobs ?? [])]) {
    const key = `${r.slot}:${r.started ?? r.ended}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const named = String(r.label ?? '').match(/→\s+(\S+)/)?.[1];
    const outPath = r.out ?? (named ? d.outputs?.find((o) => o.name === named)?.path : undefined);
    out.push(job({
      key: `rec:${key}`, id: `M${r.slot ?? ''}-${clock(r.started ?? r.ended, true).replace(/\D/g, '')}`, source: 'slot', name: humanJob(r.cmd || r.label), src: r.cmd || r.label, machine: macName,
      where: r.slot != null ? `slot ${r.slot}` : 'slot', state: r.exit === '0' ? 'done' : 'failed', startedAt: r.started ?? null, endedAt: r.ended, exit: r.exit, done: r.done, total: r.total, unit: r.unit,
      info: r.info, avgFps: r.unit === 'frames' && fin(r.fps) ? r.fps : null, outs: [outPath].filter(Boolean), logRef: null,
      detail: [['Command', r.cmd || r.label]],
    }));
  }
  // the farm
  const workers = d.farm?.workers ?? [];
  const queued = (d.farm?.jobs ?? []).filter((j) => j.state === 'queued' || j.state === 'uploading').sort((a, b) => (a.queuedAt ?? a.createdAt) - (b.queuedAt ?? b.createdAt));
  for (const j of d.farm?.jobs ?? []) {
    const box = j.node ? ms.find((m) => m.key === j.node || m.name === j.node) : null;
    let state = j.state;
    let why = j.state === 'queued' ? j.why : j.error;
    // a running farm job whose box yields to someone else's load is waiting, not rendering
    if (j.state === 'running' && box?.badge === 'waiting-foreign') {
      state = 'waiting';
      why = box.waiting?.why ?? 'its box yields to someone else’s GPU use';
    }
    const p = j.progress ?? {};
    const f = farmFps(j);
    const finished = FINISHED.has(j.state);
    const avgFps = finished && fin(p.fps) ? p.fps : null; // (the client's last line: its average over the whole run)
    out.push(job({
      key: `farm:${j.id}`, id: shortId(j.id), fullId: j.id, source: 'farm', name: humanJob(j.argv?.length ? j.argv : j.label), src: j.argv?.length ? j.argv : j.label, kind: j.kind,
      submitter: j.submitter, machine: j.node, where: j.node ? 'farm' : j.prefer ? `asked for ${j.prefer}` : 'farm', state, why,
      submittedAt: j.createdAt, queuedAt: j.queuedAt, startedAt: j.startedAt ?? j.claimedAt ?? null, enteredAt: j.claimedAt ?? j.startedAt ?? null, endedAt: j.endedAt, exit: j.exitCode, error: j.error,
      done: p.done, total: p.total, unit: p.unit, fpsNow: finished ? null : f.now, series: f.series, avgFps, etaS: finished ? null : p.etaS, estS: j.estS, last: j.last,
      position: queued.indexOf(j) >= 0 ? queued.indexOf(j) + 1 : null, queueName: 'the farm', likely: queued.includes(j) ? likelyBox(j, workers) : null,
      outs: (j.results ?? []).map((r) => r.path), logRef: `farm=${encodeURIComponent(j.id)}`, attempts: j.attempts, pending: j.pending ?? null, requeuedAs: j.requeuedAs ?? null,
      detail: [['Farm job', `${j.id}${j.kind ? `, a ${j.kind}` : ''}${j.attempts ? `, queued again ${j.attempts}×` : ''}`], ['Label', j.label], ['Command', (j.argv ?? []).join(' ')], ['Based on', `${j.base ?? ''}${j.cls ? ` (speed class ${j.cls})` : ''}`], ['Box', j.node ?? (j.prefer ? `asked for ${j.prefer}` : 'not yet taken')]],
    }));
  }
  // a box's own drift-node run, outside the farm
  for (const m of ms) {
    if (m.self || !m.job || m.farm) continue;
    const j = m.job;
    out.push(job({
      key: `node:${m.key}:${j.name}`, id: `${m.key.slice(0, 3)}-${j.name}`, source: 'node', name: cap(j.name), src: j.out ?? '', kind: 'long', machine: m.name, where: j.chunks ? `chunk ${j.chunk} of ${j.chunks}` : 'drift-node',
      state: { 'waiting-foreign': 'waiting', syncing: 'syncing', failed: 'failed' }[m.badge] ?? 'running', why: m.waiting?.why ?? m.error ?? null,
      done: j.frames, total: j.framesTotal, unit: 'frames', fpsNow: fin(j.fps) ? +j.fps : null, etaS: j.etaS, last: m.last, outs: [j.out].filter(Boolean),
      detail: [['Queue job', j.name], ['Output', j.out], ['Box', `${m.name}${m.commit ? ` at ${m.commit}` : ''}${m.bundle ? `, bundle ${m.bundle}` : ''}`]],
    }));
  }
  return out;
}

/** the box a queued farm job will likely go to (drift-farm.mjs pickWorker: a pinned box; a still to whoever is free; a clip or long job to the fastest) */
function likelyBox(j, workers) {
  if (j.prefer) return j.prefer;
  const up = workers.filter((w) => w.state !== 'offline').sort((a, b) => b.speed - a.speed);
  if (!up.length) return null;
  if (j.kind === 'still') return (up.find((w) => w.state === 'waiting') ?? up[0]).node;
  return up[0].node;
}

// --------------------------------------------------------------------------------------------- the farm's controls
/**
 * THE FARM'S CONTROLS (the user, 2026-10-30: "from our dashboard push a button and deregister it or something … opt
 * them out of taking tasks … not magically blocking these things"): per box Accepting · Drain · Pause · Remove, per
 * job Cancel (queued, running) and Requeue (failed). The hub takes them only from this Mac's own page (loopback): on
 * the tailnet they are shown, disabled, with the reason. A click shows its result at once (with a spinner) and rolls
 * back with a message if the hub refuses; Pause, Remove, Cancel and Requeue ask first, in the same slot.
 */
const LOCAL = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
const CAN_ACT = LOCAL || MOCK !== null;
const NOT_HERE = 'Only from this Mac’s own page (http://localhost:5190): the hub refuses farm controls from the tailnet';
/** the farm states, the control's words and what each means */
const FARM_STATES = {
  accepting: ['Accepting', 'dot', 'takes new jobs'],
  draining: ['Drain', 'drain', 'finishes its job, takes no new ones'],
  paused: ['Pause', 'pause', 'takes no jobs; standby'],
  removed: ['Remove', 'block', 'out of the farm until accepted again'],
};
const FARM_CHIP = { accepting: 'Farm: on', draining: 'Draining', paused: 'Paused', removed: 'Removed' };
/** an action the user clicked once and is asked to confirm: its key, until (ms epoch) */
let CONFIRM = null;
/** actions sent and not yet seen in the data: by key, { value, inflight, at } — shown over the server's state */
const PENDING = new Map();

function farmChip(m) {
  const st = m.farmState;
  if (!st) return '<span class="fchip nil" title="the dashboard server does not report farm states yet">Farm: —</span>';
  const p = PENDING.get(`node:${m.key}`);
  return `<span class="fchip f-${esc(st)}" title="${esc(`farm: ${FARM_STATES[st]?.[2] ?? st}`)}">${p?.inflight ? '<span class="spin" aria-hidden="true"></span>' : icon(FARM_STATES[st]?.[1] ?? 'dot')}${esc(FARM_CHIP[st] ?? st)}</span>`;
}

function farmControls(m) {
  const st = m.farmState;
  const key = `node:${m.key}`;
  const allowed = Array.isArray(m.farmActions) ? m.farmActions : Object.keys(FARM_STATES);
  if (CONFIRM?.key.startsWith(`${key}>`)) {
    const to = CONFIRM.key.split('>')[1];
    return `<span class="fconfirm"><span class="one">${esc(FARM_STATES[to][0])} ${esc(m.name)}?</span><button type="button" class="fbtn yes" data-node="${esc(m.key)}" data-to="${esc(to)}" data-sure="1">${esc(FARM_STATES[to][0])}</button><button type="button" class="fbtn" data-cancel-confirm="1">Keep</button></span>`;
  }
  const off = !CAN_ACT ? NOT_HERE : !st ? 'the dashboard server does not report farm states yet' : '';
  return `<span class="fseg" role="group" aria-label="Farm: ${esc(m.name)}">${Object.entries(FARM_STATES).map(([k, [word, , means]]) => {
    const cur = st === k;
    const dis = off || (!cur && !allowed.includes(k)) ? ' disabled' : '';
    return `<button type="button" class="fbtn${cur ? ' cur' : ''}" data-node="${esc(m.key)}" data-to="${k}" aria-pressed="${cur}" title="${esc(off || `${word}: ${means}`)}"${dis}>${esc(word)}</button>`;
  }).join('')}</span>`;
}

/** a job row's action: Cancel (queued, running) or Requeue (failed), farm jobs only; this Mac's slot jobs have none */
function jobAction(j) {
  if (j.source !== 'farm') return `<span class="noact" title="this Mac’s slot jobs are stopped where they were started">${DASH}</span>`;
  const act = j.lane === 'failed' ? 'requeue' : j.lane === 'queued' || j.lane === 'running' ? 'cancel' : null;
  if (!act) return '';
  const key = `job:${j.fullId}>${act}`;
  const word = act === 'cancel' ? 'Cancel' : 'Requeue';
  if (j.pending) return `<button type="button" class="jbtn" disabled><span class="spin" aria-hidden="true"></span>${esc(word)}</button>`;
  if (act === 'requeue' && j.requeuedAs) return `<button type="button" class="jbtn" disabled title="${esc(`queued again as ${j.requeuedAs}`)}">Requeued</button>`;
  const sure = CONFIRM?.key === key;
  return `<button type="button" class="jbtn${sure ? ' sure' : ''}" data-job="${esc(j.fullId)}" data-act="${act}"${CAN_ACT ? '' : ' disabled'} title="${esc(CAN_ACT ? (sure ? `click again to ${act}` : act === 'cancel' ? 'cancel this job (asks first)' : 'put it back in the queue (asks first)') : NOT_HERE)}">${sure ? `${word}?` : word}</button>`;
}

/** what the mock's hub would answer: a job on a battery-powered laptop is refused, like the queue's own guard */
const mockAnswer = (path, body) =>
  new Promise((ok, bad) => setTimeout(() => (/requeue/.test(path) && /battery/.test(JSON.stringify(last?.farm?.jobs?.find((j) => path.includes(j.id))?.error ?? '')) ? bad(new Error('eeg-msi is on battery: plug it in first')) : ok({ ok: true })), 700));
/** the mock's own state, changed by the controls (mockStatus knows nothing of them) */
const MOCK_FARM = { nodes: new Map(), jobs: new Map() };

async function farmPost(path, body) {
  if (MOCK !== null) return mockAnswer(path, body);
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(8000) });
  if (!r.ok) {
    let why = `HTTP ${r.status}`;
    try {
      why = (await r.json()).error ?? why;
    } catch {
      // (no body)
    }
    throw new Error(why);
  }
  return r.json().catch(() => ({}));
}

/** send an action: shown at once, kept until the data says so (or 30 s), rolled back with a message on refusal */
async function act(key, value, path, body, label) {
  PENDING.set(key, { value, inflight: true, at: Date.now() });
  rerender();
  try {
    await farmPost(path, body);
    PENDING.set(key, { value, inflight: false, at: Date.now() });
    if (MOCK !== null) {
      const [kind, id] = key.split(':');
      MOCK_FARM[kind === 'node' ? 'nodes' : 'jobs'].set(id, value);
    }
    toast(`${label}: done`);
  } catch (e) {
    PENDING.delete(key);
    toast(`${label}: refused — ${e.message}`, true);
  }
  // (laid over the answer we have, so the change shows now — or goes back — not at the next poll)
  rerender();
}

/** the server's last answer with the pending actions laid over a copy of it (the answer itself stays as it came) */
function rerender() {
  if (!raw) return;
  last = overlay(structuredClone(raw));
  render(last);
}

/** the pending actions and the mock's state laid over a fresh answer, until the server's own data agrees */
function overlay(d) {
  for (const m of machinesOf(d)) {
    // (the farm's own view of the box when the machine card does not carry it: Farm.nodes, the workers)
    if (!m.self) {
      m.farmState ??= d.farm?.nodes?.[m.key]?.state ?? d.farm?.workers?.find((w) => w.node === m.key)?.farmState ?? undefined;
      m.farmActions ??= d.farm?.nodes?.[m.key]?.actions ?? undefined;
    }
    const mock = MOCK_FARM.nodes.get(m.key);
    if (mock) m.farmState = mock;
    const p = PENDING.get(`node:${m.key}`);
    if (!p) continue;
    if ((m.farmState === p.value && !p.inflight) || Date.now() - p.at > 30_000) PENDING.delete(`node:${m.key}`);
    else m.farmState = p.value;
  }
  for (const j of d.farm?.jobs ?? []) {
    const mock = MOCK_FARM.jobs.get(j.id);
    if (mock) j.state = mock;
    const p = PENDING.get(`job:${j.id}`);
    if (!p) continue;
    // done when the data says so: the job's state, or (requeue) the new job it was queued again as (requeuedAs);
    // a running job being cancelled stays "cancelling" until its box stops it, however long that takes
    const agreed = j.state === p.value || (p.value === 'queued' && j.requeuedAs);
    const stopping = p.value === 'cancelled' && (j.state === 'running' || j.state === 'preparing');
    if ((agreed && !p.inflight) || (!stopping && Date.now() - p.at > 30_000)) PENDING.delete(`job:${j.id}`);
    else if (p.inflight) j.pending = p.value === 'cancelled' ? 'Cancelling' : 'Requeuing';
    else if (stopping) j.pending = 'Cancelling';
    else j.state = p.value;
  }
  return d;
}

/** a message in the corner for a few seconds (fixed: it moves nothing) */
function toast(text, bad) {
  const el = document.createElement('div');
  el.className = `toast${bad ? ' bad' : ''}`;
  el.setAttribute('role', bad ? 'alert' : 'status');
  el.textContent = text;
  $('toasts').append(el);
  setTimeout(() => el.remove(), bad ? 8000 : 4000);
}

// ------------------------------------------------------------------------------------------------ the queue's view
const LANES = [
  ['queued', 'Queued'],
  ['running', 'Running'],
  ['done', 'Done'],
  ['failed', 'Failed'],
];
/**
 * each tab's columns: [key, heading, numeric]. Fixed per tab, the same in every row; a missing value is "—" (the
 * user, 2026-10-30: "fixed columns")
 */
const COLS = {
  running: [['id', 'ID'], ['job', 'Job'], ['type', 'Type'], ['machine', 'Machine'], ['progress', 'Progress'], ['fps', 'fps now', 1], ['avg', 'avg', 1], ['spf', 's / frame', 1], ['eta', 'ETA', 1], ['elapsed', 'Elapsed', 1], ['status', 'Status'], ['act', '']],
  queued: [['pos', '#', 1], ['id', 'ID'], ['job', 'Job'], ['type', 'Type'], ['submitter', 'From'], ['submitted', 'Submitted', 1], ['waited', 'Waiting', 1], ['est', 'Est. run', 1], ['likely', 'Likely box'], ['why', 'Held because'], ['act', '']],
  done: [['id', 'ID'], ['job', 'Job'], ['type', 'Type'], ['machine', 'Machine'], ['submitter', 'From'], ['finished', 'Finished', 1], ['waited', 'Wait', 1], ['render', 'Render', 1], ['frames', 'Frames', 1], ['avg', 'avg fps', 1], ['spf', 's / frame', 1], ['output', 'Output']],
  failed: [['id', 'ID'], ['job', 'Job'], ['type', 'Type'], ['machine', 'Machine'], ['finished', 'Finished', 1], ['render', 'Ran', 1], ['frames', 'Frames', 1], ['exit', 'Exit', 1], ['why', 'Error'], ['act', '']],
};

/** one cell's content (escaped HTML) for column `c` of job `j` */
function cellOf(c, j, now) {
  const unitShort = j.unit === 'frames' ? 'f' : j.unit === 'stills' ? 'stills' : j.unit ?? '';
  switch (c) {
    case 'id':
      return `<span class="mono" title="${esc(j.fullId ?? j.id)}">${or(j.id)}</span>`;
    case 'job': {
      const k = `j:${j.key}`;
      return `<button class="exp" type="button" data-open="${esc(k)}" aria-expanded="${OPEN.has(k)}" title="${esc(j.name)}">${icon('chev')}<span class="lbl one">${esc(j.name)}</span></button>`;
    }
    case 'type':
      return `<span class="one" title="${esc([j.kindWord, ...j.settings].join(', '))}">${esc(j.kindWord)}${j.settings.length ? `<small> ${esc(j.settings.join(' · '))}</small>` : ''}</span>`;
    case 'machine':
      return j.machine ? `<span class="one" title="${esc(`${j.machine}${j.where ? `, ${j.where}` : ''}`)}">${esc(j.machine)}</span>` : `<span class="one muted" title="${esc(j.where ?? '')}">${DASH}</span>`;
    case 'submitter':
      return j.submitter ? `<span class="one${j.guessed ? ' guess' : ''}" title="${esc(j.guessed ? `guessed from the folder its output goes to (the job names no submitter)` : 'the agent that sent it')}">${esc(j.submitter)}</span>` : DASH;
    case 'progress': {
      const p = fin(j.total) && j.total > 0 ? pct(j.done ?? 0, j.total) : null;
      const txt = fin(j.total) ? `<b>${num(j.done ?? 0)}</b> / ${num(j.total)} ${esc(unitShort)}` : fin(j.done) && j.done > 0 ? `<b>${num(j.done)}</b> ${esc(unitShort)}` : esc(j.state === 'running' ? 'starting' : stateOf(j.state)[3]);
      return `<div class="pline" title="${p == null ? '' : `${Math.floor(p)}%`}"><div class="pbar${p == null ? ' idle' : ''}"><b style="transform:scaleX(${((p ?? 0) / 100).toFixed(4)})"></b></div><span class="pt">${txt}</span></div>`;
    }
    case 'fps':
      return j.unit === 'frames' || j.series?.length ? `<span class="fpsc">${sparkline(j.series ?? [], `fps over the last ${j.source === 'farm' ? `${Math.round(((j.series?.length ?? 0) * 10) / 60)} min` : 'progress lines'}: now ${num(j.fpsNow, 2)}`)}<span>${fin(j.fpsNow) ? num(j.fpsNow, 2) : DASH}</span></span>` : DASH;
    case 'avg':
      return fin(j.avgFps) ? num(j.avgFps, 2) : DASH;
    case 'spf':
      return fin(j.perUnit) ? `${num(j.perUnit, j.perUnit < 10 ? 1 : 0)}<small> s${j.unit === 'stills' ? '/still' : ''}</small>` : DASH;
    case 'eta':
      return fin(j.etaS) ? dur(j.etaS) : DASH;
    case 'elapsed':
      return fin(j.renderS) ? dur(j.renderS) : DASH;
    case 'status':
      return j.pending ? `<span class="chip s-sync" title="asked the hub; waiting for its answer"><span class="spin" aria-hidden="true"></span>${esc(j.pending)}</span>` : chip(j.state === 'running' ? 'rendering' : j.state, j.why || undefined);
    case 'act':
      return jobAction(j);
    case 'pos':
      return fin(j.position) ? `<span title="${esc(`place in ${j.queueName}`)}">${j.position}</span>` : DASH;
    case 'submitted':
      return fin(j.submittedAt) ? `<span title="${esc(stamp(j.submittedAt))}">${clock(j.submittedAt)}</span>` : DASH;
    case 'waited':
      return fin(j.waitS) ? durCoarse(j.waitS) : DASH;
    case 'est':
      return fin(j.estS) ? `~${durCoarse(j.estS)}` : DASH;
    case 'likely':
      return j.likely ? `<span class="one" title="the box drift-farm.mjs would hand it to now">${esc(j.likely)}</span>` : DASH;
    case 'why':
      return j.why || j.error ? `<span class="one why" title="${esc(j.why || j.error)}">${esc(j.why || j.error)}</span>` : DASH;
    case 'finished':
      return fin(j.endedAt) ? `<span title="${esc(stamp(j.endedAt))}">${durCoarse((now - j.endedAt) / 1000)} ago</span>` : DASH;
    case 'render':
      return fin(j.renderS) ? dur(j.renderS) : DASH;
    case 'frames':
      return fin(j.done) ? `${num(j.done)}${fin(j.total) && j.total !== j.done ? `<small> / ${num(j.total)}</small>` : ''}<small> ${esc(unitShort)}</small>` : DASH;
    case 'exit':
      return j.exit != null && j.exit !== '' ? `<span class="mono">${esc(j.exit)}</span>` : DASH;
    case 'output': {
      const o = (j.outs ?? []).find(isMedia) ?? null;
      if (!o) return j.outs?.length ? `<span class="one" title="${esc(j.outs.join('\n'))}">${esc(base(j.outs[0]))}</span>` : DASH;
      const thumb = isVideo(o) ? `<span class="othumb vid">${icon('play')}</span>` : `<img class="othumb" loading="lazy" decoding="async" alt="" src="${fileUrl(o)}">`;
      return `<a class="olink" href="${fileUrl(o)}" target="_blank" rel="noopener" title="${esc(o)}">${thumb}<span class="one">${esc(base(o))}</span></a>`;
    }
    default:
      return DASH;
  }
}

/** an opened row's details: everything, with paths, and the log's newest lines (fetched while it is open) */
function detailOf(j, cols) {
  const rows = [
    ['ID', j.fullId ?? j.id], ['Submitted by', j.submitter ? `${j.submitter}${j.guessed ? ' (guessed from its output folder)' : ''}` : null], ['Type', [j.kindWord, ...j.settings].join(', ')],
    ['Submitted', stamp(j.submittedAt)], ['Started', stamp(j.startedAt)], ['Finished', stamp(j.endedAt)], ['Waited', fin(j.waitS) ? dur(j.waitS) : null], ['Rendered', fin(j.renderS) ? dur(j.renderS) : null],
    ['Why', j.why], ['Error', j.error], ['Exit', j.exit != null && j.exit !== '' ? String(j.exit) : null], ...j.detail, ['Outputs', (j.outs ?? []).join('\n')],
  ].filter(([, v]) => v != null && v !== '');
  let h = `<div class="detail"><dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
  const media = (j.outs ?? []).filter(isMedia);
  if (media.length) h += `<div class="douts">${media.slice(0, 6).map((o) => `<a href="${fileUrl(o)}" target="_blank" rel="noopener" title="${esc(o)}">${isVideo(o) ? `<span class="othumb big vid">${icon('play')}</span>` : `<img class="othumb big" loading="lazy" alt="" src="${fileUrl(o)}">`}</a>`).join('')}</div>`;
  if (j.logRef) {
    const lg = LOGS.get(j.logRef);
    h += `<div class="logtail"><div class="lt-h">Log, newest ${lg?.lines?.length ?? 0} lines${lg?.at ? `, read ${clock(lg.at, true)}` : ''}</div><pre>${lg ? esc(lg.lines.join('\n')) || 'empty' : 'reading…'}</pre></div>`;
  }
  return `${h}</div>`;
}

/** a log line fit for the running row: a slot log's first line is its command, said in words instead */
const lastLine = (j) => (/^\d{4}-\d\d-\d\dT\S+\s+node\s/.test(j.last ?? '') ? 'started; no progress line yet' : j.last);

function jobRow(j, lane, now) {
  const cols = COLS[lane];
  const [cls] = stateOf(j.state === 'running' ? 'rendering' : j.state);
  const open = OPEN.has(`j:${j.key}`);
  let h = `<div class="jr s-${cls}" role="row" data-key="${esc(j.key)}">`;
  h += cols.map(([c, , n]) => `<div class="c c-${c}${n ? ' n' : ''}" role="cell" data-k="${esc(COLS[lane].find((x) => x[0] === c)[1])}">${cellOf(c, j, now)}</div>`).join('');
  if (lane === 'running') h += `<div class="c c-log one" role="cell" title="${esc(j.last ?? '')}">${j.last ? esc(lastLine(j)) : DASH}</div>`;
  if (open) h += detailOf(j, cols);
  return `${h}</div>`;
}

/**
 * the last 24 hours' numbers: what got done, how much, how fast, and when the queue will be empty. Rolling, not since
 * midnight: a studio rendering through the night is not "done" at 00:00
 */
function todayStrip(jobs, d) {
  const since = d.now - 86_400_000;
  const today = jobs.filter((j) => FINISHED.has(j.state) && j.endedAt >= since);
  const done = today.filter((j) => j.state === 'done');
  const failed = today.filter((j) => j.state === 'failed');
  const running = jobs.filter((j) => j.lane === 'running');
  const frames = done.filter((j) => j.unit === 'frames').reduce((a, j) => a + (j.done ?? 0), 0) + running.filter((j) => j.unit === 'frames').reduce((a, j) => a + (j.done ?? 0), 0);
  const stills = done.filter((j) => j.unit === 'stills').reduce((a, j) => a + (j.done ?? 0), 0);
  const renderS = today.reduce((a, j) => a + (j.renderS ?? 0), 0) + running.reduce((a, j) => a + (j.renderS ?? 0), 0);
  // average fps per machine over today's finished frame jobs
  const per = new Map();
  for (const j of done) {
    if (j.unit !== 'frames' || !fin(j.done) || !(j.renderS > 0)) continue;
    const e = per.get(j.machine) ?? { f: 0, s: 0 };
    e.f += j.done;
    e.s += j.renderS;
    per.set(j.machine, e);
  }
  const perTxt = [...per.entries()].sort((a, b) => b[1].f / b[1].s - a[1].f / a[1].s).map(([m, e]) => `${m} ${num(e.f / e.s, 1)}`);
  const throughput = running.filter((j) => j.unit === 'frames' && fin(j.fpsNow) && j.state === 'running').reduce((a, j) => a + j.fpsNow, 0) * 60;
  // drain: the queued jobs' expected run times plus the running ones' time left, over the boxes that can take them
  const queued = jobs.filter((j) => j.lane === 'queued');
  const median = (xs) => (xs.length ? xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
  const typical = (k) => median(jobs.filter((x) => x.state === 'done' && x.kind === k && fin(x.renderS)).map((x) => x.renderS));
  let work = running.reduce((a, j) => a + (fin(j.etaS) ? j.etaS : 0), 0);
  let unknown = 0;
  for (const j of queued) {
    const e = fin(j.estS) ? j.estS : typical(j.kind);
    if (fin(e)) work += e;
    else unknown += 1;
  }
  const lanes = (d.farm?.workers ?? []).filter((w) => w.state !== 'offline').length + (d.slots?.limit ?? 0);
  const drainS = queued.length || running.length ? work / Math.max(1, lanes) : 0;
  const stat = (k, v, sub, tip) => `<div class="st"${tip ? ` title="${esc(tip)}"` : ''}><span class="st-k">${esc(k)}</span><span class="st-v">${v}</span><span class="st-s one">${sub ?? '&nbsp;'}</span></div>`;
  const all = [...per.values()].reduce((a, e) => ({ f: a.f + e.f, s: a.s + e.s }), { f: 0, s: 0 });
  return stat('Done, 24 h', `${done.length}`, failed.length ? `<span class="bad">${failed.length} failed</span>` : 'none failed')
    + stat('Rendered, 24 h', `<span class="v">${num(frames)}</span><small> frames</small>`, stills ? `and ${num(stills)} stills` : '&nbsp;', 'frames of the last 24 hours’ finished jobs and of the running ones so far')
    + stat('Render time, 24 h', renderS ? dur(renderS) : DASH, `over ${today.length + running.length} job${today.length + running.length === 1 ? '' : 's'}`, 'summed over the machines: two boxes for an hour is 2 h')
    + stat('Avg fps, 24 h', all.s > 0 ? num(all.f / all.s, 2) : DASH, perTxt.length ? esc(perTxt.join(', ')) : '&nbsp;', perTxt.length ? `frames per second of render time, all finished frame jobs; by machine: ${perTxt.join(', ')}` : 'no finished frame jobs in the last 24 hours')
    + stat('Throughput now', throughput ? `<span class="v">${num(throughput)}</span><small> f/min</small>` : DASH, `${running.length} running`, 'the running jobs’ frame rates, summed')
    + stat('Queue drains in', queued.length ? `~${durCoarse(drainS)}` : running.length ? `~${durCoarse(drainS)}` : 'empty', `${queued.length} queued${unknown ? `, ${unknown} unestimated` : ''}`, `queued jobs’ expected run times (the farm's measured speeds, else the median of this kind) plus the running ones’ time left, over ${lanes} lane${lanes === 1 ? '' : 's'} (online farm boxes and this Mac’s slots)`);
}

function renderJobs(d) {
  const jobs = allJobs(d);
  const lanes = { queued: [], running: [], done: [], failed: [] };
  for (const j of jobs) lanes[j.lane]?.push(j);
  lanes.queued.sort((a, b) => (a.queueName === b.queueName ? (a.position ?? 0) - (b.position ?? 0) : a.queueName === 'the farm' ? -1 : 1));
  // (by when a job entered the lane — its box took it — which never changes; its start time does, when it boots)
  lanes.running.sort((a, b) => (a.enteredAt ?? a.startedAt ?? 0) - (b.enteredAt ?? b.startedAt ?? 0) || String(a.key).localeCompare(String(b.key)));
  lanes.done.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  lanes.failed.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  // (Running unless the user picked another: a tab that switched itself when the last job finished would be a jump)
  const tab = TAB && lanes[TAB] ? TAB : 'running';
  morph($('tabs'), LANES.map(([k, w]) => `<button type="button" role="tab" class="tab t-${k}" data-key="${k}" data-tab="${k}" aria-selected="${k === tab}">${esc(w)}<span class="n" data-num="${lanes[k].length}">${lanes[k].length}</span></button>`).join(''));
  const cols = COLS[tab];
  const list = lanes[tab].slice(0, tab === 'done' || tab === 'failed' ? FINISHED_MAX : 200);
  const wanted = SHOW_JOB && lanes[tab].find((j) => j.key === SHOW_JOB);
  if (wanted && !list.includes(wanted)) list.push(wanted);
  let h = `<div class="jr jh" role="row" data-key="h">${cols.map(([c, w, n]) => `<div class="c c-${c}${n ? ' n' : ''}" role="columnheader">${esc(w)}</div>`).join('')}</div>`;
  h += list.length ? list.map((j) => jobRow(j, tab, d.now)).join('') : `<div class="empty" role="row" data-key="none"><span role="cell">${esc({ queued: 'Nothing in line. A job sent with drift-slot.mjs --farm, or waiting for a slot on this Mac, shows here.', running: 'Nothing rendering right now.', done: 'Nothing finished in the last 24 hours (the farm) or 7 days (this Mac).', failed: 'No failures in the last 24 hours (the farm) or 7 days (this Mac).' }[tab])}</span></div>`;
  const el = $('jobs');
  el.className = `jt lane-${tab}`;
  morph(el, h);
  const farm = d.farm ? (d.farm.enabled ? `farm: ${(d.farm.workers ?? []).filter((w) => w.state !== 'offline').length} of ${(d.farm.workers ?? []).length} workers up` : 'farm queue off') : '';
  $('jobs-meta').textContent = farm;
  return lanes;
}

// ------------------------------------------------------------------------------------- waiting on you, the streams
function renderYou(d) {
  const you = d.work?.waitingOnUser ?? [];
  morph($('you'), you.length
    ? you.map((x) => {
        const k = `y:${x}`;
        return `<li class="${OPEN.has(k) ? 'open' : ''}" data-key="${esc(x)}"><button type="button" data-open="${esc(k)}" aria-expanded="${OPEN.has(k)}" title="${esc(x)}">${icon('ask')}<span class="yt">${inline(x)}</span></button></li>`;
      }).join('')
    : '<li class="none" data-key="none">Nothing needs you right now.</li>');
  $('you-n').textContent = you.length ? String(you.length) : '';
}

const STREAM_ORDER = { blocked: 0, review: 1, waiting: 2, failed: 2, rendering: 3, coding: 4, syncing: 4, queued: 5, done: 9 };
/** each stream's place within its state group: the order this page first saw them, so an update moves nothing */
const STREAM_SEEN = new Map();
function renderStreams(d) {
  for (const x of d.work?.streams ?? []) if (!STREAM_SEEN.has(x.title)) STREAM_SEEN.set(x.title, STREAM_SEEN.size);
  const st = [...(d.work?.streams ?? [])].sort((a, b) => (STREAM_ORDER[a.state] ?? 6) - (STREAM_ORDER[b.state] ?? 6) || STREAM_SEEN.get(a.title) - STREAM_SEEN.get(b.title));
  const html = st.length
    ? `<div class="sl" data-key="list">${st.map((s) => {
        const k = `s:${s.title}`;
        const open = OPEN.has(k);
        const since = toMs(s.since);
        const tip = `${s.title}${s.eta ? ` (${s.eta})` : ''}${since ? `, since ${clock(since)}` : ''}`;
        return `<div class="sr${open ? ' open' : ''}${s.state === 'done' ? ' done' : ''}" data-key="${esc(s.title)}"><button type="button" data-open="${esc(k)}" aria-expanded="${open}" title="${esc(tip)}">${chip(s.state)}<span class="ttl one">${esc(s.title)}</span><span class="det">${inline(s.detail ?? '')}${open && since ? `<span class="muted"> Since ${clock(since)}.</span>` : ''}</span><span class="est">${esc(s.eta || DASH)}</span></button></div>`;
      }).join('')}</div>`
    : '<div class="note" data-key="none">No work streams listed (out/drift/dashboard/work.json).</div>';
  morph($('streams'), html);
  const active = st.filter((s) => s.state !== 'done').length;
  $('streams-meta').textContent = st.length ? `${active} active, ${st.length - active} done` : '';
}

// ---------------------------------------------------------------------------------------------- the newest outputs
let outputs = [];
/** thumbnails whose file would not load (gone, or not an image after all), by their src: not asked for again */
const GONE = new Set();
function renderOuts(d) {
  outputs = d.outputs ?? [];
  // (a new output slides in at the front and the others glide aside: their old places, then FLIP to the new ones)
  const before = new Map([...$('outs').children].map((el) => [el.dataset.key, el.getBoundingClientRect()]));
  const first = before.size === 0;
  morph($('outs'), outputs.length
    ? outputs.map((o, i) => {
        const u = fileUrl(o.path, o.mtime);
        const src = o.video ? `${u}#t=0.5` : u;
        const gone = GONE.has(src);
        const media = gone ? '' : o.video ? `<video muted playsinline preload="metadata" src="${src}"></video><span class="play">${icon('play')}</span>` : `<img loading="lazy" decoding="async" alt="" src="${src}">`;
        return `<button class="thumb" type="button" data-key="${esc(`${o.path}|${o.mtime}`)}" data-view="${i}" title="${esc(o.path)}"><span class="media${gone ? ' gone' : ''}">${media}</span><span class="cap">${esc(o.name)}</span><span class="cap2">${esc(o.dir)}, ${durCoarse((d.now - o.mtime) / 1000)} ago</span></button>`;
      }).join('')
    : '<div class="note" data-key="none">No review images or clips yet.</div>');
  if (CALM || first) return;
  for (const el of $('outs').children) {
    const was = before.get(el.dataset.key);
    if (!was) {
      el.animate([{ opacity: 0, transform: 'translateY(10px) scale(.97)' }, { opacity: 1, transform: 'none' }], { duration: 520, easing: 'cubic-bezier(.2,.7,.2,1)' });
      continue;
    }
    const now = el.getBoundingClientRect();
    const dx = was.left - now.left;
    const dy = was.top - now.top;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 520, easing: 'cubic-bezier(.2,.7,.2,1)' });
  }
}

/** the viewer: an image, or the clip playing. It remembers the file, not its place: a poll can reorder the list */
let viewingPath = null;
const viewStep = (step) => {
  const i = outputs.findIndex((o) => o.path === viewingPath);
  view((Math.max(0, i) + step + outputs.length) % outputs.length);
};
function view(i) {
  const o = outputs[i];
  if (!o) return;
  viewingPath = o.path;
  const u = fileUrl(o.path, o.mtime);
  $('viewer-cap').textContent = `${o.dir}/${o.name}`;
  $('viewer-open').href = u;
  $('viewer-stage').innerHTML = o.video ? `<video controls autoplay playsinline src="${u}"></video>` : `<img alt="${esc(o.name)}" src="${u}">`;
  const dlg = $('viewer');
  if (!dlg.open) dlg.showModal();
}
$('viewer').addEventListener('close', () => {
  $('viewer-stage').innerHTML = ''; // (stops a playing clip)
  viewingPath = null;
});
$('viewer-close').addEventListener('click', () => $('viewer').close());
$('viewer').addEventListener('click', (e) => {
  const step = e.target.closest('[data-step]')?.dataset.step;
  if (step) viewStep(Number(step));
  else if (e.target === $('viewer')) $('viewer').close(); // (a click on the backdrop)
});
$('viewer').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') viewStep(e.key === 'ArrowRight' ? 1 : -1);
});

// a thumbnail whose file has gone (cleaned up between the server's listing and the request) or does not decode: say
// so instead of a broken icon. Kept in GONE, not as a class on the element: the next poll's morph would reset a class
document.addEventListener('error', (e) => {
  const el = e.target;
  if (!(el instanceof HTMLImageElement || el instanceof HTMLVideoElement) || !el.closest('.thumb')) return;
  GONE.add(el.getAttribute('src'));
  if (last) renderOuts(last);
}, true);

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-cancel-confirm]')) {
    CONFIRM = null;
    if (last) render(last);
    return;
  }
  const nb = e.target.closest('[data-node][data-to]');
  if (nb && !nb.disabled) {
    const { node, to, sure } = nb.dataset;
    const m = last && machinesOf(last).find((x) => x.key === node);
    if (!m || m.farmState === to) return;
    if ((to === 'paused' || to === 'removed') && !sure) {
      CONFIRM = { key: `node:${node}>${to}`, until: Date.now() + 8000 };
      if (last) render(last);
      return;
    }
    CONFIRM = null;
    act(`node:${node}`, to, `/farm/nodes/${encodeURIComponent(m.name)}/state`, { state: to }, `${FARM_STATES[to][0]} ${m.name}`);
    return;
  }
  const jb = e.target.closest('[data-job][data-act]');
  if (jb && !jb.disabled) {
    const { job, act: a } = jb.dataset;
    const key = `job:${job}>${a}`;
    if (CONFIRM?.key !== key) {
      CONFIRM = { key, until: Date.now() + 5000 };
      if (last) renderJobs(last);
      return;
    }
    CONFIRM = null;
    act(`job:${job}`, a === 'cancel' ? 'cancelled' : 'queued', `/farm/jobs/${encodeURIComponent(job)}/${a}`, {}, `${a === 'cancel' ? 'Cancel' : 'Requeue'} ${shortId(job)}`);
    return;
  }
  const v = e.target.closest('[data-view]');
  if (v) return view(Number(v.dataset.view));
  const t = e.target.closest('[data-tab]');
  if (t) {
    TAB = t.dataset.tab;
    try {
      localStorage.setItem('drift-console-tab', TAB);
    } catch {
      // (not kept: fine)
    }
    if (last) renderJobs(last);
    return;
  }
  const o = e.target.closest('[data-open]');
  if (!o) return;
  const k = o.dataset.open;
  if (OPEN.has(k)) OPEN.delete(k);
  else OPEN.add(k);
  if (last) {
    render(last);
    if (k.startsWith('j:')) readLogs();
  }
});
// arrow keys between the queue's tabs (the tablist pattern)
$('tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const tabs = [...$('tabs').querySelectorAll('[role=tab]')];
  const i = tabs.findIndex((x) => x.getAttribute('aria-selected') === 'true');
  const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
  next.click();
  next.focus();
});

// ------------------------------------------------------------------------------------------- v3: live previews
/**
 * THE NEWEST FRAME OF WHAT A MACHINE RENDERS (the user, 2026-10-30: "live render previews"): a farm job's
 * /farm/jobs/:id/preview.jpg once the hub says it has one (FarmJob.previewAt — asked only then, so nothing 404s), this
 * Mac's stills job's newest image in its output folder; none for a clip until it lands. Refreshed with the data (the
 * boxes send a frame about every 10 s), crossfaded by syncPreviews so a new frame never blinks.
 */
function previewOf(m, d) {
  if (MOCK !== null) return mockMod?.mockPreview?.(m, d) ?? null;
  if (m.self) {
    const h = d.slots?.held?.[0];
    const out = h ? flagOf(h.cmd, 'out') : null;
    if (!out || isMedia(out)) return null;
    const rel = out.replace(/^\.\//, '').replace(/\/+$/, '');
    const o = (d.outputs ?? []).filter((x) => !x.video && (x.path.startsWith(`${rel}/`) || x.path.includes(`/${rel}/`))).sort((a, b) => b.mtime - a.mtime)[0];
    return o ? fileUrl(o.path, o.mtime) : null;
  }
  const j = m.farm;
  return j?.previewAt ? `/farm/jobs/${encodeURIComponent(j.id)}/preview.jpg?v=${Math.round(j.previewAt)}` : null;
}
/** each preview slot shows its data-src: the new frame loads unseen, then fades in over the old one */
function syncPreviews() {
  for (const pv of document.querySelectorAll('.pv[data-own]')) {
    const src = pv.dataset.src || '';
    if (pv.__src === src) continue;
    pv.__src = src;
    const old = [...pv.querySelectorAll('img')];
    const fade = () => old.forEach((o) => {
      o.classList.remove('in');
      setTimeout(() => o.remove(), CALM ? 0 : 900);
    });
    if (!src) {
      fade();
      pv.classList.remove('has');
      continue;
    }
    const img = new Image();
    img.decoding = 'async';
    img.alt = '';
    img.onload = () => {
      if (pv.__src !== src) return;
      pv.append(img);
      pv.classList.add('has');
      requestAnimationFrame(() => requestAnimationFrame(() => img.classList.add('in')));
      fade();
    };
    img.src = src;
  }
}

// ------------------------------------------------------------------------------------------ v3: motion helpers
/** the formats a rolling number is shown in */
const FMT = { int: (v) => num(Math.round(v)), f1: (v) => num(v, 1), f2: (v) => num(v, 2) };
/**
 * numbers that ROLL to their new value (data-num, data-fmt) instead of jumping: 0.7 s, easing out, then exact. Text
 * only, in slots of fixed width (tabular figures), so nothing moves around them
 */
function roll(root) {
  for (const el of root.querySelectorAll('[data-num]')) {
    if (el.dataset.num === '') continue;
    const to = Number(el.dataset.num);
    const from = el.__v;
    el.__v = to;
    if (CALM || !fin(from) || from === to) continue;
    const f = FMT[el.dataset.fmt] ?? FMT.int;
    const t0 = performance.now();
    cancelAnimationFrame(el.__raf);
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 700);
      el.textContent = f(from + (to - from) * (1 - (1 - k) ** 3));
      if (k < 1) el.__raf = requestAnimationFrame(step);
    };
    el.__raf = requestAnimationFrame(step);
  }
}
/** a chip, or a timeline bar, that changed state gives one soft pulse (Web Animations: its attributes stay the data's) */
const SEEN_CLASS = new WeakMap();
function pulses(root) {
  for (const el of root.querySelectorAll('.chip, .fchip, .gb')) {
    const was = SEEN_CLASS.get(el);
    SEEN_CLASS.set(el, el.className);
    if (CALM || !was || was === el.className) continue;
    const landed = el.classList.contains('gb') && /st-done/.test(el.className);
    el.animate(landed
      ? [{ filter: 'brightness(1.9)', transform: 'scaleY(1.35)' }, { filter: 'brightness(1)', transform: 'scaleY(1)' }]
      : [{ transform: 'scale(1)', filter: 'brightness(1)' }, { transform: 'scale(1.12)', filter: 'brightness(1.45)' }, { transform: 'scale(1)', filter: 'brightness(1)' }], { duration: landed ? 900 : 700, easing: 'cubic-bezier(.2,.7,.2,1)' });
  }
}

// --------------------------------------------------------------------------------------------- v3: the hero
const nspan = (v, fmt = 'int') => `<span class="v" data-num="${fin(v) ? v : ''}" data-fmt="${fmt}">${fin(v) ? FMT[fmt](v) : DASH}</span>`;
/** the hero's throughput line: the fleet's frames/min over the last 30 min, its newest point breathing */
function heroSpark(values) {
  const v = values.filter(fin);
  if (v.length < 2) return '<div class="hsp"><svg class="hspark" viewBox="0 0 200 36" preserveAspectRatio="none" aria-hidden="true"><line x1="0" x2="200" y1="35" y2="35"/></svg></div>';
  const max = Math.max(...v, 30) * 1.12;
  const pts = v.map((y, i) => [(i / (v.length - 1)) * 198 + 1, 34 - (y / max) * 32]);
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lx, ly] = pts.at(-1);
  return `<div class="hsp"><svg class="hspark" viewBox="0 0 200 36" preserveAspectRatio="none" role="img" aria-label="frames per minute over the last 30 minutes, now ${Math.round(v.at(-1))}"><polygon points="1,35 ${line} 199,35"/><polyline points="${line}"/></svg><i class="hdot" style="left:${(lx / 2).toFixed(1)}%;top:${((ly / 36) * 100).toFixed(1)}%"></i></div>`;
}
/** the queue's drain: queued jobs' expected run times plus the running ones' time left, over the lanes that take them */
function drainOf(jobs, d) {
  const running = jobs.filter((j) => j.lane === 'running');
  const queued = jobs.filter((j) => j.lane === 'queued');
  const median = (xs) => (xs.length ? xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
  const typical = (k) => median(jobs.filter((x) => x.state === 'done' && x.kind === k && fin(x.renderS)).map((x) => x.renderS));
  let work = running.reduce((a, j) => a + (fin(j.etaS) ? j.etaS : 0), 0);
  let unknown = 0;
  for (const j of queued) {
    const e = fin(j.estS) ? j.estS : typical(j.kind);
    if (fin(e)) work += e;
    else unknown += 1;
  }
  const lanes = (d.farm?.workers ?? []).filter((w) => w.state !== 'offline' && (w.farmState ?? 'accepting') === 'accepting').length + (d.slots?.limit ?? 0);
  return { drainS: queued.length || running.length ? work / Math.max(1, lanes) : 0, lanes, unknown, queued: queued.length, running: running.length };
}
function renderHero(d, jobs, shows) {
  const now = d.now;
  const ms = machinesOf(d);
  const running = jobs.filter((j) => j.lane === 'running');
  const since = now - 86_400_000;
  const fin24 = jobs.filter((j) => FINISHED.has(j.state) && j.endedAt >= since);
  const done24 = fin24.filter((j) => j.state === 'done');
  const live = running.filter((j) => j.unit === 'frames' && j.state === 'running' && fin(j.fpsNow));
  const fpm = live.reduce((a, j) => a + j.fpsNow, 0) * 60;
  const gpus = ms.map((m) => ({ m, who: !m.online ? 'off' : /^rendering|^syncing/.test(m.badge) ? 'ours' : m.badge === 'busy-foreign' || m.badge === 'waiting-foreign' || (m.gpu?.utilPct ?? 0) >= 30 ? 'foreign' : 'idle' }));
  const busy = gpus.filter((g) => g.who === 'ours' || g.who === 'foreign').length;
  const ours = gpus.filter((g) => g.who === 'ours').length;
  const watts = ms.reduce((a, m) => a + (m.online && fin(m.gpu?.powerW) ? m.gpu.powerW : 0), 0);
  const limit = ms.reduce((a, m) => a + (m.online && fin(m.gpu?.powerLimitW) ? m.gpu.powerLimitW : 0), 0);
  const frames = [...done24, ...running].filter((j) => j.unit === 'frames').reduce((a, j) => a + (j.done ?? 0), 0);
  const stills = [...done24, ...running].filter((j) => j.unit === 'stills').reduce((a, j) => a + (j.done ?? 0), 0);
  const renderH = [...fin24, ...running].reduce((a, j) => a + (j.renderS ?? 0), 0) / 3600;
  const dr = drainOf(jobs, d);
  const card = (cls, k, big, unit, sub, extra = '', tip = '') => `<div class="hc ${cls}"${tip ? ` title="${esc(tip)}"` : ''}><div class="hk">${k}</div><div class="hv">${big}${unit ? `<small>${unit}</small>` : ''}</div><div class="hs one">${sub}</div>${extra}</div>`;
  const pips = `<div class="pips">${gpus.map((g) => `<i class="pip ${g.who}" title="${esc(`${splitName(g.m.name).name}: ${g.who === 'off' ? 'offline' : g.who === 'ours' ? 'ours' : g.who === 'foreign' ? 'someone else’s' : 'idle'}${fin(g.m.gpu?.utilPct) ? `, GPU ${g.m.gpu.utilPct}%` : ''}`)}"></i>`).join('')}</div>`;
  const sh = shows[0];
  let h = card(`hc-thru${fpm > 0 ? ' lit' : ''}`, 'Throughput', nspan(fpm), 'frames/min', `${num(fpm / 60, 1)} fps over ${live.length} job${live.length === 1 ? '' : 's'}`, heroSpark((hist?.fleet ?? []).map((r) => r[3])), 'the running frame jobs’ frame rates, summed; the line: the last 30 min');
  h += card('hc-gpu', 'GPUs busy', `${nspan(busy)}<span class="of"> / ${ms.length}</span>`, '', `${icon('bolt')}${fin(watts) && watts > 0 ? `${num(watts)} W` : DASH}${limit ? ` of ${num(limit)} W` : ''} drawn`, pips, `${ours} rendering ours; power is the boxes’ GPU boards (this Mac’s is not measured)`);
  h += card('hc-frames', 'Rendered, 24 h', nspan(frames), 'frames', `${num(renderH, 1)} render-hours${stills ? `, ${num(stills)} stills` : ''}`, '', 'frames of the last 24 hours’ finished jobs and of the running ones so far; render-hours summed over the machines');
  h += card('hc-jobs', 'Jobs', `<span class="trio"><span>${nspan(dr.running)}<i>running</i></span><span>${nspan(dr.queued)}<i>queued</i></span><span title="finished in the last 24 hours">${nspan(done24.length)}<i>done</i></span></span>`, '', fin24.length - done24.length ? `<span class="bad">${fin24.length - done24.length} failed or cancelled in 24 h</span>` : 'none failed in 24 h');
  h += card('hc-drain', 'Queue drains in', dr.queued || dr.running ? `<span class="v">~${esc(durCoarse(dr.drainS))}</span>` : '<span class="v">empty</span>', '', dr.queued || dr.running ? `at ${clock(now + dr.drainS * 1000)}, ${dr.queued} queued over ${dr.lanes} lane${dr.lanes === 1 ? '' : 's'}${dr.unknown ? `, ${dr.unknown} unestimated` : ''}` : 'nothing waiting', '', 'queued jobs’ expected run times (measured speeds, else the median of their kind) plus the running ones’ time left, over the boxes taking work and this Mac’s slots');
  h += shows.length ? `<div class="hc-shows n${shows.length}">${shows.map((g) => showRenderCard(g, d, shows.length > 1)).join('')}</div>` : card('hc-show', 'Full show', '<span class="v">—</span>', '', 'no full-show render running');
  morph($('hero'), h);
}

// ------------------------------------------------------------------------------------- v3: whole-show renders
/** a chunk of a whole render (drift-farm-render.mjs): its output is <out>/chunks/chunk_<from>-<to>.mp4 */
const CHUNK_RE = /[\\/]chunks[\\/]chunk_([\d.]+)-([\d.]+)(_[a-z]+\d*)?\.mp4$/i;
/**
 * THE WHOLE-SHOW RENDERS (the user, 2026-10-30: "what the user watches overnight"): the farm's jobs grouped by the
 * render they are chunks of, laid on the render's grid of chunks (cut every `chunk` s from its start). A cell without
 * a job is a chunk that was already on disk when the render was started again (drift-farm-render skips those).
 * Newest render of each format (dome, flat); kept for 12 h after its last chunk
 */
function showGroups(d) {
  const groups = new Map();
  for (const j of d.farm?.jobs ?? []) {
    const o = [...(j.outs ?? []), ...(j.argv ?? [])].find((p) => CHUNK_RE.test(String(p)));
    if (!o) continue;
    const [, a, b, suffix] = String(o).match(CHUNK_RE);
    const flat = /flat/i.test(suffix ?? '') || (j.argv ?? []).some((x) => String(x).includes('drift-review-clip'));
    // (the dome's chunks and the 16:9 version's (chunk_…_flat2048.mp4) may share a folder: a render is both)
    const dir = `${String(o).replace(CHUNK_RE, '')}${flat ? ' (16:9)' : ''}`;
    const g = groups.get(dir) ?? { dir, format: flat ? 'flat' : 'dome', size: flagOf(j.argv, flat ? 'width' : 'size'), chunks: new Map(), lastAt: 0, firstAt: Infinity };
    const key = (+a).toFixed(3);
    const prev = g.chunks.get(key);
    if (!prev || (j.createdAt ?? 0) > (prev.job.createdAt ?? 0)) g.chunks.set(key, { from: +a, to: +b, job: j });
    g.lastAt = Math.max(g.lastAt, FINISHED.has(j.state) ? j.endedAt ?? 0 : d.now);
    g.firstAt = Math.min(g.firstAt, j.createdAt ?? d.now);
    groups.set(dir, g);
  }
  const out = [];
  for (const g of groups.values()) {
    if (d.now - g.lastAt > 12 * 3600e3 || g.chunks.size < 3) continue;
    const list = [...g.chunks.values()].sort((x, y) => x.from - y.from);
    const lens = list.map((c) => +(c.to - c.from).toFixed(3));
    const L = lens.sort((x, y) => lens.filter((v) => v === y).length - lens.filter((v) => v === x).length)[0] || 20;
    const from0 = list[0].from;
    const to1 = Math.max(...list.map((c) => c.to));
    const n = Math.max(1, Math.round((to1 - from0) / L + 0.49));
    const cells = [];
    for (let i = 0; i < n; i++) {
      const cf = from0 + i * L;
      const c = list.find((x) => Math.abs(x.from - cf) < L / 2);
      const j = c?.job;
      const k = !j ? 'here' : j.state === 'done' ? 'done' : j.state === 'failed' ? 'failed' : j.state === 'cancelled' ? 'cancelled' : j.state === 'running' || j.state === 'preparing' ? 'running' : 'queued';
      const p = j && fin(j.progress?.done) && fin(j.progress?.total) && j.progress.total > 0 ? j.progress.done / j.progress.total : 0;
      const range = `${num(c?.from ?? cf, 0)}–${num(c?.to ?? cf + L, 0)} s`;
      cells.push({ k, p, j, tip: `${range}: ${k === 'here' ? 'no job: on disk already (not rendered again), or never sent' : `${k}${j.node ? ` on ${j.node}` : ''}${k === 'running' ? `, ${Math.round(p * 100)}%` : ''}${j.error ? ` — ${j.error}` : ''}`}` });
    }
    const done = cells.filter((c) => c.k === 'done' || c.k === 'here').length;
    const runs = cells.filter((c) => c.k === 'running');
    const pct = (100 * (done + runs.reduce((a, c) => a + c.p, 0))) / cells.length;
    const took = cells.filter((c) => c.k === 'done' && fin(c.j?.startedAt) && fin(c.j?.endedAt)).map((c) => (c.j.endedAt - c.j.startedAt) / 1000).sort((x, y) => x - y);
    const per = took.length ? took[Math.floor(took.length / 2)] : null;
    const waiting = cells.filter((c) => c.k === 'queued').length;
    const left = runs.reduce((a, c) => a + (fin(c.j.progress?.etaS) ? c.j.progress.etaS : fin(per) ? per * (1 - c.p) : 0), 0) + (fin(per) ? waiting * per : 0);
    const etaS = runs.length || waiting ? left / Math.max(1, runs.length) : null;
    out.push({ ...g, cells, done, running: runs.length, queued: waiting, failed: cells.filter((c) => c.k === 'failed').length, cancelled: cells.filter((c) => c.k === 'cancelled').length, pct, etaS, title: `${g.format === 'flat' ? '16:9' : 'Dome'} ${g.size ? `${g.size}${g.format === 'flat' ? ' px' : '²'}` : ''} · ${num(from0, 0)}–${num(to1, 0)} s` });
  }
  // the newest of each format, the dome first
  const best = (f) => out.filter((g) => g.format === f).sort((x, y) => y.firstAt - x.firstAt)[0];
  return [best('dome'), best('flat')].filter(Boolean);
}
/**
 * a whole-show render's card in the hero (the user, 2026-10-30: the tracker "merges into the hero strip's 'Full show'
 * card … with its chunk cell strip inside"): its %, its chunks by state, done, failed, cancelled, the time left
 */
function showRenderCard(g, d, half) {
  const strip = `<div class="sg-cells" style="grid-template-columns:repeat(${g.cells.length},minmax(0,1fr))" role="img" aria-label="${esc(`${g.title}: ${g.done} of ${g.cells.length} chunks done`)}">${g.cells.map((c) => `<i class="ck k-${c.k}" title="${esc(c.tip)}">${c.k === 'running' ? `<b style="transform:scaleX(${c.p.toFixed(3)})"></b>` : ''}</i>`).join('')}</div>`;
  const left = !g.running && !g.queued ? 'stopped' : fin(g.etaS) ? `~${durCoarse(g.etaS)} left (${clock(d.now + g.etaS * 1000)})` : '';
  const sub = `${g.done}/${g.cells.length} chunks${g.running ? `, ${g.running} rendering` : ''}${g.failed ? `, <span class="bad">${g.failed} failed</span>` : ''}${g.cancelled ? `, ${g.cancelled} cancelled` : ''}${left ? `, ${esc(left)}` : ''}`;
  // (two renders at once: two half-height cards, each one line — its %, which render, how it stands — over its strip)
  if (half) return `<div class="hc hc-show half${g.running ? ' lit' : ''}" data-key="${esc(g.dir)}" title="${esc(g.dir)}"><div class="sh1"><span class="shv">${nspan(g.pct)}<small>%</small></span><b class="one">${esc(g.title)}</b><span class="hs one">${sub}</span></div>${strip}</div>`;
  return `<div class="hc hc-show${g.running ? ' lit' : ''}" data-key="${esc(g.dir)}" title="${esc(g.dir)}"><div class="hk one">Full show, ${esc(g.title)}</div><div class="hv">${nspan(g.pct)}<small>%</small><span class="hs one">${sub}</span></div>${strip}</div>`;
}
function renderShow(d, shows) {
  $('show-p').classList.toggle('hidden', !shows.length);
  morph($('show'), shows.map((g) => `<div class="sg" data-key="${esc(g.dir)}" title="${esc(g.dir)}"><div class="sg-h"><b class="one">${esc(g.title)}</b><span class="sg-pct">${nspan(g.pct)}<small>%</small></span></div>`
    + `<div class="sg-cells" style="grid-template-columns:repeat(${g.cells.length},minmax(0,1fr))">${g.cells.map((c) => `<i class="ck k-${c.k}" title="${esc(c.tip)}">${c.k === 'running' ? `<b style="transform:scaleX(${c.p.toFixed(3)})"></b>` : ''}</i>`).join('')}</div>`
    + `<div class="sg-s one">${g.done} done · ${g.running} rendering · ${g.queued} queued${g.failed ? ` · <span class="bad">${g.failed} failed</span>` : ''}${g.cancelled ? ` · ${g.cancelled} cancelled` : ''}${!g.running && !g.queued ? ' · stopped' : fin(g.etaS) ? ` · ~${esc(durCoarse(g.etaS))} left (${clock(d.now + g.etaS * 1000)})` : ''}</div></div>`).join(''));
  $('show-meta').textContent = shows.length ? 'chunks by state' : '';
}

// ------------------------------------------------------------------------------------------- v3: the timeline
/**
 * THE LAST HOURS, a timeline you can read (the user, 2026-10-30, on the first one: "impossible for me to see what's
 * happening, it's all tiny, there's no hover cards and no way to zoom in or filter"). The farm's jobs are short —
 * stills of 20–90 s — so on a fixed 3 h axis they were slivers. Now:
 *   - ZOOM AND PAN: 15 m · 1 h · 3 h · 12 h (remembered in this browser), the wheel or a pinch zooms around the
 *     pointer, a drag pans, a double-click resets. While it follows now, now sits near the right edge and the night
 *     glides left (the tracks animate between polls: a transform, nothing laid out again); pan back and it stops
 *     following, with "Back to now" to return. The ticks step 1 / 5 / 15 / 30 min, 1 h, 3 h with the zoom
 *   - READABLE BARS: never narrower than BAR_MIN px; a label only where it fits whole (no "R." fragments); a run of
 *     small back-to-back jobs of one agent is ONE bar with its count ("8 stills"), which splits as you zoom in
 *   - A CARD on hover or focus — the job, its agent, machine, times, frames, fps, state, exit or error, its output's
 *     thumbnail — pinned by a click or a tap, with its output and its row in the queue
 *   - FILTERS: the agents (the legend's chips), the farm or this Mac, cancelled jobs — dimmed, not removed, so
 *     nothing moves
 *   - A FOCUS LANE: a machine's name opens its lane tall with full labels; the others shrink so the panel keeps its
 *     height
 * Under each lane the machine's GPU use (teal ours, amber someone else's, grey idle); below, the throughput stacked
 * by machine and the queue's depth, on the same axis.
 */
const TL_KEY = 'drift-console-timeline';
const TL_RANGES = [['15 m', 15 * 60e3], ['1 h', 3600e3], ['3 h', 3 * 3600e3], ['12 h', 12 * 3600e3]];
const TL_MIN_SPAN = 5 * 60e3;
const TL_MAX_SPAN = 24 * 3600e3;
/** the share of the window right of now while following: the now line and the running jobs' ETAs show */
const TL_AHEAD = 0.06;
/** px: the narrowest bar drawn; the narrowest that carries its label; a group's count alone; a "small" job (groups) */
const BAR_MIN = 6;
const LABEL_MIN = 70;
const BADGE_MIN = 24;
const SMALL_PX = 16;
/** px: a lane, and a focused one (the lanes keep their total height) */
const LANE_H = 31;
const FOCUS_H = 76;
/** the agents' colours, in the validated order (dataviz validate_palette: dark, all checks pass); past six: grey */
const AGENT_N = 6;
const AGENTS = new Map();
const agentIdx = (a) => {
  if (!a) return -1;
  if (!AGENTS.has(a)) AGENTS.set(a, AGENTS.size);
  const i = AGENTS.get(a);
  return i < AGENT_N ? i : -1;
};
const TL = (() => {
  let s = {};
  try {
    s = JSON.parse(localStorage.getItem(TL_KEY) ?? '{}');
  } catch {
    // (none kept: the defaults)
  }
  return {
    span: TL_RANGES.some(([, v]) => v === s.span) ? s.span : 3600e3, follow: true, end: 0,
    hidden: new Set(s.hidden ?? []), source: ['all', 'farm', 'local'].includes(s.source) ? s.source : 'all', hideCancelled: s.hideCancelled === true, focus: s.focus ?? null,
    data: null, items: new Map(), w0: 0, k: 0, card: null, pinned: null, hover: null,
  };
})();
const saveTL = () => {
  try {
    localStorage.setItem(TL_KEY, JSON.stringify({ span: TL_RANGES.some(([, v]) => v === TL.span) ? TL.span : 3600e3, hidden: [...TL.hidden], source: TL.source, hideCancelled: TL.hideCancelled, focus: TL.focus }));
  } catch {
    // (not kept: fine)
  }
};
/** the track's width in px (the lanes' right column), kept by a ResizeObserver */
let tlW = 0;

/** the tick step for a window: the smallest whose labels stand ≥ 72 px apart */
const tickStep = (span, w) => [60e3, 300e3, 900e3, 1800e3, 3600e3, 3 * 3600e3, 6 * 3600e3].find((s) => (s / span) * w >= 72) ?? 6 * 3600e3;

/** a lane's bars: jobs in start order, a run of small back-to-back jobs of one agent merged into one item */
function laneItems(list, k, now) {
  const items = [];
  for (const j of list) {
    const a = j.startedAt;
    const b = j.lane === 'running' ? now : j.endedAt ?? now;
    const small = j.lane !== 'running' && (b - a) * k < SMALL_PX;
    const last = items.at(-1);
    if (last && last.small && small && last.agent === (j.submitter ?? null) && a - last.b < Math.max(90e3, 12 / k)) {
      last.jobs.push(j);
      last.b = Math.max(last.b, b);
      continue;
    }
    items.push({ jobs: [j], a, b, agent: j.submitter ?? null, small });
  }
  return items;
}
const nounOf = (jobs) => {
  const k = jobs.filter((j) => j.kind === 'still').length > jobs.length / 2 ? 'still' : jobs.filter((j) => j.kind === 'clip').length > jobs.length / 2 ? 'clip' : 'job';
  return `${k}s`;
};
/** is a job filtered out (dimmed): its agent hidden, the other source, a cancelled one */
const dimmed = (j) => (j.submitter && TL.hidden.has(j.submitter)) || (TL.source === 'farm' && j.source !== 'farm') || (TL.source === 'local' && j.source === 'farm') || (TL.hideCancelled && j.state === 'cancelled');

function renderTimeline(d, jobs) {
  TL.data = { d, jobs };
  tlRender();
}

function tlRender(animateFrom) {
  if (!TL.data) return;
  const { d, jobs } = TL.data;
  const now = d.now;
  if (!tlW) tlW = Math.max(200, ($('tl').clientWidth || 900) - 8.2 * 16);
  const W = tlW;
  const end = TL.follow ? now + TL.span * TL_AHEAD : TL.end;
  const w0 = end - TL.span;
  const k = W / TL.span;
  const prevW0 = TL.w0;
  TL.w0 = w0;
  TL.k = k;
  const X = (t) => (t - w0) * k;
  const ms = machinesOf(d);
  const keyOf = (j) => ms.find((m) => m.key === j.machine || splitName(m.name).name === j.machine)?.key;
  const lanes = new Map(ms.map((m) => [m.key, []]));
  const near = jobs.filter((j) => fin(j.startedAt) && j.lane !== 'queued' && (j.lane === 'running' ? now : j.endedAt ?? now) >= w0 - TL.span * 0.25 && j.startedAt <= end + TL.span * 0.25).sort((a, b) => a.startedAt - b.startedAt);
  for (const j of near) agentIdx(j.submitter);
  for (const j of near) lanes.get(keyOf(j))?.push(j);
  const n = ms.length;
  const focusOn = TL.focus && lanes.has(TL.focus);
  const laneH = (key) => (!focusOn ? LANE_H : key === TL.focus ? FOCUS_H : (LANE_H * n - FOCUS_H) / Math.max(1, n - 1));
  // the heat strips' and the charts' samples: the 15 s ring for a short window, the 60 s ring (3 h) for a long one
  const ring = TL.span <= 45 * 60e3 && hist?.util ? { util: hist.util, fleet: hist.fleet, stepS: hist.stepS } : hist?.long?.util ? hist.long : hist;
  const stepMs = (ring?.stepS ?? 15) * 1000;
  TL.items = new Map();
  let h = '';
  for (const m of ms) {
    const { name } = splitName(m.name);
    const lh = laneH(m.key);
    const tall = focusOn && m.key === TL.focus;
    const thin = focusOn && !tall;
    const bars = laneItems(lanes.get(m.key), k, now).map((it) => {
      const g = it.jobs.length > 1;
      const j = it.jobs[0];
      const key = g ? `grp:${j.key}` : j.key;
      TL.items.set(key, { ...it, machine: m });
      // (a bar that began before the window starts at its edge, so its label is whole)
      const a = Math.max(it.a, w0);
      const x = X(a);
      const w = Math.max(BAR_MIN, X(it.b) - x);
      const ai = agentIdx(it.agent);
      const states = new Set(it.jobs.map((x) => (x.lane === 'running' ? 'running' : x.state)));
      const st = states.has('running') ? 'running' : states.has('failed') ? 'failed' : states.size === 1 ? [...states][0] : 'done';
      const dim = it.jobs.every(dimmed);
      const low = it.jobs.every((x) => x.priority === 'low');
      const label = g ? (w >= LABEL_MIN ? `${it.jobs.length} ${nounOf(it.jobs)}` : w >= BADGE_MIN ? `${it.jobs.length}` : '') : w >= LABEL_MIN ? j.name : '';
      const sub = tall && !g && w >= LABEL_MIN ? `${it.agent ?? ''}${it.agent ? ' · ' : ''}${dur(((j.endedAt ?? now) - j.startedAt) / 1000)}` : '';
      let bar = `<button type="button" class="gb a${ai} st-${st}${low ? ' low' : ''}${g ? ' grp' : ''}${dim ? ' dim' : ''}${label ? '' : ' bare'}" data-key="${esc(key)}" data-tlk="${esc(key)}" style="left:${x.toFixed(1)}px;width:${w.toFixed(1)}px" aria-label="${esc(g ? `${it.jobs.length} ${nounOf(it.jobs)} by ${it.agent ?? 'no agent'}` : `${j.name}, ${j.state}`)}">${label ? `<span class="gl">${esc(label)}</span>` : ''}${sub ? `<span class="gs">${esc(sub)}</span>` : ''}</button>`;
      if (!g && j.lane === 'running' && fin(j.etaS) && j.etaS > 0) bar += `<i class="gb-eta a${ai}${dim ? ' dim' : ''}" data-key="${esc(key)}:eta" style="left:${X(now).toFixed(1)}px;width:${Math.max(0, X(now + j.etaS * 1000) - X(now)).toFixed(1)}px"></i>`;
      return bar;
    }).join('');
    const cells = (ring?.util?.[m.key] ?? []).filter((r) => r[0] >= w0 - stepMs && r[0] <= end).map((r) => {
      const [t, u, , others, badge] = r;
      if (badge === 'offline' || !fin(u)) return '';
      const who = /^rendering|^syncing/.test(badge) ? 'ours' : badge === 'busy-foreign' || badge === 'waiting-foreign' || (u >= 10 && (others ?? 0) > 1) ? 'foreign' : 'idle';
      return `<rect class="${who}" x="${X(t).toFixed(1)}" y="0" width="${(stepMs * k + 0.4).toFixed(1)}" height="1" fill-opacity="${(0.18 + (0.82 * Math.min(100, u)) / 100).toFixed(2)}"/>`;
    }).join('');
    const live = /^rendering/.test(m.badge);
    h += `<button type="button" class="tl-lab${tall ? ' on' : ''}" data-focus="${esc(m.key)}" style="height:${lh.toFixed(1)}px" title="${esc(tall ? 'back to all lanes' : `${m.name}: open its lane`)}"><i class="live-dot${live ? ' on' : ''}" aria-hidden="true"></i><span class="one">${esc(name)}</span></button>`;
    h += `<div class="tl-lane${tall ? ' tall' : ''}${thin ? ' thin' : ''}" data-key="lane:${esc(m.key)}" style="height:${lh.toFixed(1)}px"><div class="tl-trk">${bars}</div><svg class="tl-heat tl-trk" viewBox="0 0 ${W.toFixed(0)} 1" preserveAspectRatio="none" aria-label="${esc(`${name}: GPU use`)}">${cells}</svg></div>`;
  }
  // the fleet's throughput, stacked by machine (frames/min), and the queue's depth
  const rows = ms.map((m) => (ring?.util?.[m.key] ?? []).filter((r) => r[0] >= w0 - stepMs && r[0] <= end + stepMs));
  const len = Math.max(0, ...rows.map((r) => r.length));
  let chart = '';
  let nowFpm = 0;
  if (len > 1) {
    const ts = rows.find((r) => r.length === len).map((r) => r[0]);
    const vals = rows.map((r) => ts.map((t, i) => (fin(r[i]?.[5]) ? r[i][5] * 60 : 0)));
    const tops = ts.map((_, i) => vals.reduce((a, v) => a + v[i], 0));
    const max = Math.max(60, ...tops) * 1.1;
    nowFpm = tops.at(-1);
    const Y = (v) => (48 - (v / max) * 46).toFixed(1);
    let floor = ts.map(() => 0);
    vals.forEach((v, kk) => {
      const top = floor.map((b, i) => b + v[i]);
      if (top.some((t, i) => t !== floor[i])) {
        const up = ts.map((t, i) => `${X(t).toFixed(1)},${Y(top[i])}`).join(' ');
        const down = ts.map((t, i) => `${X(t).toFixed(1)},${Y(floor[i])}`).reverse().join(' ');
        chart += `<polygon class="tp m${kk}" points="${up} ${down}"><title>${esc(`${splitName(ms[kk].name).name}: ${Math.round(v.at(-1))} frames/min now`)}</title></polygon>`;
      }
      floor = top;
    });
  }
  const fl = (ring?.fleet ?? []).filter((r) => r[0] >= w0 - stepMs && r[0] <= end);
  const qmax = Math.max(4, ...fl.map((r) => r[1]));
  const q = fl.map((r) => `${X(r[0]).toFixed(1)},${(29 - (r[1] / qmax) * 26).toFixed(1)}`).join(' ');
  const qNow = jobs.filter((j) => j.lane === 'queued').length;
  h += `<div class="tl-lab ch"><span>Throughput</span><b>${nspan(nowFpm)}</b><small>f/min</small></div><div class="tl-chart"><svg class="tl-trk" viewBox="0 0 ${W.toFixed(0)} 50" preserveAspectRatio="none" role="img" aria-label="frames per minute, stacked by machine">${chart}</svg><i class="base"></i></div>`;
  h += `<div class="tl-lab ch"><span>Queue</span><b>${nspan(qNow)}</b><small>jobs</small></div><div class="tl-chart q"><svg class="tl-trk" viewBox="0 0 ${W.toFixed(0)} 30" preserveAspectRatio="none" role="img" aria-label="jobs waiting over time">${q ? `<polyline points="${q}"/>` : ''}</svg><i class="base"></i></div>`;
  // the ticks: a step for the zoom, a label on each (an hour's in ink)
  const step = tickStep(TL.span, W);
  let ticks = '';
  for (let t = Math.ceil((w0 - step) / step) * step; t <= end + step; t += step) {
    const x = X(t);
    if (x < 20 || x > W - 20) continue;
    ticks += `<span class="${t % 3600e3 === 0 ? 'hr' : ''}" style="left:${x.toFixed(1)}px">${clock(t)}</span>`;
  }
  h += `<div class="tl-lab tl-axis"></div><div class="tl-ticks"><div class="tl-trk">${ticks}</div></div>`;
  const nx = X(now);
  h += `<div class="tl-now${nx < 0 || nx > W ? ' gone' : ''}" style="transform:translateX(${nx.toFixed(1)}px)" aria-hidden="true"><span>now ${clock(now)}</span></div>`;
  morph($('tl'), h);
  // following now: the tracks glide from where they were to where they are (a transform on the compositor, 3 s)
  if (animateFrom !== false && TL.follow && prevW0 && !CALM) {
    const dx = (w0 - prevW0) * k;
    if (dx > 0 && dx < W / 3) for (const el of $('tl').querySelectorAll('.tl-trk')) el.animate([{ transform: `translateX(${dx.toFixed(1)}px)` }, { transform: 'none' }], { duration: POLL_MS, easing: 'linear' });
  }
  // the controls: the range, the source, cancelled jobs, back to now; the agents' chips
  const rangeOn = TL_RANGES.find(([, v]) => Math.abs(v - TL.span) < 1000)?.[1];
  morph($('tl-ctl'), `<span class="seg" role="group" aria-label="Time range">${TL_RANGES.map(([w, v]) => `<button type="button" class="sb${v === rangeOn ? ' cur' : ''}" data-range="${v}" aria-pressed="${v === rangeOn}">${w}</button>`).join('')}</span>`
    + `<span class="seg" role="group" aria-label="Which jobs">${[['all', 'All'], ['farm', 'Farm'], ['local', 'This Mac']].map(([v, w]) => `<button type="button" class="sb${TL.source === v ? ' cur' : ''}" data-source="${v}" aria-pressed="${TL.source === v}">${w}</button>`).join('')}</span>`
    + `<button type="button" class="sb solo${TL.hideCancelled ? ' cur' : ''}" data-cancelled="1" aria-pressed="${TL.hideCancelled}" title="dim the cancelled jobs">Hide cancelled</button>`
    + `<button type="button" class="sb now${TL.follow ? ' off' : ''}" data-tonow="1" ${TL.follow ? 'tabindex="-1" aria-hidden="true"' : ''}>Back to now</button>`);
  const used = [...new Set(near.map((j) => j.submitter).filter(Boolean))].sort((a, b) => agentIdx(a) - agentIdx(b) || a.localeCompare(b));
  morph($('agents'), used.length ? used.map((a) => `<button type="button" class="ag${TL.hidden.has(a) ? ' off' : ''}" data-key="${esc(a)}" data-agent="${esc(a)}" aria-pressed="${!TL.hidden.has(a)}" title="${esc(`${TL.hidden.has(a) ? 'show' : 'dim'} ${a}’s jobs`)}"><i class="a${agentIdx(a)}"></i><span class="one">${esc(a)}</span></button>`).join('') : '<span class="ag none" data-key="none">no jobs in this window</span>');
  $('time-meta').textContent = `${clock(w0)}–${clock(end)}${TL.follow ? '' : ', paused'}`;
  if (TL.card && TL.card.dataset.key) showCard(TL.card.dataset.key, null, true);
}

// ------------------------------------------------------------------------------------- the timeline's card
/** the card for a bar (a job, or a run of them): what it is, who sent it, where and when, how it went, its output */
function cardHtml(key) {
  const it = TL.items.get(key);
  if (!it) return '';
  const now = TL.data.d.now;
  const pinned = TL.pinned === key;
  const g = it.jobs.length > 1;
  const close = pinned ? '<button type="button" class="cc-x" data-cardclose="1" aria-label="Close">×</button>' : '';
  if (g) {
    const done = it.jobs.filter((j) => j.state === 'done').length;
    const bad = it.jobs.filter((j) => j.state === 'failed').length;
    const rows = it.jobs.slice(0, 10).map((j) => `<div class="cc-r"><span class="mono">${clock(j.startedAt, true)}</span><span class="one">${esc(j.name)}</span><span>${fin(j.renderS) ? dur(j.renderS) : DASH}</span>${chip(j.lane === 'running' ? 'rendering' : j.state)}</div>`).join('');
    return `<div class="cc-h">${close}<b>${it.jobs.length} ${nounOf(it.jobs)}</b><span class="one">${esc(it.agent ?? 'no agent named')} on ${esc(splitName(it.machine.name).name)}</span></div>`
      + `<div class="cc-s">${clock(it.a)}–${clock(it.b)}, ${dur((it.b - it.a) / 1000)}; ${done} done${bad ? `, <span class="bad">${bad} failed</span>` : ''}</div><div class="cc-list">${rows}${it.jobs.length > 10 ? `<div class="cc-r muted">and ${it.jobs.length - 10} more</div>` : ''}</div>`
      + `<div class="cc-f">${pinned ? `<button type="button" class="sb" data-showjob="${esc(it.jobs[0].key)}">Show in the queue</button>` : '<span class="muted">zoom in to see each one; click to pin</span>'}</div>`;
  }
  const j = it.jobs[0];
  const media = (j.outs ?? []).find(isMedia);
  const thumb = media ? (isVideo(media) ? `<span class="cc-th vid">${icon('play')}</span>` : `<img class="cc-th" alt="" src="${fileUrl(media)}">`) : '';
  const row = (k2, v) => (v == null || v === '' ? '' : `<dt>${esc(k2)}</dt><dd>${v}</dd>`);
  const runS = fin(j.renderS) ? j.renderS : ((j.endedAt ?? now) - j.startedAt) / 1000;
  return `<div class="cc-h">${close}${chip(j.lane === 'running' ? 'rendering' : j.state)}<b class="one">${esc(j.name)}</b></div>`
    + `<div class="cc-b">${thumb}<dl>${row('Agent', esc(j.submitter ?? '—'))}${row('Machine', esc(splitName(it.machine.name).name))}${row('When', `${clock(j.startedAt, true)} – ${j.lane === 'running' ? 'now' : clock(j.endedAt, true)}`)}${row('Took', dur(runS))}${row('Waited', fin(j.waitS) ? dur(j.waitS) : '')}`
    + `${row('Frames', fin(j.done) ? `${num(j.done)}${fin(j.total) ? ` / ${num(j.total)}` : ''} ${esc(j.unit ?? '')}` : '')}${row('fps', fin(j.avgFps) ? num(j.avgFps, 2) : fin(j.fpsNow) ? num(j.fpsNow, 2) : '')}${row('Type', esc([j.kindWord, ...j.settings].join(', ')))}`
    + `${row('Exit', j.exit != null && j.exit !== '' ? esc(String(j.exit)) : '')}${row(j.state === 'failed' ? 'Error' : 'Note', j.error || j.why ? `<span class="${j.state === 'failed' ? 'bad' : ''}">${esc(j.error || j.why)}</span>` : '')}</dl></div>`
    + `<div class="cc-f">${pinned ? `${media ? `<a class="sb" href="${fileUrl(media)}" target="_blank" rel="noopener">Open output</a>` : ''}<button type="button" class="sb" data-showjob="${esc(j.key)}">Show in the queue</button>` : '<span class="muted">click to pin</span>'}</div>`;
}
/** show (or refresh) the card of `key` beside its bar; `refresh`: only its content, where it is */
function showCard(key, anchor, refresh) {
  if (!TL.card) {
    TL.card = document.createElement('div');
    TL.card.className = 'tlcard';
    TL.card.setAttribute('role', 'dialog');
    TL.card.addEventListener('pointerleave', () => !TL.pinned && hideCard(120));
    document.body.append(TL.card);
  }
  const html = cardHtml(key);
  if (!html) return hideCard(0);
  clearTimeout(TL.card.__hide);
  TL.card.dataset.key = key;
  TL.card.classList.toggle('pinned', TL.pinned === key);
  morph(TL.card, html);
  const bar = anchor ?? $('tl').querySelector(`[data-tlk="${CSS.escape(key)}"]`);
  if (!bar) return;
  if (refresh && TL.card.classList.contains('on')) return;
  const r = bar.getBoundingClientRect();
  const cw = TL.card.offsetWidth || 340;
  const ch = TL.card.offsetHeight || 220;
  const left = Math.max(8, Math.min(innerWidth - cw - 8, r.left + r.width / 2 - cw / 2));
  const top = r.top - ch - 10 > 8 ? r.top - ch - 10 : Math.min(innerHeight - ch - 8, r.bottom + 10);
  TL.card.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  TL.card.classList.add('on');
}
function hideCard(ms) {
  if (!TL.card) return;
  clearTimeout(TL.card.__hide);
  TL.card.__hide = setTimeout(() => {
    TL.card.classList.remove('on', 'pinned');
    delete TL.card.dataset.key;
    TL.pinned = null;
  }, ms);
}
/** the job's row in the queue: its tab, the row opened, scrolled to and flashed */
function showInQueue(key) {
  const j = TL.data?.jobs.find((x) => x.key === key);
  if (!j || !last) return;
  TL.pinned = null;
  hideCard(0);
  TAB = j.lane;
  SHOW_JOB = key;
  OPEN.add(`j:${key}`);
  renderJobs(last);
  readLogs();
  const row = $('jobs').querySelector(`.jr[data-key="${CSS.escape(key)}"]`);
  if (!row) return;
  row.scrollIntoView({ block: 'nearest', behavior: CALM ? 'auto' : 'smooth' });
  if (!CALM) row.animate([{ backgroundColor: 'rgba(56, 199, 176, .22)' }, { backgroundColor: 'transparent' }], { duration: 1600, easing: 'ease-out' });
}

// ------------------------------------------------------------------------------------- the timeline's hands
{
  const tl = $('tl');
  new ResizeObserver(() => {
    const w = Math.max(200, tl.clientWidth - 8.2 * 16);
    if (Math.abs(w - tlW) > 1) {
      tlW = w;
      tlRender(false);
    }
  }).observe(tl);
  let raf = 0;
  const redraw = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => tlRender(false));
  };
  /** the time under a pointer at client x */
  const timeAt = (cx) => TL.w0 + (cx - tl.querySelector('.tl-lane').getBoundingClientRect().left) / TL.k;
  const inTrack = (e) => {
    const lane = tl.querySelector('.tl-lane');
    return lane && e.clientX >= lane.getBoundingClientRect().left;
  };
  const zoomAt = (cx, factor) => {
    const now = TL.data.d.now;
    const span = Math.min(TL_MAX_SPAN, Math.max(TL_MIN_SPAN, TL.span * factor));
    if (TL.follow) TL.span = span; // (following: now stays put on the right)
    else {
      const t = timeAt(cx);
      const share = (t - TL.w0) / TL.span;
      const w0 = t - share * span;
      TL.span = span;
      TL.end = w0 + span;
      if (TL.end >= now + span * TL_AHEAD) TL.follow = true;
    }
    redraw();
  };
  tl.addEventListener('wheel', (e) => {
    if (!TL.data || !inTrack(e)) return;
    e.preventDefault();
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && !e.ctrlKey) {
      // a sideways swipe pans
      const now = TL.data.d.now;
      TL.end = (TL.follow ? now + TL.span * TL_AHEAD : TL.end) + e.deltaX / TL.k;
      TL.follow = TL.end >= now + TL.span * TL_AHEAD;
      redraw();
      return;
    }
    zoomAt(e.clientX, Math.exp(e.deltaY * (e.ctrlKey ? 0.012 : 0.0016)));
  }, { passive: false });
  // a drag pans (a press that does not move is a click: the card)
  let drag = null;
  tl.addEventListener('pointerdown', (e) => {
    if (!TL.data || !inTrack(e) || e.button !== 0 || e.pointerType === 'touch') return;
    drag = { x: e.clientX, end: TL.follow ? TL.data.d.now + TL.span * TL_AHEAD : TL.end, moved: false, id: e.pointerId };
  });
  tl.addEventListener('pointermove', (e) => {
    if (drag && e.pointerId === drag.id) {
      const dx = e.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) < 4) return;
      if (!drag.moved) {
        drag.moved = true;
        tl.setPointerCapture(e.pointerId);
        tl.classList.add('panning');
        hideCard(0);
      }
      const now = TL.data.d.now;
      TL.end = drag.end - dx / TL.k;
      TL.follow = TL.end >= now + TL.span * TL_AHEAD;
      redraw();
      return;
    }
    const bar = e.target.closest?.('.gb');
    if (!TL.pinned && bar && bar.dataset.tlk !== TL.hover) {
      TL.hover = bar.dataset.tlk;
      showCard(bar.dataset.tlk, bar);
    }
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const moved = drag.moved;
    drag = null;
    tl.classList.remove('panning');
    if (moved) tl.__noClick = true;
  };
  tl.addEventListener('pointerup', endDrag);
  tl.addEventListener('pointercancel', endDrag);
  tl.addEventListener('pointerout', (e) => {
    const bar = e.target.closest?.('.gb');
    if (bar && !bar.contains(e.relatedTarget) && !TL.card?.contains(e.relatedTarget) && !TL.pinned) {
      TL.hover = null;
      hideCard(160);
    }
  });
  tl.addEventListener('focusin', (e) => {
    const bar = e.target.closest?.('.gb');
    if (bar && !TL.pinned) showCard(bar.dataset.tlk, bar);
  });
  tl.addEventListener('focusout', (e) => {
    if (e.target.closest?.('.gb') && !TL.pinned && !TL.card?.contains(e.relatedTarget)) hideCard(160);
  });
  tl.addEventListener('dblclick', (e) => {
    if (!inTrack(e)) return;
    let s = {};
    try {
      s = JSON.parse(localStorage.getItem(TL_KEY) ?? '{}');
    } catch {
      // (the default)
    }
    TL.span = TL_RANGES.some(([, v]) => v === s.span) ? s.span : 3600e3;
    TL.follow = true;
    redraw();
  });
  tl.addEventListener('click', (e) => {
    if (tl.__noClick) {
      tl.__noClick = false;
      return;
    }
    const lab = e.target.closest('[data-focus]');
    if (lab) {
      TL.focus = TL.focus === lab.dataset.focus ? null : lab.dataset.focus;
      saveTL();
      tlRender(false);
      return;
    }
    const bar = e.target.closest('.gb');
    if (!bar) return;
    // a click (or a tap) pins the card; on the pinned bar, unpins it
    const key = bar.dataset.tlk;
    TL.pinned = TL.pinned === key ? null : key;
    showCard(key, bar);
    if (!TL.pinned) hideCard(0);
  });
  $('tl-ctl').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.range) {
      TL.span = Number(b.dataset.range);
      TL.follow = true;
      saveTL();
    } else if (b.dataset.source) {
      TL.source = b.dataset.source;
      saveTL();
    } else if (b.dataset.cancelled) {
      TL.hideCancelled = !TL.hideCancelled;
      saveTL();
    } else if (b.dataset.tonow) TL.follow = true;
    tlRender(false);
  });
  $('agents').addEventListener('click', (e) => {
    const b = e.target.closest('[data-agent]');
    if (!b) return;
    const a = b.dataset.agent;
    if (TL.hidden.has(a)) TL.hidden.delete(a);
    else TL.hidden.add(a);
    saveTL();
    tlRender(false);
  });
  // the card's own buttons; a click elsewhere, or Escape, lets a pinned card go
  document.addEventListener('click', (e) => {
    if (!TL.card) return;
    if (e.target.closest('[data-cardclose]')) return hideCard(0);
    const sj = e.target.closest('[data-showjob]');
    if (sj) return showInQueue(sj.dataset.showjob);
    if (TL.pinned && !TL.card.contains(e.target) && !e.target.closest('#tl')) hideCard(0);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && TL.card?.classList.contains('on')) hideCard(0);
    const bar = e.target.closest?.('.gb');
    if (bar && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      TL.pinned = bar.dataset.tlk;
      showCard(bar.dataset.tlk, bar);
    }
  });
}

// -------------------------------------------------------------------------------------------- polling, staleness
let last = null;
/** the server's answer as it came, before the pending actions are laid over it (last) */
let raw = null;
/** the newest /api/history (History): the machines over 30 min, this Mac's finished jobs */
let hist = null;
let histAt = 0;
let lastOkAt = 0;
let lastErr = '';
let timer = 0;
let mockMod = null;
/** an opened job's log lines, by its logRef ("farm=<id>", "slot=<n>"): { lines, at } */
const LOGS = new Map();

function render(d) {
  const jobs = allJobs(d);
  const shows = showGroups(d);
  renderHero(d, jobs, shows);
  renderFleet(d);
  renderTimeline(d, jobs);
  renderJobs(d);
  renderYou(d);
  renderStreams(d);
  renderOuts(d);
  syncPreviews();
  const main = document.querySelector('main');
  roll(main);
  pulses(main);
}

function renderLive() {
  const el = $('live');
  const mockTag = MOCK !== null ? `<span class="mocktag" title="?mock: fake machines, slots, farm jobs and history (mock.js)">Mock fleet data</span>` : '';
  if (!lastOkAt) {
    el.className = 'live stale';
    morph(el, `${mockTag}<span class="dot"></span><span class="lt">No answer from the dashboard server${lastErr ? ` (${esc(lastErr)})` : ''}. Retrying every 3 s.</span>`);
    return;
  }
  const age = Date.now() - lastOkAt;
  const stale = age > STALE_MS;
  el.className = `live${stale ? ' stale' : ''}`;
  morph(el, `${mockTag}<span class="dot"></span><span class="lt">${stale ? `No answer for ${dur(age / 1000)}: showing the data of ${clock(last.now, true)}` : `Live, updated ${clock(last.now, true)}`}</span>`);
}

const getJson = async (path) => {
  const r = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};

/** the logs of the opened job rows (only those: one small request each per poll) */
async function readLogs() {
  if (!last) return;
  const open = allJobs(last).filter((j) => j.logRef && OPEN.has(`j:${j.key}`));
  await Promise.all(open.map(async (j) => {
    try {
      const lines = MOCK !== null ? mockMod.mockLog(j, Date.now()) : (await getJson(`/api/log?${j.logRef}&lines=200`)).lines;
      LOGS.set(j.logRef, { lines, at: Date.now() });
    } catch {
      // (kept: the last we read)
    }
  }));
  if (open.length) renderJobs(last);
}

async function tick() {
  clearTimeout(timer);
  if (document.hidden) return;
  if (CONFIRM && Date.now() > CONFIRM.until) CONFIRM = null;
  try {
    let d;
    if (MOCK !== null) {
      mockMod ??= await import('./mock.js');
      let real = null;
      try {
        real = await getJson('/api');
      } catch {
        // (mock without a server: its own streams and outputs)
      }
      raw = mockMod.mockStatus(Date.now(), MOCK || 'default', real);
      d = overlay(structuredClone(raw));
      if (Date.now() - histAt > HISTORY_MS) {
        hist = mockMod.mockHistory(Date.now(), MOCK || 'default');
        histAt = Date.now();
      }
    } else {
      const wantHist = Date.now() - histAt > HISTORY_MS;
      const [a, h] = await Promise.all([getJson('/api'), wantHist ? getJson('/api/history').catch(() => null) : null]);
      raw = a;
      d = overlay(structuredClone(raw));
      if (h) {
        hist = h;
        histAt = Date.now();
      }
    }
    last = d;
    lastOkAt = Date.now();
    lastErr = '';
    render(d);
    readLogs();
  } catch (e) {
    lastErr = e?.name === 'TimeoutError' ? 'no answer in 5 s' : String(e?.message ?? e);
  }
  renderLive();
  if (!document.hidden) timer = setTimeout(tick, POLL_MS);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(timer);
  else tick();
});
tick();
