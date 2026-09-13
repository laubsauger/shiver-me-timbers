"""
Clay/lit preview render of a RAW contract GLB (the Blender export before gltf-transform: Blender's
importer cannot read KTX2). CPU Cycles, small and modest — a quick look without a browser, and the
seed of the doc's clay-render step (asset-pipeline-research.md §7.3).

  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
      -P scripts/blender/render_preview.py -- --glb <work>/raw.glb --out preview.png \
      [--view three_quarter|side|front|top|below] [--lod 0] [--clay] [--size 960x540] [--samples 16]
"""
import argparse
import math
import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sb_conventions as sb  # noqa: E402


def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument('--glb', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--view', default='three_quarter', choices=['three_quarter', 'side', 'front', 'top', 'below'])
    p.add_argument('--lod', type=int, default=0)
    p.add_argument('--clay', action='store_true')
    p.add_argument('--size', default='960x540')
    p.add_argument('--samples', type=int, default=16)
    p.add_argument('--threads', type=int, default=4)
    return p.parse_args(argv)


def main():
    args = parse_args()
    scene = sb.reset_scene(args.threads)
    bpy.ops.import_scene.gltf(filepath=os.path.abspath(args.glb))
    keep = f'LOD{args.lod}'
    for obj in list(scene.objects):
        lod_parent = obj
        while lod_parent is not None and not lod_parent.name.startswith('LOD'):
            lod_parent = lod_parent.parent
        if lod_parent is not None and lod_parent.name != keep:
            obj.hide_render = True
    meshes = [o for o in scene.objects if o.type == 'MESH' and not o.hide_render]
    if not meshes:
        raise SystemExit(f'no meshes under {keep}')
    # the RAW export links the gelcoat's livery MASK into Alpha so the channel survives export; the
    # build normalises alphaMode to the contract afterwards. Mirror that here or the hull renders
    # see-through.
    contract = sb.load_contract()
    for mat in bpy.data.materials:
        slot = contract['slots'].get(mat.name.split('.')[0])
        if slot is None or slot['alphaMode'] != 'OPAQUE' or not mat.node_tree:
            continue
        for link in list(mat.node_tree.links):
            if link.to_socket.name == 'Alpha':
                mat.node_tree.links.remove(link)
    if args.clay:
        clay = bpy.data.materials.new('clay')
        clay.use_nodes = True
        clay.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.7, 0.7, 0.68, 1)
        clay.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.6
        for o in meshes:
            for slot in o.material_slots:
                slot.material = clay

    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for o in meshes:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            lo = Vector(map(min, lo, w))
            hi = Vector(map(max, hi, w))
    centre = (lo + hi) / 2
    size = (hi - lo).length

    # neutral ground + sky + sun
    if args.view != 'below':
        bpy.ops.mesh.primitive_plane_add(size=size * 6, location=(centre.x, centre.y, lo.z - 0.01))
    world = bpy.data.worlds.new('sky')
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.55, 0.65, 0.78, 1)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.8
    sun = bpy.data.lights.new('sun', 'SUN')
    sun.energy = 3.5
    sun_obj = bpy.data.objects.new('sun', sun)
    scene.collection.objects.link(sun_obj)
    sun_obj.rotation_euler = (math.radians(50), 0, math.radians(35))

    # Blender frame: bow toward −Y, up +Z (sb_conventions.three_to_blender)
    dirs = {
        'three_quarter': Vector((1.0, -1.1, 0.55)),
        'side': Vector((1.0, 0.0, 0.08)),
        'front': Vector((0.0, -1.0, 0.12)),
        'top': Vector((0.001, 0.0, 1.0)),
        'below': Vector((0.6, -0.4, -0.5)),
    }
    cam_data = bpy.data.cameras.new('cam')
    cam_data.lens = 50
    cam = bpy.data.objects.new('cam', cam_data)
    scene.collection.objects.link(cam)
    cam.location = centre + dirs[args.view].normalized() * size * 1.35
    cam.rotation_euler = (centre - cam.location).to_track_quat('-Z', 'Y').to_euler()
    scene.camera = cam

    w, h = (int(v) for v in args.size.split('x'))
    scene.render.resolution_x, scene.render.resolution_y = w, h
    scene.cycles.samples = args.samples
    scene.view_settings.view_transform = 'AgX'
    scene.render.filepath = os.path.abspath(args.out)
    bpy.ops.render.render(write_still=True)
    print(f'[preview] {args.out}')


main()
