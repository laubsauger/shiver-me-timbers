/**
 * Clouds over the sea (Part C, Act 3): a layer of fair-weather cumulus, ray-marched per view direction in the
 * sky's own shader (seaSky.ts) — so it has no seams across the dome's cube faces, and every frame is a pure
 * function of time (the field drifts with a steady wind).
 *
 * After Schneider's Nubis (Horizon Zero Dawn's clouds): a coverage field decides where clouds are; in it a
 * Perlin–Worley body billows, a height profile rounds its base and top, Worley detail erodes its edges
 * (scripts/drift-cloud-noise.py bakes the volumes). Light: a short march toward the Sun (Beer's law, with a
 * second, softer octave standing in for multiple scattering, and a two-lobe phase — the silver lining toward
 * the Sun); the sunlight's colour at the layer's base and top from the same air (atmosphere.ts — clouds 2 km up
 * stay lit after sunset at the sea, lit from below); the sky's irradiance as ambient, darker at the base.
 *
 * What the references measured (references/sea-golden-hour-sky): sunlit faces warm (#f6e0c3), shaded flanks
 * pinkish, bases blue-violet; toward the Sun, bodies darker than the sky with hard bright rims.
 *
 * Geometry: the layer is a spherical shell (BASE–TOP above the sea) on the planet's curvature, so it closes on
 * the horizon; beyond MAX_DIST it has gone into the haze.
 */
import * as THREE from 'three/webgpu';
import { If, Loop, Break, exp, float, fract, mix, screenCoordinate, smoothstep, sqrt, texture3D, vec3 } from 'three/tsl';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

/** m above the sea: the layer's base and top (fair-weather cumulus) */
export const CLOUD_BASE = 1200;
export const CLOUD_TOP = 2800;
const R = 6.371e6;
/** m: beyond, the clouds have gone into the haze */
const MAX_DIST = 45000;
/** m: the shape volume's tile (cells ~1.5 km), the detail's, the coverage field's */
const SHAPE_TILE = 6000;
const DETAIL_TILE = 700;
const COVER_TILE = 30000;
/** the share of the sky the field gathers cloud groups over */
const GROUPS = 0.55;
/** per m: extinction of the densest cloud (a mean free path of ~15 m) */
const SIGMA = 0.065;
/** the sky's own march; the water's reflection of it can do with far less (a rough sea blurs it) */
export const FULL = { steps: 72, lightSteps: 5, detail: true };
export const REFLECTED = { steps: 24, lightSteps: 2, detail: false };
/** the cores against the edges: dense enough that Beer's law cuts a crisp edge */
const DENSE = 4;

export interface CloudData {
  shape: THREE.Data3DTexture;
  detail: THREE.Data3DTexture;
  ready: Promise<void>;
}

function volume(n: number): THREE.Data3DTexture {
  const t = new THREE.Data3DTexture(new Uint8Array(n * n * n * 4), n, n, n);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.unpackAlignment = 1;
  return t;
}

export function loadClouds(base = `${import.meta.env.BASE_URL}drift/clouds/`): CloudData {
  const shape = volume(128);
  const detail = volume(32);
  const fill = (name: string, tex: THREE.Data3DTexture): Promise<void> =>
    fetch(base + name)
      .then((r) => {
        if (!r.ok) throw new Error(`clouds: ${r.status} (run scripts/drift-cloud-noise.py)`);
        return r.arrayBuffer();
      })
      .then((b) => {
        (tex.image as { data: Uint8Array }).data = new Uint8Array(b);
        tex.needsUpdate = true;
      });
  return { shape, detail, ready: Promise.all([fill('cloud-shape-128.u8', shape), fill('cloud-detail-32.u8', detail)]).then(() => undefined) };
}

export interface CloudUniforms {
  /** s */
  time: F;
  /** m/s, the wind on the sea's xz plane */
  wind: THREE.Node<'vec2'>;
  /** 0..1, how much of the sky the field covers */
  coverage: F;
  /** unit, toward the Sun */
  sun: V3;
  /** the sunlight's radiance on a white surface facing it, at the layer's base and top (linear) */
  sunBase: V3;
  sunTop: V3;
  /** the sky's light on the layer (irradiance / π, linear) */
  ambient: V3;
}

const sat = (x: F): F => x.clamp(0, 1) as F;

/**
 * The layer along a ray from the eye `o` (m, y up, sea level at y = 0) in direction d: the light it sends back
 * (linear), its opacity, and how far its light comes from (m, opacity-weighted; for the haze in front of it).
 */
export function cloudMarch(o: V3, d: V3, data: CloudData, U: CloudUniforms, quality: { steps: number; lightSteps: number; detail: boolean } = FULL): { light: V3; alpha: F; dist: F } {
  const drift = vec3(U.wind.x, 0, U.wind.y).mul(U.time);
  // the planet's surface below the eye: altitude of p ≈ |p − C| − R (C straight down)
  const C = vec3(o.x, float(-R), o.z);
  const alt = (p: V3): F => p.sub(C).length().sub(R) as F;
  const density = (p: V3, detailed: boolean): F => {
    const h = alt(p);
    const hf = sat(h.sub(CLOUD_BASE).div(CLOUD_TOP - CLOUD_BASE));
    const q = p.add(drift);
    // (every noise channel is uniform on [0, 1]: a threshold at 1 − c keeps a share c)
    // where the field gathers clouds: groups over GROUPS of the sky, the cells inside them at `coverage`
    const field = texture3D(data.shape, vec3(q.x.div(COVER_TILE), 0.37, q.z.div(COVER_TILE))).g;
    const groups = smoothstep(1 - GROUPS - 0.12, 1 - GROUPS + 0.12, field);
    const c = U.coverage.mul(groups);
    const s = texture3D(data.shape, q.div(SHAPE_TILE));
    // the body: Perlin–Worley, rounded by the Worley billows
    const body = s.r.mul(0.7).add(s.g.mul(0.2)).add(s.b.mul(0.1));
    // the cell narrows toward its top (cauliflower heads, not columns) and is cut flat at its base
    const thr = float(1).sub(c.mul(float(1).sub(hf.pow(1.5).mul(0.75))));
    const shaped = sat(body.sub(thr).div(thr.oneMinus().max(0.04))).mul(smoothstep(0, 0.05, hf)).mul(float(1).sub(smoothstep(0.85, 1, hf)));
    if (!detailed) return shaped as F;
    const dt = texture3D(data.detail, q.div(DETAIL_TILE));
    const dfbm = dt.r.mul(0.625).add(dt.g.mul(0.25)).add(dt.b.mul(0.125));
    // wispy at the base, billowy at the top
    const erode = mix(dfbm, dfbm.oneMinus(), sat(hf.mul(8))).mul(0.35);
    return sat(shaped.sub(erode).div(erode.oneMinus())) as F;
  };

  // the shell between BASE and TOP along the ray (stable roots: the radii are 6 Mm, the gaps 1 km)
  const r0 = float(R).add(o.y);
  const mu = d.y;
  const toAlt = (H: number): F => {
    const k = float(H).sub(o.y).mul(float(2 * R + H).add(o.y));
    return k.div(r0.mul(mu).add(sqrt(r0.mul(r0).mul(mu.mul(mu)).add(k)))) as F;
  };
  const t0 = toAlt(CLOUD_BASE).max(0);
  const t1 = toAlt(CLOUD_TOP).min(MAX_DIST);
  const light = vec3(0).toVar();
  const T = float(1).toVar();
  const distW = float(0).toVar();
  const cosT = d.dot(U.sun);
  // two-lobe phase: forward (the silver lining) and a little back
  const hg = (g: number): F => float((1 - g * g) / (4 * Math.PI)).div(float(1 + g * g).sub(cosT.mul(2 * g)).pow(1.5)) as F;
  const phase = hg(0.6).mul(0.7).add(hg(-0.25).mul(0.3));
  const phaseSoft = hg(0.3);
  const jitter = fract(fract(screenCoordinate.x.mul(0.06711056).add(screenCoordinate.y.mul(0.00583715))).mul(52.9829189));
  If(mu.greaterThan(0).and(t1.greaterThan(t0)), () => {
    const ds = t1.sub(t0).div(quality.steps);
    Loop(quality.steps, ({ i }) => {
      If(T.lessThan(0.01), () => {
        Break();
      });
      const t = t0.add(float(i).add(jitter).mul(ds));
      const p = o.add(d.mul(t));
      const rho = density(p, quality.detail);
      If(rho.greaterThan(0.002), () => {
        // the light reaching here from the Sun: the cloud between, in steps doubling from 60 m
        const od = float(0).toVar();
        let step = 60;
        let at = 30;
        for (let k = 0; k < quality.lightSteps; k++) {
          od.addAssign(density(p.add(U.sun.mul(at)), false).mul(step * DENSE));
          at += step * 1.5;
          step *= 2;
        }
        const hf = sat(alt(p).sub(CLOUD_BASE).div(CLOUD_TOP - CLOUD_BASE));
        const sunC = mix(U.sunBase, U.sunTop, hf);
        // Beer's law, and a softer second octave for the light scattered on through the cloud
        const direct = exp(od.mul(-SIGMA)).mul(phase).add(exp(od.mul(-SIGMA * 0.25)).mul(phaseSoft).mul(0.35));
        const amb = U.ambient.mul(mix(float(0.45), float(1), hf));
        const S = sunC.mul(direct).mul(Math.PI).add(amb);
        const a = float(1).sub(exp(rho.mul(-SIGMA * DENSE).mul(ds)));
        light.addAssign(S.mul(a).mul(T));
        distW.addAssign(t.mul(a).mul(T));
        T.mulAssign(a.oneMinus());
      });
    });
  });
  const alpha = T.oneMinus();
  return { light: light as unknown as V3, alpha: alpha as F, dist: distW.div(alpha.max(1e-4)) as F };
}
