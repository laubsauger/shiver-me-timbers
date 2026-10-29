/**
 * THE BLUE CASE (props.ts: the dolphin flips it aboard in c3, its radio's dial glows in c4) as a believable hard
 * case rather than a blue box: a moulded shell and lid with rounded edges and the dark seam between them, ribs
 * on the lid, two latches and a carrying handle on the front. Blue moulded plastic with a light clear sheen (the
 * one smooth, saturated thing on the raft, so it reads against wood and cane in any light), scuffed pale on its
 * corners and edges, a little salt dried in the seam. 0.55 × 0.22 × 0.40 m about its centre, as the box it
 * replaces (the dial's place on its lid, the throw and the landing are props.ts's own).
 */
import * as THREE from 'three/webgpu';
import { float, mix, normalLocal, positionLocal, smoothstep, vec3 } from 'three/tsl';
import { softBox } from '../../ship/pieceGeometryWear';
import { triplanarFbm } from '../../terrain/noise';

const W = 0.55;
const H = 0.22;
const D = 0.4;

export function createHardCase(colour = 0x1f5fa8): THREE.Group {
  const g = new THREE.Group();
  g.name = 'drift-hard-case';
  const shell = new THREE.MeshPhysicalNodeMaterial({ color: colour, metalness: 0 });
  shell.name = 'drift-case-shell';
  const p = positionLocal;
  const scuff = triplanarFbm(p.mul(23), normalLocal, float(6), 3);
  const grain = triplanarFbm(p.mul(140), normalLocal, float(6), 2);
  // pale scuffs where the case is knocked: its edges and corners (far from the face centres), patchy
  const edge = smoothstep(0.17, 0.26, p.x.abs()).max(smoothstep(0.12, 0.19, p.z.abs())).max(smoothstep(0.085, 0.105, p.y.abs()));
  const worn = edge.mul(smoothstep(0.55, 0.8, scuff)).clamp(0, 1);
  // salt dried in the seam and the lid's channels
  const seam = float(1).sub(smoothstep(0.004, 0.02, p.y.sub(0.039).abs())).mul(smoothstep(0.55, 0.8, grain));
  const base = vec3(new THREE.Color(colour).r, new THREE.Color(colour).g, new THREE.Color(colour).b);
  // (the sun has faded the top a touch)
  const top = smoothstep(0.5, 0.9, normalLocal.y);
  let c = mix(base, base.mul(1.25).add(0.02), top.mul(0.35));
  c = mix(c, vec3(0.3, 0.36, 0.45), worn.mul(0.35));
  c = mix(c, vec3(0.5, 0.5, 0.48), seam.mul(0.35));
  shell.colorNode = c.mul(mix(float(0.94), float(1.04), grain));
  shell.roughnessNode = float(0.36).add(worn.mul(0.35)).add(scuff.mul(0.12)).add(seam.mul(0.3));
  shell.clearcoatNode = float(0.3).mul(float(1).sub(worn));
  shell.clearcoatRoughnessNode = float(0.3);
  const dark = new THREE.MeshStandardNodeMaterial({ color: 0x1a1d21, roughness: 0.55, metalness: 0 });
  dark.name = 'drift-case-fittings';
  dark.roughnessNode = float(0.5).add(triplanarFbm(p.mul(60), normalLocal, float(6), 2).mul(0.25));

  const part = (geo: THREE.BufferGeometry, mat: THREE.Material): void => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
  };
  const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, r: number): THREE.BufferGeometry => softBox(x0, x1, y0, y1, z0, z1, r, 1, 3);
  // the shell and the lid, the seam between them; the seam's dark core behind it
  part(box(-W / 2, W / 2, -H / 2, 0.035, -D / 2, D / 2, 0.024), shell);
  part(box(-W / 2, W / 2, 0.043, H / 2, -D / 2, D / 2, 0.024), shell);
  part(box(-W / 2 + 0.008, W / 2 - 0.008, 0.02, 0.06, -D / 2 + 0.008, D / 2 - 0.008, 0.01), dark);
  // ribs across the lid, clear of the dial (props.ts: centred 0.08 to starboard on the lid)
  for (const x of [-0.2, 0.215]) part(box(x - 0.016, x + 0.016, H / 2 - 0.004, H / 2 + 0.007, -D / 2 + 0.03, D / 2 - 0.03, 0.005), shell);
  // two latches on the front, over the seam, and the handle between them on its two posts
  for (const x of [-0.165, 0.165]) part(box(x - 0.032, x + 0.032, -0.012, 0.074, D / 2 - 0.004, D / 2 + 0.014, 0.006), dark);
  part(box(-0.075, 0.075, -0.01, 0.012, D / 2 + 0.018, D / 2 + 0.034, 0.008), dark);
  for (const x of [-0.07, 0.07]) part(box(x - 0.012, x + 0.012, -0.012, 0.012, D / 2 - 0.002, D / 2 + 0.03, 0.004), dark);
  return g;
}
