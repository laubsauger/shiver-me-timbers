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
 * The walk runs at off −8; nothing stands nearer than off −13.
 */
import * as THREE from 'three/webgpu';
import { atan, attribute, cameraPosition, diffuseColor, float, length, normalWorld, positionLocal, positionWorld, sin, smoothstep, uniform, vec2, vec3 } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { rng } from '../undertime/web';

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

type Slot = { along: number; off: number; kind: Kind; lean: number; turn: number; h: number };

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

export function createPalms(beach: { x: number; z: number }, ground: (x: number, z: number) => number, base = `${import.meta.env.BASE_URL}drift/pbr/blenderkit/`): Palms {
  const group = new THREE.Group();
  group.name = 'drift-palms';
  const slots = palmSlots();

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
      if (!mine.length) return;
      const g = await loader.loadAsync(base + FILES[kind]);
      g.scene.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(g.scene);
      const height = box.max.y - box.min.y;
      const cx = (box.min.x + box.max.x) / 2;
      const cz = (box.min.z + box.max.z) / 2;
      const parts: THREE.Mesh[] = [];
      g.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        // its own place in the file baked in, the trunk's foot at the origin
        const geo = m.geometry.clone().applyMatrix4(m.matrixWorld);
        geo.translate(-cx, -box.min.y, -cz);
        const mats = (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshStandardMaterial[];
        const drawn = mats.map((mat) => (mat.alphaTest > 0 || mat.transparent ? leafOf(mat) : trunkOf(mat, kind)));
        parts.push(new THREE.Mesh(geo, Array.isArray(m.material) ? drawn : drawn[0]));
      });
      const feet = new Float32Array(mine.length * 4);
      const crowns = new Float32Array(mine.length * 3);
      const matrices = mine.map((s, i) => {
        const x = beach.x - s.off;
        const z = beach.z - s.along;
        const k = s.h / height;
        // lean toward the sea (−x), turned about its own trunk
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), s.lean).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.turn));
        const foot = new THREE.Vector3(x, ground(x, z) - 0.15, z);
        feet.set([foot.x, foot.y, foot.z, s.h], i * 4);
        crowns.set(new THREE.Vector3(0, s.h * (s.kind === 'fan' ? 0.75 : 0.92), 0).applyQuaternion(q).add(foot).toArray(), i * 3);
        return new THREE.Matrix4().compose(foot, q, new THREE.Vector3(k, k, k));
      });
      for (const p of parts) {
        p.geometry.setAttribute('palmFoot', new THREE.InstancedBufferAttribute(feet, 4));
        p.geometry.setAttribute('palmCrown', new THREE.InstancedBufferAttribute(crowns, 3));
        const inst = new THREE.InstancedMesh(p.geometry, p.material, matrices.length);
        matrices.forEach((m, i) => inst.setMatrixAt(i, m));
        inst.instanceMatrix.needsUpdate = true;
        inst.castShadow = true;
        inst.receiveShadow = true;
        inst.computeBoundingSphere();
        inst.name = `drift-palm-${kind}`;
        group.add(inst);
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
