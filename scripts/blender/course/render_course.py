"""
CPU Cycles renders of a RAW course GLB (§T.187): the asset STAGED the way it stands on the course, in water,
at the design doc's hero hour (17:30 dusk, low warm sun), plus a clay pass and a LOD strip. The raw GLB carries
PNG textures (Blender cannot import KTX2), so what renders here is the baked texture set that gets packaged.

  Blender -b --factory-startup -P scripts/blender/course/render_course.py -- \
      --glb <work>/raw-course_gate_pole.glb --asset course_gate_pole --out-dir <dir> [--samples 64] [--size 1600x900]
"""
import argparse
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
import sb_conventions as sb  # noqa: E402


def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument('--glb', required=True)
    p.add_argument('--asset', required=True)
    p.add_argument('--out-dir', required=True)
    p.add_argument('--samples', type=int, default=64)
    p.add_argument('--size', default='1600x900')
    p.add_argument('--threads', type=int, default=8)
    p.add_argument('--views', default='hero,detail,clay,lod')
    return p.parse_args(argv)


def T(x, y, z):
    return Vector(sb.three_to_blender(x, y, z))


# staging: (variants, three-frame offset, yaw°) per placed copy
STAGING = {
    'course_gate_pole': [
        (['Spar', 'Strobe', 'BoardSquare', 'Numeral3'], (-3.0, 0, 0), 0, {}),
        (['Spar', 'Strobe', 'BoardTriangle', 'Numeral3'], (3.0, 0, 0), 0, {'Numeral3': (0, -0.12, 0)}),
        (['Spar', 'Strobe', 'BoardChequer'], (0.0, 0, -7.0), 0, {}),
    ],
    'course_turn_buoy': [(['Buoy', 'Lantern', 'Tag2'], (0, 0, 0), 0, {})],
    'course_bar_stake': [
        (['Stake'], (0, 0, 0), 0, {}),
        (['Stake'], (4.5, 0, -6), 35, {}),
        (['Stake'], (-5.0, 0, -12), -20, {}),
    ],
    'course_pylon': [(['Pylon', 'Insulators'], (0, 0, 0), 0, {})],
    'course_radio_tower': [
        # the placement's list (towerReachLayout TOWER.lean 0.075 rad ≈ 4.3°), leaning away from the grid (three −Z)
        (['Mast', 'Hut', 'LampRig', 'StartLamp1', 'StartLamp2', 'StartLamp3', 'StartLamp4', 'StartLamp5', 'StartGreen', 'Beacons'], (0, 0, 0), 0, {'lean': 4.3}),
        (['GuyAnchor'], (-130.0, 0, 0), 0, {}),
        (['GuyAnchor'], (65.0, 0, 112.6), 0, {}),
        (['GuyAnchor'], (65.0, 0, -112.6), 0, {}),
    ],
    'course_roofs': [
        (['Gable'], (-24, -7.2, 0), 0, {}),
        (['GableChimney'], (-3, -7.3, 1), 0, {}),
        (['Shed'], (17, -7.0, 0), 0, {}),
        (['Hip'], (-20, -7.6, -46), 180, {}),
        (['Steeple'], (8, -7.4, -58), 180, {}),
        (['WaterTower'], (34, -7.1, -40), 180, {}),
    ],
}

VIEWS = {
    # view → (camera target, camera position, lens mm), three.js frame of the STAGED scene
    'course_gate_pole': {'hero': ((0.0, 3.4, -2.0), (10.5, 2.6, 13.5), 32), 'detail': ((-3.0, 5.2, 0.2), (-0.9, 4.6, 3.6), 45)},
    'course_turn_buoy': {'hero': ((0.0, 2.3, 0.0), (9.5, 2.6, 12.5), 34), 'detail': ((0.0, 3.3, 0.3), (1.8, 3.4, 3.4), 40)},
    'course_bar_stake': {'hero': ((0.0, 2.2, -5.0), (6.5, 2.4, 9.5), 36), 'detail': ((0.0, 3.8, 0.3), (1.0, 3.6, 2.6), 45)},
    'course_pylon': {'hero': ((0.0, 11.0, 0.0), (36.0, 5.0, 34.0), 30), 'detail': ((7.2, 11.4, 0.0), (13.5, 10.5, 7.5), 40)},
    'course_radio_tower': {
        'hero': ((-6.0, 46.0, 0.0), (-112.0, 8.0, 118.0), 22),
        'detail': ((-10.0, 14.0, 1.0), (-26.0, 9.0, 27.0), 32),
        'water': ((-8.0, 22.0, 0.0), (-62.0, 1.8, 76.0), 26),
    },
    'course_roofs': {'hero': ((6.0, 0.0, -24.0), (46.0, 7.5, 36.0), 30), 'detail': ((-3.0, 2.0, 1.0), (7.0, 2.6, 14.0), 40)},
}


def import_glb(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.abspath(path))
    return [o for o in bpy.data.objects if o not in before]


def variant_objects(objs, lod):
    out = {}
    for o in objs:
        if o.type != 'MESH' or not o.name.endswith(f'_LOD{lod}'):
            continue
        out[o.name[: -len(f'_LOD{lod}')].split('.')[0]] = o
    return out


def stage(asset, objs, lod, clay=None, x_shift=0.0):
    """instance the staged copies as linked duplicates; hide the originals"""
    src = variant_objects(objs, lod)
    placed = []
    for variants, off, yaw, local in STAGING[asset]:
        for v in variants:
            if v not in src:
                continue
            o = src[v].copy()
            bpy.context.scene.collection.objects.link(o)
            o.parent = None
            lo = local.get(v, (0, 0, 0))
            # lean: degrees about three +X, pivoting at the mast foot 25 m down (Blender +X = three +X)
            lean = Matrix.Translation(T(0, -25, 0)) @ Matrix.Rotation(math.radians(-local.get('lean', 0.0)), 4, 'X') @ Matrix.Translation(T(0, 25, 0))
            M = Matrix.Translation(T(off[0] + x_shift, off[1], off[2])) @ Matrix.Rotation(math.radians(yaw), 4, 'Z') @ lean @ Matrix.Translation(T(*lo))
            o.matrix_world = M
            if clay is not None:
                o.data = o.data.copy()
                o.data.materials.clear()
                o.data.materials.append(clay)
            placed.append(o)
    for o in objs:
        if o.type == 'MESH':
            o.hide_render = True
    return placed


def bounds(objs, min_z=-1.5):
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for o in objs:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            if w.z < min_z:
                w.z = min_z
            lo = Vector(map(min, lo, w))
            hi = Vector(map(max, hi, w))
    return lo, hi


def world_and_water(scene, size):
    world = bpy.data.worlds.new('dusk')
    scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputWorld')
    bg = nt.nodes.new('ShaderNodeBackground')
    # the design doc's dusk sky (gSky: zenith #76ABBE → #D5DCCB → horizon #F0C48C), as a view-direction ramp
    tc = nt.nodes.new('ShaderNodeTexCoord')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    nt.links.new(tc.outputs['Generated'], sep.inputs['Vector'])
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    cr = ramp.color_ramp
    stops = [(0.0, (0.94, 0.62, 0.36)), (0.08, (0.94, 0.77, 0.55)), (0.3, (0.84, 0.86, 0.80)), (1.0, (0.46, 0.67, 0.75))]
    cr.elements[0].position, cr.elements[0].color = stops[0][0], (*stops[0][1], 1)
    cr.elements[1].position, cr.elements[1].color = stops[-1][0], (*stops[-1][1], 1)
    for pos, col in stops[1:-1]:
        e = cr.elements.new(pos)
        e.color = (*col, 1)
    clamp = nt.nodes.new('ShaderNodeMath')
    clamp.operation = 'MAXIMUM'
    clamp.inputs[1].default_value = 0.0
    nt.links.new(sep.outputs['Z'], clamp.inputs[0])
    nt.links.new(clamp.outputs['Value'], ramp.inputs['Fac'])
    nt.links.new(ramp.outputs['Color'], bg.inputs['Color'])
    bg.inputs['Strength'].default_value = 0.9
    nt.links.new(bg.outputs['Background'], out.inputs['Surface'])
    sun = bpy.data.lights.new('sun', 'SUN')
    sun.energy = 4.2
    sun.color = (1.0, 0.78, 0.55)
    sun.angle = math.radians(1.2)
    so = bpy.data.objects.new('sun', sun)
    scene.collection.objects.link(so)
    so.rotation_euler = (math.radians(90 - 11.0), 0, math.radians(35.0))
    # the sea: a transmissive, absorbing water body with a gentle wave bump (renders the underwater part too)
    bpy.ops.mesh.primitive_plane_add(size=size, location=(0, 0, 0))
    water = bpy.context.active_object
    mat = bpy.data.materials.new('__water')
    mat.use_nodes = True
    wt = mat.node_tree
    b = wt.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (0.05, 0.16, 0.17, 1)
    b.inputs['Roughness'].default_value = 0.04
    b.inputs['Transmission Weight'].default_value = 1.0
    b.inputs['IOR'].default_value = 1.333
    vol = wt.nodes.new('ShaderNodeVolumeAbsorption')
    vol.inputs['Color'].default_value = (0.18, 0.43, 0.44, 1)
    vol.inputs['Density'].default_value = 0.35
    wt.links.new(vol.outputs['Volume'], wt.nodes['Material Output'].inputs['Volume'])
    tc = wt.nodes.new('ShaderNodeTexCoord')
    wave = wt.nodes.new('ShaderNodeTexWave')
    wave.inputs['Scale'].default_value = 0.08
    wave.inputs['Distortion'].default_value = 6.0
    wt.links.new(tc.outputs['Object'], wave.inputs['Vector'])
    noise = wt.nodes.new('ShaderNodeTexNoise')
    noise.inputs['Scale'].default_value = 1.2
    wt.links.new(tc.outputs['Object'], noise.inputs['Vector'])
    mix = wt.nodes.new('ShaderNodeMath')
    mix.operation = 'ADD'
    wt.links.new(wave.outputs['Fac'], mix.inputs[0])
    wt.links.new(noise.outputs['Fac'], mix.inputs[1])
    bump = wt.nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = 0.08
    wt.links.new(mix.outputs['Value'], bump.inputs['Height'])
    wt.links.new(bump.outputs['Normal'], b.inputs['Normal'])
    water.data.materials.append(mat)
    # a deep seabed card so transmission has something to absorb toward
    bpy.ops.mesh.primitive_plane_add(size=size, location=(0, 0, -30))
    bed = bpy.context.active_object
    bm = bpy.data.materials.new('__bed')
    bm.use_nodes = True
    bm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.12, 0.13, 0.11, 1)
    bed.data.materials.append(bm)


def camera(scene, target, position, lens):
    cam_data = bpy.data.cameras.new('cam')
    cam_data.lens = lens
    cam_data.clip_end = 5000
    cam = bpy.data.objects.new('cam', cam_data)
    scene.collection.objects.link(cam)
    t = T(*target)
    cam.location = T(*position)
    cam.rotation_euler = (t - cam.location).to_track_quat('-Z', 'Y').to_euler()
    scene.camera = cam
    return cam


def camera_bounds(scene, lo, hi, direction, dist, height, lens):
    centre = (lo + hi) / 2
    extent = (hi - lo).length
    target = Vector((centre.x, centre.y, lo.z + (hi.z - lo.z) * height))
    d = T(*direction).normalized()
    cam_data = bpy.data.cameras.new('cam')
    cam_data.lens = lens
    cam_data.clip_end = 5000
    cam = bpy.data.objects.new('cam', cam_data)
    scene.collection.objects.link(cam)
    cam.location = target + d * extent * dist
    cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler()
    scene.camera = cam
    return cam


def render(scene, path):
    scene.render.filepath = os.path.abspath(path)
    bpy.ops.render.render(write_still=True)
    print(f'[course-render] {path}')


def main():
    args = parse_args()
    views = args.views.split(',')
    for view in views:
        scene = sb.reset_scene(args.threads)
        w, h = (int(v) for v in args.size.split('x'))
        scene.render.resolution_x, scene.render.resolution_y = w, h
        scene.cycles.samples = args.samples
        scene.cycles.use_denoising = True
        scene.view_settings.view_transform = 'AgX'
        scene.view_settings.look = 'AgX - Medium High Contrast' if 'AgX - Medium High Contrast' in [i.identifier for i in scene.view_settings.bl_rna.properties['look'].enum_items] else 'None'
        objs = import_glb(args.glb)
        for m in bpy.data.materials:
            if m.name.startswith('C_Lamp') and m.node_tree:
                bsdf = m.node_tree.nodes.get('Principled BSDF')
                if bsdf:
                    bsdf.inputs['Emission Strength'].default_value = 12.0
        if view == 'lod':
            placed = []
            lo0, hi0 = None, None
            for lod in range(3):
                shift = 0.0
                if lo0 is not None:
                    shift = (hi0.x - lo0.x) * 1.25 * lod
                ps = stage(args.asset, objs, lod, x_shift=shift)
                if lo0 is None:
                    lo0, hi0 = bounds(ps)
                placed += ps
            lo, hi = bounds(placed)
            world_and_water(scene, 40000)
            camera_bounds(scene, lo, hi, (0.0, 0.15, 1.0), 1.0, 0.45, 45)
        else:
            clay = None
            if view == 'clay':
                clay = bpy.data.materials.new('__clay')
                clay.use_nodes = True
                clay.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.62, 0.61, 0.58, 1)
                clay.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.65
            placed = stage(args.asset, objs, 0, clay=clay)
            lo, hi = bounds(placed)
            world_and_water(scene, 40000)
            views = VIEWS[args.asset]
            v = views.get(view) or views['hero']
            camera(scene, v[0], v[1], v[2])
        render(scene, os.path.join(args.out_dir, f'{args.asset}-{view}.png'))


main()
