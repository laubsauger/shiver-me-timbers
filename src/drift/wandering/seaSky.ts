/**
 * The sky over the sea (Part C, Act 3): the same air as Act 2's planet (getTheDrift/atmosphere.ts), seen from
 * just above the water — so the descent to the sea and the sky over it are one sky, and the sunset comes out
 * of the physics: the reddened Sun, the glow over its setting point, the Earth's shadow rising opposite under
 * the pink band above it. Drawn on a sphere centred on the eye (the march takes its ray as world position
 * minus the camera's); the ocean reflects the same function, the Sun left out (its glint road is the ocean's).
 *
 * A CPU twin of the march gives what the scene's lights need: the sunlight's colour at the sea, the sky's
 * irradiance for the ambient, and the colour along the horizon for the haze the water and land melt into.
 */
import * as THREE from 'three/webgpu';
import { Fn, If, acos, cameraPosition, cubeTexture, exp, float, max, min, mix, normalize, positionWorld, select, uniform, vec3, vec4 } from 'three/tsl';
import type { NightSky } from './nightSky';
import { REFLECTED, cirrus, cloudMarch, type CloudData, type CloudUniforms } from './clouds';
import {
  BETA_M, BETA_R_RGB, EARTH_R, H_MIE, H_RAY, MIE_G, MS_FEED_H, MS_SOFT, OZONE_H, OZONE_RGB, OZONE_W, SUN_ANG, SUN_E, SUN_TINT,
  GROUND, chapmanColumn, ozoneColumnCpu, scatter, sunDisc, sunGlare, sunlight, type Air,
} from '../getTheDrift/atmosphere';

type V3 = THREE.Node<'vec3'>;

/** m → Mm */
const MM = 1e-6;
const ATMOS_TOP = EARTH_R + 0.1;

export interface SeaSky {
  readonly mesh: THREE.Mesh;
  /** the sky's radiance toward a world direction, the Sun left out (the ocean's reflected sky) */
  readonly dome: (dir: V3) => V3;
  /** the Sun's disc toward a direction (what the water transmits of it, looking up from below) */
  readonly sunTerm: (dir: V3) => V3;
  /** the eye (world, m above the mean sea) and the unit toward the Sun */
  update(eye: THREE.Vector3, sun: THREE.Vector3): void;
  /** CPU: the sunlight's colour at the sea (transmittance, white = 1, 0 once set) */
  readonly sunColour: THREE.Color;
  /** CPU: the sky's irradiance on an up-facing surface (linear) */
  readonly irradiance: THREE.Color;
  /** CPU: the sky's mean radiance just above the horizon (linear) */
  readonly horizon: THREE.Color;
  /** the eye's adaptation: exposure that opens as the light falls, only partly (night stays night) */
  readonly exposure: number;
}

/** sky irradiance (luminance) that needs no adaptation (the Sun ~30° up), how far the eye adapts (0..1, as a
 * power of the light's fall), and the most it opens */
const ADAPT_REF = 0.4;
const ADAPT = 0.5;
const ADAPT_MAX = 14;

/** THE NIGHT SKY'S OWN LIGHT (starlight, airglow, the Milky Way; the single-scattering air has none, so a
 * moonless night lit nothing at all and the raft went black — a pop at every dissolve into night): an
 * irradiance floor (linear rgb, a little blue), added to the light the scene is lit by but not to the
 * adaptation (the night sky stays as dark as it was) */
const NIGHT_LIGHT: Rgb = [0.009, 0.011, 0.016];

/** the exposure the eye opens to under a sky of this irradiance (luminance, linear) */
export const adaptation = (lum: number): number => Math.min(ADAPT_MAX, Math.pow(ADAPT_REF / Math.max(lum, 1e-9), ADAPT));

type Rgb = [number, number, number];
const smooth = (a: number, b: number, x: number): number => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

/** CPU twin of atmosphere.ts: transmittance from radius r (Mm) at cos-zenith μ out to space */
export function transmittance(r: number, mu: number, air: Air = GROUND): Rgb {
  const cr = chapmanColumn(r, mu, H_RAY);
  const cm = chapmanColumn(r, mu, H_MIE) * BETA_M * air.mie * 1.1;
  const co = air.ozone ? ozoneColumnCpu(r, mu) : 0;
  return [0, 1, 2].map((k) => Math.exp(-(BETA_R_RGB[k] * cr + cm + OZONE_RGB[k] * co))) as Rgb;
}

export function sunlightCpu(r: number, mu: number, air: Air = GROUND): Rgb {
  const dip = Math.sqrt(Math.max(0, r - EARTH_R) * (2 / EARTH_R));
  const k = smooth(-SUN_ANG, SUN_ANG, Math.asin(Math.max(-1, Math.min(1, mu))) + dip);
  const t = transmittance(r, mu, air);
  return [t[0] * k, t[1] * k, t[2] * k];
}

function skylightCpu(r: number, mu: number, air: Air): Rgb {
  const dip = Math.sqrt(Math.max(0, r - EARTH_R) * (2 / EARTH_R));
  const k = smooth(-MS_SOFT, 0.02, Math.asin(Math.max(-1, Math.min(1, mu))) + dip);
  const t = transmittance(Math.max(r + 0.003, EARTH_R + MS_FEED_H), Math.max(mu, Math.sin(-(dip + 0.003))), air);
  return [t[0] * k, t[1] * k, t[2] * k];
}

/** CPU twin of `scatter`: the sky's radiance toward d (unit, y up) from radius r0 on the +y axis */
export function radianceCpu(r0: number, d: THREE.Vector3, S: THREE.Vector3, steps = 48, air: Air = GROUND): Rgb {
  const mie = BETA_M * air.mie;
  const b = r0 * d.y;
  const c = r0 * r0;
  const discTop = b * b - c + ATMOS_TOP * ATMOS_TOP;
  const tTop = -b + Math.sqrt(Math.max(0, discTop));
  const discGnd = b * b - c + EARTH_R * EARTH_R;
  const tGnd = discGnd > 0 ? -b - Math.sqrt(discGnd) : -1;
  const t1 = tGnd > 0 ? tGnd : tTop;
  const ds = t1 / steps;
  let odR = 0;
  let odM = 0;
  let odO = 0;
  const inR = [0, 0, 0];
  const inM = [0, 0, 0];
  const msR = [0, 0, 0];
  const msM = [0, 0, 0];
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * ds;
    const px = d.x * t;
    const py = r0 + d.y * t;
    const pz = d.z * t;
    const r = Math.hypot(px, py, pz);
    const h = Math.max(0, r - EARTH_R);
    const rR = Math.exp(-h / H_RAY) * ds;
    const rM = Math.exp(-h / H_MIE) * ds;
    const rO = Math.max(0, 1 - Math.abs(h - OZONE_H) / OZONE_W) * ds;
    odR += rR * 0.5;
    odM += rM * 0.5;
    odO += rO * 0.5;
    const muS = (px * S.x + py * S.y + pz * S.z) / r;
    const sun = sunlightCpu(r, muS, air);
    const sky = skylightCpu(r, muS, air);
    for (let k = 0; k < 3; k++) {
      const toEye = Math.exp(-(BETA_R_RGB[k] * odR + mie * 1.1 * odM + (air.ozone ? OZONE_RGB[k] * odO : 0)));
      inR[k] += toEye * sun[k] * rR;
      inM[k] += toEye * sun[k] * rM;
      msR[k] += toEye * sky[k] * rR;
      msM[k] += toEye * sky[k] * rM;
    }
    odR += rR * 0.5;
    odM += rM * 0.5;
    odO += rO * 0.5;
  }
  const mu = d.dot(S);
  const phaseR = (3 / (16 * Math.PI)) * (1 + mu * mu);
  const g2 = MIE_G * MIE_G;
  const phaseM = ((3 * (1 - g2)) / (8 * Math.PI * (2 + g2))) * (1 + mu * mu) / Math.pow(1 + g2 - 2 * MIE_G * mu, 1.5);
  const iso = air.ms / (4 * Math.PI);
  return [0, 1, 2].map((k) => (inR[k] * BETA_R_RGB[k] * phaseR + inM[k] * mie * phaseM + (msR[k] * BETA_R_RGB[k] + msM[k] * mie) * iso) * SUN_E) as Rgb;
}

/** the baked galaxy's light against Act 2's (seen from space at exposure 1): the eye opens ~ADAPT_MAX at night */
const NIGHT_GAIN = 1 / 14;
/** sky luminance at which the stars show at half strength: a bright sky hides them (the dome's scale squeezes
 * the night's millionfold fall into a few stops, so their light alone would show them by day) */
const STAR_CONTRAST = 0.002;

/** m: the marine haze between the eye and a cloud (its light falls to 1/e over this) */
const CLOUD_HAZE = 18000;

/** the far sea's mean-square wave slope: Cox–Munk's clean surface, 0.003 + 0.00512·U, at the sea's light air,
 * 2.5 m/s (sea.ts RIPPLE) */
const FAR_SLOPE2 = 0.003 + 0.00512 * 2.5;
/** the far sea's glitter at most, against the Sun's disc (the glint's peak, past what the eye resolves) */
const FAR_GLINT_MAX = 0.5;

/** CPU: the sky's irradiance (linear) on an up-facing surface at radius r0 (Mm), Sun toward `sun` (y up):
 * ∫ L cosθ dω over 8 rings × 16 bearings */
export function skyIrradiance(r0: number, sun: THREE.Vector3): Rgb {
  const E: Rgb = [0, 0, 0];
  const d = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    const el = ((i + 0.5) / 8) * (Math.PI / 2);
    for (let j = 0; j < 16; j++) {
      const az = ((j + 0.5) / 16) * Math.PI * 2;
      d.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
      const L = radianceCpu(r0, d, sun, 32);
      const w = Math.sin(el) * Math.cos(el) * (Math.PI / 2 / 8) * ((Math.PI * 2) / 16);
      for (let k = 0; k < 3; k++) E[k] += L[k] * w;
    }
  }
  return E;
}

export function createSeaSky(radius: number, night?: NightSky, clouds?: { data: CloudData; uniforms: CloudUniforms }): SeaSky {
  const u = { sun: uniform(new THREE.Vector3(0, 1, 0)), eyeR: uniform(EARTH_R) };
  const S = u.sun as unknown as V3;
  const eyeR = u.eyeR as unknown as THREE.Node<'float'>;
  const o = vec3(0, eyeR, 0);
  const C = vec3(0, 0, 0);
  const toGalaxy = uniform(night ? night.toGalaxy : new THREE.Matrix3());
  // the galaxy behind the air, dimmed along the ray (none below the horizon)
  const starsAlong = (d: V3, T: V3, hitGround: THREE.Node<'bool'>, sky: V3): V3 => {
    if (!night) return vec3(0);
    const seen = float(STAR_CONTRAST).div(sky.dot(vec3(0.2126, 0.7152, 0.0722)).add(STAR_CONTRAST));
    return cubeTexture(night.texture, toGalaxy.mul(d)).rgb.mul(T).mul(seen).mul(select(hitGround, float(0), float(NIGHT_GAIN))) as V3;
  };
  // the clouds over the sky by their opacity; the haze in front of them takes them into the sky's own colour
  const withClouds = (behind: V3, light: V3, d: V3, quality?: typeof REFLECTED): V3 => {
    if (!clouds) return behind;
    // the cirrus first (it is behind the cumulus), then the cumulus over it
    const ci = cirrus(cameraPosition, d, clouds.data, clouds.uniforms);
    const kc = exp(ci.dist.div(-CLOUD_HAZE * 3));
    const sky = behind.mul(ci.alpha.oneMinus()).add(ci.light.mul(kc)).add(light.mul(kc.oneMinus()).mul(ci.alpha));
    const c = cloudMarch(cameraPosition, d, clouds.data, clouds.uniforms, quality);
    const k = exp(c.dist.div(-CLOUD_HAZE));
    return mix(sky, c.light.mul(k).add(light.mul(k.oneMinus())), c.alpha) as V3;
  };
  const dome = (dir: V3): V3 => {
    const d = normalize(dir);
    const air = scatter(o, d, C, S, GROUND);
    return withClouds(air.light.add(starsAlong(d, air.T, air.hitGround, air.light)) as V3, air.light, d, REFLECTED);
  };
  const sunTerm = (dir: V3): V3 => {
    const d = normalize(dir);
    return SUN_TINT.mul(sunDisc(acos(d.dot(S).clamp(-1, 1)))).mul(sunlight(eyeR, d.y, GROUND)) as V3;
  };

  // THE FAR SEA: below the horizon, past the ocean's rim (~4.6 km; from 150 m up the horizon is 44 km off), the
  // rays meet the planet — water, which mirrors the sky above it by Fresnel (nearly all of it, this grazing) and
  // carries the Sun's glitter road on to the horizon (Cox–Munk: the share of wave facets tilted to reflect it,
  // the grazing view's masking with them), all under the air between
  const farSea = (d: V3, light: V3, T: V3): V3 => {
    const cv = d.y.negate().max(1e-3);
    const fresnel = float(0.02).add(cv.oneMinus().pow(5).mul(0.98));
    const sky = scatter(o, vec3(d.x, cv, d.z), C, S, GROUND).light;
    const h = normalize(S.sub(d));
    const hy = h.y.max(1e-3);
    const tan2 = h.x.mul(h.x).add(h.z.mul(h.z)).div(hy.mul(hy));
    const facets = exp(tan2.div(-FAR_SLOPE2)).div(Math.PI * FAR_SLOPE2);
    // Smith's masking for the view (Beckmann, rational fit)
    const a = cv.div(max(cv.mul(cv).oneMinus(), 1e-6).sqrt()).div(Math.sqrt(FAR_SLOPE2));
    const lam = select(a.lessThan(1.6), a.mul(a).mul(0.396).sub(a.mul(1.259)).add(1).div(a.mul(a).mul(2.181).add(a.mul(3.535))), float(0));
    const glint = min(facets.mul(fresnel).mul(SUN_E).div(cv.mul(hy.mul(hy).mul(hy.mul(hy))).mul(4)).div(lam.add(1)), sunDisc(float(0)).mul(FAR_GLINT_MAX));
    return light.add(T.mul(sky.mul(fresnel).add(SUN_TINT.mul(sunlight(eyeR, S.y, GROUND)).mul(glint)))) as V3;
  };

  const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
  material.colorNode = Fn(() => {
    const d = normalize(positionWorld.sub(cameraPosition));
    const { light, T, hitGround } = scatter(o, d, C, S, GROUND);
    const r = acos(d.dot(S).clamp(-1, 1));
    // the disc through the air along this ray; its glare goes with the Sun's own light (and with it as it sets)
    const sun = SUN_TINT.mul(sunDisc(r).mul(select(hitGround, float(0), float(1))).mul(sunlight(eyeR, d.y, GROUND)).add(sunlight(eyeR, S.y, GROUND).mul(sunGlare(r))));
    const colour = withClouds(light.add(sun).add(starsAlong(d, T, hitGround, light)) as V3, light, d).toVar();
    If(hitGround, () => {
      colour.assign(farSea(d, light, T).add(SUN_TINT.mul(sunlight(eyeR, S.y, GROUND).mul(sunGlare(r)))));
    });
    return vec4(colour, 1);
  })();
  material.name = 'drift-sea-sky';
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 96, 48), material);
  mesh.renderOrder = -1;
  mesh.frustumCulled = false;
  mesh.name = 'drift-sea-sky';

  const sunColour = new THREE.Color();
  const irradiance = new THREE.Color();
  const horizon = new THREE.Color();
  let exposure = 1;
  const lastSun = new THREE.Vector3(NaN, NaN, NaN);
  let lastR = NaN;
  const d = new THREE.Vector3();
  return {
    mesh,
    dome,
    sunTerm,
    sunColour,
    irradiance,
    horizon,
    get exposure() {
      return exposure;
    },
    update(eye, sun) {
      const r0 = EARTH_R + Math.max(0, eye.y) * MM;
      mesh.position.copy(eye);
      u.sun.value.copy(sun);
      u.eyeR.value = r0;
      if (lastSun.equals(sun) && lastR === r0) return;
      lastSun.copy(sun);
      lastR = r0;
      sunColour.setRGB(...sunlightCpu(r0, sun.y));
      // irradiance on an up-facing surface: ∫ L cosθ dω over the sky (8 rings × 16 bearings)
      const E = skyIrradiance(r0, sun);
      const H = [0, 0, 0];
      for (let j = 0; j < 16; j++) {
        const az = ((j + 0.5) / 16) * Math.PI * 2;
        d.set(Math.sin(az) * Math.cos(0.01), Math.sin(0.01), Math.cos(az) * Math.cos(0.01));
        const L = radianceCpu(r0, d, sun);
        for (let k = 0; k < 3; k++) H[k] += L[k] / 16;
      }
      irradiance.setRGB(E[0] + NIGHT_LIGHT[0], E[1] + NIGHT_LIGHT[1], E[2] + NIGHT_LIGHT[2]);
      horizon.setRGB(H[0], H[1], H[2]);
      const lum = 0.2126 * E[0] + 0.7152 * E[1] + 0.0722 * E[2];
      exposure = adaptation(lum);
    },
  };
}
