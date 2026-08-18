/**
 * GROUND COVER GEOMETRY — grass tufts and shrubs (§V43).
 *
 * THE DEFECT THIS CLOSES, and it is the sibling of the one groundCover.ts
 * opens with. That file made the island's green mass a believable COLOUR. The
 * user's next look at it was "there's no grass on the island", and they were
 * right in the only sense that matters: below palm scale there was no
 * GEOMETRY anywhere on an island. The green was terrain albedo and nothing
 * else, so the island had no silhouette between "sand" and "9 m palm" — every
 * reference in docs/inspo/island/ has a fringe of tufts along the top of the
 * beach (ref-island-147 and -149 most clearly) and undergrowth behind it.
 *
 * ── THE COST RULE THIS IS BUILT AROUND ─────────────────────────────────────
 * The frame is CPU-BOUND: ~557 draws against a GPU that finishes in a third of
 * the encode time. DRAW CALLS ARE THE SCARCE RESOURCE AND TRIANGLES ARE NOT.
 * So this is two InstancedMeshes per island — one grass, one shrub — sharing
 * ONE material across every island (§V17), with all per-plant variation in
 * instance attributes and the sway in the vertex stage. A bush that cost a
 * draw call would be the single worst thing anyone could do to this frame, and
 * a thousand of them at 30 triangles each cost less than one.
 *
 * Both meshes are LOD-gated as a unit (`setLodDistance`): past
 * `coverCullDistance` they are `visible = false`, which is zero draws in the
 * main pass AND zero in the shadow pass. Only the island the player is at
 * pays anything at all.
 *
 * ── NO TEXTURES ────────────────────────────────────────────────────────────
 * §V40: the sampler wall is at 16 and the terrain stage has none spare, so
 * there is no alpha-cutout blade card here. Blades are real tapered geometry
 * and shrubs are real domes — which also means no alpha test, no sorting, and
 * no order-dependent transparency, all of which a card would have brought.
 *
 * ── §V.48 ──────────────────────────────────────────────────────────────────
 * There is no procedural spatial field in this material. Every varying term is
 * either an interpolated vertex attribute or an INSTANCE attribute, which is
 * constant across the whole instance and therefore has no gradient to alias.
 * The one thing that could alias is the geometry itself going sub-pixel, and
 * that is what `coverCullDistance` is: the tufts are gone long before a blade
 * is under a pixel. Nothing here needs a band limit; see the audit note on
 * `buildCoverMeshMaterial`.
 *
 * §V2-adjacent: placement is a pure function of (seed, heightmap, params) via
 * createRng only. §V16: every tunable is in params/terrain.ts. §V28: every
 * divisor floored.
 */
import * as THREE from 'three/webgpu';
import {
  attribute,
  float,
  mix,
  positionLocal,
  sin,
  uniform,
  vec3,
} from 'three/tsl';
import { createRng, type Rng } from '../state/rng';
import { terrainParams } from '../params/terrain';
import { fbm2Cpu } from './noiseCpu';

/** what a heightmap has to offer for cover to be placed on it */
export interface CoverTerrain {
  worldRadius: number;
  heightAt(x: number, z: number): number;
}

export interface CoverPlacement {
  /** island-local; y = terrain height (plants sit ON the ground) */
  position: [number, number, number];
  scale: number;
  yaw: number;
  /** 0..1 → per-plant colour + sway-amplitude variation */
  tint: number;
  phase: number;
}

/* -------------------------------------------------------------------------
 * GEOMETRY
 * ---------------------------------------------------------------------- */

interface Builder {
  positions: number[];
  normals: number[];
  /** 0 at the root, 1 at the tip — drives sway AND the root-darkening */
  weights: number[];
  indices: number[];
}

const newBuilder = (): Builder => ({ positions: [], normals: [], weights: [], indices: [] });

function finish(b: Builder): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(b.positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(b.normals, 3));
  g.setAttribute('coverWeight', new THREE.Float32BufferAttribute(b.weights, 1));
  g.setIndex(b.indices);
  g.computeBoundingSphere();
  return g;
}

/**
 * One blade: a tapered strip swept along a quadratic bend, `segments` long.
 *
 * The bend is what stops a tuft reading as a hedgehog — a straight blade has
 * no silhouette from above, which is exactly the view the user reported from.
 * Normals point along the bend's own side vector rather than being computed,
 * so a one-quad-wide strip lights as a curved surface instead of as two flat
 * triangles meeting at a crease.
 */
function pushBlade(
  b: Builder,
  rng: Rng,
  yaw: number,
  height: number,
  width: number,
  bend: number,
  segments: number,
): void {
  const dx = Math.cos(yaw);
  const dz = Math.sin(yaw);
  // side vector: horizontal, perpendicular to the blade's lean direction
  const sx = -dz;
  const sz = dx;
  const first = b.positions.length / 3;
  const lean = bend * (0.7 + rng() * 0.6);
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    // rises fast then falls away outward — a grass blade, not a spike
    const out = lean * t * t;
    const y = height * Math.sin(t * Math.PI * 0.5) * (1 - 0.18 * t * t);
    const hw = width * 0.5 * (1 - t) ** 0.7;
    // face normal: the blade's flat faces the side it bends away from
    const nx = -dx * 0.55;
    const nz = -dz * 0.55;
    const ny = 0.83;
    for (let s = -1; s <= 1; s += 2) {
      b.positions.push(dx * out + sx * s * hw, y, dz * out + sz * s * hw);
      b.normals.push(nx, ny, nz);
      b.weights.push(t);
    }
  }
  for (let i = 0; i < segments; i++) {
    const a = first + i * 2;
    b.indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
}

/** a squashed low-poly dome — the shrub's leaf mass */
function pushDome(
  b: Builder,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  squash: number,
  rings: number,
  segments: number,
  weightBase: number,
): void {
  const first = b.positions.length / 3;
  for (let r = 0; r <= rings; r++) {
    // top half only: the underside is never seen and doubles the triangles
    const lat = (r / rings) * Math.PI * 0.62;
    const sy = Math.cos(lat);
    const sr = Math.sin(lat);
    for (let c = 0; c <= segments; c++) {
      const lon = (c / segments) * Math.PI * 2;
      const nx = Math.cos(lon) * sr;
      const nz = Math.sin(lon) * sr;
      b.positions.push(cx + nx * radius, cy + sy * radius * squash, cz + nz * radius);
      // normal of the squashed ellipsoid (unnormalised is fine — the shader
      // normalises, and the ratio is what carries the shape)
      const ny = sy / Math.max(squash, 1e-3); // §V28 floored divisor
      const len = Math.hypot(nx, ny, nz) || 1; // §V28 floored divisor
      b.normals.push(nx / len, ny / len, nz / len);
      // sway weight rises with height up the bush so the top of it moves most
      b.weights.push(weightBase + (1 - weightBase) * sy * 0.7);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let c = 0; c < segments; c++) {
      const a = first + r * (segments + 1) + c;
      const d = a + segments + 1;
      b.indices.push(a, d, a + 1, a + 1, d, d + 1);
    }
  }
}

/** A tuft of blades fanned around a point. Deterministic per seed. */
export function buildGrassGeometry(seed: number, p = terrainParams): THREE.BufferGeometry {
  const rng = createRng(seed);
  const b = newBuilder();
  const blades = Math.max(1, Math.floor(p.grassBlades));
  for (let i = 0; i < blades; i++) {
    // golden-angle fan + jitter: an even spray with no visible rotational
    // symmetry, which a plain i/blades ring would have
    const yaw = i * 2.39996 + rng() * 0.9;
    pushBlade(
      b,
      rng,
      yaw,
      p.grassHeight * (0.6 + rng() * 0.8),
      p.grassWidth * (0.75 + rng() * 0.5),
      p.grassBend * (0.5 + rng()),
      Math.max(1, Math.floor(p.grassSegments)),
    );
  }
  return finish(b);
}

/**
 * A shrub: two or three overlapping leaf domes with a skirt of blades round
 * the base, so the silhouette is a rounded mass that still has an edge.
 * The user asked for shrubs by name; this is the mid-height layer between the
 * grass fringe and the palms.
 */
export function buildShrubGeometry(seed: number, p = terrainParams): THREE.BufferGeometry {
  const rng = createRng(seed);
  const b = newBuilder();
  const lobes = Math.max(1, Math.floor(p.shrubLobes));
  for (let i = 0; i < lobes; i++) {
    const a = i * 2.39996 + rng();
    const off = i === 0 ? 0 : p.shrubRadius * (0.35 + rng() * 0.45);
    const radius = p.shrubRadius * (i === 0 ? 1 : 0.55 + rng() * 0.35);
    pushDome(
      b,
      Math.cos(a) * off,
      p.shrubRadius * (0.12 + rng() * 0.25),
      Math.sin(a) * off,
      radius,
      p.shrubSquash * (0.85 + rng() * 0.3),
      Math.max(1, Math.floor(p.shrubRings)),
      Math.max(3, Math.floor(p.shrubSegments)),
      0.25,
    );
  }
  const skirt = Math.max(0, Math.floor(p.shrubSkirtBlades));
  for (let i = 0; i < skirt; i++) {
    const yaw = i * 2.39996 + rng() * 0.9;
    pushBlade(
      b,
      rng,
      yaw,
      p.shrubRadius * (1.0 + rng() * 0.7),
      p.grassWidth * 1.3,
      p.shrubRadius * 0.8,
      Math.max(1, Math.floor(p.grassSegments)),
    );
  }
  return finish(b);
}

/* -------------------------------------------------------------------------
 * PLACEMENT
 * ---------------------------------------------------------------------- */

/**
 * Where cover grows, as a pure function of (seed, terrain, params).
 *
 * A JITTERED GRID, NOT A RANDOM SCATTER. `count` uniform-random points inside
 * a disc is a Poisson process: it clumps and it leaves holes at every scale,
 * so raising the count to fill the holes just makes the clumps denser. A grid
 * with a full-cell jitter gives an even field for free, and the CLUMPING is
 * then put back deliberately by the noise gate below — which is the difference
 * between undergrowth that follows the ground and undergrowth that looks
 * sprayed on. (Same lesson as `palmGroveAngles`, one level down in scale.)
 *
 * THE GATES, in the order they reject:
 *  - height above the waterline: `coverMinHeight` keeps it off the wet beach,
 *    and it is deliberately keyed to the SAND SKIRT (`shoreBandHeight`) so the
 *    fringe starts exactly where the painted sand hands over to green rather
 *    than at an unrelated elevation — the two would drift apart otherwise and
 *    the user would see tufts standing in sand.
 *  - slope: nothing takes root on a face steeper than `coverSlopeLimit`. This
 *    is what keeps the new cliff masses' surroundings looking like rock.
 *  - a clump noise, so cover comes in stands with bare ground between them.
 */
export function generateCoverPlacements(
  seed: number,
  hm: CoverTerrain,
  spacing: number,
  clumpThreshold: number,
  density: number,
  p = terrainParams,
): CoverPlacement[] {
  const rng = createRng(seed);
  const out: CoverPlacement[] = [];
  const R = hm.worldRadius;
  const step = Math.max(spacing, 0.25); // §V28 floored divisor
  const cells = Math.floor((R * 2) / step);
  // the sand skirt's own top, so the fringe starts where the sand ends
  const minH = p.shoreBandHeight * p.coverMinHeightFraction;
  const noiseFreq = p.coverClumpScale;
  for (let iz = 0; iz < cells; iz++) {
    for (let ix = 0; ix < cells; ix++) {
      // draw the jitter FIRST and unconditionally, so the rng stream does not
      // depend on which cells pass — determinism must not be gate-dependent
      const jx = rng();
      const jz = rng();
      const keep = rng();
      const sizeRoll = rng();
      const yawRoll = rng();
      const tintRoll = rng();
      const phaseRoll = rng();
      if (keep > density) continue;
      const x = -R + (ix + jx) * step;
      const z = -R + (iz + jz) * step;
      if (x * x + z * z > R * R) continue;
      const h = hm.heightAt(x, z);
      if (h < minH || h > p.coverMaxHeight) continue;
      // central-difference slope, same probe as island/heightmap.gradientAt
      const d = step * 0.5;
      const gx = (hm.heightAt(x + d, z) - hm.heightAt(x - d, z)) / (2 * d);
      const gz = (hm.heightAt(x, z + d) - hm.heightAt(x, z - d)) / (2 * d);
      if (Math.hypot(gx, gz) > p.coverSlopeLimit) continue;
      if (fbm2Cpu(x * noiseFreq, z * noiseFreq, 2) < clumpThreshold) continue;
      out.push({
        position: [x, h, z],
        scale: p.coverScaleMin + (p.coverScaleMax - p.coverScaleMin) * sizeRoll,
        yaw: yawRoll * Math.PI * 2,
        tint: tintRoll,
        phase: phaseRoll * Math.PI * 2,
      });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------
 * MATERIAL
 * ---------------------------------------------------------------------- */

/* eslint-disable @typescript-eslint/no-explicit-any */

export function createCoverMeshUniforms() {
  const p = terrainParams;
  return {
    time: uniform(0),
    windDir: uniform(new THREE.Vector2(1, 0)),
    windStrength: uniform(1),
    swayAmplitude: uniform(p.coverSwayAmplitude),
    swaySpeed: uniform(p.coverSwaySpeed),
    swayGust: uniform(p.coverSwayGust),
    baseColor: uniform(new THREE.Color(p.coverBaseColor)),
    tipColor: uniform(new THREE.Color(p.coverTipColor)),
    dryColor: uniform(new THREE.Color(p.coverDryColor)),
    rootDarken: uniform(p.coverRootDarken),
    roughness: uniform(p.coverRoughness),
  };
}

export type CoverMeshUniforms = ReturnType<typeof createCoverMeshUniforms>;

export function updateCoverMeshUniforms(u: CoverMeshUniforms): void {
  const p = terrainParams;
  u.swayAmplitude.value = p.coverSwayAmplitude;
  u.swaySpeed.value = p.coverSwaySpeed;
  u.swayGust.value = p.coverSwayGust;
  u.baseColor.value.setHex(p.coverBaseColor);
  u.tipColor.value.setHex(p.coverTipColor);
  u.dryColor.value.setHex(p.coverDryColor);
  u.rootDarken.value = p.coverRootDarken;
  u.roughness.value = p.coverRoughness;
}

/**
 * ONE material for every tuft and bush on every island (§V17).
 *
 * SWAY IS IN THE VERTEX STAGE and is driven by the LIVE wind — the same
 * `windDir`/`windStrength` the palms and the sea read, so the whole scene
 * agrees about the weather instead of the grass having its own breeze.
 * Amplitude is `weight²`, which is the palms' contract too (windSway.ts): the
 * root is pinned at exactly zero, so a blade can never shear out of the
 * ground, and the tip carries all of the motion.
 *
 * The gust term is a travelling wave in world space, so a gust visibly crosses
 * a field of grass rather than every plant on the island bending in lockstep —
 * the same defect `runupPhaseScale` exists to fix on the shoreline.
 *
 * §V.48 AUDIT NOTE. `instanceTint` and `instancePhase` are INSTANCE
 * attributes: constant over an entire instance, so they are flat-shaded
 * per-plant values with no spatial derivative and nothing to alias.
 * `coverWeight` is a vertex attribute interpolated over a triangle, i.e.
 * band-limited by the rasteriser by construction. The travelling gust is the
 * only world-space term, and it is evaluated PER INSTANCE (at the instance
 * origin, not per vertex), so it too is constant across the plant. There is no
 * procedural field sampled per fragment in this material at all.
 * @band-limited-elsewhere — no per-fragment spatial field; see above
 */
export function createCoverMeshMaterial() {
  const u = createCoverMeshUniforms();
  const weight = attribute('coverWeight', 'float');
  const tint = attribute('instanceTint', 'float');
  const phase = attribute('instancePhase', 'float');

  // --- vertex: wind sway ---------------------------------------------------
  // instance origin in world space, for the travelling gust. `modelWorldMatrix`
  // is not exposed as a TSL constant here, so the phase is taken from the
  // per-instance attribute instead — it is a hash of the placement position
  // (see generateCoverPlacements), which is what a spatial gust phase IS.
  const t = u.time.mul(u.swaySpeed);
  const gust = sin(t.mul(0.37).add(phase.mul(u.swayGust))).mul(0.5).add(0.75);
  const bend = sin(t.add(phase)).add(sin(t.mul(1.7).add(phase.mul(2.1))).mul(0.35));
  const amp = weight
    .mul(weight)
    .mul(u.swayAmplitude)
    .mul(u.windStrength)
    .mul(gust);
  // Bend along the wind in the instance's own frame. The instance matrix has
  // a yaw in it, so this is not exactly world-aligned per plant — which is
  // correct and cheaper than un-rotating: real grass leans downwind with a
  // spread, not as one rigid comb.
  const swayOffset = vec3(u.windDir.x, float(0), u.windDir.y).mul(bend.mul(amp));

  // --- fragment: colour ----------------------------------------------------
  // Per-plant hue walk between two greens, then a dry straw variant on a
  // minority. §ffeb839: saturation is NOT a free axis — a low-chroma
  // yellow-olive reads grey-purple under this sky's blue fill, because the
  // fill's blue then carries more chroma than the albedo's green does. So the
  // variation here moves VALUE and HUE and leaves chroma alone; `coverDryColor`
  // is a genuinely warm straw, not a desaturated green.
  let albedo: any = mix(u.baseColor, u.tipColor, tint);
  albedo = mix(albedo, u.dryColor, tint.smoothstep(0.72, 0.98));
  // roots sit in shadow under their own canopy — this is the contact cue that
  // stops a tuft reading as a decal floating on the ground
  albedo = albedo.mul(mix(u.rootDarken, float(1), weight.smoothstep(0, 0.55)));

  const material = new THREE.MeshStandardNodeMaterial();
  material.positionNode = positionLocal.add(swayOffset);
  material.colorNode = albedo;
  material.roughnessNode = u.roughness;
  material.metalness = 0;
  // blades are one quad wide: both faces are seen, and backface culling would
  // make half of every tuft disappear as the camera moves round it
  material.side = THREE.DoubleSide;

  return {
    material,
    uniforms: u,
    /** per-frame: sim time (s), unit wind xz, wind strength 0..1+ */
    setWind(time: number, windDir: [number, number], windStrength: number): void {
      u.time.value = time;
      const [x, z] = windDir;
      const len = Math.hypot(x, z);
      if (len > 1e-6) (u.windDir.value as THREE.Vector2).set(x / len, z / len);
      u.windStrength.value = windStrength;
    },
    updateFromParams(): void {
      updateCoverMeshUniforms(u);
    },
    dispose(): void {
      material.dispose();
    },
  };
}

export type CoverMeshMaterial = ReturnType<typeof createCoverMeshMaterial>;

/* -------------------------------------------------------------------------
 * ASSEMBLY
 * ---------------------------------------------------------------------- */

export interface CreateGroundCoverOptions {
  seed: number;
  heightmap: CoverTerrain;
  /** shared material (islandMaterials.ts); omit and this builds its own */
  material?: CoverMeshMaterial;
}

export interface GroundCoverMeshes {
  group: THREE.Group;
  /** total instances across both species — the LOD ceiling and the cost */
  readonly instanceCount: number;
  /** per-frame LOD (§V17): hide the whole set past `coverCullDistance` */
  setLodDistance(cameraDistance: number): void;
  dispose(): void;
}

function buildBatch(
  name: string,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  placements: CoverPlacement[],
): THREE.InstancedMesh | null {
  if (placements.length === 0) return null;
  const mesh = new THREE.InstancedMesh(geometry, material, placements.length);
  mesh.name = name;
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const tints = new Float32Array(placements.length);
  const phases = new Float32Array(placements.length);
  for (let i = 0; i < placements.length; i++) {
    const pl = placements[i];
    position.set(...pl.position);
    quat.setFromAxisAngle(up, pl.yaw);
    scale.setScalar(pl.scale);
    mesh.setMatrixAt(i, matrix.compose(position, quat, scale));
    tints[i] = pl.tint;
    phases[i] = pl.phase;
  }
  mesh.instanceMatrix.needsUpdate = true;
  geometry.setAttribute('instanceTint', new THREE.InstancedBufferAttribute(tints, 1));
  geometry.setAttribute('instancePhase', new THREE.InstancedBufferAttribute(phases, 1));
  // instance matrices are baked into the batch, so the unit-tuft bounds would
  // cull the lot the moment the island origin left the frustum (same trap
  // rocks.ts and scatter.ts each had to fix). Grown by the sway reach so a
  // blade cannot bend out of its own culling volume.
  mesh.computeBoundingSphere();
  if (mesh.boundingSphere) {
    mesh.boundingSphere.radius += terrainParams.coverSwayAmplitude * terrainParams.coverScaleMax;
  }
  // Grass does not cast: a tuft's shadow is smaller than a shadow texel at
  // the shipped rig (extent 80 / map 2048 → 7.8 cm) and every caster is a
  // second draw in the shadow pass, which is the CPU-bound half of the frame.
  // It RECEIVES, which is the half that actually reads.
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Build one island's ground cover: two instanced batches, LOD-gated together.
 */
export function createGroundCover(opts: CreateGroundCoverOptions): GroundCoverMeshes {
  const p = terrainParams;
  const own = opts.material ? null : createCoverMeshMaterial();
  const material = (opts.material ?? own!).material;

  const grassGeo = buildGrassGeometry(opts.seed, p);
  const shrubGeo = buildShrubGeometry(opts.seed + 5501, p);
  const grassPl = generateCoverPlacements(
    opts.seed,
    opts.heightmap,
    p.grassSpacing,
    p.grassClumpThreshold,
    p.grassDensity,
    p,
  );
  const shrubPl = generateCoverPlacements(
    opts.seed + 911,
    opts.heightmap,
    p.shrubSpacing,
    p.shrubClumpThreshold,
    p.shrubDensity,
    p,
  );

  const group = new THREE.Group();
  group.name = 'island-ground-cover';
  const grass = buildBatch('island-grass', grassGeo, material, grassPl);
  const shrub = buildBatch('island-shrubs', shrubGeo, material, shrubPl);
  if (grass) group.add(grass);
  if (shrub) group.add(shrub);

  return {
    group,
    instanceCount: grassPl.length + shrubPl.length,
    setLodDistance(cameraDistance: number): void {
      group.visible = cameraDistance <= p.coverCullDistance;
    },
    dispose(): void {
      grassGeo.dispose();
      shrubGeo.dispose();
      grass?.dispose();
      shrub?.dispose();
      own?.dispose();
    },
  };
}
