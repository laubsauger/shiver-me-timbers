/** SCRATCH — §T.140/§T.144 before/after measurement. Not a gate. */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Material } from 'three';
import { buildRaftBlueprint, raftLayout } from '../src/ship/raftBlueprint';
import { ShipAssembly } from '../src/ship/shipAssembly';
import { raftParams } from '../src/params/raft';
import { playerParams } from '../src/params/player';
import { thatchCourses } from '../src/ship/pieceGeometryRaft';
import { roofSlope } from '../src/ship/raftPartsCabin';

const stub = () => ({ dispose(): void {} }) as unknown as Material;

describe('scratch T140 measurements', () => {
  it('prints the rig, roof and lane numbers', () => {
    const p = raftParams;
    const raft = buildRaftBlueprint();
    const L = raftLayout();
    const asm = new ShipAssembly(raft, stub);
    asm.group.updateMatrixWorld(true);
    const byId = new Map(raft.map((d) => [d.id, d]));
    const wb = (id: string): THREE.Box3 => {
      const mesh = asm.group.getObjectByName(`${id}-mesh`) as THREE.Mesh;
      asm.group.updateWorldMatrix(true, true);
      mesh.geometry.computeBoundingBox();
      return mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld);
    };
    const sailBox = (id: string): THREE.Box3 => new THREE.Box3().setFromObject(asm.sailMesh(id));
    const deck = L.deckY;
    const out: string[] = [];
    const row = (k: string, v: number): void => { out.push(`${k.padEnd(42)} ${v.toFixed(3)}`); };

    const crossing = byId.get('mast-main')!;
    const crossingY = crossing.transform.position[1] + crossing.aabb.min[1];
    const topY = crossing.transform.position[1] + crossing.aabb.max[1];
    row('logTopY', L.logTopY);
    row('deckY', deck);
    row('crossing above deck', crossingY - deck);
    row('pole tip above deck', topY - deck);
    const perch = asm.socketWorldPosition('station-lookout');
    row('perch above deck', perch[1] - deck);
    row('lookout eye above deck', perch[1] + playerParams.standHeight - playerParams.eyeDrop - deck);
    const main = sailBox('sail-main-lower');
    const top = sailBox('sail-main-upper');
    row('main sail head above deck', main.max.y - deck);
    row('main sail foot above deck', main.min.y - deck);
    row('main drop (live)', main.max.y - main.min.y);
    row('topsail foot above deck', top.min.y - deck);
    row('topsail head above deck', top.max.y - deck);
    row('GAP main head -> topsail foot', top.min.y - main.max.y);
    row('gap / main drop', (top.min.y - main.max.y) / (main.max.y - main.min.y));
    const sp = byId.get('sail-main-lower')!;
    // per-x clearance between the two sails (the box test is corner-to-corner)
    const binned = (id: string): Map<number, [number, number]> => {
      const mesh = asm.sailMesh(id);
      const m = new Map<number, [number, number]>();
      mesh.updateWorldMatrix(true, false);
      mesh.traverse((o) => {
        const mm = o as THREE.Mesh;
        if (!mm.isMesh) return;
        const pos = mm.geometry.attributes.position;
        const v = new THREE.Vector3();
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(mm.matrixWorld);
          const k = Math.round(v.x * 4);
          const cur = m.get(k);
          if (cur === undefined) m.set(k, [v.y, v.y]);
          else m.set(k, [Math.min(cur[0], v.y), Math.max(cur[1], v.y)]);
        }
      });
      return m;
    };
    const bl = binned('sail-main-lower');
    const bu = binned('sail-main-upper');
    let worst = Infinity;
    for (const [k, [lo]] of bu) {
      const l = bl.get(k);
      if (l === undefined) continue;
      worst = Math.min(worst, lo - l[1]);
    }
    row('WORST per-x gap topsail foot - main head', worst);
    row('sail piece aabb y span', sp.aabb.max[1] - sp.aabb.min[1]);
    row('sail piece aabb max y', sp.aabb.max[1]);
    const yd = byId.get('yard-main-lower')!;
    row('yard rot x (rake)', yd.transform.rotation[0]);
    row('yard rot z (cock)', yd.transform.rotation[2]);
    row('yard world y', new THREE.Vector3(...yd.transform.position).y);
    const ybox = wb('yard-main-lower');
    row('yard box y span', ybox.max.y - ybox.min.y);
    row('main sail box x span', main.max.x - main.min.x);
    row('main sail box z span', main.max.z - main.min.z);
    row('leg diameter', byId.get('bipod-leg-port')!.aabb.max[0] * 2);
    row('yard diameter', byId.get('yard-main-lower')!.aabb.max[1] * 2);

    // roof
    const roof = byId.get('thatch-roof-starboard')!;
    const slabLen = roof.aabb.max[0] - roof.aabb.min[0];
    const courses = thatchCourses(slabLen, roof.aabb.max[1], roof.shape ?? {});
    row('roof aabb min y', roof.aabb.min[1]);
    row('roof aabb max y', roof.aabb.max[1]);
    row('course[0] bottom', courses[0].bottom);
    row('course[0] top', courses[0].top);
    row('built ridge thickness', courses[0].top - courses[0].bottom);
    row('built eave thickness', courses[courses.length - 1].top - courses[courses.length - 1].bottom);
    row('course count', courses.length);
    row('roof slope deg', (roofSlope(p) * 180) / Math.PI);
    const rp = wb('thatch-roof-port');
    const rs = wb('thatch-roof-starboard');
    row('port roof max x (ridge overshoot)', rp.max.x);
    row('stbd roof min x (ridge overshoot)', rs.min.x);
    row('ridge INTERPENETRATION', rp.max.x - rs.min.x);
    row('roof top y over cabin floor', Math.max(rp.max.y, rs.max.y) - L.cabinFloorY);

    // T144-3: the lane between the bipod and the cabin front, at capsule heights
    const legS = byId.get('bipod-leg-starboard')!;

    const legR = legS.aabb.max[0];
    for (const h of [0.2, 0.9, 1.1, 1.7]) {
      // leg axis z at height h over its own step, carrying the rake
      const e = new THREE.Euler(...legS.transform.rotation);
      const axis = new THREE.Vector3(0, h, 0).applyEuler(e)
        .add(new THREE.Vector3(...legS.transform.position));
      row(`leg axis z at h=${h}`, axis.z);
      row(`  leg AFT face z at h=${h}`, axis.z - legR);
    }
    row('cabin front wall z', L.cabinFrontZ);
    row('roof fwd overhang edge z', L.cabinFrontZ + p.roofOverhang);
    row('roof fwd edge world z', Math.max(rp.max.z, rs.max.z));
    row('mastZ', L.mastZ);
    row('capsule radius', playerParams.capsuleRadius);

    // T144-2: the mid guara and the plank chest
    const g3 = byId.get('guara-3')!;
    const gb = wb('guara-3');
    const cb = wb('plank-chest');
    row('guara-3 x', g3.transform.position[0]);
    row('guara-3 z', g3.transform.position[2]);
    row('guara-3 box z0', gb.min.z);
    row('guara-3 box z1', gb.max.z);
    row('guara-3 box y0', gb.min.y);
    row('guara-3 box y1', gb.max.y);
    row('chest z0', cb.min.z);
    row('chest z1', cb.max.z);
    row('chest x0', cb.min.x);
    row('chest x1', cb.max.x);
    row('chest y1', cb.max.y);
    const ox = Math.min(gb.max.x, cb.max.x) - Math.max(gb.min.x, cb.min.x);
    const oy = Math.min(gb.max.y, cb.max.y) - Math.max(gb.min.y, cb.min.y);
    const oz = Math.min(gb.max.z, cb.max.z) - Math.max(gb.min.z, cb.min.z);
    row('guara-3 ∩ chest x', ox);
    row('guara-3 ∩ chest y', oy);
    row('guara-3 ∩ chest z', oz);
    for (let k = 1; k <= 5; k++) {
      const g = byId.get(`guara-${k}`)!;
      row(`guara-${k} (x, z)`, g.transform.position[0]);
      row(`  z`, g.transform.position[2]);
    }
    // eslint-disable-next-line no-console
    console.log('\n' + out.join('\n'));
    expect(true).toBe(true);
  });
});
