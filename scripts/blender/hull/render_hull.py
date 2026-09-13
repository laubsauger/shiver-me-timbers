"""
CPU preview renders of the hero hull (Cycles CPU + OIDN; no GPU, no browser). docs/speedboat/hull-log.md.

  Blender -b --factory-startup -P scripts/blender/hull/render_hull.py -- \
      --glb <work>/raw.glb --work <work> --views side,rear34,hero34 --variant hero --out-dir <dir>

--glb      a raw export (PNG textures) from `node scripts/asset-build.mjs --work <work>`, or --blend
--work     the build's work dir: the hull preview maps (hull_preview_<variant>_albedo.png, _clearcoat.png)
           evaluate the RUNTIME livery formula (slotMaterials.ts) per texel, so variants render without a GPU
--clay     flat grey materials (geometry review)
Views: side rear34 hero34 front top below chase close_chine close_bow close_transom lod
"""
import argparse
import math
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
import sb_conventions as sb  # noqa: E402


def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument('--glb')
    p.add_argument('--blend')
    p.add_argument('--work')
    p.add_argument('--variant', default='hero')
    p.add_argument('--views', default='side')
    p.add_argument('--out-dir', required=True)
    p.add_argument('--samples', type=int, default=48)
    p.add_argument('--threads', type=int, default=8)
    p.add_argument('--size', default='1600x900')
    p.add_argument('--tag', default='')
    p.add_argument('--lod', type=int, default=0)
    p.add_argument('--clay', action='store_true')
    p.add_argument('--no-parts', action='store_true')
    return p.parse_args(argv)


def t2b(p):
    return Vector((p[0], -p[2], p[1]))


def studio(scene, args, ground_y):
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.render.threads_mode = 'FIXED'
    scene.render.threads = args.threads
    scene.cycles.samples = args.samples
    scene.cycles.use_denoising = True
    scene.cycles.denoiser = 'OPENIMAGEDENOISE'
    scene.cycles.max_bounces = 6
    w, h = (int(v) for v in args.size.split('x'))
    scene.render.resolution_x, scene.render.resolution_y = w, h
    scene.view_settings.view_transform = 'AgX'
    scene.view_settings.look = 'AgX - Medium High Contrast'
    world = bpy.data.worlds.new('__studio')
    scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    bg = nt.nodes['Background']
    tc = nt.nodes.new('ShaderNodeTexCoord')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    nt.links.new(tc.outputs['Generated'], sep.inputs['Vector'])
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].position = 0.35
    ramp.color_ramp.elements[0].color = (0.36, 0.35, 0.33, 1)
    ramp.color_ramp.elements[1].position = 0.78
    ramp.color_ramp.elements[1].color = (0.86, 0.87, 0.9, 1)
    nt.links.new(sep.outputs['Z'], ramp.inputs['Fac'])
    nt.links.new(ramp.outputs['Color'], bg.inputs['Color'])
    bg.inputs['Strength'].default_value = 0.85
    sun = bpy.data.objects.new('__sun', bpy.data.lights.new('__sun', 'SUN'))
    sun.data.energy = 3.4
    sun.data.angle = math.radians(3)
    sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(-40))
    scene.collection.objects.link(sun)
    me = bpy.data.meshes.new('__ground')
    s = 80
    y = ground_y
    me.from_pydata([(-s, -s, y), (s, -s, y), (s, s, y), (-s, s, y)], [], [(0, 1, 2, 3)])
    g = bpy.data.objects.new('__ground', me)
    scene.collection.objects.link(g)
    m = bpy.data.materials.new('__ground')
    m.use_nodes = True
    m.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.55, 0.54, 0.52, 1)
    m.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.92
    me.materials.append(m)
    return g


def camera(scene, loc, target, lens):
    cam = bpy.data.objects.get('__cam')
    if cam is None:
        cam = bpy.data.objects.new('__cam', bpy.data.cameras.new('__cam'))
        scene.collection.objects.link(cam)
    cam.data.lens = lens
    cam.data.clip_start = 0.02
    cam.data.clip_end = 400
    cam.location = t2b(loc)
    cam.rotation_euler = (t2b(target) - cam.location).to_track_quat('-Z', 'Y').to_euler()
    scene.camera = cam


def load_img(path, non_color):
    img = bpy.data.images.load(path, check_existing=True)
    img.colorspace_settings.name = 'Non-Color' if non_color else 'sRGB'
    img.alpha_mode = 'CHANNEL_PACKED'
    return img


def preview_hull_material(mat, work, variant, slot):
    """the runtime look, per texel: albedo (livery + overlays + number) and clearcoat from the build's preview maps"""
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
    uvn = nt.nodes.new('ShaderNodeUVMap')
    uvn.uv_map = 'UVMap'

    def tex(path, non_color):
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = load_img(path, non_color)
        t.interpolation = 'Linear'
        nt.links.new(uvn.outputs['UV'], t.inputs['Vector'])
        return t

    tag = 'gelcoat' if slot == 'M_Gelcoat' else 'nonslip'
    alb = tex(os.path.join(work, f'hull_preview_{variant}_{tag}_albedo.png'), False)
    nt.links.new(alb.outputs['Color'], bsdf.inputs['Base Color'])
    orm = tex(os.path.join(work, f'hull_preview_{tag}_orm.png'), True)
    sep = nt.nodes.new('ShaderNodeSeparateColor')
    nt.links.new(orm.outputs['Color'], sep.inputs['Color'])
    nt.links.new(sep.outputs['Green'], bsdf.inputs['Roughness'])
    nt.links.new(sep.outputs['Blue'], bsdf.inputs['Metallic'])
    nrm = tex(os.path.join(work, f'hull_preview_{tag}_normal.png'), True)
    nm = nt.nodes.new('ShaderNodeNormalMap')
    nm.uv_map = 'UVMap'
    nt.links.new(nrm.outputs['Color'], nm.inputs['Color'])
    nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    # AO multiplies albedo in the preview (the glTF occlusion channel)
    mul = nt.nodes.new('ShaderNodeMix')
    mul.data_type = 'RGBA'
    mul.blend_type = 'MULTIPLY'
    mul.inputs['Factor'].default_value = 1.0
    nt.links.new(alb.outputs['Color'], mul.inputs['A'])
    nt.links.new(sep.outputs['Red'], mul.inputs['B'])
    nt.links.new(mul.outputs['Result'], bsdf.inputs['Base Color'])
    if slot == 'M_Gelcoat':
        cc = tex(os.path.join(work, 'hull_preview_gelcoat_clearcoat.png'), True)
        csep = nt.nodes.new('ShaderNodeSeparateColor')
        nt.links.new(cc.outputs['Color'], csep.inputs['Color'])
        nt.links.new(csep.outputs['Red'], bsdf.inputs['Coat Weight'])
        bsdf.inputs['Coat Roughness'].default_value = 0.12
    else:
        bsdf.inputs['Coat Weight'].default_value = 0.0


def clay(mat):
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
    bsdf.inputs['Base Color'].default_value = (0.62, 0.61, 0.58, 1)
    bsdf.inputs['Roughness'].default_value = 0.42


def main():
    args = parse_args()
    os.makedirs(args.out_dir, exist_ok=True)
    if args.blend:
        bpy.ops.wm.open_mainfile(filepath=os.path.abspath(args.blend))
    else:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=os.path.abspath(args.glb))
    scene = bpy.context.scene
    contract = sb.load_contract()
    keep = f'LOD{args.lod}'
    hull_obj = None
    for ob in list(scene.objects):
        par = ob
        while par is not None and not par.name.startswith('LOD'):
            par = par.parent
        if par is not None and par.name.split('.')[0] != keep:
            ob.hide_render = True
        if ob.type == 'MESH' and ob.name.startswith(f'Hull_LOD{args.lod}'):
            hull_obj = ob
        if args.no_parts and ob.type == 'MESH' and not ob.name.startswith('Hull_'):
            ob.hide_render = True
    for mat in bpy.data.materials:
        slot = mat.name.split('.')[0]
        if slot not in contract['slots'] or not mat.node_tree:
            continue
        if args.clay:
            if slot in ('M_Gelcoat', 'M_NonSlip'):
                clay(mat)
            continue
        if slot in ('M_Gelcoat', 'M_NonSlip') and args.work:
            preview_hull_material(mat, args.work, args.variant, slot)
            continue
        if contract['slots'][slot]['alphaMode'] == 'OPAQUE':
            for link in list(mat.node_tree.links):
                if link.to_socket.name == 'Alpha':
                    mat.node_tree.links.remove(link)
    for img in bpy.data.images:
        img.alpha_mode = 'CHANNEL_PACKED'
    ext = {k: hull_obj.parent.parent[k] for k in ('bowZ', 'sternZ', 'keelY', 'deckY')} if hull_obj and hull_obj.parent and hull_obj.parent.parent and 'bowZ' in hull_obj.parent.parent else {'bowZ': 8.39, 'sternZ': -3.61, 'keelY': -0.854, 'deckY': 0.82}
    bow, stern, keel, deck = ext['bowZ'], ext['sternZ'], ext['keelY'], ext['deckY']
    mid = 0.5 * (bow + stern)
    ground = studio(scene, args, keel - 1.4)
    views = args.views.split(',')
    for view in views:
        ground.hide_render = view in ('below', 'close_chine')
        if view == 'side':
            camera(scene, (-26.0, 0.2, mid), (0.0, 0.1, mid), 60)
        elif view == 'side_port':
            camera(scene, (26.0, 0.2, mid), (0.0, 0.1, mid), 60)
        elif view == 'rear34':
            camera(scene, (-6.5, 3.2, stern - 8.5), (0.0, -0.1, stern + 3.2), 40)
        elif view == 'hero34':
            camera(scene, (-8.2, 0.9, bow + 6.5), (0.0, -0.1, mid + 1.0), 38)
        elif view == 'front':
            camera(scene, (0.0, 0.2, bow + 22.0), (0.0, 0.0, mid), 70)
        elif view == 'top':
            camera(scene, (0.0, 28.0, mid + 0.001), (0.0, 0.0, mid), 60)
        elif view == 'below':
            camera(scene, (-7.5, -6.0, bow + 3.5), (0.0, -0.6, mid + 0.5), 32)
        elif view == 'chase':
            camera(scene, (0.0, deck + 2.6, stern - 10.0), (0.0, deck - 0.2, stern + 5.0), 38)
        elif view == 'close_chine':
            camera(scene, (-2.3, keel - 0.35, stern + 2.6), (-1.05, keel + 0.3, stern + 1.3), 35)
        elif view == 'close_bow':
            camera(scene, (-3.2, deck - 0.1, bow - 0.6), (-0.4, deck - 0.6, bow - 2.2), 32)
        elif view == 'close_transom':
            camera(scene, (-2.6, deck + 0.4, stern - 3.6), (-0.2, keel + 0.6, stern), 32)
        elif view == 'deck34':
            camera(scene, (-4.5, deck + 4.2, stern + 11.5), (0.0, deck, stern + 3.5), 32)
        else:
            print(f'[render] unknown view {view}')
            continue
        path = os.path.join(args.out_dir, f'{view}{args.tag}.png')
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        print(f'[render] {path}')


main()
