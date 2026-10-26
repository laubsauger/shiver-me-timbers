/**
 * Undertime's medium: a hot, dense, slowly churning plasma the audience is INSIDE — like the inside of a
 * storm cloud lit from within. It glows a little by its own heat while the universe is hot, and is lit by
 * the events in it: every creation burst, bead and annihilation flash lights the gas around it (single
 * scattering, inverse-square), so the dome flickers with inner lightning shaped by the gas. As the universe
 * cools the plasma thins and darkens until it is transparent — the black that follows is the universe
 * becoming see-through.
 *
 * Ray-marched per VIEW DIRECTION on a sphere around the eye (sky.ts reasoning: the six cube faces agree),
 * with exponentially spaced steps (dense near the eye, where parallax lives), a per-pixel jitter, and front
 * to back transmittance — far light is seen through the gas, dimmer and warmer. The density is
 * domain-warped noise drifting slowly; the lights are the frame's strongest events (events.ts eventLights).
 */
import * as THREE from 'three/webgpu';
import { Fn, Loop, cameraPosition, exp, float, hash, mx_fractal_noise_float, normalize, positionWorld, pow, screenCoordinate, select, smoothstep, sqrt, uniform, uniformArray, vec3, vec4 } from 'three/tsl';
import type { EventLight } from './events';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;

/** lights the plasma sees per frame */
export const PLASMA_LIGHTS = 12;
const STEPS = 40;
const NEAR = 0.4;
const FAR = 45;

export interface Plasma {
  readonly mesh: THREE.Mesh;
  update(o: { time: number; density: number; heat: number; lights: EventLight[]; eye: THREE.Vector3 }): void;
  dispose(): void;
}

export function createPlasma(): Plasma {
  const lightPos = uniformArray(Array.from({ length: PLASMA_LIGHTS }, () => new THREE.Vector4()), 'vec4');
  const lightCol = uniformArray(Array.from({ length: PLASMA_LIGHTS }, () => new THREE.Vector4()), 'vec4');
  const u = { time: uniform(0), density: uniform(0), heat: uniform(0) };

  const material = new THREE.MeshBasicNodeMaterial();
  material.side = THREE.BackSide;
  material.transparent = true;
  material.depthWrite = false;
  material.depthTest = false;
  material.blending = THREE.AdditiveBlending;
  material.colorNode = Fn(() => {
    const d = normalize(positionWorld.sub(cameraPosition));
    const light = vec3(0).toVar();
    const T = float(1).toVar();
    // white-noise jitter (a structured one reads as a stipple pattern on the gas)
    const jitter = hash(screenCoordinate.x.add(screenCoordinate.y.mul(4096)).add(u.time.mul(0)));
    const ratio = FAR / NEAR;
    Loop(STEPS, ({ i }) => {
      // exponential spacing: t_i = NEAR · ratio^(i/STEPS)
      const a = float(i).add(jitter).div(STEPS);
      const b = float(i).add(1).add(jitter).div(STEPS);
      const t0 = float(NEAR).mul(exp(a.mul(Math.log(ratio))));
      const t1 = float(NEAR).mul(exp(b.mul(Math.log(ratio))));
      const ds = t1.sub(t0);
      const p = cameraPosition.add(d.mul(t0));
      // churning gas: domain-warped noise drifting slowly; contrast so there is clear air between the clouds
      const drift = vec3(u.time.mul(0.05), u.time.mul(-0.03), u.time.mul(0.02));
      const densityAt = (x: V3): F => {
        // the cheap twin of the gas, for shadows: same large folds, no fine detail
        const n2 = mx_fractal_noise_float(x.mul(0.2).add(drift).mul(1.7), 2, 2.2, 0.55).mul(0.5).add(0.5);
        return pow(smoothstep(0.5, 0.92, n2), float(1.6)).mul(u.density);
      };
      const q = p.mul(0.2).add(drift);
      const warp = vec3(
        mx_fractal_noise_float(q.add(3.1), 2, 2, 0.5),
        mx_fractal_noise_float(q.add(7.7), 2, 2, 0.5),
        mx_fractal_noise_float(q.add(1.3), 2, 2, 0.5),
      ).mul(1.6);
      const n = mx_fractal_noise_float(q.mul(1.7).add(warp), 5, 2.2, 0.55).mul(0.5).add(0.5);
      // wisps, not fog: most of the volume is clear, the gas gathers in folds
      const rho = pow(smoothstep(0.5, 0.92, n), float(1.6)).mul(u.density);
      // light from the events, scattered toward the eye. The strongest light also casts SHADOWS through the
      // gas (four steps toward it): lit edges and dark cores, which is what makes a lit cloud read as volume
      const lit = vec3(0).toVar();
      const L0 = lightPos.element(0) as unknown as V4;
      const toL0 = L0.xyz.sub(p);
      const shadowStep = toL0.length().min(8).div(4);
      const dirL0 = normalize(toL0);
      const occl = float(0).toVar();
      Loop(4, ({ i: m }) => {
        occl.addAssign(densityAt(p.add(dirL0.mul(float(m).add(0.5).mul(shadowStep)))).mul(shadowStep));
      });
      const shadow0 = exp(occl.mul(0.9).negate());
      Loop(PLASMA_LIGHTS, ({ i: j }) => {
        // @types/three 0.186 types an array element loosely; at runtime it is a vec4
        const L = lightPos.element(j) as unknown as V4;
        const C = lightCol.element(j) as unknown as V4;
        const toL = L.xyz.sub(p);
        const r2 = toL.dot(toL).add(0.3);
        // the light is absorbed on its way through the gas, blue first: a flash makes a warm POOL of light
        // around it, not a lit dome (the gas's mean extinction stands in for a march toward each light)
        const r = sqrt(r2);
        const absorb = exp(vec3(0.16, 0.2, 0.26).mul(r).mul(u.density).negate());
        // forward scattering (Henyey-Greenstein, g 0.5): gas between the eye and a flash glows brightest
        const cosT = normalize(toL).dot(d.negate());
        const hg = float(0.75).div(pow(float(1.25).sub(cosT.mul(1)), float(1.5))).mul(0.5);
        const s = select(j.equal(0), shadow0, float(1));
        lit.addAssign(C.xyz.mul(absorb).mul(hg).mul(s).div(r2));
      });
      // its own heat: a faint deep red in the densest folds while hot (never a fill)
      const heat = vec3(0.6, 0.12, 0.05).mul(u.heat).mul(0.004);
      const sigma = rho.mul(0.12);
      light.addAssign(lit.mul(0.45).add(heat).mul(rho).mul(T).mul(ds));
      T.mulAssign(exp(sigma.mul(ds).negate()));
    });
    return vec4(light, 1);
  })();
  material.name = 'undertime-plasma';
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(300, 96, 48), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  mesh.name = 'undertime-plasma';

  return {
    mesh,
    update(o) {
      u.time.value = o.time;
      u.density.value = o.density;
      u.heat.value = o.heat;
      for (let k = 0; k < PLASMA_LIGHTS; k++) {
        const l = o.lights[k];
        (lightPos.array[k] as THREE.Vector4).set(l ? l.pos[0] : 0, l ? l.pos[1] : 0, l ? l.pos[2] : 0, 0);
        (lightCol.array[k] as THREE.Vector4).set(l ? l.colour[0] : 0, l ? l.colour[1] : 0, l ? l.colour[2] : 0, 0);
      }
      mesh.position.copy(o.eye);
    },
    dispose() {
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}
