"""
Stage 2 (fit): split the MakeHuman body into skin / suit / gloves / boots and build the fitted gear,
all in MakeHuman's A-pose rest (clean normals, no self-contact).

  Skin      head and upper neck (the only visible skin; hands are gloved, the vest collar hides the
            lower neck)
  Suit      body minus head, hands and feet. Taubin-smoothed so fabric drops muscle definition,
            inflated by a per-region thickness, with accordion creases at elbows, knees and hips
  Collar    stand collar swept along the suit's neck opening
  Gloves    hand + 7.5 cm of forearm: smoothed, inflated, flared gauntlet cuff, knuckle pads
  Boots     foot + 14 cm of shin: toes merged, inflated, flat 2 cm sole with a lip
  Vest      foam flotation vest: torso patch of the suit, smoothed, offset, solidified; tall padded
            collar tube; open 2 cm zip gap at the front
  Goggles   two conforming cups (gasket ray-cast onto the face), metal rims, bridge, leather strap
            around the skull; lenses are a separate object (M_PilotLens)
  Headset   single ear cup on the left ear with cushion, headband, temple pad, boom mic with foam,
            and the cable from the cup down to the vest collar
  Bottle    emergency air bottle with valve and two straps on the vest's left chest

Every piece carries: the rig weights (split pieces keep MakeHuman's; generated pieces transfer from
the surface under them or are rigid), the variant shape keys (split pieces keep theirs; generated
pieces follow the surface under them, rigid parts move as one), a per-face `look` id for the
texture compositor, and a Blender material named after its pilot slot.
"""
import math

import bmesh
import bpy
import numpy as np
from mathutils import Vector

import common as C
import meshops as M

LOOKS = {
    'skin': 1, 'eye': 2, 'brow': 3, 'lash': 4, 'hair': 5,
    'suit': 10, 'collar': 11, 'glove': 12, 'glove_pad': 13, 'boot': 14, 'boot_sole': 15,
    'vest': 16, 'vest_collar': 17, 'goggle_frame': 18, 'goggle_gasket': 19, 'goggle_strap': 20,
    'lens': 21, 'headset_shell': 22, 'headset_cushion': 23, 'headband': 24, 'mic_foam': 25,
    'bottle': 26, 'bottle_valve': 27, 'cable': 28, 'webbing': 29, 'buckle': 30, 'strap_band': 31,
    'vest_trim': 32, 'gaiter': 33, 'coil': 34,
}
FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky']


def material(slot):
    m = bpy.data.materials.get(slot)
    if m is None:
        m = bpy.data.materials.new(slot)
    return m


def set_material(ob, slot):
    ob.data.materials.clear()
    ob.data.materials.append(material(slot))


def set_look(ob, look, face_mask=None):
    me = ob.data
    attr = me.attributes.get('look') or me.attributes.new('look', 'INT', 'FACE')
    vals = np.empty(len(me.polygons), dtype=np.int32)
    attr.data.foreach_get('value', vals)
    if face_mask is None:
        vals[:] = LOOKS[look]
    else:
        vals[np.asarray(face_mask, dtype=bool)] = LOOKS[look]
    attr.data.foreach_set('value', vals)


def outward(ob):
    """consistent outward winding: swept profiles can come out inside-out depending on frame handedness"""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()


def new_mesh(name, verts, faces, slot, look, parent=None):
    ob = C.mesh_object(name, verts, faces)
    outward(ob)
    set_material(ob, slot)
    set_look(ob, look)
    M.shade_smooth(ob)
    return ob


def add_part(parts, verts, faces, look):
    """accumulate generated pieces: parts = [verts list, faces list, looks list]"""
    base = sum(len(v) for v in parts[0])
    parts[0].append(np.asarray(verts, dtype=np.float64))
    parts[1].extend(tuple(int(i) + base for i in f) for f in faces)
    parts[2].extend([LOOKS[look]] * len(faces))
    return base, base + len(verts)


def build_parts(name, parts, slot):
    verts = np.vstack(parts[0])
    ob = C.mesh_object(name, verts, parts[1])
    outward(ob)
    set_material(ob, slot)
    attr = ob.data.attributes.new('look', 'INT', 'FACE')
    attr.data.foreach_set('value', np.asarray(parts[2], dtype=np.int32))
    M.shade_smooth(ob)
    return ob


# ── landmarks ───────────────────────────────────────────────────────────────


class Body:
    def __init__(self):
        self.ob = bpy.data.objects['MH_Body']
        self.rig = bpy.data.objects['PilotRig']
        self.J = {b.name: np.array(b.head_local, dtype=np.float64) for b in self.rig.data.bones}
        self.JT = {b.name: np.array(b.tail_local, dtype=np.float64) for b in self.rig.data.bones}
        self.co = C.coords(self.ob)
        self.edges = M.edges_of(self.ob)
        self.tris = M.tris_of(self.ob)
        self.nrm = M.vertex_normals(self.co, self.tris)

    def w(self, names):
        return C.group_weights(self.ob, names)

    def side(self, s):
        return 1.0 if s == 'l' else -1.0


# ── split ───────────────────────────────────────────────────────────────────


GAITER = {'bottom': 0.02, 'topFront': 0.5, 'topBack': 0.68, 'suitCut': 0.22, 'skinCutFront': 0.12, 'skinCutBack': 0.46, 'neckRadiusMax': 0.09, 'segments': 24}


def neck_axis(J):
    a0 = np.asarray(J['neck_01'], dtype=np.float64)
    a1 = np.asarray(J['head'], dtype=np.float64)
    L = np.linalg.norm(a1 - a0)
    return a0, (a1 - a0) / L, L


def neck_t(B, co):
    a0, ax, L = neck_axis(B.J)
    return (co - a0) @ ax / L


def hand_frame(B, s):
    wrist = B.J[f'hand_{s}']
    fdir = wrist - B.J[f'lowerarm_{s}']
    fdir /= np.linalg.norm(fdir)
    return wrist, fdir


def regions(B):
    co = B.co
    neck = B.J['neck_01']
    head = B.J['head']
    # skin: above 40 % of the neck, a little lower at the front (under the jaw)
    front = np.clip(-(co[:, 1] - neck[1]) / 0.08, 0, 1)
    skin = co[:, 2] > neck[2] + 0.42 * (head[2] - neck[2]) - 0.012 * front
    # delete-under-cloth: the rendered skin stops at 40 % of the neck, inside the neck gaiter (which
    # runs from 18 % to 62-84 %), so neither its MakeHuman edge nor the suit's neckline can show
    back = np.clip((co[:, 1] - neck[1]) / 0.06, -1, 1) * 0.5 + 0.5
    cut = GAITER['skinCutFront'] + (GAITER['skinCutBack'] - GAITER['skinCutFront']) * back
    out = {'skin': skin, 'skin_render': neck_t(B, co) > cut}
    for s in ('l', 'r'):
        wrist, fdir = hand_frame(B, s)
        arm = B.w([f'lowerarm_{s}', f'hand_{s}'] + [f'{f}_0{k}_{s}' for f in FINGERS for k in (1, 2, 3)])
        along = (co - wrist) @ fdir
        side = np.sign(co[:, 0]) == B.side(s)
        out[f'glove_{s}'] = side & (arm > 0.4) & (along > -0.048)
        out[f'suitcut_hand_{s}'] = side & (arm > 0.4) & (along > -0.045)
        ankle = B.J[f'foot_{s}']
        leg = B.w([f'calf_{s}', f'foot_{s}', f'ball_{s}'])
        out[f'boot_{s}'] = side & (leg > 0.4) & (co[:, 2] < ankle[2] + 0.14)
        out[f'suitcut_foot_{s}'] = side & (leg > 0.4) & (co[:, 2] < ankle[2] + 0.10)
    return out


# ── suit ────────────────────────────────────────────────────────────────────


def build_suit(B, R, joints, gloves=None):
    cut =R['suitcut_hand_l'] | R['suitcut_hand_r'] | R['suitcut_foot_l'] | R['suitcut_foot_r']
    fm_skin_all = M.face_mask_from_verts(B.ob, R['skin'], 'all')
    fm_cut_any = M.face_mask_from_verts(B.ob, cut, 'all')
    suit = M.subset_copy(B.ob, ~fm_skin_all & ~fm_cut_any, 'Suit')
    co = C.coords(suit)
    edges = M.edges_of(suit)
    tris = M.tris_of(suit)
    bnd = M.boundary_verts(suit)
    pin = 1.0 - M.diffuse(bnd.astype(float), edges, 3).clip(0, 1) * 1.0
    pin = np.clip(pin * 1.6 - 0.3, 0, 1)
    gen = M.diffuse(C.group_weights(suit, ['genitals']), edges, 6)
    gen = np.clip(gen * 3, 0, 1)
    nip = M.diffuse(C.group_weights(suit, ['nipple', 'nippleTip']), edges, 4).clip(0, 1)

    wt = lambda names: C.group_weights(suit, names)  # noqa: E731
    torso = wt(['pelvis', 'spine_01', 'spine_02', 'spine_03'])
    thigh = wt(['thigh_l', 'thigh_r'])
    calf = wt(['calf_l', 'calf_r'])
    upper = wt(['upperarm_l', 'upperarm_r', 'clavicle_l', 'clavicle_r'])
    lower = wt(['lowerarm_l', 'lowerarm_r'])
    thick = 0.0045 + 0.0075 * torso + 0.0085 * thigh + 0.0075 * calf + 0.0055 * upper + 0.004 * lower

    # accordion creases: rings along the limb axis, strongest at the joints
    folds = np.zeros(len(co))
    for s in ('l', 'r'):
        for joint, parent, child, amp, sigma in (
            (f'lowerarm_{s}', f'upperarm_{s}', f'hand_{s}', 0.0038, 0.075),
            (f'calf_{s}', f'thigh_{s}', f'foot_{s}', 0.0042, 0.085),
            (f'thigh_{s}', 'pelvis', f'calf_{s}', 0.0030, 0.07),
            (f'upperarm_{s}', f'clavicle_{s}', f'lowerarm_{s}', 0.0022, 0.06),
        ):
            j = B.J[joint]
            axis = B.J[child] - B.J[parent]
            axis /= np.linalg.norm(axis)
            d = np.linalg.norm(co - j, axis=1)
            g = np.exp(-(d / sigma) ** 2)
            t = (co - j) @ axis
            phase = M.fbm(co, 9.0, 2, seed=11) * 1.8
            folds += amp * g * np.sin(t * 2 * math.pi / 0.032 + phase) * (0.55 + 0.45 * M.fbm(co, 14.0, 2, seed=5))
    # loose fabric: broad low-frequency drape + waist bunching under the belt line
    drape = 0.0022 * M.fbm(co, 6.0, 3, seed=3) + 0.0018 * M.fbm(co * [1, 1, 0.35], 16.0, 2, seed=7)
    waist_z = B.J['spine_01'][2]
    waist = 0.003 * np.exp(-((co[:, 2] - waist_z) / 0.035) ** 2) * (0.5 + 0.5 * M.fbm(co, 30.0, 2, seed=9))
    offset = thick + folds + drape + waist
    # coveralls hang: limb cross-sections never narrower than a straight tube (radius at segment
    # start, end), so calves and forearms read as trouser legs and sleeves, not tights
    tubes = []
    for s in ('l', 'r'):
        tubes += [
            (f'thigh_{s}', f'calf_{s}', wt([f'thigh_{s}']) * (1 - np.clip(torso * 2.5, 0, 1)), 0.080, 0.071),
            (f'calf_{s}', f'foot_{s}', wt([f'calf_{s}']), 0.071, 0.064),
            (f'upperarm_{s}', f'lowerarm_{s}', wt([f'upperarm_{s}']) * (1 - np.clip(torso * 2.5, 0, 1)), 0.056, 0.050),
            (f'lowerarm_{s}', f'hand_{s}', wt([f'lowerarm_{s}']), 0.050, 0.043),
        ]
    tubes = [(a, b, np.clip(w * 1.4, 0, 1), r0, r1) for a, b, w, r0, r1 in tubes]
    hang = 1.0 + 0.10 * M.fbm(co, 11.0, 2, seed=41)

    glove_shapes = M.all_shapes(gloves) if gloves is not None else {}
    glove_tris = M.tris_of(gloves) if gloves is not None else None

    def tuck(c, name):
        """the sleeve end tucks into the glove gauntlet: inside the gauntlet the suit stays 4 mm
        under the glove surface, so the gauntlet flares over the cuff (concept 05)"""
        if name not in glove_shapes:
            return c
        from mathutils.bvhtree import BVHTree
        gco = glove_shapes.get(name, glove_shapes['Basis'])
        bvh = BVHTree.FromPolygons([tuple(map(float, v)) for v in gco], [tuple(map(int, t)) for t in glove_tris])
        J = joints[name]
        c = c.copy()
        for s_, sx in (('l', 1), ('r', -1)):
            wrist = np.array(J[f'hand_{s_}'])
            fdir = wrist - np.array(J[f'lowerarm_{s_}'])
            fdir /= np.linalg.norm(fdir)
            along = (c - wrist) @ fdir
            sel = np.nonzero((np.sign(c[:, 0]) == sx) & (along > -0.13) & (along < 0.0) & (lower > 0.3))[0]
            for i in sel:
                a_ = along[i]
                foot = wrist + fdir * a_
                rv = c[i] - foot
                r = np.linalg.norm(rv)
                if r < 1e-6:
                    continue
                d = rv / r
                probe = wrist + fdir * max(a_, -0.068)
                hit = bvh.ray_cast(Vector(probe + d * 0.15), Vector(-d), 0.2)[0]
                if hit is None:
                    continue
                gr = np.linalg.norm((np.array(hit) - probe) - ((np.array(hit) - probe) @ fdir) * fdir)
                w = np.clip((a_ + 0.125) / 0.045, 0, 1)
                w = w * w * (3 - 2 * w)
                want = min(r, gr - 0.004)
                c[i] = foot + d * (r + (want - r) * w)
        return c

    def smooth_max(a, b, k=0.012):
        return 0.5 * (a + b + np.sqrt((a - b) ** 2 + k * k))

    def shape(c, name):
        J = joints[name]
        c = M.taubin(c, edges, 10, mask=pin * 0.9)
        c = M.taubin(c, edges, 30, mask=np.maximum(gen, nip * 0.6) * pin)
        n = M.vertex_normals(c, tris)
        c = c + n * offset[:, None]
        for a, b, w, r0, r1 in tubes:
            pa, pb = np.array(J[a]), np.array(J[b])
            ax = pb - pa
            L = np.linalg.norm(ax)
            ax /= L
            t = np.clip((c - pa) @ ax / L, 0, 1)
            foot = pa + np.outer(t * L, ax)
            rv = c - foot
            r = np.linalg.norm(rv, axis=1)
            rn = rv / np.maximum(r, 1e-9)[:, None]
            want = smooth_max(r, (r0 + (r1 - r0) * t) * hang)
            c = c + rn * ((want - r) * w)[:, None]
        return tuck(c, name)

    M.map_shapes(suit, shape)
    set_material(suit, 'M_Pilot')
    set_look(suit, 'suit')
    M.shade_smooth(suit)
    return suit


def ordered_loop(ob, vmask):
    """the boundary loop of ob among masked verts, ordered by walking boundary edges"""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.verts.ensure_lookup_table()
    adj = {}
    for e in bm.edges:
        if e.is_boundary:
            a, b = e.verts[0].index, e.verts[1].index
            if vmask[a] and vmask[b]:
                adj.setdefault(a, []).append(b)
                adj.setdefault(b, []).append(a)
    bm.free()
    if not adj:
        return []
    start = min(adj)
    loop, prev, cur = [start], None, start
    while True:
        nxt = [n for n in adj[cur] if n != prev]
        if not nxt or nxt[0] == start:
            break
        prev, cur = cur, nxt[0]
        loop.append(cur)
        if len(loop) > len(adj) + 2:
            break
    return loop


def smooth_neckline(B, suit):
    """the suit's neck opening follows MakeHuman's face edges and zigzags: smooth the edge along the
    loop in every shape. The neck gaiter covers it; this only keeps the gaiter's ray casts clean"""
    co = C.coords(suit)
    neck = B.J['neck_01']
    loop = ordered_loop(suit, co[:, 2] > neck[2] - 0.15)
    if len(loop) < 8:
        raise RuntimeError(f'suit neck opening not found ({len(loop)} verts)')
    idx = np.array(loop)
    k9 = np.ones(9) / 9

    def clean(c, name):
        pts = c[idx]
        sm = np.stack([np.convolve(np.r_[pts[-4:, i], pts[:, i], pts[:4, i]], k9, mode='valid') for i in range(3)], axis=1)
        c = c.copy()
        c[idx] = sm
        return c

    M.map_shapes(suit, clean)


def _circ_smooth(a, k):
    """circular moving average over axis 0"""
    n = len(a)
    ker = np.ones(2 * k + 1) / (2 * k + 1)
    pad = np.concatenate([a[-k:], a, a[:k]], axis=0)
    if a.ndim == 1:
        return np.convolve(pad, ker, mode='valid')
    return np.stack([np.convolve(pad[:, i], ker, mode='valid') for i in range(a.shape[1])], axis=1)


def gaiter_geometry(skin_co, skin_tris, suit_co, suit_tris, J):
    """knit neck gaiter: outer wall from below the suit neckline to under the jaw (higher at the back),
    a soft horizontal fold at mid height, a rolled top lip that turns inside, and an inner wall that
    drops back down against the skin. Radii come from ray casts onto the outermost of skin and suit,
    smoothed so the knit bridges MakeHuman's facets."""
    from mathutils.bvhtree import BVHTree
    a0, ax, L = neck_axis(J)
    # only the neck and the suit's collar line: rays under the jaw must not climb onto the chin
    rel = skin_co - a0
    radial = np.linalg.norm(rel - np.outer(rel @ ax, ax), axis=1)
    tt = rel @ ax / L
    ok = (radial < GAITER['neckRadiusMax']) & (tt < 1.0)
    skin_tris = skin_tris[ok[skin_tris].all(axis=1)]
    relu = suit_co - a0
    ok_u = (relu @ ax / L > -0.6)
    suit_tris = suit_tris[ok_u[suit_tris].all(axis=1)]
    verts = [tuple(map(float, v)) for v in skin_co] + [tuple(map(float, v)) for v in suit_co]
    polys = [tuple(map(int, t)) for t in skin_tris] + [tuple(int(i) + len(skin_co) for i in t) for t in suit_tris]
    bvh = BVHTree.FromPolygons(verts, polys)
    fwd = np.array([0.0, -1.0, 0.0])
    fwd = fwd - (fwd @ ax) * ax
    fwd /= np.linalg.norm(fwd)
    left = np.cross(ax, fwd)
    if left[0] < 0:
        left = -left
    n = GAITER['segments']
    th = np.arange(n) * 2 * math.pi / n  # 0 = front
    dirs = np.outer(np.cos(th), fwd) + np.outer(np.sin(th), left)
    back = 0.5 - 0.5 * np.cos(th)
    top = GAITER['topFront'] + (GAITER['topBack'] - GAITER['topFront']) * back
    rows_t = np.linspace(0, 1, 7)

    def radius_at(t_abs):
        out = np.zeros(n)
        for i in range(n):
            o = a0 + ax * t_abs[i] * L
            hit = bvh.ray_cast(Vector(o + dirs[i] * 0.2), Vector(-dirs[i]), 0.3)[0]
            out[i] = np.linalg.norm((np.array(hit) - o) - ((np.array(hit) - o) @ ax) * ax) if hit is not None else 0.06
        return out

    wall = []
    for f in rows_t:
        t_abs = GAITER['bottom'] + (top - GAITER['bottom']) * f
        r = radius_at(t_abs)
        wall.append((t_abs, r))
    R = np.array([w[1] for w in wall])
    # the knit bridges facets: blur around and along the neck, never narrower than what is under it
    Rs = np.stack([_circ_smooth(R[j], 3) for j in range(len(R))])
    Rs = np.maximum(Rs, R - 0.001)
    for j in range(1, len(Rs) - 1):
        Rs[j] = np.maximum(0.25 * Rs[j - 1] + 0.5 * Rs[j] + 0.25 * Rs[j + 1], R[j] - 0.001)
    thick_rows = 0.0045 + 0.0035 * rows_t ** 2  # the top stands off the neck: room for the head to pitch
    thick = float(thick_rows[-1])
    fold = np.exp(-((rows_t - 0.45) / 0.12) ** 2) * 0.0032 - np.exp(-((rows_t - 0.62) / 0.06) ** 2) * 0.0012
    rings = []
    for j, f in enumerate(rows_t):
        t_abs = wall[j][0]
        # the throat stretches forward when the leaning pilot's head pitches up: the knit's front top
        # stands 7 mm further off so the neck skin stays inside it
        front = np.clip(np.cos(th), 0, 1) ** 2
        r = Rs[j] + thick_rows[j] + fold[j] + 0.007 * front * f ** 1.5 + 0.0012 * np.sin(th * 5 + j * 0.7)  # a slight twist in the knit
        rings.append(a0[None] + np.outer(t_abs * L, ax) + dirs * r[:, None])
    # rolled lip: over the top edge and inside
    rt = Rs[-1]
    t_top = wall[-1][0]
    for ang in (50, 110, 160):
        a_ = math.radians(ang)
        rr = rt + thick * 0.5 + (thick * 0.9) * math.cos(a_)
        tt = t_top * L + (thick * 1.1) * math.sin(a_)
        rings.append(a0[None] + np.outer(np.full(n, 1.0) * 0, ax) + np.outer(tt, ax) + dirs * rr[:, None])
    for drop in (0.006, 0.02):
        rings.append(a0[None] + np.outer(t_top * L - drop, ax) + dirs * (rt + 0.0004)[:, None])
    V = np.vstack(rings)
    faces = []
    for j in range(len(rings) - 1):
        for i in range(n):
            a, b = j * n + i, j * n + (i + 1) % n
            faces.append((a, b, b + n, a + n))
    # gc: u around the neck (m), v up the knit (m, continuing over the lip), edge = distance to the hem
    circ = 2 * math.pi * float(Rs.mean())
    ring_h = np.r_[0, np.cumsum([float(np.linalg.norm(rings[j + 1] - rings[j], axis=1).mean()) for j in range(len(rings) - 1)])]
    gc = np.zeros((len(rings) * n, 3))
    for j in range(len(rings)):
        gc[j * n:(j + 1) * n, 0] = np.arange(n) / n * circ
        gc[j * n:(j + 1) * n, 1] = ring_h[j]
        gc[j * n:(j + 1) * n, 2] = min(ring_h[j], ring_h[-1] - ring_h[j])
    return V, faces, gc


def build_gaiter(B, skin, suit, joints):
    stris = M.tris_of(skin)
    utris = M.tris_of(suit)
    sk_shapes = M.all_shapes(skin)
    su_shapes = M.all_shapes(suit)
    geo = {name: gaiter_geometry(sk_shapes[name], stris, su_shapes[name], utris, joints[name]) for name in sk_shapes}
    v, f, gc = geo['Basis']
    ob = C.mesh_object('Gaiter', v, f)
    M.set_gc(ob, gc)
    # winding: faces must point away from the neck axis
    a0, ax, _L = neck_axis(joints['Basis'])
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.faces.ensure_lookup_table()
    fc = bm.faces[len(bm.faces) // 4]
    c = np.array(fc.calc_center_median())
    radial = (c - a0) - ((c - a0) @ ax) * ax
    if np.array(fc.normal) @ radial < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    bm.to_mesh(ob.data)
    bm.free()
    set_material(ob, 'M_Pilot')
    set_look(ob, 'gaiter')
    M.shade_smooth(ob)
    M.set_all_shapes(ob, {k: g[0] for k, g in geo.items()})
    # weights: the lower rows hang on the suit's collar line (chest, clavicles), the upper rows follow
    # the neck skin; blended along the neck so the gaiter bottom never lifts off the suit
    co = C.coords(ob)
    t = (co - a0) @ ax / _L
    w_top = np.clip((t - 0.1) / 0.35, 0, 1)
    w_top = w_top * w_top * (3 - 2 * w_top)
    names, W = {}, []
    for src, k in ((suit, 1 - w_top), (skin, w_top)):
        tri_idx, bary, _ = M.surface_binding(src, co)
        gn = [g.name for g in src.vertex_groups]
        Ws = np.zeros((len(src.data.vertices), len(gn)))
        for v in src.data.vertices:
            for g in v.groups:
                Ws[v.index, g.group] = g.weight
        Wd = (Ws[tri_idx] * bary[:, :, None]).sum(axis=1) * k[:, None]
        for j, n in enumerate(gn):
            names.setdefault(n, np.zeros(len(co)))
            names[n] += Wd[:, j]
    keys = sorted(names)
    M.set_weights(ob, keys, np.stack([names[n] for n in keys], axis=1))
    # the knit's top follows the throat more than the suit does: when the head pitches back the neck
    # skin must not slide out over the gaiter's front
    cap_head_weight(ob, joints['Basis'], top_share=0.9)
    return ob


def trim_suit_neck(suit, J):
    """delete-under-cloth: the suit stops inside the gaiter (its neckline ends at GAITER suitCut along
    the neck, the gaiter runs from `bottom` well above that), so its edge can never show"""
    a0, ax, L = neck_axis(J)
    co = C.coords(suit)
    t = (co - a0) @ ax / L
    rad = np.linalg.norm((co - a0) - np.outer((co - a0) @ ax, ax), axis=1)
    fm = M.face_mask_from_verts(suit, (t > GAITER['suitCut']) & (rad < 0.2), 'any')
    bm = bmesh.new()
    bm.from_mesh(suit.data)
    bm.faces.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[bm.faces[i] for i in np.nonzero(fm)[0]], context='FACES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    bm.to_mesh(suit.data)
    bm.free()
    suit.data.update()


def cap_head_weight(ob, J, top_share=0.35):
    """cloth at the neck hangs from the collar line: the head's share is capped (0 at the collar, 35 %
    at the top of the gaiter) and handed to neck_01, the same rule for the gaiter and the suit's
    neckline so the two never part when the head turns or pitches"""
    if 'head' not in ob.vertex_groups:
        return
    a0, ax, L = neck_axis(J)
    co = C.coords(ob)
    t = (co - a0) @ ax / L
    hg = ob.vertex_groups['head']
    ng = ob.vertex_groups.get('neck_01') or ob.vertex_groups.new(name='neck_01')
    for i in np.nonzero(t > -0.3)[0]:
        try:
            w = hg.weight(int(i))
        except RuntimeError:
            continue
        cap = top_share * float(np.clip((t[i] - 0.4) / 0.45, 0, 1))
        if w > cap:
            try:
                wn = ng.weight(int(i))
            except RuntimeError:
                wn = 0.0
            hg.add([int(i)], cap, 'REPLACE')
            ng.add([int(i)], float(wn + w - cap), 'REPLACE')


def hide_suit_under_vest(suit, vest_geo):
    """delete-under-cloth: suit faces fully inside the foam vest (between its hem and armholes, away
    from the zip gap) never show. Uses the basis vest grid with margins."""
    P, th, J = vest_geo['Basis'][3], vest_geo['Basis'][5], vest_geo['joints']
    bot = np.array(J['spine_01'])
    top = np.array(J['neck_01'])
    co = C.coords(suit)
    rows, cols = P.shape[0], P.shape[1]
    zb = P[0, :, 2].mean() + 0.03
    zt = P[-1, :, 2]
    f = np.clip((co[:, 2] - bot[2]) / max(top[2] - bot[2], 1e-6), 0, 1)
    axis = bot[None] + (top - bot)[None] * f[:, None]
    rel = co - axis
    ang = np.mod(np.arctan2(rel[:, 0], -rel[:, 1]), 2 * math.pi)
    ci = np.clip(np.interp(ang, th, np.arange(cols)), 0, cols - 1).astype(int)
    rad = np.hypot(rel[:, 0], rel[:, 1])
    ri = np.clip(np.interp(co[:, 2], P[:, 0, 2], np.arange(rows)), 0, rows - 1).astype(int)
    vest_r = np.hypot(P[ri, ci, 0] - axis[:, 0], P[ri, ci, 1] - axis[:, 1])
    deg = np.degrees(ang)
    covered = (co[:, 2] > zb) & (co[:, 2] < zt[ci] - 0.035) & (deg > 16) & (deg < 344) & (rad < vest_r + 0.004)
    fm = M.face_mask_from_verts(suit, covered, 'all')
    bm = bmesh.new()
    bm.from_mesh(suit.data)
    bm.faces.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[bm.faces[i] for i in np.nonzero(fm)[0]], context='FACES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    bm.to_mesh(suit.data)
    bm.free()
    suit.data.update()
    return int(fm.sum())


# ── gloves ──────────────────────────────────────────────────────────────────


def build_gloves(B, R):
    out = []
    for s in ('l', 'r'):
        fm = M.face_mask_from_verts(B.ob, R[f'glove_{s}'], 'any')
        g = M.subset_copy(B.ob, fm, f'Glove_{s}')
        co = C.coords(g)
        edges = M.edges_of(g)
        tris = M.tris_of(g)
        wrist, fdir = hand_frame(B, s)
        along = (co - wrist) @ fdir
        nails = M.diffuse(C.group_weights(g, ['fingernails']), edges, 4).clip(0, 1)
        bnd = M.boundary_verts(g)
        pin = 1 - M.diffuse(bnd.astype(float), edges, 2).clip(0, 1)
        # palm/back axis from PCA of the hand; the thumb sits on the palm side
        hand = co[along > 0.01]
        cen = hand.mean(axis=0)
        _u, _s, vt = np.linalg.svd(hand - cen, full_matrices=False)
        thin = vt[2]
        if (B.J[f'thumb_02_{s}'] - cen) @ thin > 0:
            thin = -thin
        back_dir = thin
        nrm = M.vertex_normals(co, tris)
        backness = np.clip((nrm @ back_dir) * 1.5, 0, 1)
        pads = np.zeros(len(co))
        for f in ('index', 'middle', 'ring', 'pinky'):
            k = B.J[f'{f}_01_{s}']
            pads += np.exp(-(np.linalg.norm(co - k, axis=1) / 0.013) ** 2)
        pads = np.clip(pads, 0, 1) * backness
        plate = np.exp(-(((along - 0.045) / 0.03) ** 2)) * backness
        cuff = np.clip((-0.02 - along) / 0.055, 0, 1)
        thick = 0.0032 + 0.0018 * (along < 0.08) + 0.006 * cuff + 0.0035 * pads + 0.0012 * plate
        creases = 0.0007 * M.fbm(co, 60.0, 2, seed=21) * (along > 0.05)

        def shape(c, name, thick=thick, creases=creases, nails=nails, pin=pin, tris=tris, edges=edges):
            c = M.taubin(c, edges, 6, mask=pin)
            c = M.taubin(c, edges, 16, mask=nails * pin)
            n = M.vertex_normals(c, tris)
            return c + n * (thick + creases)[:, None]

        M.map_shapes(g, shape)
        set_material(g, 'M_Pilot')
        set_look(g, 'glove')
        pad_faces = M.face_mask_from_verts(g, pads > 0.45, 'all')
        set_look(g, 'glove_pad', pad_faces)
        M.shade_smooth(g)
        out.append(g)
        out.append(build_gauntlet(B, s))
    return M.join(out, 'Gloves')


def build_gauntlet(B, s, seg=16):
    """leather gauntlet cuff swept around the forearm (concept 05): starts over the glove's wrist edge,
    flares to ~2 cm over the arm so the tucked sleeve end sits inside it, a rolled top lip turning in.
    A clean sweep instead of inflating MakeHuman's boundary faces (which made a pointed flap)."""
    from mathutils.bvhtree import BVHTree
    wrist, fdir = hand_frame(B, s)
    ref = np.array([0.0, 0.0, 1.0])
    e1 = ref - (ref @ fdir) * fdir
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(fdir, e1)
    bvh = BVHTree.FromPolygons([tuple(map(float, v)) for v in B.co], [tuple(map(int, t)) for t in B.tris])
    ang = np.arange(seg) * 2 * math.pi / seg
    dirs = np.outer(np.cos(ang), e1) + np.outer(np.sin(ang), e2)
    # (along from the wrist, offset over the arm surface)
    rows = [(-0.026, 0.0052), (-0.045, 0.011), (-0.064, 0.0165), (-0.082, 0.0205), (-0.089, 0.0205), (-0.091, 0.0165), (-0.084, 0.013)]
    verts = []
    base_r = None
    for a_, off in rows:
        o = wrist + fdir * max(a_, -0.08)
        rr = []
        for d in dirs:
            hit = bvh.ray_cast(Vector(o + d * 0.15), Vector(-d), 0.2)[0]
            rr.append(np.linalg.norm(np.array(hit) - o) if hit is not None else 0.03)
        rr = _circ_smooth(np.array(rr), 2)
        base_r = rr if base_r is None else np.maximum(rr, base_r * 0.0 + rr)
        verts.append(wrist[None] + fdir[None] * a_ + dirs * (rr + off)[:, None])
    V = np.vstack(verts)
    faces = []
    for j in range(len(rows) - 1):
        for i in range(seg):
            a, b = j * seg + i, j * seg + (i + 1) % seg
            faces.append((a, b, b + seg, a + seg))
    ob = C.mesh_object(f'Gauntlet_{s}', V, faces)
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.faces.ensure_lookup_table()
    f0 = bm.faces[seg]
    rad = np.array(f0.calc_center_median()) - wrist
    rad = rad - (rad @ fdir) * fdir
    if np.array(f0.normal) @ rad < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    bm.to_mesh(ob.data)
    bm.free()
    set_material(ob, 'M_Pilot')
    set_look(ob, 'glove')
    M.shade_smooth(ob)
    M.transfer_weights(B.ob, ob)
    M.transfer_variant_keys(B.ob, ob)
    return ob


# ── boots ───────────────────────────────────────────────────────────────────


def build_boots(B, R, joints):
    """voxel-remeshed boot volume (toes merge), bisected shaft with a rolled lip, flat lug sole"""
    out = []
    for s in ('l', 'r'):
        fm = M.face_mask_from_verts(B.ob, R[f'boot_{s}'], 'any')
        src = M.subset_copy(B.ob, fm, f'BootSrc_{s}')
        vol = src.copy()
        vol.data = src.data.copy()
        vol.name = f'Boot_{s}'
        C.link(vol)
        if vol.data.shape_keys:
            base = C.coords(vol)
            vol.shape_key_clear()
            C.set_coords(vol, base)
        for g in list(vol.vertex_groups):
            vol.vertex_groups.remove(g)
        ankle = B.J[f'foot_{s}']
        top_z = ankle[2] + 0.135
        bm = bmesh.new()
        bm.from_mesh(vol.data)
        bmesh.ops.holes_fill(bm, edges=[e for e in bm.edges if e.is_boundary], sides=0)
        bm.to_mesh(vol.data)
        bm.free()
        co = C.coords(vol)
        tris = M.tris_of(vol)
        n = M.vertex_normals(co, tris)
        up = np.clip((co[:, 2] - (ankle[2] + 0.02)) / 0.12, 0, 1)
        C.set_coords(vol, co + n * (0.010 + 0.004 * up)[:, None])
        mod = vol.modifiers.new('remesh', 'REMESH')
        mod.mode = 'VOXEL'
        mod.voxel_size = 0.0045
        mod.adaptivity = 0.0
        mod.use_smooth_shade = True
        C.select_only([vol])
        bpy.ops.object.modifier_apply(modifier=mod.name)
        # open the shaft with a clean plane cut
        bm = bmesh.new()
        bm.from_mesh(vol.data)
        geom = list(bm.verts) + list(bm.edges) + list(bm.faces)
        bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-6, plane_co=(0, 0, top_z), plane_no=(0, 0, 1), clear_outer=True)
        bm.to_mesh(vol.data)
        bm.free()
        co = C.coords(vol)
        edges = M.edges_of(vol)
        bnd = M.boundary_verts(vol)
        co = M.taubin(co, edges, 12, mask=1 - bnd.astype(float))
        # sole: flatten the bottom 12 mm, push a 5 mm lip out around it
        ground = co[:, 2].min()
        low = np.clip((0.03 - (co[:, 2] - ground)) / 0.03, 0, 1)
        cen = co[low > 0.5].mean(axis=0)
        fwd = B.J[f'ball_{s}'] - ankle
        fwd[2] = 0
        fwd /= np.linalg.norm(fwd)
        rad = co - cen
        rad[:, 2] = 0
        rad /= np.maximum(np.linalg.norm(rad, axis=1, keepdims=True), 1e-9)
        co = co + rad * (0.005 * low)[:, None]
        co[:, 2] = np.where(co[:, 2] - ground < 0.013, ground - 0.006, co[:, 2])
        C.set_coords(vol, co)
        # rolled lip: extrude the shaft opening inward and down
        bm = bmesh.new()
        bm.from_mesh(vol.data)
        ring = [e for e in bm.edges if e.is_boundary]
        rv = list({v for e in ring for v in e.verts})
        c_top = np.mean([np.array(v.co) for v in rv], axis=0)
        res = bmesh.ops.extrude_edge_only(bm, edges=ring)
        for v in [g for g in res['geom'] if isinstance(g, bmesh.types.BMVert)]:
            d = np.array(v.co) - c_top
            d[2] = 0
            d /= max(np.linalg.norm(d), 1e-9)
            v.co = v.co + bpy_vec(-d * 0.006 + np.array([0, 0, -0.012]))
        bm.to_mesh(vol.data)
        bm.free()
        target = 1500
        dec = vol.modifiers.new('dec', 'DECIMATE')
        dec.ratio = min(1.0, target / max(1, C.tri_count(vol)))
        bpy.ops.object.modifier_apply(modifier=dec.name)
        canonical_topology(vol)
        set_material(vol, 'M_Pilot')
        set_look(vol, 'boot')
        co = C.coords(vol)
        sole = M.face_mask_from_verts(vol, co[:, 2] < co[:, 2].min() + 0.02, 'all')
        set_look(vol, 'boot_sole', sole)
        M.shade_smooth(vol)
        M.transfer_weights(src, vol)
        M.transfer_variant_keys(src, vol)
        bpy.data.objects.remove(src, do_unlink=True)
        out.append(vol)
    return M.join(out, 'Boots')


def canonical_topology(ob):
    """voxel remesh + collapse return the same surface with a run-dependent vertex/face order (OpenVDB
    is multithreaded), which changes every later UV pack. Rebuild the mesh with vertices sorted by
    position and faces sorted by their vertex indices, so the build is reproducible. Call it only
    before weights, UVs or attributes exist on the mesh."""
    me = ob.data
    co = np.array([v.co for v in me.vertices], dtype=np.float64)
    order = np.lexsort((np.round(co[:, 2], 6), np.round(co[:, 1], 6), np.round(co[:, 0], 6)))
    remap = np.empty(len(order), dtype=np.int64)
    remap[order] = np.arange(len(order))
    faces = []
    for p in me.polygons:
        f = [int(remap[i]) for i in p.vertices]
        k = f.index(min(f))
        faces.append(tuple(f[k:] + f[:k]))
    faces.sort()
    new = bpy.data.meshes.new(me.name)
    new.from_pydata([tuple(map(float, v)) for v in co[order]], [], faces)
    new.update()
    ob.data = new
    bpy.data.meshes.remove(me)


def unit_or(v, fallback):
    n = np.linalg.norm(v)
    return v / n if n > 1e-9 else fallback


def bpy_vec(a):
    from mathutils import Vector
    return Vector(tuple(float(x) for x in a))


VEST_COLS = 32
VEST_ROWS = 11


def _vest_grid(suit_co, suit_tris, J):
    from mathutils.bvhtree import BVHTree
    from mathutils import Vector
    bvh = BVHTree.FromPolygons([tuple(map(float, v)) for v in suit_co], [tuple(map(int, t)) for t in suit_tris])
    bot = np.array(J['spine_01'])
    top = np.array(J['neck_01'])
    z_bot = bot[2] + 0.035
    z_front = np.array(J['clavicle_l'])[2] - 0.075
    z_back = top[2] - 0.055
    z_arm = np.array(J['upperarm_l'])[2] - 0.085
    th = np.radians(np.linspace(7, 353, VEST_COLS))
    R = np.zeros((VEST_ROWS, VEST_COLS))
    Z = np.zeros((VEST_ROWS, VEST_COLS))
    AX = np.zeros((VEST_ROWS, VEST_COLS, 3))
    for ci, t in enumerate(th):
        deg = math.degrees(t)
        side_dist = min(abs(deg - 90), abs(deg - 270))
        x = np.clip((side_dist - 22.0) / (58.0 - 22.0), 0, 1)
        dip = 1 - x * x * (3 - 2 * x)  # 1 in the armhole, 0 on the front and back panels
        back = np.clip((abs(deg - 180) < 90) * 1.0, 0, 1)
        zt = z_front + (z_back - z_front) * back
        zt = zt - (zt - z_arm) * dip
        d = np.array([math.sin(t), -math.cos(t), 0.0])
        last = 0.12
        for ri, z in enumerate(np.linspace(z_bot, zt, VEST_ROWS)):
            f = (z - bot[2]) / max(top[2] - bot[2], 1e-6)
            a = bot + (top - bot) * np.clip(f, 0, 1)
            a[2] = z
            hit = bvh.ray_cast(Vector(a), Vector(d), 0.6)[0]
            r = (np.array(hit) - a) @ d if hit is not None else last
            last = r
            R[ri, ci], Z[ri, ci], AX[ri, ci] = r, z, a
    # the vest is stiff foam: blur the radii so it bridges the suit's folds
    for _ in range(6):
        Rp = np.pad(R, 1, mode='edge')
        R = 0.4 * R + 0.15 * (Rp[:-2, 1:-1] + Rp[2:, 1:-1] + Rp[1:-1, :-2] + Rp[1:-1, 2:])
    R = R + 0.012
    P = np.zeros((VEST_ROWS, VEST_COLS, 3))
    for ci, t in enumerate(th):
        d = np.array([math.sin(t), -math.cos(t), 0.0])
        P[:, ci] = AX[:, ci] + R[:, ci, None] * d
    return P, th


def _grid_normals(P):
    du = np.gradient(P, axis=1)
    dv = np.gradient(P, axis=0)
    n = np.cross(dv, du)
    return n / np.maximum(np.linalg.norm(n, axis=2, keepdims=True), 1e-12)


def vest_geometry(suit_co, suit_tris, J):
    P, th = _vest_grid(suit_co, suit_tris, J)
    N = _grid_normals(P)
    # outward check: normal must point away from the torso axis
    mid = P[VEST_ROWS // 2, VEST_COLS // 4]
    if (N[VEST_ROWS // 2, VEST_COLS // 4] @ np.array([math.sin(th[VEST_COLS // 4]), -math.cos(th[VEST_COLS // 4]), 0])) < 0:
        N = -N
    edge = np.ones((VEST_ROWS, VEST_COLS))
    edge[0, :] = edge[-1, :] = 0
    edge[:, 0] = edge[:, -1] = 0
    puff = np.minimum.outer(np.minimum(np.arange(VEST_ROWS), np.arange(VEST_ROWS)[::-1]),
                            np.minimum(np.arange(VEST_COLS), np.arange(VEST_COLS)[::-1]))
    puff = np.clip(puff / 3.0, 0, 1)
    thick = 0.018 + 0.008 * puff
    inner = P
    outer = P + N * thick[:, :, None]
    verts = np.vstack([inner.reshape(-1, 3), outer.reshape(-1, 3)])
    nrc = VEST_ROWS * VEST_COLS
    idx = lambda r, c, o: o * nrc + r * VEST_COLS + c  # noqa: E731
    faces = []
    for r in range(VEST_ROWS - 1):
        for c in range(VEST_COLS - 1):
            faces.append((idx(r, c, 1), idx(r, c + 1, 1), idx(r + 1, c + 1, 1), idx(r + 1, c, 1)))
            faces.append((idx(r, c, 0), idx(r + 1, c, 0), idx(r + 1, c + 1, 0), idx(r, c + 1, 0)))
    n_panel = len(faces)
    for c in range(VEST_COLS - 1):
        faces.append((idx(0, c, 0), idx(0, c + 1, 0), idx(0, c + 1, 1), idx(0, c, 1)))
        r = VEST_ROWS - 1
        faces.append((idx(r, c, 1), idx(r, c + 1, 1), idx(r, c + 1, 0), idx(r, c, 0)))
    for r in range(VEST_ROWS - 1):
        faces.append((idx(r, 0, 1), idx(r + 1, 0, 1), idx(r + 1, 0, 0), idx(r, 0, 0)))
        c = VEST_COLS - 1
        faces.append((idx(r, c, 0), idx(r + 1, c, 0), idx(r + 1, c, 1), idx(r, c, 1)))
    # shoulder straps: front top to back top over the trapezius
    from mathutils.bvhtree import BVHTree
    from mathutils import Vector
    bvh = BVHTree.FromPolygons([tuple(map(float, v)) for v in suit_co], [tuple(map(int, t)) for t in suit_tris])
    straps = []
    for sgn in (1, -1):
        cf = int(round((38 if sgn > 0 else 322) / 346 * (VEST_COLS - 1) - 7 / 346 * (VEST_COLS - 1)))
        cb = int(round((142 if sgn > 0 else 218) / 346 * (VEST_COLS - 1) - 7 / 346 * (VEST_COLS - 1)))
        f0 = outer[-4, cf] - N[-4, cf] * 0.02
        b0 = outer[-4, cb] - N[-4, cb] * 0.02
        clav = np.array(J['clavicle_l' if sgn > 0 else 'clavicle_r'])
        shoulder = np.array(J['upperarm_l' if sgn > 0 else 'upperarm_r'])
        above = np.array([shoulder[0] * 0.62, (f0[1] + b0[1]) / 2, shoulder[2] + 0.4])
        hit = bvh.ray_cast(Vector(above), Vector((0, 0, -1)), 0.8)[0]
        top_pt = (np.array(hit) if hit is not None else clav + np.array([0, 0, 0.06])) + np.array([0, 0, 0.022])
        fm = (f0 + top_pt) / 2 + (N[-3, cf] * 0.01) + np.array([0, 0, 0.02])
        bmid = (b0 + top_pt) / 2 + (N[-3, cb] * 0.01) + np.array([0, 0, 0.02])
        fm = (f0 + top_pt) / 2 + N[-3, cf] * 0.024
        bmid = (b0 + top_pt) / 2 + N[-3, cb] * 0.024
        path = M.catmull([f0, fm, top_pt, bmid, b0], 16)
        cen = np.array([shoulder[0] * 0.45, (f0[1] + b0[1]) / 2, shoulder[2] - 0.12])
        nrm = path - cen
        nrm /= np.linalg.norm(nrm, axis=1, keepdims=True)
        # lay the middle of the strap on the suit (never inside it)
        for k in range(2, len(path) - 2):
            loc = bvh.ray_cast(Vector(path[k] + nrm[k] * 0.3), Vector(-nrm[k]), 0.6)[0]
            if loc is not None:
                on = np.array(loc) + nrm[k] * 0.017
                if (on - path[k]) @ nrm[k] > 0:
                    path[k] = on
        path = M.catmull(path[::3].tolist() + [path[-1]], 12)
        nrm = path - cen
        nrm /= np.linalg.norm(nrm, axis=1, keepdims=True)
        v, f, _ = M.sweep(path, M.rounded_rect(0.020, 0.080, 0.008, 1), normals=nrm)
        straps.append((v, f))
    return verts, faces, straps, outer, N, th, n_panel


def build_vest(B, suit, joints):
    shapes = M.all_shapes(suit)
    tris = M.tris_of(suit)
    geo = {name: vest_geometry(co, tris, joints[name]) for name, co in shapes.items()}
    v0, f0, straps0, _o, _n, _t, n_panel = geo['Basis']
    verts = [v0]
    faces = list(f0)
    looks = [LOOKS['vest']] * n_panel + [LOOKS['vest_trim']] * (len(f0) - n_panel)
    base = len(v0)
    for v, f in straps0:
        faces += [tuple(i + base for i in ff) for ff in f]
        looks += [LOOKS['vest']] * len(f)
        base += len(v)
        verts.append(v)
    vest = C.mesh_object('Vest', np.vstack(verts), faces)
    vest.data.attributes.new('look', 'INT', 'FACE').data.foreach_set('value', np.asarray(looks, dtype=np.int32))
    set_material(vest, 'M_Pilot')
    M.shade_smooth(vest)
    M.set_all_shapes(vest, {name: np.vstack([g[0]] + [s[0] for s in g[2]]) for name, g in geo.items()})
    M.transfer_weights(suit, vest)
    vest['grid'] = [VEST_ROWS, VEST_COLS]
    # gc: girth and height along the foam panels (inner + outer grid), strap length/width
    outer = geo['Basis'][3]
    du = np.linalg.norm(np.diff(outer, axis=1), axis=2).mean(axis=0)
    dv = np.linalg.norm(np.diff(outer, axis=0), axis=2).mean(axis=1)
    U = np.r_[0, np.cumsum(du)]
    Vh = np.r_[0, np.cumsum(dv)]
    g = np.zeros((VEST_ROWS, VEST_COLS, 3))
    g[..., 0] = U[None, :]
    g[..., 1] = Vh[:, None]
    g[..., 2] = np.minimum(np.minimum(U[None, :], U[-1] - U[None, :]), np.minimum(Vh[:, None], Vh[-1] - Vh[:, None]))
    gcs = [g.reshape(-1, 3), g.reshape(-1, 3)]
    for v, _f in straps0:
        gcs.append(np.zeros((len(v), 3)))
    gc = np.vstack(gcs)
    k = len(M.rounded_rect(0.020, 0.080, 0.008, 1))
    base = len(v0)
    for v, _f in straps0:
        ring = len(v) // k
        path = v.reshape(ring, k, 3).mean(axis=1)
        gc[base:base + len(v)] = M.sweep_gc(path, M.rounded_rect(0.020, 0.080, 0.008, 1))
        base += len(v)
    M.set_gc(vest, gc)
    return vest, geo


def build_vest_collar(B, vest, geo, joints, suit):
    """tall padded foam collar: a tube around the back and sides of the neck, open at the front,
    resting on the vest's shoulder straps"""
    from mathutils.bvhtree import BVHTree
    from mathutils import Vector
    shapes = {}
    tris = M.tris_of(suit)
    for name, sco in M.all_shapes(suit).items():
        J = joints[name]
        neck = np.array(J['neck_01'])
        bvh = BVHTree.FromPolygons([tuple(map(float, v)) for v in sco], [tuple(map(int, t)) for t in tris])
        pts, nrms = [], []
        n = 25
        for i in range(n):
            a = math.radians(-118 + 236 * i / (n - 1))  # 0 = back of the neck
            d = np.array([math.sin(a), math.cos(a), 0.0])
            back = 0.5 + 0.5 * math.cos(a)
            c = neck + np.array([0.0, 0.012, -0.012 + 0.03 * back])
            hit = bvh.ray_cast(Vector(c + d * 0.4), Vector(-d), 0.5)[0]
            r = np.linalg.norm((np.array(hit) - c)[:2]) if hit is not None else 0.07
            r = max(r, 0.06)
            pts.append(c + d * (r + 0.018) + np.array([0, 0, 0.012 * back]))
            nrms.append(d)
        pts = M.catmull(pts, 20)
        nrms = M.resample(np.array(nrms), 20)
        a = np.linspace(-1, 1, 20)
        scale = 0.5 + 0.5 * np.cos(a * math.pi / 2) ** 0.7
        v, f, _ = M.sweep(pts, M.circle(10, 1.0) * [0.034, 0.019], normals=nrms, scale=scale)
        shapes[name] = (v, f)
    v, f = shapes['Basis']
    ob = new_mesh('VestCollar', v, f, 'M_Pilot', 'vest_collar')
    M.set_gc(ob, M.sweep_gc(shapes['Basis'][0].reshape(20, 10, 3).mean(axis=1), M.circle(10, 1.0) * [0.034, 0.019]))
    M.set_all_shapes(ob, {n: s[0] for n, s in shapes.items()})
    M.transfer_weights(vest, ob)
    if 'head' in ob.vertex_groups:
        ob.vertex_groups.remove(ob.vertex_groups['head'])
    return ob


# ── goggles ─────────────────────────────────────────────────────────────────


def eye_centres():
    eyes = bpy.data.objects['MH_Eyes']
    co = C.coords(eyes)
    left = co[co[:, 0] > 0].mean(axis=0)
    right = co[co[:, 0] < 0].mean(axis=0)
    radius = np.linalg.norm(co[co[:, 0] > 0] - left, axis=1).max()
    return {'l': left, 'r': right}, radius


def build_goggles(B, skin):
    eyes, er = eye_centres()
    bvh = M.bvh_of([skin] + [o for o in (bpy.data.objects.get('ScalpSrc'),) if o])  # the full skull, scalp included
    frame = [[], [], []]
    lens = [[], [], []]
    rigid = []
    seg = 20
    outer_pts = {}
    for s, e in eyes.items():
        sx = 1.0 if s == 'l' else -1.0
        axis = np.array([0.16 * sx, -1.0, 0.03])
        axis /= np.linalg.norm(axis)
        right = np.cross(axis, [0, 0, 1])
        right /= np.linalg.norm(right)
        up = np.cross(right, axis)
        front_c = e + axis * (er + 0.019)
        rx, ry = 0.0235, 0.0195
        ang = np.arange(seg) * 2 * math.pi / seg
        radial = np.outer(np.cos(ang), right * rx) + np.outer(np.sin(ang), up * ry)
        rdir = radial / np.linalg.norm(radial, axis=1, keepdims=True)
        # gasket ring at a fixed depth; any point that ends up inside the face is pushed forward
        # onto the skin (a ray cast forward from inside the head leaves through the skin)
        gasket = front_c[None] + radial * 1.26 - axis * 0.026
        for gi, p in enumerate(gasket):
            loc, _n, _i, dist = bvh.ray_cast(Vector(p - axis * 0.03), Vector(axis), 0.06)
            if loc is not None and dist > 0.03:
                gasket[gi] = np.array(loc) + axis * 0.0015
        rows = [
            ('goggle_gasket', gasket - rdir * 0.001),
            ('goggle_gasket', gasket + rdir * 0.004 + axis * 0.005),
            ('goggle_frame', front_c[None] + radial * 1.2 - axis * 0.012),
            ('goggle_frame', front_c[None] + radial * 1.08 + axis * 0.0),
            ('goggle_frame', front_c[None] + radial * 1.14 + axis * 0.003),
            ('goggle_frame', front_c[None] + radial * 0.96 + axis * 0.004),
            ('goggle_frame', front_c[None] + radial * 0.94 - axis * 0.002),
        ]
        start = sum(len(v) for v in frame[0])
        verts = np.vstack([r[1] for r in rows])
        faces, looks = [], []
        for j in range(len(rows) - 1):
            for i in range(seg):
                a, b = j * seg + i, j * seg + (i + 1) % seg
                faces.append((a, b, b + seg, a + seg))
                looks.append(rows[j + 1][0] if j >= 1 else rows[j][0])
        frame[0].append(verts)
        frame[1].extend(tuple(i + start for i in f) for f in faces)
        frame[2].extend(LOOKS[l] for l in looks)
        rigid.append(np.arange(start, start + len(verts)))
        # lens: shallow dome inside the rim
        lv = [front_c - axis * 0.002 + axis * 0.004]
        lf = []
        rings = [(0.35, 0.0034), (0.7, 0.0022), (0.96, -0.0004)]
        for k, (f, dz) in enumerate(rings):
            for i in range(seg):
                lv.append(front_c + radial[i] * f + axis * dz - axis * 0.002)
        for i in range(seg):
            lf.append((0, 1 + (i + 1) % seg, 1 + i))
        for k in range(len(rings) - 1):
            for i in range(seg):
                a, b = 1 + k * seg + i, 1 + k * seg + (i + 1) % seg
                lf.append((a, b, b + seg, a + seg))
        add_part(lens, lv, lf, 'lens')
        # strap anchor: the outer side of the cup
        outer_pts[s] = front_c + right * rx * 1.1 * sx - axis * 0.012
    # bridge over the nose
    bl, br = outer_pts['l'], outer_pts['r']
    inner_l = eyes['l'] + np.array([-0.018, -er - 0.024, 0.004])
    inner_r = eyes['r'] + np.array([0.018, -er - 0.024, 0.004])
    mid = (inner_l + inner_r) / 2 + np.array([0, -0.006, 0.004])
    path = M.catmull([inner_l, mid, inner_r], 10)
    v, f, _ = M.sweep(path, M.rounded_rect(0.006, 0.004, 0.0015, 2), up_hint=(0, -1, 0))
    add_part(frame, v, f, 'goggle_frame')
    # leather strap: one continuous band from the left cup's outer rim, round the back of the skull, to
    # the right cup. Every sample is ray-cast onto the head (skin + full scalp) and lifted by what lies
    # under it: 2.5 mm over skin at the temples, ~10 mm over the hair volume, blended along the band so
    # it never steps; the ends run tangentially out of the cup sides
    scalp_ob = bpy.data.objects.get('ScalpSrc')
    bvh_scalp = M.bvh_of([scalp_ob]) if scalp_ob else None
    bl, br = outer_pts['l'], outer_pts['r']
    O = np.array([0.0, (eyes['l'][1] + eyes['r'][1]) / 2 + 0.085, (eyes['l'][2] + eyes['r'][2]) / 2])
    ang = lambda p: math.atan2(p[0] - O[0], p[1] - O[1])  # noqa: E731  0 = back of the head (+Y)
    a_l, a_r = ang(bl), ang(br)
    if a_r > 0:
        a_r -= 2 * math.pi
    n_s = 40
    raw, dirs, over_hair = [], [], []
    for i in range(n_s + 1):
        u = i / n_s
        a = a_l + (a_r - a_l) * u
        back = 0.5 + 0.5 * math.cos(a)
        z = bl[2] + (br[2] - bl[2]) * u + (0.028 * back ** 1.2)
        d = np.array([math.sin(a), math.cos(a), 0.12 * back])
        d /= np.linalg.norm(d)
        c = np.array([O[0], O[1], z])
        hit = bvh.ray_cast(Vector(c + d * 0.3), Vector(-d), 0.4)
        if hit[0] is None:
            raw.append(c + d * 0.09)
            dirs.append(d)
            over_hair.append(0.0)
            continue
        hp = np.array(hit[0])
        hn = np.array(hit[1])
        on_hair = 0.0
        if bvh_scalp is not None:
            hs = bvh_scalp.ray_cast(Vector(c + d * 0.3), Vector(-d), 0.4)[0]
            if hs is not None and np.linalg.norm(np.array(hs) - hp) < 0.002:
                on_hair = 1.0
        raw.append(hp)
        dirs.append(hn if hn @ d > 0 else d)
        over_hair.append(on_hair)
    over_hair = np.convolve(np.r_[[over_hair[0]] * 4, over_hair, [over_hair[-1]] * 4], np.ones(9) / 9, mode='valid')
    offset = 0.0025 + 0.0075 * over_hair
    ends = np.array([0.0] * 3 + [1.0] * (n_s - 5) + [0.0] * 3)
    body = [raw[i] + dirs[i] * offset[i] for i in range(n_s + 1)]
    # the first/last samples are replaced by the cup attachment, blended in over three samples
    for k in range(3):
        t = (k + 1) / 4
        body[k] = bl * (1 - t) + body[k] * t
        body[n_s - k] = br * (1 - t) + body[n_s - k] * t
    strap = M.catmull([bl] + body[1:-1] + [br], 34)
    normals = []
    for p_ in strap:
        dd = p_ - np.array([O[0], O[1], p_[2]])
        dd[2] = 0.0
        normals.append(dd / max(np.linalg.norm(dd), 1e-9))
    normals = np.array(normals)
    # keep the smoothed band off the head: push any sample back out to its offset
    for i, p_ in enumerate(strap):
        hit = bvh.find_nearest(Vector(p_))
        if hit[0] is None:
            continue
        hp = np.array(hit[0])
        k = min(int(round(i / (len(strap) - 1) * n_s)), n_s)
        want = offset[k] * ends[k] + 0.0015 * (1 - ends[k])
        if np.linalg.norm(p_ - hp) < want:
            strap[i] = hp + unit_or(p_ - hp, normals[i]) * want
    v, f, _ = M.sweep(strap, M.rounded_rect(0.0032, 0.026, 0.001, 1), normals=normals, cap=True)
    add_part(frame, v, f, 'goggle_strap')
    # slide adjuster on the left side of the strap, riding on it
    k = 9
    tcen = strap[k] + normals[k] * 0.002
    tdir = (strap[k + 1] - strap[k - 1]) / np.linalg.norm(strap[k + 1] - strap[k - 1])
    v, f, _ = M.sweep(M.resample([tcen - tdir * 0.012, tcen + tdir * 0.012], 3),
                      M.rounded_rect(0.006, 0.03, 0.002, 1), normals=[normals[k]] * 3)
    add_part(frame, v, f, 'goggle_frame')
    gog = build_parts('Goggles', frame, 'M_Pilot')
    lenses = build_parts('GoggleLenses', lens, 'M_PilotLens')
    for ob in (gog, lenses):
        M.rigid_weights(ob, 'goggles')
    M.transfer_variant_keys(skin, gog, rigid_groups=rigid)
    M.transfer_variant_keys(skin, lenses, rigid_groups=[np.arange(0, (len(C.coords(lenses)) // 2)),
                                                        np.arange(len(C.coords(lenses)) // 2, len(C.coords(lenses)))])
    return gog, lenses


# ── headset ─────────────────────────────────────────────────────────────────


def build_headset(B, skin):
    co = C.coords(skin)
    ears = C.group_weights(skin, ['ears']) > 0.5
    lips = C.group_weights(skin, ['lips']) > 0.5
    ear = co[ears & (co[:, 0] > 0)]
    ear_c = ear.mean(axis=0)
    ear_out = ear[:, 0].max()
    bvh = M.bvh_of([skin] + [o for o in (bpy.data.objects.get('ScalpSrc'),) if o])  # the full skull, scalp included
    parts = [[], [], []]
    rigid = []
    ax = np.array([1.0, 0.0, 0.0])
    cup_back = np.array([ear_out - 0.006, ear_c[1] + 0.004, ear_c[2] + 0.002])
    # cushion ring
    path = [cup_back + np.array([0, 0.034 * math.cos(a), 0.038 * math.sin(a)]) for a in np.linspace(0, 2 * math.pi, 21)[:-1]]
    path.append(path[0])
    path = np.array(path)
    v, f, _ = M.sweep(path, M.circle(8, 1.0) * [0.0085, 0.0085], up_hint=(1, 0, 0), cap=False)
    s0, s1 = add_part(parts, v, f, 'headset_cushion')
    rigid.append(np.arange(s0, s1))
    # shell: a shallow cylinder capped by a dome
    seg = 24
    rows = [(0.006, 1.0), (0.012, 1.05), (0.026, 1.0), (0.032, 0.84), (0.036, 0.5), (0.0375, 0.0)]
    verts, faces = [], []
    for (dx, sc) in rows:
        for i in range(seg):
            a = 2 * math.pi * i / seg
            verts.append(cup_back + np.array([dx, 0.038 * sc * math.cos(a), 0.042 * sc * math.sin(a)]))
    for j in range(len(rows) - 1):
        for i in range(seg):
            a, b = j * seg + i, j * seg + (i + 1) % seg
            faces.append((a, b, b + seg, a + seg))
    faces.append(tuple(range(seg - 1, -1, -1)))
    s0, s1 = add_part(parts, verts, faces, 'headset_shell')
    rigid.append(np.arange(s0, s1))
    # boom mic: from the front-bottom of the cup to the left mouth corner
    mouth = co[lips]
    corner = mouth[np.argmax(mouth[:, 0])]
    root = cup_back + np.array([0.03, -0.03, -0.022])
    tip = corner + np.array([0.004, -0.022, -0.004])
    ctrl = [root, root + np.array([0.004, -0.04, -0.012]), (root + tip) / 2 + np.array([0.022, -0.012, -0.012]), tip]
    boom = M.catmull(ctrl, 14)
    v, f, _ = M.sweep(boom, M.circle(8, 0.0024), up_hint=(1, 0, 0))
    s0, s1 = add_part(parts, v, f, 'headband')
    rigid.append(np.arange(s0, s1))
    tdir = boom[-1] - boom[-3]
    tdir /= np.linalg.norm(tdir)
    capsule = M.resample([tip - tdir * 0.012, tip + tdir * 0.012], 7)
    prof_scale = np.array([0.55, 0.9, 1.0, 1.0, 1.0, 0.9, 0.55])
    v, f, _ = M.sweep(capsule, M.circle(12, 0.0072), up_hint=(0, 0, 1), scale=prof_scale)
    s0, s1 = add_part(parts, v, f, 'mic_foam')
    rigid.append(np.arange(s0, s1))
    # headband over the crown to a temple pad on the right
    band = []
    nrm = []
    for i in range(25):
        a = math.radians(i / 24 * 180)  # 0 = left side, 180 = right side
        d = np.array([math.cos(a), 0.12, math.sin(a)])
        d /= np.linalg.norm(d)
        c = np.array([0.0, ear_c[1] + 0.012, ear_c[2] + 0.01])
        hit = M.project_out([c], bvh, [d], 0.019, max_dist=0.3)[0]
        band.append(hit)
        nrm.append(d)
    band[0] = cup_back + np.array([0.03, 0.0, 0.036])
    band = M.catmull(band[:23], 24)
    nrm = M.resample(np.array(nrm[:23]), 24)
    v, f, _ = M.sweep(band, M.rounded_rect(0.0035, 0.018, 0.001, 1), normals=nrm)
    add_part(parts, v, f, 'headband')
    pad_c = band[-1]
    pad_n = nrm[-1]
    v, f, _ = M.sweep(M.resample([pad_c + pad_n * 0.004, pad_c - pad_n * 0.006], 3), M.rounded_rect(0.034, 0.048, 0.01, 3),
                      up_hint=(0, 0, 1))
    add_part(parts, v, f, 'headset_cushion')
    # cable: cup bottom, behind the jaw, down to the vest collar front-left
    neck = B.J['neck_01']
    cable = M.catmull([cup_back + np.array([0.018, 0.012, -0.04]), cup_back + np.array([0.012, 0.02, -0.09]),
                       np.array([0.075, neck[1] - 0.02, neck[2] + 0.02]), np.array([0.085, neck[1] - 0.075, neck[2] - 0.035])], 18)
    v, f, _ = M.sweep(cable, M.circle(6, 0.0032), up_hint=(0, -1, 0))
    c0, c1 = add_part(parts, v, f, 'cable')
    ob = build_parts('Headset', parts, 'M_Pilot')
    M.rigid_weights(ob, 'head')
    # the cable's lower half follows the neck and chest, not the head
    cc = C.coords(ob)[c0:c1]
    t = np.clip((cup_back[2] - 0.06 - cc[:, 2]) / 0.12, 0, 1)
    ids = np.arange(c0, c1)
    ob.vertex_groups['head'].add([int(i) for i in ids], 1.0, 'REPLACE')
    for i, tt in zip(ids, t):
        ob.vertex_groups['head'].add([int(i)], float(1 - tt), 'REPLACE')
    sp = ob.vertex_groups.new(name='spine_03')
    for i, tt in zip(ids, t):
        if tt > 1e-3:
            sp.add([int(i)], float(tt), 'REPLACE')
    M.transfer_variant_keys(skin, ob, rigid_groups=rigid)
    return ob


# ── bottle ──────────────────────────────────────────────────────────────────


def build_bottle(B, vest):
    bvh = M.bvh_of([vest])
    z = B.J['spine_03'][2] - 0.055
    c = np.array([0.088, 0.0, z])
    hit = M.project_out([c], bvh, [np.array([0.2, -1.0, 0.0])], 0.026, max_dist=0.4)[0]
    parts = [[], [], []]
    body = M.resample([hit + np.array([0, 0, -0.085]), hit + np.array([0, 0, 0.075])], 10)
    sc = np.array([0.55, 0.92, 1, 1, 1, 1, 1, 1, 0.92, 0.6])
    v, f, _ = M.sweep(body, M.circle(16, 0.023), up_hint=(0, -1, 0), scale=sc)
    add_part(parts, v, f, 'bottle')
    valve = M.resample([hit + np.array([0, 0, 0.075]), hit + np.array([0, 0, 0.1])], 3)
    v, f, _ = M.sweep(valve, M.circle(12, 0.011), up_hint=(0, -1, 0))
    add_part(parts, v, f, 'bottle_valve')
    knob = M.resample([hit + np.array([-0.018, 0, 0.09]), hit + np.array([0.018, 0, 0.09])], 3)
    v, f, _ = M.sweep(knob, M.circle(10, 0.007), up_hint=(0, 0, 1))
    add_part(parts, v, f, 'bottle_valve')
    for dz in (-0.045, 0.04):
        ring = M.resample([hit + np.array([0, 0, dz - 0.009]), hit + np.array([0, 0, dz + 0.009])], 2)
        v, f, _ = M.sweep(ring, M.circle(16, 0.0262), up_hint=(0, -1, 0))
        add_part(parts, v, f, 'strap_band')
    ob = build_parts('Bottle', parts, 'M_Pilot')
    M.rigid_weights(ob, 'spine_03')
    M.transfer_variant_keys(vest, ob, rigid_groups=[np.arange(len(C.coords(ob)))])
    return ob


# ── stage ───────────────────────────────────────────────────────────────────


def run(cfg, work, args):
    rep = C.load(work, 'stage_body')
    B = Body()
    print(f"[pilot] fit: hand_l x {B.J['hand_l'][0]:+.3f} (character left = +X), face toward -Y "
          f"(nose y {B.co[:, 1].min():+.3f})")
    R = regions(B)
    # delete-under-hair: skin fully under the opaque part of the hair cap never shows. The full scalp
    # is kept as ScalpSrc (posed with the rest): the hair stage grows the cap and the cards on it
    # only 3 cm inside the scalp's edge: the cap fades out over its last 14 mm, and a hole in the skin
    # under that fade shows as a black line (the inside of the head)
    scalp_w = C.group_weights(B.ob, ['scalp'])
    under_cap = (scalp_w > 0.92) & (M.surface_distance(B.co, B.edges, scalp_w < 0.5) > 0.03)
    fm_render = M.face_mask_from_verts(B.ob, R['skin_render'], 'any')
    scalp_src = M.subset_copy(B.ob, fm_render & M.face_mask_from_verts(B.ob, C.group_weights(B.ob, ['scalp']) > 0.3, 'any'), 'ScalpSrc')
    fm_skin = fm_render & ~M.face_mask_from_verts(B.ob, under_cap, 'all')
    skin = M.subset_copy(B.ob, fm_skin, 'Skin')
    set_material(skin, 'M_PilotSkin')
    set_look(skin, 'skin')
    M.shade_smooth(skin)
    joints = {'Basis': rep['variants']['hero']['jointHeads'], 'variant_b': rep['variants']['npc_b']['jointHeads'],
              'variant_c': rep['variants']['npc_c']['jointHeads']}
    gloves = build_gloves(B, R)
    suit = build_suit(B, R, joints, gloves)
    trim_suit_neck(suit, joints['Basis'])
    smooth_neckline(B, suit)
    cap_head_weight(suit, joints['Basis'])
    boots = build_boots(B, R, joints)
    vest, vgeo = build_vest(B, suit, joints)
    vcollar = build_vest_collar(B, vest, vgeo, joints, suit)
    gaiter = build_gaiter(B, skin, suit, joints)
    gog, lenses = build_goggles(B, skin)
    headset = build_headset(B, skin)
    bottle = build_bottle(B, vest)
    vgeo['joints'] = joints['Basis']
    hidden = hide_suit_under_vest(suit, vgeo)
    print(f'[pilot] fit: {hidden} suit faces under the vest deleted')
    eyes = bpy.data.objects['MH_Eyes']
    eyes.name = 'Eyes'
    set_material(eyes, 'M_PilotSkin')
    set_look(eyes, 'eye')
    brows = bpy.data.objects['MH_Eyebrows']
    brows.name = 'Brows'
    set_material(brows, 'M_PilotHair')
    set_look(brows, 'brow')
    lashes = bpy.data.objects['MH_Eyelashes']
    lashes.name = 'Lashes'
    set_material(lashes, 'M_PilotHair')
    set_look(lashes, 'lash')
    rig = B.rig
    for ob in (skin, scalp_src, suit, gaiter, gloves, boots, vest, vcollar, gog, lenses, headset, bottle):
        ob.parent = rig
        ob.matrix_parent_inverse.identity()
        for m in list(ob.modifiers):
            ob.modifiers.remove(m)
        mod = ob.modifiers.new('Armature', 'ARMATURE')
        mod.object = rig
    body_ob = B.ob
    bpy.data.objects.remove(body_ob, do_unlink=True)
    C.purge()
    pieces = [o for o in bpy.data.objects if o.type == 'MESH']
    report = {'pieces': {o.name: {'tris': C.tri_count(o), 'keys': M.key_names(o),
                                  'material': o.data.materials[0].name if o.data.materials else None}
                         for o in sorted(pieces, key=lambda o: o.name)}}
    report['trisTotal'] = sum(p['tris'] for p in report['pieces'].values())
    for k, v in report['pieces'].items():
        print(f"[pilot] fit {k:14s} {v['tris']:6d} tris  keys {v['keys']}  {v['material']}")
    print(f"[pilot] fit total {report['trisTotal']} tris (before LOD0 reduction)")
    report['body'] = rep
    C.save(work, 'stage_fit', report)
