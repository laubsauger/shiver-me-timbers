"""
Stage 5 (texture, v2): atlas UVs, Cycles CPU data bakes, numpy compositing, and the skin atlas.

M_Pilot (gear atlas, --bake-size, default 2048):
  UVs   Suit and Gloves keep MakeHuman's organic islands (the swept gauntlets, which have none, are
        smart-projected on their own); everything else is smart-projected. Islands get one texel
        density, then a tier (gloves x2.2, the suit's arm islands x1.45 for the cockpit camera,
        cable x0.4).
  Bakes POS, NRM (world), LOOK id, GC (`gc` surface coordinates: vest girth/height/edge, gaiter,
        webbing), AO (Cycles, all pilot geometry occludes), CURV (pointiness, small hard parts only)
  Comp  every pattern is placed in bone-local or surface coordinates, never world axes (the bind
        pose is seated and leaning):
        suit   sand canvas; outer/inner leg and sleeve seams with double stitching; raglan and waist
               seams; zip placket; fabric folds in the height map (inner-elbow and back-of-knee
               compression rings, wrist bunching above the gauntlet, forearm pipe folds, hip
               diagonals, shoulder drape); dark rubber knee pads, elbow reinforcement patches,
               reflective shoulder tape, thigh cargo pockets with flaps, a cross-stitched repair on
               the left shin, duct tape on the right forearm; salt tide lines on legs and sleeves,
               salt crust and grime in fold valleys, abraded knees, sun fade; roughness 0.86-0.97
        vest   orange foam: vertical quilted channels with stitched grooves and pillowed foam, a
               horizontal panel seam, black binding on every edge, reflective tape, a velcro pocket,
               soft fade and salt mottling (no curvature blotches); straps bound
        gaiter charcoal rib knit; harness 50 mm webbing weave with bound edges; tri-glides dark
               anodised; gloves worn leather, padded knuckles, accent band + velcro on the
               gauntlet; boots, goggles, headset, bottle, cable as v1
  Out   T_Pilot_base (RGB albedo, A = accent mask), T_Pilot_orm, T_Pilot_normal (height through a
        Bump node, tangent space baked by Cycles), T_Pilot_detail (256² tiling canvas weave)

M_PilotSkin (2048): MakeHuman head islands packed without rotation, scaled by what shows (face
  x1.25, ears x0.75, neck x0.55, scalp under the hair cap x0.3); CC0 sources re-baked through the
  original UVs.
  Normal  Mindfront NRM + a sculpted height layer (forehead and frown lines, crow's feet, under-eye
          lines, nasolabial folds, the hero's scar) baked together in tangent space
  Albedo  per variant: CC0 skin, painted eye sockets repaired from the mirrored side and pulled to
          the surrounding tone, stubble follicles + beard shadow, sun spots/freckles, scar tissue,
          scalp paint under the hair
  Out     T_PilotSkin_base_<variant> (A = SSS thickness), T_PilotSkin_normal, T_PilotSkin_orm,
          T_PilotSkin_detail (256² tiling pores)
"""
import math
import os

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.kdtree import KDTree

import common as C
import meshops as M
from fit import LOOKS

TIER = {'Gloves': 2.2, 'Goggles': 1.6, 'Headset': 1.5, 'Bottle': 1.2, 'Harness': 1.1, 'Vest': 1.0,
        'VestCollar': 1.0, 'Suit': 0.95, 'Gaiter': 1.2, 'Boots': 0.8, 'DashCable': 0.4}
LOOK_NAMES = {v: k for k, v in LOOKS.items()}


def lin(h):
    return C.hex_lin(h)


def srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, 12.92 * c, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def unit(v):
    return v / max(np.linalg.norm(v), 1e-12)


# ── UV ──────────────────────────────────────────────────────────────────────


def _edit(objs, fn):
    C.select_only(objs, objs[0])
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    fn()
    bpy.ops.object.mode_set(mode='OBJECT')


def uv_islands(ob, layer='Atlas'):
    """face index lists of connected UV islands"""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    uvl = bm.loops.layers.uv[layer]
    bm.faces.ensure_lookup_table()
    parent = list(range(len(bm.faces)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for e in bm.edges:
        if len(e.link_faces) != 2:
            continue
        f0, f1 = e.link_faces
        same = True
        for v in e.verts:
            u0 = next(l[uvl].uv for l in f0.loops if l.vert == v)
            u1 = next(l[uvl].uv for l in f1.loops if l.vert == v)
            if (u0 - u1).length > 1e-6:
                same = False
                break
        if same:
            parent[find(f0.index)] = find(f1.index)
    groups = {}
    for f in bm.faces:
        groups.setdefault(find(f.index), []).append(f.index)
    bm.free()
    return list(groups.values())


def scale_islands(ob, factor_of, layer='Atlas'):
    """scale each UV island about its own UV centre by factor_of(face_indices)"""
    me = ob.data
    uv = me.uv_layers[layer].data
    arr = np.empty(len(uv) * 2)
    uv.foreach_get('uv', arr)
    arr = arr.reshape(-1, 2)
    starts = np.empty(len(me.polygons), dtype=np.int64)
    totals = np.empty(len(me.polygons), dtype=np.int64)
    me.polygons.foreach_get('loop_start', starts)
    me.polygons.foreach_get('loop_total', totals)
    for faces in uv_islands(ob, layer):
        k = factor_of(faces)
        if abs(k - 1) < 1e-3:
            continue
        loops = np.concatenate([np.arange(starts[f], starts[f] + totals[f]) for f in faces])
        c = arr[loops].mean(axis=0)
        arr[loops] = c + (arr[loops] - c) * k
    uv.foreach_set('uv', arr.ravel())


def project_degenerate(ob, layer='Atlas'):
    """faces with no UV area (pieces joined without UVs: the swept gauntlets) get their own smart
    projection"""
    me = ob.data
    uv = me.uv_layers[layer].data
    bad = []
    for p in me.polygons:
        pts = [uv[p.loop_start + i].uv for i in range(p.loop_total)]
        area = abs(sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1] for i in range(len(pts))))
        bad.append(area < 1e-12)
    if not any(bad):
        return 0
    C.select_only([ob])
    bpy.ops.object.mode_set(mode='EDIT')
    bm = bmesh.from_edit_mesh(me)
    bm.faces.ensure_lookup_table()
    for f in bm.faces:
        f.select_set(bool(bad[f.index]))
    bmesh.update_edit_mesh(me)
    bpy.ops.uv.smart_project(angle_limit=math.radians(58), island_margin=0.002)
    bpy.ops.object.mode_set(mode='OBJECT')
    return int(sum(bad))


def _loop_vertex_tables(ob):
    me = ob.data
    loops = np.empty(len(me.loops), dtype=np.int64)
    me.loops.foreach_get('vertex_index', loops)
    starts = np.empty(len(me.polygons), dtype=np.int64)
    totals = np.empty(len(me.polygons), dtype=np.int64)
    me.polygons.foreach_get('loop_start', starts)
    me.polygons.foreach_get('loop_total', totals)
    return loops, starts, totals


def atlas_uvs(objs, margin_px, size):
    bpy.context.scene.tool_settings.use_uv_select_sync = True
    for ob in objs:
        me = ob.data
        src = me.uv_layers[0] if len(me.uv_layers) and ob.name in ('Suit', 'Gloves') else None
        uv = me.uv_layers.new(name='Atlas')
        if src is not None:
            arr = np.empty(len(src.data) * 2, dtype=np.float32)
            src.data.foreach_get('uv', arr)
            uv.data.foreach_set('uv', arr)
        me.uv_layers.active = uv
        for other in [u for u in me.uv_layers if u.name != 'Atlas']:
            me.uv_layers.remove(other)
        if src is None:
            _edit([ob], lambda: bpy.ops.uv.smart_project(angle_limit=math.radians(58), island_margin=0.002))
        else:
            project_degenerate(ob)
    _edit(objs, lambda: bpy.ops.uv.average_islands_scale())
    for ob in objs:
        m = TIER.get(ob.name, 1.0)
        uv = ob.data.uv_layers['Atlas'].data
        arr = np.empty(len(uv) * 2)
        uv.foreach_get('uv', arr)
        uv.foreach_set('uv', arr * m)
    # the sleeves fill the cockpit camera: the suit's arm islands get 1.45x the suit's density
    suit = next((o for o in objs if o.name == 'Suit'), None)
    if suit is not None:
        arms = [f'{b}_{s}' for s in ('l', 'r') for b in ('upperarm', 'lowerarm', 'lowerarm_twist')]
        w_arm = C.group_weights(suit, arms)
        loops, starts, totals = _loop_vertex_tables(suit)

        def arm_factor(faces):
            vs = np.concatenate([loops[starts[f]:starts[f] + totals[f]] for f in faces])
            return 1.45 if w_arm[vs].mean() > 0.5 else 1.0

        scale_islands(suit, arm_factor)
    _edit(objs, lambda: bpy.ops.uv.pack_islands(rotate=True, rotate_method='CARDINAL', margin_method='FRACTION',
                                                margin=margin_px / size, shape_method='CONCAVE', scale=True))
    snap_uvs(objs)
    dens = {}
    for ob in objs:
        me = ob.data
        uvd = me.uv_layers['Atlas'].data
        a3 = sum(p.area for p in me.polygons)
        auv = 0.0
        for p in me.polygons:
            pts = [uvd[p.loop_start + i].uv for i in range(p.loop_total)]
            auv += abs(sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1] for i in range(len(pts)))) / 2
        dens[ob.name] = round(size * math.sqrt(auv / max(a3, 1e-9)), 1)
    return dens


def snap_uvs(objs, step=1.0 / 65536):
    """the island packer leaves ~1e-7 float noise between runs, which reorders exported vertices;
    snapping to a 1/65536 grid (sub-texel at 4096²) makes the layout reproducible"""
    for ob in objs:
        uv = ob.data.uv_layers['Atlas'].data
        arr = np.empty(len(uv) * 2, dtype=np.float64)
        uv.foreach_get('uv', arr)
        uv.foreach_set('uv', (np.round(arr / step) * step).astype(np.float32))


# ── bakes ───────────────────────────────────────────────────────────────────


def float_image(name, size):
    img = bpy.data.images.new(name, size, size, alpha=True, float_buffer=True)
    img.colorspace_settings.name = 'Non-Color'
    return img


def pixels(img):
    w, h = img.size
    return np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)


def bake_material(mat, img, build):
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = img
    uvn = nt.nodes.new('ShaderNodeUVMap')
    uvn.uv_map = 'Atlas'
    nt.links.new(uvn.outputs['UV'], tex.inputs['Vector'])
    shader = build(nt)
    nt.links.new(shader, out.inputs['Surface'])
    nt.nodes.active = tex


def emission_of(nt, sock):
    em = nt.nodes.new('ShaderNodeEmission')
    em.inputs['Strength'].default_value = 1.0
    nt.links.new(sock, em.inputs['Color'])
    return em.outputs['Emission']


def do_bake(objs, kind, samples=1, margin=8):
    sc = bpy.context.scene
    sc.cycles.samples = samples
    sc.render.bake.margin = margin
    sc.render.bake.margin_type = 'EXTEND'
    sc.render.bake.use_clear = True
    C.select_only(list(objs), objs[0])
    if kind == 'NORMAL':
        bpy.ops.object.bake(type='NORMAL', normal_space='TANGENT', uv_layer='Atlas', margin=margin)
    else:
        bpy.ops.object.bake(type=kind, uv_layer='Atlas', margin=margin)


def data_passes(objs, mat, size, ao_samples, hide_for_ao):
    out = {}
    img = float_image('bake_tmp', size)

    def geo(field):
        def build(nt):
            g = nt.nodes.new('ShaderNodeNewGeometry')
            return emission_of(nt, g.outputs[field])
        return build

    def look(nt):
        a = nt.nodes.new('ShaderNodeAttribute')
        a.attribute_type = 'GEOMETRY'
        a.attribute_name = 'look'
        mul = nt.nodes.new('ShaderNodeMath')
        mul.operation = 'DIVIDE'
        mul.inputs[1].default_value = 64.0
        nt.links.new(a.outputs['Fac'], mul.inputs[0])
        return emission_of(nt, mul.outputs[0])

    def gc(nt):
        a = nt.nodes.new('ShaderNodeAttribute')
        a.attribute_type = 'GEOMETRY'
        a.attribute_name = 'gc'
        return emission_of(nt, a.outputs['Vector'])

    for name, build in (('POS', geo('Position')), ('NRM', geo('Normal')), ('LOOK', look), ('GC', gc)):
        bake_material(mat, img, build)
        do_bake(objs, 'EMIT')
        out[name] = pixels(img)[..., :3].copy()

    bake_material(mat, img, geo('Pointiness'))
    do_bake(objs, 'EMIT')
    out['CURV'] = pixels(img)[..., 0].copy()
    bake_material(mat, img, lambda nt: nt.nodes.new('ShaderNodeBsdfDiffuse').outputs['BSDF'])
    for o in hide_for_ao:
        o.hide_render = True
    bpy.context.scene.world.light_settings.distance = 0.12
    do_bake(objs, 'AO', samples=ao_samples)
    for o in hide_for_ao:
        o.hide_render = False
    out['AO'] = pixels(img)[..., 0].copy()
    out['COVER'] = pixels(img)[..., 3].copy()
    bpy.data.images.remove(img)
    return out


# ── noise and frames (per pixel) ────────────────────────────────────────────


def fbm3(p, scale, octaves=3, seed=0):
    flat = p.reshape(-1, 3)
    return M.fbm(flat, scale, octaves, seed).reshape(p.shape[:-1])


def bone_frame(rig, name):
    b = rig.data.bones[name]
    return np.array(b.head_local), np.array(b.tail_local)


def axial(P, h, t):
    ax = t - h
    L = np.linalg.norm(ax)
    ax = ax / L
    s = (P - h) @ ax
    rv = P - h - s[..., None] * ax
    return s / L, np.linalg.norm(rv, axis=-1), rv, ax


class Limb:
    """cylindrical coordinates about a bone (head -> child's head) in the seated rest: along (m),
    radius (m), angle from a reference side (rad)"""

    def __init__(self, rig, bone, child, ref):
        self.h, self.t = bone_frame(rig, bone)[0], bone_frame(rig, child)[0]
        self.L = np.linalg.norm(self.t - self.h)
        self.ax = (self.t - self.h) / self.L
        ref = np.asarray(ref, dtype=np.float64)
        self.e1 = unit(ref - (ref @ self.ax) * self.ax)
        self.e2 = np.cross(self.ax, self.e1)

    def coords(self, P):
        d = P - self.h
        s = d @ self.ax
        x = d @ self.e1
        y = d @ self.e2
        return s, np.hypot(x, y), np.arctan2(y, x)


def bend_dir(rig, upper, lower, child):
    """inner side of a joint in the seated rest: from the upper bone axis toward the lower bone's end"""
    h, _ = bone_frame(rig, upper)
    j, _ = bone_frame(rig, lower)
    e, _ = bone_frame(rig, child)
    ax = unit(j - h)
    v = e - j
    v = v - (v @ ax) * ax
    return unit(v) if np.linalg.norm(v) > 1e-4 else np.array([0.0, -1.0, 0.0])


def ridges(phase, sharp=2.5):
    """crisp fold ridges: 1 at the crest, 0 in the valleys"""
    return (1 - np.abs(np.sin(phase * math.pi))) ** sharp


def stitch_line(dist, along, offset=0.0025, pitch=0.004, width=0.0006):
    """two parallel dashed stitch lines either side of a seam (dist = signed distance to the seam, m)"""
    dash = np.sin(along * 2 * math.pi / pitch) > 0.1
    return np.exp(-((np.abs(dist) - offset) / width) ** 2) * dash


def rect_patch(u, v, u0, u1, v0, v1, corner=0.008):
    """signed distance (m, negative inside) to a rounded rectangle in surface coordinates"""
    cu, cv = (u0 + u1) / 2, (v0 + v1) / 2
    hu, hv = (u1 - u0) / 2 - corner, (v1 - v0) / 2 - corner
    qu, qv = np.abs(u - cu) - hu, np.abs(v - cv) - hv
    return np.hypot(np.maximum(qu, 0), np.maximum(qv, 0)) + np.minimum(np.maximum(qu, qv), 0) - corner


def arc(r, ang, ref=0.0):
    return r * np.angle(np.exp(1j * (ang - ref)))


# ── gear compositor ─────────────────────────────────────────────────────────


def composite_suit(P, Nw, look, ao, n1, n2, n3, rig, col, rough, height):
    H, W = look.shape
    suit = (look == LOOKS['suit']) | (look == LOOKS['collar'])
    Z = np.array([0.0, 0.0, 1.0])
    c = lin('#CDBFA3') * (0.93 + 0.1 * n1[..., None] + 0.05 * n2[..., None])
    sun = smooth(0.2, 0.9, Nw[..., 2]) * 0.1
    c = c * (1 - sun[..., None]) + lin('#E3DACB') * sun[..., None]
    h_s = np.zeros((H, W))
    seam_dark = np.zeros((H, W))
    stitch = np.zeros((H, W))
    valley = np.zeros((H, W))
    rgh = 0.88 + 0.06 * n2
    for s, sx in (('l', 1), ('r', -1)):
        lat = np.array([sx, 0.0, 0.0])
        # legs: outer + inner seams
        for bone, child in ((f'thigh_{s}', f'calf_{s}'), (f'calf_{s}', f'foot_{s}')):
            lb = Limb(rig, bone, child, lat)
            sl, rl, al = lb.coords(P)
            on = (sl > -0.06) & (sl < lb.L + 0.04) & (rl < 0.14)
            for seam_ang in (0.0, math.pi):
                dd = arc(rl, al, seam_ang)
                g = np.exp(-(dd / 0.0012) ** 2) * on
                seam_dark += g
                h_s += (0.35 * np.exp(-((dd - 0.004) / 0.003) ** 2) - 0.25 * g) * on
                stitch += stitch_line(dd, sl) * on
        # knee: compression rings behind, pad in front
        kb = bend_dir(rig, f'thigh_{s}', f'calf_{s}', f'foot_{s}')
        lk = Limb(rig, f'calf_{s}', f'foot_{s}', kb)
        sk, rk, ak = lk.coords(P)
        knee_g = np.exp(-(sk / 0.085) ** 2) * (rk < 0.14)
        inner = smooth(-0.2, 0.8, np.cos(ak))
        phase = sk / 0.03 + 0.25 * n2 + 0.08 * np.sin(ak * 3)
        h_s += 3.0 * ridges(phase, 3.0) * knee_g * (0.45 + 0.55 * inner) * (0.6 + 0.4 * n1)
        valley += knee_g * inner * (1 - ridges(phase))
        pad_d = np.hypot((sk + 0.01) / 0.075, arc(rk, ak, math.pi) / 0.065)
        pad = (pad_d < 1.0) & (rk < 0.14) & suit
        c[pad] = lin('#34332F') * (0.85 + 0.2 * n3[pad, None]) + lin('#8B8475') * 0.12 * smooth(0.2, 0.9, n2[pad, None])
        rgh[pad] = 0.62 + 0.1 * n3[pad]
        h_s[pad] += 1.2 + 0.25 * ridges(sk[pad] / 0.03, 4.0)
        pad_edge = np.exp(-((pad_d - 1.0) / 0.05) ** 2) * (rk < 0.14)
        stitch += pad_edge * (np.sin(arc(rk, ak) * 2 * math.pi / 0.004 + sk * 1500) > 0.1)
        # hip diagonals radiating from the crotch
        lt = Limb(rig, f'thigh_{s}', f'calf_{s}', -kb)
        st, rt, at = lt.coords(P)
        hip_g = np.exp(-(st / 0.16) ** 2) * (rt < 0.16)
        h_s += 1.8 * ridges((st * 0.72 + arc(rt, at) * 0.7 * sx) / 0.05 + 0.3 * n2, 3.0) * hip_g * smooth(-0.3, 0.6, np.cos(at))
        # cargo pocket with a flap on the outer thigh
        ls = Limb(rig, f'thigh_{s}', f'calf_{s}', lat)
        s2, r2, a2 = ls.coords(P)
        pu, pv = arc(r2, a2), s2
        pk_d = rect_patch(pu, pv, -0.075, 0.075, 0.13, 0.31)
        on2 = r2 < 0.16
        pm = (pk_d < 0) & on2 & suit
        c[pm] *= 0.96
        h_s[pm] += 0.8
        stitch += np.exp(-((pk_d + 0.003) / 0.0008) ** 2) * on2 * (np.sin((pu + pv) * 2 * math.pi / 0.004) > 0.1)
        flap = (rect_patch(pu, pv, -0.08, 0.08, 0.12, 0.175) < 0) & on2 & suit
        h_s[flap] += 1.3
        seam_dark += np.exp(-((pv - 0.175) / 0.0025) ** 2) * (np.abs(pu) < 0.08) * on2
        # arms: sleeve seam underneath, raglan, elbow + wrist folds, pipe folds, patches
        eb = bend_dir(rig, f'upperarm_{s}', f'lowerarm_{s}', f'hand_{s}')
        for bone, child in ((f'upperarm_{s}', f'lowerarm_{s}'), (f'lowerarm_{s}', f'hand_{s}')):
            la = Limb(rig, bone, child, -Z)
            sa, ra, aa = la.coords(P)
            on = (sa > -0.04) & (sa < la.L + 0.02) & (ra < 0.1)
            dd = arc(ra, aa)
            g = np.exp(-(dd / 0.0012) ** 2) * on
            seam_dark += g
            h_s += (0.3 * np.exp(-((dd - 0.0035) / 0.0028) ** 2) - 0.22 * g) * on
            stitch += stitch_line(dd, sa) * on
        lu = Limb(rig, f'upperarm_{s}', f'lowerarm_{s}', eb)
        su, ru, au = lu.coords(P)
        on_u = ru < 0.1
        seam_dark += np.exp(-((su - 0.02) / 0.0015) ** 2) * on_u
        stitch += stitch_line(su - 0.02, arc(ru, au)) * on_u
        h_s += 1.5 * ridges(su / 0.04 + 0.5 * n1, 2.0) * np.exp(-((su - 0.06) / 0.07) ** 2) * on_u * smooth(0.0, 1.0, -np.cos(au))
        lf = Limb(rig, f'lowerarm_{s}', f'hand_{s}', eb)
        sf, rf, af = lf.coords(P)
        on_f = rf < 0.1
        elbow_g = np.exp(-(sf / 0.12) ** 2) * on_f
        inner_e = smooth(-0.3, 0.9, np.cos(af))
        ph = sf / 0.026 + 0.3 * n2 + 0.1 * np.sin(af * 2)
        h_s += 3.2 * ridges(ph, 3.0) * elbow_g * (0.35 + 0.65 * inner_e) * (0.6 + 0.4 * n1)
        valley += elbow_g * inner_e * (1 - ridges(ph))
        # the sleeve bunches where it is pushed up the forearm above the gauntlet (which covers the
        # last ~9 cm), and hangs in long twisted pipe folds between elbow and bunching
        wrist_g = smooth(lf.L - 0.22, lf.L - 0.15, sf) * smooth(lf.L - 0.05, lf.L - 0.08, sf) * on_f
        ph_w = sf / 0.017 + 0.35 * n2 + 0.15 * np.sin(af * 3 + sf * 40)
        h_s += 3.0 * ridges(ph_w, 2.5) * wrist_g
        valley += wrist_g * (1 - ridges(ph_w, 2.0))
        pipe = (sf * math.cos(0.6) + arc(rf, af) * math.sin(0.6)) / 0.045 + 0.4 * n1
        h_s += 2.2 * ridges(pipe, 2.5) * on_f * smooth(0.02, 0.1, sf) * smooth(lf.L - 0.06, lf.L - 0.1, sf)
        la_up = Limb(rig, f'upperarm_{s}', f'lowerarm_{s}', eb)
        s_up, r_up, a_up = la_up.coords(P)
        drape = (s_up * math.cos(0.9) + arc(r_up, a_up) * math.sin(0.9)) / 0.06 + 0.5 * n1
        h_s += 1.6 * ridges(drape, 2.5) * (r_up < 0.1) * smooth(0.04, 0.12, s_up) * smooth(la_up.L + 0.02, la_up.L - 0.06, s_up)
        e_d = np.hypot(sf / 0.07, arc(rf, af, math.pi) / 0.05)
        ep = (e_d < 1.0) & on_f & suit
        c[ep] = lin('#B5A382') * (0.93 + 0.1 * n2[ep, None])
        h_s[ep] += 0.35
        stitch += np.exp(-((e_d - 1.0) / 0.045) ** 2) * on_f * (np.sin(arc(rf, af) * 2 * math.pi / 0.004 + sf * 1500) > 0.1)
        l3 = Limb(rig, f'upperarm_{s}', f'lowerarm_{s}', lat)
        s3, r3, a3 = l3.coords(P)
        rm = (rect_patch(arc(r3, a3), s3, -0.04, 0.04, 0.05, 0.1, 0.003) < 0) & (r3 < 0.1) & suit
        c[rm] = lin('#B7BBB8') * (0.8 + 0.25 * n3[rm, None])
        rgh[rm] = 0.36 + 0.12 * n3[rm]
        h_s[rm] += 0.3
    # waist seam and zip placket (torso axis, front = away from the backrest)
    lw = Limb(rig, 'spine_01', 'spine_02', np.array([0.0, -1.0, 0.0]))
    sw, rw, aw = lw.coords(P)
    seam_dark += np.exp(-((sw - 0.01) / 0.0018) ** 2) * (rw < 0.22)
    stitch += stitch_line(sw - 0.01, arc(rw, aw)) * (rw < 0.22)
    lp = Limb(rig, 'pelvis', 'spine_01', np.array([0.0, -1.0, 0.0]))
    sp_, rp_, ap_ = lp.coords(P)
    zd = arc(rp_, ap_)
    zip_ = (np.abs(zd) < 0.006) & (sp_ > -0.12) & (rp_ < 0.25) & suit
    placket = (np.abs(zd) < 0.022) & (sp_ > -0.13) & (rp_ < 0.25) & suit
    h_s[placket] += 0.5
    # cross-stitched repair on the left shin (concept 11)
    lr = Limb(rig, 'calf_l', 'foot_l', np.array([0.0, -1.0, 0.0]))
    sr, rr_, ar = lr.coords(P)
    tu = arc(rr_, ar)
    in_r = (sr > 0.14) & (sr < 0.24) & (rr_ < 0.12) & suit
    tear = in_r & (np.abs(tu - 0.004 * np.sin(sr * 160)) < 0.0012)
    cross = in_r & (np.abs(tu) < 0.007) & (np.abs(((sr * 250) % 1.0) - 0.5) < 0.12)
    # duct tape: overlapping wraps on the right forearm
    h, t = bone_frame(rig, 'lowerarm_r')[0], bone_frame(rig, 'hand_r')[0]
    tt, r, rv, _ax = axial(P, h, t)
    ang = np.arctan2(rv[..., 2], rv[..., 1])
    tape = np.zeros((H, W), dtype=bool)
    for (t0, tilt) in ((0.3, 0.02), (0.37, -0.03), (0.44, 0.015)):
        tape |= (np.abs(tt - t0 - tilt * np.sin(ang)) < 0.035) & (r < 0.09)
    tape &= suit
    seam_dark = np.clip(seam_dark, 0, 1)
    stitch = np.clip(stitch, 0, 1)
    c = c * (1 - 0.3 * seam_dark[..., None]) * (1 - 0.35 * stitch[..., None])
    h_s -= 0.2 * stitch
    c[zip_] = lin('#3A3934')
    h_s[zip_] += 0.25 * (np.sin(sp_[zip_] * 2 * math.pi / 0.003) > 0)
    rgh[zip_] = 0.45
    c[tear | cross] = lin('#4A4337')
    h_s[tear | cross] -= 0.3
    c[tape] = lin('#8F928D') * (0.9 + 0.15 * n3[tape, None])
    rgh[tape] = 0.42 + 0.1 * n3[tape]
    h_s[tape] += 0.5 + 0.2 * n3[tape]
    # salt tide lines on lower legs and sleeves, crust + grime in fold valleys, abraded knees
    low = np.zeros((H, W))
    for s in ('l', 'r'):
        lc = Limb(rig, f'calf_{s}', f'foot_{s}', Z)
        scl, rcl, _a = lc.coords(P)
        low = np.maximum(low, smooth(0.1, 0.4, scl / lc.L) * (rcl < 0.12))
        lfa = Limb(rig, f'lowerarm_{s}', f'hand_{s}', Z)
        sfa, rfa, _a = lfa.coords(P)
        low = np.maximum(low, 0.7 * smooth(0.4, 0.9, sfa / lfa.L) * (rfa < 0.1))
    tide = np.exp(-((fbm3(P, 9.0, 3, 17) - 0.1) / 0.03) ** 2) + 0.7 * np.exp(-((fbm3(P, 14.0, 3, 18) + 0.15) / 0.02) ** 2)
    valley = np.clip(valley, 0, 1)
    salt = np.clip(tide * (0.25 + 0.75 * low) + 0.5 * valley * smooth(0.0, 0.5, n2) + 0.2 * smooth(0.3, 0.6, fbm3(P, 4.0, 3, 19)), 0, 1) * suit
    grime = np.clip(0.55 * valley + 0.35 * (1 - ao) + 0.25 * low * smooth(0.0, 0.6, n1), 0, 1) * suit
    c = c * (1 - 0.3 * grime[..., None]) * (np.array([1.0, 0.97, 0.92])[None, None, :] ** grime[..., None])
    c = c * (1 - 0.4 * salt[..., None]) + lin('#EEEBE3') * 0.4 * salt[..., None]
    for s in ('l', 'r'):
        kn = bone_frame(rig, f'calf_{s}')[0]
        wear = np.exp(-(np.linalg.norm(P - kn, axis=-1) / 0.07) ** 2) * suit * (0.5 + 0.5 * n2)
        c = c * (1 - 0.12 * wear[..., None]) + lin('#E0D6C2') * 0.12 * wear[..., None]
    rgh = rgh + 0.05 * salt - 0.03 * grime
    h_s += 0.1 * n3 + 0.12 * fbm3(P, 60.0, 2, 23) + 0.12 * salt * smooth(0.0, 0.5, fbm3(P, 300.0, 1, 29))
    height[suit] = h_s[suit]
    col[suit] = c[suit]
    rough[suit] = rgh[suit]


def composite_gear(D, rig, cfg):
    P, Nw = D['POS'].astype(np.float64), D['NRM'].astype(np.float64)
    look = np.rint(D['LOOK'][..., 0] * 64).astype(int)
    G = D['GC'].astype(np.float64)
    ao = np.clip(D['AO'], 0, 1)
    cov = D['COVER'] > 0.5
    curv = D['CURV']
    cv = np.clip((curv - np.median(curv[cov])) * 9, -1, 1) if cov.any() else np.zeros_like(curv)
    H, W = look.shape
    col = np.zeros((H, W, 3))
    rough = np.full((H, W), 0.8)
    metal = np.zeros((H, W))
    height = np.zeros((H, W))
    accent = np.zeros((H, W))
    n1 = fbm3(P, 7.0, 3, 1)
    n2 = fbm3(P, 31.0, 3, 2)
    n3 = fbm3(P, 110.0, 2, 3)
    is_ = lambda name: look == LOOKS[name]  # noqa: E731
    Z = np.array([0.0, 0.0, 1.0])
    u, v, e = G[..., 0], G[..., 1], G[..., 2]

    composite_suit(P, Nw, look, ao, n1, n2, n3, rig, col, rough, height)

    # ── gaiter: charcoal rib knit ──
    gt = is_('gaiter')
    rib = 0.5 + 0.5 * np.sin(u * 2 * math.pi / 0.0042)
    col[gt] = (lin('#3B3C3A') * (0.85 + 0.25 * rib[..., None] + 0.08 * n2[..., None]))[gt]
    height[gt] = (0.45 * rib + 0.3 * n3 - 0.4 * np.exp(-((v - 0.035) / 0.004) ** 2))[gt]
    rough[gt] = 0.93
    salt_g = smooth(0.012, 0.0, v) * smooth(0.0, 0.6, n2)
    col[gt] = col[gt] * (1 - 0.3 * salt_g[gt, None]) + lin('#CFCBC2') * 0.3 * salt_g[gt, None]

    # ── gloves: worn leather, padded knuckles, gauntlet band + velcro ──
    g = is_('glove') | is_('glove_pad')
    gc_ = lin('#34322E') * (0.88 + 0.22 * n2[..., None])
    palm_wear = np.zeros((H, W))
    for s in ('l', 'r'):
        hh = bone_frame(rig, f'hand_{s}')[0]
        palm_wear += (np.linalg.norm(P - hh, axis=-1) < 0.13) * smooth(0.3, 0.9, n2 * 0.5 + 0.5) * 0.35
    gc_ = gc_ * (1 - 0.3 * palm_wear[..., None]) + lin('#6A655B') * 0.3 * palm_wear[..., None]
    gc_ = gc_ + (smooth(0.2, 0.7, cv) * (0.5 + 0.5 * n3))[..., None] * 0.05
    col[g] = gc_[g]
    rough[g] = (0.52 + 0.12 * n3 + 0.1 * palm_wear)[g]
    pad_ = is_('glove_pad')
    col[pad_] = lin('#1E1E1D') * (0.9 + 0.2 * n3[pad_, None])
    rough[pad_] = 0.7
    height[g] += (0.1 * fbm3(P, 180.0, 2, 29) + 0.04 * fbm3(P, 500.0, 1, 31))[g]  # fine grain: the detail normal carries the rest
    height[pad_] += 0.7
    # the glove's fingers are one inflated surface: a groove where two fingers' phalanges are about
    # equally near separates them, stitched seams run along the finger sides
    for s in ('l', 'r'):
        near = [np.full((H, W), 9.0), np.full((H, W), 9.0)]
        for f in ('index', 'middle', 'ring', 'pinky'):
            d = np.full((H, W), 9.0)
            for i in (1, 2, 3):
                hh, tt_ = bone_frame(rig, f'{f}_0{i}_{s}')
                ab = tt_ - hh
                tp = np.clip(((P - hh) @ ab) / max(ab @ ab, 1e-9), 0, 1)
                d = np.minimum(d, np.linalg.norm(P - (hh + tp[..., None] * ab), axis=-1))
            n0 = np.minimum(near[0], d)
            near[1] = np.minimum(np.maximum(near[0], d), near[1])
            near[0] = n0
        hand_d = np.linalg.norm(P - bone_frame(rig, f'middle_01_{s}')[0], axis=-1)
        fing = g & (near[0] < 0.016) & (hand_d < 0.12)
        groove = np.exp(-((near[1] - near[0]) / 0.0018) ** 2) * fing
        height[g] -= 0.5 * groove[g]
        col[g] = col[g] * (1 - 0.25 * groove[g, None])
    for s in ('l', 'r'):
        lg = Limb(rig, f'lowerarm_{s}', f'hand_{s}', Z)
        sg, rg, ag = lg.coords(P)
        back = lg.L - sg  # distance from the wrist up the forearm
        on = g & (rg < 0.1)
        band = on & (np.abs(back - 0.062) < 0.009)
        col[band] = lin('#E4572E') * (0.82 + 0.15 * n2[band, None])
        accent[band] = 1.0
        rough[band] = 0.6
        height[band] += 0.25
        velcro = on & (np.abs(back - 0.04) < 0.008)
        col[velcro] = lin('#232322')
        rough[velcro] = 0.92
        height[velcro] += 0.5 + 0.2 * n3[velcro]
        col[on & (np.abs(back - 0.086) < 0.0015)] *= 0.6
        st_g = on & (np.abs(np.abs(back - 0.062) - 0.011) < 0.0007) & (np.sin(arc(rg, ag) * 2 * math.pi / 0.004) > 0.1)
        col[st_g] = lin('#8A7F6B')

    # ── boots ──
    b = is_('boot')
    bc = lin('#2C2D2C') * (0.9 + 0.15 * n2[..., None])
    crust = np.zeros((H, W))
    for s in ('l', 'r'):
        fh = bone_frame(rig, f'foot_{s}')[0]
        crust = np.maximum(crust, smooth(0.09, 0.0, np.linalg.norm(P - fh, axis=-1) - 0.05))
    crust *= smooth(0.1, 0.6, fbm3(P, 12.0, 3, 37))
    bc = bc * (1 - 0.35 * crust[..., None]) + lin('#D8D4C8') * 0.35 * crust[..., None] + smooth(0.3, 0.8, cv)[..., None] * 0.04
    col[b] = bc[b]
    rough[b] = 0.72 + 0.1 * n3[b]
    height[b] += 0.3 * fbm3(P, 90.0, 2, 41)[b]
    sole = is_('boot_sole')
    col[sole] = lin('#6D675C') * (0.85 + 0.2 * n2[sole, None])
    rough[sole] = 0.85
    height[sole] += 0.7 * (np.sin(P[..., 1] * 2 * math.pi / 0.011) > 0.3)[sole]

    # ── vest: quilted foam panels, bound edges ──
    vp = is_('vest')
    vcl = is_('vest_collar')
    vt = is_('vest_trim')
    fade = smooth(0.0, 0.9, Nw[..., 2]) * 0.2 + 0.07 * smooth(0.2, 0.8, n1)
    vcol = lin('#E4572E') * (0.9 + 0.1 * n2[..., None])
    vcol = vcol * (1 - fade[..., None]) + lin('#E9B49A') * fade[..., None]
    mott = smooth(0.15, 0.7, fbm3(P, 6.0, 3, 43)) * 0.35 + 0.15 * smooth(0.3, 0.8, fbm3(P, 22.0, 2, 44))
    vcol = vcol * (1 - 0.3 * mott[..., None]) + lin('#EFE6DA') * 0.3 * mott[..., None]
    ch = (u % 0.068) / 0.068
    groove = np.exp(-((ch - 0.5) / 0.035) ** 2)
    pillow = 1 - (2 * ch - 1) ** 2
    hseam = np.exp(-((v - 0.115) / 0.003) ** 2)
    height[vp] += (1.1 * pillow - 1.6 * groove - 0.9 * hseam)[vp]
    vcol = vcol * (1 - 0.22 * groove[..., None]) * (1 - 0.15 * hseam[..., None])
    st_v = (np.abs(np.abs(ch - 0.5) - 0.045) < 0.012) & (np.sin(v * 2 * math.pi / 0.005) > 0.2)
    vcol[st_v] *= 0.7
    col[vp | vcl] = vcol[vp | vcl]
    accent[vp | vcl] = 1.0
    rough[vp | vcl] = (0.66 + 0.1 * n2 + 0.08 * mott)[vp | vcl]
    height[vp | vcl] += (0.35 * fbm3(P, 70.0, 2, 47) + 0.2 * fbm3(P, 400.0, 1, 48))[vp | vcl]
    bind = vp & (e < 0.011)
    col[bind] = lin('#232322') * (0.9 + 0.2 * n2[bind, None])
    accent[bind] = 0.0
    rough[bind] = 0.58
    height[bind] += 0.6
    col[vp & (np.abs(e - 0.013) < 0.0008) & (np.sin((u + v) * 2 * math.pi / 0.005) > 0.1)] *= 0.55
    umax = float(np.percentile(u[vp], 99.5)) if vp.any() else 1.0
    tape_v = np.zeros((H, W), dtype=bool)
    for u0 in (0.07, umax - 0.17):
        tape_v |= rect_patch(u, v, u0, u0 + 0.1, 0.19, 0.232, 0.002) < 0
    for vv in (0.06, 0.15):
        tape_v |= rect_patch(u, v, umax / 2 - 0.16, umax / 2 + 0.16, vv, vv + 0.028, 0.002) < 0
    tape_v &= vp & ~bind
    col[tape_v] = lin('#C9CFD0') * (0.8 + 0.25 * n3[tape_v, None])
    accent[tape_v] = 0.0
    rough[tape_v] = 0.33 + 0.15 * n3[tape_v]
    height[tape_v] += 0.4
    pk = rect_patch(u, v, umax - 0.2, umax - 0.07, 0.035, 0.14)
    height[vp & (pk < 0)] += 0.9
    flap_v = vp & (rect_patch(u, v, umax - 0.205, umax - 0.065, 0.1, 0.145) < 0)
    col[flap_v] *= 0.92
    height[flap_v] += 1.3
    col[vp & (np.abs(pk) < 0.0012)] *= 0.6
    col[vt] = lin('#232322') * (0.9 + 0.2 * n2[vt, None])
    rough[vt] = 0.6
    ring_c = vcl & ((u % 0.05) / 0.05 < 0.08)
    height[ring_c] -= 0.8
    col[ring_c] *= 0.8

    # ── goggles, headset, bottle ──
    fr = is_('goggle_frame')
    col[fr] = lin('#8E7A52') * (0.8 + 0.3 * n2[fr, None]) + smooth(0.2, 0.8, cv)[fr, None] * 0.15
    patina = smooth(0.7, 0.3, ao) * 0.6
    col[fr] = col[fr] * (1 - patina[fr, None]) + lin('#3E3A2C') * patina[fr, None]
    metal[fr] = 1.0
    rough[fr] = 0.32 + 0.15 * n3[fr]
    gk = is_('goggle_gasket')
    col[gk] = lin('#2A2019')
    rough[gk] = 0.6
    st = is_('goggle_strap')
    col[st] = lin('#5C3C25') * (0.8 + 0.3 * n2[st, None]) + smooth(0.3, 0.8, cv)[st, None] * 0.08
    rough[st] = 0.58 + 0.1 * n3[st]
    height[st] += 0.4 * fbm3(P, 200.0, 2, 53)[st]
    hs = is_('headset_shell')
    col[hs] = lin('#454A3C') * (0.9 + 0.12 * n2[hs, None]) + smooth(0.2, 0.7, cv)[hs, None] * 0.1
    rough[hs] = 0.45 + 0.15 * n3[hs]
    height[hs] += 0.2 * fbm3(P, 150.0, 2, 59)[hs]
    hc = is_('headset_cushion')
    col[hc] = lin('#1C1C1B')
    rough[hc] = 0.38
    height[hc] += 0.5 * fbm3(P, 90.0, 2, 61)[hc]
    hb = is_('headband')
    col[hb] = lin('#55595C')
    metal[hb] = 1.0
    rough[hb] = 0.35
    mf = is_('mic_foam')
    col[mf] = lin('#151515')
    rough[mf] = 0.95
    height[mf] += 0.6 * fbm3(P, 400.0, 1, 67)[mf]
    bt = is_('bottle')
    col[bt] = lin('#A2A6A8')
    metal[bt] = 1.0
    rough[bt] = 0.35
    if bt.any():
        yb = bt & (np.abs(P[..., 2] - np.median(P[bt][:, 2])) < 0.04)
        col[yb] = lin('#E8B420') * (0.85 + 0.15 * n2[yb, None])
        metal[yb] = 0.0
        rough[yb] = 0.5
    bv = is_('bottle_valve')
    col[bv] = lin('#2A2B2D')
    metal[bv] = 1.0
    rough[bv] = 0.4
    sb = is_('strap_band')
    col[sb] = lin('#696B68') * (0.85 + 0.2 * n2[sb, None])
    rough[sb] = 0.82

    # ── harness webbing: 50 mm weave, bound edges, salt streaks; dark anodised hardware ──
    wb = is_('webbing')
    weave = (1 - np.abs(np.sin(u * 2 * math.pi / 0.0024))) ** 1.5
    edge_w = smooth(0.004, 0.0015, e)
    col[wb] = (lin('#5D605C') * (0.86 + 0.18 * n2[..., None] + 0.08 * weave[..., None]) * (1 - 0.25 * edge_w[..., None]))[wb]
    salt_w = smooth(0.2, 0.7, fbm3(P, 18.0, 2, 72)) * 0.3
    col[wb] = col[wb] * (1 - salt_w[wb, None]) + lin('#D9D6CE') * salt_w[wb, None]
    rough[wb] = 0.84
    height[wb] += (0.35 * weave + 0.3 * edge_w)[wb]
    bk = is_('buckle')
    col[bk] = lin('#4E5153') * (0.85 + 0.2 * n3[bk, None]) + smooth(0.3, 0.9, cv)[bk, None] * 0.18
    metal[bk] = 1.0
    rough[bk] = 0.42 + 0.12 * n3[bk]
    cb = is_('cable') | is_('coil')
    col[cb] = lin('#161616')
    rough[cb] = 0.5
    co_ = is_('coil')
    turn = (1 - np.abs(np.sin(u * math.pi / 0.0105))) ** 0.6
    height[co_] += (2.2 * turn - 1.2)[co_]
    col[co_] = (lin('#1A1A1A') * (0.7 + 0.5 * turn[..., None]))[co_]
    rough[co_] = 0.42

    # gentle cavity darkening only (faded, not dirty)
    col = col * (0.72 + 0.28 * ao[..., None])
    return col, np.clip(rough, 0.05, 1), metal, height, accent, ao


def height_to_image(height, size, name):
    img = float_image(name, size)
    a = np.zeros((size, size, 4), dtype=np.float32)
    a[..., 0] = a[..., 1] = a[..., 2] = height * 0.001
    a[..., 3] = 1
    img.pixels.foreach_set(a.ravel())
    return img


def bake_normals_from_height(objs, mat, height_img, size, out_path, strength=1.0, base_normal=None, distance=1.0):
    """tangent-space normal of a height image baked on the Atlas UVs; base_normal = (image path, UV
    layer) adds an existing normal map sampled through another UV layer with the same tangent
    orientation (islands packed without rotation)"""
    img = bpy.data.images.new('nrm_tmp', size, size, alpha=False, float_buffer=False)
    img.colorspace_settings.name = 'Non-Color'

    def build(nt):
        uvn = nt.nodes.new('ShaderNodeUVMap')
        uvn.uv_map = 'Atlas'
        ht = nt.nodes.new('ShaderNodeTexImage')
        ht.image = height_img
        ht.interpolation = 'Cubic'
        nt.links.new(uvn.outputs['UV'], ht.inputs['Vector'])
        bump = nt.nodes.new('ShaderNodeBump')
        bump.inputs['Strength'].default_value = strength
        bump.inputs['Distance'].default_value = distance
        nt.links.new(ht.outputs['Color'], bump.inputs['Height'])
        if base_normal is not None:
            path, uv_name = base_normal
            bn = nt.nodes.new('ShaderNodeTexImage')
            bn.image = bpy.data.images.load(path, check_existing=True)
            bn.image.colorspace_settings.name = 'Non-Color'
            bn.interpolation = 'Cubic'
            u2 = nt.nodes.new('ShaderNodeUVMap')
            u2.uv_map = uv_name
            nt.links.new(u2.outputs['UV'], bn.inputs['Vector'])
            nm = nt.nodes.new('ShaderNodeNormalMap')
            nm.uv_map = uv_name
            nt.links.new(bn.outputs['Color'], nm.inputs['Color'])
            nt.links.new(nm.outputs['Normal'], bump.inputs['Normal'])
        bs = nt.nodes.new('ShaderNodeBsdfDiffuse')
        nt.links.new(bump.outputs['Normal'], bs.inputs['Normal'])
        return bs.outputs['BSDF']

    bake_material(mat, img, build)
    do_bake(objs, 'NORMAL', samples=1)
    img.filepath_raw = out_path
    img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)


def save_rgba(arr, path, colorspace):
    h, w, _ = arr.shape
    img = bpy.data.images.new(os.path.basename(path).split('.')[0], w, h, alpha=True)
    img.colorspace_settings.name = colorspace
    img.pixels.foreach_set(np.clip(arr, 0, 1).astype(np.float32).ravel())
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)


def dilate(rgb, mask, iters=16):
    rgb = rgb.copy()
    m = mask.copy()
    for _ in range(iters):
        pad = np.pad(rgb * m[..., None], ((1, 1), (1, 1), (0, 0)))
        pm = np.pad(m.astype(np.float64), 1)
        s = pad[:-2, 1:-1] + pad[2:, 1:-1] + pad[1:-1, :-2] + pad[1:-1, 2:]
        cnt = pm[:-2, 1:-1] + pm[2:, 1:-1] + pm[1:-1, :-2] + pm[1:-1, 2:]
        grow = (~m) & (cnt > 0)
        rgb[grow] = s[grow] / cnt[grow, None]
        m = m | grow
    return rgb


def _height_normal(hgt, strength):
    gx = (np.roll(hgt, -1, 1) - np.roll(hgt, 1, 1)) * strength
    gy = (np.roll(hgt, -1, 0) - np.roll(hgt, 1, 0)) * strength
    n = np.stack([-gx, -gy, np.ones_like(hgt)], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    out = np.ones(hgt.shape + (4,))
    out[..., :3] = n * 0.5 + 0.5
    return out


def canvas_weave(size, threads=24, strength=1.4, seed=71):
    """tileable plain-weave canvas: over/under thread bumps with slub noise"""
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:size, 0:size] / size
    tx, ty = x * threads, y * threads
    ix, iy = np.floor(tx).astype(int), np.floor(ty).astype(int)
    over = (ix + iy) % 2
    bx = np.sin(np.pi * (tx % 1.0)) ** 0.6
    by = np.sin(np.pi * (ty % 1.0)) ** 0.6
    hgt = np.where(over > 0, bx * (0.6 + 0.4 * by), by * (0.6 + 0.4 * bx))
    slub = rng.uniform(0.85, 1.15, threads)
    hgt = hgt * slub[iy % threads] * slub[ix % threads]
    return _height_normal(hgt, strength)


def skin_pores(size, cells=40, strength=0.9, seed=97):
    """tileable pores: dimples at jittered cell centres plus fine noise"""
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:size, 0:size] / size * cells
    jx = rng.uniform(0.2, 0.8, (cells, cells))
    jy = rng.uniform(0.2, 0.8, (cells, cells))
    dmin = np.full((size, size), 9.0)
    ix, iy = np.floor(x).astype(int), np.floor(y).astype(int)
    for ox in (-1, 0, 1):
        for oy in (-1, 0, 1):
            cx = (ix + ox) % cells
            cy = (iy + oy) % cells
            dmin = np.minimum(dmin, np.hypot(x - (ix + ox + jx[cy, cx]), y - (iy + oy + jy[cy, cx])))
    noise = rng.normal(0, 1, (size, size))
    noise = (noise + np.roll(noise, 1, 0) + np.roll(noise, 1, 1)) / 3
    hgt = -np.exp(-(dmin / 0.12) ** 2) + 0.15 * noise
    return _height_normal(hgt, strength)


# ── gear stage ──────────────────────────────────────────────────────────────


def gear(cfg, work, args, rig):
    size = args.bake_size
    objs = [o for o in bpy.data.objects if o.type == 'MESH' and o.data.materials and o.data.materials[0].name == 'M_Pilot']
    dens = atlas_uvs(objs, margin_px=6 * size / 2048, size=size)
    mat = bpy.data.materials['M_Pilot']
    others = [o for o in bpy.data.objects if o.type == 'MESH' and o not in objs]
    hide = [o for o in others if o.name.startswith('Hair') or o.name in ('Brows', 'Lashes', 'GoggleLenses')]
    D = data_passes(objs, mat, size, args.samples, hide)
    if os.environ.get('PILOT_DEBUG'):
        dbg = np.ones((size, size, 4))
        lk = np.rint(D['LOOK'][..., 0] * 64).astype(int)
        rng = np.random.default_rng(1)
        pal = rng.uniform(0.1, 1.0, (64, 3))
        dbg[..., :3] = pal[np.clip(lk, 0, 63)]
        save_rgba(dbg, os.path.join(work, 'debug_look.png'), 'Non-Color')
        dbg[..., :3] = np.clip(np.abs(D['GC']) * np.array([1.0, 3.0, 20.0]), 0, 1)
        save_rgba(dbg, os.path.join(work, 'debug_gc.png'), 'Non-Color')
        print('[pilot] debug: looks present', sorted({str(LOOK_NAMES.get(int(k), k)) for k in np.unique(lk)}), 'gc max', D['GC'].reshape(-1, 3).max(axis=0))
    col, rough, metal, height, accent, ao = composite_gear(D, rig, cfg)
    cover = D['COVER'] > 0.5
    col = dilate(col, cover)
    height = dilate(height[..., None], cover, 8)[..., 0]
    if os.environ.get('PILOT_DEBUG'):
        dbg = np.ones((size, size, 4))
        dbg[..., :3] = np.clip(0.5 + height[..., None] / 6.0, 0, 1)
        save_rgba(dbg, os.path.join(work, 'debug_height.png'), 'Non-Color')
    base = np.ones((size, size, 4))
    base[..., :3] = srgb(col)
    base[..., 3] = accent
    save_rgba(base, os.path.join(work, 'T_Pilot_base.png'), 'sRGB')
    prev = base.copy()
    prev[..., 3] = 1
    save_rgba(prev, os.path.join(work, 'preview_gear_base.png'), 'sRGB')
    orm = np.ones((size, size, 4))
    orm[..., 0] = np.where(cover, ao, 1)
    orm[..., 1] = rough
    orm[..., 2] = metal
    save_rgba(orm, os.path.join(work, 'T_Pilot_orm.png'), 'Non-Color')
    himg = height_to_image(height, size, 'height_tmp')
    # height is in mm; Distance 3 gives cloth folds and seams the relief they have on a real coverall
    # at this texel density (1.0 read as a flat tube in the sleeve close-ups)
    bake_normals_from_height(objs, mat, himg, size, os.path.join(work, 'T_Pilot_normal.png'), strength=1.0, distance=3.0)
    bpy.data.images.remove(himg)
    save_rgba(canvas_weave(256), os.path.join(work, 'T_Pilot_detail.png'), 'Non-Color')
    return {'texelDensityPxPerM': dens, 'size': size}


# ── skin stage ──────────────────────────────────────────────────────────────


def skin_island_factor(sk, rig):
    """texel priority by what shows: the face most, the scalp under the hair cap least"""
    co = C.coords(sk)
    scalp = C.group_weights(sk, ['scalp'])
    ears = C.group_weights(sk, ['ears'])
    hb = rig.data.bones['head']
    hm = np.array(hb.matrix_local)
    up, fwd = unit(hm[:3, 1]), unit(hm[:3, 2])
    rel = co - np.array(hb.head_local)
    loops, starts, totals = _loop_vertex_tables(sk)

    nrm = M.vertex_normals(co, M.tris_of(sk))
    centre = np.array(hb.head_local) + up * 0.08

    def factor(faces):
        vs = np.unique(np.concatenate([loops[starts[f]:starts[f] + totals[f]] for f in faces]))
        if (nrm[vs] * (co[vs] - centre)).sum(axis=1).mean() < 0:
            return 0.25  # mouth and eye-socket interiors, facing into the head
        if scalp[vs].mean() > 0.5:
            return 0.3
        if ears[vs].mean() > 0.5:
            return 0.75
        if (rel[vs] @ up).mean() < -0.03 and (rel[vs] @ fwd).mean() < 0.06:
            return 0.55  # neck, mostly inside the gaiter
        return 1.25
    return factor


def face_fisheye(sk, rig, a=1.6, layer='Atlas'):
    """MakeHuman unwraps face, scalp, ears and neck as ONE island, so island scaling cannot favour the
    face. A radial warp about the nose tip magnifies the face (x2.6 linear at the centre) and
    compresses the island's rim (scalp and neck, x0.38). Every source is baked through the original
    MH UVs into world space and back, so the warp needs no tangent-space correction."""
    co = C.coords(sk)
    hb = rig.data.bones['head']
    hm = np.array(hb.matrix_local)
    fwd = unit(hm[:3, 2])
    scalp = C.group_weights(sk, ['scalp'])
    front = np.where(scalp < 0.2, (co - np.array(hb.head_local)) @ fwd, -9)
    nose = int(np.argmax(front))
    me = sk.data
    uv = me.uv_layers[layer].data
    arr = np.empty(len(uv) * 2)
    uv.foreach_get('uv', arr)
    arr = arr.reshape(-1, 2)
    loops, starts, totals = _loop_vertex_tables(sk)
    li = int(np.nonzero(loops == nose)[0][0])
    c = arr[li].copy()
    for faces in uv_islands(sk, layer):
        idx = np.concatenate([np.arange(starts[f], starts[f] + totals[f]) for f in faces])
        if li not in set(idx.tolist()):
            continue
        rel = arr[idx] - c
        d = np.linalg.norm(rel, axis=1)
        R = d.max()
        x = d / R
        fx = (1 + a) * x / (1 + a * x)
        arr[idx] = c + rel * (fx / np.maximum(x, 1e-9))[:, None]
    uv.foreach_set('uv', arr.ravel())


def mirror_uv_layer(ob, src='MH', name='MHmirror'):
    """each loop gets the source UV of its X-mirrored vertex (MakeHuman's mesh is symmetric), so a
    texture can be sampled from the other side of the face"""
    co = C.coords(ob)
    kd = KDTree(len(co))
    for i, p in enumerate(co):
        kd.insert(Vector(p), i)
    kd.balance()
    mirror = np.array([kd.find(Vector((-p[0], p[1], p[2])))[1] for p in co])
    me = ob.data
    uv = me.uv_layers[src].data
    arr = np.empty(len(uv) * 2, dtype=np.float32)
    uv.foreach_get('uv', arr)
    arr = arr.reshape(-1, 2)
    loops = np.empty(len(me.loops), dtype=np.int64)
    me.loops.foreach_get('vertex_index', loops)
    first = {}
    for li, vi in enumerate(loops):
        first.setdefault(int(vi), li)
    layer = me.uv_layers.new(name=name)
    vals = np.array([arr[first[int(mirror[vi])]] for vi in loops], dtype=np.float32)
    layer.data.foreach_set('uv', vals.ravel())
    return layer


def face_frame(P, rig, eyes_c):
    hb = rig.data.bones['head']
    hm = np.array(hb.matrix_local)
    up, fwd = unit(hm[:3, 1]), unit(hm[:3, 2])
    left = np.cross(up, fwd)
    o = np.array(hb.head_local)
    rel = P - o
    ex = float(np.mean([abs((c - o) @ left) for c in eyes_c]))
    ey = float(np.mean([(c - o) @ up for c in eyes_c]))
    return rel @ left, rel @ up, rel @ fwd, ex, ey


def face_height(P, rig, eyes_c, fmax, variant, mask):
    """sculpted skin detail in mm: sun lines, frown lines, crow's feet, nasolabial folds, scar"""
    x, y, z, ex, ey = face_frame(P, rig, eyes_c)
    front = smooth(fmax - 0.075, fmax - 0.035, z)
    k = variant.get('sunLines', 0.0)
    hgt = np.zeros(P.shape[:2])
    # forehead: horizontal lines, wavy, strongest over the brows' centre
    fy = y - (ey + 0.03)
    lines = (1 - np.abs(np.sin(math.pi * (fy + 0.0025 * np.sin(x * 60)) / 0.0085))) ** 6
    hgt -= 0.28 * lines * smooth(0.0, 0.006, fy) * smooth(0.05, 0.03, fy) * smooth(0.06, 0.03, np.abs(x)) * front
    # glabella frown lines
    for sx in (-1, 1):
        g = np.exp(-((x - sx * 0.007) / 0.0011) ** 2) * smooth(-0.002, 0.006, y - ey) * smooth(0.04, 0.025, y - ey)
        hgt -= 0.35 * g * front
    for side in (1, -1):
        cx = side * ex
        # crow's feet: a fan of fine lines at the outer eye corner
        ox, oy = x - (cx + side * 0.021), y - (ey - 0.002)
        rr = np.hypot(ox, oy)
        phi = np.arctan2(oy, ox * side)
        fan = (1 - np.abs(np.sin(phi * 9 + rr * 90))) ** 8 * smooth(0.004, 0.009, rr) * smooth(0.028, 0.016, rr) * (np.abs(phi) < 1.1)
        hgt -= 0.26 * fan * front
        # under-eye line
        ue = np.exp(-((y - (ey - 0.014 - 0.004 * ((x - cx) / 0.02) ** 2)) / 0.0012) ** 2) * smooth(0.024, 0.012, np.abs(x - cx))
        hgt -= 0.2 * ue * front
        # nasolabial fold: from the nose wing down past the mouth corner, a soft cheek roll outside it
        a = np.array([side * 0.018, ey - 0.045])
        b = np.array([side * 0.03, ey - 0.085])
        ab = b - a
        tt = np.clip(((x - a[0]) * ab[0] + (y - a[1]) * ab[1]) / (ab @ ab), 0, 1)
        qx = a[0] + tt * ab[0]
        d = np.hypot(x - qx, y - (a[1] + tt * ab[1]))
        hgt -= 0.55 * np.exp(-(d / 0.0022) ** 2) * front
        hgt += 0.25 * np.exp(-((d - 0.005) / 0.003) ** 2) * front * (np.sign(x - qx) == side)
    hgt *= k
    scar = np.zeros(P.shape[:2])
    ends = {'brow_l': ((ex + 0.012, ey + 0.038), (ex + 0.002, ey + 0.004)),
            'cheek_r': ((-ex - 0.018, ey - 0.02), (-ex - 0.006, ey - 0.055))}.get(variant.get('scar'))
    if ends is not None:
        a, b = np.array(ends[0]), np.array(ends[1])
        ab = b - a
        tt = np.clip(((x - a[0]) * ab[0] + (y - a[1]) * ab[1]) / (ab @ ab), 0, 1)
        d = np.hypot(x - (a[0] + tt * ab[0]), y - (a[1] + tt * ab[1]))
        taper = np.sin(math.pi * tt) ** 0.5
        scar = np.exp(-(d / (0.0016 * taper + 1e-4)) ** 2) * front
        hgt += -0.35 * scar + 0.2 * np.exp(-((d - 0.0022) / 0.001) ** 2) * front * taper
    hgt += 0.04 * M.fbm(P.reshape(-1, 3), 700.0, 1, 11).reshape(P.shape[:2])
    return hgt * mask, scar * mask


def skin(cfg, work, args, rig, user_data):
    """MakeHuman head/neck islands and the eye island packed into 2048² without rotation (every
    island keeps its internal mapping, scaled by what shows); the CC0 sources are re-baked through
    the original UVs"""
    size = 2048 if args.bake_size >= 2048 else args.bake_size
    sk = bpy.data.objects['Skin']
    eyes = bpy.data.objects['Eyes']
    for ob in (sk, eyes):
        me = ob.data
        src = me.uv_layers[0]
        src.name = 'MH'
        arr = np.empty(len(src.data) * 2, dtype=np.float32)
        src.data.foreach_get('uv', arr)
        if ob is eyes:
            arr = arr * 0.11  # an eye needs ~100 px of iris, not a quarter of the atlas
        uv = me.uv_layers.new(name='Atlas')
        uv.data.foreach_set('uv', arr)
        me.uv_layers.active = uv
    scale_islands(sk, skin_island_factor(sk, rig))
    face_fisheye(sk, rig)
    mirror_uv_layer(sk)
    eyes.data.uv_layers.new(name='MHmirror')
    for ob in (sk, eyes):
        ob.data.uv_layers.active = ob.data.uv_layers['Atlas']
    bpy.context.scene.tool_settings.use_uv_select_sync = True
    _edit([sk, eyes], lambda: bpy.ops.uv.pack_islands(rotate=False, margin_method='FRACTION', margin=8 / size,
                                                      shape_method='CONCAVE', scale=True))
    snap_uvs([sk, eyes])
    mat = bpy.data.materials['M_PilotSkin']
    me = sk.data
    for name in ('scalp', 'ears', 'lips'):
        a = me.attributes.new('m_' + name, 'FLOAT', 'POINT')
        a.data.foreach_set('value', np.clip(C.group_weights(sk, [name]), 0, 1).astype(np.float32))
    ea = eyes.data.attributes.new('m_eye', 'FLOAT', 'POINT')
    ea.data.foreach_set('value', np.ones(len(eyes.data.vertices), dtype=np.float32))
    sa = me.attributes.new('m_eye', 'FLOAT', 'POINT')
    sa.data.foreach_set('value', np.zeros(len(me.vertices), dtype=np.float32))
    img = float_image('skin_tmp', size)
    objs = [sk, eyes]

    def attr(name):
        def build(nt):
            a = nt.nodes.new('ShaderNodeAttribute')
            a.attribute_name = name
            return emission_of(nt, a.outputs['Fac'])
        return build

    def geo(field):
        def build(nt):
            g = nt.nodes.new('ShaderNodeNewGeometry')
            return emission_of(nt, g.outputs[field])
        return build

    def image_through(path, colorspace, uv_name='MH'):
        def build(nt):
            im = bpy.data.images.load(path, check_existing=True)
            im.colorspace_settings.name = colorspace
            t = nt.nodes.new('ShaderNodeTexImage')
            t.image = im
            t.interpolation = 'Cubic'
            u = nt.nodes.new('ShaderNodeUVMap')
            u.uv_map = uv_name
            nt.links.new(u.outputs['UV'], t.inputs['Vector'])
            return emission_of(nt, t.outputs['Color'])
        return build

    passes = {}
    for key, build in (('scalp', attr('m_scalp')), ('ears', attr('m_ears')), ('lips', attr('m_lips')),
                       ('eye', attr('m_eye')), ('POS', geo('Position'))):
        bake_material(mat, img, build)
        do_bake(objs, 'EMIT')
        passes[key] = pixels(img).copy()

    def bake_source(obj_list, path, colorspace, uv_name='MH'):
        bake_material(mat, img, image_through(path, colorspace, uv_name))
        do_bake(obj_list, 'EMIT')
        return pixels(img).copy()

    eye_src = os.path.join(user_data, cfg['assets']['files']['eyesTexture']['path'])
    eye_rgb = bake_source([eyes], eye_src, 'Non-Color')[..., :3]
    variants = [(k, v) for k, v in cfg['variants'].items() if isinstance(v, dict)]
    albedo, mirrored = {}, {}
    for vname, var in variants:
        path = os.path.join(user_data, cfg['assets']['files'][var['skin']]['path'])
        albedo[vname] = bake_source([sk], path, 'Non-Color')[..., :3]
        mirrored[vname] = bake_source([sk], path, 'Non-Color', 'MHmirror')[..., :3]
    bake_material(mat, img, lambda nt: nt.nodes.new('ShaderNodeBsdfDiffuse').outputs['BSDF'])
    # the goggles are pushed up in menus: their occlusion must not stay painted round the eyes
    hide = [o for o in bpy.data.objects if o.type == 'MESH' and (o.name.startswith('Hair_') or o.name in ('Brows', 'Lashes', 'GoggleLenses', 'Goggles'))]
    for o in hide:
        o.hide_render = True
    bpy.context.scene.world.light_settings.distance = 0.05
    do_bake(objs, 'AO', samples=args.samples)
    for o in hide:
        o.hide_render = False
    ao = pixels(img)[..., 0].copy()
    cover = pixels(img)[..., 3] > 0.5
    bpy.data.images.remove(img)

    eye_px = passes['eye'][..., 0] > 0.5
    P = passes['POS'][..., :3].astype(np.float64)
    head = rig.data.bones['head']
    hm = np.array(head.matrix_local)
    hup, hfwd = unit(hm[:3, 1]), unit(hm[:3, 2])
    rel = P - np.array(head.head_local)
    fwd = rel @ hfwd
    upc = rel @ hup
    scalp = np.clip(passes['scalp'][..., 0], 0, 1)
    ears = np.clip(passes['ears'][..., 0], 0, 1)
    lips = np.clip(passes['lips'][..., 0], 0, 1)
    fmax = fwd[cover & ~eye_px].max() if (cover & ~eye_px).any() else 0.1
    beard = smooth(fmax - 0.095, fmax - 0.055, fwd) * smooth(0.035, -0.035, upc) * (1 - lips) * (1 - ears)
    nose = np.exp(-((fwd - fmax) / 0.02) ** 2) * smooth(-0.02, 0.03, upc) * smooth(0.07, 0.03, upc)
    tzone = smooth(fmax - 0.05, fmax - 0.01, fwd) * smooth(0.0, 0.08, upc) * (1 - scalp)
    # scalp paint under the hairline: MakeHuman's scalp weights are hard 0/1, so the baked mask is a
    # one-face staircase; blurred over ~1 cm of texture and kept to a root tone, the skin darkens into
    # the hair cap instead of ending in a painted step
    sp = scalp * cover
    wsum = cover.astype(np.float64)
    rad = max(2, int(round(size / 160)))
    for _ in range(3):
        for axis in (0, 1):
            sp = sum(np.roll(sp, k, axis) for k in range(-rad, rad + 1))
            wsum = sum(np.roll(wsum, k, axis) for k in range(-rad, rad + 1))
            sp, wsum = sp / (2 * rad + 1), wsum / (2 * rad + 1)
    scalp_soft = np.where(wsum > 1e-3, sp / np.maximum(wsum, 1e-3), 0)
    scalp_paint = smooth(0.15, 0.95, scalp_soft) * 0.75
    eco = C.coords(eyes)
    centres = [eco[eco[:, 0] > 0].mean(axis=0), eco[eco[:, 0] <= 0].mean(axis=0)]
    face_mask = (cover & ~eye_px).astype(np.float64)

    # normal: Mindfront NRM + the hero's sculpted height (the NPC variants share the normal map)
    hgt, _ = face_height(P, rig, centres, fmax, cfg['variants']['hero'], face_mask)
    hgt = dilate(hgt[..., None], cover, 8)[..., 0]
    himg = height_to_image(hgt, size, 'skin_height_tmp')
    nrm_src = os.path.join(user_data, cfg['assets']['files']['skinHeroNormal']['path'])
    bake_normals_from_height(objs, mat, himg, size, os.path.join(work, 'T_PilotSkin_normal.png'), strength=1.0,
                             base_normal=(nrm_src, 'MH'))
    bpy.data.images.remove(himg)
    for ob in objs:
        for name in ('MH', 'MHmirror'):
            if name in ob.data.uv_layers:
                ob.data.uv_layers.remove(ob.data.uv_layers[name])

    rough = 0.55 - 0.1 * tzone - 0.15 * lips + 0.12 * scalp_paint + 0.05 * beard
    rough = np.where(eye_px, 0.08, rough)
    orm = np.ones((size, size, 4))
    orm[..., 0] = np.where(cover, 0.3 + 0.7 * ao, 1)
    orm[..., 1] = np.clip(rough, 0.05, 1)
    orm[..., 2] = 0
    save_rgba(orm, os.path.join(work, 'T_PilotSkin_orm.png'), 'Non-Color')
    save_rgba(skin_pores(256), os.path.join(work, 'T_PilotSkin_detail.png'), 'Non-Color')

    thick = np.clip(0.4 + 0.6 * ears + 0.35 * lips + 0.3 * nose - 0.3 * scalp_paint, 0, 1)
    thick = np.where(eye_px, 0.0, thick)
    eye_dist = [np.linalg.norm(P - c, axis=-1) for c in centres]
    lumw = np.array([0.2126, 0.7152, 0.0722])
    to_lin = lambda a: np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)  # noqa: E731
    fbm_stub = M.fbm(P.reshape(-1, 3), 120.0, 2, 5).reshape(size, size)
    x, y, z, _ex, _ey = face_frame(P, rig, centres)
    out, socket_report = {}, {}
    for vname, var in variants:
        lin_alb = to_lin(np.clip(albedo[vname], 0, 1).astype(np.float64))
        lin_mir = to_lin(np.clip(mirrored[vname], 0, 1).astype(np.float64))
        # eye sockets: the CC0 skins paint them (they sit behind MakeHuman's eyeballs). The hero skin
        # also has a bruise-green patch round one eye: where a pixel near an eye is greener than the
        # same spot on the other side of the face, the mirrored side replaces it; then darker-than-ring
        # pixels are pulled to the ring's tone
        rg_a = lin_alb[..., 1] / np.maximum(lin_alb[..., 0], 1e-4)
        rg_m = lin_mir[..., 1] / np.maximum(lin_mir[..., 0], 1e-4)
        near_eye = np.minimum(eye_dist[0], eye_dist[1])
        w_mir = smooth(0.03, 0.09, rg_a - rg_m) * smooth(0.05, 0.035, near_eye) * cover * ~eye_px
        lin_alb = lin_alb * (1 - w_mir[..., None]) + lin_mir * w_mir[..., None]
        socket_report[vname] = {'mirroredPx': int((w_mir > 0.5).sum())}
        for i in range(2):
            d = eye_dist[i]
            ring = cover & ~eye_px & (d > 0.03) & (d < 0.042) & (scalp < 0.5)
            tone = np.median(lin_alb[ring], axis=0) if ring.any() else lin_alb[cover].mean(axis=0)
            w = smooth(0.03, 0.018, d) * cover * ~eye_px
            ratio = (lin_alb @ lumw) / max(tone @ lumw, 1e-4)
            kk = (w * np.clip((0.95 - ratio) / 0.35, 0, 1))[..., None]
            lin_alb = lin_alb * (1 - kk) + tone[None, None, :] * (0.85 + 0.15 * np.clip(ratio, 0, 1))[..., None] * kk
        lin_alb *= np.array(var['skinTint'])[None, None, :]
        vh, scar = face_height(P, rig, centres, fmax, var, face_mask)
        haircol = C.hex_lin(var['hairColor'])
        # stubble: follicle dots on a ~0.9 mm lattice + a soft beard shadow
        cell = 0.0008
        gx, gy = np.floor(x / cell), np.floor(y / cell)
        hsh = (np.sin(gx * 12.9898 + gy * 78.233) * 43758.5453) % 1.0
        jx = (np.sin(gx * 63.7264 + gy * 10.873) * 28001.8384) % 1.0 - 0.5
        jy = (np.sin(gx * 36.0453 + gy * 61.321) * 17313.1287) % 1.0 - 0.5
        fx_, fy_ = (x / cell) % 1.0 - 0.5 - 0.6 * jx, (y / cell) % 1.0 - 0.5 - 0.6 * jy
        dots = (hsh > 0.3) * np.exp(-((fx_ ** 2 + fy_ ** 2) / 0.05)) * 0.7
        density = var['stubble'] * beard * smooth(-0.3, 0.5, fbm_stub + 0.4)
        shadow = density * 0.35
        lin_alb = lin_alb * (1 - shadow[..., None]) + (haircol * 0.6 + np.array([0.02, 0.025, 0.03]))[None, None, :] * shadow[..., None]
        lin_alb = lin_alb * (1 - 0.75 * (dots * density)[..., None]) + haircol * 0.75 * (dots * density)[..., None]
        # hairline: fine short hairs and root shadow on the skin just outside the hair cap's edge, so
        # the cap's fade meets painted roots instead of bare skin
        band = smooth(0.03, 0.3, scalp_soft) * (1 - smooth(0.75, 1.0, scalp_soft))
        hcell = 0.00055
        hx, hy = np.floor(x / hcell), np.floor(y / hcell)
        hh = (np.sin(hx * 91.113 + hy * 47.271) * 31337.77) % 1.0
        hj = (np.sin(hx * 12.345 + hy * 67.891) * 9876.54) % 1.0 - 0.5
        hfx, hfy = (x / hcell) % 1.0 - 0.5 - 0.6 * hj, (y / hcell) % 1.0 - 0.5 + 0.6 * hj
        roots = (hh > 1 - 0.7 * band) * np.exp(-((hfx ** 2 + hfy ** 2) / 0.05)) * 0.5
        lin_alb = lin_alb * (1 - 0.25 * band[..., None]) + haircol * 0.25 * band[..., None]
        lin_alb = lin_alb * (1 - 0.7 * roots[..., None]) + haircol * 0.6 * roots[..., None]
        # sun spots / freckles on the cheeks, nose and forehead
        fcell = 0.0035
        fh = (np.sin(np.floor(x / fcell) * 39.3468 + np.floor(y / fcell) * 11.1357) * 23421.631) % 1.0
        ffx, ffy = (x / fcell) % 1.0 - 0.5, (y / fcell) % 1.0 - 0.5
        frk = (fh > 0.82) * np.exp(-((ffx ** 2 + ffy ** 2) / (0.03 + 0.05 * fh))) * var.get('freckles', 0.0)
        frk *= smooth(fmax - 0.05, fmax - 0.02, z) * (1 - scalp) * (1 - lips)
        lin_alb = lin_alb * (1 - 0.35 * frk[..., None]) + np.array([0.3, 0.17, 0.09])[None, None, :] * 0.35 * frk[..., None]
        # scar tissue: paler, a little pink
        lin_alb = lin_alb * (1 - 0.5 * scar[..., None]) + lin_alb * np.array([1.35, 1.15, 1.1])[None, None, :] * 0.5 * scar[..., None]
        # weathering: sun-reddened nose, paler squint creases
        sl = var.get('sunLines', 0)
        lin_alb = lin_alb * (1 + 0.08 * sl * nose[..., None] * np.array([1.0, -0.4, -0.6])[None, None, :])
        lin_alb = lin_alb * (1 - 0.9 * scalp_paint[..., None]) + haircol * 0.9 * scalp_paint[..., None]
        lin_alb = lin_alb * (0.82 + 0.18 * np.clip(ao, 0, 1))[..., None]
        rgb = np.where(eye_px[..., None], np.clip(eye_rgb, 0, 1), srgb(lin_alb))
        rgb = dilate(rgb, cover, 8)
        base = np.ones((size, size, 4))
        base[..., :3] = rgb
        base[..., 3] = thick
        path = os.path.join(work, f'T_PilotSkin_base_{vname}.png')
        save_rgba(base, path, 'sRGB')
        save_rgba(np.concatenate([rgb, np.ones((size, size, 1))], axis=2), os.path.join(work, f'preview_skin_{vname}.png'), 'sRGB')
        out[vname] = os.path.basename(path)
    return {'albedos': out, 'eyePx': int(eye_px.sum()), 'size': size, 'eyeSockets': socket_report}


def run(cfg, work, args):
    rep = C.load(work, 'stage_hair')
    import body
    user_data, _t = body.enable_mpfb(cfg)
    C.set_threads(args.threads)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    if sc.world is None:
        sc.world = bpy.data.worlds.new('World')
    rig = bpy.data.objects['PilotRig']
    gear_rep = gear(cfg, work, args, rig)
    # the gear bake material referenced temporary images that are gone now: reset it so the skin
    # bakes (where the gear occludes) do not trip Cycles' missing-image errors
    bake_material(bpy.data.materials['M_Pilot'], None, lambda nt: nt.nodes.new('ShaderNodeBsdfDiffuse').outputs['BSDF'])
    rep['texture'] = {'gear': gear_rep, 'skin': skin(cfg, work, args, rig, user_data)}
    print(f"[pilot] texture: {rep['texture']}")
    C.save(work, 'stage_texture', rep)
