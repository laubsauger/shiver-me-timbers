"""
Hero hull textures: Cycles CPU data bakes + a deterministic numpy compositor (docs/speedboat/hull-log.md).

ONE atlas (hero_hull.UVLayout) shared by both hull slots, so the hull adds 4 + 1 textures in total:

  hull_baseColor  2048² sRGB   M_Gelcoat islands: RGB = OVERLAY colour (chips, filler, salt, algae, plates,
                               stains…), A = overlay coverage over the livery paint.
                               M_NonSlip islands: RGB = deck colour (charcoal non-skid, bone borders, wear),
                               A = non-skid coverage (where the tiling detail normal applies)
  hull_orm        1024² linear R occlusion, G roughness, B metal
  hull_normal     2048² linear tangent-space detail (chips, crust, rivets, hatch gaps, panel steps)
  hull_mask       1024² linear M_Gelcoat only (carried as KHR_materials_clearcoat.clearcoatTexture):
                               R livery band field, G pinstripe field, B antifoul (boot) field — each 0.5 at the
                               paint edge (signed distance, so edges stay crisp at any resolution);
                               A wear ramp (exposure). Over the deck row (never sampled by M_Gelcoat) R holds
                               the 0–9 stencil glyph strip for the hand-painted race number
  hull_nonslip_detail 512² linear tiling moulded non-skid normal (M_NonSlip, clearcoatNormalTexture carrier)

The runtime (src/speedboat/assets/slotMaterials.ts) turns mask + base into the per-boat livery; the
previews below evaluate the SAME formula per texel (hull_preview_*), so the CPU renders show what
the game draws for each fleet livery.
"""
import json
import math
import os
import time

import bpy
import numpy as np

import hero_hull as HH

# ── palette (STYLE-SPEC §4) ──────────────────────────────────────────────────


def hex_lin(h):
    h = h.lstrip('#')
    c = np.array([int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)], dtype=np.float32)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4).astype(np.float32)


def lin_srgb(c):
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.0031308, 12.92 * c, 1.055 * np.power(c, 1 / 2.4) - 0.055)


FLEET = {
    # STYLE-SPEC §4.2 (+ numeral colour: black on light topsides, bone on charcoal)
    'hero': {'topsides': '#E9E5DA', 'band': '#E4572E', 'stripe': '#1F4E5F', 'antifoul': '#6B2E25', 'numeral': '#151B1C', 'number': 27},
    'yellow': {'topsides': '#2B2F33', 'band': '#E8B420', 'stripe': '#C8372D', 'antifoul': '#6B2E25', 'numeral': '#E9E5DA', 'number': 8},
    'turquoise': {'topsides': '#3E8C8A', 'band': '#F2E6C8', 'stripe': '#2B2F33', 'antifoul': '#1E1F21', 'numeral': '#151B1C', 'number': 41},
    'charcoal': {'topsides': '#2B2F33', 'band': '#E9E5DA', 'stripe': '#E4572E', 'antifoul': '#1E1F21', 'numeral': '#E9E5DA', 'number': 63},
}
CHALK = hex_lin('#E4DFD3')
SALT = hex_lin('#D9D3C4')
RAW_GLASS = hex_lin('#BFB59A')
RAW_GLASS_DARK = hex_lin('#9C937A')
OLD_GEL = hex_lin('#D8D2C3')
FILLER = hex_lin('#C9BFA6')
PRIMER = hex_lin('#A8A49B')
AF_PRIMER = hex_lin('#7E7B75')
AF_OLD = hex_lin('#4E5862')
ALGAE = hex_lin('#6E7A3C')
RUST = hex_lin('#7A4526')
RUST_DARK = hex_lin('#4A2A18')
ALU = hex_lin('#A7ADB0')
ALU_OXIDE = hex_lin('#D3D4CD')
SEALANT = hex_lin('#BDB8AE')
BRONZE = hex_lin('#8C6A3A')
VERDIGRIS = hex_lin('#5F7A66')
SCUFF = hex_lin('#85817A')
CHARCOAL = hex_lin('#3A3D40')
CHARCOAL_WORN = hex_lin('#5C5A55')
BONE_DECK = hex_lin('#DCD5C5')
GAP_DARK = hex_lin('#1C1D1E')
CRACK = hex_lin('#4E4A43')

WEAR_LEVEL = 0.85            # hero (STYLE-SPEC §4.2); rivals share the maps, the ramp is exported for a runtime threshold
BAND_SCALE, STRIPE_SCALE, BOOT_SCALE = 0.16, 0.06, 0.16
OVERSPRAY = (0.40, 0.50, 0.35)
NUMERAL_WEAR = (0.45, 0.52)


def smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    return a + (b - a) * t


# ── bakes ────────────────────────────────────────────────────────────────────


class _N:
    def __init__(self, nt):
        self.nt = nt

    def math(self, op, a, b=None, clamp=False):
        n = self.nt.nodes.new('ShaderNodeMath')
        n.operation = op
        n.use_clamp = clamp
        for i, v in enumerate((a, b)):
            if v is None:
                continue
            if isinstance(v, (int, float)):
                n.inputs[i].default_value = v
            else:
                self.nt.links.new(v, n.inputs[i])
        return n.outputs[0]

    def combine(self, r, g, b):
        n = self.nt.nodes.new('ShaderNodeCombineXYZ')
        for i, v in enumerate((r, g, b)):
            if isinstance(v, (int, float)):
                n.inputs[i].default_value = v
            else:
                self.nt.links.new(v, n.inputs[i])
        return n.outputs[0]

    def noise(self, vec, scale, detail, rough):
        n = self.nt.nodes.new('ShaderNodeTexNoise')
        n.inputs['Scale'].default_value = scale
        n.inputs['Detail'].default_value = detail
        n.inputs['Roughness'].default_value = rough
        self.nt.links.new(vec, n.inputs['Vector'])
        return n.outputs['Fac']


def _pass_material(name, img, build):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    em = nt.nodes.new('ShaderNodeEmission')
    em.inputs['Strength'].default_value = 1.0
    nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
    sock = build(nt, _N(nt))
    if sock is not None:
        nt.links.new(sock, em.inputs['Color'])
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = img
    nt.nodes.active = tex
    return mat


def bake(hull_obj, size, ao_samples):
    scene = bpy.context.scene
    scene.world = scene.world or bpy.data.worlds.new('bake_world')
    scene.world.light_settings.distance = 1.2

    def geo(nt):
        return nt.nodes.new('ShaderNodeNewGeometry')

    def p_pos(nt, N):
        return geo(nt).outputs['Position']

    def p_nrm(nt, N):
        return geo(nt).outputs['Normal']

    def p_edge(nt, N):
        g = geo(nt)
        bev = nt.nodes.new('ShaderNodeBevel')
        bev.samples = 8
        bev.inputs['Radius'].default_value = 0.008
        dot = nt.nodes.new('ShaderNodeVectorMath')
        dot.operation = 'DOT_PRODUCT'
        nt.links.new(bev.outputs['Normal'], dot.inputs[0])
        nt.links.new(g.outputs['Normal'], dot.inputs[1])
        edge = N.math('MULTIPLY', N.math('SUBTRACT', 1.0, dot.outputs['Value']), 5.0, clamp=True)
        ao = nt.nodes.new('ShaderNodeAmbientOcclusion')
        ao.only_local = True
        ao.samples = 12
        ao.inputs['Distance'].default_value = 0.05
        attr = nt.nodes.new('ShaderNodeAttribute')
        attr.attribute_type = 'GEOMETRY'
        attr.attribute_name = 'sb_island'
        isl = N.math('DIVIDE', attr.outputs['Fac'], 10.0)
        return N.combine(edge, ao.outputs['AO'], isl)

    def p_noise(nt, N):
        P = geo(nt).outputs['Position']
        return N.combine(N.noise(P, 55.0, 4.0, 0.55), N.noise(P, 9.0, 5.0, 0.6), N.noise(P, 1.6, 3.0, 0.5))

    def p_voro(nt, N):
        g = geo(nt)
        v1 = nt.nodes.new('ShaderNodeTexVoronoi')
        v1.feature = 'F1'
        v1.inputs['Scale'].default_value = 11.0
        nt.links.new(g.outputs['Position'], v1.inputs['Vector'])
        v2 = nt.nodes.new('ShaderNodeTexVoronoi')
        v2.feature = 'F1'
        v2.inputs['Scale'].default_value = 5.0
        nt.links.new(g.outputs['Position'], v2.inputs['Vector'])
        sep = nt.nodes.new('ShaderNodeSeparateColor')
        nt.links.new(v2.outputs['Color'], sep.inputs['Color'])
        vm = nt.nodes.new('ShaderNodeVectorMath')
        vm.operation = 'MULTIPLY'
        vm.inputs[1].default_value = (38.0, 38.0, 1.2)
        nt.links.new(g.outputs['Position'], vm.inputs[0])
        streak = N.noise(vm.outputs['Vector'], 1.0, 3.0, 0.6)
        return N.combine(v1.outputs['Distance'], sep.outputs['Red'], streak)

    def p_scr(nt, N):
        g = geo(nt)

        def lines(rot_deg, scale):
            mp = nt.nodes.new('ShaderNodeMapping')
            mp.inputs['Rotation'].default_value = (math.radians(rot_deg), 0.0, math.radians(rot_deg * 0.5))
            mp.inputs['Scale'].default_value = scale
            nt.links.new(g.outputs['Position'], mp.inputs['Vector'])
            return N.noise(mp.outputs['Vector'], 1.0, 2.0, 0.5)
        return N.combine(lines(22.0, (140.0, 2.5, 140.0)), lines(-31.0, (120.0, 3.0, 120.0)), N.noise(g.outputs['Position'], 0.9, 2.0, 0.5))

    def p_long(nt, N):
        # noise in HULL-SHAPED coordinates: across = fraction of the chine half-beam (vertex attribute sb_frac), along =
        # hull length (Blender -Y). Streaks follow the strakes and converge to the bow like real flow marks
        g = geo(nt)
        attr = nt.nodes.new('ShaderNodeAttribute')
        attr.attribute_type = 'GEOMETRY'
        attr.attribute_name = 'sb_frac'
        sep = nt.nodes.new('ShaderNodeSeparateXYZ')
        nt.links.new(g.outputs['Position'], sep.inputs['Vector'])
        side = N.math('SIGN', sep.outputs['X'])
        frac = N.math('MULTIPLY', attr.outputs['Fac'], side)

        def field(k_across, k_along, detail):
            v = N.combine(N.math('MULTIPLY', frac, k_across), N.math('MULTIPLY', sep.outputs['Y'], k_along), N.math('MULTIPLY', sep.outputs['Z'], 3.0))
            return N.noise(v, 1.0, detail, 0.5)
        return N.combine(field(90.0, 0.9, 2.0), field(16.0, 0.45, 3.0), field(5.0, 0.25, 2.0))

    passes = [('POS', p_pos, 1), ('NRM', p_nrm, 1), ('EDGE', p_edge, 8), ('NOISE', p_noise, 1), ('VORO', p_voro, 1), ('SCR', p_scr, 1), ('LONG', p_long, 1),
              ('AO', None, ao_samples)]
    originals = [s.material for s in hull_obj.material_slots]
    out = {}
    for name, build, spp in passes:
        t0 = time.time()
        img = bpy.data.images.new(f'__hull_{name}', width=size, height=size, alpha=True, float_buffer=True)
        img.colorspace_settings.name = 'Non-Color'
        img.generated_color = (0, 0, 0, 0)
        if build is None:
            mats = [_pass_material(f'__hb_{name}_{i}', img, lambda nt, N: None) for i in range(len(originals))]
        else:
            mats = [_pass_material(f'__hb_{name}_{i}', img, build) for i in range(len(originals))]
        for i, m in enumerate(mats):
            hull_obj.material_slots[i].material = m
        for o in bpy.context.view_layer.objects:
            o.select_set(False)
        hull_obj.select_set(True)
        bpy.context.view_layer.objects.active = hull_obj
        scene.cycles.samples = spp
        bpy.ops.object.bake(type='AO' if name == 'AO' else 'EMIT', margin=max(4, size // 256), margin_type='EXTEND', use_clear=True,
                            target='IMAGE_TEXTURES')
        a = np.empty(size * size * 4, dtype=np.float32)
        img.pixels.foreach_get(a)
        out[name] = a.reshape(size, size, 4)
        hull_obj.select_set(False)
        for m in mats:
            bpy.data.materials.remove(m)
        bpy.data.images.remove(img)
        print(f'[hull] bake {name} ({size}², {spp} spp) {time.time() - t0:.1f}s')
    for i, m in enumerate(originals):
        hull_obj.material_slots[i].material = m
    return out


# ── glyphs: hand-painted stencil numerals (STYLE-SPEC §4.3 (a), concept 14a) ─


def _raster_tris(tris, w, h, scale, off):
    cov = np.zeros((h, w), dtype=np.float32)
    for (a, b, c) in tris:
        pts = [((p[0] * scale[0] + off[0]), (p[1] * scale[1] + off[1])) for p in (a, b, c)]
        x0 = max(int(math.floor(min(p[0] for p in pts))), 0)
        x1 = min(int(math.ceil(max(p[0] for p in pts))), w - 1)
        y0 = max(int(math.floor(min(p[1] for p in pts))), 0)
        y1 = min(int(math.ceil(max(p[1] for p in pts))), h - 1)
        if x1 < x0 or y1 < y0:
            continue
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        (ax, ay), (bx, by), (cx, cy) = pts
        d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if abs(d) < 1e-12:
            continue
        l1 = ((by - cy) * (xs - cx) + (cx - bx) * (ys - cy)) / d
        l2 = ((cy - ay) * (xs - cx) + (ax - cx) * (ys - cy)) / d
        l3 = 1 - l1 - l2
        inside = (l1 >= 0) & (l2 >= 0) & (l3 >= 0)
        cov[y0:y1 + 1, x0:x1 + 1] = np.maximum(cov[y0:y1 + 1, x0:x1 + 1], inside.astype(np.float32))
    return cov


def _blur(a, sigma):
    r = int(math.ceil(sigma * 3))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2).astype(np.float32)
    k /= k.sum()
    pad = np.pad(a, r, mode='edge')
    tmp = np.apply_along_axis(lambda m: np.convolve(m, k, mode='valid'), 1, pad)
    return np.apply_along_axis(lambda m: np.convolve(m, k, mode='valid'), 0, tmp)


def _seg(X, Y, ax, ay, bx, by, h):
    dx, dy = bx - ax, by - ay
    ln = math.hypot(dx, dy)
    ux, uy = dx / ln, dy / ln
    px, py = X - ax, Y - ay
    along = px * ux + py * uy
    perp = -px * uy + py * ux
    return np.maximum(np.abs(along - ln / 2) - ln / 2, np.abs(perp) - h)


def _arc(X, Y, cx, cy, r, a0, a1, h):
    """ring segment from angle a0 to a1 (degrees, CCW), butt ends"""
    dist = np.sqrt((X - cx) ** 2 + (Y - cy) ** 2)
    ring = np.abs(dist - r) - h
    ang = (np.degrees(np.arctan2(Y - cy, X - cx)) - a0) % 360.0
    span = (a1 - a0) % 360.0 or 360.0
    return np.where(ang <= span, ring, 1.0)


def _gap(X, Y, x0, x1, y0, y1):
    """sdf of an axis box (the stencil bridge cut)"""
    return np.maximum(np.maximum(x0 - X, X - x1), np.maximum(y0 - Y, Y - y1))


def stencil_digit_sdf(d, X, Y):
    """owned bold stencil numerals in a unit box x ∈ [0, 0.6], y ∈ [0, 1] (y up), stroke 0.17 (concept 14a)"""
    h = 0.085
    u = np.minimum
    if d == 9:
        return stencil_digit_sdf(6, 0.6 - X, 1.0 - Y)
    if d == 0:
        s = u(u(_seg(X, Y, h, 0.30, h, 0.70, h), _seg(X, Y, 0.6 - h, 0.30, 0.6 - h, 0.70, h)),
              u(_arc(X, Y, 0.30, 0.70, 0.215, 0, 180, h), _arc(X, Y, 0.30, 0.30, 0.215, 180, 360, h)))
        cut = u(_gap(X, Y, 0.275, 0.325, 0.78, 1.1), _gap(X, Y, 0.275, 0.325, -0.1, 0.22))
    elif d == 1:
        s = u(_seg(X, Y, 0.38, 0.0, 0.38, 1.0, h), _seg(X, Y, 0.38, 0.93, 0.08, 0.72, 0.075))
        cut = _gap(X, Y, 0.27, 0.30, 0.76, 0.93)
    elif d == 2:
        a = math.radians(-35)
        ex, ey = 0.30 + 0.215 * math.cos(a), 0.70 + 0.215 * math.sin(a)
        s = u(u(_arc(X, Y, 0.30, 0.70, 0.215, -35, 175, h), _seg(X, Y, ex, ey, 0.07, 0.10, h)), _seg(X, Y, 0.0, h, 0.60, h, h))
        cut = _gap(X, Y, 0.40, 0.44, -0.1, 0.25)
    elif d == 3:
        s = u(_arc(X, Y, 0.29, 0.74, 0.195, -90, 165, h), _arc(X, Y, 0.29, 0.285, 0.24, -165, 90, h))
        cut = _gap(X, Y, 0.0, 0.26, 0.50, 0.555)
    elif d == 4:
        s = u(u(_seg(X, Y, 0.40, 1.0, 0.02, 0.33, 0.08), _seg(X, Y, 0.0, 0.30, 0.60, 0.30, h)), _seg(X, Y, 0.47, 0.0, 0.47, 0.78, h))
        cut = _gap(X, Y, 0.38, 0.56, 0.37, 0.43)
    elif d == 5:
        s = u(u(_seg(X, Y, 0.05, 1.0 - h, 0.58, 1.0 - h, h), _seg(X, Y, 0.10, 1.0, 0.10, 0.55, h)),
              _arc(X, Y, 0.30, 0.325, 0.23, -150, 125, h))
        cut = _gap(X, Y, -0.1, 0.22, 0.555, 0.60)
    elif d == 6:
        s = u(u(_arc(X, Y, 0.30, 0.30, 0.215, 0, 360, h), _seg(X, Y, h, 0.30, h, 0.70, h)), _arc(X, Y, 0.30, 0.70, 0.215, 30, 180, h))
        cut = u(_gap(X, Y, 0.275, 0.325, -0.1, 0.20), _gap(X, Y, -0.1, 0.2, 0.34, 0.39))
    elif d == 7:
        s = u(_seg(X, Y, 0.0, 1.0 - h, 0.60, 1.0 - h, h), _seg(X, Y, 0.56, 0.90, 0.18, 0.0, 0.09))
        cut = _gap(X, Y, 0.42, 0.62, 0.78, 0.83)
    else:  # 8
        s = u(_arc(X, Y, 0.30, 0.745, 0.18, 0, 360, h), _arc(X, Y, 0.30, 0.285, 0.215, 0, 360, h))
        cut = u(u(_gap(X, Y, 0.275, 0.325, 0.86, 1.1), _gap(X, Y, 0.275, 0.325, -0.1, 0.17)), _gap(X, Y, -0.1, 0.15, 0.49, 0.53))
    return np.maximum(s, -cut)


def glyph_strip(cell_w, cell_h, digit_w=0.40, digit_h=0.60):
    """10 digit cells (0-9), each cell_w × cell_h px over digit_w × digit_h metres: a soft field, 0.5 at the
    painted edge (analytic stencil SDF + brush roughness + drips), row 0 = bottom"""
    unit = 0.54
    ox, oy = (digit_w - 0.6 * unit) / 2, 0.055
    ramp = 3.0 * digit_h / cell_h
    cells = []
    for d in range(10):
        rows, cols = np.mgrid[0:cell_h, 0:cell_w].astype(np.float32)
        xm = (cols + 0.5) / cell_w * digit_w
        ym = (rows + 0.5) / cell_h * digit_h
        X, Y = (xm - ox) / unit, (ym - oy) / unit
        sdf = stencil_digit_sdf(d, X, Y) * unit
        rng = np.random.RandomState(1000 + d)
        # drips under 1–2 bottom stroke ends (hand-painted over a stencil)
        base_cols = np.flatnonzero((stencil_digit_sdf(d, np.linspace(0, 0.6, 61), np.full(61, 0.03)) < 0))
        for _ in range(1 + (d % 2)):
            if base_cols.size == 0:
                break
            xu = base_cols[rng.randint(base_cols.size)] / 60.0 * 0.6
            ln = 0.022 + 0.022 * rng.rand()
            drip = _seg(X, Y, xu, 0.02, xu, -ln / unit * unit / unit, 0.012 / unit) * unit
            bulb = (np.sqrt((X - xu) ** 2 + (Y + ln / unit) ** 2) - 0.013 / unit) * unit
            sdf = np.minimum(sdf, np.minimum(drip, bulb))
        n = _blur(rng.rand(cell_h, cell_w).astype(np.float32), 1.0)
        n = (n - n.mean()) / (n.std() + 1e-6)
        # weathering (≤ 20 % of the paint, §5.2.4): flaked chips, denser toward the bottom of the digit
        blobs = _blur(np.random.RandomState(500 + d).rand(cell_h, cell_w).astype(np.float32), 2.2)
        blobs = (blobs - blobs.mean()) / (blobs.std() + 1e-6)
        chip = smooth(1.55, 1.9, blobs + 0.5 * (1.0 - rows / cell_h))
        field = 0.5 - sdf / ramp + 0.06 * n - 0.6 * chip
        cells.append(np.clip(field, 0, 1))
    return np.concatenate(cells, axis=1)


# ── non-skid detail (tiling, M_NonSlip) ─────────────────────────────────────


def nonskid_detail(size, tile_m):
    """moulded diamond non-skid (REFERENCES e6, scaled down, gelcoat-moulded): raised rounded diamonds"""
    pitch = tile_m / 12.0
    ys, xs = np.mgrid[0:size, 0:size].astype(np.float32)
    u = xs / size * tile_m
    v = ys / size * tile_m
    a = (u + v) / pitch
    b = (u - v) / pitch
    fa = np.abs(a - np.round(a))
    fb = np.abs(b - np.round(b))
    dist = np.maximum(fa, fb)          # 0 at the diamond centre, 0.5 at the groove
    hgt = smooth(0.46, 0.22, dist) * 0.0006
    rng = np.random.RandomState(9)
    n = _blur(rng.rand(size, size).astype(np.float32), 1.5)
    n = np.roll(n, (size // 3, size // 5), axis=(0, 1))
    hgt += (n - n.mean()) * 0.0012
    texel = tile_m / size
    gx = (np.roll(hgt, -1, axis=1) - np.roll(hgt, 1, axis=1)) / (2 * texel)
    gy = (np.roll(hgt, -1, axis=0) - np.roll(hgt, 1, axis=0)) / (2 * texel)
    gx, gy = np.clip(gx, -2, 2), np.clip(gy, -2, 2)
    ln = np.sqrt(gx * gx + gy * gy + 1)
    return np.stack([-gx / ln, -gy / ln, 1 / ln], axis=-1) * 0.5 + 0.5


# ── compositor ───────────────────────────────────────────────────────────────


def _norm(ch, cov):
    v = ch[cov]
    return (ch - float(v.mean())) / (float(v.std()) + 1e-6)


def _over(C, A, c, a):
    """paint layer c with coverage a over (C, A) (straight alpha)"""
    a = np.clip(a, 0.0, 1.0)[..., None]
    A3 = A[..., None]
    out_a = a + A3 * (1 - a)
    out_c = (c * a + C * A3 * (1 - a)) / np.maximum(out_a, 1e-6)
    return out_c, out_a[..., 0]


def composite(H, D, size, anchors):
    t0 = time.time()
    pos = D['POS'][..., :3]
    cov = D['POS'][..., 3] > 0.5
    hx = pos[..., 0]
    hy = pos[..., 2] + H.vcg
    hz = -pos[..., 1] + H.lcg
    ny = D['NRM'][..., 2]
    nxb = D['NRM'][..., 0]
    edge = np.clip(D['EDGE'][..., 0], 0, 1)
    cav = np.clip(D['EDGE'][..., 1], 0, 1)
    isl = np.rint(D['EDGE'][..., 2] * 10).astype(np.int32)
    nf = _norm(D['NOISE'][..., 0], cov)
    nm = _norm(D['NOISE'][..., 1], cov)
    nl = _norm(D['NOISE'][..., 2], cov)
    vd = np.clip(D['VORO'][..., 0], 0, 1)
    vr = D['VORO'][..., 1]
    streak = _norm(D['VORO'][..., 2], cov)
    ao = np.clip(D['AO'][..., 0], 0, 1)

    shell = cov & ((isl == HH.ISLAND_SHELL_P) | (isl == HH.ISLAND_SHELL_S))
    transom = cov & (isl == HH.ISLAND_TRANSOM)
    plate_isl = cov & (isl == HH.ISLAND_PLATE)
    decknum = cov & (isl == HH.ISLAND_DECK_NUMBER)
    gel = shell | transom | plate_isl | decknum
    deck = cov & (isl == HH.ISLAND_DECK)
    well = cov & (isl == HH.ISLAND_WELL)
    ns = deck | well

    # station functions per texel
    tz = np.array(H.tz, dtype=np.float32)
    zc = np.clip(hz, 0.0, H.Lk)
    b = np.interp(zc, tz, np.array([s['chineHalfBeam'] for s in H.st], dtype=np.float32))
    cy = np.interp(zc, tz, np.array([s['chineY'] for s in H.st], dtype=np.float32))
    ky = np.interp(zc, tz, np.array([s['keelY'] for s in H.st], dtype=np.float32))
    dy = H.dy
    L = H.stem_z
    ax_ = np.abs(hx)
    side = np.sign(hx)

    # ── livery fields (M_Gelcoat) ─────────────────────────────────────────
    d = dy - hy
    zn = np.clip(hz / L, 0, 1)
    # heights from the live JSON topside (hero_hull livery layout): nothing here assumes a freeboard
    band_lo = H.band_lo(zn)
    # edge wobble only at ≥ 10 cm wavelengths: finer noise baked into the 1024² SDF aliases into a serrated edge (V48)
    sd_band = band_lo - d + 0.003 * nm
    stripe_c = H.stripe_centre(zn)
    st_half = H.stripe_t / 2
    sd_stripe = st_half - np.abs(d - stripe_c) + 0.0015 * nm
    k = 0.05
    boot_y = H.boot_y(cy)
    del k
    # clear topside between the pinstripe and the boot line, as a 0..1 fraction (0 = under the stripe)
    clear_d0 = stripe_c + st_half
    clear_h = np.maximum((dy - boot_y) - clear_d0, 0.05)
    fd = (d - clear_d0) / clear_h
    sd_boot = boot_y - hy + 0.004 * nm

    # exposure ramp: edges, chines, stem, keel, transom corners, sheer, spray zone (wear follows use, §5.4).
    # Open panels stay near 0 (no random speckle); impact clusters come from the large noise only.
    dch = np.sqrt((ax_ - b) ** 2 + (hy - (cy - 0.035)) ** 2)
    e_chine = np.exp(-dch / 0.045)
    e_keel = np.exp(-ax_ / 0.035) * (hy < ky + 0.2)
    e_stem = smooth(10.6, 11.9, hz) * np.exp(-np.maximum(ax_ - 0.02, 0) / 0.07)
    e_trans = np.where(transom, edge, np.exp(-np.maximum(hz, 0) / 0.05))
    e_sheer = np.exp(-np.maximum(d, 0) / 0.035)
    e_spray = smooth(8.0, 11.0, hz) * np.exp(-np.maximum(hy - cy, 0) / 0.18)
    cluster = smooth(0.6, 1.8, nl + 0.45 * nm)
    W = (0.60 * edge + 0.62 * e_chine + 0.45 * e_keel + 0.32 * e_stem + 0.45 * e_trans + 0.35 * e_sheer + 0.25 * e_spray
         + 0.30 * cluster + 0.05 * nf + 0.04 * nm)
    W = np.clip(W, 0, 1)
    # the foredeck number panel is a recent repaint that only gets walked on: light, clustered wear
    W = np.where(decknum, np.clip(0.10 + 0.22 * cluster + 0.04 * nf, 0, 0.4), W)
    cell = 1.0 - 2.0 * vd
    thr = 1.02 - 0.35 * WEAR_LEVEL
    chip_v = W + 0.20 * cell + 0.05 * nf - thr
    chips = smooth(0.0, 0.012, chip_v) * gel
    chip_ring = np.clip(smooth(-0.03, -0.004, chip_v) - chips, 0, 1) * gel

    flake_b = smooth(-0.06, -0.04, W + 0.25 * cell - thr) * (np.abs(sd_band) < 0.035)
    speck = smooth(0.2, 0.9, 0.5 + 0.45 * nm + 0.2 * nl)
    R = 0.5 + np.clip(sd_band / BAND_SCALE, -0.5, 0.5)
    w_in = smooth(0.0, 0.02, sd_band)
    w_out = smooth(0.0, -0.02, sd_band)
    R = R - 0.22 * flake_b * w_in - 0.12 * (1 - speck) * w_out
    flake_s = smooth(-0.06, -0.04, W + 0.25 * cell - thr) * (np.abs(sd_stripe) < 0.03)
    G = 0.5 + np.clip(sd_stripe / STRIPE_SCALE, -0.5, 0.5) - 0.3 * flake_s * smooth(0.0, 0.008, sd_stripe)
    B = 0.5 + np.clip(sd_boot / BOOT_SCALE, -0.5, 0.5)
    band_m = smooth(0.47, 0.53, R) * (gel & ~decknum)
    boot_m = smooth(0.47, 0.53, B) * (gel & ~decknum)
    scr_a = smooth(0.985, 0.998, 1.0 - np.abs(2.0 * D['SCR'][..., 0] - 1.0))
    scr_b = smooth(0.985, 0.998, 1.0 - np.abs(2.0 * D['SCR'][..., 1] - 1.0))
    scr_zone = smooth(0.4, 1.6, _norm(D['SCR'][..., 2], cov) + 0.3 * nm)
    scratches = np.clip(np.maximum(scr_a, 0.7 * scr_b) * scr_zone, 0, 1) * gel

    # ── overlays over the paint (M_Gelcoat) ───────────────────────────────
    C = np.zeros((size, size, 3), dtype=np.float32)
    A = np.zeros((size, size), dtype=np.float32)
    rough = np.full((size, size), 0.3, dtype=np.float32)
    metal = np.zeros((size, size), dtype=np.float32)
    height = np.zeros((size, size), dtype=np.float32)
    topside = gel & (boot_m < 0.5)
    # base paint roughness: satin gelcoat, satin band paint, matte antifoul; chalky on up-facing and aft
    chalk = np.clip(0.04 + 0.08 * np.clip(ny, 0, 1) + 0.035 * nl + 0.03 * (1 - zn), 0, 0.16) * topside
    rough = np.where(gel, lerp(0.26 + 0.10 * band_m, 0.86, boot_m) + 0.9 * chalk + 0.03 * nm, rough)
    C, A = _over(C, A, CHALK, chalk * (1 - 0.6 * band_m))
    # antifoul sun bleach: broad and soft
    bleach = np.clip(0.05 + 0.14 * smooth(-0.6, 1.6, nl + 0.4 * nm), 0, 0.22) * boot_m
    C, A = _over(C, A, hex_lin('#B3AAA0'), 0.8 * bleach)
    older = smooth(0.9, 1.7, -nl + 0.5 * nm) * boot_m
    C, A = _over(C, A, hex_lin('#2C2826'), 0.22 * older)
    rough = rough + 0.06 * older - 0.04 * bleach
    # decal ghosts: chalk silhouettes of old speed chevrons aft of the number (both sides), §5.3
    gz = hz - 1.4
    gd = (fd - 0.3) * clear_h
    gh = 0.4 * clear_h
    ghost = np.zeros_like(A)
    for i in range(3):
        u = gz - i * 0.42 - 0.9 * gd
        ghost = np.maximum(ghost, ((u > 0) & (u < 0.26) & (gd > 0) & (gd < gh) & (hz < 3.4)).astype(np.float32))
    C, A = _over(C, A, CHALK, 0.045 * ghost * shell * smooth(-0.5, 0.8, nm))
    # repaint panels: fresher bone with soft overspray edges (livery-independent: mismatched panels, §5.5)
    panels = [(-1, 5.9, 7.6, 0.10, 0.95), (1, 2.6, 4.0, 0.05, 0.90), (1, 8.4, 9.6, 0.10, 0.80)]
    for (sgn, z0, z1, f0, f1) in panels:
        inside = np.minimum.reduce([hz - z0, z1 - hz, (fd - f0) * clear_h, (f1 - fd) * clear_h]) + 0.012 * nm
        pm = smooth(-0.02, 0.03, inside) * (side == sgn) * shell * (boot_m < 0.5)
        C, A = _over(C, A, hex_lin('#F1EDE3'), 0.05 * pm)
        rough = np.where(pm > 0.5, rough - 0.05, rough)
    # dried salt runs down the topsides from the sheer and fittings
    runs = smooth(1.0, 2.2, streak) * smooth(-0.2, 1.2, nm) * (1 - np.abs(ny)) * topside * np.exp(-np.maximum(d, 0) / 0.8)
    C, A = _over(C, A, hex_lin('#E6E1D5'), 0.2 * runs * (1 - 0.5 * band_m))
    # tea staining down the topsides under the stainless cleats (REFERENCES h4)
    for (cz, inset) in ((0.35, 0.16), (6.4, 0.14)):
        tea = np.exp(-np.abs(hz - cz) / 0.03) * smooth(0.0, 0.06, d) * np.exp(-np.maximum(d - 0.05, 0) / 0.35) * shell * np.clip(0.6 + 0.35 * streak, 0, 1)
        C, A = _over(C, A, hex_lin('#8E6242'), 0.32 * tea)
    rough = rough + 0.15 * runs
    # fine scratches: lighter lines, clustered; on the band they read as the white scratch webs of concept 09
    C, A = _over(C, A, lerp(CHALK, hex_lin('#FFFFFF'), 0.3), 0.16 * scratches * (0.5 + 0.5 * band_m) * (1 - boot_m))
    rough = rough + 0.18 * scratches
    # dock scuffs at fender height
    scuff = smooth(1.4, 2.2, _norm(0.6 * streak + 0.8 * nf + 0.4 * nm, cov)) * (fd > 0.15) * (fd < 0.55) * shell * smooth(0.3, 1.2, nl)
    C, A = _over(C, A, SCUFF, 0.28 * scuff)
    # grounding scrapes and flow streaks along the bottom (lighter, drier, rougher lines; concept 01c)
    scrape_l = smooth(0.965, 0.995, 1.0 - np.abs(2.0 * D['LONG'][..., 0] - 1.0))
    scrape_zone = smooth(0.2, 1.3, _norm(D['LONG'][..., 1], cov) + 0.4 * nl) * (1.0 - 0.6 * smooth(-0.3, 0.3, hy - (ky + 0.35)))
    scrapes = scrape_l * scrape_zone * boot_m
    C, A = _over(C, A, hex_lin('#9A928A'), 0.38 * scrapes)
    rough = rough + 0.08 * scrapes
    height -= 0.00012 * scrapes
    flow = smooth(0.6, 1.9, _norm(D['LONG'][..., 1], cov)) * boot_m
    C, A = _over(C, A, hex_lin('#2E2A28'), 0.18 * flow)
    # antifoul tone: repainted and faded panels in hull-shaped bands, plus broad sun/wet mottling
    tone = _norm(D['LONG'][..., 2], cov)
    C, A = _over(C, A, hex_lin('#7B3429'), 0.30 * smooth(0.5, 1.4, tone) * boot_m)
    C, A = _over(C, A, hex_lin('#9B6A5E'), 0.26 * smooth(-0.5, -1.4, tone) * boot_m)
    C, A = _over(C, A, hex_lin('#3D221E'), 0.20 * smooth(0.9, 1.8, nl - 0.5 * tone) * boot_m)
    rough = rough - 0.08 * smooth(0.5, 1.4, tone) * boot_m
    # strake running-edge wear: the antifoul is worn to primer along each strake's outer edge and the chine flat edge
    strake_w = np.zeros_like(A)
    for sd_ in H.strakes:
        fade = 1.0 - smooth(sd_['toZ'] - 0.6, sd_['toZ'], hz)
        x_edge = sd_['atChineFraction'] * b + np.maximum(0.004, sd_['flatWidth'] * fade)
        strake_w = np.maximum(strake_w, smooth(0.016, 0.004, np.abs(ax_ - x_edge)) * (hy < ky + (x_edge + 0.1) * 1.2) * (fade > 0.05))
    strake_w = np.maximum(strake_w, smooth(0.016, 0.004, np.abs(ax_ - b)) * (hy < cy + 0.01))
    edge_wear = strake_w * smooth(-0.4, 0.9, _norm(D['LONG'][..., 0], cov) + 0.4 * nm) * boot_m
    C, A = _over(C, A, lerp(hex_lin('#A08A80'), PRIMER, 0.4), 0.7 * edge_wear)
    rough = lerp(rough, 0.9, edge_wear)
    height -= 0.00015 * edge_wear
    # antifoul wear at the edges it runs on: strakes, chines, keel, forefoot
    afw = smooth(0.58, 0.86, W + 0.12 * cell + 0.05 * nm) * boot_m
    C, A = _over(C, A, lerp(AF_PRIMER, AF_OLD, smooth(-0.5, 0.8, nl)[..., None]), 0.75 * afw)
    rough = rough + 0.05 * afw
    # fairing-compound repairs (REFERENCES f3, h3): a masked, sanded filler core with a slightly different gloss,
    # a thin shrink line at the core edge, and a wide feathered sanding zone of dulled, swirled paint around it.
    # Few of them, placed by topside fraction (clear of the race number) so a freeboard change moves them too.
    nzc = H.number_field['zCentre']
    patches = [(1, 7.0, 0.55, 0.26, 0.14), (-1, 2.9, 0.45, 0.20, 0.12), (1, 9.7, 0.50, 0.15, 0.10)]
    swirl = np.clip(np.maximum(scr_a, scr_b) * 1.4 + 0.3 * smooth(0.2, 1.4, nf), 0, 1)
    for (sgn, pz, pf, rz, ryy) in patches:
        if abs(pz - nzc) < 0.8:
            raise SystemExit(f'[hull] fairing patch at z {pz} overlaps the race number at z {nzc:.2f}')
        s_pz = H.at(pz)
        cy_p = s_pz['chineY']
        boot_p = float(H.boot_y(cy_p))
        d0 = H.stripe_bottom_depth(pz)
        py = boot_p + (1.0 - pf) * ((dy - d0) - boot_p)
        ryy = min(ryy, 0.3 * ((dy - d0) - boot_p))
        du = (hz - pz) / rz
        dv = (hy - py) / ryy
        r = (np.abs(du) ** 5 + np.abs(dv) ** 5) ** 0.2 + 0.035 * nm      # masked: squarish, straight-ish edges
        m = (side == sgn) * shell
        core = smooth(1.0, 0.975, r) * m
        rim = np.clip(smooth(1.02, 0.995, r) - core, 0, 1) * m
        rf = np.sqrt(du * du + dv * dv * (rz / ryy) ** 2) / 1.0 + 0.10 * nm
        feather = smooth(1.9, 1.05, rf) * (1 - core) * m
        C, A = _over(C, A, hex_lin('#EEE9DD'), 0.30 * feather * (0.6 + 0.4 * swirl))
        C, A = _over(C, A, hex_lin('#A89F8B'), 0.35 * rim)
        C, A = _over(C, A, lerp(hex_lin('#D7CEB9'), hex_lin('#CBC1AA'), smooth(-1, 1, nf)[..., None]), 0.88 * core)
        rough = lerp(rough, 0.55 + 0.1 * swirl, feather * 0.8)
        rough = np.where(core > 0.5, 0.62 + 0.05 * nf, rough)
        height += 0.0001 * core - 0.00003 * feather * swirl
    # one repair on the bottom: grey barrier-coat primer in a sanded antifoul halo
    bpz, bgx = 5.9, 0.55
    du = (hz - bpz) / 0.28
    dv = (ax_ - bgx) / 0.16
    r = (np.abs(du) ** 5 + np.abs(dv) ** 5) ** 0.2 + 0.04 * nm
    m = (side < 0) * shell * (boot_m > 0.5)
    core = smooth(1.0, 0.97, r) * m
    feather = smooth(1.6, 1.02, np.sqrt(du * du + dv * dv) + 0.1 * nm) * (1 - core) * m
    C, A = _over(C, A, hex_lin('#9A6A5E'), 0.35 * feather)
    C, A = _over(C, A, hex_lin('#8E8A82'), 0.9 * core)
    rough = np.where(core > 0.5, 0.8, lerp(rough, 0.9, feather))
    # transom repair, under the band
    ty = dy - H.stripe_bottom_depth(0.0) - 0.16
    du = (hx - 0.70) / 0.15
    dv = (hy - ty) / 0.09
    r = (np.abs(du) ** 5 + np.abs(dv) ** 5) ** 0.2 + 0.04 * nm
    tpatch = smooth(1.0, 0.97, r) * transom
    tfeather = smooth(1.7, 1.03, np.sqrt(du * du + dv * dv) + 0.1 * nm) * (1 - tpatch) * transom
    C, A = _over(C, A, hex_lin('#EEE9DD'), 0.3 * tfeather)
    C, A = _over(C, A, hex_lin('#D7CEB9'), 0.88 * tpatch)
    rough = np.where(tpatch > 0.5, 0.62, rough)
    # chips to the laminate (fibreglass mottle), with a lighter old-gelcoat ring
    mott = smooth(-0.8, 0.9, nf)
    chip_col = np.where(boot_m[..., None] > 0.5, lerp(AF_PRIMER, PRIMER, 0.35), lerp(RAW_GLASS, RAW_GLASS_DARK, mott[..., None]))
    C, A = _over(C, A, np.where(boot_m[..., None] > 0.5, AF_OLD, OLD_GEL), 0.5 * chip_ring * (1 - band_m * 0.5))
    deep = chips * np.where(band_m > 0.5, smooth(0.03, 0.06, chip_v), 1.0)
    C, A = _over(C, A, chip_col, deep)
    rough = np.where(deep > 0.5, 0.72 + 0.08 * nf, rough)
    height -= 0.00045 * deep
    # algae line (≤ 8 cm) and the salt crust band just above the waterline (§5.2.6)
    wl = hy - boot_y
    # scum line: a thin brown-grey film right at the rest waterline, under the algae and the crust
    scum = np.exp(-((wl - 0.004) / 0.012) ** 2) * np.clip(0.55 + 0.45 * nf, 0, 1) * gel * (hz < 11.2)
    C, A = _over(C, A, hex_lin('#5F574A'), 0.55 * scum)
    rough = lerp(rough, 0.6, scum * 0.5)
    algae = np.exp(-((wl + 0.01) / 0.022) ** 2) * np.clip(0.5 + 0.5 * nm, 0, 1) * gel * (hz < 11.2)
    C, A = _over(C, A, ALGAE, 0.5 * algae)
    rough = lerp(rough, 0.55, algae * 0.6)
    crust_n = smooth(-0.3, 1.1, nm + 0.6 * nf)
    crust = (1.0 - smooth(0.0, 0.07, wl)) * (wl > -0.008) * crust_n * gel * (hz < 11.2)
    C, A = _over(C, A, SALT, 0.65 * crust)
    rough = lerp(rough, 0.93, crust)
    height += 0.0005 * crust * np.clip(nf + 1.2, 0, 2.4)
    lime = smooth(1.3, 2.0, nl + 0.5 * nm) * boot_m * (1.0 - smooth(-0.35, -0.02, -wl))
    C, A = _over(C, A, hex_lin('#CFCBBE'), 0.22 * lime)
    # barnacle scars near the transom and along the chine on the bottom
    zone = (hz < 1.4) | (dch < 0.12)
    scar = smooth(0.16, 0.11, vd) * (vr > 0.94) * boot_m * zone
    ring = np.clip(scar - smooth(0.10, 0.06, vd) * (vr > 0.94) * boot_m * zone, 0, 1)
    C, A = _over(C, A, hex_lin('#D6D0C2'), 0.6 * ring)
    height += 0.0006 * ring

    # ── salvage plates (on their islands AND painted on the shell texels under them, for LOD1/2) ─
    def plate_sd(p):
        y_top = np.interp(zc, tz, np.array([H.plate_outline(p, z, 0.0) for z in H.tz], dtype=np.float32))
        y_bot = np.interp(zc, tz, np.array([H.plate_outline(p, z, 1.0) for z in H.tz], dtype=np.float32))
        fr = np.clip((y_top - hy) / np.maximum(y_top - y_bot, 1e-3), 0, 1)
        z_fwd = p['z1'] - p['rake'] * fr
        sd = np.minimum.reduce([hz - p['z0'], z_fwd - hz, y_top - hy, hy - y_bot])
        return sd * (side == p['side'])

    fasteners = []
    under_plate = np.zeros((size, size), dtype=bool)
    for p in H.plates:
        sd = plate_sd(p)
        # the LOD0 slab occludes these shell texels in the AO bake; LOD1/2 draw them as the plate
        under_plate |= (sd > -0.004) & shell
        on = (sd > 0) & (shell | plate_isl)
        on_isl = plate_isl & (side == p['side']) & (hz > p['z0'] - 0.02) & (hz < p['z1'] + 0.02)
        pm = np.maximum(on.astype(np.float32), on_isl.astype(np.float32))
        grain = smooth(0.3, 0.9, 0.5 + 0.2 * nf)
        oxide = smooth(0.8, 1.8, 0.7 * nf + 0.5 * nm) * 0.7
        pcol = lerp(ALU * (1.02 + 0.04 * grain[..., None]), ALU_OXIDE, (0.5 * oxide)[..., None])
        # oil-canning: the thin sheet dishes between the rivet rows (low, broad relief, darker in the hollows)
        can = smooth(-1.2, 1.2, nm + 0.35 * nl)
        pcol = pcol * (0.93 + 0.1 * can[..., None])
        # feathered filler around the doubler (STYLE-SPEC §5.3), then the sealant squeeze-out bead
        if 'd_top' in p:
            feather = smooth(0.05, 0.012, np.abs(sd) + 0.012 * nm) * (sd < 0) * shell * (side == p['side'])
            C, A = _over(C, A, FILLER, 0.55 * feather)
            rough = lerp(rough, 0.7, feather * 0.6)
        seal = smooth(0.010, 0.002, np.abs(sd) - 0.002 + 0.0015 * nf) * shell * (side == p['side'])
        C, A = _over(C, A, lerp(SEALANT, hex_lin('#8F8A80'), smooth(-0.5, 1.2, nm)[..., None]), 0.9 * seal)
        rough = lerp(rough, 0.8, seal)
        height += 0.0009 * seal
        C = np.where(pm[..., None] > 0.5, pcol, C)
        A = np.where(pm > 0.5, 1.0, A)
        rough = np.where(pm > 0.5, 0.42 + 0.25 * oxide + 0.02 * nf, rough)
        metal = np.where(pm > 0.5, 0.75 - 0.5 * oxide, metal)
        height = np.where(pm > 0.5, height + 0.0011 * can, height)
        # the same rivet pattern the LOD0 geometry carries (hero_hull.plate_rivets): steel pop rivets on the chine
        # plate bleed rust; monel/alu rivets on the doubler bleed white oxide and dark galvanic streaks
        for (z, y) in H.plate_rivets(p):
            fasteners.append((p['side'], z, y, p['name'] == 'chine_plate'))
    # rivet domes (texture relief for LOD1/2) + bleed (vectorised on a local subset around the plates)
    near_plates = np.zeros((size, size), dtype=bool)
    for p in H.plates:
        near_plates |= (hz > p['z0'] - 0.05) & (hz < p['z1'] + 0.05)
    sel = np.flatnonzero(((shell | plate_isl) & (side < 0) & near_plates).ravel())
    hzf, hyf = hz.ravel()[sel], hy.ravel()[sel]
    Cf, Af = C.reshape(-1, 3)[sel], A.ravel()[sel]
    hgt_f = np.zeros(sel.size, dtype=np.float32)
    rust_s = np.zeros(sel.size, dtype=np.float32)
    salt_s = np.zeros(sel.size, dtype=np.float32)
    galv_s = np.zeros(sel.size, dtype=np.float32)
    oxide_h = np.zeros(sel.size, dtype=np.float32)
    ring_s = np.zeros(sel.size, dtype=np.float32)
    stf = streak.ravel()[sel]
    for (sgn, z, y, rusty) in fasteners:
        dz = hzf - z
        dyv = hyf - y
        near = np.abs(dz) < 0.3
        if not near.any():
            continue
        r2 = dz * dz + dyv * dyv
        rr = np.sqrt(r2)
        dome = np.clip(1 - r2 / 0.0065 ** 2, 0, 1)
        hgt_f += np.sqrt(dome) * 0.0026
        ring_s = np.maximum(ring_s, smooth(0.0095, 0.0068, rr) * smooth(0.005, 0.0066, rr))
        run = (dyv < 0) & (dyv > -0.22) & (np.abs(dz) < 0.02)
        s = run * np.exp(-np.abs(dz) / 0.004) * np.clip(1 + dyv / 0.22, 0, 1) ** 1.4 * np.clip(0.4 + 0.5 * stf, 0, 1) * (np.sin(z * 37.0 + y * 11.0) > -0.3)
        halo = np.exp(-rr / 0.009)
        if rusty:
            rust_s = np.maximum(rust_s, np.maximum(s, 0.8 * halo))
        else:
            galv_s = np.maximum(galv_s, 0.7 * s)
            oxide_h = np.maximum(oxide_h, smooth(0.02, 0.007, rr))
            salt_s = np.maximum(salt_s, 0.35 * s)
    Cf, Af = _over(Cf[None], Af[None], hex_lin('#7E7A72'), 0.3 * ring_s[None])
    Cf, Af = _over(Cf, Af, RUST, 0.45 * rust_s[None])
    Cf, Af = _over(Cf, Af, hex_lin('#DCDDD6'), 0.55 * oxide_h[None])
    Cf, Af = _over(Cf, Af, hex_lin('#3E3B37'), 0.32 * galv_s[None])
    Cf, Af = _over(Cf, Af, SALT, 0.3 * salt_s[None])
    C.reshape(-1, 3)[sel] = Cf[0]
    A.ravel()[sel] = Af[0]
    height.ravel()[sel] += hgt_f
    rough.ravel()[sel] = np.maximum(rough.ravel()[sel], 0.8 * np.maximum(rust_s, oxide_h))
    metal.ravel()[sel] *= (1 - np.clip(rust_s + salt_s + galv_s + 0.6 * oxide_h, 0, 1))

    # transom: bronze drain plugs in the bottom corners, tea staining under the tow eyes
    bT = float(H.at(0.0)['chineHalfBeam'])
    for sgn in (1, -1):
        px_ = sgn * (bT - 0.13)
        py_ = dict((n, y) for (n, _, y) in H.half_section(0.0)[0])['chine_root'] + 0.08
        r = np.sqrt((hx - px_) ** 2 + (hy - py_) ** 2)
        plug = smooth(0.03, 0.024, r) * transom
        C = np.where(plug[..., None] > 0.5, lerp(BRONZE, VERDIGRIS, smooth(-0.5, 1.0, nm)[..., None]), C)
        A = np.where(plug > 0.5, 1.0, A)
        metal = np.where(plug > 0.5, 0.8, metal)
        rough = np.where(plug > 0.5, 0.45, rough)
        height += 0.004 * np.sqrt(np.clip(1 - (r / 0.028) ** 2, 0, 1)) * transom
        gstreak = (hy < py_) & (hy > py_ - 0.25) & (np.abs(hx - px_) < 0.02) * transom
        C, A = _over(C, A, VERDIGRIS, 0.4 * gstreak * np.exp(-np.abs(hx - px_) / 0.01))
        ex_, ey_ = sgn * (float(anchors.transom()['halfBeamTop']) - 0.22), dy - 0.16
        tea = (hy < ey_ - 0.03) & (hy > ey_ - 0.55) & (np.abs(hx - ex_) < 0.035) * transom
        C, A = _over(C, A, hex_lin('#8A5A35'), 0.35 * tea * np.clip(1 + (hy - ey_) / 0.55, 0, 1) * np.exp(-np.abs(hx - ex_) / 0.02) * np.clip(0.6 + 0.3 * streak, 0, 1))

    # ── deck / well (M_NonSlip): real colours, A = non-skid coverage ─────
    e2x = np.interp(zc, tz, np.array([_e2x(H, z) for z in H.tz], dtype=np.float32))
    ww_tab_z = np.linspace(H.well_aft, H.well_fwd_end, 200)
    ww = np.interp(hz, ww_tab_z, np.array([H.well_width(z) or 0.0 for z in ww_tab_z], dtype=np.float32), left=-1.0, right=-1.0)
    in_well_z = (hz >= H.well_aft) & (hz <= H.well_fwd_end)
    edge_dist = e2x - ax_
    well_dist = _well_plan_distance(H, ax_, hz, deck)
    nsk = np.ones((size, size), dtype=np.float32)
    nsk *= smooth(0.085, 0.095, edge_dist)          # bone margin along the deck edge
    nsk *= smooth(0.095, 0.105, well_dist)            # bone surround at the well lip
    hz0, hz1, hxh = 0.30, min(2.70, H.well_aft - 0.18), 0.80
    hatch_sd = np.maximum(np.abs(hx) - hxh, np.maximum(hz0 - hz, hz - hz1))
    nsk *= np.where(np.abs(hatch_sd) < 0.055, 0.0, 1.0)  # bone frame around the hatch gap
    nsk *= (hz > 0.22)                               # bone strip at the transom
    fh_z = H.L * (1 - anchors.extra['foredeckHatchFromBow'])
    fh_r = np.sqrt(hx ** 2 + (hz - fh_z) ** 2)
    nsk *= smooth(0.33, 0.345, fh_r)
    nsk *= smooth(0.008, 0.013, ax_) * (hz > H.well_fwd_end + 0.1) + (hz <= H.well_fwd_end + 0.1)  # foredeck centre seam
    nsk *= (hz < 11.45)
    dp = H.deck_panel
    panel_d = np.maximum(np.maximum(dp['z0'] - hz, hz - dp['z1']), ax_ - dp['half'])
    nsk *= smooth(0.055, 0.065, panel_d)             # bone frame round the painted number panel
    nsk = nsk * deck
    # well: bone walls, non-skid sole with a bone border
    sole = well & (hy < H.sole_y + 0.01)
    sole_wall_dist = np.where(in_well_z, ww - ax_, 0.0)
    nsk = np.where(sole, smooth(0.06, 0.07, sole_wall_dist) * smooth(0.05, 0.06, np.minimum(hz - H.well_aft, H.well_fwd_end - hz)), nsk)
    nsk = np.clip(nsk, 0, 1) * ns
    # colour
    DC = lerp(BONE_DECK, CHARCOAL, nsk[..., None])
    Dr = lerp(np.full_like(nsk, 0.42), np.full_like(nsk, 0.86), nsk)
    Dh = np.zeros_like(nsk)
    Dh += 0.0008 * nsk
    # chalky bone + faded charcoal
    DC = lerp(DC, CHALK, (0.12 * (1 - nsk) * np.clip(0.6 + 0.4 * nl, 0, 1))[..., None])
    DC = lerp(DC, CHARCOAL_WORN, (0.18 * nsk * smooth(-0.5, 1.4, nl))[..., None])
    # walk paths: along the well sides, over the hatch centre, forward along the side decks
    walk = (np.exp(-np.abs(ax_ - 0.98) / 0.12) * (hz > 1.5) * (hz < 6.0) + np.exp(-ax_ / 0.25) * (hz > 0.4) * (hz < 2.2)) * deck
    worn = smooth(0.45, 1.0, walk + 0.35 * nm + 0.15 * nf) * nsk
    DC = lerp(DC, CHARCOAL_WORN * 1.25, (0.55 * worn)[..., None])
    Dr = lerp(Dr, 0.62, worn * 0.6)
    nsk_a = nsk * (1 - 0.6 * worn)
    # hatch gap with salt in it, screws around the frame
    gap = smooth(0.0065, 0.003, np.abs(hatch_sd)) * deck
    DC = lerp(DC, GAP_DARK, gap[..., None])
    DC = lerp(DC, SALT, (gap * 0.35 * smooth(0.0, 1.0, nm))[..., None])
    Dh -= 0.004 * gap
    Dr = np.where(gap > 0.5, 0.9, Dr)
    fh_gap = smooth(0.006, 0.002, np.abs(fh_r - 0.275)) * deck
    DC = lerp(DC, GAP_DARK, (0.8 * fh_gap)[..., None])
    Dh -= 0.002 * fh_gap
    # vent cut-outs (under the clamshells) and filler/cleat/stanchion bases with rust halos + spider cracks
    bases = []
    for zh in (hz0 + (hz1 - hz0) * 0.38, hz0 + (hz1 - hz0) * 0.78):
        for sgn in (1, -1):
            cut = (np.abs(hx - sgn * 0.55) < 0.10) & (hz > zh - 0.17) & (hz < zh + 0.10) & deck
            DC = np.where(cut[..., None], GAP_DARK, DC)
            nsk_a = np.where(cut, 0.0, nsk_a)
            bases.append((sgn * 0.55, zh, 0.16, False))
    for x in (-0.55, 0.0, 0.55):
        bases.append((x, hz0 + 0.20, 0.07, True))
    for (zh, inset) in ((0.35, 0.16), (6.4, 0.14)):
        for sgn in (1, -1):
            bases.append((sgn * (anchors.sheer_half(zh) - inset), zh, 0.12, True))
    bases.append((0.0, 11.0, 0.12, True))
    W_ = anchors.cockpit_well()
    for sgn in (1, -1):
        for zz in (W_['zAft'] + 0.35 + H.lcg, W_['zFwd'] - 0.55 + H.lcg):
            bases.append((sgn * (W_['halfWidth'] + 0.10), zz, 0.05, True))
    for (bx, bz, br, cracks) in bases:
        r = np.sqrt((hx - bx) ** 2 + (hz - bz) ** 2)
        halo = np.exp(-np.maximum(r - br * 0.6, 0) / (0.35 * br)) * (r < br * 2.5) * ns
        DC = lerp(DC, lerp(RUST, RUST_DARK, 0.4), (0.45 * halo * np.clip(0.6 + 0.3 * nm, 0, 1))[..., None])
        Dr = lerp(Dr, 0.85, halo * 0.5)
        if cracks:
            a = np.arctan2(hz - bz, hx - bx)
            spokes = np.abs(np.sin(a * 5.0 + 2.0 * nl + bx * 7.0))
            crk = smooth(0.06, 0.0, spokes) * (r > br * 0.8) * (r < br * 3.2) * (1 - nsk) * deck
            DC = lerp(DC, CRACK, (0.7 * crk)[..., None])
            Dh -= 0.0002 * crk
    # salt crust in the corners of the well and along the lip, tea stains down the walls
    wall = well & ~sole
    DC = np.where(wall[..., None], lerp(hex_lin('#D6CFBF'), CHALK, (0.2 * smooth(-1, 1, nl))[..., None]), DC)
    Dr = np.where(wall, 0.36 + 0.08 * nm, Dr)
    boots = smooth(1.6, 2.6, streak + nm) * wall * np.exp(-np.maximum(hy - H.sole_y, 0) / 0.12)
    DC = lerp(DC, hex_lin('#6E6A62'), (0.25 * boots)[..., None])
    corner = np.exp(-np.maximum(hy - H.sole_y, 0) / 0.02) * wall
    DC = lerp(DC, SALT, (0.2 * corner * smooth(0.0, 1.2, nm))[..., None])
    drain = (np.abs(hx) < 0.12) & (np.abs(hz - (H.well_aft + 0.12)) < 0.035) & sole
    DC = np.where(drain[..., None], GAP_DARK, DC)
    nsk_a = np.where(drain, 0.0, nsk_a)
    # deck chips at the lip and the deck edge
    dchip = smooth(0.0, 0.02, 0.6 * edge + 0.25 * np.exp(-np.maximum(edge_dist, 0) / 0.03) + 0.16 * cell + 0.08 * nf - 0.55) * ns
    DC = lerp(DC, RAW_GLASS, dchip[..., None])
    Dh -= 0.0003 * dchip
    C = np.where(ns[..., None], DC, C)
    A = np.where(ns, nsk_a, A)
    rough = np.where(ns, Dr, rough)
    height = np.where(ns, height + Dh, height)

    # ── ORM, normal ────────────────────────────────────────────────────────
    occl = np.clip(ao * lerp(1.0, cav, 0.4), 0, 1)
    occl = np.where(under_plate, np.maximum(occl, 0.92), occl)
    rough = np.clip(rough, 0.05, 1.0)
    metal = np.clip(metal, 0, 1)
    texel_n = _height_normal(height, pos, cov, size)

    # ── mask (1024): fields + wear ramp, glyph strip over the deck row ────
    paintf = gel & ~decknum      # the deck number panel wears the topsides hue only
    mask2 = np.stack([np.where(paintf, R, 0.0), np.where(paintf, G, 0.0), np.where(paintf, B, 0.0), np.where(cov, W, 0.0)], axis=-1).astype(np.float32)
    msz = size // 2
    mask = mask2.reshape(msz, 2, msz, 2, 4).mean(axis=(1, 3))
    layout = H.uv_layout()
    gu0, gv0, gcw, gch = layout.glyph_rect(msz)
    cw_px, ch_px = int(round(gcw * msz)), int(round(gch * msz))
    strip = glyph_strip(cw_px, ch_px)
    px0, py0 = int(round(gu0 * msz)), int(round(gv0 * msz))
    mask[py0:py0 + ch_px, px0:px0 + 10 * cw_px, 0] = strip
    mask[py0:py0 + ch_px, px0:px0 + 10 * cw_px, 1:3] = 0.0
    glyph_info = {'u0': px0 / msz, 'v0': py0 / msz, 'cellW': cw_px / msz, 'cellH': ch_px / msz}

    # ── stats: livery legibility (§5.2) ───────────────────────────────────
    band_px = shell & (band_m > 0.5)
    stats = {
        'bandOverlayMean': round(float(A[band_px].mean()), 3) if band_px.any() else None,
        'bandCleanFraction': round(float((A[band_px] < 0.25).mean()), 3) if band_px.any() else None,
        'numberFieldOverlayMean': None,
        'deckNonSkidFraction': round(float(nsk[deck].mean()), 3) if deck.any() else None,
        'fasteners': len(fasteners),
        'seconds': round(time.time() - t0, 1),
    }
    nf_ = H.number_field
    in_num = shell & (np.abs(hz - nf_['zCentre']) < 0.45) & (np.abs(hy - nf_['yCentre']) < 0.3)
    if in_num.any():
        stats['numberFieldOverlayMean'] = round(float(A[in_num].mean()), 3)
        stats['numberFieldWornFraction'] = round(float((W[in_num] > NUMERAL_WEAR[0]).mean()), 3)
    out = {
        'base': np.concatenate([lin_srgb(C), A[..., None]], axis=-1),
        'orm': np.stack([occl, rough, metal], axis=-1),
        'normal': texel_n,
        'mask': mask,
        'glyph': glyph_info,
        'stats': stats,
        'cov': cov, 'gel': gel, 'ns': ns, 'pos': pos, 'decknum': decknum,
        'nxb': nxb,
    }
    return out


def _well_plan_distance(H, ax_, hz, where):
    """plan distance (m) from the cockpit opening outline, for texels near it (large elsewhere)"""
    zs = np.linspace(H.well_aft, H.well_fwd_end, 120)
    pts = [(0.0, H.well_aft)] + [(H.well_width(z), z) for z in zs] + [(0.0, H.well_fwd_end)]
    out = np.full(ax_.shape, 10.0, dtype=np.float32)
    near = where & (hz > H.well_aft - 0.3) & (hz < H.well_fwd_end + 0.3) & (ax_ < H.well_half + 0.3)
    idx = np.flatnonzero(near.ravel())
    px, pz = ax_.ravel()[idx], hz.ravel()[idx]
    best = np.full(idx.size, 10.0, dtype=np.float32)
    for (x0, z0), (x1, z1) in zip(pts[:-1], pts[1:]):
        dx, dz = x1 - x0, z1 - z0
        ln2 = dx * dx + dz * dz
        if ln2 < 1e-12:
            continue
        t = np.clip(((px - x0) * dx + (pz - z0) * dz) / ln2, 0, 1)
        best = np.minimum(best, np.hypot(px - (x0 + t * dx), pz - (z0 + t * dz)))
    out.ravel()[idx] = best
    return out


def _e2x(H, z):
    half, _, _ = H.half_section(min(z, H.z_x))
    return dict((n, x) for (n, x, _) in half)['edge_e2']


def _height_normal(height, pos, cov, size):
    covf = cov.astype(np.float32)
    nx = np.zeros((size, size), dtype=np.float32)
    ny = np.zeros((size, size), dtype=np.float32)
    dxp = np.linalg.norm(pos[:, 2:, :] - pos[:, :-2, :], axis=2)
    dyp = np.linalg.norm(pos[2:, :, :] - pos[:-2, :, :], axis=2)
    texel = float(np.median(dxp[cov[:, 1:-1] & cov[:, 2:] & cov[:, :-2]])) if cov.any() else 1.0
    okx = (covf[:, 2:] * covf[:, :-2] > 0) & (dxp < texel * 6) & (dxp > 1e-7)
    oky = (covf[2:, :] * covf[:-2, :] > 0) & (dyp < texel * 6) & (dyp > 1e-7)
    nx[:, 1:-1] = np.where(okx, (height[:, 2:] - height[:, :-2]) / np.maximum(dxp, 1e-7), 0)
    ny[1:-1, :] = np.where(oky, (height[2:, :] - height[:-2, :]) / np.maximum(dyp, 1e-7), 0)
    nx = np.clip(nx, -3, 3)
    ny = np.clip(ny, -3, 3)
    ln = np.sqrt(nx * nx + ny * ny + 1)
    n = np.stack([-nx / ln, -ny / ln, 1 / ln], axis=-1) * 0.5 + 0.5
    n[~cov] = [0.5, 0.5, 1.0]
    return n


# ── runtime-equivalent preview (slotMaterials.ts formula, per texel) ────────


def _sample_bilinear(img, u, v):
    """img HxWxC (row 0 = v 0), u/v in [0,1] arrays"""
    h, w = img.shape[:2]
    x = np.clip(u * w - 0.5, 0, w - 1.001)
    y = np.clip(v * h - 0.5, 0, h - 1.001)
    x0, y0 = np.floor(x).astype(np.int32), np.floor(y).astype(np.int32)
    fx, fy = (x - x0)[..., None], (y - y0)[..., None]
    a = img[y0, x0]
    b = img[y0, x0 + 1]
    c = img[y0 + 1, x0]
    d = img[y0 + 1, x0 + 1]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def _upsample2(img):
    """bilinear 2× (texel centres), as the GPU samples the half-resolution mask"""
    h, w = img.shape[:2]
    ys, xs = np.mgrid[0:2 * h, 0:2 * w].astype(np.float32)
    return _sample_bilinear(img, (xs + 0.5) / (2 * w), (ys + 0.5) / (2 * h))


def number_glyphs(n):
    n = int(n) % 100
    return [n] if n < 10 else [n // 10, n % 10]


def _upsample(img, f):
    """bilinear f× (texel centres), as a GPU samples a lower-resolution texture"""
    h, w = img.shape[:2]
    ys, xs = np.mgrid[0:f * h, 0:f * w].astype(np.float32)
    return _sample_bilinear(img, (xs + 0.5) / (f * w), (ys + 0.5) / (f * h))


def _aa(v):
    """the runtime aaStep: smoothstep(0.5 ∓ 0.75·fwidth) with fwidth taken per preview texel"""
    gy, gx = np.gradient(v)
    w = np.maximum(np.abs(gx) + np.abs(gy), 1e-4) * 0.75
    return smooth(0.5 - w, 0.5 + w, v)


def preview_albedo(H, T, size, livery, scale=2):
    """runtime formula (slotMaterials.ts hullLiveryAlbedo) per texel of a preview at `scale`× the atlas: paint from the
    bilinearly sampled mask SDFs with a derivative-width threshold, overlay by base alpha, both race numbers"""
    out = size * scale
    mask = T['mask']
    up = _upsample(mask, out // mask.shape[0])
    R, G, B, Wr = up[..., 0], up[..., 1], up[..., 2], up[..., 3]
    band, stripe, boot = _aa(R), _aa(G), _aa(B)
    over = smooth(OVERSPRAY[0], OVERSPRAY[1], R) * (1 - band) * OVERSPRAY[2]
    top, bnd, stp, af = (hex_lin(livery[k]) for k in ('topsides', 'band', 'stripe', 'antifoul'))
    paint = lerp(top, bnd, np.maximum(band, over)[..., None])
    paint = lerp(paint, stp, stripe[..., None])
    paint = lerp(paint, af, boot[..., None])
    base = _upsample(T['base'], scale)
    ov_rgb = np.where(base[..., :3] <= 0.04045, base[..., :3] / 12.92, ((base[..., :3] + 0.055) / 1.055) ** 2.4)
    alb = lerp(paint, ov_rgb, base[..., 3:4])
    del up, base
    pos = _upsample(T['pos'], scale)
    rep = lambda a: np.repeat(np.repeat(a, scale, axis=0), scale, axis=1)  # noqa: E731
    gel, nxb, decknum = rep(T['gel']), rep(T['nxb']), rep(T['decknum'])
    bx, by, bz = pos[..., 0], pos[..., 2], -pos[..., 1]
    del pos
    digits = number_glyphs(livery['number'])
    gi = T['glyph']
    g = np.zeros(bx.shape, dtype=np.float32)

    def paint_field(nfd, gx_m, gy_m, where):
        dw, gp, hh = nfd['digitWidth'], nfd['gap'], nfd['height']
        fw = dw * len(digits) + gp * (len(digits) - 1)
        gx = gx_m / fw + 0.5
        gy = gy_m / hh + 0.5
        infield = (gx >= 0) & (gx <= 1) & (gy >= 0) & (gy <= 1) & where
        res = np.zeros(bx.shape, dtype=np.float32)
        for i, dig in enumerate(digits):
            x0 = i * (dw + gp) / fw
            cx = (gx - x0) * fw / dw
            inside = infield & (cx >= 0) & (cx <= 1)
            u = gi['u0'] + (dig + np.clip(cx, 0, 1)) * gi['cellW']
            v = gi['v0'] + np.clip(gy, 0, 1) * gi['cellH']
            val = _sample_bilinear(mask[..., :1], u, v)[..., 0]
            res = np.where(inside, _aa(val), res)
        return res

    nfd = H.number_field
    s = np.where(bx >= 0, 1.0, -1.0)
    g = np.maximum(g, paint_field(nfd, -s * (bz - (nfd['zCentre'] - H.lcg)), by - (nfd['yCentre'] - H.vcg), (np.abs(nxb) > 0.5) & gel))
    dnf = H.deck_number_field
    g = np.maximum(g, paint_field(dnf, -bx - dnf['xCentre'], bz - (dnf['zCentre'] - H.lcg), decknum))
    g = g * (1 - smooth(NUMERAL_WEAR[0], NUMERAL_WEAR[1], Wr)) * (1 - boot)
    alb = lerp(alb, hex_lin(livery['numeral']), (0.97 * g)[..., None])
    alb = np.where(gel[..., None], alb, ov_rgb)
    return lin_srgb(alb)


def clearcoat_map(T, size):
    """runtime: coat = (1 − boot) · (1 − 0.9·overlay) · smoothstep(0.62, 0.25, roughness)"""
    up = _upsample2(T['mask'])
    boot = smooth(0.475, 0.525, up[..., 2])
    ormu = T['orm']
    if ormu.shape[0] != size:
        ormu = np.repeat(np.repeat(ormu, size // ormu.shape[0], axis=0), size // ormu.shape[1], axis=1)
    cc = (1 - boot) * (1 - 0.9 * T['base'][..., 3]) * smooth(0.62, 0.25, ormu[..., 1])
    return np.where(T['gel'], cc, 0.0)


# ── io ───────────────────────────────────────────────────────────────────────


def save_png(name, arr, work, non_color):
    h, w = arr.shape[:2]
    if arr.ndim == 2:
        arr = np.stack([arr, arr, arr], axis=-1)
    if arr.shape[2] == 3:
        arr = np.concatenate([arr, np.ones((h, w, 1), dtype=np.float32)], axis=-1)
    bad = int(np.count_nonzero(~np.isfinite(arr)))
    if bad:
        raise SystemExit(f'[hull] {name}: {bad} non-finite texels out of the compositor')
    img = bpy.data.images.new(name, width=w, height=h, alpha=True, float_buffer=False)
    img.colorspace_settings.name = 'Non-Color' if non_color else 'sRGB'
    q = np.round(np.clip(arr, 0, 1) * 255.0) / 255.0
    img.pixels.foreach_set(q.astype(np.float32).ravel())
    path = os.path.join(work, name + '.png')
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)
    loaded = bpy.data.images.load(path)
    loaded.name = name
    loaded.alpha_mode = 'CHANNEL_PACKED'
    loaded.colorspace_settings.name = 'Non-Color' if non_color else 'sRGB'
    return loaded, path


def downsample(arr, f):
    h, w = arr.shape[:2]
    return arr.reshape(h // f, f, w // f, f, *arr.shape[2:]).mean(axis=(1, 3))


def bake_and_texture(H, hull_obj, args, anchors, preview_variants=('hero', 'yellow', 'turquoise')):
    size = 1 << int(round(math.log2(max(64, args.bake_size * 2))))
    work = args.work
    D = bake(hull_obj, size, args.ao_samples)
    T = composite(H, D, size, anchors)
    del D
    print('[hull] composite ' + json.dumps(T['stats']))
    img_base, _ = save_png('hull_baseColor', T['base'], work, non_color=False)
    img_orm, _ = save_png('hull_orm', downsample(T['orm'], 2), work, non_color=True)
    img_n, _ = save_png('hull_normal', T['normal'], work, non_color=True)
    save_png('hull_mask', T['mask'], work, non_color=True)
    dsize = max(64, size // 4)
    save_png('hull_nonslip_detail', nonskid_detail(dsize, 0.10), work, non_color=True)
    layout = H.uv_layout()
    g = T['glyph']
    nfd = H.number_field
    gel_extras = {
        'hullLivery': {
            'about': 'M_Gelcoat: paint = mix(topsides, band, stripe, antifoul) by the mask fields (0.5 = edge); albedo = mix(paint, baseColor.rgb, baseColor.a); numeral from the glyph strip. src/speedboat/assets/slotMaterials.ts',
            'maskCarrier': 'KHR_materials_clearcoat.clearcoatTexture (R band field, G stripe field, B antifoul field, A wear ramp)',
            'overspray': list(OVERSPRAY),
            'numeralWear': list(NUMERAL_WEAR),
            'wearLevelBaked': WEAR_LEVEL,
            'numberField': {'zCentre': round(nfd['zCentre'] - H.lcg, 5), 'yCentre': round(nfd['yCentre'] - H.vcg, 5),
                            'height': nfd['height'], 'digitWidth': nfd['digitWidth'], 'gap': nfd['gap']},
            # the clear topside the number must stay inside (pinstripe bottom → boot line, body frame; checkGlb liveryErrors)
            'clearTopside': {'top': round(nfd['clearTop'] - H.vcg, 5), 'bottom': round(nfd['clearBottom'] - H.vcg, 5),
                             'zMin': round(nfd['zMin'] - H.lcg, 5), 'zMax': round(nfd['zMax'] - H.lcg, 5)},
            # foredeck race-number panel: glyph up = bow (+z), reading right = −x (as seen from aft and from above)
            'deckNumberField': {k: round(v - (H.lcg if k == 'zCentre' else 0.0), 5) for k, v in H.deck_number_field.items()},
            'deckPanel': {'zMin': round(H.deck_panel['z0'] - H.lcg, 5), 'zMax': round(H.deck_panel['z1'] - H.lcg, 5), 'halfWidth': H.deck_panel['half']},
            # glTF UV convention (v down): the strip's top edge
            'glyphAtlas': {'u0': round(g['u0'], 6), 'v0': round(1.0 - g['v0'] - g['cellH'], 6), 'cellW': round(g['cellW'], 6), 'cellH': round(g['cellH'], 6)},
            'clearcoat': 'coat = (1 - antifoul) * (1 - 0.9 * overlay) * smoothstep(0.62, 0.25, roughness)',
        }
    }
    ns_extras = {
        'nonSkid': {
            'about': 'M_NonSlip: albedo = baseColor.rgb; baseColor.a = non-skid coverage; detail normal (clearcoatNormalTexture carrier) tiled at uv * atlasMetres / tileMetres, whiteout-blended by coverage, faded out with distance',
            'atlasMetres': round(layout.S, 5), 'tileMetres': 0.10, 'fade': [4.0, 12.0],
        }
    }
    sidecar = {
        'M_Gelcoat': {'clearcoatTexture': 'hull_mask.png', 'clearcoatFactor': 1.0, 'clearcoatRoughness': 0.1, 'extras': gel_extras},
        'M_NonSlip': {'clearcoatNormalTexture': 'hull_nonslip_detail.png', 'clearcoatFactor': 0.0, 'extras': ns_extras},
        'stats': T['stats'],
        'atlas': {'size': size, 'metres': layout.S, 'pxPerM': round(size / layout.S, 1)},
    }
    with open(os.path.join(work, 'hull_textures.json'), 'w', encoding='utf-8') as f:
        json.dump(sidecar, f, indent=2)
    # previews for the CPU renders (never exported)
    orm_full = T['orm']
    save_png('hull_preview_gelcoat_orm', orm_full, work, non_color=True)
    save_png('hull_preview_nonslip_orm', orm_full, work, non_color=True)
    # the non-skid detail folded into the preview normal (the runtime blends it in the shader)
    save_png('hull_preview_gelcoat_normal', T['normal'], work, non_color=True)
    save_png('hull_preview_nonslip_normal', _preview_nonslip_normal(T, size, layout.S), work, non_color=True)
    save_png('hull_preview_gelcoat_clearcoat', clearcoat_map(T, size), work, non_color=True)
    for v in preview_variants:
        alb = preview_albedo(H, T, size, FLEET[v])
        save_png(f'hull_preview_{v}_gelcoat_albedo', alb, work, non_color=False)
        save_png(f'hull_preview_{v}_nonslip_albedo', T['base'][..., :3], work, non_color=False)
    return img_base, img_orm, img_n, sidecar


def _preview_nonslip_normal(T, size, atlas_m):
    """whiteout blend of the tiling detail (at its metric scale) into the atlas normal, weighted by coverage"""
    tile = 0.10
    dsz = 256
    det = nonskid_detail(dsz, tile)
    ys, xs = np.mgrid[0:size, 0:size].astype(np.float32)
    u = (xs + 0.5) / size * atlas_m / tile
    v = (ys + 0.5) / size * atlas_m / tile
    di = det[(np.floor(v * dsz).astype(np.int64)) % dsz, (np.floor(u * dsz).astype(np.int64)) % dsz]
    n1 = T['normal'] * 2 - 1
    n2 = di * 2 - 1
    k = (T['base'][..., 3] * T['ns'])[..., None]
    n = np.concatenate([n1[..., :2] + n2[..., :2] * k, n1[..., 2:3]], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n * 0.5 + 0.5
