/** Real gameplay sea + default controls: steering must turn the boat without rolling it onto its side. */
import { expect, it } from 'vitest';
import { CpuOcean } from '../src/sea-physics/cpuOcean';
import { oceanParams } from '../src/params/ocean';
import { SPEEDBOAT_SEAS } from '../src/params/speedboatSea';
import { speedboatSeaParams } from '../src/speedboat/page/seaParams';
import { weatherPresets } from '../src/weather/presets';
import { buildDeepVHull } from '../src/speedboat/hullMesh';
import { createPlayerBoat } from '../src/speedboat/page/playerBoat';
import { assistPreset, createAssistState, readBoatSim, stepAssists } from '../src/speedboat/assists';
import { neutralBoatInput } from '../src/speedboat/controls/boatInput';
import type { ShipState } from '../src/state/simState';

it('full right helm in the open sea turns through 30° while staying below 45° of roll', () => {
  const hull = buildDeepVHull();
  const preset = SPEEDBOAT_SEAS.open;
  const ocean = Object.assign(structuredClone(oceanParams), structuredClone(weatherPresets[preset.weather].ocean), preset.ocean);
  const mirror = new CpuOcean(2100, ocean, speedboatSeaParams(hull));
  const yaw = Math.PI / 2;
  const state: ShipState = {
    id: 'player', kind: 'player', rudder: 0, sailTrim: 0, flood: 0, damage: {},
    position: [0, 0.35, 0], quaternion: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
    velocity: [30, 0, 0], angularVelocity: [0, 0, 0],
  };
  const player = createPlayerBoat({ hull, pressureHeadAt: (x, z, t) => mirror.pressureHeadAt(x, z, t) }, state);
  const assist = createAssistState();
  const settings = assistPreset('default');
  const input = neutralBoatInput();
  const dt = 1 / 60;
  let peakRoll = 0;
  let turn = 0;
  let previousHeading = yaw;
  for (let tick = 0; tick < 1200; tick++) {
    const time = (tick + 1) * dt;
    mirror.update(time);
    input.throttle = 1;
    input.steer = tick >= 600 ? 1 : 0;
    const command = stepAssists(input, readBoatSim(player.hw, state), settings, assist, dt, hull.drives[0].maxSteerRad);
    player.tick({ steer: command.steerRad / hull.drives[0].maxSteerRad, throttle: command.throttle, trim: 0, surge: false }, time);
    const [x, y, z, w] = state.quaternion;
    const heading = Math.atan2(2 * (x * z + w * y), 1 - 2 * (x * x + y * y));
    if (tick >= 600) {
      const delta = heading - previousHeading;
      turn += Math.atan2(Math.sin(delta), Math.cos(delta));
      peakRoll = Math.max(peakRoll, Math.abs(Math.atan2(2 * (x * y + w * z), 1 - 2 * (x * x + z * z))));
    }
    previousHeading = heading;
  }
  // Keeping the boat straight or stopping it is not a steering fix.
  expect(turn * 180 / Math.PI, 'right turn').toBeLessThan(-30);
  expect(Math.hypot(state.velocity[0], state.velocity[2]), 'still underway').toBeGreaterThan(10);
  // Historical topside-planing classification: 49.8° in this 10-second turn (68.1° over 30 s).
  expect(peakRoll * 180 / Math.PI, 'roll while steering').toBeLessThan(45);
}, 20000);
