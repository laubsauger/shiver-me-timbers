"""
CPU verification renders of the pilot (Cycles CPU, OpenImageDenoise on the CPU). No GPU, no browser.

  Blender -b <work>/stage_export.blend --factory-startup -P scripts/blender/pilot/render_pilot.py -- \
      --out <dir> --cockpit <parts.glb> [--shots ...] [--samples 48] [--threads 6] [--legacy]

--cockpit: the parts build (assets/models/speedboat_pipeline_test.glb) decoded to plain glTF (meshopt
  and KTX2 removed, textures as PNG), so the pilot is judged on the real seat, wheel and throttle.
  It is moved from the boat body frame into the seat frame with --socket (the seat station on the
  pan top, body frame; default the current hull JSON: 0, 0.69004, 0.234). The hull shell is hidden
  (the pipeline-test deck is not cut open at the cockpit).
--legacy: renders a v1 build (stage_export.blend of the v1 pipeline) for before/after pairs: v1's
  seat frame origin was the pan front edge, its hair styles swept/cropped and its cockpit camera the
  collapsed head bone at the eye midpoint.

Shots: portrait (85 mm), portrait_side, head (front, both sides, back close-ups of hairline and goggle
strap), goggles (goggles_up), chase (60 deg FOV at 10 m + a 15 deg
crop), cockpit (from cam_eye, head_geo collapsed; the render camera pitches povPitch further down, the
runtime look), hair (front 3/4, side, back close-ups at ~0.5 m), sleeve (forearm, gauntlet and glove
from the pilot's side), hands (left + right grip, three angles each), neck, variants (hero, npc_b,
npc_c with goggles up), poses (contact sheet of every clip).
"""
import argparse
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import common as C  # noqa: E402


def args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument('--out', required=True)
    p.add_argument('--cockpit', default=None)
    p.add_argument('--socket', default='0,0.69004,0.234')
    p.add_argument('--shots', default='portrait,goggles,chase,cockpit,hair,sleeve,hands,neck,variants,poses')
    p.add_argument('--samples', type=int, default=48)
    p.add_argument('--threads', type=int, default=6)
    p.add_argument('--pov-pitch', type=float, default=30.0)
    p.add_argument('--legacy', action='store_true')
    p.add_argument('--prefix', default='')
    return p.parse_args(argv)


# ── scene ───────────────────────────────────────────────────────────────────


def render_materials():
    """preview look for Cycles: masks and SSS thickness are data, not transparency"""
    for name in ('M_Pilot', 'M_PilotSkin'):
        m = bpy.data.materials[name]
        for n in m.node_tree.nodes:
            if n.type == 'TEX_IMAGE' and n.image:
                n.image.alpha_mode = 'CHANNEL_PACKED'
        nt = m.node_tree
        bs = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
        for link in list(bs.inputs['Alpha'].links):
            nt.links.remove(link)
        if name == 'M_PilotSkin':
            bs.inputs['Subsurface Weight'].default_value = 0.3
            bs.inputs['Subsurface Radius'].default_value = (1.0, 0.35, 0.2)
            bs.inputs['Subsurface Scale'].default_value = 0.01
    hair = bpy.data.materials['M_PilotHair']
    nt = hair.node_tree
    bs = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    tex = next(n for n in nt.nodes if n.type == 'TEX_IMAGE')
    tex.image.alpha_mode = 'CHANNEL_PACKED'
    # alpha-to-coverage at MASK 0.35 with 4x MSAA resolves to a few coverage steps around the cutoff:
    # a soft ramp across it, not a hard test and not full blending
    ramp = nt.nodes.new('ShaderNodeMapRange')
    ramp.inputs['From Min'].default_value = 0.2
    ramp.inputs['From Max'].default_value = 0.5
    ramp.interpolation_type = 'SMOOTHSTEP'
    nt.links.new(tex.outputs['Alpha'], ramp.inputs['Value'])
    nt.links.new(ramp.outputs['Result'], bs.inputs['Alpha'])
    # runtime tint rule (M_PilotHair extras): rgb = hairColor * luminance(albedo) / luminance(heroHairColor)
    bw = nt.nodes.new('ShaderNodeRGBToBW')
    nt.links.new(tex.outputs['Color'], bw.inputs['Color'])
    mix = nt.nodes.new('ShaderNodeMixRGB')
    mix.blend_type = 'MULTIPLY'
    mix.inputs['Fac'].default_value = 1.0
    mix.inputs['Color2'].default_value = (1, 1, 1, 1)
    nt.links.new(bw.outputs['Val'], mix.inputs['Color1'])
    sel = nt.nodes.new('ShaderNodeMixRGB')
    sel.name = 'hero_or_tint'
    sel.inputs['Fac'].default_value = 0.0
    nt.links.new(tex.outputs['Color'], sel.inputs['Color1'])
    nt.links.new(mix.outputs['Color'], sel.inputs['Color2'])
    nt.links.new(sel.outputs['Color'], bs.inputs['Base Color'])
    bs.inputs['Roughness'].default_value = 0.6
    bs.inputs['Specular IOR Level'].default_value = 0.25
    bs.inputs['Anisotropic'].default_value = 0.6
    hair['tintNode'] = mix.name
    lens = bpy.data.materials['M_PilotLens']
    lbs = next(n for n in lens.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    lbs.inputs['Alpha'].default_value = 0.55


def grey(name, rgb, rough=0.6, metal=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bs = m.node_tree.nodes['Principled BSDF']
    bs.inputs['Base Color'].default_value = (*rgb, 1)
    bs.inputs['Roughness'].default_value = rough
    bs.inputs['Metallic'].default_value = metal
    return m


def parts_cockpit(path, socket):
    """the real parts build in the seat frame; the hull shell and far LODs hidden"""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    sx, sy, sz = socket
    shift = Vector((-sx, sz, -sy))  # body frame (x, y, z) -> Blender (x, -z, y), negated
    for o in new:
        if o.parent is None:
            o.location = o.location + shift
    for o in new:
        chain, p = [o.name], o.parent
        while p is not None:
            chain.append(p.name)
            p = p.parent
        if any(('LOD1' in n or 'LOD2' in n or n.startswith('Hull')) for n in chain):
            o.hide_render = True
    # ocean stand-in below the hull line
    bpy.ops.mesh.primitive_plane_add(size=400, location=(0, 0, -1.25))
    bpy.context.object.data.materials.append(grey('sea', (0.03, 0.08, 0.1), 0.15))


def legacy_proxy():
    """v1's grey proxy cockpit (v1 assumed helm), for before renders of v1 builds"""
    sole, sheer = -0.62, 0.13
    g = grey('proxy_grey', (0.23, 0.24, 0.25), 0.7)
    carbon = grey('proxy_carbon', (0.05, 0.05, 0.055), 0.35)
    for name, loc, size in (('seat_pan', (0, 0.22, -0.05), (0.46, 0.44, 0.1)), ('sole', (0, -0.3, sole - 0.01), (1.6, 2.6, 0.02)),
                            ('dash', (0, -1.17, sheer - 0.25), (1.5, 0.45, 0.4))):
        bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
        bpy.context.object.scale = size
        bpy.context.object.data.materials.append(carbon if name == 'dash' else g)
    tilt = math.radians(40)
    bpy.ops.mesh.primitive_torus_add(major_radius=0.19, minor_radius=0.016, location=(0, -0.53, 0.28), rotation=(-(math.pi / 2 - tilt), 0, 0))
    bpy.context.object.data.materials.append(grey('proxy_wheel', (0.35, 0.3, 0.24), 0.8))


def world_and_light():
    sc = bpy.context.scene
    w = bpy.data.worlds.new('sky')
    sc.world = w
    w.use_nodes = True
    nt = w.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputWorld')
    sky = nt.nodes.new('ShaderNodeTexSky')
    try:
        sky.sky_type = 'NISHITA'
        sky.sun_elevation = math.radians(28)
        sky.sun_rotation = math.radians(215)
    except (TypeError, AttributeError):
        pass
    bg = nt.nodes.new('ShaderNodeBackground')
    bg.inputs['Strength'].default_value = 0.35
    nt.links.new(sky.outputs['Color'], bg.inputs['Color'])
    nt.links.new(bg.outputs['Background'], out.inputs['Surface'])
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sc.collection.objects.link(sun)
    sun.data.energy = 3.2
    sun.data.angle = math.radians(1.5)
    sun.data.color = (1.0, 0.92, 0.82)
    sun.rotation_euler = Euler((math.radians(58), 0, math.radians(215)))
    fill = bpy.data.objects.new('fill', bpy.data.lights.new('fill', 'AREA'))
    sc.collection.objects.link(fill)
    fill.data.energy = 60
    fill.data.size = 3
    fill.location = (2.5, -3.0, 2.0)
    fill.rotation_euler = (Vector((0, 0, 0.6)) - fill.location).to_track_quat('-Z', 'Y').to_euler()


def setup(a):
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = a.samples
    sc.cycles.use_denoising = True
    sc.cycles.denoiser = 'OPENIMAGEDENOISE'
    sc.render.threads_mode = 'FIXED'
    sc.render.threads = a.threads
    sc.view_settings.view_transform = 'AgX'
    sc.view_settings.look = 'AgX - Medium High Contrast'
    sc.render.film_transparent = False
    for o in bpy.data.objects:
        if o.type == 'MESH' and ('_LOD1' in o.name or '_LOD2' in o.name):
            o.hide_render = True
    render_materials()
    world_and_light()
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    sc.collection.objects.link(cam)
    sc.camera = cam
    return cam


def hair_styles():
    return sorted({o.name.split('_')[1] for o in bpy.data.objects if o.name.startswith('Hair_') and '_LOD0' in o.name})


def variant(name, cfg):
    key = {'hero': None, 'npc_b': 'variant_b', 'npc_c': 'variant_c'}[name]
    for o in bpy.data.objects:
        if o.type != 'MESH' or not o.data.shape_keys:
            continue
        for kb in o.data.shape_keys.key_blocks[1:]:
            kb.value = 1.0 if kb.name == key else 0.0
    style = cfg['variants'][name]['hair']
    if style not in hair_styles():
        style = hair_styles()[0 if name != 'npc_b' else -1]
    for o in bpy.data.objects:
        if o.name.startswith('Hair_') and '_LOD0' in o.name:
            o.hide_render = not o.name.startswith(f'Hair_{style}')
    work = os.path.dirname(bpy.data.filepath)
    img = bpy.data.images.load(os.path.join(work, f'T_PilotSkin_base_{name}.png'), check_existing=True)
    img.alpha_mode = 'CHANNEL_PACKED'
    m = bpy.data.materials['M_PilotSkin']
    tex = [n for n in m.node_tree.nodes if n.type == 'TEX_IMAGE' and n.image and n.image.name.startswith('T_PilotSkin_base')]
    tex[0].image = img
    hair = bpy.data.materials['M_PilotHair']
    mix = hair.node_tree.nodes[hair['tintNode']]
    hc = C.hex_lin(cfg['variants'][name]['hairColor'])
    h0 = C.hex_lin(cfg['variants']['hero']['hairColor'])
    lum = lambda c: 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]  # noqa: E731
    mix.inputs['Color2'].default_value = (*np.clip(hc / max(lum(h0), 1e-4), 0, 16), 1)
    hair.node_tree.nodes['hero_or_tint'].inputs['Fac'].default_value = 0.0 if name == 'hero' else 1.0
    bpy.context.view_layer.update()


def pose(clip, frame):
    rig = bpy.data.objects['PilotRig']
    rig.animation_data_create()
    rig.animation_data.action = bpy.data.actions[clip] if clip else None
    if clip:
        slots = bpy.data.actions[clip].slots
        if len(slots):
            rig.animation_data.action_slot = slots[0]
    bpy.context.scene.frame_set(frame)
    bpy.context.view_layer.update()


def eyes_world():
    rig = bpy.data.objects['PilotRig']
    return rig.matrix_world @ ((rig.pose.bones['eye_l'].head + rig.pose.bones['eye_r'].head) / 2)


def bone_world(name):
    rig = bpy.data.objects['PilotRig']
    return rig.matrix_world @ rig.pose.bones[name].head


def shoot(cam, path, loc, target, lens=None, fov_deg=None, res=(1200, 1200), samples=None):
    sc = bpy.context.scene
    sc.render.resolution_x, sc.render.resolution_y = res
    cam.location = loc
    cam.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    if lens:
        cam.data.lens_unit = 'MILLIMETERS'
        cam.data.lens = lens
    if fov_deg:
        cam.data.lens_unit = 'FOV'
        cam.data.sensor_fit = 'HORIZONTAL'
        cam.data.angle = math.radians(fov_deg)
    cam.data.clip_start = 0.01
    old = sc.cycles.samples
    if samples:
        sc.cycles.samples = samples
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    sc.cycles.samples = old
    print(f'[render] {path}')


def load_rgb(path):
    img = bpy.data.images.load(path, check_existing=False)
    w, h = img.size
    px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)
    bpy.data.images.remove(img)
    return px


def save_rgb(px, path):
    h, w, _ = px.shape
    img = bpy.data.images.new('sheet', w, h, alpha=True)
    img.pixels.foreach_set(px.ravel())
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)


def main():
    a = args()
    os.makedirs(a.out, exist_ok=True)
    cfg = C.load_config()
    cam = setup(a)
    if a.cockpit:
        parts_cockpit(a.cockpit, [float(x) for x in a.socket.split(',')])
    elif a.legacy:
        legacy_proxy()
    else:
        raise SystemExit('[render] pass --cockpit <decoded parts glb> (or --legacy for a v1 build)')
    shots = a.shots.split(',')
    out = lambda n: os.path.join(a.out, a.prefix + n + '.png')  # noqa: E731
    rig = bpy.data.objects['PilotRig']
    variant('hero', cfg)
    pose('seated_base', 1)
    head = eyes_world()
    fwd = (rig.matrix_world.to_3x3() @ rig.pose.bones['head'].matrix.to_3x3() @ Vector((0, 0, 1))).normalized()
    if 'portrait' in shots:
        shoot(cam, out('portrait'), head + Vector((0.42, -0.82, 0.12)), head + Vector((0, 0, -0.03)), lens=85, res=(1000, 1200))
        shoot(cam, out('portrait_side'), head + Vector((0.9, -0.15, 0.08)), head + Vector((0, 0.03, -0.04)), lens=85, res=(1000, 1200))
    if 'hair' in shots:
        crown = head + Vector((0, 0.03, 0.06))
        shoot(cam, out('hair_front34'), crown + Vector((0.3, -0.42, 0.14)), crown, lens=85, res=(1000, 1000))
        shoot(cam, out('hair_side'), crown + Vector((0.56, 0.06, 0.06)), crown, lens=85, res=(1000, 1000))
        shoot(cam, out('hair_back'), crown + Vector((-0.24, 0.5, 0.18)), crown, lens=85, res=(1000, 1000))
    if 'head' in shots:
        # head + goggles close-ups (~0.45 m): hairline, strap continuity round the skull, cup attachment
        hc = head + Vector((0, 0.04, 0.04))
        hf = fwd.normalized()
        shoot(cam, out('head_front'), hc + hf * 0.5 + Vector((0, 0, 0.08)), hc, lens=85, res=(1000, 1000))
        shoot(cam, out('head_side_l'), hc + Vector((0.5, 0.02, 0.05)), hc, lens=85, res=(1000, 1000))
        shoot(cam, out('head_side_r'), hc + Vector((-0.5, 0.02, 0.05)), hc, lens=85, res=(1000, 1000))
        shoot(cam, out('head_back'), hc + Vector((0.0, 0.5, 0.12)), hc, lens=85, res=(1000, 1000))
    if 'neck' in shots:
        nk = bone_world('neck_01')
        shoot(cam, out('neck'), nk + Vector((0.16, -0.46, 0.02)), nk + Vector((0, -0.03, 0.0)), lens=85, res=(1000, 1000))
    if 'chase' in shots:
        tgt = Vector((0, -0.2, 0.3))
        d = Vector((-0.35, 1.0, 0.38)).normalized()
        shoot(cam, out('chase_10m_rear34'), tgt + d * 10.0, tgt, fov_deg=60, res=(1920, 1080), samples=32)
        d = Vector((-0.75, -0.62, 0.22)).normalized()
        shoot(cam, out('chase_10m_front34'), tgt + d * 10.0, tgt, fov_deg=60, res=(1920, 1080), samples=32)
        shoot(cam, out('chase_10m_front34_crop'), tgt + d * 10.0, tgt + Vector((0, 0, 0.3)), fov_deg=15, res=(960, 540), samples=32)
    if 'hands' in shots:
        for s, sx in (('l', 1), ('r', -1)):
            hnd = (bone_world(f'hand_{s}') + bone_world(f'middle_01_{s}')) / 2
            shoot(cam, out(f'hands_{s}_pilot'), hnd + Vector((0.26 * sx, 0.2, 0.3)), hnd, lens=60, res=(900, 900))
            shoot(cam, out(f'hands_{s}_outside'), hnd + Vector((0.36 * sx, 0.1, 0.06)), hnd, lens=60, res=(900, 900))
            shoot(cam, out(f'hands_{s}_dash'), hnd + Vector((0.1 * sx, -0.34, 0.14)), hnd, lens=60, res=(900, 900))
    if 'sleeve' in shots:
        wr = bone_world('hand_l')
        el = bone_world('lowerarm_l')
        mid = (wr * 0.65 + el * 0.35)
        shoot(cam, out('sleeve_glove_l'), mid + Vector((0.3, 0.2, 0.2)), mid, lens=60, res=(1100, 900))
    if 'cockpit' in shots:
        ce = bpy.data.objects.get('cam_eye')
        if ce is not None and 'head_geo' in rig.pose.bones:
            rig.pose.bones['head_geo'].scale = (0.001, 0.001, 0.001)
            bpy.context.view_layer.update()
            m = ce.matrix_world.copy()
            M = m @ Matrix.Rotation(math.radians(90), 4, 'X')  # empty local +Y view, +Z up -> camera -Z view
            M = M @ Matrix.Rotation(math.radians(-a.pov_pitch), 4, 'X')
            cam.matrix_world = M
        else:
            eye = eyes_world()
            rig.pose.bones['head'].scale = (0.001, 0.001, 0.001)
            bpy.context.view_layer.update()
            cam.location = eye + Vector((0, -0.03, 0.0))
            cam.rotation_euler = (Vector((0, -1.0, -0.78))).to_track_quat('-Z', 'Y').to_euler()
        sc = bpy.context.scene
        cam.data.lens_unit = 'FOV'
        cam.data.sensor_fit = 'HORIZONTAL'
        cam.data.angle = math.radians(86)
        cam.data.clip_start = cfg['rig'].get('sockets', {}).get('cam_eye', {}).get('nearMaxM', 0.01)
        sc.render.resolution_x, sc.render.resolution_y = 1920, 1080
        sc.render.filepath = out('cockpit_pov')
        bpy.ops.render.render(write_still=True)
        if ce is not None and 'head_geo' in rig.pose.bones:
            # the parts helm sits ~70 cm under the eye: at the runtime's pitch the wheel is out of frame,
            # so a second view looks down onto the hands
            cam.matrix_world = cam.matrix_world @ Matrix.Rotation(math.radians(-28), 4, 'X')
            sc.render.filepath = out('cockpit_pov_down')
            bpy.ops.render.render(write_still=True)
        for b in ('head_geo', 'head'):
            if b in rig.pose.bones:
                rig.pose.bones[b].scale = (1, 1, 1)
        bpy.context.view_layer.update()
    if 'goggles' in shots:
        pose('goggles_up', 2)
        head = eyes_world()
        shoot(cam, out('portrait_goggles_up'), head + Vector((0.42, -0.82, 0.12)), head + Vector((0, 0, 0.0)), lens=85, res=(1000, 1200))
        pose('seated_base', 1)
    if 'variants' in shots:
        tiles = []
        for v in ('hero', 'npc_b', 'npc_c'):
            variant(v, cfg)
            pose('goggles_up', 2)
            head = eyes_world()
            p = out(f'variant_{v}')
            shoot(cam, p, head + Vector((0.45, -0.85, 0.1)), head + Vector((0, 0, -0.04)), lens=70, res=(800, 1000))
            tiles.append(load_rgb(p))
        save_rgb(np.concatenate(tiles, axis=1), out('variants_sheet'))
        variant('hero', cfg)
        pose('seated_base', 1)
    if 'poses' in shots:
        keys = {'seated_base': 1, 'idle_seated': 16, 'steer_left': 16, 'steer_right': 16, 'throttle_push': 25, 'brace_landing': 19,
                'airborne_tuck': 25, 'impact_jolt': 4, 'capsize_hang': 16, 'look_back': 14, 'victory_fist': 18, 'goggles_up': 2}
        tiles = []
        for clip, fr in keys.items():
            pose(clip, fr)
            p = out(f'pose_{clip}')
            shoot(cam, p, Vector((-1.9, -2.3, 1.1)), Vector((0, -0.25, 0.15)), lens=40, res=(600, 600), samples=max(12, a.samples // 3))
            tiles.append(load_rgb(p))
        rows = [np.concatenate(tiles[i:i + 4], axis=1) for i in range(0, 12, 4)]
        save_rgb(np.concatenate(rows[::-1], axis=0), out('poses_sheet'))
        pose('seated_base', 1)


if __name__ == '__main__':
    main()
