import { Color, type DirectionalLight, type HemisphereLight } from 'three/webgpu';
import { uniform } from 'three/tsl';

/** The page's sky rig owns these, like the shared sea/caustics lighting.
 * Unlit until that rig publishes its first frame; no synthetic daylight.
 * Colors are already linear. Key intensity uses the Lambert 1/pi scale;
 * a small droplet receives ambient from both hemispheres.
 */
export const particleLighting = {
  key: uniform(new Color(0, 0, 0)),
  ambient: uniform(new Color(0, 0, 0)),
};

export function updateParticleLighting(key: DirectionalLight, ambient: HemisphereLight): void {
  particleLighting.key.value.copy(key.color).multiplyScalar(key.intensity / Math.PI);
  particleLighting.ambient.value.copy(ambient.color).add(ambient.groundColor)
    .multiplyScalar(ambient.intensity * 0.5);
}
