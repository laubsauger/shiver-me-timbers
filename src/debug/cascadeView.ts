/**
 * CASCADE SPECTRUM VIEW (research-poseidon §2.3, ranked #2) — a measuring
 * instrument for the three FFT bands, not a toy.
 *
 * WHY IT EXISTS. Three separate investigations in one session had to be run
 * blind, by CPU transliteration, because nothing could show one band on its
 * own: the 6.9× foam-coverage pulse at a 13.3 s period (whitecaps at 0.62 %
 * coverage are sub-pixel and swamped by sails and sky, so screen luminance
 * cannot resolve it), "cascade 2 carries 65 % of the sea's Jacobian variance",
 * and a cascade-widening experiment that was rejected without anyone being
 * able to LOOK at what each band contributed. Every one of those is a direct
 * read off this view.
 *
 * ARCHITECTURE — the reason this is cheap. A separate ortho scene with one
 * fullscreen quad, rendered INSTEAD OF the game frame. The ocean material is
 * not touched: no debug uniform, no branch, and above all NO BINDING (§V.40 —
 * the ocean fragment stage has exactly one spare sampler and it is contested).
 * Everything here reads the sim's storage textures in ITS OWN material, which
 * is measured against its own fresh budget of 16.
 *
 * COST WHEN OFF: one boolean test in the frame, and nothing is built at all —
 * materials compile lazily, per (field, cascade), on first selection. The
 * frame is CPU-bound at ~595 draws / 19–24 ms encode, so a debug view that
 * built 18 pipelines at boot would be a real regression on every launch that
 * never opens it. COST WHEN ON: one draw, and the whole game frame skipped.
 *
 * WHAT IT SHOWS, and why these six. The map-space tile at 1:1 texels, which is
 * the isolation that matters — a world-space "only cascade 0" render adds
 * perspective, clipmap LOD and tiling on top of the thing being measured,
 * while the tile is the band itself, undistorted:
 *
 *   h        elevation, in σ of THIS band            — who owns which scale
 *   λD       horizontal displacement (the choppy part, §2.1)
 *   ∇h       surface slope, the input to every normal
 *   det J    area compression — poseidon's fold metric, kept for the A/B
 *   λ⁻       the fold metric we actually inject on, IN σ, WITH THE GATE DRAWN
 *   foam     the lane's two clocks: R residue, G breaking
 *
 * λ⁻ vs det J is the §V.58 distinction that has never been visible: measured
 * at 0.5 % coverage vs 9.2 %, cap-length CV 0.08 vs 0.68, orientation spread
 * 2.1° vs 21.4°. Both are here, one keypress apart, so it can be SEEN.
 *
 * THE λ⁻ VIEW IS THE POINT. It is drawn as a z-score against the band's own
 * live rest value and σ (foamMath.eigenRestValue / eigenSigma), which is the
 * unit every foam gate in this project is expressed in and which nobody could
 * previously see, and every texel below the live gate is painted hot. That
 * lit region IS the injected set: what it does over a wave period is the
 * synchrony measurement, and `stats()` returns its area as a number.
 *
 * CAPTURE. `__game.cascadeView` drives every control from the console so an
 * A/B is repeatable — `.set(field, cascade)`, `.stats()`, `.off()`. Two traps
 * from docs/agent-browser-harness.md apply and are handled here:
 *  · this view calls `renderer.render()` directly, NOT `post.renderAsync()`,
 *    so §3's stale-frame trap (PassNode skips on an unchanged frameId) cannot
 *    bite the picture. An agent driving the loop by hand outside rAF must
 *    still tick the sim itself or the sea is frozen — which for a bit-exact
 *    A/B is the feature, not the bug.
 *  · `stats()` allocates a FRESH RenderTarget per call and disposes it (§2:
 *    a reused target returns the first frame forever), and unpads the
 *    256-byte-aligned rows three does not strip.
 */
import * as THREE from 'three/webgpu';
import { float, Fn, int, ivec2, textureLoad, uniform, uv, vec2, vec3, vec4 } from 'three/tsl';
import { sampleCascadeLayer, type CascadeLayer } from '../ocean/oceanTextures';
import {
  breakupOctaves,
  eigenFoamGate,
  eigenRestValue,
  eigenSigma,
  foamTexelMetres,
  jacobianSigma,
  metricSigmaScale,
  minEigenvalue,
  NEVER_INJECT_BIAS,
} from '../foam/foamMath';
import { foamParams } from '../params/foam';
import { oceanParams } from '../params/ocean';
import { setCascadeViewSink, type CascadeViewAction } from '../ui/cascadeViewChannel';

type TslNode = any;

/** one band's sim outputs, exactly as `OceanCascade` publishes them */
export interface CascadeViewInput {
  /** unpack output (λDx, h, λDz, det J) */
  readonly displacement: THREE.StorageTexture;
  /** unpack output (∂h/∂x, ∂h/∂z, ∂Dx/∂x, ∂Dz/∂z) — a LAYER of the array */
  readonly derivatives: CascadeLayer;
  /** world metres this band tiles over */
  readonly domain: number;
  /** RMS of the Jacobian trace at λ=1 — the band's own fold σ (§V36) */
  readonly jacobianRms: number;
  /** elevation variance of this band (m²) */
  readonly heightVariance: number;
  /** energy-weighted mean wavenumber (rad/m) */
  readonly meanWavenumber: number;
}

/** the live sea moments the gate is a multiple of — `OceanSimulation` fits */
export interface CascadeViewSea {
  /** σ of the SUMMED Jacobian trace at λ=1 */
  readonly jacobianRms: number;
  /** choppiness λ actually sent to the GPU (the anti-fold cap, not the slider) */
  effectiveChoppiness(): number;
}

export type CascadeFieldId =
  | 'height'
  | 'displacement'
  | 'slope'
  | 'detJ'
  | 'lambdaMinus'
  | 'foam';

interface FieldSpec {
  readonly id: CascadeFieldId;
  readonly label: string;
  /** what the colours mean, shown under the label so a capture is self-describing */
  readonly legend: string;
  /** the scalar `stats()` reduces, or null where the field has no single scalar */
  readonly scalar: 'height' | 'slope' | 'detJ' | 'lambdaMinus' | 'foamResidue' | null;
}

/**
 * ORDER IS THE `[` / `]` ORDER, and it is deliberate: the two fold metrics sit
 * next to each other so det J → λ⁻ is one keypress, which is the §V.58
 * comparison this whole view was worth building for.
 */
export const CASCADE_FIELDS: readonly FieldSpec[] = [
  {
    id: 'height',
    label: 'h — elevation',
    legend: 'diverging, ±3σ of this band · blue trough / red crest',
    scalar: 'height',
  },
  {
    id: 'displacement',
    label: 'λD — horizontal displacement',
    legend: 'hue = direction, value = |λD| over 3σ_h · the choppy part',
    scalar: null,
  },
  {
    id: 'slope',
    label: '∇h — surface slope',
    legend: 'r = ∂h/∂x, g = ∂h/∂z, ±4σ · the input to every normal',
    scalar: 'slope',
  },
  {
    id: 'detJ',
    label: 'det J — area compression (poseidon’s metric)',
    legend: 'grey = rest (1) · red = folded (<0) · §V.58: 0.5 % coverage',
    scalar: 'detJ',
  },
  {
    id: 'lambdaMinus',
    label: 'λ⁻ — fold metric, in σ, gate drawn',
    legend: 'z = (λ⁻ − rest)/σ · HOT = below the live gate = injecting',
    scalar: 'lambdaMinus',
  },
  {
    id: 'foam',
    label: 'foam lane — R residue / G breaking',
    legend: 'teal = residue (history) · orange = breaking (rate)',
    scalar: 'foamResidue',
  },
];

function fieldIndex(id: CascadeFieldId): number {
  const i = CASCADE_FIELDS.findIndex((f) => f.id === id);
  if (i < 0) throw new Error(`cascadeView: unknown field ${id}`);
  return i;
}

/**
 * Reducer for the key channel, pure so the whole navigation is pinned by a
 * test. `on` is separate from the selection so closing and reopening returns
 * to the field you were looking at — an A/B that loses its mode on every
 * toggle is not an A/B.
 */
export interface CascadeViewState {
  on: boolean;
  field: number;
  cascade: number;
}

export const INITIAL_CASCADE_VIEW: CascadeViewState = {
  on: false,
  // λ⁻ first: it is the view that has never existed and the one every foam
  // gate in the project is expressed in
  field: fieldIndex('lambdaMinus'),
  cascade: 1,
};

export interface CascadeViewTransition {
  state: CascadeViewState;
  /** false = the key meant nothing here and must stay available (§V.62) */
  consumed: boolean;
}

export function reduceCascadeView(
  s: CascadeViewState,
  action: CascadeViewAction,
  cascadeCount: number,
): CascadeViewTransition {
  switch (action.type) {
    case 'toggle':
      return { state: { ...s, on: !s.on }, consumed: true };
    case 'cascade': {
      // while the view is off these keys belong to nobody — say so rather than
      // swallowing them into a mode the player cannot see
      if (!s.on) return { state: s, consumed: false };
      if (!Number.isInteger(action.index) || action.index < 0 || action.index >= cascadeCount) {
        return { state: s, consumed: false };
      }
      return { state: { ...s, cascade: action.index }, consumed: true };
    }
    case 'stepField': {
      if (!s.on) return { state: s, consumed: false };
      const n = CASCADE_FIELDS.length;
      const field = (((s.field + action.delta) % n) + n) % n;
      return { state: { ...s, field }, consumed: true };
    }
  }
}

/* ---------------------------------------------------------------------------
 * The colour ramps. Kept as small named helpers rather than inline chains so
 * the same mapping is used by every field that wants it and a capture from one
 * field is comparable with a capture from another.
 *
 * NOTE ON §V.48: this file lives in `src/debug/`, which is NOT one of
 * `bandLimitAudit.test.ts`'s SHADER_DIRS, so nothing here counts toward the
 * BASELINE 176 ratchet. That is also the honest answer — a full-screen quad at
 * one texel per pixel has no minification to alias through, and the whole
 * point is to show the raw texel rather than a filtered opinion of it.
 * ------------------------------------------------------------------------- */

/** signed value in [-1,1] → blue (negative) through near-black to red */
function diverging(t: TslNode): TslNode {
  const p = t.clamp(0, 1);
  const n = t.negate().clamp(0, 1);
  return vec3(p.mul(1.05).add(n.mul(0.04)), p.mul(0.35).add(n.mul(0.36)), n.mul(1.05).add(p.mul(0.06)))
    .add(0.02);
}

/** 0..1 → the cool ramp poseidon uses for magnitude, so ours reads the same */
function magnitude(t: TslNode): TslNode {
  const v = t.clamp(0, 1);
  return vec3(v.mul(0.7).add(0.05), v.mul(0.85).add(0.05), v.mul(1.0).add(0.08));
}

/* ------------------------------------------------------------------------ */

/**
 * Per-band scalars, refreshed every frame the view draws. Typed `TslNode`
 * (i.e. `any`, the convention this project uses for TSL throughout) because
 * each one is used BOTH as a node in the graph and as a `.value` the overlay
 * prints — narrowing to `{ value: number }` the way the sim's uniforms do
 * would cost the graph half of these.
 */
interface BandUniforms {
  /** σ of this band's elevation (m) */
  heightSigma: TslNode;
  /** σ of this band's slope — derived from the k-weighted moment */
  slopeSigma: TslNode;
  /** σ of this band's det J about its rest value of 1 */
  detSigma: TslNode;
  /** where λ⁻ rests on an undisturbed sea of this band (NOT 1 — foamMath) */
  eigenRest: TslNode;
  /** σ of this band's λ⁻ */
  eigenSigma: TslNode;
  /** the gate in λ⁻ units — below this the lane is injecting (see mirrorGate) */
  eigenGate: TslNode;
  /** choppiness λ actually on the GPU */
  choppiness: TslNode;
}

function makeBandUniforms(): BandUniforms {
  return {
    heightSigma: uniform(1),
    slopeSigma: uniform(1),
    detSigma: uniform(1),
    eigenRest: uniform(1),
    eigenSigma: uniform(1),
    eigenGate: uniform(-10),
    choppiness: uniform(1),
  };
}

export interface CascadeView {
  /** true when the view owns the frame — main.ts renders this instead */
  isOn(): boolean;
  /** current selection, for the caller and for a capture script */
  get(): { field: CascadeFieldId; cascade: number; label: string };
  /** drive it from the console: `__game.cascadeView.set('detJ', 2)` */
  set(field: CascadeFieldId, cascade?: number): void;
  off(): void;
  on(): void;
  /**
   * Render the view for this frame. Call INSTEAD OF the game render — this
   * clears and presents on its own.
   */
  render(renderer: THREE.WebGPURenderer): void;
  /**
   * Reduce the CURRENT field's scalar over the whole tile, on the CPU, from a
   * real readback. This is the repeatable half of the instrument: the picture
   * shows the shape, this gives the number the A/B compares.
   */
  stats(renderer: THREE.WebGPURenderer): Promise<CascadeStats>;
  dispose(): void;
}

export interface CascadeStats {
  field: CascadeFieldId;
  cascade: number;
  /** world metres this band tiles over */
  domain: number;
  n: number;
  mean: number;
  sd: number;
  min: number;
  max: number;
  /**
   * Fraction of the tile below the live foam gate — the coverage number the
   * foam-synchrony investigation had to transliterate on the CPU to get.
   * `null` on fields that have no gate.
   */
  belowGate: number | null;
  /** the gate itself, in the field's own units, so the number is checkable */
  gate: number | null;
  nonFinite: number;
}

/**
 * @param cascades the three bands, index-aligned with `OceanSimulation.cascades`
 * @param foamTextures per-lane foam RTs (R residue, G breaking), or [] if foam
 *        is not built — the `foam` field then reports itself unavailable rather
 *        than drawing black, which is §V.62's exact failure mode
 */
export function createCascadeView(
  cascades: readonly CascadeViewInput[],
  sea: CascadeViewSea,
  foamTextures: readonly THREE.StorageTexture[],
  n: number,
  container: HTMLElement = document.body,
): CascadeView {
  if (cascades.length === 0) throw new Error('cascadeView: no cascades');
  if (!Number.isInteger(n) || n < 1) throw new Error(`cascadeView: bad resolution ${n}`);

  let state: CascadeViewState = { ...INITIAL_CASCADE_VIEW };

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const geometry = new THREE.PlaneGeometry(2, 2);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicNodeMaterial());
  // the quad IS the frame; nothing else is in this scene and there is no depth
  mesh.frustumCulled = false;
  scene.add(mesh);

  const bands = cascades.map(() => makeBandUniforms());
  /** vec2 that letterboxes the square tile into a non-square canvas */
  const uFit = uniform(vec2(1, 1));
  /** manual exposure, for the cases where the live σ is not the right frame */
  const uGain = uniform(1);

  /** built on first selection, keyed `field|cascade` — see the header on cost */
  const materials = new Map<string, THREE.MeshBasicNodeMaterial>();

  /** background outside the square tile — mid-grey so black data still reads */
  const BG = vec3(0.055, 0.06, 0.07);

  /**
   * Both spellings of the same texel, because the two texture kinds this view
   * reads do NOT share a working access path in the FRAGMENT stage:
   *
   *  · `coord` — integer texel, for the plain 2D `displacement` StorageTextures.
   *  · `texelUv` — that texel's CENTRE in uv, for the `derivatives`
   *    StorageArrayTexture, which must go through `sampleCascadeLayer`.
   *
   * WHY NOT `loadCascadeLayer` FOR BOTH — which is what this file did first,
   * what `oceanTextures.ts` calls "the one path in r180 that carries the array
   * index correctly in EVERY shader stage", and what every existing caller
   * uses. Every one of those callers is a COMPUTE pass. This is the project's
   * first FRAGMENT-stage read of the array texture, and there the layered
   * `textureLoad` returns LAYER 0 for all three cascades.
   *
   * MEASURED, not reasoned. Against a CPU readback of the same texels, the
   * fraction of the tile below the foam gate came out picture-vs-number
   * 0.29 / 0.06 / 0.01 for cascades 0 / 1 / 2 — agreeing on cascade 0 and
   * diverging monotonically with band index, which is the exact signature of
   * always sampling layer 0 (cascade 0's own gradients are small, so every
   * other band looks far flatter than it is). With this spelling the three
   * ratios come back to ~1. Two earlier rounds MISSED it because the sea had
   * drifted calm and all three bands then had ~0.5 % coverage, where the
   * signature is invisible — judge this one on a rough sea (§V.46 moves the
   * sea state under you; see docs/agent-browser-harness.md §6).
   *
   * The uv is the texel CENTRE, so a Linear tap returns that texel exactly and
   * the picture stays a raw-texel view rather than a filtered opinion of one.
   * It costs one sampler — in THIS material, which has a fresh budget of 16
   * and uses three. The ocean's contested spare is untouched.
   */
  function tileNode(): { coord: TslNode; texelUv: TslNode; inside: TslNode } {
    const t = uv().sub(0.5).mul(uFit).add(0.5).toVar();
    const inside = t.x
      .greaterThanEqual(float(0))
      .and(t.x.lessThan(float(1)))
      .and(t.y.greaterThanEqual(float(0)))
      .and(t.y.lessThan(float(1)));
    const ix = int(t.x.mul(n)).clamp(0, n - 1);
    const iy = int(t.y.mul(n)).clamp(0, n - 1);
    const coord = ivec2(ix, iy);
    const texelUv = vec2(float(ix).add(0.5).div(n), float(iy).add(0.5).div(n));
    return { coord, texelUv, inside };
  }

  function colorFor(field: CascadeFieldId, index: number): TslNode {
    const c = cascades[index];
    const u = bands[index];
    return Fn(() => {
      const { coord, texelUv, inside } = tileNode();
      // (λDx, h, λDz, det J) and (∂h/∂x, ∂h/∂z, ∂Dx/∂x, ∂Dz/∂z) — unpackPass.
      // `textureLoad` throughout: it is the ONE path in three r180 that carries
      // the array index in every stage, and it needs no sampler, so this whole
      // material stays far under its own budget however many fields it grows.
      let out: TslNode;

      if (field === 'height') {
        const h = textureLoad(c.displacement, coord).y;
        out = diverging(h.div(u.heightSigma.mul(3).mul(uGain)));
      } else if (field === 'displacement') {
        const d = textureLoad(c.displacement, coord);
        const m = vec2(d.x, d.z);
        const len = m.length();
        // direction as a red/green pair rather than a hue wheel: two signed
        // channels stay readable in a screenshot, a hue wheel does not
        const dir = m.div(len.max(1e-6)).mul(0.5).add(0.5);
        const v = len.div(u.heightSigma.mul(3).mul(uGain)).clamp(0, 1);
        out = vec3(dir.x, dir.y, float(0.25)).mul(v).add(0.02);
      } else if (field === 'slope') {
        const d = sampleCascadeLayer(c.derivatives, texelUv);
        const s = u.slopeSigma.mul(4).mul(uGain);
        out = vec3(
          d.x.div(s).mul(0.5).add(0.5).clamp(0, 1),
          d.y.div(s).mul(0.5).add(0.5).clamp(0, 1),
          float(0.35),
        );
      } else if (field === 'detJ') {
        const det = textureLoad(c.displacement, coord).w;
        // grey at rest (1), diverging in σ, and hard red once it goes NEGATIVE
        // — a negative determinant is the sheet actually turned inside out
        const z = det.sub(1).div(u.detSigma.mul(2).mul(uGain));
        const folded = det.lessThan(float(0));
        out = folded.select(vec3(1.0, 0.18, 0.05), diverging(z).add(0.06));
      } else if (field === 'lambdaMinus') {
        // GPU mirror of foamPasses.createInjectPass / foamMath.minEigenvalue.
        // Kept literally identical, including the max(0) on the discriminant:
        // one ulp of negative returns NaN, and a NaN here would paint a hole
        // that reads as "this band is not folding".
        const det = textureLoad(c.displacement, coord).w;
        const d = sampleCascadeLayer(c.derivatives, texelUv);
        const trace = float(2).add(u.choppiness.mul(d.z.add(d.w))).toVar();
        const disc = trace.mul(trace).sub(det.mul(4)).max(0);
        const lm = trace.sub(disc.sqrt()).mul(0.5).toVar();
        const z = lm.sub(u.eigenRest).div(u.eigenSigma.max(1e-9)).div(uGain);
        // HOT is the whole point: this set is what the lane injects on, and it
        // is the set nobody could see. Everything else is the cool ramp so the
        // hot region cannot be confused with a bright value.
        const injecting = lm.lessThan(u.eigenGate);
        out = injecting.select(
          vec3(1.0, 0.45, 0.08),
          magnitude(z.mul(-0.5).clamp(0, 1)),
        );
      } else if (field === 'foam') {
        const tex = foamTextures[index];
        if (tex === undefined) {
          // fail loud IN THE PICTURE (§V.62): magenta, not black, so "foam is
          // not built" cannot be read as "this band has no foam"
          out = vec3(0.8, 0.0, 0.6);
        } else {
          const f = textureLoad(tex, coord);
          // residue teal, breaking orange — additive, so a texel carrying both
          // (a live cap) goes pale and a texel carrying only history stays cool
          out = vec3(f.g.mul(1.0), f.r.mul(0.55).add(f.g.mul(0.4)), f.r.mul(0.75))
            .mul(uGain)
            .add(0.02);
        }
      } else {
        throw new Error(`cascadeView: unhandled field ${field}`);
      }

      return vec4(inside.select(out, BG), 1);
    })();
  }

  function materialFor(field: CascadeFieldId, index: number): THREE.MeshBasicNodeMaterial {
    const key = `${field}|${index}`;
    let m = materials.get(key);
    if (m === undefined) {
      m = new THREE.MeshBasicNodeMaterial();
      m.colorNode = colorFor(field, index);
      // a MEASUREMENT must not be graded: the renderer runs ACES
      // (src/sky/lighting.ts) and it would crush the top of every ramp
      m.toneMapped = false;
      m.depthTest = false;
      m.depthWrite = false;
      m.name = `cascadeView/${key}`;
      materials.set(key, m);
    }
    return m;
  }

  /* -- the caption. A capture with no caption is not a measurement. -------- */
  const overlay = document.createElement('div');
  overlay.className = 'smt-cascade-view';
  overlay.setAttribute('role', 'status');
  overlay.style.cssText = [
    'position:fixed', 'left:12px', 'top:12px', 'z-index:60',
    'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace',
    'color:#e8f4ff', 'background:rgba(6,10,16,0.78)', 'padding:8px 11px',
    'border:1px solid rgba(120,180,220,0.35)', 'border-radius:4px',
    'pointer-events:none', 'white-space:pre', 'display:none',
  ].join(';');
  container.appendChild(overlay);

  function refreshOverlay(): void {
    if (!state.on) {
      overlay.style.display = 'none';
      return;
    }
    const spec = CASCADE_FIELDS[state.field];
    const c = cascades[state.cascade];
    const u = bands[state.cascade];
    const texel = c.domain / n;
    const wavelength = c.meanWavenumber > 0 ? (2 * Math.PI) / c.meanWavenumber : Infinity;
    overlay.textContent = [
      `cascade ${state.cascade}/${cascades.length - 1}   ${spec.label}`,
      `${spec.legend}`,
      '',
      `domain ${c.domain.toFixed(1)} m   N ${n}   texel ${texel.toFixed(3)} m`,
      `mean λ ${Number.isFinite(wavelength) ? `${wavelength.toFixed(1)} m` : '—'}   ` +
        `σ(h) ${u.heightSigma.value.toFixed(3)} m   λ_chop ${u.choppiness.value.toFixed(3)}`,
      `λ⁻ rest ${u.eigenRest.value.toFixed(4)}   σ ${u.eigenSigma.value.toFixed(4)}   ` +
        `gate* ${u.eigenGate.value.toFixed(4)}   (* mirror of foam’s, see mirrorGate)`,
      '',
      `G off   1/2/3 band   [ ] field   __game.cascadeView.stats()`,
    ].join('\n');
    overlay.style.display = '';
  }

  /* -- live moments, refreshed on every frame the view is on -------------- */
  function refreshUniforms(): void {
    const lambda = sea.effectiveChoppiness();
    const seaSigmaJ = jacobianSigma(sea.jacobianRms, lambda);
    for (let i = 0; i < cascades.length; i++) {
      const c = cascades[i];
      const u = bands[i];
      const bandSigmaJ = jacobianSigma(c.jacobianRms, lambda);
      u.choppiness.value = lambda;
      u.heightSigma.value = Math.sqrt(Math.max(1e-12, c.heightVariance));
      // slope σ from the same band moment the sim publishes: ∇h scales with
      // k·h, so k̄·σ(h) is the right frame and it tracks a spectrum rebuild
      u.slopeSigma.value = Math.max(1e-6, c.meanWavenumber * u.heightSigma.value);
      // det J rests at 1 and its spread is the trace moment's, to first order
      u.detSigma.value = Math.max(1e-9, bandSigmaJ);
      u.eigenRest.value = eigenRestValue(c.jacobianRms, lambda);
      u.eigenSigma.value = Math.max(1e-9, eigenSigma(c.jacobianRms, lambda));
      u.eigenGate.value = mirrorGate(i, c.jacobianRms, lambda, bandSigmaJ, seaSigmaJ);
    }
  }

  /**
   * THE GATE THIS VIEW DRAWS IS A MIRROR, NOT THE LIVE UNIFORM — say it out
   * loud, because a debug view that draws a threshold nobody actually uses is
   * §V.62 wearing a lab coat.
   *
   * `createFoamSim` publishes `foamTextures`, `update`, `shadingNode` and
   * `dispose`; `lane.u.uBias` — the number the inject pass really compares
   * against — is private to it, and src/foam belongs to another agent this
   * session. So this recomputes it from the SAME pure functions
   * `src/foam/index.ts:346-374` calls, with the same arguments, and the
   * overlay labels it `gate*`. Every term here is a published `foamMath`
   * export with its own test; the drift risk is that foam changes the CALL and
   * not the functions. If that happens the honest fix is for `createFoamSim`
   * to expose the live per-lane bias and for this to read it.
   */
  function mirrorGate(
    index: number,
    bandJacobianRms: number,
    lambda: number,
    bandSigmaJ: number,
    seaSigmaJ: number,
  ): number {
    const off = foamParams.injectFineCascade < 1 && index === cascades.length - 1;
    if (off) return NEVER_INJECT_BIAS;
    const octaves = breakupOctaves(
      foamParams.breakupMetres,
      foamTexelMetres(cascades[index].domain, n),
    );
    const sigmaScale = metricSigmaScale(
      foamParams.crestBiasSigma,
      foamParams.breakupSigma,
      octaves,
    );
    return eigenFoamGate(
      oceanParams.jacobianFoamBias,
      bandJacobianRms,
      lambda,
      bandSigmaJ,
      seaSigmaJ,
      sigmaScale,
    );
  }

  function applySelection(): void {
    mesh.material = materialFor(CASCADE_FIELDS[state.field].id, state.cascade);
  }

  const detach = setCascadeViewSink((action: CascadeViewAction): boolean => {
    const next = reduceCascadeView(state, action, cascades.length);
    if (!next.consumed) return false;
    state = next.state;
    if (state.on) {
      applySelection();
      refreshUniforms();
    }
    refreshOverlay();
    return true;
  });

  function fitTo(renderer: THREE.WebGPURenderer): void {
    const size = renderer.getSize(new THREE.Vector2());
    const aspect = size.height > 0 ? size.width / size.height : 1;
    // scale the SAMPLED range, so the square tile keeps its shape and the
    // surplus axis becomes background rather than stretching the data
    if (aspect >= 1) uFit.value.set(aspect, 1);
    else uFit.value.set(1, 1 / aspect);
  }

  return {
    isOn: () => state.on,
    get: () => ({
      field: CASCADE_FIELDS[state.field].id,
      cascade: state.cascade,
      label: CASCADE_FIELDS[state.field].label,
    }),
    set(field: CascadeFieldId, cascade?: number): void {
      state = {
        on: true,
        field: fieldIndex(field),
        cascade:
          cascade === undefined
            ? state.cascade
            : Math.min(Math.max(0, Math.trunc(cascade)), cascades.length - 1),
      };
      applySelection();
      refreshUniforms();
      refreshOverlay();
    },
    on(): void {
      state = { ...state, on: true };
      applySelection();
      refreshUniforms();
      refreshOverlay();
    },
    off(): void {
      state = { ...state, on: false };
      refreshOverlay();
    },
    render(renderer: THREE.WebGPURenderer): void {
      refreshUniforms();
      refreshOverlay();
      fitTo(renderer);
      // the game frame is NOT drawn while this is up — that is the whole
      // architecture (research-poseidon §2.3) and it is why the view costs the
      // ocean material nothing and the frame budget less than nothing
      renderer.render(scene, camera);
    },
    async stats(renderer: THREE.WebGPURenderer): Promise<CascadeStats> {
      const spec = CASCADE_FIELDS[state.field];
      const c = cascades[state.cascade];
      const u = bands[state.cascade];
      /**
       * DELIBERATELY DOES NOT `refreshUniforms()`. The number has to describe
       * THE FRAME ON SCREEN, and this call reduces against the gate and σ the
       * last draw actually used.
       *
       * MEASURED, and it is not a nicety: refreshing here re-read the live sea
       * between the present and the readback, and §V.46 drives windSpeed and
       * amplitude off the storm field at the ship's own position, so those
       * moments move every tick. `belowGate` is a ~2.5σ TAIL, where a few per
       * cent on σ is a factor of two on the area — so the picture and the
       * number disagreed by 2–4× purely because they were sampled a few
       * hundred milliseconds apart. That is §V.62's cousin: not a dead
       * instrument, a self-inconsistent one, which is worse because it looks
       * like a finding. `render()` refreshes; nothing else may.
       */
      if (spec.scalar === null) {
        throw new Error(
          `cascadeView.stats: field '${spec.id}' has no single scalar — ` +
            `pick one of ${CASCADE_FIELDS.filter((f) => f.scalar).map((f) => f.id).join(', ')}`,
        );
      }
      const needsDisplacement =
        spec.scalar === 'height' || spec.scalar === 'detJ' || spec.scalar === 'lambdaMinus';
      const needsDerivatives = spec.scalar === 'slope' || spec.scalar === 'lambdaMinus';
      const needsFoam = spec.scalar === 'foamResidue';
      if (needsFoam && foamTextures[state.cascade] === undefined) {
        throw new Error('cascadeView.stats: no foam texture for this lane');
      }

      const disp = needsDisplacement ? await readTexture(renderer, c.displacement, n) : null;
      const deriv = needsDerivatives
        ? await readTexture(renderer, c.derivatives.texture, n, c.derivatives.layer)
        : null;
      const foam = needsFoam ? await readTexture(renderer, foamTextures[state.cascade], n) : null;

      const lambda = u.choppiness.value;
      const gate =
        spec.scalar === 'lambdaMinus' ? u.eigenGate.value : spec.scalar === 'detJ' ? 0 : null;

      let sum = 0;
      let sumSq = 0;
      let min = Infinity;
      let max = -Infinity;
      let below = 0;
      let nonFinite = 0;
      const count = n * n;
      for (let i = 0; i < count; i++) {
        const o = i * 4;
        let v: number;
        if (spec.scalar === 'height') v = disp![o + 1];
        else if (spec.scalar === 'detJ') v = disp![o + 3];
        else if (spec.scalar === 'slope') v = Math.hypot(deriv![o], deriv![o + 1]);
        else if (spec.scalar === 'foamResidue') v = foam![o];
        else {
          // the CPU MIRROR of the shader above, and of foamPasses — same
          // function the foam tests pin, not a re-derivation
          const trace = 2 + lambda * (deriv![o + 2] + deriv![o + 3]);
          v = minEigenvalue(trace, disp![o + 3]);
        }
        if (!Number.isFinite(v)) {
          nonFinite++;
          continue;
        }
        sum += v;
        sumSq += v * v;
        if (v < min) min = v;
        if (v > max) max = v;
        if (gate !== null && v < gate) below++;
      }
      const live = count - nonFinite;
      const mean = live > 0 ? sum / live : NaN;
      return {
        field: spec.id,
        cascade: state.cascade,
        domain: c.domain,
        n,
        mean,
        sd: live > 0 ? Math.sqrt(Math.max(0, sumSq / live - mean * mean)) : NaN,
        min,
        max,
        belowGate: gate !== null && live > 0 ? below / live : null,
        gate,
        nonFinite,
      };
    },
    dispose(): void {
      detach();
      for (const m of materials.values()) m.dispose();
      materials.clear();
      geometry.dispose();
      overlay.remove();
    },
  };
}

/**
 * StorageTextures have no readback of their own: copy into a matching float
 * target and read that — the same route `src/deckwater/index.ts` takes.
 *
 * A FRESH target every call, then disposed. docs/agent-browser-harness.md §2:
 * `readRenderTargetPixelsAsync` on a REUSED RenderTarget has been observed to
 * return the first frame forever, and a probe that silently reports the boot
 * frame is worse than no probe. `stats()` is a manual call, so the allocation
 * is not on any hot path.
 *
 * `layer` selects an array slice through the Box3 z origin — the only way to
 * reach one layer of the shared `derivatives` StorageArrayTexture (§V.40).
 */
async function readTexture(
  renderer: THREE.WebGPURenderer,
  source: THREE.Texture,
  n: number,
  layer = 0,
): Promise<Float32Array> {
  const rt = new THREE.RenderTarget(n, n, { depthBuffer: false, type: THREE.FloatType });
  rt.texture.name = 'cascadeView/probe';
  try {
    renderer.copyTextureToTexture(
      source,
      rt.texture,
      new THREE.Box3(new THREE.Vector3(0, 0, layer), new THREE.Vector3(n, n, layer + 1)),
    );
    const raw = (await renderer.readRenderTargetPixelsAsync(rt, 0, 0, n, n)) as unknown as
      | Float32Array
      | undefined;
    if (!raw) throw new Error('cascadeView: readback returned nothing');
    // three does NOT strip the 256-byte row padding WebGPU requires
    // (WebGPUTextureUtils.copyTextureToBuffer aligns bytesPerRow and hands the
    // mapped range straight back). At N=512 rgba32f a row is 8192 B and the
    // padding is zero, but a resolution change would otherwise return a
    // diagonally striped field that still looks like data.
    const floatsPerRow = (Math.ceil((n * 16) / 256) * 256) / 4;
    if (floatsPerRow === n * 4) {
      if (raw.length < n * n * 4) {
        throw new Error(`cascadeView: readback short — ${raw.length} of ${n * n * 4} floats`);
      }
      return raw;
    }
    const out = new Float32Array(n * n * 4);
    for (let y = 0; y < n; y++) out.set(raw.subarray(y * floatsPerRow, y * floatsPerRow + n * 4), y * n * 4);
    return out;
  } finally {
    rt.dispose();
  }
}
