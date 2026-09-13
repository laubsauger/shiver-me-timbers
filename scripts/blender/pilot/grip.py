"""
Hand grips (v2): the hand, fingers and thumb solved against a real grip primitive, the helm rim (a
torus from the parts helm socket) or a throttle handle (a cylinder along the lever pivot axis).

  * hand model: palm frame (wrist -> middle knuckle axis, index -> pinky knuckle line, palm normal
    on the side the rest fingers curl to), palm depth and per-phalanx finger radius, all measured on
    the glove mesh in the current rest pose
  * palm frame: the palm lies on the grip at contact angle alpha (from the pilot-facing side toward
    the outside of the rim), the knuckle line runs along the rim. alpha and a small knuckle tilt are
    searched for the smallest wrist bend given the two-bone elbow (down and out)
  * fingers wrap proximal -> distal: each phalanx turns about the local grip axis onto the tangent
    of the contact circle (grip radius + phalanx radius + gap), so no segment cuts into the grip
  * thumb rests along the pilot-facing surface of the grip, pointing along it (not through it)
  * forearm twist: the lowerarm_twist bone takes the hand's roll (weights ramp to the wrist), so the
    wrist never shows a candy-wrapper twist
  * verification: the deformed glove is measured against the primitive; fingers are re-wrapped with
    a larger gap until no glove vertex sinks more than 1 mm into it

Everything is in armature space, Blender axes (the pilot faces -Y, +Z up).
"""
import math

import bpy
import numpy as np
from mathutils import Matrix, Vector

import common as C

FINGERS = ['index', 'middle', 'ring', 'pinky']


def unit(v):
    v = np.asarray(v, dtype=np.float64)
    return v / max(np.linalg.norm(v), 1e-12)


def rodrigues(v, axis, ang):
    a = unit(axis)
    return v * math.cos(ang) + np.cross(a, v) * math.sin(ang) + a * (a @ v) * (1 - math.cos(ang))


class Rim:
    """steering wheel rim: core circle (hub, axis toward the pilot, radius R) with tube radius r"""

    def __init__(self, hub, axis, R, r):
        self.hub = np.asarray(hub, dtype=np.float64)
        self.n = unit(axis)
        self.R = float(R)
        self.r = float(r)

    def core(self, P):
        rel = np.asarray(P, dtype=np.float64) - self.hub
        planar = rel - (rel @ self.n) * self.n
        d = unit(planar)
        return self.hub + self.R * d, unit(np.cross(self.n, d))

    def dist(self, P):
        P = np.atleast_2d(P)
        rel = P - self.hub
        along = rel @ self.n
        rho = np.linalg.norm(rel - along[:, None] * self.n, axis=1)
        return np.sqrt((rho - self.R) ** 2 + along ** 2) - self.r


class Bar:
    """straight handle: axis through o along u, radius r"""

    def __init__(self, o, u, r):
        self.o = np.asarray(o, dtype=np.float64)
        self.u = unit(u)
        self.r = float(r)

    def core(self, P):
        rel = np.asarray(P, dtype=np.float64) - self.o
        return self.o + (rel @ self.u) * self.u, self.u

    def dist(self, P):
        P = np.atleast_2d(P)
        rel = P - self.o
        along = rel @ self.u
        return np.linalg.norm(rel - along[:, None] * self.u, axis=1) - self.r


# ── hand model (rest pose + glove mesh) ─────────────────────────────────────


def _seg_dist(P, a, b):
    ab = b - a
    t = np.clip((P - a) @ ab / max(ab @ ab, 1e-12), 0, 1)
    return np.linalg.norm(P - (a + t[:, None] * ab), axis=1)


def hand_model(rig, s, gloves=None):
    B = rig.data.bones
    H = lambda n: np.array(B[n].head_local, dtype=np.float64)  # noqa: E731
    T = lambda n: np.array(B[n].tail_local, dtype=np.float64)  # noqa: E731
    wrist = H(f'hand_{s}')
    h = unit(H(f'middle_01_{s}') - wrist)
    k = H(f'index_01_{s}') - H(f'pinky_01_{s}')
    k = unit(k - (k @ h) * h)
    p = unit(np.cross(h, k))
    g = gloves or bpy.data.objects['Gloves']
    co = C.coords(g)
    side = np.sign(co[:, 0]) == (1.0 if s == 'l' else -1.0)
    finger_bones = [f'{f}_0{i}_{s}' for f in FINGERS for i in (1, 2, 3)]
    # palm side: MakeHuman's rest fingers curl toward the palm and the thumb sits on the palm side
    # (the fingernail group is unreliable on the inflated glove: it voted the back of the hand)
    tip = np.mean([T(f'{f}_03_{s}') for f in FINGERS], axis=0)
    curl = (tip - (wrist + h * ((tip - wrist) @ h))) @ p
    thumb = (H(f'thumb_02_{s}') - wrist) @ p
    if curl + thumb < 0:
        p = -p
    pc = wrist + 0.55 * (H(f'middle_01_{s}') - wrist)
    wh = C.group_weights(g, [f'hand_{s}'])
    near = side & (wh > 0.5) & (np.linalg.norm(co - pc, axis=1) < 0.045)
    depth = float(np.clip(np.percentile((co[near] - pc) @ p, 97), 0.012, 0.04)) if near.sum() > 8 else 0.02
    rf = {}
    for n in finger_bones + [f'thumb_0{i}_{s}' for i in (1, 2, 3)]:
        w = C.group_weights(g, [n])
        sel = side & (w > 0.55)
        rf[n] = float(np.clip(np.median(_seg_dist(co[sel], H(n), T(n))), 0.006, 0.02)) if sel.sum() > 6 else 0.009
    seg = {n: (H(n), T(n)) for n in finger_bones + [f'thumb_0{i}_{s}' for i in (1, 2, 3)]}
    return {'F': np.stack([h, k, p], axis=1), 'pcOff': pc - wrist, 'depth': depth, 'rf': rf, 'side': s,
            'spacingRest': round(finger_spacing(seg, rf, s), 4)}


# ── palm frames ─────────────────────────────────────────────────────────────


def _frame(h, k, p, model):
    F = np.stack([unit(h), unit(k), unit(p)], axis=1)
    if np.sign(np.linalg.det(F)) != np.sign(np.linalg.det(model['F'])):
        F[:, 1] = -F[:, 1]
    return F


def rim_frame(rim, s, clock_deg, alpha_deg, tilt_deg, model, gap):
    n = rim.n
    up = unit(np.array([0.0, 0.0, 1.0]) - n[2] * n)
    left = unit(np.cross(n, up))  # pilot's left (+X)
    a = math.radians(clock_deg) * (1.0 if s == 'l' else -1.0)
    rhat = math.sin(a) * left + math.cos(a) * up
    g = rim.hub + rim.R * rhat
    t_up = unit(np.cross(n, rhat))
    if t_up @ up < 0:
        t_up = -t_up
    al = math.radians(alpha_deg)
    c = n * math.cos(al) + rhat * math.sin(al)       # palm contact direction from the rim core
    h = -n * math.sin(al) + rhat * math.cos(al)      # wrist -> knuckles: along the wrap
    k = -t_up                                        # index toward 12 o'clock
    tl = math.radians(tilt_deg)
    h, k = rodrigues(h, c, tl), rodrigues(k, c, tl)
    F = _frame(h, k, -c, model)
    thumb_side = unit(n - rhat * 0.2)
    return {'F': F, 'bonePc': g + c * (rim.r + gap + model['depth']), 'grip': g, 'thumbSide': thumb_side,
            'thumbDir': t_up, 'alpha': alpha_deg, 'tilt': tilt_deg}


def bar_frame(bar, s, lever_up, toward_pilot, alpha_deg, tilt_deg, model, gap):
    """palm over the handle: alpha 0 = on top of the lever end, 90 = on its pilot-facing side"""
    l = unit(lever_up - (lever_up @ bar.u) * bar.u)
    w = unit(toward_pilot - (toward_pilot @ bar.u) * bar.u - (toward_pilot @ l) * l)
    al = math.radians(alpha_deg)
    c = l * math.cos(al) + w * math.sin(al)
    h = l * math.sin(al) - w * math.cos(al)
    tl = math.radians(tilt_deg)
    k = rodrigues(bar.u, c, tl)
    h = rodrigues(h, c, tl)
    F = _frame(h, k, -c, model)
    return {'F': F, 'bonePc': bar.o + c * (bar.r + gap + model['depth']), 'grip': bar.o, 'thumbSide': unit(w * 0.7 + l * 0.7),
            'thumbDir': unit(-w * 0.3 + bar.u * (1.0 if s == 'l' else -1.0)), 'alpha': alpha_deg, 'tilt': tilt_deg}


def wrist_of(frame, model):
    R = frame['F'] @ model['F'].T
    return frame['bonePc'] - R @ model['pcOff'], R


def elbow_of(S, W, a, b, pole):
    d = np.linalg.norm(W - S)
    u = (W - S) / max(d, 1e-9)
    dd = min(d, (a + b) * 0.999)
    v = np.asarray(pole, dtype=np.float64)
    v = unit(v - (v @ u) * u)
    cos_a = np.clip((a * a + dd * dd - b * b) / (2 * a * dd), -1, 1)
    return S + a * (cos_a * u + math.sqrt(1 - cos_a * cos_a) * v), d / (a + b)


def best_frame(make, rig, s, pole, model, alphas=range(10, 86, 5), tilts=(-30, -20, -10, 0, 10, 20, 30), alpha_pref=45):
    """make(alpha, tilt) -> frame. Smallest wrist bend (forearm vs hand axis) for a reachable wrist."""
    pb = rig.pose.bones
    S = np.array(pb[f'upperarm_{s}'].head)
    a = rig.data.bones[f'upperarm_{s}'].length
    b = rig.data.bones[f'lowerarm_{s}'].length
    best = None
    for al in alphas:
        for tl in tilts:
            fr = make(al, tl)
            W, _R = wrist_of(fr, model)
            E, ratio = elbow_of(S, W, a, b, pole)
            fore = unit(W - E)
            bend = math.degrees(math.acos(np.clip(fore @ fr['F'][:, 0], -1, 1)))
            cost = bend + 0.12 * abs(al - alpha_pref) + 0.08 * abs(tl) + (400 * (ratio - 0.97) if ratio > 0.97 else 0)
            if best is None or cost < best[0]:
                best = (cost, fr, {'wristBendDeg': round(bend, 1), 'reachRatio': round(float(ratio), 3), 'alphaDeg': al, 'tiltDeg': tl})
    return best[1], best[2]


# ── posing ──────────────────────────────────────────────────────────────────


def set_hand(rig, s, frame, model, pole):
    from rig import two_bone
    W, R = wrist_of(frame, model)
    ik = two_bone(rig, f'upperarm_{s}', f'lowerarm_{s}', W, pole)
    set_hand_rotation(rig, s, R)
    return ik


def set_hand_rotation(rig, s, R):
    pb = rig.pose.bones[f'hand_{s}']
    rest3 = np.array(rig.data.bones[f'hand_{s}'].matrix_local.to_3x3())
    M = Matrix((R @ rest3).tolist()).to_4x4()
    M.translation = pb.matrix.translation
    pb.matrix = M
    bpy.context.view_layer.update()


def hand_twist_deg(rig, s):
    q = rig.pose.bones[f'hand_{s}'].matrix_basis.to_quaternion()
    return math.degrees(2 * math.atan2(q.y, q.w))


def distribute_twist(rig, s):
    """the hand's roll about its own axis goes to lowerarm_twist (weights ramp to ~0.9 at the wrist),
    so the wrist band follows the hand and the elbow stays put"""
    pb = rig.pose.bones[f'hand_{s}']
    target = pb.matrix.copy()
    q = pb.matrix_basis.to_quaternion()
    tw = math.atan2(q.y, q.w) * 2
    tb = rig.pose.bones[f'lowerarm_twist_{s}']
    tb.rotation_mode = 'QUATERNION'
    tb.rotation_quaternion = (math.cos(tw / 2), 0.0, math.sin(tw / 2), 0.0)
    bpy.context.view_layer.update()
    pb.matrix = target
    bpy.context.view_layer.update()
    return math.degrees(tw)


def _rot_about(rig, name, axis, ang):
    from rig import rotate_about
    if abs(ang) > 1e-6:
        rotate_about(rig, name, axis, ang)


def wrap_fingers(rig, s, prim, frame, model, gap, max_flex_deg=108):
    pb = rig.pose.bones
    out = {}
    palm = frame['F'][:, 2]
    for f in FINGERS:
        d1 = unit(np.array(pb[f'{f}_01_{s}'].tail) - np.array(pb[f'{f}_01_{s}'].head))
        knuckle = unit(np.cross(d1, palm))  # +rotation about it curls the finger toward the palm
        for i in (1, 2, 3):
            name = f'{f}_0{i}_{s}'
            P = np.array(pb[name].head)
            d = unit(np.array(pb[name].tail) - P)
            q, ta = prim.core(P)
            sense = 1.0 if ta @ knuckle >= 0 else -1.0
            w = P - q
            w = w - (w @ ta) * ta
            rho = np.linalg.norm(w)
            Rc = prim.r + model['rf'][name] + gap
            if rho <= Rc * 1.002:
                if i > 1:  # already wrapped past the grip: a relaxed curl only
                    _rot_about(rig, name, knuckle, math.radians(12 if i == 2 else 18))
                out[name] = 0.0
                continue
            e1 = w / rho
            e2 = np.cross(ta, e1)
            beta = math.asin(Rc / rho)
            dp = unit(d - (d @ ta) * ta)
            flexes = []
            for sg in (1.0, -1.0):
                u = unit(-e1 * math.cos(beta) + sg * e2 * math.sin(beta))
                flexes.append(sense * math.atan2(np.cross(dp, u) @ ta, dp @ u))
            pos = [x for x in flexes if x >= 0]
            flex = min(pos) if pos else max(flexes)
            lo = -math.radians(8) if i == 1 else math.radians(12 if i == 2 else 18)  # PIP/DIP never hyperextend; fingertips keep a relaxed curl
            flex = float(np.clip(flex, lo, math.radians(max_flex_deg)))
            _rot_about(rig, name, ta, sense * flex)
            out[name] = round(math.degrees(flex), 1)
    return out


def rest_thumb(rig, s, prim, frame, model, gap, reach=0.045):
    """thumb laid on the pilot-facing surface of the grip: its tip is placed `reach` metres along the
    grip from the palm (CCD over thumb_03 -> thumb_01, the base joint moving least), then the base
    is lifted off the surface until the glove clears it"""
    pb = rig.pose.bones
    names = [f'thumb_0{i}_{s}' for i in (1, 2, 3)]
    q0, _ = prim.core(frame['bonePc'])
    qT, ta = prim.core(q0 + frame['thumbDir'] * reach)
    side = frame['thumbSide']
    sd = unit(side - (side @ ta) * ta)
    target = qT + sd * (prim.r + model['rf'][names[2]] * 0.8 + gap)
    for _ in range(10):
        for name, wgt in ((names[2], 1.0), (names[1], 0.8), (names[0], 0.35)):
            P = np.array(pb[name].head)
            tip = np.array(pb[names[2]].tail)
            a_ = unit(tip - P)
            b_ = unit(target - P)
            ax = np.cross(a_, b_)
            if np.linalg.norm(ax) < 1e-6:
                continue
            ang = math.atan2(np.linalg.norm(ax), a_ @ b_) * wgt
            _rot_about(rig, name, ax, min(ang, math.radians(25)))
        if np.linalg.norm(np.array(pb[names[2]].tail) - target) < 0.003:
            break
    for _ in range(24):
        clear = glove_clearance(rig, s, prim)['thumb'][0]
        if clear > -0.0008:
            break
        P = np.array(pb[names[1]].head)
        q, _ta = prim.core(P)
        away = unit(np.cross(frame['thumbDir'], unit(q - P)))
        _rot_about(rig, names[0], away, -math.radians(2.5))


def glove_clearance(rig, s, prim, gloves=None):
    """per region (palm, thumb, fingers): min signed distance of this hand's deformed glove vertices to
    the grip surface (m) and the count sunk more than 1 mm"""
    from rig import eval_deformed
    g = gloves or bpy.data.objects['Gloves']
    co = eval_deformed(g, 'Basis', rig)
    side = np.sign(co[:, 0]) == (1.0 if s == 'l' else -1.0)
    bones = set(rig.data.bones.keys())
    names = {vg.index: vg.name for vg in g.vertex_groups if vg.name in bones}
    region = np.full(len(co), '', dtype=object)
    for v in g.data.vertices:
        if not side[v.index]:
            continue
        gs = [x for x in v.groups if x.group in names]
        if gs:
            n = names[max(gs, key=lambda x: x.weight).group]
            region[v.index] = 'thumb' if n.startswith('thumb') else ('fingers' if n[:-5] in FINGERS or n.split('_')[0] in FINGERS else 'palm')
    d = np.full(len(co), 1.0)
    d[side] = prim.dist(co[side])
    out = {}
    for r in ('palm', 'thumb', 'fingers'):
        m = region == r
        out[r] = (float(d[m].min()) if m.any() else 1.0, int((d[m] < -0.001).sum()))
    return out


def finger_spacing(seg, rf, s):
    """smallest clearance between neighbouring fingers' phalanx capsules (m). seg: bone -> (head, tail).
    The capsule radii are generous (glove surface median), so compare against the rest value"""
    worst = 1.0
    pairs = [('index', 'middle'), ('middle', 'ring'), ('ring', 'pinky'), ('thumb', 'index')]
    for fa, fb in pairs:
        for i in (1, 2, 3):
            for j in (1, 2, 3):
                if fa == 'thumb' and i == 1:
                    continue
                na, nb = f'{fa}_0{i}_{s}', f'{fb}_0{j}_{s}'
                a0, a1 = seg[na]
                b0, b1 = seg[nb]
                pts = a0[None] + np.linspace(0, 1, 9)[:, None] * (a1 - a0)[None]
                worst = min(worst, float(_seg_dist(pts, b0, b1).min() - rf[na] - rf[nb]))
    return worst


def pose_segments(rig, s):
    pb = rig.pose.bones
    return {f'{f}_0{i}_{s}': (np.array(pb[f'{f}_0{i}_{s}'].head), np.array(pb[f'{f}_0{i}_{s}'].tail))
            for f in FINGERS + ['thumb'] for i in (1, 2, 3)}


def solve_hand(rig, s, prim, frame, model, pole, gap0=0.0015, tries=6):
    """place the hand, wrap fingers and thumb, then push whichever part sinks into the grip (palm:
    the hand moves out; thumb or fingers: their own contact gap grows) until the glove clears it"""
    names = [f'{f}_0{i}_{s}' for f in FINGERS + ['thumb'] for i in (1, 2, 3)]
    gaps = {'palm': gap0, 'thumb': gap0, 'fingers': gap0}
    rep = {}
    base = None
    for it in range(tries):
        fr = dict(frame)
        fr['bonePc'] = frame['bonePc'] + (-frame['F'][:, 2]) * (gaps['palm'] - gap0)
        if base is not None:
            for n in names:
                rig.pose.bones[n].matrix_basis = base[n]
            bpy.context.view_layer.update()
        ik = set_hand(rig, s, fr, model, pole)
        twist = distribute_twist(rig, s)
        if base is None:
            base = {n: rig.pose.bones[n].matrix_basis.copy() for n in names}
        flex = wrap_fingers(rig, s, prim, fr, model, gaps['fingers'])
        rest_thumb(rig, s, prim, fr, model, gaps['thumb'])
        gaps['thumb'] = gap0
        clear = glove_clearance(rig, s, prim)
        rep = {'gapsM': {k: round(v, 4) for k, v in gaps.items()},
               'gloveClearanceM': {k: round(v[0], 4) for k, v in clear.items()},
               'verticesInside1mm': sum(v[1] for v in clear.values()), 'flexDeg': flex,
               'fingerSpacingM': round(finger_spacing(pose_segments(rig, s), model['rf'], s), 4),
               'fingerSpacingRestM': model['spacingRest'], 'twistDeg': round(twist, 1), 'ik': ik, 'iterations': it + 1}
        bad = {k: v[0] for k, v in clear.items() if v[0] < -0.001}
        if not bad:
            break
        for k, v in bad.items():
            gaps[k] += -v + 0.0005
    return rep
