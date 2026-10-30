/**
 * The beach's palms for the film (the user's BlenderKit picks, 2026-10-27; exported by
 * scripts/drift-palm-export.py into public/drift/pbr/blenderkit/, gitignored: royalty-free models may be used
 * in renders, not passed on), in place of the game's:
 *
 *   palm_tree_medium_dense            a coconut-like palm (15.9k triangles), the most of them
 *   palm_tree                         a coconut palm with its nuts (39k)
 *   bent_palm_v1                      a palm bent out over the sand (cut to 120k): two, framing the walk
 *   palm_pritchardia_pacifica_small   a fan palm, small (cut to 40k): undergrowth among the others
 *
 * Placed along the top of the beach (beats.ts COAST: `along` up the beach toward −z, `off` out to sea toward
 * −x), seeded, each scaled to a height of its own and leaning a little toward the sea, as palms on a beach do.
 * The walk runs at off −8; nothing stands nearer than off −13. And THROUGH THE ISLAND (`inlandSlots`): coconut palms
 * scattered and clustered all over our island's forest, standing out of its canopy (forest.ts).
 */
import * as THREE from 'three/webgpu';
import { atan, attribute, cameraPosition, diffuseColor, float, length, normalWorld, positionLocal, positionWorld, sin, smoothstep, uniform, vec2, vec3 } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { rng } from '../undertime/web';
import { fbm2Cpu } from '../../terrain/noiseCpu';

type Kind = 'dense' | 'coconut' | 'bent' | 'fan';
const FILES: Record<Kind, string> = {
  dense: 'palm_tree_medium_dense/palm_tree_medium_dense.glb',
  coconut: 'palm_tree/palm_tree.glb',
  bent: 'bent_palm_v1/bent_palm_v1.glb',
  fan: 'palm_pritchardia_pacifica_small/palm_pritchardia_pacifica_small.glb',
};
/** each kind's bark against its maps' (the user, 2026-10-29: "too bright of a bark" — the trunks read near white in
 * the low Sun). A weathered coconut trunk is grey-brown, ~15% albedo; the maps' linear means: dense 0.29 (in
 * luminance), bent 0.21, coconut 0.12 (already a dark red-brown), the fan palm's left as it was */
const BARK: Record<Kind, number> = { dense: 0.5, coconut: 1, bent: 0.7, fan: 1 };
/** m: each kind's height range */
const HEIGHT: Record<Kind, [number, number]> = { dense: [8, 12], coconut: [7, 10], bent: [8, 9], fan: [2.4, 3.6] };

/**
 * THE WIND IN THE PALMS (the user, 2026-10-28: "some sway in the wind … subtle … the leaves also move
 * individually … don't overdo it"): each trunk bends downwind with its height², gusting on two slow sines of its
 * own, and each frond flutters on a phase of its own (its bearing round the crown), more toward its tip. A pure
 * function of the time it is given, so a film frame renders on its own. m at a 10 m crown; m per m out from it.
 */
const SWAY = { crown: 0.22, across: 0.06, flutter: 0.035 };
/** the air the palms stand in: toward −z, the sea's light air (sea.ts WIND_TO) */
const WIND = new THREE.Vector2(0, -1);

/** where they stand: (along, off) m, the kind, and a lean toward the sea (rad) — the two bent palms by hand,
 * the rest scattered (see createPalms) */
const HERO: Array<{ along: number; off: number; kind: Kind; lean: number; turn: number }> = [
  { along: 24, off: -14, kind: 'coconut', lean: 0.38, turn: -1.9 },
  { along: -22, off: -15, kind: 'coconut', lean: 0.32, turn: -1.3 },
];

export interface Palms {
  readonly group: THREE.Group;
  readonly ready: Promise<void>;
  /** s: the time the wind in them runs on */
  setTime(t: number): void;
  /** the light the fronds pass through (set per frame): unit toward the Sun; the Sun's and the sky's radiance on
   * a white surface */
  readonly light: { sun: THREE.Vector3; sunLight: THREE.Vector3; skyLight: THREE.Vector3 };
  /** the sky each palm hides from the ground (beachMaterial.ts setOccluders): its crown, over where the lean
   * carries it, and its foot */
  readonly occluders: Array<[number, number, number, number]>;
}

/** where the palms stand (x, z), without loading them: the plants grow round their feet */
export function palmFeet(beach: { x: number; z: number }): Array<[number, number]> {
  return palmSlots().map((s) => [beach.x - s.off, beach.z - s.along]);
}

/** the share of the light a frond lets through (a coconut leaflet: thin, ~a quarter in the green) */
const TRANSMIT = 0.45;

/** a palm's place, kind, lean (rad) and the way it leans (`dir`, rad about the vertical from toward the sea, −x),
 * its turn about its trunk (rad), height (m), and its colour (a multiplier on its maps': fronds, bark) */
type Slot = { along: number; off: number; kind: Kind; lean: number; turn: number; h: number; dir?: number; tint?: [THREE.Color, THREE.Color] };

/**
 * PALMS THROUGH THE ISLAND (the user, 2026-10-30, on the landing approach: "suddenly they are not palm trees
 * anymore … too much of a homogeneous canopy … too evenly distributed"; the frame had palms only along the beach's
 * front row, over an even broadleaf mass with tall rounded crowns on the ridge). On a real motu the coconut palms
 * stand all through the forest and over it: from the water the skyline is palm heads — in groves and clumps, alone
 * here and there, leaning every way, of every height — above a lower broadleaf canopy (forest.ts: 7–13 m now).
 *
 * INLAND_PALMS of them over our island's forest from INLAND_FROM m in (behind the edge trees' rows; the beach's own
 * palms stand in front) to INLAND_TO, along the stretch of coast the film sees (INLAND_ALONG), where a slow field (PALM_GROVE m across) makes groves and stretches without: a palm is kept
 * by its grove's density, densest in the first ~100 m behind the edge trees (from the water those make the skyline;
 * the first round, 240 of them thinned over 160 m, put only a few heads above the edge trees at 575 s). Heights INLAND_H
 * (m: over the canopy and the edge trees' 7–15 m; a coconut grows to 25 m), the
 * lean up to INLAND_LEAN (rad) any way. Each its own colour (PALM_HUE, PALM_VALUE: ±; the fronds a little toward
 * yellow-green, the bark in value only), and one in DEAD_SHARE with its fronds browned (dying, or a dry year). Their
 * shadows are not drawn (they fall inland, onto the canopy, with the Sun over the sea in w1–w5; a shadow pass of 4M
 * triangles saved).
 */
const INLAND_PALMS = 340;
const INLAND_FROM = 30;
/** m: where on the island they stand — along the beach (beats.ts `along`: the coast seen from the raft's run in, w1–w2,
 * and from the beach, w3–w6) and at most this far inland (the island's far side is never seen from it) */
const INLAND_ALONG: [number, number] = [-420, 445];
const INLAND_TO = 240;
const PALM_GROVE = 70;
const INLAND_H: [number, number] = [13, 22];
const INLAND_LEAN = 0.26;
const PALM_HUE = 0.1;
const PALM_VALUE = 0.14;
const DEAD_SHARE = 0.08;
/** the fronds' bias toward a coconut's yellow-green, and a browned crown's (multipliers on the maps' colour) */
const FROND_BIAS: [number, number, number] = [1.06, 1.02, 0.86];
const FROND_DEAD: [number, number, number] = [1.35, 0.95, 0.55];

/** an island to scatter palms through: its land's box (world m), its ground, and m inland of its shore */
export interface PalmIsland {
  box: { x: [number, number]; z: [number, number] };
  heightAt: (x: number, z: number) => number;
  inland: (x: number, z: number) => number;
}

/** a palm's colour (PALMS THROUGH THE ISLAND), seeded */
function palmTint(r: () => number, dead: boolean): [THREE.Color, THREE.Color] {
  const hue = PALM_HUE * (2 * r() - 1);
  const value = 1 + PALM_VALUE * (2 * r() - 1);
  const bias = dead ? FROND_DEAD : FROND_BIAS;
  const frond = new THREE.Color(value * (1 + hue) * bias[0], value * bias[1], value * (1 - 1.4 * hue) * bias[2]);
  // (the bark only darker, if anything: "too bright of a bark", BARK)
  const bark = new THREE.Color().setScalar(0.82 + 0.2 * r());
  return [frond, bark];
}

/** the palms through the island (PALMS THROUGH THE ISLAND), in beach coordinates */
function inlandSlots(isl: PalmIsland, beach: { x: number; z: number }, taken: Slot[]): Slot[] {
  const r = rng(5311);
  const out: Slot[] = [];
  const all = (): Slot[] => [...taken, ...out];
  const near = (along: number, off: number, d: number): boolean => all().some((s) => Math.hypot(s.along - along, s.off - off) < d);
  for (let i = 0; out.length < INLAND_PALMS && i < 60000; i++) {
    const x = isl.box.x[0] + (isl.box.x[1] - isl.box.x[0]) * r();
    const z = beach.z - (INLAND_ALONG[0] + (INLAND_ALONG[1] - INLAND_ALONG[0]) * r());
    const inland = isl.inland(x, z);
    if (inland < INLAND_FROM || inland > INLAND_TO || isl.heightAt(x, z) < 0.8) continue;
    const grove = fbm2Cpu(x / PALM_GROVE + 3.1, z / PALM_GROVE - 1.7, 3);
    const keep = Math.min(1, Math.max(0, (grove - 0.38) / 0.24)) * (0.25 + 0.75 * Math.exp(-(inland - INLAND_FROM) / 90));
    if (r() > keep) continue;
    const along = beach.z - z;
    const off = beach.x - x;
    // (a clump's palms 3–6 m apart, as they come up from fallen nuts)
    if (near(along, off, 3 + 3 * r())) continue;
    const kind: Kind = r() < 0.8 ? 'dense' : 'coconut';
    const h = INLAND_H[0] + (INLAND_H[1] - INLAND_H[0]) * Math.pow(r(), 0.8);
    out.push({ along, off, kind, lean: 0.03 + INLAND_LEAN * r() * r(), turn: r() * Math.PI * 2, h, dir: r() * Math.PI * 2, tint: palmTint(r, r() < DEAD_SHARE) });
  }
  return out;
}

/** the palms' places, seeded: the two by hand, clusters along the top of the beach, the fan palms under them */
function palmSlots(): Slot[] {
  const r = rng(5200);
  const slots: Slot[] = HERO.map((s) => ({ ...s, h: HEIGHT[s.kind][0] + (HEIGHT[s.kind][1] - HEIGHT[s.kind][0]) * r() }));
  const near = (a: number, o: number, d: number): boolean => slots.some((s) => Math.hypot(s.along - a, s.off - o) < d);
  for (let i = 0; slots.length < 34 && i < 4000; i++) {
    const along = -70 + 140 * r();
    const off = -14 - 40 * Math.pow(r(), 1.4);
    if (near(along, off, 5.5)) continue;
    const kind: Kind = r() < 0.55 ? 'dense' : 'coconut';
    slots.push({ along, off, kind, lean: 0.04 + 0.12 * r(), turn: r() * Math.PI * 2, h: HEIGHT[kind][0] + (HEIGHT[kind][1] - HEIGHT[kind][0]) * r() });
  }
  for (let i = 0, n = 0; n < 16 && i < 4000; i++) {
    const along = -60 + 120 * r();
    const off = -16 - 30 * r();
    if (near(along, off, 3)) continue;
    slots.push({ along, off, kind: 'fan', lean: 0.03, turn: r() * Math.PI * 2, h: HEIGHT.fan[0] + (HEIGHT.fan[1] - HEIGHT.fan[0]) * r() });
    n++;
  }

  return slots;
}

export function createPalms(beach: { x: number; z: number }, ground: (x: number, z: number) => number, island?: PalmIsland, base = `${import.meta.env.BASE_URL}drift/pbr/blenderkit/`): Palms {
  const group = new THREE.Group();
  group.name = 'drift-palms';
  const slots = palmSlots();
  // (the beach's palms take their colours too, from a seed of their own: PALMS THROUGH THE ISLAND)
  const rt = rng(5207);
  for (const s of slots) s.tint = palmTint(rt, false);
  const inland = island ? inlandSlots(island, beach, slots) : [];

  const uSun = uniform(new THREE.Vector3(0, 1, 0));
  const uSunLight = uniform(new THREE.Vector3());
  const uSkyLight = uniform(new THREE.Vector3());
  const uTime = uniform(0);
  /**
   * The sway, on every part of a palm (trunk and fronds, or the crown leaves its trunk). positionNode runs after the
   * instance transform, so the position is the group's: each instance carries its foot and height (`palmFoot`) and
   * its crown's centre (`palmCrown`).
   */
  const swayed = (fronds: boolean): THREE.Node<'vec3'> => {
    const foot = attribute('palmFoot', 'vec4');
    const crown = attribute('palmCrown', 'vec3');
    const p = positionLocal;
    const h = foot.w;
    const up = p.y.sub(foot.y).div(h).clamp(0, 1.2);
    const own = foot.x.mul(0.37).add(foot.z.mul(0.61));
    const gust = sin(uTime.mul(1.3).add(own)).mul(0.6).add(sin(uTime.mul(2.1).add(own.mul(1.7))).mul(0.4)).mul(0.5).add(0.5);
    const sideways = sin(uTime.mul(0.9).add(own.mul(2.3)));
    const k = up.mul(up).mul(h.div(10));
    const wind = vec2(WIND.x, WIND.y);
    const bent = wind.mul(gust.mul(SWAY.crown)).add(vec2(wind.y.negate(), wind.x).mul(sideways.mul(SWAY.across))).mul(k);
    let out = p.add(vec3(bent.x, 0, bent.y));
    if (fronds) {
      // each frond its own: its bearing round the crown sets its phase, its reach the swing
      const rel = p.sub(crown);
      const reach = length(rel.xz);
      const bearing = atan(rel.z, rel.x);
      const flap = sin(uTime.mul(3.1).add(bearing.mul(5)).add(own)).mul(0.7).add(sin(uTime.mul(4.7).add(bearing.mul(3)).add(own.mul(0.5))).mul(0.3));
      out = out.add(vec3(0, flap.mul(reach.mul(SWAY.flutter)).mul(smoothstep(0.3, 2.5, reach)).mul(gust.mul(0.6).add(0.4)), 0));
    }
    return out as THREE.Node<'vec3'>;
  };
  /**
   * A FROND IS LIT THROUGH. Seen from under the canopy — the dome looks up into it — a leaf card's face toward us
   * is the one away from the Sun, lit only by the ambient, and the fronds read black (the v9 review: "this black
   * shit on the side … the palm tree stuff is really meh"). A real frond is thin: the Sun behind it glows through
   * it (brightest looking toward the Sun), and so does the bright sky above. Added as emission, from the leaf's own
   * colour. `backlit` is the Sun on the far side of the leaf from the eye (a product of two dots: whichever way
   * the card's normal faces). The shaded side of the crown, front-lit but in its own shadow, had gone black too.
   */
  const leafOf = (mat: THREE.MeshStandardMaterial): THREE.MeshStandardNodeMaterial => {
    const leaf = new THREE.MeshStandardNodeMaterial({
      map: mat.map,
      normalMap: mat.normalMap,
      roughnessMap: mat.roughnessMap,
      color: mat.color,
      roughness: mat.roughness,
      metalness: 0,
      alphaTest: Math.max(0.4, mat.alphaTest),
      side: THREE.DoubleSide,
    });
    // (the cut as coverage in the dome's 4× multisampled faces, cine/domeCapture.ts — a frond's leaflets a pixel
    // wide were all-or-nothing specks, the 2026-10-29 beach review; plants.ts says how)
    leaf.alphaToCoverage = true;
    const toEye = cameraPosition.sub(positionWorld).normalize();
    const nv = normalWorld.dot(toEye);
    const nl = normalWorld.dot(uSun);
    const backlit = nv.mul(nl).negate().max(0).sqrt();
    const toward = toEye.negate().dot(uSun).max(0).pow(4);
    const sky = toEye.negate().y.max(0);
    // (and a crown is never black inside: light scattered leaf to leaf, the sky's through the fronds above)
    const through = uSunLight.mul(backlit.mul(float(0.5).add(toward.mul(1.5)))).add(uSkyLight.mul(sky.add(0.8)));
    // (light through a leaf comes out yellower and greener than light off it)
    leaf.emissiveNode = diffuseColor.rgb.mul(vec3(1.1, 1.3, 0.6)).mul(through).mul(TRANSMIT);
    leaf.positionNode = swayed(true);
    leaf.name = `${mat.name}-lit-through`;
    return leaf;
  };
  /** a trunk's own material, as a node material that sways with its crown, its bark darkened (BARK) */
  const trunkOf = (mat: THREE.MeshStandardMaterial, kind: Kind): THREE.MeshStandardNodeMaterial => {
    const trunk = new THREE.MeshStandardNodeMaterial({
      map: mat.map,
      normalMap: mat.normalMap,
      roughnessMap: mat.roughnessMap,
      metalnessMap: mat.metalnessMap,
      aoMap: mat.aoMap,
      color: mat.color.clone().multiplyScalar(BARK[kind]),
      roughness: mat.roughness,
      metalness: mat.metalness,
      vertexColors: mat.vertexColors,
      side: mat.side,
    });
    trunk.positionNode = swayed(false);
    trunk.name = `${mat.name}-swaying`;
    return trunk;
  };
  const loader = new GLTFLoader();
  const ready = Promise.all(
    (Object.keys(FILES) as Kind[]).map(async (kind) => {
      const mine = slots.filter((s) => s.kind === kind);
      const theirs = inland.filter((s) => s.kind === kind);
      if (!mine.length && !theirs.length) return;
      const g = await loader.loadAsync(base + FILES[kind]);
      g.scene.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(g.scene);
      const height = box.max.y - box.min.y;
      const cx = (box.min.x + box.max.x) / 2;
      const cz = (box.min.z + box.max.z) / 2;
      const parts: Array<THREE.Mesh & { fronds?: boolean }> = [];
      g.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        // its own place in the file baked in, the trunk's foot at the origin
        const geo = m.geometry.clone().applyMatrix4(m.matrixWorld);
        geo.translate(-cx, -box.min.y, -cz);
        const mats = (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshStandardMaterial[];
        const drawn = mats.map((mat) => (mat.alphaTest > 0 || mat.transparent ? leafOf(mat) : trunkOf(mat, kind)));
        const part: THREE.Mesh & { fronds?: boolean } = new THREE.Mesh(geo, Array.isArray(m.material) ? drawn : drawn[0]);
        // (a mesh of fronds takes its palm's frond colour; one with any bark in it, the bark's)
        part.fronds = mats.every((mat) => mat.alphaTest > 0 || mat.transparent);
        parts.push(part);
      });
      // the beach's palms, and those through the island (no shadows: PALMS THROUGH THE ISLAND)
      for (const [set, name, shadows] of [[mine, kind, true], [theirs, `${kind}-inland`, false]] as const) {
        if (!set.length) continue;
        const feet = new Float32Array(set.length * 4);
        const crowns = new Float32Array(set.length * 3);
        const matrices = set.map((s, i) => {
          const x = beach.x - s.off;
          const z = beach.z - s.along;
          const k = s.h / height;
          // lean toward the sea (−x; or `dir` round from it), turned about its own trunk
          const q = new THREE.Quaternion()
            .setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.dir ?? 0)
            .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), s.lean))
            .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.turn - (s.dir ?? 0)));
          const foot = new THREE.Vector3(x, ground(x, z) - 0.15, z);
          feet.set([foot.x, foot.y, foot.z, s.h], i * 4);
          crowns.set(new THREE.Vector3(0, s.h * (s.kind === 'fan' ? 0.75 : 0.92), 0).applyQuaternion(q).add(foot).toArray(), i * 3);
          return new THREE.Matrix4().compose(foot, q, new THREE.Vector3(k, k, k));
        });
        for (const p of parts) {
          const geo = p.geometry.clone();
          geo.setAttribute('palmFoot', new THREE.InstancedBufferAttribute(feet, 4));
          geo.setAttribute('palmCrown', new THREE.InstancedBufferAttribute(crowns, 3));
          const inst = new THREE.InstancedMesh(geo, p.material, matrices.length);
          matrices.forEach((m, i) => {
            inst.setMatrixAt(i, m);
            inst.setColorAt(i, set[i].tint![p.fronds ? 0 : 1]);
          });
          inst.instanceMatrix.needsUpdate = true;
          inst.castShadow = shadows;
          inst.receiveShadow = true;
          inst.computeBoundingSphere();
          inst.name = `drift-palm-${name}`;
          group.add(inst);
        }
      }
    }),
  ).then(() => undefined);
  const occluders: Array<[number, number, number, number]> = [];
  for (const s of slots) {
    const x = beach.x - s.off;
    const z = beach.z - s.along;
    // the lean is toward the sea (−x), about z: the crown stands out over the sand by h·sin(lean)
    const reach = s.h * Math.sin(s.lean);
    const crown = s.kind === 'fan' ? s.h * 0.5 : s.h * 0.42;
    // (at 0.45 of the sky hidden it did not read at all: the low Sun is most of the light on the sand facing it)
    occluders.push([x - reach * 0.85, z, crown * 1.3, s.kind === 'fan' ? 0.5 : 0.7]);
    occluders.push([x, z, 1.0, 0.5]);
  }
  return { group, ready, occluders, setTime: (t) => void (uTime.value = t), light: { sun: uSun.value as THREE.Vector3, sunLight: uSunLight.value as THREE.Vector3, skyLight: uSkyLight.value as THREE.Vector3 } };
}
