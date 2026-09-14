"""
PIPELINE-TEST speedboat hull — NOT the hero model.

Proves the Blender → glTF → gltf-transform → runtime pipeline end to end with geometry lofted from
the physics proxy's own offsets (a JSON written by scripts/blender/hullOffsets.ts from
src/speedboat/hullMesh.ts). Every surface, colour and part here is a stand-in chosen to exercise a
contract rule: 7 material slots, a textured hull (baseColor+livery alpha, ORM, normal), a
transmissive windscreen, three LODs, extras, a manifold hull shell.

Run headless (scripts/asset-build.mjs does this for you):

  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
      -P scripts/blender/build_pipeline_test.py -- \
      --hull hull.json --out raw.glb --work <dir> [--kind player] [--bake-size 1024] \
      [--ao-samples 16] [--threads 4] [--name speedboat_pipeline_test]

If the hull JSON carries fewer than 241 stations (e.g. src/speedboat/deepV12.hull.json itself,
29 stations), stations are linearly resampled — fine for a smoke run, but the pipeline feeds the
241-station evaluation so the loft follows the shape functions, not a chord of them.
"""
import argparse
import math
import os
import sys

import bpy
import bmesh
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sb_conventions as sb  # noqa: E402

PIPELINE_TEST_STATIONS = 241

# per-LOD loft resolution: (station stride, bottom subdiv, topside subdiv, deck subdiv, strakes)
LOD_LOFT = [
    (1, 3, 3, 4, True),
    (4, 1, 1, 2, True),
    (12, 0, 0, 0, False),
]
# per-LOD generic-part decimation (None = part dropped at that LOD)
PART_LOD_RATIO = {
    'RubRail': [1.0, 0.3, None],
    'BowRail': [1.0, 0.3, None],
    'Windscreen': [1.0, 0.5, 0.25],
    'Cowl': [1.0, 0.2, 0.06],
}


def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument('--hull', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--work', required=True)
    p.add_argument('--contract', default=sb.CONTRACT_PATH)
    p.add_argument('--kind', default='player', choices=['player', 'npc'])
    p.add_argument('--bake-size', type=int, default=1024)
    p.add_argument('--ao-samples', type=int, default=16)
    p.add_argument('--threads', type=int, default=4)
    p.add_argument('--name', default='speedboat_pipeline_test')
    # hero parts (scripts/blender/parts/manifest.json) replace the stand-in parts below
    p.add_argument('--parts', default=None)
    # save the built scene (textures attached, before export) for CPU preview renders
    p.add_argument('--blend', default=None)
    # 'hero': the SB-12 hero hull (scripts/blender/hull/); 'test': the stand-in loft below
    p.add_argument('--hull-kind', default='test', choices=['hero', 'test'])
    return p.parse_args(argv)


def smoothstep(e0, e1, x):
    if e0 == e1:
        return 1.0 if x >= e1 else 0.0
    t = min(max((x - e0) / (e1 - e0), 0.0), 1.0)
    return t * t * (3 - 2 * t)


def resample_stations(stations, count):
    if len(stations) == count:
        return stations
    zs = [s['z'] for s in stations]
    keys = [k for k in stations[0] if k != 'z']
    out = []
    L = zs[-1]
    for i in range(count):
        z = L * i / (count - 1)
        j = max(0, min(len(zs) - 2, next((k for k in range(len(zs) - 1) if zs[k + 1] >= z), len(zs) - 2)))
        t = (z - zs[j]) / max(zs[j + 1] - zs[j], 1e-9)
        s = {'z': z}
        for k in keys:
            s[k] = stations[j][k] * (1 - t) + stations[j + 1][k] * t
        out.append(s)
    print(f'[pipeline-test] WARNING: resampled {len(stations)} stations → {count} linearly')
    return out


# ── hull loft ────────────────────────────────────────────────────────────────


def half_section(st, ro, lod):
    """+x half of one transverse section in the HULL frame, keel → sheer → deck centre.
    Returns (points, index of the chine-outer point, index of the sheer point)."""
    _, n_bot, n_top, n_deck, strakes_on = LOD_LOFT[lod]
    z = st['z']
    b = max(st['chineHalfBeam'], 1e-4)
    ky = st['keelY']
    tan_b = (st['chineY'] - ky) / b
    dy = st['deckY']

    def V(x):
        return ky + x * tan_b

    pts = [(0.0, ky)]

    def bottom_to(xt):
        x0 = pts[-1][0]
        for k in range(1, n_bot + 1):
            x = x0 + (xt - x0) * k / (n_bot + 1)
            pts.append((x, V(x)))
        pts.append((xt, V(xt)))

    if strakes_on:
        for s in sorted(ro['strakes'], key=lambda s: s['atChineFraction']):
            fade = smoothstep(s['toZ'] + 0.6, s['toZ'], z) * smoothstep(s['fromZ'] - 0.6, s['fromZ'], z)
            w = min(max(0.002, s['flatWidth'] * fade), 0.1 * b)
            x0 = s['atChineFraction'] * b
            bottom_to(x0)
            pts.append((x0 + w, V(x0)))  # flat underside, below the V line
            pts.append((x0 + w, V(x0 + w)))  # outer face back up to the V line
    wc = min(ro['chineFlat']['width'], 0.15 * b)
    bottom_to(b - wc)
    yc = V(b - wc)
    pts.append((b, yc))
    i_chine = len(pts) - 1
    # topside: vertical from the proxy chine line up to the flare knuckle, then flared to the sheer
    # (json renderOnly.topsideFlareStartAboveChine; STYLE-SPEC C3: sheer = halfBeamAt + flare term)
    cy = st['chineY']
    yk = min(dy - 0.02, cy + ro.get('topsideFlareStartAboveChine', 0.0))
    xs = b + max(0.0, dy - yk) * math.tan(math.radians(ro['topsideFlareDeg']))
    pts.append((b, yk))
    for k in range(1, n_top + 1):
        f = k / (n_top + 1)
        pts.append((b + (xs - b) * f, yk + (dy - yk) * f))
    pts.append((xs, dy))
    i_sheer = len(pts) - 1
    for k in range(1, n_deck + 1):
        pts.append((xs * (1 - k / (n_deck + 1)), dy))
    pts.append((0.0, dy))
    return pts, i_chine, i_sheer


def loft_hull(hull, lod, contract, materials, parent):
    stride = LOD_LOFT[lod][0]
    stations = hull['stations']
    idx = list(range(0, len(stations), stride))
    if idx[-1] != len(stations) - 1:
        idx.append(len(stations) - 1)
    spec = hull['spec']
    ro = hull['renderOnly']
    lcg, vcg, L = spec['lcgFromTransom'], spec['vcgAboveKeel'], spec['length']

    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.new('UVMap')
    rings = []
    ring_kinds = None
    girth = []
    for si in idx:
        st = stations[si]
        half, i_chine, i_sheer = half_section(st, ro, lod)
        H = len(half)
        ring = half + [(-x, y) for (x, y) in reversed(half[1:-1])]
        n = len(ring)
        # segment j joins ring[j] → ring[(j+1) % n]; kinds from the half it mirrors
        kinds = []
        for j in range(n):
            s = j if j <= H - 2 else 2 * H - 3 - j
            kinds.append('bottom' if s < i_chine else ('topside' if s < i_sheer else 'deck'))
        if ring_kinds is None:
            ring_kinds = kinds
        elif len(kinds) != len(ring_kinds):
            raise RuntimeError('hull loft: ring topology changed between stations (a feature switched off mid-hull)')
        # stem rake: the deck edge of a station sits at deckZ, the keel at z; blend by height
        rake = st.get('deckZ', st['z']) - st['z']
        span = max(st['deckY'] - st['keelY'], 1e-6)
        verts = [bm.verts.new(sb.three_to_blender(x, y - vcg, st['z'] + rake * min(max((y - st['keelY']) / span, 0.0), 1.0) - lcg))
                 for (x, y) in ring]
        rings.append((st['z'], verts, ring))
        acc = [0.0]
        for j in range(n):
            (x0, y0), (x1, y1) = ring[j], ring[(j + 1) % n]
            acc.append(acc[-1] + math.hypot(x1 - x0, y1 - y0))
        girth.append(acc)

    slot_index = {'bottom': 0, 'topside': 1, 'deck': 2}
    V_SHELL = 0.78
    for r in range(len(rings) - 1):
        za, va, _ = rings[r]
        zb, vb, _ = rings[r + 1]
        ga, gb = girth[r], girth[r + 1]
        n = len(va)
        for j in range(n):
            k = (j + 1) % n
            f = bm.faces.new((va[j], va[k], vb[k], vb[j]))
            f.material_index = slot_index[ring_kinds[j]]
            f.smooth = True
            uvs = [
                (0.01 + 0.98 * za / L, V_SHELL * ga[j] / ga[-1]),
                (0.01 + 0.98 * za / L, V_SHELL * ga[j + 1] / ga[-1]),
                (0.01 + 0.98 * zb / L, V_SHELL * gb[j + 1] / gb[-1]),
                (0.01 + 0.98 * zb / L, V_SHELL * gb[j] / gb[-1]),
            ]
            for loop, uv in zip(f.loops, uvs):
                loop[uv_layer].uv = uv

    def cap(ring_entry, u0):
        _, verts, pts2d = ring_entry
        f = bm.faces.new(verts)
        f.material_index = slot_index['topside']
        xs = [abs(p[0]) for p in pts2d]
        ys = [p[1] for p in pts2d]
        wmax, y0, y1 = max(max(xs), 1e-4), min(ys), max(ys)
        by_vert = {v: p for v, p in zip(verts, pts2d)}
        for loop in f.loops:
            x, y = by_vert[loop.vert]
            loop[uv_layer].uv = (u0 + 0.46 * (0.5 + 0.5 * x / wmax), 0.80 + 0.18 * (y - y0) / max(y1 - y0, 1e-4))

    cap(rings[0], 0.02)  # transom
    cap(rings[-1], 0.52)  # stem

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bmesh.ops.triangulate(bm, faces=bm.faces[:], quad_method='BEAUTY', ngon_method='EAR_CLIP')
    name = sb.hull_name(contract, lod)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    for m in materials:
        mesh.materials.append(m)
    try:
        mesh.set_sharp_from_angle(angle=math.radians(35))
    except AttributeError:
        pass
    return sb.link_mesh_object(name, mesh, parent, lod, {'foamTarget': True})


# ── generic parts (stand-ins for generated/kitbashed parts) ─────────────────


def sheer_at(hull, z_hull):
    """sheer half-beam and deck height at hull-frame z (linear in the dense table)."""
    st = hull['stations']
    ro = hull['renderOnly']
    j = max(0, min(len(st) - 2, int(z_hull / st[-1]['z'] * (len(st) - 1))))
    a, b = st[j], st[j + 1]
    t = min(max((z_hull - a['z']) / max(b['z'] - a['z'], 1e-9), 0), 1)
    lerp = lambda k: a[k] * (1 - t) + b[k] * t  # noqa: E731
    half, _, i_sheer = half_section({k: lerp(k) if k != 'z' else z_hull for k in a}, ro, 2)
    return half[i_sheer][0], lerp('deckY')


def tube_part(name, splines, radius, material):
    cu = bpy.data.curves.new(name, 'CURVE')
    cu.dimensions = '3D'
    cu.bevel_depth = radius
    cu.bevel_resolution = 2
    cu.use_fill_caps = True
    cu.resolution_u = 1
    for pts in splines:
        sp = cu.splines.new('POLY')
        sp.points.add(len(pts) - 1)
        for i, p in enumerate(pts):
            sp.points[i].co = (*sb.three_to_blender(*p), 1.0)
    obj = bpy.data.objects.new(name + '_curve', cu)
    bpy.context.scene.collection.objects.link(obj)
    mesh = sb.curve_to_mesh(obj, name)
    mesh.materials.append(material)
    return mesh


def build_parts(hull, mats):
    spec = hull['spec']
    L, lcg, vcg = spec['length'], spec['lcgFromTransom'], spec['vcgAboveKeel']
    parts = {}

    # rub rail along the sheer, both sides
    zs = [L * (0.004 + 0.97 * i / 60) for i in range(61)]
    side = []
    for sgn in (1, -1):
        pts = []
        for z in zs:
            xs, dy = sheer_at(hull, z)
            pts.append((sgn * (xs + 0.012), dy - vcg - 0.06, z - lcg))
        side.append(pts)
    parts['RubRail'] = tube_part('RubRail', side, 0.04, mats['M_Rubber'])

    # bow rail on stanchions over the foredeck
    rail = []
    zs = [L * (0.60 + 0.33 * i / 24) for i in range(25)]
    for sgn in (1, -1):
        pts = []
        for z in zs:
            xs, dy = sheer_at(hull, z)
            pts.append((sgn * max(xs - 0.1, 0.05), dy - vcg + 0.32, z - lcg))
        rail.append(pts)
        for z in zs[::6]:
            xs, dy = sheer_at(hull, z)
            x = sgn * max(xs - 0.1, 0.05)
            rail.append([(x, dy - vcg, z - lcg), (x, dy - vcg + 0.32, z - lcg)])
    parts['BowRail'] = tube_part('BowRail', rail, 0.016, mats['M_Metal'])

    # windscreen: a raked, forward-bulged sheet with thickness (closed after solidify)
    zw = 0.52 * L
    xs, dy = sheer_at(hull, zw)
    bm = bmesh.new()
    cols, rows = 20, 4
    grid = []
    for r in range(rows + 1):
        h = r / rows
        row = []
        for c in range(cols + 1):
            s = -1 + 2 * c / cols
            x = s * 0.78 * xs
            y = dy - vcg + 0.04 + h * 0.46
            z = zw - lcg + 0.28 * (1 - s * s) - h * 0.32
            row.append(bm.verts.new(sb.three_to_blender(x, y, z)))
        grid.append(row)
    for r in range(rows):
        for c in range(cols):
            f = bm.faces.new((grid[r][c], grid[r][c + 1], grid[r + 1][c + 1], grid[r + 1][c]))
            f.smooth = True
    mesh = bpy.data.meshes.new('Windscreen')
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(mats['M_Perspex'])
    parts['Windscreen'] = mesh

    # engine cowl: bevelled, subdivided block on the aft deck
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    z0, z1 = 0.06 * L, 0.30 * L
    _, dy = sheer_at(hull, (z0 + z1) / 2)
    for v in bm.verts:
        x, y, z = v.co.x, v.co.z, -v.co.y  # cube is centred; read it in three axes
        tx, ty, tz = x * 1.7, dy - vcg + 0.2 + y * 0.4, (z0 + z1) / 2 - lcg + z * (z1 - z0)
        v.co = sb.three_to_blender(tx, ty, tz)
    mesh = bpy.data.meshes.new('Cowl')
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(mats['M_Carbon'])
    parts['Cowl'] = mesh
    return parts


def finish_part_lod0(obj):
    name = obj.name.split('_LOD')[0]
    if name == 'Windscreen':
        mod = obj.modifiers.new('Thickness', 'SOLIDIFY')
        mod.thickness = 0.012
        mod.offset = 0
    elif name == 'Cowl':
        bev = obj.modifiers.new('Bevel', 'BEVEL')
        bev.width = 0.06
        bev.segments = 4
        sub = obj.modifiers.new('Subsurf', 'SUBSURF')
        sub.levels = 2
        sub.render_levels = 2
    sb.apply_modifiers(obj)
    for p in obj.data.polygons:
        p.use_smooth = True
    sb.triangulate_object(obj)
    sb.smart_uv(obj)


# ── bake stubs ───────────────────────────────────────────────────────────────


SLOT_LOOK = {
    # base colour (linear), roughness, bump kind — stand-ins, not art direction
    'M_Antifoul': ((0.035, 0.04, 0.045), 0.82, 'noise_coarse'),
    'M_Gelcoat': ((0.78, 0.76, 0.72), 0.12, 'orange_peel'),
    'M_NonSlip': ((0.42, 0.42, 0.40), 0.72, 'tread'),
}
HULL_SLOTS = ['M_Antifoul', 'M_Gelcoat', 'M_NonSlip']


def _emit_material(name, build_signal):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    em = nt.nodes.new('ShaderNodeEmission')
    em.inputs['Strength'].default_value = 1.0
    nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
    build_signal(nt, em.inputs['Color'])
    return mat


def _wear(nt):
    """convex-edge wear from Cycles pointiness — the curvature bake stub"""
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    mr = nt.nodes.new('ShaderNodeMapRange')
    mr.inputs['From Min'].default_value = 0.52
    mr.inputs['From Max'].default_value = 0.62
    nt.links.new(geo.outputs['Pointiness'], mr.inputs['Value'])
    return mr.outputs['Result']


def bake_hull_textures(hull_obj, args, deck_body_y):
    size = args.bake_size
    work = args.work
    img_color = sb.new_image('bake_color', size, non_color=False)
    img_mask = sb.new_image('bake_mask', size, non_color=True)
    img_rough = sb.new_image('bake_rough', size, non_color=True)
    img_ao = sb.new_image('bake_ao', size, non_color=True)
    img_normal = sb.new_image('hull_normal', size, non_color=True)

    def color_mat(slot):
        base, _, _ = SLOT_LOOK[slot]

        def sig(nt, sock):
            mix = nt.nodes.new('ShaderNodeMix')
            mix.data_type = 'RGBA'
            mix.inputs['A'].default_value = (*base, 1)
            mix.inputs['B'].default_value = (0.36, 0.36, 0.34, 1)  # exposed fibreglass
            mul = nt.nodes.new('ShaderNodeMath')
            mul.operation = 'MULTIPLY'
            mul.inputs[1].default_value = 0.0 if slot == 'M_Antifoul' else 0.7
            nt.links.new(_wear(nt), mul.inputs[0])
            nt.links.new(mul.outputs['Value'], mix.inputs['Factor'])
            nt.links.new(mix.outputs['Result'], sock)
        return _emit_material(f'BAKE_color_{slot}', sig)

    def mask_mat(slot):
        def sig(nt, sock):
            if slot != 'M_Gelcoat':
                sock.default_value = (0, 0, 0, 1)
                return
            tc = nt.nodes.new('ShaderNodeTexCoord')
            sep = nt.nodes.new('ShaderNodeSeparateXYZ')
            nt.links.new(tc.outputs['Object'], sep.inputs['Vector'])
            lo = nt.nodes.new('ShaderNodeMath')
            lo.operation = 'GREATER_THAN'
            lo.inputs[1].default_value = deck_body_y - 0.42
            hi = nt.nodes.new('ShaderNodeMath')
            hi.operation = 'LESS_THAN'
            hi.inputs[1].default_value = deck_body_y - 0.22
            nt.links.new(sep.outputs['Z'], lo.inputs[0])
            nt.links.new(sep.outputs['Z'], hi.inputs[0])
            both = nt.nodes.new('ShaderNodeMath')
            both.operation = 'MULTIPLY'
            nt.links.new(lo.outputs['Value'], both.inputs[0])
            nt.links.new(hi.outputs['Value'], both.inputs[1])
            nt.links.new(both.outputs['Value'], sock)
        return _emit_material(f'BAKE_mask_{slot}', sig)

    def rough_mat(slot):
        _, rough, _ = SLOT_LOOK[slot]

        def sig(nt, sock):
            add = nt.nodes.new('ShaderNodeMath')
            add.operation = 'MULTIPLY_ADD'
            add.inputs[1].default_value = 0.25
            add.inputs[2].default_value = rough
            nt.links.new(_wear(nt), add.inputs[0])
            clamp = nt.nodes.new('ShaderNodeClamp')
            nt.links.new(add.outputs['Value'], clamp.inputs['Value'])
            nt.links.new(clamp.outputs['Result'], sock)
        return _emit_material(f'BAKE_rough_{slot}', sig)

    def normal_mat(slot):
        _, _, kind = SLOT_LOOK[slot]
        mat = bpy.data.materials.new(f'BAKE_normal_{slot}')
        mat.use_nodes = True
        nt = mat.node_tree
        bsdf = nt.nodes['Principled BSDF']
        bump = nt.nodes.new('ShaderNodeBump')
        tc = nt.nodes.new('ShaderNodeTexCoord')
        if kind == 'tread':
            wa = nt.nodes.new('ShaderNodeTexWave')
            wb = nt.nodes.new('ShaderNodeTexWave')
            for w, direction in ((wa, 'X'), (wb, 'Y')):
                w.wave_type = 'BANDS'
                w.bands_direction = direction
                w.inputs['Scale'].default_value = 60
                nt.links.new(tc.outputs['Object'], w.inputs['Vector'])
            mul = nt.nodes.new('ShaderNodeMath')
            mul.operation = 'MULTIPLY'
            nt.links.new(wa.outputs['Fac'], mul.inputs[0])
            nt.links.new(wb.outputs['Fac'], mul.inputs[1])
            height, strength = mul.outputs['Value'], 0.35
        else:
            noise = nt.nodes.new('ShaderNodeTexNoise')
            noise.inputs['Scale'].default_value = 220 if kind == 'orange_peel' else 45
            nt.links.new(tc.outputs['Object'], noise.inputs['Vector'])
            height, strength = noise.outputs['Fac'], (0.025 if kind == 'orange_peel' else 0.12)
        bump.inputs['Strength'].default_value = strength
        bump.inputs['Distance'].default_value = 0.002
        nt.links.new(height, bump.inputs['Height'])
        nt.links.new(bump.outputs['Normal'], bsdf.inputs['Normal'])
        return mat

    emit_samples = 1
    sb.bake_pass(hull_obj, img_color, 'EMIT', emit_samples, [color_mat(s) for s in HULL_SLOTS])
    sb.bake_pass(hull_obj, img_mask, 'EMIT', emit_samples, [mask_mat(s) for s in HULL_SLOTS])
    sb.bake_pass(hull_obj, img_rough, 'EMIT', emit_samples, [rough_mat(s) for s in HULL_SLOTS])
    ao_mats = [color_mat(s) for s in HULL_SLOTS]
    sb.bake_pass(hull_obj, img_ao, 'AO', args.ao_samples, ao_mats)
    sb.bake_pass(hull_obj, img_normal, 'NORMAL', 1, [normal_mat(s) for s in HULL_SLOTS])

    def px(img):
        a = np.empty(len(img.pixels), dtype=np.float32)
        img.pixels.foreach_get(a)
        return a.reshape(-1, 4)

    base = px(img_color)
    base[:, 3] = px(img_mask)[:, 0]
    img_base = sb.new_image('hull_baseColor', size, non_color=False)
    img_base.pixels.foreach_set(base.ravel())
    orm = np.zeros_like(base)
    orm[:, 0] = px(img_ao)[:, 0]
    orm[:, 1] = px(img_rough)[:, 0]
    orm[:, 2] = 0.0
    orm[:, 3] = 1.0
    img_orm = sb.new_image('hull_orm', size, non_color=True)
    img_orm.pixels.foreach_set(orm.ravel())

    paths = {}
    for img in (img_base, img_orm, img_normal):
        path = os.path.join(work, img.name + '.png')
        sb.save_png(img, path)
        paths[img.name] = path
    for m in [m for m in bpy.data.materials if m.name.startswith('BAKE_')]:
        bpy.data.materials.remove(m)
    for img in (img_color, img_mask, img_rough, img_ao, img_base, img_orm, img_normal):
        bpy.data.images.remove(img)

    def load(name, non_color):
        img = bpy.data.images.load(paths[name])
        img.name = name
        img.colorspace_settings.name = 'Non-Color' if non_color else 'sRGB'
        return img

    return load('hull_baseColor', False), load('hull_orm', True), load('hull_normal', True)


# ── main ─────────────────────────────────────────────────────────────────────


def main():
    args = parse_args()
    import json
    with open(args.hull, 'r', encoding='utf-8') as f:
        hull = json.load(f)
    if not hull.get('renderOnly'):
        raise SystemExit('[pipeline-test] hull JSON has no renderOnly block (strakes/chineFlat/topsideFlareDeg)')
    hull['stations'] = resample_stations(hull['stations'], PIPELINE_TEST_STATIONS)
    contract = sb.load_contract(args.contract)
    os.makedirs(args.work, exist_ok=True)
    sb.reset_scene(args.threads)

    spec = hull['spec']
    vcg, lcg, L = spec['vcgAboveKeel'], spec['lcgFromTransom'], spec['length']
    deck_body_y = max(s['deckY'] for s in hull['stations']) - vcg

    hhull = None
    if args.hull_kind == 'hero':
        # antifoul folds into M_Gelcoat (livery mask), so hull + 4 part slots + M_Pilot fit the 7-slot contract
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'hull'))
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'parts'))
        import anchors as hull_anchors  # noqa: E402
        import hero_hull as HH  # noqa: E402
        manifest_path = args.parts or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'parts', 'manifest.json')
        with open(manifest_path, 'r', encoding='utf-8') as f:
            hull_manifest = json.load(f)
        hull_A = hull_anchors.Anchors(hull, hull_manifest)
        hhull = HH.HeroHull(hull, hull_A)

    mats = {}
    mats['M_Antifoul'], _ = sb.principled_material(contract, 'M_Antifoul', roughness=0.82)
    mats['M_Gelcoat'], _ = sb.principled_material(contract, 'M_Gelcoat', roughness=0.12, coat=1.0, coat_roughness=0.08)
    mats['M_NonSlip'], _ = sb.principled_material(contract, 'M_NonSlip', roughness=0.72)
    mats['M_Rubber'], _ = sb.principled_material(contract, 'M_Rubber', base=(0.02, 0.02, 0.02, 1), roughness=0.85)
    mats['M_Metal'], _ = sb.principled_material(contract, 'M_Metal', base=(0.62, 0.62, 0.6, 1), roughness=0.28, metallic=1.0)
    mats['M_Perspex'], _ = sb.principled_material(contract, 'M_Perspex', base=(0.9, 0.95, 0.97, 1), roughness=0.03,
                                                  transmission=1.0, ior=1.49, alpha=0.35)
    mats['M_Carbon'], _ = sb.principled_material(contract, 'M_Carbon', base=(0.025, 0.025, 0.028, 1), roughness=0.35, coat=1.0)
    if args.parts:
        mats['M_Cockpit'], _ = sb.principled_material(contract, 'M_Cockpit', roughness=1.0)
    hull_mats = [mats[s] for s in HULL_SLOTS] if hhull is None else [mats['M_Gelcoat'], mats['M_NonSlip']]

    root = sb.make_empty('SB_' + args.name, props={
        'assetKind': args.kind,
        'contractVersion': int(contract['version']),
        'pipelineTest': hhull is None,
        'hullKind': args.hull_kind,
        'hullSource': hull.get('source', hull.get('name', '?')),
    })
    lods = [sb.make_empty(sb.lod_group_name(contract, l), parent=root, props={'lodLevel': l}) for l in range(len(LOD_LOFT))]

    # LOD0 first: the bake must not see the coarser LODs (they would occlude the AO rays)
    if hhull is None:
        hull0 = loft_hull(hull, 0, contract, hull_mats, lods[0])
    else:
        hull0 = HH.link_lod(hhull, 0, contract, hull_mats, lods[0], sb)
    hero = None
    if args.parts:
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'parts'))
        import build_parts as hero_parts  # noqa: E402  (module; build_parts() below is the stand-in)
        hero = hero_parts.HeroParts(hull, args.parts, contract, mats, lods, args)
        hero.build_lod0()
    part_meshes = {} if hero else build_parts(hull, mats)
    parts0 = {}
    for name, mesh in part_meshes.items():
        obj = sb.link_mesh_object(sb.mesh_name(contract, name, 0), mesh, lods[0], 0)
        mesh.name = obj.name
        finish_part_lod0(obj)
        parts0[name] = obj

    if hhull is None:
        base_img, orm_img, normal_img = bake_hull_textures(hull0, args, deck_body_y)
        hull_slots = HULL_SLOTS
    else:
        import hull_textures  # noqa: E402
        base_img, orm_img, normal_img, _ = hull_textures.bake_and_texture(hhull, hull0, args, hull_A)
        hull_slots = ['M_Gelcoat', 'M_NonSlip']
    for slot in hull_slots:
        mat = mats[slot]
        bsdf = mat.node_tree.nodes['Principled BSDF']
        sb.attach_texture_set(mat, bsdf, base_img, orm_img, normal_img, alpha_from_base=True)

    if hero:
        hero.bake_and_texture()

    for lod in range(1, len(LOD_LOFT)):
        if hhull is None:
            loft_hull(hull, lod, contract, hull_mats, lods[lod])
        else:
            HH.link_lod(hhull, lod, contract, hull_mats, lods[lod], sb)
        for name, obj0 in parts0.items():
            ratio = PART_LOD_RATIO[name][lod]
            if ratio is None:
                continue
            sb.decimated_copy(obj0, sb.mesh_name(contract, name, lod), ratio, lods[lod], lod)

    # measured, not assumed: the extras describe the geometry actually exported
    ys, zs, xs = [], [], []
    for v in hull0.data.vertices:
        xs.append(abs(v.co.x))
        ys.append(v.co.z)
        zs.append(-v.co.y)
    sb.set_props(root, {
        'bowZ': round(max(zs), 5),
        'sternZ': round(min(zs), 5),
        'beam': round(2 * max(xs), 5),
        'keelY': round(min(ys), 5),
        'deckY': round(max(ys), 5),
    })

    if hero:
        hero.assemble_lods()
        sb.set_props(root, hero.root_extras())
    if hhull is not None:
        # §T.192: the well opening the runtime caps so the sea never shows inside the hull (hero_hull.water_mask)
        import json  # noqa: E402
        sb.set_props(root, {'waterMask': json.dumps(hhull.water_mask())})

    report = []
    for lod_obj in lods:
        tris = sum(sb.tri_count(c) for c in lod_obj.children)
        report.append(f'{lod_obj.name}={tris}')
    print('[pipeline-test] tris ' + ' '.join(report))
    if args.blend:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.blend), compress=False)
    sb.export_glb(os.path.abspath(args.out))
    print(f'[pipeline-test] exported {args.out}')


if __name__ == '__main__':
    main()
