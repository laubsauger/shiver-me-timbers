/**
 * THE STUDIO CONSOLE'S SCRIPT (served by scripts/drift-dash.mjs; the /api contract is the JSDoc block at the top of
 * that file). One screen: the fleet's tiles, every render job in one table (this Mac's slots, the farm's queue, a
 * box's own drift-node run), the agents' work streams, what waits on the user, the newest outputs.
 *
 * LIGHT ON THE MACHINE (the user, 2026-10-29: "doesn't take enough resources"): plain JS, no framework, no build, no
 * CDN (it must work offline on the tailnet). One GET /api every 3 s, none while the tab is hidden. Each section is
 * rendered to an HTML string and MORPHED into the page (morph() below): only the text and attributes that changed are
 * touched, rows are matched by data-key, so a thumbnail's <img> or <video> is never rebuilt, a progress bar's width
 * animates instead of jumping, and an opened row stays open.
 *
 * WORDS, NOT COMMANDS (the user, on the first page: "raw command lines as titles"): a job is named by humanJob(), e.g.
 * "Waterline clip 642–650 s · 1280 px"; the full command, its output path and its newest log line are in the row's
 * details. Everything that would wrap is one line with an ellipsis and its full text on hover or when opened (the
 * user, 2026-10-29: "the tags and stuff don't take up so much space and … the subtitle line doesn't wrap").
 *
 * ?mock fakes the machines, slots and farm jobs (mock.js) to judge the design before the boxes report; ?mock=yield a
 * second set of states (syncing, waiting, offline). The work streams and outputs stay real when /api answers.
 */

const POLL_MS = 3000;
/** ms without an answer before the header says the data is stale */
const STALE_MS = 9000;
/** finished jobs listed (the newest) */
const RECENT_MAX = 8;
const MOCK = new URLSearchParams(location.search).get('mock');

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fin = (x) => typeof x === 'number' && Number.isFinite(x);
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
const clock = (ms, secs) => new Date(ms).toLocaleTimeString([], secs ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
const toMs = (t) => (typeof t === 'number' ? t : t ? Date.parse(t) : NaN);
/** GB to one decimal, a whole number without its ".0" */
const gb = (x) => (fin(x) ? String(Math.round(x * 10) / 10) : '–');
const pct = (part, whole) => (fin(part) && fin(whole) && whole > 0 ? Math.max(0, Math.min(100, (100 * part) / whole)) : 0);
const base = (p) => String(p ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';
const parent = (p) => base(String(p ?? '').replace(/[\\/][^\\/]*$/, ''));
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
/** inline `code` in work.json's free text */
const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
const fileUrl = (p, v) => `/file?p=${encodeURIComponent(p)}${v ? `&v=${Math.round(v)}` : ''}`;
const isMedia = (p) => /\.(png|jpe?g|webp|mp4)$/i.test(String(p ?? ''));

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
  waiting: ['yield', 'pause', 'Waiting', 'waiting'],
  syncing: ['sync', 'sync', 'Syncing', 'pulling code and assets'],
  uploading: ['sync', 'sync', 'Uploading', 'sending its inputs to the box'],
  preparing: ['sync', 'sync', 'Preparing', 'the box is getting ready'],
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
    .filter((w) => w && !/^\d+(px|k|kpx|p|s|fps)?$/i.test(w) && !/^(clip|clips|stills?|shots?|review|out|frames?|final|test)$/i.test(w));
  return words.join(' ');
}
const span = (a, b) => (a != null && b != null ? `${a}–${b} s` : '');
const joinDot = (...p) => p.filter(Boolean).join(' · ');
const flagOf = (cmd, k) => String(cmd ?? '').match(new RegExp(`--${k}[= ](\\S+)`))?.[1];

/**
 * a job in a few words, from its command (or the server's short label, or a farm job's label): what it makes, of
 * what, over which span and at what size. Never a path: those are in the row's details.
 */
function humanJob(src) {
  const s = String(src ?? '').replace(/^\d{4}-\d\d-\d\dT\S+\s+/, '').trim(); // (a slot log's first line: its timestamp, then the command)
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
    const args = s.split(/\s+/).slice(s.split(/\s+/).findIndex((w) => w.includes('drift-review-stills')) + 1).filter((w) => !w.startsWith('-'));
    const shots = args.find((w) => /\.json$/.test(w));
    const outDir = args.filter((w) => !/^\d+$/.test(w) && w !== shots).pop();
    return joinDot(`${cap(subject(shots) || subject(outDir) || 'review')} stills`, px(args.find((w) => /^\d+$/.test(w))));
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
  for (const a of [...cur.attributes]) if (!n.hasAttribute(a.name)) cur.removeAttribute(a.name);
  for (const a of n.attributes) if (cur.getAttribute(a.name) !== a.value) cur.setAttribute(a.name, a.value);
  // (a thumbnail's media: same src, same element — never reloaded)
  if (cur.nodeName === 'IMG' || cur.nodeName === 'VIDEO') return;
  patchChildren(cur, n);
}

/** rows the user opened, by key (kept across polls) */
const OPEN = new Set();

// ---------------------------------------------------------------------------------------------------- the fleet
function machinesOf(d) {
  if (Array.isArray(d.machines)) return d.machines;
  return d.fleet?.cards ?? []; // (a server from before machines[])
}

const gauge = (k, v, unit, meterPct, hot, tip) =>
  `<div class="g${hot ? ' hot' : ''}"${tip ? ` title="${esc(tip)}"` : ''}><span class="g-k">${esc(k)}</span><span class="g-v">${v}${unit ? `<small>${unit}</small>` : ''}</span>${meterPct != null ? `<span class="meter"><b style="width:${meterPct.toFixed(1)}%"></b></span>` : ''}</div>`;

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

function tile(m, d) {
  const now = d.now;
  const [cls] = stateOf(m.badge);
  const { name, tag } = splitName(m.name);
  const g = m.gpu ?? {};
  const self = m.self === true;
  const mc = self ? d.machine ?? {} : null;
  const sub = [gpuShort(g.name || m.hint?.gpu), osName(m.os), m.tailnet].filter(Boolean);
  const subTip = [g.name || m.hint?.gpu, osName(m.os), m.tailnet && `tailnet ${m.tailnet}`, m.hint?.speed && `renders at ${m.hint.speed}× a 4090`, m.hint?.battery && 'a laptop: renders on AC power only'].filter(Boolean).join(', ');
  let h = `<article class="tile s-${cls}${m.online ? '' : ' off'}" data-key="${esc(m.key)}">`;
  h += `<header class="t-head"><div class="t-name"><h3 title="${esc(m.name)}">${esc(name)}${tag ? `<span class="tag">${esc(tag)}</span>` : ''}</h3>`;
  h += `<div class="t-sub" title="${esc(subTip)}">${sub.map(esc).join('<span class="sep">·</span>')}</div></div>${chip(m.badge, m.why || undefined, true)}</header>`;
  h += '<div class="t-body">';

  if (!m.online) {
    const heard = m.seen ? `Last heard ${durCoarse((now - m.seen) / 1000)} ago` : 'Not reporting: no answer from its studio-manager agent and no heartbeat of ours';
    h += `<div class="t-why one" title="${esc(heard)}">${esc(heard)}</div>`;
    if (m.agentError) h += `<div class="t-why one muted" title="${esc(m.agentError)}">Agent: ${esc(m.agentError)}</div>`;
    if (m.hint) h += `<div class="t-why one muted">${esc([m.hint.speed && `${m.hint.speed}× a 4090`, m.hint.battery && 'laptop, renders on AC only'].filter(Boolean).join(', '))}</div>`;
    h += '</div>';
    h += lastRunFoot(m, now);
    return h + '</article>';
  }

  // why the badge says what it says, when it is not obvious
  if (m.badge === 'busy-foreign' && m.why) h += `<div class="t-why one" title="${esc(m.why)}"><b>Someone else’s:</b> ${esc(m.why)}</div>`;
  if (m.waiting?.why) h += `<div class="t-why one yield" title="${esc(m.waiting.why)}"><b>Yielding${toMs(m.waiting.since) ? ` since ${clock(toMs(m.waiting.since))}` : ''}:</b> ${esc(m.waiting.why)}</div>`;
  if (m.badge === 'rendering+shared') h += `<div class="t-why one" title="${esc(m.why ?? '')}"><b>Shared:</b> ${esc(m.why || 'a foreign load runs beside our render')}</div>`;

  // the gauges
  let gs = '';
  if (self) {
    const load = mc.load?.[0];
    const cpuPct = fin(load) && mc.cores ? (100 * load) / mc.cores : null;
    const ramPct = fin(m.ramPct) ? m.ramPct : fin(mc.memFreePct) ? 100 - mc.memFreePct : null;
    if (fin(g.utilPct)) gs += gauge('GPU', Math.round(g.utilPct), '%', g.utilPct, false);
    if (cpuPct != null) gs += gauge('CPU', Math.round(cpuPct), '%', Math.min(100, cpuPct), cpuPct > 100, `load ${load} on ${mc.cores} cores (5 min ${mc.load?.[1]}, 15 min ${mc.load?.[2]})`);
    if (ramPct != null) gs += gauge('RAM', Math.round(ramPct), '%', ramPct, ramPct >= 85, fin(mc.memFreePct) ? `memory free ${mc.memFreePct}% (memory_pressure)` : '');
    if (mc.power) gs += gauge('Power', esc(mc.power.replace(/^battery /, '')), mc.power.startsWith('battery') ? ' battery' : '', null, mc.power.startsWith('battery'));
  } else {
    if (fin(g.utilPct)) gs += gauge('GPU', Math.round(g.utilPct), '%', g.utilPct, false);
    if (fin(g.tempC)) gs += gauge('Temp', Math.round(g.tempC), ' °C', null, g.tempC >= 83);
    if (fin(g.powerW)) gs += gauge('Power', Math.round(g.powerW), fin(g.powerLimitW) ? ` / ${Math.round(g.powerLimitW)} W` : ' W', fin(g.powerLimitW) ? pct(g.powerW, g.powerLimitW) : null, false, fin(g.powerLimitW) ? `power limit ${Math.round(g.powerLimitW)} W` : '');
    if (fin(m.cpuPct)) gs += gauge('CPU', Math.round(m.cpuPct), '%', m.cpuPct, m.cpuPct >= 90);
    if (fin(m.ramPct)) gs += gauge('RAM', Math.round(m.ramPct), '%', m.ramPct, m.ramPct >= 90);
  }
  if (gs) h += `<div class="gauges">${gs}</div>`;

  // VRAM: ours | someone else's | free
  if (fin(g.totalGB) && g.totalGB > 0 && fin(g.usedGB)) {
    const ours = fin(g.oursGB) ? g.oursGB : 0;
    const others = fin(g.othersGB) ? g.othersGB : Math.max(0, g.usedGB - ours);
    const free = Math.max(0, g.totalGB - ours - others);
    h += `<div class="vram"><div class="vk"><span class="g-k">VRAM</span><span class="g-v">${gb(g.usedGB)}<small> / ${gb(g.totalGB)} GB</small></span></div>`;
    h += `<div class="vbar" role="img" aria-label="VRAM: ours ${gb(ours)} GB, others ${gb(others)} GB, free ${gb(free)} GB"><b class="ours" style="width:${pct(ours, g.totalGB).toFixed(1)}%"></b><b class="foreign" style="width:${pct(others, g.totalGB).toFixed(1)}%"></b></div>`;
    h += `<div class="legend"><span><i class="ours"></i>ours <b>${gb(ours)}</b></span><span><i class="foreign"></i>others <b>${gb(others)}</b></span><span><i></i>free <b>${gb(free)}</b></span></div></div>`;
  } else if (fin(g.usedGB)) {
    h += `<div class="vram"><div class="vk"><span class="g-k" title="Apple silicon: GPU memory is RAM, so there is no ours-or-others split">GPU memory, unified with RAM</span><span class="g-v">${gb(g.usedGB)}<small> GB</small></span></div></div>`;
  }

  // the Mac's own warnings: memory pressure, more load than cores
  if (self) {
    const warn = [];
    if (fin(mc.memFreePct) && mc.memFreePct < 15) warn.push(`memory ${mc.memFreePct}% free`);
    if (fin(mc.load?.[0]) && mc.cores && mc.load[0] > mc.cores) warn.push(`load ${mc.load[0]} on ${mc.cores} cores`);
    if (warn.length) h += `<div class="flag one" title="${esc(warn.join(', '))}">${icon('warn')}Overloaded<span>${esc(warn.join(', '))}</span></div>`;
  }

  // what else runs there
  if (self) {
    const procs = macProcs(mc.top).filter((p) => !/render\)$/.test(p.name)).slice(0, 3);
    if (procs.length) h += `<div class="also" title="${esc(macProcs(mc.top).map((p) => `${p.name}${p.n > 1 ? ` ×${p.n}` : ''}: ${Math.round(p.cpu)}% CPU, ${p.memMB} MB`).join('\n'))}"><span class="k">Busiest</span>${procs.map((p, i) => `<span class="svc i${i + 1}"><span class="nm">${esc(p.name)}${p.n > 1 ? ` ×${p.n}` : ''}</span><b>${Math.round(p.cpu)}%</b></span>`).join('')}</div>`;
  } else if (m.services?.length) {
    const svcs = [...m.services].sort((a, b) => (b.vramGB ?? -1) - (a.vramGB ?? -1));
    const shown = svcs.slice(0, 3);
    const more = svcs.length - shown.length;
    const all = svcs.map((s) => `${s.name} (${s.state}${fin(s.vramGB) ? `, ${gb(s.vramGB)} GB` : ''})`).join('\n');
    // (a narrow tile hides the third chip, app.css: so it has a count of its own that includes it)
    const count = (n, cls) => (n > 0 ? `<span class="svc more ${cls}">+${n}</span>` : '');
    h += `<div class="also" title="${esc(all)}"><span class="k">Also running</span>${shown.map((s, i) => `<span class="svc i${i + 1}"><span class="nm">${esc(s.name)}</span>${fin(s.vramGB) && s.vramGB >= 0.05 ? `<b>${gb(s.vramGB)} GB</b>` : ''}</span>`).join('')}${count(more, 'wide')}${count(more + (shown.length > 2 ? 1 : 0), 'narrow')}</div>`;
  }
  if (m.error) h += `<div class="flag one" title="${esc(m.error)}">${icon('x')}Failed<span>${esc(m.error)}</span></div>`;
  h += '</div>';

  // our job(s) there
  if (self) {
    const held = d.slots?.held ?? [];
    for (const s of held) h += tileJob({ name: humanJob(s.cmd || s.label), tip: s.cmd, done: s.done, total: s.total, unit: s.unit, rate: rateOf(s, now), etaS: s.etaS, label: `Slot ${s.slot}` }, now);
    const lim = d.slots?.limit;
    const waiting = d.slots?.waiting?.length ?? 0;
    if (!held.length) h += `<div class="t-job none">No render of ours${lim ? `: ${lim} slot${lim > 1 ? 's' : ''} free` : ''}${waiting ? `, ${waiting} waiting` : ''}</div>`;
    else if (waiting) h += `<div class="t-job none">${waiting} more waiting for a slot</div>`;
  } else {
    const fj = m.farm;
    const j = m.job;
    // (no rate while it yields: 0 fps says nothing)
    if (fj) h += tileJob({ name: humanJob(fj.label), tip: fj.label, done: fj.progress?.done, total: fj.progress?.total, unit: fj.progress?.unit, rate: fin(fj.progress?.fps) && fj.progress.fps > 0 ? `${fj.progress.fps.toFixed(2)} fps` : '', etaS: fj.progress?.etaS, label: 'Farm job' }, now);
    else if (j) h += tileJob({ name: cap(j.name), tip: j.out, done: j.frames, total: j.framesTotal, unit: 'frames', rate: fin(j.fps) && j.fps > 0 ? `${(+j.fps).toFixed(2)} fps` : '', etaS: j.etaS, label: j.chunks ? `Chunk ${j.chunk} of ${j.chunks}` : 'Our job' }, now);
    else h += `<div class="t-job none">${m.badge === 'ready' ? 'Free: no job of ours' : 'No job of ours'}</div>`;
  }
  h += lastRunFoot(m, now);
  return h + '</article>';
}

/** one job in a tile: its name, a bar, frames, rate, time left */
function tileJob(j, now) {
  const p = fin(j.total) && j.total > 0 ? pct(j.done ?? 0, j.total) : null;
  let h = `<div class="t-job"><div class="k one">${esc(j.label)}</div><div class="name one" title="${esc(j.tip ?? j.name)}">${esc(j.name)}</div>`;
  h += p != null ? `<div class="pbar"><b style="width:${p.toFixed(1)}%"></b></div>` : '<div class="pbar idle"><b></b></div>';
  const count = fin(j.total) ? `${j.done ?? 0} / ${j.total} ${j.unit ?? ''}` : fin(j.done) && j.done > 0 ? `${j.done} ${j.unit ?? ''} done` : 'starting: booting the page, compiling shaders';
  const meta = [`<span>${esc(count)}</span>`, j.rate ? `<span>${esc(j.rate)}</span>` : '', fin(j.etaS) ? `<span class="eta">${dur(j.etaS)} left</span>` : ''];
  return h + `<div class="meta one">${meta.join('')}</div></div>`;
}

function lastRunFoot(m, now) {
  const bits = [];
  if (m.seen && m.online) bits.push(`heard ${durCoarse((now - m.seen) / 1000)} ago`);
  if (m.lastRun) bits.push(`last run: ${m.lastRun.job ?? 'a job'}, ${m.lastRun.state}${m.lastRun.seen ? `, ${durCoarse((now - m.lastRun.seen) / 1000)} ago` : ''}`);
  if (m.commit) bits.push(`at ${m.commit}`);
  if (m.bundle) bits.push(`bundle ${m.bundle}`);
  if (m.online && m.agentError) bits.push(`<span class="err">agent: ${esc(m.agentError)}</span>`);
  if (!bits.length) return '';
  const text = bits.map((b) => (b.startsWith('<') ? b : esc(b)));
  return `<footer class="t-foot one" title="${esc(bits.join(', ').replace(/<[^>]+>/g, ''))}">${text.map((t) => `<span>${t}</span>`).join('')}</footer>`;
}

function renderFleet(d) {
  const ms = machinesOf(d);
  morph($('tiles'), ms.length ? ms.map((m) => tile(m, d)).join('') : '<div class="note" data-key="none">No machines listed (scripts/drift-farm-nodes.json).</div>');
  const online = ms.filter((m) => m.online).length;
  const ready = ms.filter((m) => m.badge === 'ready' || m.badge === 'idle').length;
  const ours = ms.filter((m) => /^rendering/.test(m.badge)).length;
  $('fleet-meta').textContent = ms.length ? `${online} of ${ms.length} online, ${ready} ready, ${ours} rendering ours` : '';
  // where the numbers come from, when a source is down
  // (machines[]: the hub is only asked when a box's own agent does not answer; the older fleet{}: always)
  const hub = d.sources?.hub ?? d.fleet?.hub;
  const hubDown = d.sources ? hub?.used === true && hub.ok === false : hub?.ok === false;
  const note = hubDown
    ? `<div class="note">studio-manager’s hub isn’t answering at <code>${esc(hub.url)}</code>${hub.error ? ` (${esc(hub.error)})` : ''}: a box without its own agent shows only our heartbeats. To start it: <code>cd ../studio-manager &amp;&amp; yarn studio</code></div>`
    : '';
  morph($('fleet-note'), note);
}

// ----------------------------------------------------------------------------------------------------- the jobs
/** a slot job's rate: a clip's newest fps, else seconds per still */
function rateOf(s, now) {
  const fps = String(s.last ?? '').match(/([\d.]+) fps/)?.[1];
  if (fps && /\d+\/\d+/.test(s.last)) return `${fps} fps`;
  if (s.unit === 'stills' && s.done > 0) return `${Math.round((now - s.started) / 1000 / s.done)} s/still`;
  return '';
}
const RANK = { running: 0, waiting: 1, syncing: 1, uploading: 1, preparing: 1, queued: 2, done: 3, failed: 3, cancelled: 3 };
const FINISHED = new Set(['done', 'failed', 'cancelled']);

/** every job in one list: this Mac's slots, the farm's queue, a box's own drift-node run, the recently finished */
function jobRows(d) {
  const now = d.now;
  const rows = [];
  const sl = d.slots ?? {};
  const ms = machinesOf(d);
  const mac = ms.find((m) => m.self);
  const macName = mac ? splitName(mac.name).name : 'This Mac';
  for (const h of sl.held ?? []) {
    const out = flagOf(h.cmd, 'out');
    rows.push({
      key: `slot:${h.slot}:${h.pid}`, where: macName, whereSub: `slot ${h.slot}`, what: humanJob(h.cmd || h.label), state: 'running',
      done: h.done, total: h.total, unit: h.unit, rate: rateOf(h, now), etaS: h.etaS, since: h.started,
      detail: [['Command', h.cmd], ['Output', out], ['Newest line', h.last], ['Process', `pid ${h.pid}, slot ${h.slot}`]],
    });
  }
  for (const w of sl.waiting ?? []) {
    rows.push({ key: `wait:${w.pid}`, where: macName, whereSub: 'waits for a slot', what: humanJob(w.cmd || w.label), state: 'queued', queuedAt: w.since, detail: [['Command', w.cmd || w.label], ['Process', `pid ${w.pid}`]] });
  }
  for (const j of d.farm?.jobs ?? []) rows.push(farmRow(j, ms));
  for (const m of ms) if (!m.self && m.job && !m.farm) rows.push(nodeRow(m));
  for (const r of sl.recent ?? []) {
    const named = String(r.label ?? '').match(/→\s+(\S+)/)?.[1];
    const out = r.out ?? (named ? d.outputs?.find((o) => o.name === named)?.path : undefined);
    rows.push({
      key: `rec:${r.ended}:${r.label}`, where: macName, whereSub: 'slot', what: humanJob(r.cmd || r.label), state: r.exit === '0' ? 'done' : 'failed',
      endedAt: r.ended, exit: r.exit, out, since: r.started, detail: [['Command', r.cmd || r.label], ['Exit', r.exit], ['Output', out]],
    });
  }
  const active = rows.filter((r) => !FINISHED.has(r.state)).sort((a, b) => RANK[a.state] - RANK[b.state] || (a.since ?? a.queuedAt ?? 0) - (b.since ?? b.queuedAt ?? 0));
  const done = rows.filter((r) => FINISHED.has(r.state)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).slice(0, RECENT_MAX);
  return { active, done };
}

function farmRow(j, ms) {
  const box = j.node ? ms.find((m) => m.key === j.node || m.name === j.node) : null;
  let state = j.state === 'running' ? 'running' : j.state;
  let why = j.error || null;
  // a running farm job whose box yields to someone else's load is waiting, not rendering
  if (j.state === 'running' && box?.badge === 'waiting-foreign') {
    state = 'waiting';
    why = box.waiting?.why ?? 'its box yields to someone else’s GPU use';
  }
  if (j.state === 'queued' && j.why) why = j.why;
  const out = (j.results ?? []).map((r) => r.path).find(isMedia);
  const p = j.progress ?? {};
  return {
    key: `farm:${j.id}`, where: j.node ?? 'Farm', whereSub: j.node ? 'farm' : j.prefer ? `asked for ${j.prefer}` : 'next free box', what: humanJob(j.label), state, why,
    done: p.done, total: p.total, unit: p.unit, rate: fin(p.fps) && p.fps > 0 && state === 'running' || FINISHED.has(state) && fin(p.fps) ? `${p.fps.toFixed(2)} fps` : '', etaS: p.etaS, since: j.startedAt ?? undefined, queuedAt: j.createdAt, endedAt: j.endedAt ?? undefined, estS: j.estS, exit: j.exitCode, out,
    detail: [['Farm job', `${j.id}${j.kind ? `, a ${j.kind}` : ''}`], ['Label', j.label], ['Based on', j.base], ['Box', j.node ?? (j.prefer ? `asked for ${j.prefer}` : 'not yet taken')], ['Newest line', j.last], ['Error', j.error], ['Results', (j.results ?? []).map((r) => r.path).join('\n')]],
  };
}

function nodeRow(m) {
  const j = m.job;
  const state = { 'waiting-foreign': 'waiting', syncing: 'syncing', failed: 'failed' }[m.badge] ?? 'running';
  return {
    key: `node:${m.key}:${j.name}`, where: m.name, whereSub: j.chunks ? `chunk ${j.chunk} of ${j.chunks}` : 'drift-node', what: cap(j.name), state, why: m.waiting?.why ?? m.error ?? null,
    done: j.frames, total: j.framesTotal, unit: 'frames', rate: fin(j.fps) ? `${(+j.fps).toFixed(2)} fps` : '', etaS: j.etaS, out: j.out,
    detail: [['Queue job', j.name], ['Output', j.out], ['Newest line', m.last], ['Error', m.error], ['Box', `${m.name}${m.commit ? ` at ${m.commit}` : ''}${m.bundle ? `, bundle ${m.bundle}` : ''}`]],
  };
}

const JHEAD = '<div class="jr jh" role="row" data-key="h"><div class="c" role="columnheader">Where</div><div class="c" role="columnheader">What</div><div class="c" role="columnheader">Progress</div><div class="c n" role="columnheader">Rate</div><div class="c n" role="columnheader">ETA</div><div class="c n" role="columnheader">Elapsed</div><div class="c st" role="columnheader">Status</div></div>';

function jobRow(r, now) {
  const k = `j:${r.key}`;
  const open = OPEN.has(k);
  const [cls] = stateOf(r.state === 'running' ? 'rendering' : r.state);
  const finished = FINISHED.has(r.state);
  let prog;
  if (finished) {
    const when = r.endedAt ? `${r.state === 'done' ? 'Finished' : r.state === 'failed' ? 'Failed' : 'Stopped'} ${durCoarse((now - r.endedAt) / 1000)} ago` : cap(r.state);
    const link = r.out && isMedia(r.out) ? `<a href="${fileUrl(r.out)}" target="_blank" rel="noopener">Open output</a>` : '';
    prog = `<div class="ptxt"><span class="one">${esc(when)}${r.state === 'failed' && r.exit != null && r.exit !== '' ? `, exit ${esc(r.exit)}` : ''}</span>${link}</div>`;
    if (r.why) prog += `<div class="why one" title="${esc(r.why)}">${esc(r.why)}</div>`;
  } else if (r.state === 'queued') {
    prog = `<div class="why one" title="${fin(r.estS) ? `expected run time on the fastest box: ${dur(r.estS)}` : ''}">In line ${durCoarse((now - (r.queuedAt ?? now)) / 1000) || '0 s'}${fin(r.estS) ? `, runs ~${durCoarse(r.estS)}` : ''}</div>`;
    if (r.why) prog += `<div class="why one" title="${esc(r.why)}">${esc(r.why)}</div>`;
  } else {
    // one line: the bar, then frames done of all (the percentage on hover)
    const p = fin(r.total) && r.total > 0 ? pct(r.done ?? 0, r.total) : null;
    prog = p != null
      ? `<div class="pline" title="${Math.floor(p)}%"><div class="pbar"><b style="width:${p.toFixed(1)}%"></b></div><span class="pt"><b>${r.done ?? 0}</b> / ${r.total} ${esc(r.unit ?? '')}</span></div>`
      : `<div class="pline"><div class="pbar idle"><b></b></div><span class="pt">${fin(r.done) && r.done > 0 ? `<b>${r.done}</b> ${esc(r.unit ?? '')} done` : r.state === 'running' ? 'starting' : esc(stateOf(r.state)[3])}</span></div>`;
    if (r.why) prog += `<div class="why one" title="${esc(r.why)}">${esc(r.why)}</div>`;
  }
  const elapsed = r.since ? ((finished ? r.endedAt ?? now : now) - r.since) / 1000 : null;
  const rate = r.rate ? r.rate.replace(/^([\d.]+)\s*(.*)$/, '$1<small> $2</small>') : '';
  let h = `<div class="jr s-${cls}${finished ? ' fin' : ''}" role="row" data-key="${esc(r.key)}">`;
  h += `<div class="c where one" role="cell" title="${esc(`${r.where} ${r.whereSub ?? ''}`)}"><b>${esc(r.where)}</b> <span>${esc(r.whereSub ?? '')}</span></div>`;
  h += `<div class="c what" role="cell"><button class="exp" type="button" data-open="${esc(k)}" aria-expanded="${open}" title="${esc(r.what)}">${icon('chev')}<span class="lbl one">${esc(r.what)}</span></button></div>`;
  h += `<div class="c prog" role="cell">${prog}</div>`;
  h += `<div class="c n rate" role="cell" data-k="Rate">${rate}</div>`;
  h += `<div class="c n eta" role="cell" data-k="ETA">${!finished && fin(r.etaS) ? dur(r.etaS) : ''}</div>`;
  h += `<div class="c n el" role="cell" data-k="${finished ? 'Ran' : 'Elapsed'}">${elapsed != null ? dur(elapsed) : ''}</div>`;
  h += `<div class="c st" role="cell">${chip(r.state === 'running' ? 'rendering' : r.state, r.why || undefined)}</div>`;
  if (open) h += `<dl class="detail">${r.detail.filter(([, v]) => v != null && v !== '').map(([dt, dd]) => `<dt>${esc(dt)}</dt><dd>${esc(dd)}</dd>`).join('')}</dl>`;
  return h + '</div>';
}

function renderJobs(d) {
  const { active, done } = jobRows(d);
  let h = JHEAD;
  h += active.length ? active.map((r) => jobRow(r, d.now)).join('') : '<div class="empty" role="row" data-key="none"><span role="cell">No render running or waiting. A free slot on this Mac and every ready box can take one.</span></div>';
  if (done.length) h += `<div class="jsep" role="row" data-key="sep"><span role="cell">Finished recently</span></div>${done.map((r) => jobRow(r, d.now)).join('')}`;
  morph($('jobs'), h);
  const n = (s) => active.filter((r) => s.includes(r.state)).length;
  const bits = [n(['running']) && `${n(['running'])} rendering`, n(['waiting', 'syncing', 'uploading', 'preparing']) && `${n(['waiting', 'syncing', 'uploading', 'preparing'])} starting or waiting`, n(['queued']) && `${n(['queued'])} queued`].filter(Boolean);
  const farm = d.farm ? (d.farm.enabled ? '' : 'farm queue off') : '';
  $('jobs-meta').textContent = [bits.join(', ') || 'nothing running', farm].filter(Boolean).join('; ');
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
function renderStreams(d) {
  const st = [...(d.work?.streams ?? [])].sort((a, b) => (STREAM_ORDER[a.state] ?? 6) - (STREAM_ORDER[b.state] ?? 6) || (toMs(b.since) || 0) - (toMs(a.since) || 0));
  const html = st.length
    ? `<div class="sl" data-key="list">${st.map((s) => {
        const k = `s:${s.title}`;
        const open = OPEN.has(k);
        const since = toMs(s.since);
        const tip = `${s.title}${s.eta ? ` (${s.eta})` : ''}${since ? `, since ${clock(since)}` : ''}`;
        return `<div class="sr${open ? ' open' : ''}${s.state === 'done' ? ' done' : ''}" data-key="${esc(s.title)}"><button type="button" data-open="${esc(k)}" aria-expanded="${open}" title="${esc(tip)}">${chip(s.state)}<span class="ttl one">${esc(s.title)}</span><span class="det">${inline(s.detail ?? '')}${open && since ? `<span class="muted"> Since ${clock(since)}.</span>` : ''}</span><span class="est">${esc(s.eta ?? '')}</span></button></div>`;
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
  morph($('outs'), outputs.length
    ? outputs.map((o, i) => {
        const u = fileUrl(o.path, o.mtime);
        const src = o.video ? `${u}#t=0.5` : u;
        const gone = GONE.has(src);
        const media = gone ? '' : o.video ? `<video muted playsinline preload="metadata" src="${src}"></video><span class="play">${icon('play')}</span>` : `<img loading="lazy" decoding="async" alt="" src="${src}">`;
        return `<button class="thumb" type="button" data-key="${esc(`${o.path}|${o.mtime}`)}" data-view="${i}" title="${esc(o.path)}"><span class="media${gone ? ' gone' : ''}">${media}</span><span class="cap">${esc(o.name)}</span><span class="cap2">${esc(o.dir)}, ${durCoarse((d.now - o.mtime) / 1000)} ago</span></button>`;
      }).join('')
    : '<div class="note" data-key="none">No review images or clips yet.</div>');
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
  const v = e.target.closest('[data-view]');
  if (v) return view(Number(v.dataset.view));
  const o = e.target.closest('[data-open]');
  if (!o) return;
  const k = o.dataset.open;
  if (OPEN.has(k)) OPEN.delete(k);
  else OPEN.add(k);
  if (last) render(last);
});

// -------------------------------------------------------------------------------------------- polling, staleness
let last = null;
let lastOkAt = 0;
let lastErr = '';
let timer = 0;
let mockMod = null;

function render(d) {
  renderFleet(d);
  renderJobs(d);
  renderYou(d);
  renderStreams(d);
  renderOuts(d);
}

function renderLive() {
  const el = $('live');
  const mockTag = MOCK !== null ? `<span class="mocktag" title="?mock: fake machines, slots and farm jobs (mock.js)">Mock fleet data</span>` : '';
  if (!lastOkAt) {
    el.className = 'live stale';
    el.innerHTML = `${mockTag}<span class="dot"></span>No answer from the dashboard server${lastErr ? ` (${esc(lastErr)})` : ''}. Retrying every 3 s.`;
    return;
  }
  const age = Date.now() - lastOkAt;
  const stale = age > STALE_MS;
  el.className = `live${stale ? ' stale' : ''}`;
  el.innerHTML = `${mockTag}<span class="dot"></span>${stale ? `No answer for ${dur(age / 1000)}: showing the data of ${clock(last.now, true)}` : `Live, updated ${clock(last.now, true)}`}`;
}

async function fetchStatus() {
  const r = await fetch('/api', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function tick() {
  clearTimeout(timer);
  if (document.hidden) return;
  try {
    let d;
    if (MOCK !== null) {
      mockMod ??= await import('./mock.js');
      let real = null;
      try {
        real = await fetchStatus();
      } catch {
        // (mock without a server: its own streams and outputs)
      }
      d = mockMod.mockStatus(Date.now(), MOCK || 'default', real);
    } else d = await fetchStatus();
    last = d;
    lastOkAt = Date.now();
    lastErr = '';
    render(d);
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
