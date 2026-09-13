"""
Per-slot atlas UVs, Cycles CPU data bakes, and the numpy wear compositor.

For each parts slot (M_Carbon, M_Metal, M_Cockpit, M_Perspex):
  1. UV: smart-project pieces without authored UVs, average island scale across the WHOLE slot (one
     texel density), multiply islands by their tier (cockpit close-up 2×, low 0.5×), pack.
  2. Bake data passes into float images, all pieces of the slot at once (the other LOD0 geometry and
     the hull occlude, so AO/cavity see the assembled boat):
       POS   world position                     NRM   world normal
       MASK  R edge (Bevel-node curvature)  G cavity (local AO)  B look id
       PAT   look pattern shader (alt1, alt2, micro-height)
       NOISE three world-space noise octaves    AUX   R per-piece wear, G livery, B vertical streak noise
       AO    Cycles ambient occlusion
  3. Composite (numpy, deterministic): base/alt colours, edge wear and repaint chips revealing the
     under-layer, scratches, grime in cavities, salt crust on ledges and in cavities, sun fade, rust
     halos and streaks below carbon-steel fasteners, weld heat tint on stainless, pits on castings,
     fastener domes and chip depth as micro-height → tangent-space normal.
     Output ≤ 3 textures per material: baseColor (RGB + A = livery mask / perspex opacity), ORM, normal.
"""
import math
import os
import time

import bpy
import numpy as np

import kit
import looks as LK

PASSES = ['POS', 'NRM', 'MASK', 'PAT', 'NOISE', 'AUX', 'AO']
GRIME = '#6E685C'  # faded, not dirty (STYLE-SPEC §5.1): cavities go dull grey-beige, never soot
SALT = '#D9D3C4'
RUST = '#7A4526'
RUST_DARK = '#4A2A18'
HEAT = [(0.0, '#5E4A2E'), (0.3, '#4A5C8A'), (0.55, '#7B5C8E'), (0.75, '#B8893E'), (1.0, None)]


def hex_lin(h):
    h = h.lstrip('#')
    c = np.array([int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)], dtype=np.float32)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_srgb(c):
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.0031308, 12.92 * c, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    return a + (b - a) * t


# ── UVs ──────────────────────────────────────────────────────────────────────


def _edit(objs, fn, label):
    if bpy.context.object and bpy.context.object.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.mode_set(mode='EDIT')
    in_edit = [o for o in bpy.context.objects_in_mode]
    if set(in_edit) != set(objs):
        raise SystemExit(f'[parts] {label}: edit mode holds {len(in_edit)} objects, expected {len(objs)}')
    bpy.ops.mesh.select_all(action='SELECT')
    res = fn()
    bpy.ops.object.mode_set(mode='OBJECT')
    for o in objs:
        o.select_set(False)
    if 'FINISHED' not in res:
        raise SystemExit(f'[parts] {label}: UV operator returned {res} (fail loud: the atlas would overlap)')


def uv_area_3d(obj):
    me = obj.data
    uv = me.uv_layers['UVMap'].data
    a3 = 0.0
    auv = 0.0
    for p in me.polygons:
        a3 += p.area
        l0 = p.loop_start
        pts = [uv[l0 + i].uv for i in range(p.loop_total)]
        s = 0.0
        for i in range(len(pts)):
            s += pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1]
        auv += abs(s) / 2
    return a3, auv


def pack_slot(pieces, tiers, margin_px, size):
    bpy.context.scene.tool_settings.use_uv_select_sync = True
    objs = [p.obj for p in pieces]
    smart = [p.obj for p in pieces if not (p.uv in ('auto', 'param') and p.geo.has_uv)]
    if smart:
        kit.smart_uv_objects(smart, angle=66.0)
    _edit(objs, lambda: bpy.ops.uv.average_islands_scale(), 'average_islands_scale')
    base = tiers['exterior']
    for p in pieces:
        m = tiers[p.tier] / base
        if abs(m - 1) < 1e-9:
            continue
        uv = p.obj.data.uv_layers['UVMap'].data
        arr = np.empty(len(uv) * 2, dtype=np.float64)
        uv.foreach_get('uv', arr)
        uv.foreach_set('uv', arr * m)
    _edit(objs, lambda: bpy.ops.uv.pack_islands(rotate=True, rotate_method='CARDINAL', margin_method='FRACTION',
                                                margin=margin_px / size, shape_method='CONCAVE', scale=True), 'pack_islands')
    # achieved texel density per tier (px/m)
    acc = {}
    for p in pieces:
        a3, auv = uv_area_3d(p.obj)
        t = acc.setdefault(p.tier, [0.0, 0.0])
        t[0] += a3
        t[1] += auv
    used = sum(v[1] for v in acc.values())
    return {tier: round(size * math.sqrt(v[1] / v[0]), 1) for tier, v in acc.items() if v[0] > 0}, round(used, 3)


# ── bake passes ─────────────────────────────────────────────────────────────


def _emit_mat(name, img, build):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    em = nt.nodes.new('ShaderNodeEmission')
    em.inputs['Strength'].default_value = 1.0
    nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
    sock = build(nt)
    if sock is not None:
        nt.links.new(sock, em.inputs['Color'])
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = img
    nt.nodes.active = tex
    return mat


def _pass_material(pas, look_name, look_id, img):
    lk = LK.look(look_name)

    def build(nt):
        N = LK._NT(nt)
        geo = nt.nodes.new('ShaderNodeNewGeometry')
        if pas == 'POS':
            return geo.outputs['Position']
        if pas == 'NRM':
            return geo.outputs['Normal']
        if pas == 'MASK':
            bev = nt.nodes.new('ShaderNodeBevel')
            bev.samples = 8
            bev.inputs['Radius'].default_value = 0.005
            d = N.vmath('DOT_PRODUCT', bev.outputs['Normal'], geo.outputs['Normal'])
            edge = N.math('MULTIPLY', N.math('SUBTRACT', 1.0, d), 6.0, clamp=True)
            ao = nt.nodes.new('ShaderNodeAmbientOcclusion')
            ao.only_local = True
            ao.samples = 12
            ao.inputs['Distance'].default_value = 0.04
            return N.combine(edge, ao.outputs['AO'], look_id / 255.0)
        if pas == 'PAT':
            return LK.pattern_vector(nt, lk['pattern'])
        if pas == 'NOISE':
            P = geo.outputs['Position']
            return N.combine(N.noise(P, 70.0, 4.0, 0.55), N.noise(P, 7.0, 5.0, 0.6), N.noise(P, 1.3, 3.0, 0.5))
        if pas == 'AUX':
            streak = N.noise(N.vmath('MULTIPLY', geo.outputs['Position'], (55.0, 55.0, 2.2)), 1.0, 3.0, 0.6)
            return N.combine(N.attr('wear', 'Fac'), float(lk['livery']), streak)
        return None  # AO: the bake type does the work

    return _emit_mat(f'__bake_{pas}_{look_name}', img, build)


def _set_attr(me, name, kind, values):
    a = me.attributes.new('sb_' + name, kind, 'POINT')
    a.data.foreach_set('value' if kind == 'FLOAT' else 'vector', values)


def _bake_object(slot, pieces, looks):
    """one joined copy of the slot's pieces: Cycles bakes each selected object as its own job over
    the whole image, so 160 small pieces cost 160 image walks per pass; one object costs one"""
    placeholders = {name: bpy.data.materials.new(f'__ph_{slot}_{name}') for name in looks}
    copies = []
    for p in pieces:
        c = p.obj.copy()
        c.data = p.obj.data.copy()
        bpy.context.scene.collection.objects.link(c)
        me = c.data
        n = len(me.vertices)
        _set_attr(me, 'wear', 'FLOAT', [float(p.wear)] * n)
        _set_attr(me, 'dr', 'FLOAT', [float(p.props.get('dr', 0.0))] * n)
        for key in ('lo', 'lx', 'ly'):
            v = tuple(p.obj[key]) if key in p.obj else (0.0, 0.0, 0.0)
            _set_attr(me, key, 'FLOAT_VECTOR', list(v) * n)
        me.materials.clear()
        me.materials.append(placeholders[p.look])
        copies.append(c)
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for c in copies:
        c.select_set(True)
    bpy.context.view_layer.objects.active = copies[0]
    if len(copies) > 1:
        bpy.ops.object.join()
    ob = copies[0]
    ob.name = f'__bake_{slot}'
    slot_look = [ms.material.name[len(f'__ph_{slot}_'):] for ms in ob.material_slots]
    return ob, slot_look, placeholders


def bake_slot(slot, pieces, size, ao_samples, margin):
    scene = bpy.context.scene
    looks = sorted({p.look for p in pieces})
    id_of = {name: i + 1 for i, name in enumerate(looks)}
    bob, slot_look, placeholders = _bake_object(slot, pieces, looks)
    # the joined copy occupies the pieces' exact space: hide the originals from the bake render so AO
    # and cavity rays don't hit the same surface twice (the other slots' pieces still occlude)
    hidden = []
    for p in pieces:
        if not p.obj.hide_render:
            p.obj.hide_render = True
            hidden.append(p.obj)
    scene.world = scene.world or bpy.data.worlds.new('bake_world')
    scene.world.light_settings.distance = 0.6
    out = {}
    for pas in PASSES:
        t0 = time.time()
        img = bpy.data.images.new(f'__{slot}_{pas}', width=size, height=size, alpha=True, float_buffer=True)
        img.colorspace_settings.name = 'Non-Color'
        img.generated_color = (0, 0, 0, 0)
        mats = {name: _pass_material(pas, name, id_of[name], img) for name in looks}
        for i, name in enumerate(slot_look):
            bob.material_slots[i].material = mats[name]
        for o in bpy.context.view_layer.objects:
            o.select_set(False)
        bob.select_set(True)
        bpy.context.view_layer.objects.active = bob
        objs = [bob]
        scene.cycles.samples = {'MASK': 8, 'AO': ao_samples}.get(pas, 1)
        bpy.ops.object.bake(type='AO' if pas == 'AO' else 'EMIT', margin=margin, margin_type='EXTEND', use_clear=True,
                            target='IMAGE_TEXTURES')
        a = np.empty(size * size * 4, dtype=np.float32)
        img.pixels.foreach_get(a)
        out[pas] = a.reshape(size, size, 4)
        for o in objs:
            o.select_set(False)
        for m in mats.values():
            bpy.data.materials.remove(m)
        bpy.data.images.remove(img)
        print(f'[parts] bake {slot} {pas} ({size}², {scene.cycles.samples} spp) {time.time() - t0:.1f}s')
    bpy.data.objects.remove(bob, do_unlink=True)
    for m in placeholders.values():
        bpy.data.materials.remove(m)
    for o in hidden:
        o.hide_render = False
    return out, id_of


# ── compositor ──────────────────────────────────────────────────────────────


class _Grid:
    """voxel hash over covered texels for fastener / weld proximity queries"""

    def __init__(self, pos, cov_idx, cell=0.04):
        self.cell = cell
        self.P = pos[cov_idx]
        self.idx = cov_idx
        k = np.floor(self.P / cell).astype(np.int64) + 4096
        self.key = (k[:, 0] * 8192 + k[:, 1]) * 8192 + k[:, 2]
        self.order = np.argsort(self.key, kind='stable')
        self.sk = self.key[self.order]

    def box(self, lo, hi):
        c = self.cell
        k0 = np.floor(np.array(lo) / c).astype(np.int64) + 4096
        k1 = np.floor(np.array(hi) / c).astype(np.int64) + 4096
        xs, ys, zs = np.meshgrid(np.arange(k0[0], k1[0] + 1), np.arange(k0[1], k1[1] + 1), np.arange(k0[2], k1[2] + 1), indexing='ij')
        keys = np.unique(((xs * 8192 + ys) * 8192 + zs).ravel())
        left = np.searchsorted(self.sk, keys, 'left')
        right = np.searchsorted(self.sk, keys, 'right')
        sel = [self.order[a:b] for a, b in zip(left, right) if b > a]
        if not sel:
            return np.empty(0, dtype=np.int64)
        return np.concatenate(sel)  # indices into self.P / self.idx


def _norm(ch, cov):
    v = ch[cov]
    m, s = float(v.mean()), float(v.std()) + 1e-6
    return (ch - m) / s


def composite(slot, data, id_of, pieces, size):
    POS = data['POS'][..., :3]
    NRM = data['NRM'][..., :3]
    MASK, PAT, NOISE, AUX, AO = data['MASK'], data['PAT'], data['NOISE'], data['AUX'], data['AO'][..., 0]
    lid = np.rint(MASK[..., 2] * 255.0).astype(np.int32)
    n_looks = len(id_of)
    cov = (lid > 0) & (lid <= n_looks)
    lid = np.where(cov, lid, 0)
    names = [None] * (n_looks + 1)
    for name, i in id_of.items():
        names[i] = name

    def lut_col(key):
        t = np.zeros((n_looks + 1, 3), dtype=np.float32)
        for i in range(1, n_looks + 1):
            t[i] = hex_lin(LK.look(names[i])[key])
        return t[lid]

    def lut(key):
        t = np.zeros(n_looks + 1, dtype=np.float32)
        for i in range(1, n_looks + 1):
            t[i] = float(LK.look(names[i])[key])
        return t[lid]

    a1 = np.clip(PAT[..., 0], 0, 1)[..., None]
    a2 = np.clip(PAT[..., 1], 0, 1)[..., None]
    col = lerp(lerp(lut_col('base'), lut_col('alt1'), a1), lut_col('alt2'), a2)
    rough = lerp(lut('rough'), lut('rough_alt'), a1[..., 0])
    metal = lut('metal').copy()
    height = PAT[..., 2] * 1e-3  # mm → m

    edge = np.clip(MASK[..., 0], 0, 1)
    cav = np.clip(MASK[..., 1], 0, 1)
    nf, nm, nl = (_norm(NOISE[..., i], cov) for i in range(3))
    wear = AUX[..., 0]
    livery = AUX[..., 1]
    streakn = _norm(AUX[..., 2], cov)
    up = NRM[..., 2]
    ao = np.clip(AO, 0, 1)

    convex = edge * smooth(0.55, 0.9, cav)
    # edge wear: a broken band along convex edges (wear follows use: edges, not open faces)
    ew = smooth(0.5, 0.75, convex * 1.3 + nm * 0.18 + nf * 0.12) * lut('edge') * np.clip(wear, 0, 1.5)
    # repaint chips: hard-edged flakes, denser near edges, amount-driven threshold
    chips_amt = lut('chips') * wear
    # livery chips cluster at the band edges, not across the middle (STYLE-SPEC §5.2.3)
    liv_k = livery
    chip_field = (nl * 0.55 + nm * 0.35 + nf * 0.18) * (1.0 - 0.45 * liv_k) + convex * (1.2 + 1.0 * liv_k)
    thr = 2.2 - 1.6 * np.clip(chips_amt, 0, 1)
    ch = smooth(thr, thr + 0.08, chip_field) * (chips_amt > 0)
    reveal = np.clip(np.maximum(ew, ch), 0, 1)
    col = lerp(col, lut_col('under'), reveal[..., None])
    rough = lerp(rough, lut('rough_under'), reveal)
    metal = lerp(metal, lut('metal_under'), reveal)
    height -= ch * 0.00022
    # fine scratches: ridged high-frequency noise lines
    ridge = 1.0 - np.abs(np.tanh(nf * 0.9))
    sc = smooth(0.9, 0.985, ridge) * smooth(-0.2, 0.8, nm) * lut('scratch') * np.clip(wear, 0, 1.5)
    col = lerp(col, np.clip(col * 1.06 + 0.01, 0, 1), (sc * 0.25)[..., None])  # sub-cm: roughness/normal only
    rough = lerp(rough, np.maximum(rough, 0.5), sc * 0.8)
    height -= sc * 0.00003
    # casting / corrosion pits
    pit = smooth(1.35, 1.6, nf + nm * 0.4) * lut('pits')
    col = lerp(col, col * 0.55, (pit * 0.7)[..., None])
    rough = lerp(rough, 0.85, pit)
    height -= pit * 0.00015
    # grime: cavities + AO, broken by mid noise
    occl = np.clip((1.0 - cav) * 1.7 + (1.0 - ao) * 0.55, 0, 1)
    gr = occl * np.clip(0.6 + nm * 0.25, 0.2, 1.0) * lut('grime')
    col = lerp(col, col * hex_lin(GRIME) / 0.45, (gr * 0.35)[..., None])
    rough = lerp(rough, 0.75, gr * 0.35)
    # dried salt runs on vertical faces, broken up so they never read as regular stripes
    vs = smooth(1.2, 2.4, streakn) * smooth(0.0, 1.2, nm) * (1.0 - np.abs(up)) * lut('streaks') * np.clip(wear, 0, 1.5)
    col = lerp(col, hex_lin(SALT), (vs * 0.22)[..., None])
    rough = lerp(rough, 0.7, vs * 0.5)
    # salt crust: up-facing ledges and cavities, never dominant on open vertical faces
    salt_field = smooth(0.15, 0.75, up) * 0.35 + occl * 0.8 + nm * 0.15 + nl * 0.08
    sl = smooth(0.75, 1.1, salt_field) * lut('salt') * (0.55 + 0.45 * np.clip(wear, 0, 1.5))
    col = lerp(col, hex_lin(SALT), (sl * 0.7)[..., None])
    rough = lerp(rough, 0.9, sl * 0.9)
    metal = metal * (1.0 - sl * 0.9)
    height += sl * 0.00008 * np.clip(nf + 1.0, 0, 2)
    # sun fade on up-facing paint
    fd = np.clip(up, 0, 1) * lut('fade')
    col = lerp(col, hex_lin(SALT), fd[..., None])

    # fasteners (domes, rust halos + streaks) and welds (heat tint), body-frame lists → Blender frame
    idx = np.flatnonzero(cov.ravel())
    grid = _Grid(POS.reshape(-1, 3), idx) if idx.size else None
    colf = col.reshape(-1, 3)
    roughf = rough.reshape(-1)
    metalf = metal.reshape(-1)
    hf = height.reshape(-1)
    lidf = lid.reshape(-1)
    heat_look = np.array([0.0] + [float(LK.look(names[i])['heat']) for i in range(1, n_looks + 1)], dtype=np.float32)
    rust_look = np.array([0.0] + [float(LK.look(names[i])['rust']) for i in range(1, n_looks + 1)], dtype=np.float32)
    streakf = streakn.reshape(-1)
    nrmf = NRM.reshape(-1, 3)
    n_fast = 0
    for p in pieces:
        for (pos, nrm, r, kind, rusty) in p.fasteners:
            if grid is None:
                break
            c = np.array(kit.t2b(pos), dtype=np.float32)
            L = 0.16 if rusty else 0.0
            sel = grid.box(c - np.array([r * 2.2, r * 2.2, L + r * 2.2]), c + np.array([r * 2.2, r * 2.2, r * 2.2]))
            if sel.size == 0:
                continue
            n_fast += 1
            q = grid.P[sel]
            ii = grid.idx[sel]
            d = np.linalg.norm(q - c, axis=1)
            dome = np.clip(1.0 - (d / r) ** 2, 0, 1)
            hf[ii] += np.sqrt(dome) * r * (0.35 if kind == 'rivet' else 0.22)
            if kind == 'screw':
                # a slot across the head
                nv = np.array(kit.t2b(nrm), dtype=np.float32)
                ax = np.cross(nv, np.array([0, 0, 1], dtype=np.float32))
                ax = ax / (np.linalg.norm(ax) + 1e-6)
                slot_d = np.abs((q - c) @ ax)
                hf[ii] -= (slot_d < r * 0.14) * (d < r * 0.8) * r * 0.25
            rr = rust_look[lidf[ii]] * (1.0 if rusty else 0.25)
            if rr.max() <= 0:
                continue
            halo = smooth(r * 2.0, r * 0.9, d) * rr
            colf[ii] = lerp(colf[ii], hex_lin(RUST_DARK), (halo * 0.7)[:, None])
            if rusty:
                dz = c[2] - q[:, 2]
                dh = np.linalg.norm((q - c)[:, :2], axis=1)
                w = r * (0.8 + np.clip(dz, 0.0, L) * 5.0)
                vert = 1.0 - np.abs(nrmf[ii, 2])
                s = (dz > 0) * np.clip(1.0 - dz / L, 0.0, 1.0) ** 1.5 * smooth(w, w * 0.25, np.maximum(dh, 0.0)) * vert
                s *= np.clip(0.55 + 0.3 * streakf[ii], 0, 1) * rr
                colf[ii] = lerp(colf[ii], hex_lin(RUST), (s * 0.8)[:, None])
                roughf[ii] = lerp(roughf[ii], 0.85, s * 0.6)
                metalf[ii] *= (1.0 - s)
        for w in p.welds:
            if grid is None:
                break
            c = np.array(kit.t2b(w), dtype=np.float32)
            R = 0.035
            sel = grid.box(c - R, c + R)
            if sel.size == 0:
                continue
            q = grid.P[sel]
            ii = grid.idx[sel]
            hk = heat_look[lidf[ii]]
            t = np.linalg.norm(q - c, axis=1) / R
            tint = np.zeros((len(ii), 3), dtype=np.float32)
            for (t0, h0), (t1, h1) in zip(HEAT[:-1], HEAT[1:]):
                m = (t >= t0) & (t < t1)
                c0 = hex_lin(h0)
                c1 = hex_lin(h1) if h1 else c0
                f = ((t - t0) / (t1 - t0))[m][:, None]
                tint[m] = lerp(c0, c1, f)
            k = smooth(1.0, 0.7, t) * hk * 0.75
            colf[ii] = lerp(colf[ii], tint, k[:, None])
            roughf[ii] = lerp(roughf[ii], 0.4, k * 0.5)
            # bead ripples right at the weld
            hf[ii] += smooth(0.35, 0.0, t) * 0.0008 * (0.5 + 0.5 * np.cos(t * 60.0)) * hk
    col = colf.reshape(size, size, 3)
    rough = roughf.reshape(size, size)
    metal = metalf.reshape(size, size)
    height = hf.reshape(size, size)

    liv = np.clip(livery * (1.0 - reveal) * (1.0 - sl * 0.7), 0, 1)
    opacity = np.clip(lut('opacity') + sc * 0.25 + sl * 0.35 + gr * 0.2, 0, 1)
    alpha = opacity if slot == 'M_Perspex' else liv

    # height → tangent-space normal, slopes measured against the baked positions (true metres per
    # texel, so every tier gets physically consistent relief); island borders get no gradient
    covf = cov.astype(np.float32)
    nx = np.zeros((size, size), dtype=np.float32)
    ny = np.zeros((size, size), dtype=np.float32)
    dxp = np.linalg.norm(POS[:, 2:, :] - POS[:, :-2, :], axis=2)
    dyp = np.linalg.norm(POS[2:, :, :] - POS[:-2, :, :], axis=2)
    texel = np.median(dxp[cov[:, 1:-1] & cov[:, 2:] & cov[:, :-2]]) if cov.any() else 1.0
    okx = (covf[:, 2:] * covf[:, :-2] > 0) & (dxp < texel * 6) & (dxp > 1e-7)
    oky = (covf[2:, :] * covf[:-2, :] > 0) & (dyp < texel * 6) & (dyp > 1e-7)
    nx[:, 1:-1] = np.where(okx, (height[:, 2:] - height[:, :-2]) / np.maximum(dxp, 1e-7), 0)
    ny[1:-1, :] = np.where(oky, (height[2:, :] - height[:-2, :]) / np.maximum(dyp, 1e-7), 0)
    nx = np.clip(nx, -3, 3)
    ny = np.clip(ny, -3, 3)
    nz = np.ones_like(nx)
    ln = np.sqrt(nx * nx + ny * ny + nz * nz)
    normal = np.stack([-nx / ln, -ny / ln, nz / ln], axis=-1) * 0.5 + 0.5

    ao_out = np.clip(ao * lerp(1.0, cav, 0.35), 0, 1)
    orm = np.stack([ao_out, np.clip(rough, 0.04, 1.0), np.clip(metal, 0, 1)], axis=-1)
    base = np.concatenate([lin_srgb(col), alpha[..., None]], axis=-1)
    # outside coverage: neutral values keep mip averages sane
    base[~cov] = [0.5, 0.5, 0.5, 0.0]
    orm[~cov] = [1.0, 0.6, 0.0]
    normal[~cov] = [0.5, 0.5, 1.0]
    for label, arr in (('baseColor', base), ('orm', orm), ('normal', normal)):
        bad = int(np.count_nonzero(~np.isfinite(arr)))
        if bad:
            raise SystemExit(f'[parts] {slot} {label}: {bad} non-finite texels out of the compositor')
    stats = {'fasteners': n_fast, 'coverage': round(float(cov.mean()), 3), 'texelMetres': float(texel) / 2}
    return base, orm, normal, stats


def downsample(arr, scale):
    """2×2 box filter per halving (deterministic); scale 1 returns the array untouched"""
    while scale < 0.99:
        h, w = arr.shape[:2]
        arr = arr.reshape(h // 2, 2, w // 2, 2, arr.shape[2]).mean(axis=(1, 3))
        scale *= 2
    return arr


def save_rgba(name, arr, work, non_color):
    h, w = arr.shape[:2]
    img = bpy.data.images.new(name, width=w, height=h, alpha=True, float_buffer=False)
    img.colorspace_settings.name = 'Non-Color' if non_color else 'sRGB'
    if arr.shape[2] == 3:
        arr = np.concatenate([arr, np.ones((h, w, 1), dtype=arr.dtype)], axis=-1)
    q = np.round(np.clip(arr, 0, 1) * 255.0) / 255.0
    img.pixels.foreach_set(q.astype(np.float32).ravel())
    path = os.path.join(work, name + '.png')
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)
    loaded = bpy.data.images.load(path)
    loaded.name = name
    # alpha is DATA (livery mask / perspex opacity): straight alpha would premultiply the colour away
    loaded.alpha_mode = 'CHANNEL_PACKED'
    loaded.colorspace_settings.name = 'Non-Color' if non_color else 'sRGB'
    return loaded
