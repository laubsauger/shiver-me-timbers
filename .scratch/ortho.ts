/** headless orthographic z-buffer render of the ship piece graph */
import * as fs from 'fs';
import * as THREE from 'three';
import { buildGalleonBlueprint } from '/Users/flo/work/code/shiver-me-timbers/src/ship/shipBlueprint';
import { buildPieceGeometry } from '/Users/flo/work/code/shiver-me-timbers/src/ship/pieceGeometry';
import type { PieceDef } from '/Users/flo/work/code/shiver-me-timbers/src/ship/pieceTypes';

const bp = buildGalleonBlueprint();
const byId = new Map(bp.map((p) => [p.id, p]));
function worldMatrix(p: PieceDef): THREE.Matrix4 {
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3().fromArray(p.transform.position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...p.transform.rotation)),
    new THREE.Vector3(1, 1, 1));
  if (p.parent) return worldMatrix(byId.get(p.parent)!).clone().multiply(m);
  return m;
}
type Tri = [THREE.Vector3, THREE.Vector3, THREE.Vector3, number];
const tris: Tri[] = [];
const HILITE = new Set(['figurehead','headrail','ratlines','pennant','gunport','channel','cathead','anchor','pin-rail','binnacle','window','moulding','rail']);
for (const p of bp) {
  const g = buildPieceGeometry(p.kind, p.aabb, p.shape);
  const gi = g.index ? g.index.array : null;
  const pos = g.attributes.position;
  const M = worldMatrix(p);
  const n = gi ? gi.length : pos.count;
  const tone = HILITE.has(p.kind) ? 1 : 0;
  for (let i = 0; i < n; i += 3) {
    const v: THREE.Vector3[] = [];
    for (let k = 0; k < 3; k++) {
      const idx = gi ? gi[i + k] : i + k;
      v.push(new THREE.Vector3(pos.getX(idx), pos.getY(idx), pos.getZ(idx)).applyMatrix4(M));
    }
    tris.push([v[0], v[1], v[2], tone]);
  }
  g.dispose();
}
console.log('tris', tris.length);

const W = 1100, H = 620;
function render(file: string, project: (v: THREE.Vector3) => [number, number, number]) {
  const zb = new Float32Array(W * H).fill(Infinity);
  const cb = new Uint8Array(W * H * 3);
  const light = new THREE.Vector3(0.4, 0.8, 0.45).normalize();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), nrm = new THREE.Vector3();
  for (const [a, b, c, tone] of tris) {
    e1.subVectors(b, a); e2.subVectors(c, a); nrm.crossVectors(e1, e2).normalize();
    const lam = Math.max(0.12, Math.abs(nrm.dot(light)));
    const P = [project(a), project(b), project(c)];
    const minX = Math.max(0, Math.floor(Math.min(P[0][0], P[1][0], P[2][0])));
    const maxX = Math.min(W - 1, Math.ceil(Math.max(P[0][0], P[1][0], P[2][0])));
    const minY = Math.max(0, Math.floor(Math.min(P[0][1], P[1][1], P[2][1])));
    const maxY = Math.min(H - 1, Math.ceil(Math.max(P[0][1], P[1][1], P[2][1])));
    const d = (P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (P[1][1] - P[0][1]);
    if (Math.abs(d) < 1e-9) continue;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const w0 = ((P[1][0] - x) * (P[2][1] - y) - (P[2][0] - x) * (P[1][1] - y)) / d;
      const w1 = ((P[2][0] - x) * (P[0][1] - y) - (P[0][0] - x) * (P[2][1] - y)) / d;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const z = w0 * P[0][2] + w1 * P[1][2] + w2 * P[2][2];
      const k = y * W + x;
      if (z >= zb[k]) continue;
      zb[k] = z;
      const g = Math.round(255 * Math.min(1, lam));
      cb[k * 3] = tone ? Math.min(255, g + 70) : g;
      cb[k * 3 + 1] = tone ? Math.round(g * 0.7) : g;
      cb[k * 3 + 2] = tone ? Math.round(g * 0.5) : g;
    }
  }
  fs.writeFileSync(file, `P6\n${W} ${H}\n255\n`);
  fs.appendFileSync(file, Buffer.from(cb));
}
const S = 14, CX = W / 2, CY = H - 60;
render(process.argv[2], (v) => [CX + v.z * S, CY - v.y * S, -v.x]);          // side (from port)
render(process.argv[3], (v) => [CX + v.x * S * 2.2, CY - v.y * S, -v.z]);    // bow-on
