/**
 * Wind-slanted rain (§T.37, §V47).
 *
 *   const rain = createRain();
 *   scene.add(rain.mesh);
 *   // every frame, after the camera has moved:
 *   rain.update({ camera: app.camera, intensity: weatherAt(x, z).rain });
 *
 * DESIGN — STATELESS ON PURPOSE. Every drop's position is a closed-form
 * function of `instanceIndex` and elapsed time: a hashed world-space origin
 * plus velocity·t, wrapped into a box around the camera. That means no storage
 * buffers, no compute dispatch, no spawn/death bookkeeping — and structurally
 * no room for the two failures that have cost this project the most:
 *   §B8 — there is no compute→render buffer to downgrade with `.toReadOnly()`.
 *   §B5 — there is no particle AGE, so no `0/0` NaN age and no NaN-sized quad.
 * The only divisions left are by the box size and the streak's own view-space
 * speed, both floored, and both feeding results that are bounded independently
 * (§V44: flooring a divisor bounds the division, not the quotient).
 *
 * WORLD-ANCHORED, CAMERA-WRAPPED. Drops fall and are advected in WORLD space,
 * then each is wrapped to the nearest copy of itself around the camera. Rain
 * therefore streams past a moving ship correctly; a camera-relative field would
 * hang motionless in front of the bow no matter how fast she sails.
 *
 * PER-DROP PHASE (§B4). Both the origin and the fall speed are hashed per
 * instance, so no two drops share a wrap period. A single shared time phase is
 * how the whole ocean ended up twinkling in unison once already.
 *
 * WIND (§V47). Direction and speed come from `oceanParams` via
 * rainMath.liveRainWind() — the same wind the sea spectrum and the sails read.
 * This module accepts no wind override; there is nothing to disagree with.
 */
import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  cameraViewMatrix,
  float,
  instanceIndex,
  select,
  smoothstep,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { hash2 } from '../terrain/noise';
import { rainParams } from '../params/rain';
import {
  activeRainCount,
  liveRainWind,
  sanitizeRainCount,
  seaCullDepth,
} from './rainMath';

/** hash salts — distinct per channel so origin axes are not correlated */
const H_X = 0.113;
const H_Y = 0.317;
const H_Z = 0.719;
const H_SPEED = 0.911;
/** golden ratio: spreads consecutive instance indices across the hash domain */
const PHI = 1.618033988749895;

const fin = (v: number, fallback: number): number =>
  Number.isFinite(v) ? v : fallback;

export interface RainUpdate {
  /**
   * 0..1 local rain density — `weather.weatherAt(camX, camZ).rain` (§V46).
   * The volume follows the camera through the `cameraPosition` node, so no
   * camera object is needed here.
   */
  intensity: number;
  /** seconds since the last update; defaults to the fixed sim step */
  dt?: number;
  /**
   * live sea height RMS σ (`ocean.heightRms`) — sets the σ-relative cull that
   * keeps drops from rendering underneath the (see-through, §V24) water.
   * Omitting it runs the cull on a bootstrap σ and warns: silently gating on a
   * constant is precisely the bug §V36 exists to prevent.
   */
  seaSigma?: number;
}

export function createRain() {
  const count = sanitizeRainCount(rainParams.count);

  const uExtent = uniform(1);
  const uHeight = uniform(1);
  const uHeightOffset = uniform(0);
  const uWind = uniform(new THREE.Vector2());
  const uFall = uniform(1);
  const uFallVar = uniform(0);
  const uTime = uniform(0);
  const uActive = uniform(0);
  const uLength = uniform(1);
  const uAspect = uniform(1);
  const uSoftness = uniform(1);
  const uOpacity = uniform(0);
  const uNear0 = uniform(0);
  const uNear1 = uniform(1);
  const uFar0 = uniform(1);
  const uFar1 = uniform(2);
  // sea cull band, both edges computed CPU-side so the shader never has to
  // guard e0 === e1 (σ can legitimately be 0 on a dead-flat sea)
  /** y (m, ≤0) below which a drop is fully gone — σ-relative (§V36) */
  const uSeaCull0 = uniform(-1);
  /** y (m) by which it is back to full strength */
  const uSeaCull1 = uniform(0);
  const uColor = uniform(new THREE.Color(rainParams.color));

  // per-drop seed: fract((i+1)·φ) — pure in instanceIndex, same trick the
  // spray pool uses so nothing has to be stored per particle
  const seed = float(instanceIndex).add(1).mul(PHI).fract().toVar();
  const rx = hash2(vec2(seed, float(H_X)));
  const ry = hash2(vec2(seed, float(H_Y)));
  const rz = hash2(vec2(seed, float(H_Z)));
  const rs = hash2(vec2(seed, float(H_SPEED)));

  // per-drop fall speed around the mean — decorrelates the wrap periods (§B4)
  const fall = uFall.mul(uFallVar.mul(rs.sub(0.5)).add(1)).max(0.05);
  const velocity = vec3(uWind.x, fall.negate(), uWind.y).toVar();

  // hashed world-space origin, advected. Box sizes are floored uniforms, so
  // the origin scale can never be NaN even mid slider-drag.
  const origin = vec3(rx.mul(uExtent), ry.mul(uHeight), rz.mul(uExtent));
  const world = origin.add(velocity.mul(uTime)).toVar();

  /** wrap a camera-relative offset into [−size/2, size/2) — floored divisor */
  const wrap = (d: any, size: any): any =>
    d.sub(size.mul(d.div(size.max(1e-3)).add(0.5).floor()));

  const center = vec3(
    cameraPosition.x,
    cameraPosition.y.add(uHeightOffset),
    cameraPosition.z,
  );
  const rel = world.sub(center);
  const dropPos = center.add(
    vec3(
      wrap(rel.x, uExtent),
      wrap(rel.y, uHeight),
      wrap(rel.z, uExtent),
    ),
  );

  const material = new THREE.SpriteNodeMaterial();
  material.positionNode = dropPos;

  // depth fade band (§V47): invisible at the lens, gone before it can haze the
  // distance. Functional smoothstep only (§V23).
  const camDist = dropPos.sub(cameraPosition).length();
  const nearFade = smoothstep(uNear0, uNear1.max(uNear0.add(0.01)), camDist);
  const farFade = smoothstep(
    uFar0,
    uFar1.max(uFar0.add(0.01)),
    camDist,
  ).oneMinus();
  // drops below the sea are culled: the volume wraps vertically, and the water
  // is see-through in the near field (§V24), so a drop under the surface reads
  // as rain falling through the sea. Cut at −cullSigma·σ, i.e. below any
  // trough, so rain still reaches into the hollows (§V36 — σ, not metres).
  const seaFade = smoothstep(uSeaCull0, uSeaCull1, dropPos.y);
  const depthFade = nearFade.mul(farFade).mul(seaFade);

  // density gate: drops past the active count are ZERO SIZE, not alpha 0 — a
  // transparent quad still costs fill rate, ×12k (§V28, §B5)
  const dead = float(instanceIndex).greaterThanEqual(uActive);
  const hidden = dead.or(depthFade.lessThan(0.01));
  material.scaleNode = select(hidden, float(0), uLength);

  // streak shaping: the sprite quad is built in view space, so the view-space
  // velocity direction IS the quad's long axis. Squashing ACROSS that axis
  // turns a round sprite into a slanted line — and because the velocity
  // carries the wind, the slant is the wind's, automatically.
  const q = uv().mul(2).sub(1);
  const viewVel = cameraViewMatrix.mul(vec4(velocity, 0)).xy;
  const viewSpeed = viewVel.length().toVar();
  // a zero-length direction would leave BOTH quad axes reading 0 → shape 1
  // over the whole quad → a hard bright SQUARE. Fall back to a fixed axis.
  const dir = select(
    viewSpeed.greaterThan(1e-4),
    viewVel.div(viewSpeed.max(1e-4)), // floored divisor (§V28)
    vec2(0, 1),
  );
  const along = q.dot(dir);
  const across = q.dot(vec2(dir.y.negate(), dir.x));
  const r2 = along.mul(along).add(across.mul(uAspect.max(1)).pow(2));
  const shape = r2.oneMinus().max(0).pow(uSoftness.max(1));

  // §V31: sRGB hex through THREE.Color, never a bare setRGB triple
  material.colorNode = uColor;
  material.opacityNode = shape.mul(depthFade).mul(uOpacity).clamp(0, 1);
  material.transparent = true;
  // NOT additive: rain lit by a flat overcast lid is a light grey line over a
  // dark sea, and additive blending on 12k overlapping streaks would blow the
  // near field to white — the exact "grey soup" §V47 forbids, from the other
  // direction. Normal blending keeps the water's colour readable through it.
  material.blending = THREE.NormalBlending;
  material.depthWrite = false;
  material.fog = false;

  const mesh = new THREE.Sprite(material as unknown as THREE.SpriteMaterial);
  mesh.count = count;
  mesh.frustumCulled = false; // positions are derived GPU-side
  mesh.renderOrder = 10; // after the opaque sea, before the UI overlay

  let elapsed = 0;
  /**
   * `world = origin + velocity·t` is evaluated in f32, so a monotonically
   * growing t eventually costs the streaks their sub-metre precision: at 20 m/s
   * an hour of play is 72 km, where one f32 ulp is ~5 mm — still far finer than
   * a 1.1 m streak, but it degrades linearly forever if left unbounded. Wrapping
   * the clock caps it. Every drop jumps at the same instant, which is invisible
   * precisely because they are interchangeable, and it happens once an hour.
   */
  const TIME_WRAP = 3600;
  // bootstrap σ, replaced the first tick a caller supplies one
  let seaSigma = 0.7;
  let sigmaSupplied = false;
  let warnedNoSigma = false;

  return {
    mesh,
    /** sanitized pool size actually rendered */
    count,

    /**
     * Push live params, the shared wind and the local rain density. No compute
     * dispatch and no renderer needed — this is uniform writes only.
     */
    update(input: RainUpdate): void {
      const dt = Math.max(fin(input.dt ?? 1 / 60, 1 / 60), 0);
      elapsed = (elapsed + dt) % TIME_WRAP;
      uTime.value = elapsed;

      uExtent.value = Math.max(fin(rainParams.extent, 100), 1);
      uHeight.value = Math.max(fin(rainParams.height, 60), 1);
      uHeightOffset.value = fin(rainParams.heightOffset, 0);
      uFall.value = Math.max(fin(rainParams.fallSpeed, 8), 0.05);
      uFallVar.value = Math.min(Math.max(fin(rainParams.fallSpeedVariance, 0), 0), 1);
      uLength.value = Math.max(fin(rainParams.streakLength, 1), 0);
      uAspect.value = Math.max(fin(rainParams.streakAspect, 1), 1);
      uSoftness.value = Math.max(fin(rainParams.softness, 1), 1);
      uNear0.value = Math.max(fin(rainParams.fadeNear0, 0), 0);
      uNear1.value = Math.max(fin(rainParams.fadeNear1, 1), uNear0.value + 0.01);
      uFar0.value = Math.max(fin(rainParams.fadeFar0, 50), 0);
      uFar1.value = Math.max(fin(rainParams.fadeFar1, 100), uFar0.value + 0.01);

      // §V36: the underwater cull is a multiple of live sea σ, never metres
      if (input.seaSigma !== undefined && Number.isFinite(input.seaSigma)) {
        seaSigma = Math.max(input.seaSigma, 0);
        sigmaSupplied = true;
      } else if (!sigmaSupplied && !warnedNoSigma) {
        warnedNoSigma = true;
        console.warn(
          'rain: no seaSigma supplied to update() — the underwater cull is ' +
            'running on a bootstrap σ and will not track weather, so rain ' +
            'will show through the water in a storm. Pass ocean.heightRms.',
        );
      }
      uSeaCull0.value = seaCullDepth(seaSigma, rainParams.seaCullSigma);
      // fade back to full strength halfway up to the surface, and kept
      // strictly ABOVE the lower edge so the shader's smoothstep never divides
      // by zero on a dead-flat sea where σ (and so the cull depth) is 0 (§V28)
      uSeaCull1.value = Math.max(uSeaCull0.value * 0.5, uSeaCull0.value + 0.25);

      const intensity = Math.min(Math.max(fin(input.intensity, 0), 0), 1);
      uActive.value = activeRainCount(count, intensity);
      uOpacity.value =
        Math.min(Math.max(fin(rainParams.opacity, 0), 0), 1) *
        (intensity > 0 ? 1 : 0);

      // §V47: the SAME wind the sea and the sails read, no override accepted
      const wind = liveRainWind();
      (uWind.value as THREE.Vector2).set(
        fin(wind.x, 0),
        fin(wind.z, 0),
      );
      (uColor.value as THREE.Color).set(rainParams.color);
    },

    dispose(): void {
      material.dispose();
    },
  };
}

export type Rain = ReturnType<typeof createRain>;
export {
  activeRainCount,
  liveRainWind,
  rainSlant,
  rainWindVector,
  sanitizeRainCount,
  seaCullDepth,
  wrapOffset,
  type RainWind,
} from './rainMath';
