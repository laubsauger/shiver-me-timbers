"""
Stage 1 (body): MPFB2 human -> one skinned base with three variant shapes.

  * MPFB 2.0.17 builds each variant from pilot_config.json `variants` (macros + face targets), and
    the height macro is solved per variant so every variant stands 1.78 m. That keeps one skeleton
    valid for all three (joint drift is measured and fails the build above `body.maxJointDeltaM`).
  * The hero gets MPFB's `game_engine` rig and its CC0 weights, plus the CC0 low-poly eyes, eyebrow
    and eyelash proxies (weights interpolated by MPFB).
  * Every variant is evaluated to plain vertex positions. The hero positions become the mesh, and
    the others become shape keys `variant_b` / `variant_c` on the same topology.
  * Helper geometry (tights, skirt, joint cubes) is deleted. The original MakeHuman vertex index is
    kept in the `mh_index` attribute, so later stages can still use MakeHuman's groups.

Output: <work>/stage_body.blend and <work>/stage_body.json (heights, joint deltas, counts).
"""
import hashlib
import json
import os
import sys

import addon_utils
import bmesh
import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import common as C  # noqa: E402

VARIANT_KEYS = {'npc_b': 'variant_b', 'npc_c': 'variant_c'}


# ── MPFB ─────────────────────────────────────────────────────────────────────


def enable_mpfb(cfg):
    mod_name = cfg['mpfb']['extensionModule']
    # default_set=True: MPFB reads its own preferences at import (factory-startup prefs are never saved)
    mod = addon_utils.enable(mod_name, default_set=True)
    if mod is None:
        raise SystemExit(
            f"[pilot] MPFB extension '{mod_name}' is not installed. Install MPFB {cfg['mpfb']['version']} from "
            f"{cfg['mpfb']['source']} (docs/speedboat/pilot-log.md §Installs)")
    manifest = os.path.join(os.path.dirname(mod.__file__), 'blender_manifest.toml')
    with open(manifest, 'r', encoding='utf-8') as f:
        text = f.read()
    want = f'version = "{cfg["mpfb"]["version"]}"'
    if want not in text:
        raise SystemExit(f'[pilot] MPFB version mismatch: expected {want} in {manifest}')
    from bl_ext.user_default.mpfb.services.locationservice import LocationService  # noqa
    return LocationService.get_user_data(), LocationService.get_mpfb_data('targets')


def verify_assets(cfg, user_data, lock_path, write_lock=False):
    """sha256 of every consumed CC0 file against assets.lock.json (fails loud on drift)."""
    lock = {}
    if os.path.exists(lock_path):
        with open(lock_path, 'r', encoding='utf-8') as f:
            lock = json.load(f)
    out = {}
    for key, a in cfg['assets']['files'].items():
        p = os.path.join(user_data, a['path'])
        if not os.path.exists(p):
            raise SystemExit(f"[pilot] asset '{key}' missing: {p} (CC0 pack '{a['pack']}', see pilot-log.md §Installs)")
        h = hashlib.sha256(open(p, 'rb').read()).hexdigest()
        out[a['path']] = h
        if not write_lock and lock.get(a['path']) != h:
            raise SystemExit(f"[pilot] asset '{key}' sha256 {h[:16]} does not match assets.lock.json ({str(lock.get(a['path']))[:16]})")
    if write_lock:
        with open(lock_path, 'w', encoding='utf-8') as f:
            json.dump(out, f, indent=2, sort_keys=True)
            f.write('\n')
    return out


def _services():
    from bl_ext.user_default.mpfb.services.humanservice import HumanService
    from bl_ext.user_default.mpfb.services.targetservice import TargetService
    from bl_ext.user_default.mpfb.entities.objectproperties import HumanObjectProperties
    return HumanService, TargetService, HumanObjectProperties


def eval_coords(ob):
    """world-space vertex positions with shape keys, with modifiers (armature, mask, subsurf) off"""
    saved = [(m, m.show_viewport) for m in ob.modifiers]
    for m, _ in saved:
        m.show_viewport = False
    dg = bpy.context.evaluated_depsgraph_get()
    dg.update()
    eo = ob.evaluated_get(dg)
    me = eo.to_mesh()
    co = np.empty(len(me.vertices) * 3, dtype=np.float64)
    me.vertices.foreach_get('co', co)
    eo.to_mesh_clear()
    for m, v in saved:
        m.show_viewport = v
    co = co.reshape(-1, 3)
    mw = np.array(ob.matrix_world)
    return co @ mw[:3, :3].T + mw[:3, 3]


def body_mask(ob):
    gi = ob.vertex_groups['body'].index
    mask = np.zeros(len(ob.data.vertices), dtype=bool)
    for v in ob.data.vertices:
        for g in v.groups:
            if g.group == gi and g.weight > 0.5:
                mask[v.index] = True
    return mask


def build_variant(cfg, vname, user_data, targets_dir, rig_weights):
    HumanService, TargetService, HOP = _services()
    v = cfg['variants'][vname]
    macro = json.loads(json.dumps(v['macro']))
    macro['height'] = 0.5
    b = HumanService.create_human(scale=0.1, macro_detail_dict=macro, feet_on_ground=False)
    b.name = f'MH_{vname}'
    for tname, w in sorted(v['targets'].items()):
        TargetService.load_target(b, os.path.join(targets_dir, tname + '.target.gz'), weight=float(w))
    mask = body_mask(b)

    def height(hm):
        HOP.set_value('height', hm, entity_reference=b)
        TargetService.reapply_macro_details(b)
        z = eval_coords(b)[mask, 2]
        return float(z.max() - z.min())

    lo, hi = 0.0, 1.0
    want = cfg['body']['heightM']
    if not (height(lo) <= want <= height(hi)):
        raise SystemExit(f'[pilot] {vname}: height {want} m outside the MPFB height macro range')
    for _ in range(18):
        mid = (lo + hi) / 2
        if height(mid) < want:
            lo = mid
        else:
            hi = mid
    hm = (lo + hi) / 2
    h = height(hm)
    co = eval_coords(b)
    co[:, 2] -= co[mask, 2].min()  # feet on the ground (z = 0)
    b.location = (0, 0, 0)

    rig = HumanService.add_builtin_rig(b, cfg['mpfb']['rig'], import_weights=rig_weights)
    rig.name = f'RIG_{vname}'
    parts = {}
    for part, key in (('eyes', 'eyes'), ('eyebrows', 'eyebrows'), ('eyelashes', 'eyelashes')):
        path = os.path.join(user_data, cfg['assets']['files'][key]['path'])
        o = HumanService.add_mhclo_asset(path, b, asset_type=part, subdiv_levels=0, material_type='NONE',
                                         set_up_rigging=rig_weights)
        parts[part] = o
    ground = eval_coords(b)[mask, 2].min()
    joints = {}
    for bone in rig.data.bones:
        hd = rig.matrix_world @ bone.head_local
        tl = rig.matrix_world @ bone.tail_local
        joints[bone.name] = ([hd.x, hd.y, hd.z - ground], [tl.x, tl.y, tl.z - ground])
    part_co = {}
    for part, o in parts.items():
        c = eval_coords(o)
        c[:, 2] -= ground
        part_co[part] = c
    return {'basemesh': b, 'rig': rig, 'parts': parts, 'co': co, 'part_co': part_co, 'mask': mask,
            'joints': joints, 'heightMacro': hm, 'height': h}


# ── bake the hero into plain meshes with variant shape keys ─────────────────


def _set_plain_coords(ob, co):
    if ob.data.shape_keys:
        ob.shape_key_clear()
    for m in list(ob.modifiers):
        if m.type != 'ARMATURE':
            ob.modifiers.remove(m)
    ob.parent = None
    ob.matrix_world.identity()
    ob.data.vertices.foreach_set('co', co.astype(np.float32).ravel())
    ob.data.update()


def _add_variant_keys(ob, variant_cos):
    ob.shape_key_add(name='Basis', from_mix=False)
    for key, co in variant_cos.items():
        sk = ob.shape_key_add(name=key, from_mix=False)
        sk.data.foreach_set('co', co.astype(np.float32).ravel())
        sk.value = 0.0


def run(cfg, work, write_lock=False):
    user_data, targets_dir = enable_mpfb(cfg)
    verify_assets(cfg, user_data, os.path.join(HERE, 'assets.lock.json'), write_lock=write_lock)
    C.reset_scene()
    report = {'variants': {}}
    built = {}
    for vname in ('hero', 'npc_b', 'npc_c'):
        built[vname] = build_variant(cfg, vname, user_data, targets_dir, rig_weights=(vname == 'hero'))
        report['variants'][vname] = {'heightMacro': round(built[vname]['heightMacro'], 5),
                                     'heightM': round(built[vname]['height'], 4)}
        print(f"[pilot] body {vname}: height macro {built[vname]['heightMacro']:.4f} -> {built[vname]['height']:.4f} m")

    hero = built['hero']
    # joint drift of the variants against the hero skeleton
    worst = 0.0
    for vname in ('npc_b', 'npc_c'):
        d = {}
        for bname, (hd, _tl) in hero['joints'].items():
            o = built[vname]['joints'][bname][0]
            d[bname] = float(np.linalg.norm(np.array(hd) - np.array(o)))
        top = sorted(d.items(), key=lambda kv: -kv[1])[:5]
        report['variants'][vname]['jointDeltaTop'] = [(k, round(v, 4)) for k, v in top]
        worst = max(worst, top[0][1])
        print(f'[pilot] body {vname}: worst joint deltas {report["variants"][vname]["jointDeltaTop"]}')
        # rest joint heads of the variant (armature space, feet on z = 0): the runtime re-binds a
        # variant's skeleton to these so the morph and the pivots agree (clips are rotation-only)
        report['variants'][vname]['jointHeads'] = {k: [round(c, 5) for c in hd]
                                                   for k, (hd, _tl) in built[vname]['joints'].items()}
    report['variants']['hero']['jointHeads'] = {k: [round(c, 5) for c in hd] for k, (hd, _tl) in hero['joints'].items()}
    report['maxJointDeltaM'] = round(worst, 4)
    if worst > cfg['body']['maxJointDeltaM']:
        raise SystemExit(f"[pilot] variant joint drift {worst:.3f} m > {cfg['body']['maxJointDeltaM']} m: the re-bind offsets would stretch the skeleton too far")

    # hero meshes become plain geometry; variants become shape keys
    body = hero['basemesh']
    rig = hero['rig']
    _set_plain_coords(body, hero['co'])
    _add_variant_keys(body, {VARIANT_KEYS[v]: built[v]['co'] for v in VARIANT_KEYS})
    body.name = 'MH_Body'
    for part in ('eyes', 'eyebrows', 'eyelashes'):
        o = hero['parts'][part]
        _set_plain_coords(o, hero['part_co'][part])
        _add_variant_keys(o, {VARIANT_KEYS[v]: built[v]['part_co'][part] for v in VARIANT_KEYS})
        o.name = 'MH_' + part.capitalize()
    rig.location = (0, 0, 0)
    # the rig was fitted before feet were put on z = 0: move it by the same ground offset
    ground_shift = hero['joints']['Root'][0][2] - (rig.matrix_world @ rig.data.bones['Root'].head_local).z
    rig.location.z += ground_shift
    bpy.context.view_layer.update()
    bpy.ops.object.select_all(action='DESELECT')
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    rig.name = 'PilotRig'
    rig.data.name = 'PilotRig'
    for o in [body] + [hero['parts'][p] for p in ('eyes', 'eyebrows', 'eyelashes')]:
        o.parent = rig
        o.matrix_parent_inverse.identity()
        for m in o.modifiers:
            if m.type == 'ARMATURE':
                m.object = rig

    # delete helper geometry, keep the MakeHuman index
    attr = body.data.attributes.new('mh_index', 'INT', 'POINT')
    attr.data.foreach_set('value', np.arange(len(body.data.vertices), dtype=np.int32))
    mask = hero['mask']
    bm = bmesh.new()
    bm.from_mesh(body.data)
    bm.verts.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[bm.verts[i] for i in np.nonzero(~mask)[0]], context='VERTS')
    bm.to_mesh(body.data)
    bm.free()
    body.data.update()

    # everything else MPFB made (variant humans, rigs, proxies) goes
    keep = {body, rig} | {hero['parts'][p] for p in ('eyes', 'eyebrows', 'eyelashes')}
    for o in list(bpy.data.objects):
        if o not in keep:
            bpy.data.objects.remove(o, do_unlink=True)
    C.purge()
    report['counts'] = {o.name: len(o.data.polygons) for o in keep if o.type == 'MESH'}
    report['bones'] = len(rig.data.bones)
    z = np.array([v.co.z for v in body.data.vertices])
    report['heroHeightM'] = round(float(z.max() - z.min()), 4)
    print(f"[pilot] body: {report['counts']}, {report['bones']} bones, hero height {report['heroHeightM']} m")
    C.save(work, 'stage_body', report)
    return report
