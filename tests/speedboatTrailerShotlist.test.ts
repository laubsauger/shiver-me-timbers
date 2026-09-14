/**
 * The speedboat trailer shot list (src/speedboat/cine/shotlist.ts, docs/cine/speedboat-trailer-v1.md) is what the
 * Resolve timeline is built from, so its STRUCTURE is the contract: a gap or an overlap in the beats is a hole in a
 * 60 s edit, a shot that names no scouted location has no path to drive, and a clip without symmetric handles cannot
 * be trimmed to music the way the importer (scripts/resolve/trailer_import.py) places it. And a shot is PICTURE ONLY:
 * the user's requirement is that no HUD, dev overlay or cursor is ever on screen while cine plays or records.
 */
import { describe, expect, it } from 'vitest';
import { shotDuration, shotHead, shotTail } from '../src/cine/types';
import { LOCATIONS } from '../src/speedboat/cine/locations';
import { CAMERA_PRIMITIVES, TRAILER_BEATS, TRAILER_SECONDS, TRAILER_SHOTS, TRAILER_SLOTS, cameraShot, coverageFor, trailerTakes } from '../src/speedboat/cine/shotlist';
import { TIME_LOOK } from '../src/speedboat/cine/look';
import { trailerEditPlan } from '../src/speedboat/cine/editPlan';
import { CINE_CHROME_CLASS, CINE_CHROME_CSS, CINE_KEEP_ATTR, createCineChrome, type ChromeElement } from '../src/speedboat/cine/cineChrome';
import { applyDevLayer, devLayerVisible } from '../src/ui/devLayer';
import captureSrc from '../src/cine/capture.ts?raw';
import recorderSrc from '../src/cine/recorder.ts?raw';
import hostSrc from '../src/speedboat/cine/host.ts?raw';
import mainSpeedboat from '../src/main-speedboat.ts?raw';

describe('speedboat trailer v2 shot list', () => {
  it('17 script beats tile the 60 s timeline with no gap and no overlap', () => {
    expect(TRAILER_BEATS.map((b) => b.beat)).toEqual(Array.from({ length: 17 }, (_, i) => String(i + 1).padStart(2, '0')));
    expect(TRAILER_BEATS[0]?.in).toBe(0);
    for (let i = 1; i < TRAILER_BEATS.length; i++) expect(TRAILER_BEATS[i]?.in, `beat ${TRAILER_BEATS[i]?.beat}`).toBeCloseTo(TRAILER_BEATS[i - 1]?.out ?? NaN, 9);
    expect(TRAILER_BEATS.at(-1)?.out).toBe(TRAILER_SECONDS);
    expect(TRAILER_BEATS.reduce((a, b) => a + (b.out - b.in), 0)).toBeCloseTo(60, 9);
    // the rendered shots tile 0..56 the same way (beat 14 is three cuts), and the title is a slot, not a render
    const sorted = [...TRAILER_SHOTS].sort((a, b) => a.in - b.in);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]?.in).toBeCloseTo(sorted[i - 1]?.out ?? NaN, 9);
    expect(sorted.at(-1)?.out).toBe(56);
    expect(TRAILER_SLOTS.find((s) => s.kind === 'title')).toMatchObject({ recordInS: 56, recordOutS: 60 });
  });

  it('every rendered shot names a scouted location and a known camera primitive, and drives that location', () => {
    const ids = new Set<string>();
    for (const s of TRAILER_SHOTS) {
      expect(ids.has(s.id), `duplicate ${s.id}`).toBe(false);
      ids.add(s.id);
      expect(Object.keys(LOCATIONS), s.id).toContain(s.location);
      expect(CAMERA_PRIMITIVES, s.id).toContain(s.primitive);
      expect(s.drive.path, `${s.id} drives somewhere other than its location`).toBe(LOCATIONS[s.location].path);
      expect(s.keys.length, s.id).toBeGreaterThan(0);
      // a static lens is a world-frame lens: anything else follows her and is not static
      if (s.primitive === 'static-long' || s.primitive === 'overhead') expect(s.frame, s.id).toBe('world');
      if (s.primitive === 'mount' || s.primitive === 'insert') expect(s.frame, s.id).toBe('hull');
    }
  });

  it('each clip holds handle + shot + handle, and the edit plan places the middle at the shot’s own record range', () => {
    const plan = trailerEditPlan({ fps: 60, width: 3840, height: 2160 }, 3);
    expect(plan.shots.map((p) => p.id)).toEqual(TRAILER_SHOTS.map((s) => s.id));
    for (const s of TRAILER_SHOTS) {
      expect(s.handle, s.id).toBeGreaterThanOrEqual(0.5);
      expect(s.transition, `${s.id}: a dissolve adds tail frames the importer does not know about`).toBe('cut');
      expect(shotHead(s) + shotDuration(s) + shotTail(s)).toBeCloseTo(2 * (s.handle ?? 0) + (s.out - s.in), 9);
      const p = plan.shots.find((x) => x.id === s.id);
      expect(p).toMatchObject({ handleS: s.handle, recordInS: s.in, recordOutS: s.out });
      // one name for master, proxy and stem, so the importer can pair them
      const base = p?.video.replace(/^video\/|\.mov$/g, '');
      expect(base).toBe(`sb-trailer-v2_${s.id}_${s.slug}${s.variant !== undefined ? `_${s.variant}` : ''}_take03`);
      expect(p?.proxy).toBe(`proxy/${base}.mov`);
      expect(p?.sfx).toBe(`sfx/${base}.wav`);
      // the split stems sit beside the mix under the same name, so the importer can stack them under A1
      expect(p?.sfxStems).toEqual({ engine: `sfx/${base}_engine.wav`, water: `sfx/${base}_water.wav`, amb: `sfx/${base}_amb.wav` });
    }
    expect(plan.markers.some((m) => m.atS === 15 && /drop/.test(m.name))).toBe(true);
  });

  it('a time-of-day variant is the SAME take under another sky, stacked as alternates with one sound stem', () => {
    // the edit strobes between variants on a beat, so anything that moves the boat or the lens must be identical and
    // only the look may differ; the importer stacks alternates at the primary's record range, the audio is shared
    const ten = TRAILER_SHOTS.find((s) => s.id === '10');
    expect(ten?.variants).toEqual(expect.arrayContaining(['sunset', 'dusk', 'night']));
    const takes = trailerTakes(TRAILER_SHOTS.filter((s) => s.id === '10'));
    expect(takes.map((t) => t.variant)).toEqual(['dusk', 'sunset', 'night', 'noon', 'golden']);
    for (const t of takes) {
      expect(t.drive).toEqual(ten?.drive);
      expect(t.keys).toBe(ten?.keys);
      expect([t.frame, t.in, t.out, t.handle, t.preroll, t.world?.weather]).toEqual([ten?.frame, ten?.in, ten?.out, ten?.handle, ten?.preroll, ten?.world?.weather]);
      expect(t.world?.sky?.exposure).toBe(TIME_LOOK[t.variant ?? 'dusk'].sky?.exposure);
    }
    // a bay shot's 3.5° sunset sun must not survive into its night variant (an elevation outranks the night clock)
    const bayNight = trailerTakes(TRAILER_SHOTS.filter((s) => s.id === '05'), ['night'])[1];
    expect(bayNight?.world?.sunElevationDeg).toBeUndefined();
    expect(bayNight?.world?.timeOfDay).toBe(TIME_LOOK.night.timeOfDay);
    // a shot without variants is one take, no suffix
    expect(trailerTakes(TRAILER_SHOTS.filter((s) => s.id === '09')).map((t) => t.variant)).toEqual([undefined]);

    const plan = trailerEditPlan({ fps: 60, width: 3840, height: 2160 }, 1);
    const p10 = plan.shots.find((p) => p.id === '10');
    expect(p10?.video).toBe('video/sb-trailer-v2_10_bow-lookback_dusk_take01.mov');
    expect(p10?.alternates?.map((a) => a.variant)).toEqual(['sunset', 'night', 'noon', 'golden']);
    expect(p10?.alternates?.[1]?.video).toBe('video/sb-trailer-v2_10_bow-lookback_night_take01.mov');
    expect(plan.shots.find((p) => p.id === '09')?.alternates).toBeUndefined();
    // the whole-trailer flag: every shot gets alternates, the stem keeps the name the audio pass writes
    const all = trailerEditPlan({ fps: 60, width: 3840, height: 2160 }, 1, TRAILER_SHOTS, ['sunset', 'night']);
    const p09 = all.shots.find((p) => p.id === '09');
    expect(p09?.video).toBe('video/sb-trailer-v2_09_rocky-point-pass_sunset_take01.mov');
    expect(p09?.alternates?.map((a) => a.variant)).toEqual(['night']);
    expect(p09?.sfx).toBe('sfx/sb-trailer-v2_09_rocky-point-pass_take01.wav');
    // one sound per shot across every time of day: the stems too
    expect(p09?.sfxStems?.engine).toBe('sfx/sb-trailer-v2_09_rocky-point-pass_take01_engine.wav');
    expect(p10?.sfxStems?.water).toBe('sfx/sb-trailer-v2_10_bow-lookback_dusk_take01_water.wav');
  });

  it('coverage: every lens of a run is the same run, named per camera, and lines up on the setup clock', () => {
    // multicam only works if a coverage camera changes nothing but the lens: same drive, rivals, sea, time and length,
    // one sound stem for the setup, and a clip that starts at the same setup time as the main lens
    const seven = TRAILER_SHOTS.find((s) => s.id === '07');
    const cams = coverageFor(seven ?? {}, 'C');
    expect(cams.length).toBeGreaterThan(0);
    expect(new Set(cams.map((c) => c.cam)).size).toBe(cams.length);
    for (const c of cams) {
      const cs = cameraShot(seven as NonNullable<typeof seven>, c);
      expect(cs.drive).toBe(seven?.drive);
      expect([cs.in, cs.out, cs.handle, cs.preroll, cs.timeOfDay, cs.world?.weather]).toEqual([seven?.in, seven?.out, seven?.handle, seven?.preroll, seven?.timeOfDay, seven?.world?.weather]);
      expect(cs.keys).toBe(c.keys);
      expect(cs.throttleHand).toBe(false);
    }
    expect(coverageFor(seven ?? {}, 'A').every((c) => c.tier === 'A')).toBe(true);
    const plan = trailerEditPlan({ fps: 30, width: 1920, height: 1080 }, 1);
    const cov = plan.coverage?.filter((c) => c.setup === '07') ?? [];
    expect(cov.filter((c) => c.onAssembly).map((c) => c.camera)).toEqual(['main']);
    expect(cov.find((c) => c.camera === 'windshield-back')?.video).toBe('video/sb-trailer-v2_07_rear-chase-launch_cam-windshield-back_take01.mov');
    expect(new Set(cov.map((c) => c.sfx)).size).toBe(1);
    expect(new Set(cov.map((c) => `${c.sourceStartS}/${c.durationS}`)).size).toBe(1);
    // 06c (R5): the sunset and night takes of one run, both carrying the push-start cut in source seconds
    const r5 = plan.coverage?.filter((c) => c.setup === 'R5') ?? [];
    expect(r5.map((c) => c.timeOfDay)).toEqual(['sunset', 'night']);
    expect(r5.every((c) => c.cutS === 2 && c.sourceStartS === -2)).toBe(true);
    // a variant run covers cameras × times
    const ten = plan.coverage?.filter((c) => c.setup === '10') ?? [];
    expect(ten.length).toBe((1 + coverageFor(TRAILER_SHOTS.find((s) => s.id === '10') ?? {}).length) * 5);
  });

  it('cine hides every overlay but the canvas, turns the dev layer off, and gives both back', () => {
    const el = (parent: FakeEl | null): FakeEl => ({ parentElement: parent, attrs: new Map(), setAttribute(n, v) { this.attrs.set(n, v); }, removeAttribute(n) { this.attrs.delete(n); } });
    type FakeEl = ChromeElement & { attrs: Map<string, string> };
    const body = el(null);
    const app = el(body);
    const canvas = el(app);
    const hud = el(body); // raceUi's HUD root, a body child
    const tweakpane = el(body);
    const classes = new Set<string>();
    const styles: { textContent: string | null }[] = [];
    const doc = {
      documentElement: { classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) } },
      body,
      head: { appendChild: (n: unknown) => styles.push(n as { textContent: string | null }) },
      createElement: () => ({ textContent: null as string | null, remove() { styles.splice(styles.indexOf(this), 1); } }),
    };
    // the rule the page gets: under body, anything unmarked is display:none, and no cursor anywhere
    const hidden = (e: FakeEl): boolean => classes.has(CINE_CHROME_CLASS) && styles.some((x) => x.textContent === CINE_CHROME_CSS) && !e.attrs.has(CINE_KEEP_ATTR);
    expect(CINE_CHROME_CSS).toMatch(new RegExp(`body \\*:not\\(\\[${CINE_KEEP_ATTR}\\]\\)\\s*\\{\\s*display: none !important`));
    expect(CINE_CHROME_CSS).toMatch(/cursor: none !important/);

    applyDevLayer(true);
    const chrome = createCineChrome(doc, canvas);
    chrome.set(true);
    expect(hidden(hud)).toBe(true);
    expect(hidden(tweakpane)).toBe(true);
    expect(hidden(canvas) || hidden(app)).toBe(false);
    expect(devLayerVisible()).toBe(false);
    chrome.set(false);
    expect(hidden(hud)).toBe(false);
    expect(canvas.attrs.has(CINE_KEEP_ATTR)).toBe(false);
    expect(devLayerVisible()).toBe(true);

    // wired, not optional: the host locks the chrome and forces photo mode when shooting, the page skips its HUD
    expect(hostSrc).toMatch(/chrome\.set\(true\)/);
    expect(hostSrc).toMatch(/pressPhoto\(\)/);
    expect(mainSpeedboat).toMatch(/if \(!cine\.active\) ui\.update\(/);
  });

  it('capture reads the renderer, never the page: no DOM or screen capture path exists', () => {
    expect(captureSrc).toMatch(/readRenderTargetPixelsAsync/);
    // code only: capture.ts's header documents the DOM paths that were tried and rejected
    const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const src of [captureSrc, recorderSrc].map(code)) {
      expect(src).not.toMatch(/\.toDataURL\(|\.toBlob\(|captureStream\(|getDisplayMedia\(|html2canvas|captureScreenshot/);
    }
  });
});
