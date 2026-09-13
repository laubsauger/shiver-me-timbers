"""
Course furniture build library (§T.187, docs/speedboat/circuit.md) — headless Blender, deterministic.

The course assets ride the SAME pipeline as the hero boat parts (§V95: import, never copy):
  scripts/blender/parts/kit.py     Geo / Piece / primitives / finish (weld, bevel, weighted normals)
  scripts/blender/parts/bake.py    per-slot atlas pack, Cycles CPU data bakes, numpy wear compositor
  scripts/blender/parts/looks.py   look recipes + PAT-pass pattern shaders
  scripts/blender/sb_conventions.py  frame, materials, texture sets, GLB export
What is course-specific lives here: the COURSE contract (src/circuit/assets/courseAssetContract.json),
the course looks (galvanised steel, signal paint, reflective tape, hazard/chequer bands, shingles,
brick, clapboard, corrugated tin, weathered timber, glazed insulators, lamp lenses), their pattern
shaders (registered on top of looks.py's dispatcher), variant nodes and LOD assembly.

A course module (gate_pole.py, …) exposes build(args) -> {'pieces': [Piece], 'extras': {...}} where each
Piece carries `.variant` (the instanced node it belongs to). Pieces are authored in the asset frame
(three.js metres, +Y up, +Z toward the approaching boats).
"""
import json
import math
import os
import sys
import time

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, '..'))
sys.path.insert(0, os.path.join(HERE, '..', 'parts'))
import kit  # noqa: E402
import bake as BK  # noqa: E402
import looks as LK  # noqa: E402
import sb_conventions as sb  # noqa: E402

CONTRACT_PATH = os.path.join(HERE, '..', '..', '..', 'src', 'circuit', 'assets', 'courseAssetContract.json')
SLOT_ORDER = ['C_Steel', 'C_Paint', 'C_Build', 'C_Lamp']

# STYLE-SPEC / design doc §8 palette
SIGNAL_ORANGE = '#FF6B1F'
HIVIS_YELLOW = '#E8B420'
LED_AMBER = '#F2B54A'
TAPE = '#DCE2E3'
GELCOAT = '#E9E5DA'
STENCIL = '#151B1C'
KONTIKI_RED = '#B2472A'
GRANITE = '#A9A39A'


def load_contract():
    with open(CONTRACT_PATH, 'r', encoding='utf-8') as f:
        return json.load(f)


# ── looks ────────────────────────────────────────────────────────────────────

L = LK._L
COURSE_LOOKS = {
    # C_Steel
    'galv_steel': L(base='#8E989A', alt1='#6F7778', rough=0.52, rough_alt=0.62, metal=0.75, under='#7A4526', rough_under=0.9,
                    metal_under=0.1, edge=0.55, scratch=0.35, grime=0.7, salt=0.8, rust=0.9, streaks=0.9, pits=0.6, pattern='galv'),
    'steel_painted_grey': L(base='#6E7471', rough=0.55, under='#7A4526', rough_under=0.9, edge=0.8, chips=0.45, scratch=0.4,
                            grime=0.6, salt=0.7, rust=1.0, streaks=0.8, pits=0.3, fade=0.15, pattern='cast'),
    'steel_black': L(base='#23272A', rough=0.5, under='#7A4526', rough_under=0.9, edge=0.7, chips=0.3, grime=0.5, salt=0.6,
                     rust=0.8, streaks=0.5, pattern='cast'),
    'tin_roof': L(base='#8A8D88', alt1='#6B4A34', rough=0.5, rough_alt=0.85, metal=0.7, under='#6E3F24', rough_under=0.95,
                  metal_under=0.0, edge=0.6, scratch=0.2, grime=0.8, salt=0.9, rust=1.0, streaks=1.0, pits=0.5, pattern='corrugated'),
    'tank_steel': L(base='#B4AEA2', alt1='#7A4A2E', rough=0.55, rough_alt=0.9, metal=0.3, under='#6E3F24', rough_under=0.95, edge=0.8,
                    chips=0.6, grime=0.7, salt=0.6, rust=1.0, streaks=1.2, fade=0.25, pattern='rust_bloom'),
    'chain': L(base='#5A5650', rough=0.8, metal=0.6, under='#6E3F24', edge=0.4, grime=0.9, salt=1.0, rust=1.0, pits=1.0, pattern='cast'),
    # C_Paint
    # STYLE-SPEC §5.2 legibility guards outrank the look: daymark paint keeps its chroma and value (chips cluster
    # on edges, fade and salt stay light), stencils and the chequer stay crisp. Faded and repaired, never dirty.
    'paint_signal': L(base=SIGNAL_ORANGE, rough=0.46, under='#B9B3A6', rough_under=0.8, edge=0.8, chips=0.28, scratch=0.35,
                      grime=0.12, salt=0.18, fade=0.06, streaks=0.35, rust=0.35, pattern='cast'),
    'paint_signal_board': L(base=SIGNAL_ORANGE, rough=0.42, under='#C9C2B2', rough_under=0.8, edge=0.9, chips=0.12, scratch=0.2,
                            grime=0.05, salt=0.06, fade=0.03, streaks=0.15, rust=0.2, pattern='cast'),
    'paint_hivis': L(base=HIVIS_YELLOW, rough=0.48, under='#8E8C84', rough_under=0.8, edge=0.8, chips=0.3, scratch=0.35, grime=0.15,
                     salt=0.2, fade=0.08, streaks=0.4, pattern='cast'),
    'paint_stencil': L(base=STENCIL, rough=0.62, under='#9A968C', edge=0.4, chips=0.08, grime=0.05, salt=0.05, fade=0.02, pattern='cast'),
    'paint_gelcoat': L(base=GELCOAT, rough=0.5, under='#8E8C84', edge=0.7, chips=0.35, grime=0.25, salt=0.25, fade=0.05, streaks=0.7,
                       rust=0.6, pattern='cast'),
    'tape_reflective': L(base=TAPE, alt1='#B9C0C2', rough=0.22, rough_alt=0.32, metal=0.2, under='#2C2F30', rough_under=0.7, edge=1.0,
                         chips=0.2, scratch=0.5, grime=0.08, salt=0.1, pattern='prism'),
    'hazard_band': L(base=HIVIS_YELLOW, alt1=STENCIL, rough=0.5, rough_alt=0.58, under='#8E8C84', rough_under=0.85, edge=0.8,
                     chips=0.3, scratch=0.3, grime=0.15, salt=0.25, fade=0.06, streaks=0.5, rust=0.5, pattern='hazard_diag'),
    'chequer_ring': L(base=GELCOAT, alt1=STENCIL, rough=0.5, rough_alt=0.6, under='#8E8C84', edge=0.8, chips=0.15, grime=0.08, salt=0.12,
                      fade=0.03, streaks=0.3, pattern='chequer_ring'),
    'chequer': L(base=GELCOAT, alt1=STENCIL, rough=0.5, rough_alt=0.6, under='#8E8C84', edge=0.8, chips=0.1, grime=0.05, salt=0.06,
                 fade=0.02, streaks=0.15, pattern='chequer'),
    'mast_bands': L(base=GELCOAT, alt1=KONTIKI_RED, rough=0.55, rough_alt=0.6, under='#7A4526', rough_under=0.9, edge=0.8, chips=0.4,
                    scratch=0.3, grime=0.2, salt=0.35, fade=0.12, streaks=0.9, rust=1.0, pits=0.4, pattern='mast_bands'),
    'rubber_black': L(base='#16181A', rough=0.85, under='#3A3C3E', edge=0.5, scratch=0.5, grime=0.3, salt=0.7, pattern='cast'),
    'foam_float': L(base='#E0662A', rough=0.75, under='#C9B79A', rough_under=0.95, edge=0.9, chips=0.45, grime=0.2, salt=0.35, fade=0.1,
                    streaks=0.5, pattern='cast'),
    'solar_cell': LK.LOOKS['solar_cell'],
    'teal_corrugated': L(base='#4F7F7C', alt1='#7A4A2E', rough=0.55, rough_alt=0.85, under='#9A968C', rough_under=0.8, edge=0.9, chips=0.45,
                         grime=0.25, salt=0.4, fade=0.12, streaks=0.9, rust=0.8, pattern='corrugated'),
    'paint_teal_faded': L(base='#4F7F7C', rough=0.6, under='#B8AFA0', rough_under=0.85, edge=0.8, chips=0.6, grime=0.6, salt=0.6,
                          fade=0.35, streaks=0.9, rust=0.6, pattern='cast'),
    # C_Build
    'shingles_cedar': L(base='#6B5847', alt1='#4B3E33', alt2='#8A7A63', rough=0.88, grime=0.8, salt=0.6, fade=0.25, pattern='shingles'),
    'shingles_slate': L(base='#4E5557', alt1='#3A4042', alt2='#6A7170', rough=0.75, grime=0.7, salt=0.7, fade=0.15, pattern='shingles'),
    'brick_red': L(base='#8A4B38', alt1='#B9B09F', alt2='#6E3A2C', rough=0.86, grime=0.8, salt=0.7, streaks=0.8, pattern='brick'),
    'clapboard_sage': L(base='#9AAE9F', alt1='#7E8F82', rough=0.72, under='#8A8174', rough_under=0.9, edge=0.9, chips=0.7, grime=0.7,
                        salt=0.6, fade=0.35, streaks=1.0, pattern='clapboard'),
    'clapboard_bone': L(base='#D9D0BC', alt1='#B8AE98', rough=0.72, under='#8A8174', rough_under=0.9, edge=0.9, chips=0.7, grime=0.7,
                        salt=0.6, fade=0.3, streaks=1.0, pattern='clapboard'),
    'clapboard_ochre': L(base='#C39A55', alt1='#A07C42', rough=0.72, under='#8A8174', rough_under=0.9, edge=0.9, chips=0.7, grime=0.7,
                         salt=0.6, fade=0.35, streaks=1.0, pattern='clapboard'),
    'clapboard_rust': L(base='#8E4A36', alt1='#733B2C', rough=0.72, under='#8A8174', rough_under=0.9, edge=0.9, chips=0.7, grime=0.7,
                        salt=0.6, fade=0.35, streaks=1.0, pattern='clapboard'),
    'timber_weathered': L(base='#8E857A', alt1='#6E665C', rough=0.9, grime=0.7, salt=0.8, streaks=0.8, pattern='woodgrain'),
    'timber_dark': L(base='#4F463D', alt1='#3A332C', rough=0.9, grime=0.8, salt=0.8, pattern='woodgrain'),
    'barnacle': L(base='#7C766A', alt1='#5E594F', rough=0.95, grime=0.6, salt=0.9, pits=1.0, pattern='concrete'),
    'concrete': L(base='#9A978E', alt1='#7F7C74', rough=0.9, grime=0.9, salt=0.9, streaks=1.0, pits=0.8, pattern='concrete'),
    'glass_dark': L(base='#1A2326', alt1='#3E4E52', rough=0.12, rough_alt=0.3, grime=0.5, salt=0.6, pattern='none'),
    'ceramic_glaze': L(base='#5E6B55', alt1='#7B8A70', rough=0.18, rough_alt=0.25, edge=0.4, chips=0.2, grime=0.4, salt=0.6, pattern='cast'),
    'paint_white_trim': L(base='#E4DFD2', rough=0.6, under='#8A8174', edge=0.9, chips=0.7, grime=0.6, salt=0.5, fade=0.2, pattern='cast'),
    # C_Lamp
    'lens_amber': L(base=LED_AMBER, rough=0.12, scratch=0.4, grime=0.2, salt=0.3, pattern='fresnel'),
    'lens_red': L(base='#E0432F', rough=0.12, scratch=0.4, grime=0.2, salt=0.3, pattern='fresnel'),
    'lens_green': L(base='#58C27A', rough=0.12, scratch=0.4, grime=0.2, salt=0.3, pattern='fresnel'),
}
LK.LOOKS.update(COURSE_LOOKS)

_base_pattern_vector = LK.pattern_vector


def _stripes(N, coord, period, duty):
    return N.math('LESS_THAN', N.math('FRACT', N.math('DIVIDE', coord, period)), duty)


def course_pattern_vector(nt, pattern):
    """course patterns in Blender WORLD space of the asset frame (Blender z = three y); falls back to looks.py"""
    N = LK._NT(nt)
    if pattern not in ('galv', 'prism', 'hazard_diag', 'chequer', 'chequer_ring', 'mast_bands', 'shingles', 'brick', 'clapboard',
                       'corrugated', 'woodgrain', 'concrete', 'rust_bloom', 'fresnel'):
        return _base_pattern_vector(nt, pattern)
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    P = geo.outputs['Position']
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    nt.links.new(P, sep.inputs['Vector'])
    X, Y, Z = sep.outputs['X'], sep.outputs['Y'], sep.outputs['Z']
    if pattern == 'galv':
        # hot-dip spangle: crystal mottling (Voronoi cells a few cm) + a faint zinc drip texture
        vor = nt.nodes.new('ShaderNodeTexVoronoi')
        vor.inputs['Scale'].default_value = 28.0
        nt.links.new(P, vor.inputs['Vector'])
        mott = N.smooth(0.25, 0.9, vor.outputs['Distance'])
        drip = N.noise(N.vmath('MULTIPLY', P, (6.0, 6.0, 0.8)), 3.0, 3.0, 0.6)
        a1 = N.math('ADD', N.math('MULTIPLY', mott, 0.35), N.math('MULTIPLY', N.smooth(0.55, 0.75, drip), 0.35))
        return N.combine(a1, 0, N.math('MULTIPLY', N.noise(P, 180.0, 2.0), 0.03))
    if pattern == 'prism':
        # micro-prismatic sheeting: a fine diamond grid (normal/roughness only) + the stripe of the tape's seam
        wa = nt.nodes.new('ShaderNodeTexWave')
        wa.wave_type = 'BANDS'
        wa.bands_direction = 'DIAGONAL'
        wa.inputs['Scale'].default_value = 90.0
        nt.links.new(P, wa.inputs['Vector'])
        return N.combine(N.math('MULTIPLY', N.smooth(0.45, 0.55, wa.outputs['Fac']), 0.25), 0, N.math('MULTIPLY', wa.outputs['Fac'], 0.02))
    if pattern == 'hazard_diag':
        # 45° stripes wrapping a vertical axis at the asset origin: angle · r_nominal + height
        ang = N.math('ARCTAN2', Y, X)
        s = N.math('ADD', N.math('MULTIPLY', ang, 0.12), Z)
        stripe = _stripes(N, s, 0.36, 0.5)
        return N.combine(stripe, 0, N.math('MULTIPLY', N.noise(P, 60.0, 2.0), 0.04))
    if pattern == 'chequer':
        # 0.25 m chequer in the board's local plane (u, v from the piece frame)
        u, v = N.local_uv()
        cu = _stripes(N, u, 0.5, 0.5)
        cv = _stripes(N, v, 0.5, 0.5)
        ch = N.math('ABSOLUTE', N.math('SUBTRACT', cu, cv))
        return N.combine(ch, 0, 0)
    if pattern == 'chequer_ring':
        # 0.3 m chequer wrapped round a vertical axis at the asset origin (buoy body, r ≈ 1.2 m)
        ang = N.math('ARCTAN2', Y, X)
        u = N.math('MULTIPLY', ang, 1.2)
        cu = _stripes(N, u, 0.6, 0.5)
        cv = _stripes(N, Z, 0.6, 0.5)
        return N.combine(N.math('ABSOLUTE', N.math('SUBTRACT', cu, cv)), 0, 0)
    if pattern == 'mast_bands':
        # ICAO day marking: 7 equal red/white bands per 60 m section, read on the vertical axis
        band = _stripes(N, N.math('ADD', Z, 12.0), 13.72, 0.5)
        return N.combine(band, 0, N.math('MULTIPLY', N.noise(P, 40.0, 2.0), 0.05))
    if pattern == 'shingles':
        # courses every 0.14 m up the roof (world height), staggered butt joints every ~0.24 m, per-shingle tone
        row = N.math('FLOOR', N.math('DIVIDE', Z, 0.14))
        shift = N.math('MULTIPLY', N.math('FRACT', N.math('MULTIPLY', row, 0.5)), 0.12)
        run = N.math('ADD', N.math('ADD', X, Y), shift)
        joint = N.math('LESS_THAN', N.math('FRACT', N.math('DIVIDE', run, 0.24)), 0.06)
        cell = N.math('ADD', N.math('FLOOR', N.math('DIVIDE', run, 0.24)), N.math('MULTIPLY', row, 17.0))
        tone = N.math('FRACT', N.math('MULTIPLY', N.math('SINE', N.math('MULTIPLY', cell, 12.9898)), 43758.55))
        butt = N.math('FRACT', N.math('DIVIDE', Z, 0.14))
        h = N.math('SUBTRACT', N.math('MULTIPLY', butt, 3.0), N.math('MULTIPLY', joint, 1.5))
        return N.combine(N.math('MULTIPLY', N.smooth(0.55, 0.95, tone), 0.8), N.math('MULTIPLY', N.smooth(0.0, 0.2, tone), 0.5), h)
    if pattern == 'brick':
        row = N.math('FLOOR', N.math('DIVIDE', Z, 0.076))
        shift = N.math('MULTIPLY', N.math('FRACT', N.math('MULTIPLY', row, 0.5)), 0.11)
        run = N.math('ADD', N.math('ADD', X, Y), shift)
        bed = N.math('LESS_THAN', N.math('FRACT', N.math('DIVIDE', Z, 0.076)), 0.14)
        head = N.math('LESS_THAN', N.math('FRACT', N.math('DIVIDE', run, 0.22)), 0.05)
        mortar = N.math('MAXIMUM', bed, head)
        cell = N.math('ADD', N.math('FLOOR', N.math('DIVIDE', run, 0.22)), N.math('MULTIPLY', row, 31.0))
        tone = N.math('FRACT', N.math('MULTIPLY', N.math('SINE', N.math('MULTIPLY', cell, 7.233)), 23421.63))
        return N.combine(mortar, N.math('MULTIPLY', N.smooth(0.6, 1.0, tone), N.math('SUBTRACT', 1.0, mortar)),
                         N.math('MULTIPLY', mortar, -1.5))
    if pattern == 'clapboard':
        lap = N.math('FRACT', N.math('DIVIDE', Z, 0.17))
        grain = N.noise(N.vmath('MULTIPLY', P, (2.0, 2.0, 60.0)), 4.0, 3.0, 0.6)
        return N.combine(N.math('MULTIPLY', N.smooth(0.6, 0.8, grain), 0.5), 0, N.math('ADD', N.math('MULTIPLY', lap, 4.0), N.math('MULTIPLY', grain, 0.3)))
    if pattern == 'corrugated':
        # 76 mm pitch sine corrugation across the sheet (world X+Y), rust blooms in alt1
        wav = N.math('SINE', N.math('MULTIPLY', N.math('ADD', X, Y), 82.7))
        bloom = N.smooth(0.52, 0.72, N.noise(P, 1.6, 4.0, 0.6))
        return N.combine(bloom, 0, N.math('MULTIPLY', wav, 9.0))
    if pattern == 'woodgrain':
        g = N.noise(N.vmath('MULTIPLY', P, (1.5, 1.5, 40.0)), 3.0, 4.0, 0.65)
        return N.combine(N.smooth(0.45, 0.7, g), 0, N.math('MULTIPLY', g, 0.8))
    if pattern == 'concrete':
        pits = N.smooth(0.7, 0.8, N.noise(P, 25.0, 2.0))
        return N.combine(N.smooth(0.4, 0.7, N.noise(P, 1.2, 4.0)), 0, N.math('MULTIPLY', pits, -0.6))
    if pattern == 'rust_bloom':
        return N.combine(N.smooth(0.55, 0.75, N.noise(P, 2.2, 5.0, 0.62)), 0, N.math('MULTIPLY', N.noise(P, 90.0, 2.0), 0.08))
    if pattern == 'fresnel':
        ring = N.math('SINE', N.math('MULTIPLY', N.math('SQRT', N.math('ADD', N.math('MULTIPLY', X, X), N.math('MULTIPLY', Y, Y))), 400.0))
        return N.combine(0, 0, N.math('MULTIPLY', ring, 0.05))
    raise KeyError(pattern)


LK.pattern_vector = course_pattern_vector

# ── pieces ───────────────────────────────────────────────────────────────────


def piece(variant, name, geo, slot, look, **kw):
    """a kit.Piece that knows its variant node; `min_lod` lets a proxy replace detail at distance"""
    min_lod = kw.pop('min_lod', 0)
    p = kit.Piece(f'{variant}__{name}', geo, slot, look, **kw)
    p.variant = variant
    p.min_lod = min_lod
    return p


def member(a, b, w, h=None, up=(0, 1, 0)):
    """a rectangular structural member (box section w × h) from a to b, in the asset frame"""
    from mathutils import Vector
    A, B = Vector(a), Vector(b)
    d = B - A
    L = d.length
    h = w if h is None else h
    g = kit.box(w, h, L, center=(0, 0, L / 2))
    z = d.normalized()
    upv = Vector(up)
    if abs(upv.dot(z)) > 0.95:
        upv = Vector((1, 0, 0))
    x = upv.cross(z).normalized()
    y = z.cross(x)
    from mathutils import Matrix
    M = Matrix.Identity(4)
    for r in range(3):
        M[r][0], M[r][1], M[r][2], M[r][3] = x[r], y[r], z[r], A[r]
    return g.transform(M)


def _frame_along(a, b, roll_to):
    from mathutils import Vector
    A, B = Vector(a), Vector(b)
    z = (B - A).normalized()
    upv = Vector(roll_to)
    if abs(upv.dot(z)) > 0.95:
        upv = Vector((1, 0, 0)) if abs(z.x) < 0.9 else Vector((0, 0, 1))
    x = upv.cross(z).normalized()
    y = z.cross(x)
    return A, B, x, y


def angle_member(a, b, leg, t, roll_to=(0, 1, 0)):
    """an L-angle section (flanges `leg` wide, `t` thick) from a to b — how lattice towers are built. ONE UV island
    (girth × length) + two small caps: a lattice is hundreds of these, and smart-UV slivers would starve the atlas.
    Closed, so kit.finish can orient it outward (OPAQUE slots are single-sided)"""
    A, B, x, y = _frame_along(a, b, roll_to)
    prof = [(0, 0), (leg, 0), (leg, t), (t, t), (t, leg), (0, leg)]
    rings = [[tuple(P + x * (px - t / 2) + y * (py - t / 2)) for (px, py) in prof] for P in (A, B)]
    return kit.grid_loft(rings, closed=True, cap0=True, cap1=True, uv_chunk=1000.0)


def tube(a, b, r, segs=8, caps=True):
    """a round member from a to b: one UV island, optional caps"""
    import math as _m
    A, B, x, y = _frame_along(a, b, (0, 1, 0))
    prof = [(_m.cos(2 * _m.pi * k / segs) * r, _m.sin(2 * _m.pi * k / segs) * r) for k in range(segs)]
    rings = [[tuple(P + x * px + y * py) for (px, py) in prof] for P in (A, B)]
    return kit.grid_loft(rings, closed=True, cap0=caps, cap1=caps, uv_chunk=1000.0)


def catenary(a, b, sag, n=16):
    """points of a hanging cable from a to b sagging `sag` metres at mid-span (parabola approximation)"""
    pts = []
    for i in range(n + 1):
        t = i / n
        pts.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - 4 * sag * t * (1 - t), a[2] + (b[2] - a[2]) * t))
    return pts


STENCIL_FONT = os.path.join(HERE, '..', '..', '..', 'assets', 'fonts', 'speedboat', 'SairaStencilOne-Regular.woff2')


def stencil_text(body, height, depth, resolution=2):
    """extruded glyphs in the HUD's stencil face (Saira Stencil One, OFL, assets/fonts/speedboat), in the XY
    plane reading along +X, centred on the origin, scaled so the glyph box is `height` tall; +Z face at depth/2"""
    font = bpy.data.fonts.load(os.path.abspath(STENCIL_FONT), check_existing=True)
    cu = bpy.data.curves.new('__stencil', 'FONT')
    cu.body = body
    cu.font = font
    cu.size = 1.0
    cu.extrude = depth / 2
    cu.resolution_u = resolution
    cu.align_x = 'CENTER'
    cu.fill_mode = 'BOTH'
    ob = bpy.data.objects.new('__stencil', cu)
    bpy.context.scene.collection.objects.link(ob)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    g = kit.Geo()
    ys = [v.co.y for v in me.vertices]
    y0, y1 = min(ys), max(ys)
    k = height / max(y1 - y0, 1e-6)
    yc = (y0 + y1) / 2
    P = [((v.co.x) * k, (v.co.y - yc) * k, v.co.z) for v in me.vertices]
    ids = [g.vert(p) for p in P]
    for poly in me.polygons:
        # box projection: the glyph faces stay a few connected islands instead of hundreds of smart-UV slivers
        n = poly.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        proj = (lambda p: (p[0], p[1])) if ax == 2 else (lambda p: (p[1], p[2])) if ax == 0 else (lambda p: (p[0], p[2]))
        g.face([ids[i] for i in poly.vertices], [proj(P[i]) for i in poly.vertices])
    bpy.data.objects.remove(ob, do_unlink=True)
    bpy.data.curves.remove(cu)
    bpy.data.meshes.remove(me)
    return g


# ── build flow ───────────────────────────────────────────────────────────────


def build_asset(name, module, args):
    t_start = time.time()
    contract = load_contract()
    spec = contract['assets'][name]
    sb.reset_scene(args.threads)
    mats = {}
    for slot in SLOT_ORDER:
        mat, bsdf = sb.principled_material(contract, slot, roughness=0.6)
        mats[slot] = (mat, bsdf)
    res = module.build(args)
    pieces = res['pieces']
    extras = res.get('extras', {})
    col = bpy.data.collections.new('CoursePieces')
    bpy.context.scene.collection.children.link(col)
    for p in pieces:
        if p.slot not in SLOT_ORDER:
            raise SystemExit(f'[course] {name}/{p.name}: slot {p.slot} is not a course slot {SLOT_ORDER}')
        if p.variant not in spec['variants']:
            raise SystemExit(f'[course] {name}/{p.name}: variant {p.variant} is not in the contract {spec["variants"]}')
        ob = kit.make_object(p, col)
        ob.data.materials.append(mats[p.slot][0])
        kit.finish(p)
    lod0_tris = sum(sb.tri_count(p.obj) for p in pieces if p.min_lod == 0)
    print(f'[course] {name}: {len(pieces)} pieces, LOD0 {lod0_tris} tris, modelled in {time.time() - t_start:.1f}s')

    # ── bake per slot: every piece shares its slot's atlas at one texel density (tiers scale it) ──
    size_full = int(spec['textureSize'])
    size = min(size_full, 1 << int(round(math.log2(max(64, args.bake_size * size_full / 1024)))))
    tiers = {'exterior': 1.0, 'hero': 2.0, 'low': 0.5}
    stats = {}
    for slot in SLOT_ORDER:
        sp = [p for p in pieces if p.slot == slot]
        if not sp:
            continue
        mat, bsdf = mats[slot]
        # small-surface slots (lamp lenses) bake at a fraction of the asset's atlas: a lens is a few cm² of texture
        slot_size = max(64, int(size * contract.get('slotTextureScale', {}).get(slot, 1.0)))
        # many-island slots (lattices) pack with a thin margin: EXTEND bleeds the rest, and a lattice's colour is uniform
        margin = res.get('uvMarginPx', {}).get(slot, max(2, size // 256))
        t0 = time.time()
        dens, used = BK.pack_slot(sp, tiers, margin_px=margin * 2, size=slot_size)
        data, id_of = BK.bake_slot(slot, sp, slot_size, args.ao_samples, margin)
        base, orm, normal, st = BK.composite(slot, data, id_of, sp, slot_size)
        del data
        tag = f'{name}_{slot[2:].lower()}'
        img_b = BK.save_rgba(f'{tag}_baseColor', base, args.work, non_color=False)
        img_o = BK.save_rgba(f'{tag}_orm', orm, args.work, non_color=True)
        img_n = BK.save_rgba(f'{tag}_normal', normal, args.work, non_color=True)
        sb.attach_texture_set(mat, bsdf, img_b, img_o, img_n, alpha_from_base=False)
        if contract['slots'][slot].get('emissive'):
            # emission = the lens colour (baked base × a runtime-driven strength); glTF emissiveFactor × texture
            nt = mat.node_tree
            tex = next(n for n in nt.nodes if n.type == 'TEX_IMAGE' and n.image == img_b)
            nt.links.new(tex.outputs['Color'], bsdf.inputs['Emission Color'])
            bsdf.inputs['Emission Strength'].default_value = 1.0
        stats[slot] = {'atlas': slot_size, 'pxPerM': dens, 'uvUsed': used, **st}
        print(f'[course] {slot}: {len(sp)} pieces, atlas {slot_size}², px/m {dens}, uv {used:.0%}, {time.time() - t0:.1f}s')

    # ── LOD nodes: one node per variant per level (one primitive per slot) ──
    root = sb.make_empty(contract['names']['root'].replace('{asset}', name), props={
        'assetKind': spec['kind'],
        'contractVersion': contract['version'],
    })
    levels = contract['lod']['levels']
    ratios = res.get('lodRatios', [1.0, 0.3, 0.08])
    table = {}
    totals = [0] * levels
    for lod in range(levels):
        grp = sb.make_empty(contract['names']['lodGroup'].replace('{level}', str(lod)), parent=root, props={'lodLevel': lod})
        for variant in spec['variants']:
            keep = [p.obj for p in pieces if p.variant == variant and p.min_lod <= lod <= p.max_lod]
            if not keep:
                continue
            ob = _join(f'{variant}_LOD{lod}', keep, grp, lod)
            ob['variant'] = variant
            src_tris = sb.tri_count(ob)
            # proxies authored for this level are already light; LOD0-surviving detail is collapse-decimated
            authored = any(p.min_lod == lod and lod > 0 for p in pieces if p.variant == variant)
            if lod > 0 and not authored and ratios[lod] < 0.999 and src_tris > 64:
                m = ob.modifiers.new('LOD', 'DECIMATE')
                m.decimate_type = 'COLLAPSE'
                m.ratio = max(0.02, ratios[lod])
                m.use_collapse_triangulate = True
                sb.apply_modifiers(ob)
                ob.data.set_sharp_from_angle(angle=math.radians(40))
            sb.triangulate_object(ob)
            t = sb.tri_count(ob)
            table.setdefault(variant, [0] * levels)[lod] = t
            totals[lod] += t
    for p in pieces:
        bpy.data.objects.remove(p.obj, do_unlink=True)
    bpy.data.collections.remove(col)
    for v, row in table.items():
        print(f'[course] tris {v:14s} ' + ' / '.join(str(x) for x in row))
    print(f'[course] tris TOTAL          ' + ' / '.join(str(x) for x in totals))
    variants = {v: {'tris': table.get(v, [0] * levels)} for v in spec['variants']}
    for v, ex in (res.get('variantExtras') or {}).items():
        variants.setdefault(v, {}).update(ex)
    root['variants'] = json.dumps(variants, sort_keys=True)
    for k, v in extras.items():
        root[k] = json.dumps(v, sort_keys=True) if isinstance(v, (dict, list)) else v
    root['courseTexelDensity'] = json.dumps(stats, sort_keys=True, default=str)
    if args.blend:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.blend), compress=False)
    sb.export_glb(os.path.abspath(args.out))
    print(f'[course] {name}: exported {args.out} in {time.time() - t_start:.1f}s')


def _join(name, objs, parent, lod):
    copies = []
    for o in objs:
        c = o.copy()
        c.data = o.data.copy()
        bpy.context.scene.collection.objects.link(c)
        copies.append(c)
    for o in bpy.context.selected_objects:
        o.select_set(False)
    for c in copies:
        c.select_set(True)
    bpy.context.view_layer.objects.active = copies[0]
    if len(copies) > 1:
        bpy.ops.object.join()
    ob = copies[0]
    ob.select_set(False)
    for k in list(ob.keys()):
        del ob[k]
    ob.name = name
    ob.data.name = name
    for c in bpy.context.scene.collection.children:
        if ob.name in c.objects:
            c.objects.unlink(ob)
    ob.parent = parent
    ob['lodLevel'] = int(lod)
    return ob
