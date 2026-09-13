"""
Shared helpers for the pilot build (scripts/blender/pilot/).

Frame: the pilot is authored in Blender with the face toward Blender -Y and up +Z, so the glTF
exporter's +Y-up conversion puts the face on three.js +Z (the bow), the same rule as
scripts/blender/sb_conventions.py. Origin = the seat socket (pilot_config.json `seat`).
"""
import json
import os

import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, 'pilot_config.json')


def load_config(path=CONFIG_PATH):
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def reset_scene(threads=4):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.unit_settings.system = 'METRIC'
    sc.unit_settings.scale_length = 1.0
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.seed = 0
    sc.cycles.use_animated_seed = False
    sc.cycles.use_denoising = False
    sc.render.threads_mode = 'FIXED'
    sc.render.threads = max(1, int(threads))
    return sc


def set_threads(threads):
    sc = bpy.context.scene
    sc.render.threads_mode = 'FIXED'
    sc.render.threads = max(1, int(threads))


def purge():
    for _ in range(4):
        bpy.ops.outliner.orphans_purge(do_local_ids=True, do_linked_ids=True, do_recursive=True)


def save(work, name, report=None):
    os.makedirs(work, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(work, name + '.blend'), compress=False)
    if report is not None:
        with open(os.path.join(work, name + '.json'), 'w', encoding='utf-8') as f:
            json.dump(report, f, indent=2, sort_keys=True)


def load(work, name):
    path = os.path.join(work, name + '.blend')
    if not os.path.exists(path):
        raise SystemExit(f'[pilot] missing checkpoint {path}: run the earlier stage first')
    bpy.ops.wm.open_mainfile(filepath=path)
    rp = os.path.join(work, name + '.json')
    if os.path.exists(rp):
        with open(rp, 'r', encoding='utf-8') as f:
            return json.load(f)
    return {}


def link(ob, collection=None):
    (collection or bpy.context.scene.collection).objects.link(ob)
    return ob


def select_only(objs, active=None):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active or (objs[0] if objs else None)


def mesh_object(name, verts, faces, collection=None):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(map(float, v)) for v in verts], [], [tuple(int(i) for i in f) for f in faces])
    me.update()
    ob = bpy.data.objects.new(name, me)
    return link(ob, collection)


def tri_count(ob):
    me = ob.data
    me.calc_loop_triangles()
    return len(me.loop_triangles)


def coords(ob):
    co = np.empty(len(ob.data.vertices) * 3, dtype=np.float64)
    ob.data.vertices.foreach_get('co', co)
    return co.reshape(-1, 3)


def set_coords(ob, co):
    ob.data.vertices.foreach_set('co', np.asarray(co, dtype=np.float32).ravel())
    ob.data.update()


def group_weights(ob, names):
    """per-vertex summed weight of the named vertex groups"""
    idx = {ob.vertex_groups[n].index for n in names if n in ob.vertex_groups}
    w = np.zeros(len(ob.data.vertices), dtype=np.float64)
    for v in ob.data.vertices:
        for g in v.groups:
            if g.group in idx:
                w[v.index] += g.weight
    return w


def hex_lin(h):
    h = h.lstrip('#')
    c = np.array([int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)], dtype=np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
