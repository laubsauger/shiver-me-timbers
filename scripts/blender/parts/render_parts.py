"""
CPU preview renders for the hero parts (Cycles CPU + OIDN, no GPU, no browser).

  dev (geometry iteration, flat look colours, no bake):
    Blender -b --factory-startup -P scripts/blender/parts/render_parts.py -- \
        --hull hull.json --parts Outboard_P,Prop_P --views part --out-dir <dir>
  final (the built scene, baked textures; asset-build.mjs --blend <file>):
    Blender -b --factory-startup -P scripts/blender/parts/render_parts.py -- \
        --blend scene.blend --views part,rear34,hero34,side,chase,pov --out-dir <dir>

Views: `part` (2×2 turntable per part), `rear34`, `hero34`, `side`, `chase` (7.5 m back, 2.4 m up),
`pov` (cockpit camera at the eye anchor), `helm` (0.6 m close-up of the dash), `lod` (LOD0/1/2 side
by side). The pipeline-test hull has no cockpit well, so a render-only context hull with a well is
lofted from the same JSON (never exported).
"""
import argparse
import json
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, '..'))
import anchors as AN  # noqa: E402
import kit  # noqa: E402
import looks as LK  # noqa: E402
import sb_conventions as sb  # noqa: E402


def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument('--hull')
    p.add_argument('--manifest', default=os.path.join(HERE, 'manifest.json'))
    p.add_argument('--parts', default='')
    p.add_argument('--blend')
    p.add_argument('--views', default='part')
    p.add_argument('--out-dir', required=True)
    p.add_argument('--samples', type=int, default=32)
    p.add_argument('--threads', type=int, default=8)
    p.add_argument('--size', default='1280x720')
    p.add_argument('--tag', default='')
    p.add_argument('--lod', type=int, default=0)
    return p.parse_args(argv)


# ── context ──────────────────────────────────────────────────────────────────


def hex_rgba(h):
    c = bake_hex(h)
    return (c[0], c[1], c[2], 1.0)


def bake_hex(h):
    h = h.lstrip('#')
    c = [int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]
    return [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]


def hull_material(A):
    """render-only hull look: bone topsides, orange band, teal pinstripe, oxide antifoul, charcoal deck"""
    m = bpy.data.materials.new('__ctx_hull')
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes['Principled BSDF']
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    nt.links.new(geo.outputs['Position'], sep.inputs['Vector'])
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.interpolation = 'CONSTANT'
    d = A.deck_y
    cy = A.transom()['chineY']
    stops = [(cy - 1.0, '#6B2E25'), (cy + 0.02, '#EDE6D6'), (d - 0.36, '#1F4E5F'), (d - 0.33, '#EDE6D6'),
             (d - 0.30, '#E4572E'), (d - 0.03, '#EDE6D6')]
    lo, hi = cy - 1.0, d + 0.2
    els = ramp.color_ramp.elements
    els[0].position = 0.0
    els[0].color = hex_rgba(stops[0][1])
    els[1].position = 0.999
    els[1].color = hex_rgba('#EDE6D6')
    for pos, col in stops[1:]:
        e = els.new((pos - lo) / (hi - lo))
        e.color = hex_rgba(col)
    mr = nt.nodes.new('ShaderNodeMapRange')
    mr.inputs['From Min'].default_value = lo
    mr.inputs['From Max'].default_value = hi
    nt.links.new(sep.outputs['Z'], mr.inputs['Value'])
    nt.links.new(mr.outputs['Result'], ramp.inputs['Fac'])
    # up-facing = non-slip deck charcoal
    nsep = nt.nodes.new('ShaderNodeSeparateXYZ')
    nt.links.new(geo.outputs['Normal'], nsep.inputs['Vector'])
    gt = nt.nodes.new('ShaderNodeMath')
    gt.operation = 'GREATER_THAN'
    gt.inputs[1].default_value = 0.93
    nt.links.new(nsep.outputs['Z'], gt.inputs[0])
    mix = nt.nodes.new('ShaderNodeMix')
    mix.data_type = 'RGBA'
    mix.inputs['B'].default_value = hex_rgba('#3A3D40')
    nt.links.new(gt.outputs[0], mix.inputs['Factor'])
    nt.links.new(ramp.outputs['Color'], mix.inputs['A'])
    nt.links.new(mix.outputs['Result'], bsdf.inputs['Base Color'])
    rough = nt.nodes.new('ShaderNodeMath')
    rough.operation = 'MULTIPLY_ADD'
    rough.inputs[1].default_value = 0.55
    rough.inputs[2].default_value = 0.22
    nt.links.new(gt.outputs[0], rough.inputs[0])
    nt.links.new(rough.outputs[0], bsdf.inputs['Roughness'])
    return m


def context_hull(hull, A, contract):
    import build_pipeline_test as bpt
    hull = dict(hull)
    hull['stations'] = bpt.resample_stations(hull['stations'], bpt.PIPELINE_TEST_STATIONS)
    mat = hull_material(A)
    parent = sb.make_empty('__ctx')
    ob = bpt.loft_hull(hull, 0, contract, [mat, mat, mat], parent)
    ob.name = '__ctx_hull'
    for k in list(ob.keys()):
        del ob[k]
    W = A.cockpit_well()
    zc = (W['zAft'] + W['zFwd']) / 2
    cutter = bpy.data.objects.new('__cut', bpy.data.meshes.new('__cut'))
    bpy.context.scene.collection.objects.link(cutter)
    g = kit.box(2 * W['halfWidth'], A.deck_y - W['soleY'] + 0.3, W['zFwd'] - W['zAft'],
                center=(0, (A.deck_y + W['soleY']) / 2 + 0.15, zc))
    cutter.data.from_pydata([tuple(kit.t2b(v)) for v in g.v], [], g.f)
    mod = ob.modifiers.new('well', 'BOOLEAN')
    mod.operation = 'DIFFERENCE'
    mod.object = cutter
    mod.solver = 'EXACT'
    sb.apply_modifiers(ob)
    bpy.data.objects.remove(cutter, do_unlink=True)
    # sole + well liner
    liner = kit.box(2 * W['halfWidth'] - 0.002, 0.02, W['zFwd'] - W['zAft'] - 0.002, center=(0, W['soleY'] - 0.01, zc))
    lm = bpy.data.meshes.new('__ctx_sole')
    lm.from_pydata([tuple(kit.t2b(v)) for v in liner.v], [], liner.f)
    lo = bpy.data.objects.new('__ctx_sole', lm)
    bpy.context.scene.collection.objects.link(lo)
    sm = bpy.data.materials.new('__ctx_sole')
    sm.use_nodes = True
    sm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = hex_rgba('#34373A')
    sm.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.8
    lm.materials.append(sm)
    return [ob, lo]


def look_material(name):
    mat = bpy.data.materials.get('__look_' + name)
    if mat:
        return mat
    lk = LK.look(name)
    mat = bpy.data.materials.new('__look_' + name)
    mat.use_nodes = True
    b = mat.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = hex_rgba(lk['base'])
    b.inputs['Roughness'].default_value = lk['rough']
    b.inputs['Metallic'].default_value = lk['metal']
    if lk['opacity'] < 1:
        b.inputs['Transmission Weight'].default_value = 1.0
        b.inputs['IOR'].default_value = 1.49
    return mat


def studio(scene, threads, samples, size):
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.render.threads_mode = 'FIXED'
    scene.render.threads = threads
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.cycles.denoiser = 'OPENIMAGEDENOISE'
    scene.cycles.max_bounces = 6
    scene.cycles.transmission_bounces = 6
    w, h = (int(v) for v in size.split('x'))
    scene.render.resolution_x, scene.render.resolution_y = w, h
    scene.view_settings.view_transform = 'AgX'
    scene.view_settings.look = 'AgX - Medium High Contrast'
    world = bpy.data.worlds.new('__studio')
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes['Background']
    # soft vertical gradient: brighter sky, darker ground bounce
    tc = world.node_tree.nodes.new('ShaderNodeTexCoord')
    sep = world.node_tree.nodes.new('ShaderNodeSeparateXYZ')
    world.node_tree.links.new(tc.outputs['Generated'], sep.inputs['Vector'])
    ramp = world.node_tree.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].position = 0.35
    ramp.color_ramp.elements[0].color = (0.30, 0.29, 0.28, 1)
    ramp.color_ramp.elements[1].position = 0.75
    ramp.color_ramp.elements[1].color = (0.85, 0.86, 0.88, 1)
    world.node_tree.links.new(sep.outputs['Z'], ramp.inputs['Fac'])
    world.node_tree.links.new(ramp.outputs['Color'], bg.inputs['Color'])
    bg.inputs['Strength'].default_value = 0.9
    sun = bpy.data.objects.new('__sun', bpy.data.lights.new('__sun', 'SUN'))
    sun.data.energy = 3.2
    sun.data.angle = math.radians(4)
    sun.rotation_euler = (math.radians(48), math.radians(12), math.radians(-35))
    scene.collection.objects.link(sun)


def ground(z, size=60):
    me = bpy.data.meshes.new('__ground')
    s = size / 2
    me.from_pydata([(-s, -s, z), (s, -s, z), (s, s, z), (-s, s, z)], [], [(0, 1, 2, 3)])
    ob = bpy.data.objects.new('__ground', me)
    bpy.context.scene.collection.objects.link(ob)
    m = bpy.data.materials.new('__ground')
    m.use_nodes = True
    m.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.56, 0.55, 0.53, 1)
    m.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.9
    me.materials.append(m)
    return ob


def camera(scene, loc_three, target_three, lens=50.0, name='__cam'):
    cam = bpy.data.objects.new(name, bpy.data.cameras.new(name))
    scene.collection.objects.link(cam)
    cam.data.lens = lens
    cam.data.clip_start = 0.02
    cam.location = kit.t2b(loc_three)
    d = kit.t2b(target_three) - cam.location
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    scene.camera = cam
    return cam


def render(scene, path):
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print(f'[render] {path}')


def bbox_three(objs):
    lo = Vector((1e9, 1e9, 1e9))
    hi = -lo
    for o in objs:
        for v in o.data.vertices:
            w = o.matrix_world @ v.co
            t = Vector((w.x, w.z, -w.y))
            lo = Vector(map(min, lo, t))
            hi = Vector(map(max, hi, t))
    return lo, hi


def grid2x2(paths, out):
    imgs = []
    for p in paths:
        im = bpy.data.images.load(p)
        a = np.empty(im.size[0] * im.size[1] * 4, dtype=np.float32)
        im.pixels.foreach_get(a)
        imgs.append(a.reshape(im.size[1], im.size[0], 4))
        bpy.data.images.remove(im)
    top = np.concatenate([imgs[2], imgs[3]], axis=1)
    bot = np.concatenate([imgs[0], imgs[1]], axis=1)
    full = np.concatenate([bot, top], axis=0)
    img = bpy.data.images.new('__grid', full.shape[1], full.shape[0], alpha=True)
    img.pixels.foreach_set(full.ravel())
    img.filepath_raw = out
    img.file_format = 'PNG'
    img.save()
    for p in paths:
        os.remove(p)
    print(f'[render] {out}')


def main():
    args = parse_args()
    os.makedirs(args.out_dir, exist_ok=True)
    views = args.views.split(',')
    with open(args.manifest, 'r', encoding='utf-8') as f:
        manifest = json.load(f)
    contract = sb.load_contract()
    if args.blend:
        bpy.ops.wm.open_mainfile(filepath=os.path.abspath(args.blend))
        scene = bpy.context.scene
        hull_path = args.hull
        # the raw builder links livery masks into Alpha so the exporter keeps the channel; opaque
        # slots must not render see-through here
        for mat in bpy.data.materials:
            slot = contract['slots'].get(mat.name.split('.')[0])
            if slot is None or slot['alphaMode'] != 'OPAQUE' or not mat.node_tree:
                continue
            for link in list(mat.node_tree.links):
                if link.to_socket.name == 'Alpha':
                    mat.node_tree.links.remove(link)
        for img in bpy.data.images:
            img.alpha_mode = 'CHANNEL_PACKED'
        keep = f'LOD{args.lod}'
        for ob in list(scene.objects):
            par = ob
            while par is not None and not par.name.startswith('LOD'):
                par = par.parent
            if par is not None and par.name != keep:
                ob.hide_render = True
            if ob.name.startswith('Hull_LOD'):
                ob.hide_render = True  # the pipeline-test hull has no well; the context hull replaces it
        parts = {}
        for ob in scene.objects:
            if ob.type == 'MESH' and ob.name.endswith(f'_LOD{args.lod}') and not ob.name.startswith('Hull'):
                pid = ob.name[: -len(f'_LOD{args.lod}')]
                if args.parts and pid not in args.parts.split(','):
                    continue
                parts.setdefault(pid, []).append(ob)
    else:
        sb.reset_scene(args.threads)
        scene = bpy.context.scene
        hull_path = args.hull
        import build_parts
        os.environ['SB_PARTS_ONLY'] = args.parts
        mats = {name: sb.principled_material(contract, name)[0] for name in ('M_Carbon', 'M_Metal', 'M_Cockpit', 'M_Perspex')}

        class _Args:
            bake_size = 256
            ao_samples = 4
            work = args.out_dir
        hp = build_parts.HeroParts(json.load(open(hull_path)), args.manifest, contract, mats, [None, None, None], _Args)
        hp.build_lod0()
        parts = {}
        for spec, pieces, _ in hp.parts:
            for p in pieces:
                p.obj.material_slots[0].material = look_material(p.look)
                parts.setdefault(spec['id'], []).append(p.obj)
    hull = json.load(open(hull_path))
    A = AN.Anchors(hull, manifest)
    studio(scene, args.threads, args.samples, args.size)
    ctx = context_hull(hull, A, contract)
    keel = A.transom()['keelY']
    gnd = ground(keel - 1.3)
    # sky fill over the cockpit: the studio sun leaves the well in shadow, a real sky would not
    e = A.eye()
    fill = bpy.data.objects.new('__fill', bpy.data.lights.new('__fill', 'AREA'))
    fill.data.energy = 260.0
    fill.data.size = 2.5
    fill.location = kit.t2b((e[0], e[1] + 1.6, e[2] - 0.6))
    fill.rotation_euler = (kit.t2b((0, A.dash()['topY'] - 0.2, A.dash()['zAft'])) - fill.location).to_track_quat('-Z', 'Y').to_euler()
    scene.collection.objects.link(fill)
    tag = args.tag
    all_objs = [o for objs in parts.values() for o in objs]

    for view in views:
        if view == 'part':
            for o in ctx:
                o.hide_render = True
            lod_meshes = [o for o in scene.objects if o.type == 'MESH' and not o.name.startswith('__') and not o.hide_render]
            for pid, objs in parts.items():
                for o in lod_meshes:
                    o.hide_render = o not in objs
                lo, hi = bbox_three(objs)
                c = (lo + hi) / 2
                r = max((hi - lo).length * 0.5, 0.05)
                paths = []
                for k, az in enumerate((35, 145, 215, 325)):
                    a = math.radians(az)
                    el = math.radians(18)
                    dist = r * 4.4
                    loc = (c.x + math.sin(a) * math.cos(el) * dist, c.y + math.sin(el) * dist, c.z + math.cos(a) * math.cos(el) * dist)
                    camera(scene, loc, tuple(c), lens=50)
                    w, h = scene.render.resolution_x, scene.render.resolution_y
                    scene.render.resolution_x, scene.render.resolution_y = w // 2, h // 2
                    pth = os.path.join(args.out_dir, f'__{pid}_{k}.png')
                    render(scene, pth)
                    scene.render.resolution_x, scene.render.resolution_y = w, h
                    paths.append(pth)
                grid2x2(paths, os.path.join(args.out_dir, f'part_{pid}{tag}.png'))
            for o in ctx + lod_meshes:
                o.hide_render = False
            continue
        t = A.transom()
        stern = Vector((0, t['topY'], t['z']))
        if view == 'rear34':
            camera(scene, (4.2, 2.3, stern.z - 5.4), (0.0, 0.1, stern.z + 1.6), lens=40)
        elif view == 'rear_close':
            camera(scene, (2.2, 0.9, stern.z - 3.2), (0.0, -0.2, stern.z - 0.6), lens=40)
        elif view == 'hero34':
            camera(scene, (7.5, 3.0, 9.5), (0.0, 0.3, 0.2), lens=45)
        elif view == 'side':
            camera(scene, (16.0, 0.6, 0.3), (0.0, 0.3, 0.3), lens=50)
        elif view == 'chase':
            camera(scene, (0.0, keel + 0.85 + 2.4, stern.z - 7.5), (0.0, keel + 1.2, stern.z + 6.0), lens=35)
        elif view == 'top':
            camera(scene, (0.0, 18.0, 0.3), (0.0, 0.0, 0.31), lens=50)
        elif view == 'pov':
            e = A.eye()
            camera(scene, e, (0.0, e[1] - 1.9, e[2] + 6.0), lens=16)
        elif view == 'helm':
            e = A.eye()
            camera(scene, (e[0] + 0.25, e[1] - 0.05, e[2] + 0.05), (0.0, A.dash()['topY'] - 0.12, A.dash()['zAft'] + 0.1), lens=24)
        elif view == 'far25':   # LOD1 range: ~25 m chase/overtake
            camera(scene, (9.0, 4.0, stern.z - 22.0), (0.0, 0.2, 0.0), lens=50)
        elif view == 'far60':   # LOD2 range
            camera(scene, (20.0, 8.0, stern.z - 55.0), (0.0, 0.2, 0.0), lens=50)
        elif view == 'arch':
            a = A.arch()
            camera(scene, (2.0, a['topY'] + 0.3, a['z'] - 2.2), (0.0, a['topY'] - 0.2, a['z']), lens=45)
        else:
            print(f'[render] unknown view {view}')
            continue
        if os.environ.get('SB_RAY_DEBUG') and view == 'pov':
            cam = scene.camera
            dg = bpy.context.evaluated_depsgraph_get()
            fwd = cam.matrix_world.to_3x3() @ Vector((0, 0, -1))
            upv = cam.matrix_world.to_3x3() @ Vector((0, 1, 0))
            for k in range(0, 34, 3):
                d = (fwd + upv * math.tan(math.radians(k))).normalized()
                hit, loc, n, idx, ob, M = scene.ray_cast(dg, cam.location, d)
                print('[ray]', k, ob.name if hit else None, tuple(round(v, 3) for v in loc) if hit else '')
        render(scene, os.path.join(args.out_dir, f'{view}{tag}.png'))


main()
