/**
 * The speedboat pilot asset (assets/models/speedboat_pilot.glb, built by scripts/pilot-build.mjs).
 *
 * Why these rules matter:
 *  - the pilot is parented to the boat's seat socket, so the bind pose must BE the seated pose on the
 *    REAL helm of the parts build: fingers around the actual wheel rim, hips on the pan, root at the
 *    socket. A pilot posed on an assumed wheel grips air (or the dash) in game.
 *  - the cockpit camera rides the pilot's head (cam_eye): it must sit between the eyes, look toward
 *    the bow, and survive the head being hidden (it cannot hang under the collapse bone).
 *  - clips are rotation-only, so an NPC variant re-bound to its own joint positions plays the same
 *    clips without being dragged back to the hero's proportions.
 *  - every mesh shares one ≤ 4-influence skin (one skeleton update, GPU skinning limit) and the
 *    triangle budget per LOD holds for the heaviest variant.
 * Each rule is also proven to FAIL on a document that breaks it: a checker that cannot fail is not
 * a gate.
 */
import { describe, expect, it } from 'vitest';
import { type Document, type Node } from '@gltf-transform/core';
import { createIO, readBytes } from '../scripts/blender/checkGlb.mjs';
import { checkPilotDocument, loadPilotConfig } from '../scripts/blender/pilot/checkPilotGlb.mjs';

const GLB = new URL('../assets/models/speedboat_pilot.glb', import.meta.url).pathname;
const PARTS_GLB = new URL('../assets/models/speedboat_hero.glb', import.meta.url).pathname;
const cfg = loadPilotConfig();

async function load(path = GLB): Promise<Document> {
  const io = await createIO();
  return io.readBinary(readBytes(path));
}

function parseExtras(ex: Record<string, unknown> | undefined): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(ex ?? {})) {
    out[k] = typeof v === 'string' && /^[[{]/.test(v) ? JSON.parse(v) : v;
  }
  return out;
}

const rootExtras = (doc: Document) => parseExtras(doc.getRoot().getDefaultScene()!.listChildren()[0].getExtras());

function joint(doc: Document, name: string): Node {
  const j = doc.getRoot().listSkins()[0].listJoints().find((n) => n.getName() === name);
  if (!j) throw new Error(`joint ${name} missing`);
  return j;
}

const worldPos = (n: Node): number[] => {
  const m = n.getWorldMatrix();
  return [m[12], m[13], m[14]];
};
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: number[]) => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** distance from a point to the core circle of a steering-wheel rim (hub, unit axis, radius) */
function rimCoreDistance(p: number[], hub: number[], axis: number[], R: number): number {
  const rel = sub(p, hub);
  const along = dot(rel, axis);
  const planar = [rel[0] - along * axis[0], rel[1] - along * axis[1], rel[2] - along * axis[2]];
  return Math.hypot(Math.hypot(...planar) - R, along);
}

describe('speedboat pilot GLB', () => {
  it('passes every pilot convention at the final (packaged) stage', async () => {
    const doc = await load();
    const { errors, stats } = checkPilotDocument(doc, cfg, { stage: 'final' });
    expect(errors).toEqual([]);
    expect(stats.worstVariantTris[0]).toBeLessThanOrEqual(cfg.lod.trisMax[0]);
    expect(stats.clips).toEqual(expect.arrayContaining(Object.keys(cfg.clips)));
  });

  it('grips the helm where the parts build puts it (not an assumed wheel)', async () => {
    // the parts GLB carries the helm pivot/axis in the boat body frame and the seat station in its
    // anchors; the pilot frame is that station on the pan top (sole + 0.62)
    const parts = await load(PARTS_GLB);
    const px = rootExtras(parts);
    const anchors = typeof px.partsAnchors === 'string' ? JSON.parse(px.partsAnchors) : px.partsAnchors;
    const helm = parts.getRoot().listNodes().find((n) => n.getName() === 'Helm_LOD0');
    expect(helm, 'parts GLB has no Helm_LOD0 socket node').toBeTruthy();
    const hx = parseExtras(helm!.getExtras());
    const socket = [0, anchors.deckY - 0.75 + cfg.seat.panAboveSole, anchors.seatZ];
    const hubFromParts = sub(hx.pivot, socket);
    expect(dist(hubFromParts, cfg.helm.wheelHub)).toBeLessThan(0.02);
    expect(dot(norm(hx.axis), norm(cfg.helm.wheelAxis))).toBeGreaterThan(0.999);

    const doc = await load();
    const hub = cfg.helm.wheelHub;
    const axis = norm(cfg.helm.wheelAxis);
    for (const s of ['l', 'r'] as const) {
      // fingers wrap the rim: every middle phalanx sits on the rim (outside the tube, within a finger)
      for (const f of ['index', 'middle', 'ring', 'pinky']) {
        const d = rimCoreDistance(worldPos(joint(doc, `${f}_02_${s}`)), hub, axis, cfg.helm.wheelRadius);
        expect(d, `${f}_02_${s} off the rim`).toBeLessThan(cfg.helm.rimTube + 0.045);
        expect(d, `${f}_02_${s} inside the rim`).toBeGreaterThan(cfg.helm.rimTube);
      }
      // the hand is on its own side of the wheel, above the hub (ten-to-two)
      const mid = worldPos(joint(doc, `middle_01_${s}`));
      expect(Math.sign(mid[0])).toBe(s === 'l' ? 1 : -1);
      expect(mid[1]).toBeGreaterThan(hub[1]);
    }
  });

  it('is seated on the pan with the root at the socket', async () => {
    const doc = await load();
    const pelvis = worldPos(joint(doc, 'pelvis'));
    // seat frame: origin = seat station on the pan top, +Y up, +Z bow. Hips between the bucket back
    // and the pan's front edge, a little above the pan
    expect(pelvis[1]).toBeGreaterThan(0.0);
    expect(pelvis[1]).toBeLessThan(0.3);
    expect(Math.abs(pelvis[0])).toBeLessThan(0.01);
    expect(pelvis[2]).toBeGreaterThan(cfg.seat.backrestFaceZ);
    expect(pelvis[2]).toBeLessThan(cfg.seat.panFrontEdgeZ);
    expect(dist(worldPos(joint(doc, 'Root')), [0, 0, 0])).toBeLessThan(0.005);
  });

  it('carries a cockpit camera between the eyes that survives hiding the head', async () => {
    const doc = await load();
    const cam = joint(doc, 'head').listChildren().find((n) => n.getName() === 'cam_eye');
    expect(cam).toBeTruthy();
    const m = cam!.getWorldMatrix();
    const mid = worldPos(joint(doc, 'eye_l')).map((v, i) => (v + worldPos(joint(doc, 'eye_r'))[i]) / 2);
    const view = norm([-m[8], -m[9], -m[10]]);
    const up = norm([m[4], m[5], m[6]]);
    const off = sub([m[12], m[13], m[14]], mid);
    expect(dot(off, view)).toBeCloseTo(cfg.rig.sockets.cam_eye.forwardM, 2);
    expect(view[2]).toBeGreaterThan(0.6); // toward the bow
    expect(up[1]).toBeGreaterThan(0.6); // upright
    // the hide bone is a child of head, and the camera is not under it
    const hide = joint(doc, rootExtras(doc).firstPerson.collapseBone);
    expect(hide.getName()).toBe('head_geo');
    let p: Node | null = cam!.getParentNode();
    for (; p; p = p.getParentNode()) expect(p).not.toBe(hide);
  });

  it("ships each variant's own joint heads, and the hero's match the skeleton it is bound to", async () => {
    const doc = await load();
    const ex = rootExtras(doc) as { variants: Record<string, { jointHeads: Record<string, number[]> }> };
    for (const name of ['pelvis', 'head', 'hand_l', 'foot_r']) {
      expect(dist(ex.variants.hero.jointHeads[name], worldPos(joint(doc, name)))).toBeLessThan(0.002);
    }
    // the variants really differ (otherwise the re-bind path is untested dead data)
    const d = dist(ex.variants.npc_b.jointHeads.hand_l, ex.variants.hero.jointHeads.hand_l);
    expect(d).toBeGreaterThan(0.005);
  });

  describe('the checker fails a GLB that breaks a rule', () => {
    it('a missing clip', async () => {
      const doc = await load();
      doc.getRoot().listAnimations().find((a) => a.getName() === 'capsize_hang')!.dispose();
      expect(checkPilotDocument(doc, cfg, { stage: 'final' }).errors.join('\n')).toMatch(/clips: 'capsize_hang' missing/);
    });

    it('a translation track (clips must stay rotation-only)', async () => {
      const doc = await load();
      const anim = doc.getRoot().listAnimations().find((a) => a.getName() === 'impact_jolt')!;
      const ch = anim.listChannels()[0];
      const extra = doc.createAnimationChannel().setTargetNode(ch.getTargetNode()).setTargetPath('translation').setSampler(ch.getSampler()!);
      anim.addChannel(extra);
      expect(checkPilotDocument(doc, cfg, { stage: 'final' }).errors.join('\n')).toMatch(/rotation-only/);
    });

    it('more than four influences per vertex', async () => {
      const doc = await load();
      const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
      prim.setAttribute('JOINTS_1', prim.getAttribute('JOINTS_0'));
      expect(checkPilotDocument(doc, cfg, { stage: 'final' }).errors.join('\n')).toMatch(/more than 4 influences/);
    });

    it('a seat socket that is not at the origin', async () => {
      const doc = await load();
      const sock = doc.getRoot().getDefaultScene()!.listChildren()[0].listChildren().find((n) => n.getName() === 'PilotSeatSocket')!;
      sock.setTranslation([0, 0.1, 0]);
      expect(checkPilotDocument(doc, cfg, { stage: 'final' }).errors.join('\n')).toMatch(/socket: PilotSeatSocket must sit at the origin/);
    });

    it('a LOD over its triangle budget', async () => {
      const doc = await load();
      const tight = { ...cfg, lod: { ...cfg.lod, trisMax: [10000, 8000, 2500] } };
      expect(checkPilotDocument(doc, tight, { stage: 'final' }).errors.join('\n')).toMatch(/budget: LOD0 worst variant \d+ tris > 10000/);
    });

    it('a mesh without the NPC variant morph targets', async () => {
      const doc = await load();
      const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
      for (const t of prim.listTargets()) prim.removeTarget(t);
      expect(checkPilotDocument(doc, cfg, { stage: 'final' }).errors.join('\n')).toMatch(/variants: .* morph targets/);
    });

    it('a cockpit camera pushed off the eyes, or hung under the head-hide bone', async () => {
      const doc = await load();
      const cam = joint(doc, 'head').listChildren().find((n) => n.getName() === 'cam_eye')!;
      const t = cam.getTranslation();
      cam.setTranslation([t[0] + 0.05, t[1], t[2]]);
      expect(checkPilotDocument(doc, cfg, { stage: 'final' }).errors.join('\n')).toMatch(/camera: cam_eye is .* off the eye midpoint/);
      const doc2 = await load();
      const cam2 = joint(doc2, 'head').listChildren().find((n) => n.getName() === 'cam_eye')!;
      joint(doc2, 'head').removeChild(cam2);
      joint(doc2, 'head_geo').addChild(cam2);
      expect(checkPilotDocument(doc2, cfg, { stage: 'final' }).errors.join('\n')).toMatch(/cam_eye.*(not a child of joint 'head'|under the collapse bone)/);
    });

    it('head geometry left on the camera parent (it would stay visible in the cockpit view)', async () => {
      const doc = await load();
      const skin = doc.getRoot().listSkins()[0];
      const headIdx = skin.listJoints().findIndex((j) => j.getName() === 'head');
      const hair = doc.getRoot().getDefaultScene()!.listChildren()[0].listChildren().find((n) => n.getName() === 'LOD0')!
        .listChildren().find((n) => n.getName().startsWith('Hair_swept'))!;
      const prim = hair.getMesh()!.listPrimitives()[0];
      const j = prim.getAttribute('JOINTS_0')!;
      const el = [0, 0, 0, 0];
      for (let i = 0; i < j.getCount(); i++) {
        j.getElement(i, el);
        el[0] = headIdx;
        j.setElement(i, el);
      }
      expect(checkPilotDocument(doc, cfg, { stage: 'final' }).errors.join('\n')).toMatch(/firstPerson: .* weighted > 25 % to 'head'/);
    });
  });
});
