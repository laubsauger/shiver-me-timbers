/**
 * §T.185 performance contract, structural: the per-frame HUD path builds no markup, allocates
 * nothing and reads no layout.
 *
 * WHY: the HUD updates every frame of a 60 fps racer. innerHTML re-parses and re-lays-out the
 * subtree; string formatting and closures make garbage whose collection lands as hitches; a layout
 * read (getBoundingClientRect, offsetWidth) after a style write forces synchronous layout. Each is
 * invisible in a unit test's output and obvious in a frame graph, so the source is scanned.
 *
 * Scope: every `update*` body (and the few helpers they call) in the HUD modules and the model
 * adapter. `rebuild*` methods MAY build strings, because they run on an edge; the scan checks that
 * every call to one is guarded by a change test on the same line.
 */
import { describe, expect, it } from 'vitest';
import modelSrc from '../src/speedboat/ui/model.ts?raw';
import gaugesSrc from '../src/speedboat/ui/gauges.ts?raw';
import hudSrc from '../src/speedboat/ui/raceHud.ts?raw';
import dashSrc from '../src/speedboat/ui/dash.ts?raw';
import textSrc from '../src/speedboat/ui/text.ts?raw';

const uiDir = import.meta.glob('../src/speedboat/ui/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/** body of a method or function named `name` (all occurrences), by brace matching */
function bodies(src: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:private\\s+|public\\s+)?(?:function\\s+)?${name}\\s*\\([^)]*\\)\\s*(?::\\s*[\\w<>| ]+)?\\s*\\{`, 'g');
  for (let m = re.exec(src); m; m = re.exec(src)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (depth > 0 && i < src.length) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      i++;
    }
    out.push(src.slice(start, i - 1));
  }
  return out;
}

const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const FORBIDDEN: [RegExp, string][] = [
  [/innerHTML|outerHTML|insertAdjacentHTML/, 'markup'],
  [/createElement|createTextNode|createElementNS/, 'node creation'],
  [/\bnew\s+[A-Z]/, 'object construction'],
  [/`/, 'template string'],
  [/\.toFixed\(|\bString\(|\.padStart\(|\.toLocaleString\(/, 'number formatting'],
  [/\.(map|filter|forEach|reduce|slice|concat|join|split|push|find|findIndex|indexOf)\(/, 'array helper / growth'],
  [/=>/, 'closure'],
  [/[=(,:?]\s*\{(?!\s*$)/m, 'object literal'],
  [/[=(,:?]\s*\[/, 'array literal'],
  [/['"]\s*\+\s*[\w(]|[\w)\]]\s*\+\s*['"]/, 'string concatenation'],
  [/querySelector|getBoundingClientRect|offsetWidth|offsetHeight|clientWidth|clientHeight|getComputedStyle|scrollWidth/, 'layout read / DOM query'],
  [/setAttribute\(|setProperty\(|\.textContent\s*=/, 'string attribute / text write (use Text.data or SVG animated values)'],
];

function violations(body: string): string[] {
  const code = stripComments(body);
  return FORBIDDEN.filter(([re]) => re.test(code)).map(([re, why]) => `${why}: ${(re.exec(code) as RegExpExecArray)[0]}`);
}

/** [module, source, function/method names that run per frame] */
const HOT: [string, string, string[]][] = [
  ['model.ts', modelSrc, ['updateRaceHudModel', 'fillRow', 'surgeSegmentFill', 'crashOverlayFor', 'landingWindowFor', 'relativeBearing', 'mpsToKnots']],
  ['text.ts', textSrc, ['setData']],
  ['gauges.ts', gaugesSrc, ['set', 'update', 'showWord', 'windowClass', 'mx', 'mz']],
  ['raceHud.ts', hudSrc, ['update', 'updatePosition', 'updateRows', 'updateRadio', 'updateGate', 'updateToast', 'updateStart', 'updateCrash']],
  ['dash.ts', dashSrc, ['update', 'pose', 'updateGauges', 'tick', 'updateLed', 'updatePlotter', 'mx', 'mz']],
];

describe('per-frame HUD path: no markup, no allocation, no layout reads', () => {
  it('the scanner finds the hot functions it claims to scan', () => {
    for (const [file, src, names] of HOT) {
      for (const n of names) {
        const found = bodies(src, n).length > 0 || new RegExp(`const ${n} = \\(`).test(src);
        expect(found, `${file}: ${n}`).toBe(true);
      }
    }
    expect(bodies(gaugesSrc, 'update').length).toBeGreaterThanOrEqual(6); // ScaleBar, Clock, Gap, Trim, Speed, Surge, Plotter
  });

  for (const [file, src, names] of HOT) {
    it(`${file}: ${names.join(', ')}`, () => {
      for (const n of names) for (const body of bodies(src, n)) expect(violations(body), `${file} ${n}()`).toEqual([]);
    });
  }

  it('rebuild* (edge work that may allocate) is only ever called behind a change check', () => {
    for (const [file, src] of HOT) {
      const lines = stripComments(src).split('\n').filter((l) => /this\.rebuild\w*\(/.test(l) && !/^\s*(private\s+)?rebuild\w*\(/.test(l));
      for (const l of lines) expect(l, `${file}: ${l.trim()}`).toMatch(/if\s*\(.*!==.*\)\s*this\.rebuild/);
    }
  });

  it('the scanner is not toothless: it flags the shapes it exists to catch', () => {
    expect(violations('el.innerHTML = s;')).not.toEqual([]);
    expect(violations('node.data = `${n} kn`;')).not.toEqual([]);
    expect(violations('node.data = n.toFixed(1);')).not.toEqual([]);
    expect(violations('rows.forEach((r) => r.update());')).not.toEqual([]);
    expect(violations('const p = { x: 1 };')).not.toEqual([]);
    expect(violations('const w = el.getBoundingClientRect().width;')).not.toEqual([]);
    expect(violations("node.data = knots + ' kn';")).not.toEqual([]);
    expect(violations("setData(this.sign, neg ? MINUS : '+');")).toEqual([]);
    expect(violations('setData(this.knots, INT[k]);\n    this.flag.set(on);')).toEqual([]);
  });

  it('no innerHTML anywhere in src/speedboat/ui', () => {
    for (const [k, src] of Object.entries(uiDir)) expect(stripComments(src), k).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
  });
});
