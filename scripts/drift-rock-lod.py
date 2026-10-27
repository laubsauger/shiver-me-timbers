"""
The Drift's scanned rocks (Poly Haven CC0, scripts/drift-pbr-fetch.py) cut down for scattering on the
islands: each glTF imported, its meshes joined, decimated (collapse) to a triangle budget — the scan's normal
map carries the detail the triangles give up — and written as one .glb beside the source, textures embedded.

  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P scripts/drift-rock-lod.py -- public/drift/pbr
"""

import sys
from pathlib import Path

import bpy

ROOT = Path(sys.argv[sys.argv.index('--') + 1])
ROCKS = {
    'namaqualand_boulder_05': 12000,
    'coast_rocks_05': 60000,
}

for name, budget in ROCKS.items():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(ROOT / name / f'{name}_4k.gltf'))
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    mod = obj.modifiers.new('lod', 'DECIMATE')
    mod.decimate_type = 'COLLAPSE'
    mod.ratio = min(1.0, budget / max(1, tris))
    bpy.ops.object.modifier_apply(modifier=mod.name)
    after = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    out = ROOT / name / f'{name}_lod.glb'
    bpy.ops.export_scene.gltf(filepath=str(out), export_format='GLB', use_selection=False, export_image_format='AUTO', export_apply=True)
    dims = tuple(round(v, 2) for v in obj.dimensions)
    print(f'[rock-lod] {name}: {tris} -> {after} triangles, {dims} m, {out.stat().st_size / 1e6:.1f} MB', flush=True)
