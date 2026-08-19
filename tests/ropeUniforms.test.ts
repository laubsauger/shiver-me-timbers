/**
 * §V62 tripwire for the rope path: EVERY ROPE UNIFORM MUST FOLLOW ITS PARAM.
 *
 * WHY THIS EXISTS. `uniform(x)` COPIES x at construction; it does not bind to
 * it. Twenty-five rope uniforms were built that way and never refreshed, so
 * every slider in the panel's `ropes` folder moved a number nothing read —
 * gravity, damping, wind, the LOD distances, the phone-wire thresholds, every
 * colour. Nothing errored; the controls simply did nothing, which is exactly
 * the failure shape §V62 collects.
 *
 * The property asserted is NOT "gravity is 9.81" (that is a decision, §V80) —
 * it is "the shader-side value tracks the param it mirrors, whatever that
 * param is", which is what makes in-browser tuning possible at all. It is
 * checked by driving each param to a value it does not currently hold,
 * running one update, and demanding the uniform moved with it.
 *
 * Like tests/causticsNodes.test.ts this imports three/webgpu on purpose: node
 * construction only, no GPU, so it proves the wiring and not the picture.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { createRopes } from '../src/ropes';
import { ropeParams, type RopeParams } from '../src/params/ropes';
import type { RungDescriptor } from '../src/ropes/ratlines';
import type { BlockDescriptor } from '../src/ropes/blockMath';

/** one rung and one block, so the ratline and block meshes actually exist —
 *  createRopes skips both when their descriptor lists are empty */
const RUNGS: RungDescriptor[] = [
  { ropeA: 0, ropeB: 1, tA: 0.3, tB: 0.3, sag: 0.04, radius: 0.022 },
];
const BLOCKS: BlockDescriptor[] = [
  { rope: 0, t: 0.04, size: 0.25, away: 1, socket: 'test-socket' },
];

function build() {
  const ropes = createRopes({ maxRopes: 4, rungs: RUNGS, blocks: BLOCKS });
  if (ropes.ratlines === null) throw new Error('ratlines missing');
  if (ropes.blocks === null) throw new Error('blocks missing');
  return {
    ropes,
    compute: ropes.uniforms.compute,
    mesh: ropes.uniforms.mesh,
    ratlines: ropes.ratlines,
    blocks: ropes.blocks,
  };
}

const defaults: RopeParams = { ...ropeParams };
afterEach(() => {
  Object.assign(ropeParams, defaults);
});

/** a value the param provably does not hold now, inside its panel range */
const nudge = (v: number): number => v + 0.5;

describe('§V62 rope uniforms follow their params', () => {
  it('refreshes every scalar tunable of the compute solver', () => {
    // WHY: these are the §V42 chain's physics. Frozen, the rope cannot be
    // tuned in a browser at all — which is why §T.48 blocks the dynamic-rope
    // flip on this wiring.
    const { ropes, compute } = build();

    ropeParams.dynamic = true;
    ropeParams.gravity = nudge(ropeParams.gravity);
    ropeParams.damping = 0.9;
    ropeParams.windForce = nudge(ropeParams.windForce);
    ropeParams.gustSpeed = nudge(ropeParams.gustSpeed);
    ropeParams.gustDepth = 0.2;
    ropeParams.maxStray = nudge(ropeParams.maxStray);
    ropeParams.strayFraction = 0.4;
    ropeParams.teleportDistance = nudge(ropeParams.teleportDistance);
    ropeParams.simDistance = nudge(ropeParams.simDistance);
    ropeParams.simFadeBand = nudge(ropeParams.simFadeBand);
    ropes.update();

    expect(compute.uDynamic.value).toBe(1);
    expect(compute.uGravity.value).toBe(ropeParams.gravity);
    expect(compute.uDamping.value).toBe(ropeParams.damping);
    expect(compute.uWindForce.value).toBe(ropeParams.windForce);
    expect(compute.uGustSpeed.value).toBe(ropeParams.gustSpeed);
    expect(compute.uGustDepth.value).toBe(ropeParams.gustDepth);
    expect(compute.uMaxStray.value).toBe(ropeParams.maxStray);
    expect(compute.uStrayFraction.value).toBe(ropeParams.strayFraction);
    expect(compute.uTeleport.value).toBe(ropeParams.teleportDistance);
    expect(compute.uSimDistance.value).toBe(ropeParams.simDistance);
    expect(compute.uSimFadeBand.value).toBe(ropeParams.simFadeBand);

    // the master switch is a switch: OFF must reach the shader too, or the
    // §V42 flip is one-way from the panel's point of view
    ropeParams.dynamic = false;
    ropes.update();
    expect(compute.uDynamic.value).toBe(0);
    ropes.dispose();
  });

  it('refreshes the rope and ratline render tunables', () => {
    // WHY: the §V41 regime thresholds decide which rope shader a pixel gets.
    // Frozen, the near/far crossfade cannot be tuned against a real screen.
    const { ropes, mesh, ratlines } = build();

    ropeParams.roughness = 0.31;
    ropeParams.aaMinWidthPx = nudge(ropeParams.aaMinWidthPx);
    ropeParams.farWidthPx = nudge(ropeParams.farWidthPx);
    ropeParams.nearWidthPx = nudge(ropeParams.nearWidthPx);
    ropeParams.farLightness = nudge(ropeParams.farLightness);
    ropes.update();

    expect(mesh.uRoughness.value).toBe(ropeParams.roughness);
    expect(mesh.uMinWidthPx.value).toBe(ropeParams.aaMinWidthPx);
    expect(mesh.uFarWidthPx.value).toBe(ropeParams.farWidthPx);
    expect(mesh.uNearWidthPx.value).toBe(ropeParams.nearWidthPx);
    expect(mesh.uFarLightness.value).toBe(ropeParams.farLightness);
    // the rungs are the same hemp on the same two regimes — they must not
    // drift away from the ropes they are seized to
    expect(ratlines.uRoughness.value).toBe(ropeParams.roughness);
    expect(ratlines.uFarLightness.value).toBe(ropeParams.farLightness);
    ropes.dispose();
  });

  it('refreshes the block tunables', () => {
    // WHY: uSlackSpan sets when a block swings up into its line (§V46), and
    // the two detail thresholds are the §V48 band limit on its sheave/strop.
    const { ropes, blocks } = build();

    ropeParams.blockSlackSpan = 0.05;
    ropeParams.blockDetailMinPx = nudge(ropeParams.blockDetailMinPx);
    ropeParams.blockDetailMaxPx = nudge(ropeParams.blockDetailMaxPx);
    ropes.update();

    expect(blocks.uniforms.uSlackSpan.value).toBe(ropeParams.blockSlackSpan);
    expect(blocks.uniforms.uDetailMinPx.value).toBe(ropeParams.blockDetailMinPx);
    expect(blocks.uniforms.uDetailMaxPx.value).toBe(ropeParams.blockDetailMaxPx);
    ropes.dispose();
  });

  it('refreshes colours in place, in sRGB, without replacing the Color', () => {
    // WHY, two properties in one test because they fail together:
    //  1. §V31 — a hex param must enter through the sRGB transfer, so the
    //     refreshed colour must equal what `new THREE.Color(hex)` builds. A
    //     bare setRGB lands in linear working space, ~2x too bright.
    //  2. the uniform must keep the SAME Color object. Assigning a fresh
    //     Color to `.value` is the shape that drops bindings (§V29's family),
    //     and it would satisfy a value check while breaking the graph.
    const { ropes, mesh, ratlines, blocks } = build();
    const before = {
      rope: mesh.uColor.value,
      rung: ratlines.uColor.value,
      shell: blocks.uniforms.uShell.value,
      sheave: blocks.uniforms.uSheave.value,
      strop: blocks.uniforms.uStrop.value,
    };

    ropeParams.colorHex = 0x8899aa;
    ropeParams.blockColorHex = 0x112233;
    ropeParams.blockSheaveColorHex = 0x445566;
    ropes.update();

    const expected = (hex: number): THREE.Color => new THREE.Color(hex);
    expect(mesh.uColor.value.equals(expected(0x8899aa))).toBe(true);
    expect(ratlines.uColor.value.equals(expected(0x8899aa))).toBe(true);
    expect(blocks.uniforms.uShell.value.equals(expected(0x112233))).toBe(true);
    expect(blocks.uniforms.uSheave.value.equals(expected(0x445566))).toBe(true);
    // the strop IS rope, so it tracks the ROPE's albedo, not the block's
    expect(blocks.uniforms.uStrop.value.equals(expected(0x8899aa))).toBe(true);

    expect(mesh.uColor.value).toBe(before.rope);
    expect(ratlines.uColor.value).toBe(before.rung);
    expect(blocks.uniforms.uShell.value).toBe(before.shell);
    expect(blocks.uniforms.uSheave.value).toBe(before.sheave);
    expect(blocks.uniforms.uStrop.value).toBe(before.strop);
    ropes.dispose();
  });

  it('drops a non-finite param instead of pushing it at the GPU (§V28)', () => {
    // WHY: `__params.ropes.aaMinWidthPx = NaN` from the console is one
    // keystroke away, and that uniform scales GEOMETRY — a NaN-sized
    // primitive wedges the GPU process (§B5) rather than drawing wrongly.
    const { ropes, mesh } = build();
    ropeParams.aaMinWidthPx = 2.5;
    ropes.update();
    (ropeParams as unknown as Record<string, number>).aaMinWidthPx = Number.NaN;
    ropes.update();
    expect(mesh.uMinWidthPx.value).toBe(2.5);
    ropes.dispose();
  });
});

/**
 * The sink has to be CALLED, not merely to exist (§V62: "wire the sink in the
 * same change as the knob"). Derived from main.ts's own source rather than
 * matching a hardcoded variable name, so renaming a rope instance moves the
 * requirement with it instead of raising a false alarm (§V80).
 */
const MAIN = import.meta.glob('../src/main.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

describe('§V62 the refresh is actually called per frame', () => {
  it('updates every rope system main.ts creates', () => {
    const src = Object.values(MAIN)[0];
    expect(src).toBeTruthy();
    const handles = [...src.matchAll(/const\s+(\w+)\s*=\s*createRopes\(/g)].map((m) => m[1]);
    // two ships today; the assertion is per-handle, whatever that count is
    expect(handles.length).toBeGreaterThan(0);
    for (const name of handles) {
      expect(src.includes(`${name}.update()`)).toBe(true);
    }
  });
});
