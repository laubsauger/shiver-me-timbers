/**
 * W8 round 5: THE BOATS' LEDs ON THEIR OWN WAKE FOAM (docs/wake/w8-foam-readability.md §15). The water's LED pool
 * (`ocean/boatLightPool`) is a hull-hugging ellipse (~9 m): at night the lane and its foam 15–25 m astern received none,
 * so the wakes read faint. Foam is a diffuse, high-albedo scatterer, so a lamp at the boat lights it by inverse square
 * past the lamp's own size: E = colour / (1 + d²/R²). Reads the pool's uniform arrays only (no texture, no sampler,
 * §V40); the caller multiplies by the foam's albedo and amount.
 */
import { Loop, vec3 } from 'three/tsl';
import type { BoatLightPool } from '../ocean/boatLightPool';

/** LOOK: lamp size R (m) of the 1/(1 + d²/R²) falloff and gain (round 6: ×¼, lit only where the lane's foam is) */
export const WAKE_LED_RADIUS = 11;
export const WAKE_LED_GAIN = 0.15;
/** the lamps' height above each boat's reference point (m) */
export const WAKE_LED_HEIGHT = 0.4;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node union
export function wakeLedIrradianceNode(pool: BoatLightPool, surfacePos: any): any {
  const { positions, colors } = pool.nodes;
  const acc = vec3(0).toVar();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node union
  Loop(pool.max, ({ i }: { i: any }) => {
    const d = surfacePos.sub(positions.element(i).xyz.add(vec3(0, WAKE_LED_HEIGHT, 0)));
    acc.addAssign(colors.element(i).xyz.div(d.dot(d).div(WAKE_LED_RADIUS * WAKE_LED_RADIUS).add(1)));
  });
  return acc.mul(WAKE_LED_GAIN);
}
