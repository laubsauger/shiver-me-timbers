"""
The Drift's palms (BlenderKit, royalty-free: free for commercial renders, no attribution, the model itself not
to be redistributed — so the sources and the export stay out of git, in public/drift/pbr/): each .blend the user
downloaded exported as one .glb with its textures embedded, modifiers applied, for src/drift/wandering/.

  /Applications/Blender.app/Contents/MacOS/Blender -b <palm.blend> -P scripts/drift-palm-export.py -- <palm.glb> [triangle budget]

A budget decimates (collapse) the meshes over it to their share of it — the heavy scans, not the card fronds.
"""

import sys

import bpy

args = sys.argv[sys.argv.index('--') + 1:]
out = args[0]
budget = int(args[1]) if len(args) > 1 else 0
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH' and o.visible_get()]
bpy.ops.object.select_all(action='DESELECT')
for o in meshes:
    o.select_set(True)
count = lambda o: sum(len(p.vertices) - 2 for p in o.data.polygons)
tris = sum(count(o) for o in meshes)
if budget and tris > budget:
    for o in meshes:
        bpy.context.view_layer.objects.active = o
        m = o.modifiers.new('lod', 'DECIMATE')
        m.decimate_type = 'COLLAPSE'
        m.ratio = budget / tris
        m.use_collapse_triangulate = True
    tris = budget  # (the modifiers apply at export)
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True, export_image_format='AUTO', export_apply=True)
print(f'[palm-export] {len(meshes)} meshes, {tris} triangles -> {out}', flush=True)
