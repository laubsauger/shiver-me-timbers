/**
 * Hull offsets for the Blender render-hull loft, evaluated by the PHYSICS module's own shape
 * functions (§V77: one set of numbers). Run through vite-node (hullMesh.ts reads its data file
 * with `?raw`, which plain node cannot resolve):
 *
 *   npx vite-node scripts/blender/hullOffsets.ts -- <out.json> [stations]
 *
 * Output = the data file (`spec`, `derived`, `renderOnly`) plus `stations` re-sampled at
 * `stations` (default 240) and `proxy` (body-frame stem/transom/keel/deck/beam from
 * `buildDeepVHull`) so the Blender script and the GLB checker compare against the proxy itself,
 * never against a copy of its arithmetic.
 */
import { writeFileSync } from 'node:fs';
import * as hull from '../../src/speedboat/hullMesh';

const args = process.argv.slice(2).filter((a) => a !== '--');
const out = args[0];
const stationCount = Number(args[1] ?? 240);
if (!out) throw new Error('usage: vite-node scripts/blender/hullOffsets.ts -- <out.json> [stations]');
if (!Number.isInteger(stationCount) || stationCount < 8) throw new Error(`stations must be an integer ≥ 8, got ${args[1]}`);

const data = hull.HULL_DATA;
const spec = hull.REFERENCE_DEEP_V;
const proxy = hull.buildDeepVHull(spec);
// `hullStations` samples at spec.segments; asking for more stations is asking the same functions
// at more z values, not interpolating the 29-station table
const stations = hull.hullStations({ ...spec, segments: stationCount });

const payload = {
  name: data.name,
  source: 'src/speedboat/hullMesh.ts (HULL_DATA + hullStations + buildDeepVHull)',
  spec,
  derived: (data as unknown as Record<string, unknown>).derived ?? null,
  renderOnly: (data as unknown as Record<string, unknown>).renderOnly ?? null,
  // per-engine mount + prop points: the parts build (scripts/blender/parts/anchors.py) hangs the
  // outboards and bracket off these, so a physics change moves the drives with it
  engines: (data as unknown as Record<string, unknown>).engines ?? null,
  stations,
  proxy: {
    stemZ: proxy.stemZ,
    transomZ: proxy.transomZ,
    keelBodyY: proxy.keelBodyY,
    deckBodyY: hull.deckHeight(spec) - spec.vcgAboveKeel,
    chineBeam: proxy.beam,
    cgFromTransom: spec.lcgFromTransom,
    cgAboveKeel: spec.vcgAboveKeel,
  },
};
writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`[hullOffsets] ${data.name}: ${stations.length} stations → ${out}`);
