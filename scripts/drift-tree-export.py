"""
The Drift's forest-edge trees and shrubs (Poly Haven, CC0; fetched by scripts/drift-pbr-fetch.py into
public/drift/pbr/<asset>/): each scanned glTF decimated to a triangle budget and written as one .glb next to it,
<asset>_lod.glb, for src/drift/wandering/forest.ts. The island trees are 1–2M triangles of individually modelled
leaves — far more than a forest edge of a hundred of them can draw a frame; a leaf collapsed to a few triangles
keeps its shape through its texture's alpha, which forest.ts cuts from the scan's black background.

  /Applications/Blender.app/Contents/MacOS/Blender -b -P scripts/drift-tree-export.py -- <asset.gltf> <out.glb> <triangle budget> [planar°]

`planar°`: first a PLANAR dissolve at that angle — a flat leaf's own triangles merged into one outline, its shape kept
(the 2026-10-29 review: collapsed to a budget, the island trees' modelled leaves fell apart into grainy shards that
flickered at any resolution) — then a collapse only if still over the budget.
"""

import sys

import bpy

args = sys.argv[sys.argv.index('--') + 1:]
src, out, budget = args[0], args[1], int(args[2])
planar = float(args[3]) if len(args) > 3 else 0.0
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
count = lambda o: sum(len(p.vertices) - 2 for p in o.data.polygons)
tris = sum(count(o) for o in meshes)
if planar > 0:
    import math
    for o in meshes:
        bpy.context.view_layer.objects.active = o
        m = o.modifiers.new('planar', 'DECIMATE')
        m.decimate_type = 'DISSOLVE'
        m.angle_limit = math.radians(planar)
        m.delimit = {'UV', 'MATERIAL'}
        bpy.ops.object.modifier_apply(modifier='planar')
        tri = o.modifiers.new('tri', 'TRIANGULATE')
        bpy.ops.object.modifier_apply(modifier='tri')
    print(f'[tree-export] planar {planar}°: {tris} -> {sum(count(o) for o in meshes)} triangles', flush=True)
    tris = sum(count(o) for o in meshes)
if tris > budget:
    for o in meshes:
        m = o.modifiers.new('lod', 'DECIMATE')
        m.decimate_type = 'COLLAPSE'
        m.ratio = budget / tris
        m.use_collapse_triangulate = True
bpy.ops.object.select_all(action='DESELECT')
for o in meshes:
    o.select_set(True)
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True, export_image_format='AUTO', export_apply=True)
print(f'[tree-export] {len(meshes)} meshes, {tris} -> {min(tris, budget)} triangles -> {out}', flush=True)
