"""
Deterministic numpy mesh operations for the pilot build: smoothing, normals, offsets, sweeps, and
carrying variant shape keys and skin weights onto generated gear.
"""
import math

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

import common as C


# ── topology ────────────────────────────────────────────────────────────────


def tris_of(ob):
    me = ob.data
    me.calc_loop_triangles()
    t = np.empty(len(me.loop_triangles) * 3, dtype=np.int64)
    me.loop_triangles.foreach_get('vertices', t)
    return t.reshape(-1, 3)


def edges_of(ob):
    me = ob.data
    e = np.empty(len(me.edges) * 2, dtype=np.int64)
    me.edges.foreach_get('vertices', e)
    return e.reshape(-1, 2)


def boundary_verts(ob):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    b = np.zeros(len(bm.verts), dtype=bool)
    for e in bm.edges:
        if e.is_boundary:
            b[e.verts[0].index] = True
            b[e.verts[1].index] = True
    bm.free()
    return b


def vertex_normals(co, tris):
    n = np.zeros_like(co)
    a, b, c = co[tris[:, 0]], co[tris[:, 1]], co[tris[:, 2]]
    fn = np.cross(b - a, c - a)  # area weighted
    for k in range(3):
        np.add.at(n, tris[:, k], fn)
    ln = np.linalg.norm(n, axis=1, keepdims=True)
    return n / np.maximum(ln, 1e-12)


def laplacian(co, edges, weights=None):
    """uniform Laplacian: mean of neighbours minus self"""
    n = len(co)
    acc = np.zeros_like(co)
    cnt = np.zeros(n)
    np.add.at(acc, edges[:, 0], co[edges[:, 1]])
    np.add.at(acc, edges[:, 1], co[edges[:, 0]])
    np.add.at(cnt, edges[:, 0], 1)
    np.add.at(cnt, edges[:, 1], 1)
    return acc / np.maximum(cnt, 1)[:, None] - co


def taubin(co, edges, iters, lam=0.5, mu=-0.53, mask=None):
    """volume-preserving smoothing; mask (0..1 per vertex) scales the move, 0 = pinned"""
    co = co.copy()
    m = np.ones(len(co)) if mask is None else np.asarray(mask, dtype=np.float64)
    for _ in range(iters):
        co += lam * m[:, None] * laplacian(co, edges)
        co += mu * m[:, None] * laplacian(co, edges)
    return co


def diffuse(values, edges, iters):
    """smooth a scalar field over the mesh (for soft region masks)"""
    v = values.astype(np.float64).copy()
    for _ in range(iters):
        acc = np.zeros_like(v)
        cnt = np.zeros_like(v)
        np.add.at(acc, edges[:, 0], v[edges[:, 1]])
        np.add.at(acc, edges[:, 1], v[edges[:, 0]])
        np.add.at(cnt, edges[:, 0], 1)
        np.add.at(cnt, edges[:, 1], 1)
        v = 0.5 * v + 0.5 * acc / np.maximum(cnt, 1)
    return v


# ── noise (value noise, deterministic) ──────────────────────────────────────


def _hash3(ix, iy, iz, seed):
    h = (ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791) ^ (seed * 2654435761)
    h = (h ^ (h >> 13)) * 1274126177
    h = h ^ (h >> 16)
    return (h & 0xFFFFFF).astype(np.float64) / float(0xFFFFFF)


def value_noise(p, scale, seed=0):
    q = np.asarray(p, dtype=np.float64) * scale
    i = np.floor(q).astype(np.int64)
    f = q - i
    f = f * f * (3 - 2 * f)
    out = np.zeros(len(q))
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                w = (f[:, 0] if dx else 1 - f[:, 0]) * (f[:, 1] if dy else 1 - f[:, 1]) * (f[:, 2] if dz else 1 - f[:, 2])
                out += w * _hash3(i[:, 0] + dx, i[:, 1] + dy, i[:, 2] + dz, seed)
    return out * 2 - 1


def fbm(p, scale, octaves=3, seed=0):
    s, a, tot, norm = scale, 1.0, 0.0, 0.0
    for o in range(octaves):
        tot = tot + a * value_noise(p, s, seed + o * 17)
        norm += a
        s *= 2.0
        a *= 0.5
    return tot / norm


# ── object helpers ──────────────────────────────────────────────────────────


def key_names(ob):
    return [k.name for k in ob.data.shape_keys.key_blocks] if ob.data.shape_keys else []


def get_key(ob, name):
    kb = ob.data.shape_keys.key_blocks[name]
    co = np.empty(len(kb.data) * 3, dtype=np.float64)
    kb.data.foreach_get('co', co)
    return co.reshape(-1, 3)


def set_key(ob, name, co):
    kb = ob.data.shape_keys.key_blocks[name]
    kb.data.foreach_set('co', np.asarray(co, dtype=np.float32).ravel())
    if name == 'Basis':
        C.set_coords(ob, co)


def all_shapes(ob):
    """{'Basis': co, 'variant_b': co, ...}; objects without keys return {'Basis': vertex co}"""
    names = key_names(ob)
    if not names:
        return {'Basis': C.coords(ob)}
    return {n: get_key(ob, n) for n in names}


def set_all_shapes(ob, shapes):
    names = key_names(ob)
    if not names:
        ob.shape_key_add(name='Basis', from_mix=False)
        names = ['Basis']
    for n, co in shapes.items():
        if n not in names:
            ob.shape_key_add(name=n, from_mix=False).value = 0.0
        set_key(ob, n, co)
    ob.data.update()


def map_shapes(ob, fn):
    """apply fn(co, name) -> co to the basis and every variant key"""
    shapes = all_shapes(ob)
    set_all_shapes(ob, {n: fn(co, n) for n, co in shapes.items()})


def subset_copy(src, face_mask, name):
    """a copy of src with only the masked faces (vertex groups, UVs, attributes, shape keys kept)"""
    ob = src.copy()
    ob.data = src.data.copy()
    ob.name = name
    ob.data.name = name
    C.link(ob)
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.faces.ensure_lookup_table()
    drop = [f for f in bm.faces if not face_mask[f.index]]
    bmesh.ops.delete(bm, geom=drop, context='FACES')
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context='VERTS')
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()
    return ob


def face_mask_from_verts(ob, vmask, rule='all'):
    me = ob.data
    loops = np.empty(len(me.loops), dtype=np.int64)
    me.loops.foreach_get('vertex_index', loops)
    starts = np.empty(len(me.polygons), dtype=np.int64)
    me.polygons.foreach_get('loop_start', starts)
    totals = np.empty(len(me.polygons), dtype=np.int64)
    me.polygons.foreach_get('loop_total', totals)
    out = np.zeros(len(me.polygons), dtype=bool)
    for i, (s, t) in enumerate(zip(starts, totals)):
        vals = vmask[loops[s:s + t]]
        out[i] = vals.all() if rule == 'all' else vals.any()
    return out


def poly_centres(ob):
    co = C.coords(ob)
    me = ob.data
    loops = np.empty(len(me.loops), dtype=np.int64)
    me.loops.foreach_get('vertex_index', loops)
    starts = np.empty(len(me.polygons), dtype=np.int64)
    me.polygons.foreach_get('loop_start', starts)
    totals = np.empty(len(me.polygons), dtype=np.int64)
    me.polygons.foreach_get('loop_total', totals)
    cen = np.zeros((len(me.polygons), 3))
    for i, (s, t) in enumerate(zip(starts, totals)):
        cen[i] = co[loops[s:s + t]].mean(axis=0)
    return cen


def join(objs, name):
    objs = [o for o in objs if o is not None]
    C.select_only(objs, objs[0])
    bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = name
    ob.data.name = name
    return ob


def weld(ob, dist=1e-5):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=dist)
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()


def shade_smooth(ob, angle_deg=None):
    for p in ob.data.polygons:
        p.use_smooth = True
    if angle_deg is not None:
        C.select_only([ob])
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(angle_deg), keep_sharp_edges=True)


# ── carrying variants and weights onto gear ─────────────────────────────────


def surface_binding(src, dst_co):
    """for each dst point: nearest src triangle + barycentric coordinates (on the basis shape)"""
    sco = C.coords(src)
    tris = tris_of(src)
    bvh = BVHTree.FromPolygons([tuple(map(float, v)) for v in sco], [tuple(map(int, t)) for t in tris])
    idx = np.zeros(len(dst_co), dtype=np.int64)
    bary = np.zeros((len(dst_co), 3))
    dist = np.zeros(len(dst_co))
    for i, p in enumerate(dst_co):
        loc, _n, fi, d = bvh.find_nearest(Vector(p))
        if fi is None:
            raise RuntimeError('surface_binding: no nearest face')
        a, b, c = (sco[j] for j in tris[fi])
        v0, v1, v2 = b - a, c - a, np.array(loc) - a
        d00, d01, d11 = v0 @ v0, v0 @ v1, v1 @ v1
        d20, d21 = v2 @ v0, v2 @ v1
        den = d00 * d11 - d01 * d01
        if abs(den) < 1e-18:
            w1 = w2 = 1 / 3
        else:
            w1 = (d11 * d20 - d01 * d21) / den
            w2 = (d00 * d21 - d01 * d20) / den
        bary[i] = (1 - w1 - w2, w1, w2)
        idx[i] = fi
        dist[i] = d
    return tris[idx], bary, dist


def transfer_variant_keys(src, dst, rigid_groups=None):
    """dst gets every variant key of src: each dst vertex moves with the src surface point under it.
    rigid_groups: list of vertex-index arrays that must move as one piece (mean displacement)."""
    src_shapes = all_shapes(src)
    if len(src_shapes) < 2:
        return
    base = C.coords(dst)
    tri_idx, bary, _ = surface_binding(src, base)
    out = {'Basis': base}
    for name, sco in src_shapes.items():
        if name == 'Basis':
            continue
        disp_src = sco - src_shapes['Basis']
        disp = (disp_src[tri_idx] * bary[:, :, None]).sum(axis=1)
        for g in rigid_groups or []:
            disp[g] = disp[g].mean(axis=0)
        out[name] = base + disp
    set_all_shapes(dst, out)


def transfer_weights(src, dst, only_groups=None):
    """dst vertex groups = barycentric blend of src weights at the nearest surface point"""
    base = C.coords(dst)
    tri_idx, bary, _ = surface_binding(src, base)
    names = [g.name for g in src.vertex_groups if (only_groups is None or g.name in only_groups)]
    W = np.zeros((len(src.data.vertices), len(names)))
    col = {src.vertex_groups[n].index: k for k, n in enumerate(names)}
    for v in src.data.vertices:
        for g in v.groups:
            k = col.get(g.group)
            if k is not None:
                W[v.index, k] = g.weight
    Wd = (W[tri_idx] * bary[:, :, None]).sum(axis=1)
    set_weights(dst, names, Wd)


def set_weights(ob, names, W, prune=1e-3):
    for n in names:
        if n in ob.vertex_groups:
            ob.vertex_groups.remove(ob.vertex_groups[n])
    for k, n in enumerate(names):
        col = W[:, k]
        nz = np.nonzero(col > prune)[0]
        if len(nz) == 0:
            continue
        g = ob.vertex_groups.new(name=n)
        for i in nz:
            g.add([int(i)], float(col[i]), 'REPLACE')


def rigid_weights(ob, bone, verts=None):
    g = ob.vertex_groups.get(bone) or ob.vertex_groups.new(name=bone)
    ids = range(len(ob.data.vertices)) if verts is None else verts
    g.add([int(i) for i in ids], 1.0, 'REPLACE')


def limit_and_normalize(ob, limit=4, deform_names=None):
    """≤ limit influences per vertex, weights sum to 1, only deform bones kept"""
    names = [g.name for g in ob.vertex_groups]
    keep = [n for n in names if deform_names is None or n in deform_names]
    idx = {ob.vertex_groups[n].index: k for k, n in enumerate(keep)}
    W = np.zeros((len(ob.data.vertices), len(keep)))
    for v in ob.data.vertices:
        for g in v.groups:
            k = idx.get(g.group)
            if k is not None:
                W[v.index, k] = g.weight
    order = np.argsort(-W, axis=1)
    cut = np.take_along_axis(W, order, axis=1)
    cut[:, limit:] = 0.0
    W2 = np.zeros_like(W)
    np.put_along_axis(W2, order, cut, axis=1)
    s = W2.sum(axis=1, keepdims=True)
    empty = s[:, 0] < 1e-9
    W2 = W2 / np.maximum(s, 1e-9)
    for g in list(ob.vertex_groups):
        ob.vertex_groups.remove(g)
    set_weights(ob, keep, W2, prune=1e-4)
    return int(empty.sum())


# ── procedural geometry ─────────────────────────────────────────────────────


def frames_along(path, up_hint):
    """parallel-transport frames (T, N, B) along a polyline, N starts close to up_hint"""
    path = np.asarray(path, dtype=np.float64)
    T = np.gradient(path, axis=0)
    T /= np.maximum(np.linalg.norm(T, axis=1, keepdims=True), 1e-12)
    N = np.zeros_like(path)
    n0 = np.asarray(up_hint, dtype=np.float64)
    n0 = n0 - (n0 @ T[0]) * T[0]
    if np.linalg.norm(n0) < 1e-6:
        n0 = np.cross(T[0], [1, 0, 0])
    N[0] = n0 / np.linalg.norm(n0)
    for i in range(1, len(path)):
        n = N[i - 1] - (N[i - 1] @ T[i]) * T[i]
        N[i] = n / max(np.linalg.norm(n), 1e-12)
    B = np.cross(T, N)
    return T, N, B


def sweep(path, profile, up_hint=(0, 0, 1), normals=None, closed_profile=True, cap=True, scale=None):
    """profile: (k, 2) points in the (N, B) plane. normals: optional per-point N override
    (e.g. the body surface normal for a strap lying on the body). Returns verts, faces, (u, v)."""
    path = np.asarray(path, dtype=np.float64)
    T, N, B = frames_along(path, up_hint)
    if normals is not None:
        N = np.asarray(normals, dtype=np.float64)
        N = N - (N * T).sum(axis=1, keepdims=True) * T
        N /= np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-12)
        B = np.cross(T, N)
    prof = np.asarray(profile, dtype=np.float64)
    k = len(prof)
    verts = []
    for i in range(len(path)):
        s = 1.0 if scale is None else scale[i]
        for p in prof:
            verts.append(path[i] + s * (p[0] * N[i] + p[1] * B[i]))
    faces = []
    ring = k if closed_profile else k - 1
    for i in range(len(path) - 1):
        for j in range(ring):
            a = i * k + j
            b = i * k + (j + 1) % k
            faces.append((a, b, b + k, a + k))
    if cap and closed_profile:
        faces.append(tuple(range(k - 1, -1, -1)))
        last = (len(path) - 1) * k
        faces.append(tuple(last + j for j in range(k)))
    seglen = np.r_[0, np.cumsum(np.linalg.norm(np.diff(path, axis=0), axis=1))]
    return np.array(verts), faces, seglen


def circle(n, r, start=0.0):
    a = start + np.arange(n) * 2 * math.pi / n
    return np.stack([r * np.cos(a), r * np.sin(a)], axis=1)


def rounded_rect(w, h, r, seg=3):
    pts = []
    for cx, cy, a0 in ((w / 2 - r, h / 2 - r, 0), (-w / 2 + r, h / 2 - r, 90), (-w / 2 + r, -h / 2 + r, 180), (w / 2 - r, -h / 2 + r, 270)):
        for s in range(seg + 1):
            a = math.radians(a0 + 90 * s / seg)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return np.array(pts)


def resample(path, n):
    path = np.asarray(path, dtype=np.float64)
    L = np.r_[0, np.cumsum(np.linalg.norm(np.diff(path, axis=0), axis=1))]
    t = np.linspace(0, L[-1], n)
    return np.stack([np.interp(t, L, path[:, k]) for k in range(3)], axis=1)


def catmull(points, n):
    """Catmull-Rom through control points, resampled to n evenly spaced points"""
    P = np.asarray(points, dtype=np.float64)
    P = np.vstack([2 * P[0] - P[1], P, 2 * P[-1] - P[-2]])
    out = []
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        for t in np.linspace(0, 1, 16, endpoint=False):
            t2, t3 = t * t, t * t * t
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    out.append(P[-2])
    return resample(np.array(out), n)


def project_out(points, bvh, directions, offset, max_dist=0.5):
    """cast each point inward along -direction from outside and place it offset above the hit"""
    out = []
    for p, d in zip(points, directions):
        d = np.asarray(d) / np.linalg.norm(d)
        origin = Vector(np.asarray(p) + d * max_dist)
        hit, nrm, _i, _dist = bvh.ray_cast(origin, Vector(-d), max_dist * 2)
        if hit is None:
            out.append(np.asarray(p))
        else:
            out.append(np.array(hit) + d * offset)
    return np.array(out)


def bvh_of(objs):
    verts, polys = [], []
    for ob in objs:
        co = C.coords(ob)
        mw = np.array(ob.matrix_world)
        co = co @ mw[:3, :3].T + mw[:3, 3]
        base = len(verts)
        verts.extend(map(tuple, co))
        for t in tris_of(ob):
            polys.append(tuple(int(i) + base for i in t))
    return BVHTree.FromPolygons(verts, polys)


def set_gc(ob, gc):
    """`gc` point attribute: surface coordinates (u metres along, v metres across, distance to the
    nearest panel edge in metres). The texture stage bakes it so seams, quilting, weave and binding
    follow the cloth instead of world axes (the bind pose is seated and leaning)."""
    a = ob.data.attributes.get('gc') or ob.data.attributes.new('gc', 'FLOAT_VECTOR', 'POINT')
    a.data.foreach_set('vector', np.asarray(gc, dtype=np.float32).ravel())


def sweep_gc(path, profile, closed_profile=True):
    """gc for a sweep(): u = arc length along the path, v = profile position across (the B axis),
    edge = distance to the profile's lateral edge"""
    path = np.asarray(path, dtype=np.float64)
    L = np.r_[0, np.cumsum(np.linalg.norm(np.diff(path, axis=0), axis=1))]
    prof = np.asarray(profile, dtype=np.float64)
    half = np.abs(prof[:, 1]).max()
    out = np.zeros((len(path) * len(prof), 3))
    for i in range(len(path)):
        out[i * len(prof):(i + 1) * len(prof), 0] = L[i]
        out[i * len(prof):(i + 1) * len(prof), 1] = prof[:, 1]
        out[i * len(prof):(i + 1) * len(prof), 2] = np.minimum(half - np.abs(prof[:, 1]), np.minimum(L[i], L[-1] - L[i]))
    return out


def surface_distance(co, edges, seeds, iters=200):
    """distance along mesh edges from the seed vertices (Bellman-Ford sweeps, vectorised)"""
    dist = np.where(seeds, 0.0, np.inf)
    lens = np.linalg.norm(co[edges[:, 0]] - co[edges[:, 1]], axis=1)
    for _ in range(iters):
        nd = dist.copy()
        np.minimum.at(nd, edges[:, 0], dist[edges[:, 1]] + lens)
        np.minimum.at(nd, edges[:, 1], dist[edges[:, 0]] + lens)
        if np.array_equal(nd, dist):
            break
        dist = nd
    return dist

