"""
The raft's stores (src/ship/raftStores.ts — the game's raft and the film's): Poly Haven's CC0 scanned and modelled
props (barrel, crates, jerrycan, lifebuoy, basket, pot, bowl, jug, spoon; fetched by scripts/drift-pbr-fetch.py into
public/drift/pbr/<asset>/) each written as one .glb, public/models/raft/<asset>.glb (they ship, CC0) — its maps cut to
`size` px (a 0.8 m crate seen from 5 m fills ~300 px of a
1920 frame: 1k texels over it is already finer than that, and six props at 2k were ~400 MB of GPU memory), its
triangles collapsed to `budget` if over it.

  /Applications/Blender.app/Contents/MacOS/Blender -b -P scripts/drift-prop-export.py -- <asset.gltf> public/models/raft/<asset>.glb <triangle budget> [size]
"""

import sys

import bpy

args = sys.argv[sys.argv.index('--') + 1:]
src, out, budget = args[0], args[1], int(args[2])
size = int(args[3]) if len(args) > 3 else 1024
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
count = lambda o: sum(len(p.vertices) - 2 for p in o.data.polygons)
tris = sum(count(o) for o in meshes)
if tris > budget:
    for o in meshes:
        m = o.modifiers.new('lod', 'DECIMATE')
        m.decimate_type = 'COLLAPSE'
        m.ratio = budget / tris
        m.use_collapse_triangulate = True
for img in bpy.data.images:
    w, h = img.size
    if max(w, h) > size:
        img.scale(max(1, w * size // max(w, h)), max(1, h * size // max(w, h)))
bpy.ops.object.select_all(action='DESELECT')
for o in meshes:
    o.select_set(True)
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True, export_image_format='JPEG', export_jpeg_quality=88, export_apply=True)
print(f'[prop-export] {len(meshes)} meshes, {tris} -> {min(tris, budget)} triangles, maps <= {size}px -> {out}', flush=True)
