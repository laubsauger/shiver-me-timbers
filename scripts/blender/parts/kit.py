"""
Hard-surface modelling kit for the hero parts (headless Blender, deterministic).

Geometry is authored as `Geo` in the three.js BODY frame (metres, +Y up, bow +Z) and converted to
Blender's frame only when it becomes an object (sb_conventions.three_to_blender, a proper rotation,
so winding survives). A part is a list of `Piece`s: one Geo + one material slot + one look (the
bake/composite recipe, looks.py) + a texel-density tier + the highest LOD it survives to + its
finishing (bevel/weighted normals, smoothing angle, UV method).
"""
import math

import bpy
import bmesh
from mathutils import Matrix, Vector

# three (x, y, z) -> Blender (x, -z, y)
T2B = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))


def t2b(p):
    return Vector((p[0], -p[2], p[1]))


def lerp(a, b, t):
    return a + (b - a) * t


def smoothstep(e0, e1, x):
    t = min(max((x - e0) / (e1 - e0), 0.0), 1.0) if e1 != e0 else (1.0 if x >= e1 else 0.0)
    return t * t * (3 - 2 * t)


# ── Geo: a polygon soup with optional per-corner UVs (metres) ────────────────


class Geo:
    def __init__(self):
        self.v = []
        self.f = []
        self.uv = []  # per face: tuple of (u, v) per corner, or None (smart UV later)

    def vert(self, p):
        self.v.append((float(p[0]), float(p[1]), float(p[2])))
        return len(self.v) - 1

    def face(self, idx, uv=None):
        self.f.append(tuple(idx))
        self.uv.append(tuple(uv) if uv is not None else None)

    def extend(self, other):
        off = len(self.v)
        self.v.extend(other.v)
        for f, uv in zip(other.f, other.uv):
            self.f.append(tuple(i + off for i in f))
            self.uv.append(uv)
        return self

    def copy(self):
        g = Geo()
        g.v = list(self.v)
        g.f = list(self.f)
        g.uv = list(self.uv)
        return g

    def transform(self, M):
        M = Matrix(M)
        self.v = [tuple(M @ Vector(p)) for p in self.v]
        return self

    def translate(self, d):
        return self.transform(Matrix.Translation(Vector(d)))

    def flip(self):
        self.f = [tuple(reversed(f)) for f in self.f]
        self.uv = [tuple(reversed(u)) if u is not None else None for u in self.uv]
        return self

    def mirror_x(self):
        g = self.copy().transform(Matrix.Diagonal((-1, 1, 1, 1)))
        return g.flip()

    @property
    def has_uv(self):
        return all(u is not None for u in self.uv) and len(self.uv) > 0


def frame(origin, x_axis, y_axis):
    """4x4 from an origin and two (not necessarily orthogonal) axes; z = x × y, y re-orthogonalised"""
    x = Vector(x_axis).normalized()
    z = x.cross(Vector(y_axis)).normalized()
    y = z.cross(x).normalized()
    M = Matrix.Identity(4)
    for r in range(3):
        M[r][0], M[r][1], M[r][2], M[r][3] = x[r], y[r], z[r], origin[r]
    return M


def rot(axis, deg):
    return Matrix.Rotation(math.radians(deg), 4, axis)


# ── primitives (all closed + outward-wound unless noted) ────────────────────


def grid_loft(rings, closed=True, cap0=False, cap1=False, uv=True, u_scale=None, uv_chunk=1.5):
    """rings: list of point lists (same count). Faces between successive rings. UV u = girth (m),
    v = accumulated distance along rings (m)."""
    g = Geo()
    n = len(rings[0])
    idx = [[g.vert(p) for p in ring] for ring in rings]
    # girth per ring
    def girth(ring):
        acc = [0.0]
        m = len(ring) if closed else len(ring) - 1
        for j in range(m):
            acc.append(acc[-1] + (Vector(ring[(j + 1) % len(ring)]) - Vector(ring[j])).length)
        return acc
    gir = [girth(r) for r in rings]
    vacc = [0.0]
    for r in range(1, len(rings)):
        d = sum((Vector(rings[r][j]) - Vector(rings[r - 1][j])).length for j in range(n)) / n
        vacc.append(vacc[-1] + d)
    m = n if closed else n - 1
    # long lofts (rub rail, arch hoops) become several UV islands of ≤ uv_chunk metres, so one
    # 11 m strip never dictates the whole atlas scale; the mesh itself stays welded
    starts = [0.0]
    for r in range(len(rings) - 1):
        if vacc[r] - starts[-1] >= uv_chunk:
            starts.append(vacc[r])
    for r in range(len(rings) - 1):
        v0 = max(s for s in starts if s <= vacc[r] + 1e-9)
        for j in range(m):
            k = (j + 1) % n
            a, b, c, d = idx[r][j], idx[r][k], idx[r + 1][k], idx[r + 1][j]
            ga, gb = gir[r], gir[r + 1]
            u0a, u1a = ga[j], ga[j + 1]
            u0b, u1b = gb[j], gb[j + 1]
            va, vb = vacc[r] - v0, vacc[r + 1] - v0
            g.face((a, b, c, d), [(u0a, va), (u1a, va), (u1b, vb), (u0b, vb)] if uv else None)
    if cap0:
        _cap(g, idx[0], rings[0], reverse=True)
    if cap1:
        _cap(g, idx[-1], rings[-1], reverse=False)
    return g


def _cap(g, ids, pts, reverse):
    c = Vector((0, 0, 0))
    for p in pts:
        c += Vector(p)
    c /= len(pts)
    # planar UV in the cap's own best-fit plane
    nrm = Vector((0, 0, 0))
    for i in range(len(pts)):
        a, b = Vector(pts[i]) - c, Vector(pts[(i + 1) % len(pts)]) - c
        nrm += a.cross(b)
    nrm = nrm.normalized() if nrm.length > 1e-12 else Vector((0, 1, 0))
    ax = (Vector(pts[0]) - c)
    ax = (ax - nrm * ax.dot(nrm)).normalized() if ax.length > 1e-9 else nrm.orthogonal().normalized()
    ay = nrm.cross(ax)
    uvs = [((Vector(p) - c).dot(ax), (Vector(p) - c).dot(ay)) for p in pts]
    order = list(ids)
    if reverse:
        order = order[::-1]
        uvs = uvs[::-1]
    g.face(order, uvs)


def box(sx, sy, sz, center=(0, 0, 0)):
    hx, hy, hz = sx / 2, sy / 2, sz / 2
    cx, cy, cz = center
    g = Geo()
    P = [(cx + x * hx, cy + y * hy, cz + z * hz) for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)]
    ids = [g.vert(p) for p in P]
    # index = (x+1)/2*4 + (y+1)/2*2 + (z+1)/2
    I = lambda x, y, z: ids[(x > 0) * 4 + (y > 0) * 2 + (z > 0)]  # noqa: E731
    quads = [
        (I(1, -1, -1), I(1, 1, -1), I(1, 1, 1), I(1, -1, 1)),     # +x
        (I(-1, -1, 1), I(-1, 1, 1), I(-1, 1, -1), I(-1, -1, -1)), # -x
        (I(-1, 1, -1), I(-1, 1, 1), I(1, 1, 1), I(1, 1, -1)),     # +y
        (I(-1, -1, 1), I(-1, -1, -1), I(1, -1, -1), I(1, -1, 1)), # -y
        (I(-1, -1, 1), I(1, -1, 1), I(1, 1, 1), I(-1, 1, 1)),     # +z
        (I(1, -1, -1), I(-1, -1, -1), I(-1, 1, -1), I(1, 1, -1)), # -z
    ]
    for q in quads:
        g.face(q)
    return g


def circle(r, segs, plane='xz', center=(0, 0, 0), start=0.0):
    out = []
    for i in range(segs):
        a = start + 2 * math.pi * i / segs
        c, s = math.cos(a) * r, math.sin(a) * r
        if plane == 'xz':
            out.append((center[0] + c, center[1], center[2] - s))
        elif plane == 'xy':
            out.append((center[0] + c, center[1] + s, center[2]))
        else:  # yz
            out.append((center[0], center[1] + c, center[2] - s))
    return out


def cylinder(r, h, segs=16, caps=True, axis='y', r2=None):
    """along +axis from 0 to h, radius r (bottom) → r2 (top)"""
    r2 = r if r2 is None else r2
    rings = [circle(r, segs, 'xz', (0, 0, 0)), circle(r2, segs, 'xz', (0, h, 0))]
    g = grid_loft(rings, closed=True, cap0=caps, cap1=caps)
    if axis == 'x':
        g.transform(rot('Z', -90))
    elif axis == 'z':
        g.transform(rot('X', 90))
    return g


def revolve(profile, segs=24, caps=False):
    """profile: [(radius, y)] bottom → top; revolved about +Y. Radius 0 ends collapse to a pole."""
    rings = []
    for (r, y) in profile:
        rings.append(circle(max(r, 1e-5), segs, 'xz', (0, y, 0)))
    return grid_loft(rings, closed=True, cap0=caps, cap1=caps)


def dome(r, segs=16, rings=5, h=None):
    h = r if h is None else h
    prof = [(r * math.cos(0.5 * math.pi * i / rings), h * math.sin(0.5 * math.pi * i / rings)) for i in range(rings + 1)]
    prof[-1] = (1e-4, h)
    g = revolve(prof, segs)
    _cap(g, list(range(0, segs)), [g.v[i] for i in range(segs)], reverse=True)
    return g


def superellipse_ring(half_x, half_z_front, half_z_back, n=2.6, segs=32, y=0.0, cx=0.0, cz=0.0):
    """closed ring in the XZ plane, front (+z) and back (-z) half lengths differ; CCW seen from +Y"""
    pts = []
    for i in range(segs):
        a = 2 * math.pi * i / segs
        c, s = math.cos(a), math.sin(a)
        x = half_x * math.copysign(abs(c) ** (2 / n), c)
        hz = half_z_back if s > 0 else half_z_front  # the point lands at cz - z
        z = hz * math.copysign(abs(s) ** (2 / n), s)
        pts.append((cx + x, y, cz - z))  # -z so that the ring winds CCW seen from +Y (outward loft)
    return pts


def extrude(poly, depth, center=True):
    """2D polygon (x, y) CCW, extruded along +Z by depth (centred on z=0 if center)"""
    z0 = -depth / 2 if center else 0.0
    rings = [[(x, y, z0) for (x, y) in poly], [(x, y, z0 + depth) for (x, y) in poly]]
    g = grid_loft(rings, closed=True, cap0=True, cap1=True)
    return g if _signed_area(poly) > 0 else g.flip()


def _signed_area(poly):
    return 0.5 * sum(poly[i][0] * poly[(i + 1) % len(poly)][1] - poly[(i + 1) % len(poly)][0] * poly[i][1] for i in range(len(poly)))


def rounded_rect(w, h, r, segs=4):
    r = min(r, w / 2 - 1e-4, h / 2 - 1e-4)
    pts = []
    for (cx, cy, a0) in ((w / 2 - r, h / 2 - r, 0), (-w / 2 + r, h / 2 - r, 90), (-w / 2 + r, -h / 2 + r, 180), (w / 2 - r, -h / 2 + r, 270)):
        for i in range(segs + 1):
            a = math.radians(a0 + 90 * i / segs)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def fillet_path(points, radius, segs=6):
    """polyline with rounded corners (tube bends): each interior corner replaced by an arc"""
    P = [Vector(p) for p in points]
    out = [P[0]]
    for i in range(1, len(P) - 1):
        a, b, c = P[i - 1], P[i], P[i + 1]
        d0, d1 = (a - b), (c - b)
        l0, l1 = d0.length, d1.length
        d0.normalize()
        d1.normalize()
        ang = d0.angle(d1)
        if ang > math.pi - 1e-3 or ang < 1e-3:
            out.append(b)
            continue
        t = min(radius / math.tan(ang / 2), 0.45 * l0, 0.45 * l1)
        p0, p1 = b + d0 * t, b + d1 * t
        for k in range(segs + 1):
            s = k / segs
            # quadratic bezier approximates the arc closely enough for tube bends
            q = p0 * (1 - s) ** 2 + b * 2 * s * (1 - s) + p1 * s * s
            out.append(q)
    out.append(P[-1])
    return [tuple(p) for p in out]


def sweep(path, r, segs=12, caps=True, up_hint=(0, 1, 0), profile=None, closed_path=False, radii=None):
    """sweep a circle (or a 2D profile [(x, y)]) along a polyline with parallel-transport frames"""
    P = [Vector(p) for p in path]
    n = len(P)
    tangents = []
    for i in range(n):
        if closed_path:
            t = P[(i + 1) % n] - P[i - 1]
        elif i == 0:
            t = P[1] - P[0]
        elif i == n - 1:
            t = P[-1] - P[-2]
        else:
            t = (P[i + 1] - P[i]).normalized() + (P[i] - P[i - 1]).normalized()
        tangents.append(t.normalized())
    up = Vector(up_hint)
    if abs(up.dot(tangents[0])) > 0.95:
        up = Vector((1, 0, 0)) if abs(tangents[0].x) < 0.9 else Vector((0, 0, 1))
    nrm = (up - tangents[0] * up.dot(tangents[0])).normalized()
    rings = []
    prof = profile or [(r * math.cos(2 * math.pi * k / segs), r * math.sin(2 * math.pi * k / segs)) for k in range(segs)]
    for i in range(n):
        t = tangents[i]
        if i > 0:
            # parallel transport
            nrm = (nrm - t * nrm.dot(t)).normalized()
        bin_ = t.cross(nrm)
        k = radii[i] if radii is not None else 1.0
        rings.append([tuple(P[i] + (nrm * px + bin_ * py) * k) for (px, py) in prof])
    if closed_path:
        rings.append(rings[0])
    g = grid_loft(rings, closed=True, cap0=caps and not closed_path, cap1=caps and not closed_path)
    return g


def torus(R, r, segs=24, rsegs=8):
    path = [(R * math.cos(2 * math.pi * i / segs), 0.0, R * math.sin(2 * math.pi * i / segs)) for i in range(segs)]
    return sweep(path, r, rsegs, caps=False, closed_path=True, up_hint=(0, 1, 0))


def ribbon(path, width, thick, up_vectors):
    """flat strap along a path; up_vectors[i] = surface normal the strap lies on"""
    rings = []
    P = [Vector(p) for p in path]
    for i, p in enumerate(P):
        t = (P[min(i + 1, len(P) - 1)] - P[max(i - 1, 0)]).normalized()
        n = Vector(up_vectors[i]).normalized()
        s = t.cross(n).normalized()
        hw, ht = width / 2, thick / 2
        rings.append([tuple(p + s * hw + n * ht), tuple(p - s * hw + n * ht), tuple(p - s * hw - n * ht), tuple(p + s * hw - n * ht)])
    return grid_loft(rings, closed=True, cap0=True, cap1=True)


def helix(coil_r, wire_r, turns, length, segs_per_turn=10, wire_segs=6):
    path = []
    N = int(turns * segs_per_turn)
    for i in range(N + 1):
        a = 2 * math.pi * turns * i / N
        path.append((coil_r * math.cos(a), length * i / N, coil_r * math.sin(a)))
    return sweep(path, wire_r, wire_segs, caps=True, up_hint=(1, 0, 0))


def hex_prism(r, h):
    return cylinder(r, h, segs=6, caps=True)


def text_geo(body, size, extrude=0.0, align='CENTER', resolution=1):
    cu = bpy.data.curves.new('__txt', 'FONT')
    cu.body = body
    cu.size = size
    cu.extrude = extrude
    cu.align_x = align
    cu.resolution_u = resolution
    cu.fill_mode = 'BOTH' if extrude > 0 else 'FRONT'
    ob = bpy.data.objects.new('__txt', cu)
    bpy.context.scene.collection.objects.link(ob)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    g = Geo()
    # font curves are authored in Blender XY; keep them in three XY (reading direction +x, up +y)
    ids = [g.vert((v.co.x, v.co.y, v.co.z)) for v in me.vertices]
    for p in me.polygons:
        g.face([ids[i] for i in p.vertices])
    bpy.data.objects.remove(ob, do_unlink=True)
    bpy.data.curves.remove(cu)
    bpy.data.meshes.remove(me)
    return g


# ── pieces ───────────────────────────────────────────────────────────────────


class Piece:
    """One authored surface: Geo + slot + look + finishing."""

    def __init__(self, name, geo, slot, look, tier='exterior', max_lod=2, bevel=None, smooth=35.0,
                 uv='auto', weld=1e-5, wear=1.0, recalc=True, fasteners=None, welds=None, subsurf=0,
                 local=None, props=None):
        self.name = name
        self.geo = geo
        self.slot = slot
        self.look = look
        self.tier = tier
        self.max_lod = max_lod
        self.bevel = bevel          # (width, segments) or None
        self.smooth = smooth        # auto-smooth angle in degrees; None = flat, 180 = all smooth
        self.uv = uv                # 'auto' (param if the Geo has UVs, else smart), 'smart', 'param'
        self.weld = weld
        self.wear = wear            # per-piece wear multiplier (replacement panels are cleaner)
        self.recalc = recalc        # recalc outward normals (closed meshes only)
        self.fasteners = fasteners or []  # [(pos3, normal3, radius, kind, rusty)] in the body frame
        self.welds = welds or []    # [pos3] heat-tint centres (stainless welds), body frame
        self.subsurf = subsurf
        self.local = local          # (origin3, x3, y3) pattern frame for looks that need one
        self.props = props or {}    # extra object attributes the look shader reads (e.g. gauge radius 'dr')
        self.obj = None


def tri_count_geo(geo):
    return sum(len(f) - 2 for f in geo.f)


def make_object(piece, collection=None):
    g = piece.geo
    me = bpy.data.meshes.new(piece.name)
    verts = [tuple(t2b(p)) for p in g.v]
    me.from_pydata(verts, [], g.f)
    uvl = me.uv_layers.new(name='UVMap')
    if g.has_uv:
        k = 0
        data = []
        for poly, uvs in zip(me.polygons, g.uv):
            for c in range(poly.loop_total):
                data.extend(uvs[c])
        uvl.data.foreach_set('uv', data)
    me.validate(clean_customdata=False)
    ob = bpy.data.objects.new(piece.name, me)
    (collection or bpy.context.scene.collection).objects.link(ob)
    piece.obj = ob
    ob['wear'] = float(piece.wear)
    for k, v in piece.props.items():
        ob[k] = v
    if piece.local is not None:
        o, x, y = piece.local
        ob['lo'] = tuple(t2b(o))
        ob['lx'] = tuple(t2b(x))
        ob['ly'] = tuple(t2b(y))
    return ob


def _activate(ob):
    for o in bpy.context.selected_objects:
        o.select_set(False)
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)


def orient_closed_islands(bm):
    """per connected island: if it is closed, make its signed volume positive (outward). Blender's
    recalc heuristic picks the wrong side on thin closed shells (straps, prop blades, 12 mm glass)."""
    seen = set()
    bm.faces.ensure_lookup_table()
    for f0 in bm.faces:
        if f0.index in seen:
            continue
        island, stack = [], [f0]
        seen.add(f0.index)
        while stack:
            f = stack.pop()
            island.append(f)
            for e in f.edges:
                for g in e.link_faces:
                    if g.index not in seen:
                        seen.add(g.index)
                        stack.append(g)
        closed = all(len(e.link_faces) == 2 for f in island for e in f.edges)
        if not closed:
            continue
        vol = 0.0
        for f in island:
            vs = [v.co for v in f.verts]
            for i in range(1, len(vs) - 1):
                vol += vs[0].dot(vs[i].cross(vs[i + 1]))
        if vol < 0:
            bmesh.ops.reverse_faces(bm, faces=island)


def finish(piece):
    """weld → (subsurf) → bevel + weighted normals → apply. Leaves a smooth-shaded, custom-normal mesh."""
    ob = piece.obj
    me = ob.data
    bm = bmesh.new()
    bm.from_mesh(me)
    if piece.weld:
        bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=piece.weld)
    bmesh.ops.dissolve_degenerate(bm, edges=bm.edges[:], dist=1e-7)
    if piece.recalc:
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        orient_closed_islands(bm)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = piece.smooth is not None
    if piece.smooth is not None:
        me.set_sharp_from_angle(angle=math.radians(min(piece.smooth, 180.0)))
    if piece.subsurf:
        m = ob.modifiers.new('Sub', 'SUBSURF')
        m.levels = piece.subsurf
        m.render_levels = piece.subsurf
        m.uv_smooth = 'PRESERVE_CORNERS'
    if piece.bevel:
        w, s = piece.bevel
        m = ob.modifiers.new('Bevel', 'BEVEL')
        m.width = w
        m.segments = s
        m.limit_method = 'ANGLE'
        m.angle_limit = math.radians(40)
        m.use_clamp_overlap = True
        m.harden_normals = True
        m.miter_outer = 'MITER_ARC'
    if piece.smooth is not None and (piece.bevel or piece.smooth < 180):
        m = ob.modifiers.new('WN', 'WEIGHTED_NORMAL')
        m.keep_sharp = True
        m.weight = 50
        m.mode = 'FACE_AREA_WITH_ANGLE'
    if ob.modifiers:
        _activate(ob)
        for mod in list(ob.modifiers):
            bpy.ops.object.modifier_apply(modifier=mod.name)
        ob.select_set(False)


def smart_uv_objects(objs, angle=60.0):
    if not objs:
        return
    for o in bpy.context.selected_objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(angle), island_margin=0.0, area_weight=0.0, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    for o in objs:
        o.select_set(False)
