"""
Stage 3 (rig): extra bones, the seated pose, the seated bind, variant re-bind data, harness + dash cable.

  * Extra bones (pilot_config.json rig.extraBones): forearm twist (weights split along the
    forearm), goggles (pivot between the strap's side points, so goggles-up is one rotation), eye_l
    and eye_r, and non-deforming IK / look-at bones under Root.
  * Seated pose, solved in the seat frame (origin = seat socket = Root):
      - hips slide along the pan and the spine leans until the eye midpoint sits on the cockpit eye
        anchor (seat.eyeAboveSheer / eyeAheadOfSeat); neck and head take back part of the lean
      - legs: analytic two-bone IK to ankle targets on the footrest, knees forward and out, feet flat
      - arms: analytic two-bone IK to the 10-and-2 grips on the wheel rim (helm.*), elbows down
        and out; hands aimed along the rim, palms on it, fingers and thumbs curled
  * The pose becomes the bind pose: every mesh (basis and variant keys) is deformed into it, the
    armature rest is re-applied, so all clips are small deltas from sitting.
  * Variants: a copy of the skeleton at each variant's own joints takes the same local pose and
    deforms that variant's key. Its seated joint heads go to the report, and the runtime re-binds
    a variant clone to them.
  * Harness (4-point webbing, cam-lock buckle, adjusters) and the coiled cable to the dash are
    built in the seated pose. Their far ends are weighted to Root, the seat socket, so the pilot
    stays strapped in whatever the body does.
"""
import math

import bpy
import numpy as np
from mathutils import Matrix, Vector

import common as C
import meshops as M
from fit import LOOKS, add_part, build_parts, set_material

FINGERS = ['index', 'middle', 'ring', 'pinky']


def b2v(a):
    return Vector(tuple(float(x) for x in a))


def three_to_blender(p):
    x, y, z = p
    return np.array([x, -z, y], dtype=np.float64)


# ── extra bones ─────────────────────────────────────────────────────────────


def add_extra_bones(cfg, rig):
    eyes = bpy.data.objects['Eyes']
    eco = C.coords(eyes)
    el, er = eco[eco[:, 0] > 0].mean(axis=0), eco[eco[:, 0] < 0].mean(axis=0)
    gog = bpy.data.objects['Goggles']
    gco = C.coords(gog)
    # goggles pivot: ear-level centre between the strap's side points
    side_l = gco[np.argmax(gco[:, 0])]
    side_r = gco[np.argmin(gco[:, 0])]
    pivot = (side_l + side_r) / 2
    C.select_only([rig])
    bpy.ops.object.mode_set(mode='EDIT')
    eb = rig.data.edit_bones
    for s in ('l', 'r'):
        lo = eb[f'lowerarm_{s}']
        tw = eb.new(f'lowerarm_twist_{s}')
        tw.head = lo.head.lerp(lo.tail, 0.5)
        tw.tail = lo.tail.copy()
        tw.roll = lo.roll
        tw.parent = lo
        tw.use_deform = True
    # head_geo carries every head-weighted vertex: the cockpit camera collapses it, while `head` (and
    # the cam_eye socket under it) keep their transform
    hg = eb.new('head_geo')
    hg.head = eb['head'].head.copy()
    hg.tail = eb['head'].tail.copy()
    hg.roll = eb['head'].roll
    hg.parent = eb['head']
    hg.use_deform = True
    for name, head, tail_off in (('eye_l', el, (0, -0.03, 0)), ('eye_r', er, (0, -0.03, 0)),
                                 ('goggles', pivot, (0, -0.06, 0))):
        b = eb.new(name)
        b.head = b2v(head)
        b.tail = b2v(np.asarray(head) + np.asarray(tail_off))
        b.parent = hg
        b.use_deform = True
    bpy.ops.object.mode_set(mode='OBJECT')
    for ob in [o for o in bpy.data.objects if o.type == 'MESH']:
        if 'head' in ob.vertex_groups:
            ob.vertex_groups['head'].name = 'head_geo'
    # eyes: rigid per side; forearm twist: weights split along the forearm
    for g in list(eyes.vertex_groups):
        eyes.vertex_groups.remove(g)
    M.rigid_weights(eyes, 'eye_l', np.nonzero(eco[:, 0] > 0)[0])
    M.rigid_weights(eyes, 'eye_r', np.nonzero(eco[:, 0] <= 0)[0])
    for g in list(gog.vertex_groups):
        gog.vertex_groups.remove(g)
    M.rigid_weights(gog, 'goggles')
    # the strap's back half stays on the skull when the goggles are pushed up: its weight hands over
    # from the goggles bone at the cups to head_geo round the back (it stretches instead of swinging
    # into the nape)
    looks = np.empty(len(gog.data.polygons), dtype=np.int32)
    gog.data.attributes['look'].data.foreach_get('value', looks)
    strap_v = sorted({v for p in gog.data.polygons if looks[p.index] == LOOKS['goggle_strap'] for v in p.vertices})
    if strap_v:
        y0 = gco[:, 1].min()
        y1 = gco[strap_v, 1].max()
        hg = gog.vertex_groups.new(name='head_geo')
        gg = gog.vertex_groups['goggles']
        for i in strap_v:
            t = float(np.clip((gco[i, 1] - (y0 + 0.07)) / max(y1 - y0 - 0.09, 1e-6), 0, 1))
            t = t * t * (3 - 2 * t)
            gg.add([i], 1 - t, 'REPLACE')
            if t > 1e-3:
                hg.add([i], t, 'REPLACE')
    for ob in [o for o in bpy.data.objects if o.type == 'MESH']:
        for s in ('l', 'r'):
            if f'lowerarm_{s}' not in ob.vertex_groups:
                continue
            bone = rig.data.bones[f'lowerarm_{s}']
            h, t = np.array(bone.head_local), np.array(bone.tail_local)
            ax = t - h
            L = np.linalg.norm(ax)
            co = C.coords(ob)
            u = np.clip((co - h) @ ax / (L * L), 0, 1)
            # pronation lives in the distal forearm: the twist bone takes the hand's full roll, its
            # weight ramps from 0 below mid-forearm to 0.9 at the wrist (no candy-wrapper band)
            share = np.clip((u - 0.3) / 0.62, 0, 1) ** 1.1 * 0.9
            src = ob.vertex_groups[f'lowerarm_{s}']
            dst = ob.vertex_groups.get(f'lowerarm_twist_{s}') or ob.vertex_groups.new(name=f'lowerarm_twist_{s}')
            for v in ob.data.vertices:
                for g in v.groups:
                    if g.group == src.index and g.weight > 0:
                        w = g.weight
                        k = share[v.index]
                        if k > 1e-3:
                            src.add([v.index], w * (1 - k), 'REPLACE')
                            dst.add([v.index], w * k, 'REPLACE')


# ── pose solving (armature space = seat frame, Blender axes) ────────────────


def reset_pose(rig):
    for pb in rig.pose.bones:
        pb.matrix_basis = Matrix.Identity(4)
    bpy.context.view_layer.update()


def rotate_about(rig, name, axis, angle, pivot=None):
    pb = rig.pose.bones[name]
    m = pb.matrix.copy()
    p = m.translation.copy() if pivot is None else b2v(pivot)
    R = Matrix.Rotation(angle, 4, b2v(axis).normalized())
    pb.matrix = Matrix.Translation(p) @ R @ Matrix.Translation(-p) @ m
    bpy.context.view_layer.update()


def aim(rig, name, target):
    pb = rig.pose.bones[name]
    m = pb.matrix.copy()
    head = m.translation.copy()
    cur = (m.to_3x3() @ Vector((0, 1, 0))).normalized()
    want = (b2v(target) - head).normalized()
    q = cur.rotation_difference(want)
    pb.matrix = Matrix.Translation(head) @ q.to_matrix().to_4x4() @ Matrix.Translation(-head) @ m
    bpy.context.view_layer.update()


def head_of(rig, name):
    return np.array(rig.pose.bones[name].head)


def tail_of(rig, name):
    return np.array(rig.pose.bones[name].tail)


def two_bone(rig, upper, lower, target, pole):
    S = head_of(rig, upper)
    a = rig.data.bones[upper].length
    b = rig.data.bones[lower].length
    T = np.asarray(target, dtype=np.float64)
    d = np.linalg.norm(T - S)
    reach = a + b
    clamped = d > reach * 0.999
    d = min(d, reach * 0.999)
    u = (T - S) / np.linalg.norm(T - S)
    v = np.asarray(pole, dtype=np.float64)
    v = v - (v @ u) * u
    v /= np.linalg.norm(v)
    cos_a = np.clip((a * a + d * d - b * b) / (2 * a * d), -1, 1)
    E = S + a * (cos_a * u + math.sqrt(1 - cos_a * cos_a) * v)
    aim(rig, upper, E)
    aim(rig, lower, S + u * d)
    return {'reachM': round(float(np.linalg.norm(np.asarray(target) - S)), 4), 'maxReachM': round(reach, 4), 'clamped': bool(clamped)}


def eye_mid(rig, eye_rest):
    """eye midpoint under the current pose (the eyes ride the head bone)"""
    hb = rig.data.bones['head']
    pm = rig.pose.bones['head'].matrix @ hb.matrix_local.inverted()
    return np.array(pm @ b2v(eye_rest))


def seated_pose(cfg, rig):
    """seated on the parts seat, hands on the REAL helm rim (pilot_config.json helm, read from the parts
    build). The helm hub sits 8 cm below the pan and 0.73 m ahead of the seat station, so the lean and
    the hip slide are solved for reach: the rearmost hips and the smallest lean that give both arms a
    bent elbow (reach ratio <= 0.955) at their best palm frame. Eyes follow the head (the cockpit
    camera rides cam_eye); the head is pitched so the gaze sits seat.gazeDownDeg below the horizon."""
    import grip as G
    seat = cfg['seat']
    helm = cfg['helm']
    J = {b.name: np.array(b.head_local) for b in rig.data.bones}
    X = np.array([1.0, 0, 0])
    models = {s: G.hand_model(rig, s) for s in ('l', 'r')}
    rim = G.Rim(three_to_blender(helm['wheelHub']), three_to_blender(helm['wheelAxis']), helm['wheelRadius'], helm['rimTube'])
    poles = {s: np.array([0.7 * sx, 0.35, -0.62]) for s, sx in (('l', 1), ('r', -1))}
    report = {'handModel': {s: {'depthM': round(m['depth'], 4)} for s, m in models.items()}}

    def pose_upper(hz, lean):
        reset_pose(rig)
        pb = rig.pose.bones['pelvis']
        m = pb.matrix.copy()
        m.translation = b2v([0.0, -hz + (J['pelvis'][1] - J['thigh_l'][1]), seat['hipAbovePan'] + (J['pelvis'][2] - J['thigh_l'][2])])
        pb.matrix = m
        bpy.context.view_layer.update()
        rotate_about(rig, 'pelvis', X, math.radians(-4) + lean * 0.42)
        for name, f in (('spine_01', 0.17), ('spine_02', 0.19), ('spine_03', 0.22)):
            rotate_about(rig, name, X, lean * f)
        for s, sx in (('l', 1), ('r', -1)):
            rotate_about(rig, f'clavicle_{s}', [0, 0, 1], math.radians(-14 * sx))  # protract toward the wheel
        gaze(rig, seat['gazeDownDeg'])

    def reach(hz, lean):
        pose_upper(hz, lean)
        worst = 0.0
        for s in ('l', 'r'):
            _fr, st = G.best_frame(lambda al, tl, s=s: G.rim_frame(rim, s, helm['gripClockDeg'], al, tl, models[s], 0.0015),
                                   rig, s, poles[s], models[s])
            worst = max(worst, st['reachRatio'])
        return worst

    max_lean = math.radians(seat['maxLeanDeg'])
    want = 0.955  # elbow flexed ~30 deg: bent, not locked, not crouched over the wheel
    chosen = None
    for hz in np.arange(seat['hipsZRange'][0], seat['hipsZRange'][1] + 1e-6, 0.0425):
        if reach(hz, max_lean) > want:
            continue
        lo, hi = 0.0, max_lean
        for _ in range(16):
            mid = (lo + hi) / 2
            if reach(hz, mid) > want:
                lo = mid
            else:
                hi = mid
        chosen = (float(hz), hi)
        break
    if chosen is None:
        chosen = (float(seat['hipsZRange'][1]), max_lean)
        report['reachClamped'] = True
        print('[pilot] rig: WARNING the helm rim is out of reach even at max lean and the front hip position')
    hz, lean = chosen
    pose_upper(hz, lean)
    report['hipsZ'] = round(hz, 4)
    report['leanDeg'] = round(math.degrees(lean), 2)
    print(f"[pilot] rig: hips z {hz:+.3f}, lean {math.degrees(lean):.1f} deg to reach the helm")

    # legs: heels on the sole ahead of the foot bar, knees forward and a little out
    thigh = rig.data.bones['thigh_l'].length
    calf = rig.data.bones['calf_l'].length
    sole_z = helm['soleY'] + 0.085
    for s, sx in (('l', 1), ('r', -1)):
        hip = head_of(rig, f'thigh_{s}')
        dy = hip[2] - sole_z
        reach_leg = 0.84 * (thigh + calf)
        fwd = math.sqrt(max(reach_leg ** 2 - dy ** 2, 0.04))
        ankle_t = np.array([sx * 0.15, hip[1] - min(fwd, 0.62 - (-hip[1])), sole_z])
        rest_foot = J[f'ball_{s}'] - J[f'foot_{s}']
        rest_ball = np.array(rig.data.bones[f'ball_{s}'].tail_local) - J[f'ball_{s}']
        report[f'leg_{s}'] = two_bone(rig, f'thigh_{s}', f'calf_{s}', ankle_t, [0.3 * sx, -1.0, 0.25])
        aim(rig, f'foot_{s}', head_of(rig, f'foot_{s}') + rest_foot)
        aim(rig, f'ball_{s}', head_of(rig, f'ball_{s}') + rest_ball)

    # hands on the rim
    grips, frames = {}, {}
    for s in ('l', 'r'):
        fr, st = G.best_frame(lambda al, tl, s=s: G.rim_frame(rim, s, helm['gripClockDeg'], al, tl, models[s], 0.0015),
                              rig, s, poles[s], models[s])
        rep = G.solve_hand(rig, s, rim, fr, models[s], poles[s])
        rep.update(st)
        frames[s] = fr
        grips[s] = fr['grip']
        report[f'hand_{s}'] = rep
        print(f"[pilot] rig: hand {s}: {st}, glove clearance {rep['gloveClearanceM']} m "
              f"({rep['verticesInside1mm']} verts > 1 mm inside), finger spacing {rep['fingerSpacingM']*1000:.1f} mm (rest {rep['fingerSpacingRestM']*1000:.1f}), "
              f"twist {rep['twistDeg']} deg, elbow {elbow_deg(rig, s):.0f} deg")
        report[f'hand_{s}']['elbowFlexDeg'] = round(elbow_deg(rig, s), 1)
    report['grips'] = {s: [round(float(v), 4) for v in g] for s, g in grips.items()}
    report['gripFrames'] = {s: {'alphaDeg': f['alpha'], 'tiltDeg': f['tilt']} for s, f in frames.items()}
    report['gripError'] = {s: round(float(np.linalg.norm(G.wrist_of(frames[s], models[s])[0] - head_of(rig, f'hand_{s}'))), 4) for s in grips}
    eyes = C.coords(bpy.data.objects['Eyes'])
    eye_rest = (eyes[eyes[:, 0] > 0].mean(axis=0) + eyes[eyes[:, 0] < 0].mean(axis=0)) / 2
    e = eye_mid(rig, eye_rest)
    anchor = three_to_blender(helm['eyeAnchorParts'])
    report['eyeSeated'] = [round(float(v), 4) for v in e]
    report['eyeError'] = [round(float(v), 4) for v in (e - anchor)]
    print(f"[pilot] rig: eye {report['eyeSeated']} (parts eye anchor error {report['eyeError']})")
    return report


def gaze(rig, down_deg):
    """pitch neck + head so the head's forward axis sits down_deg below the horizon"""
    for _ in range(3):
        fwd = np.array(rig.pose.bones['head'].matrix.to_3x3() @ Vector((0, 0, 1)))
        pitch = math.asin(np.clip(fwd[2], -1, 1))
        th = pitch + math.radians(down_deg)
        rotate_about(rig, 'neck_01', [1, 0, 0], th * 0.4)
        rotate_about(rig, 'head', [1, 0, 0], th * 0.6)


def elbow_deg(rig, s):
    u = unit3(head_of(rig, f'lowerarm_{s}') - head_of(rig, f'upperarm_{s}'))
    f = unit3(head_of(rig, f'hand_{s}') - head_of(rig, f'lowerarm_{s}'))
    return math.degrees(math.acos(np.clip(u @ f, -1, 1)))


def unit3(v):
    return v / max(np.linalg.norm(v), 1e-12)


def capture_pose(rig):
    return {pb.name: pb.matrix_basis.copy() for pb in rig.pose.bones}


# ── bind ────────────────────────────────────────────────────────────────────


def eval_deformed(ob, key, rig):
    """positions of one shape key of ob deformed by rig (the object's own data: no mesh copies)"""
    arm = [m for m in ob.modifiers if m.type == 'ARMATURE']
    mod = arm[0] if arm else ob.modifiers.new('Armature', 'ARMATURE')
    for m in ob.modifiers:
        m.show_viewport = m == mod
    mod.object = rig
    keys = ob.data.shape_keys
    if keys:
        names = [k.name for k in keys.key_blocks]
        ob.show_only_shape_key = True
        ob.active_shape_key_index = names.index(key)
    dg = bpy.context.evaluated_depsgraph_get()
    dg.update()
    eo = ob.evaluated_get(dg)
    me = eo.to_mesh()
    out = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get('co', out)
    eo.to_mesh_clear()
    if keys:
        ob.show_only_shape_key = False
        ob.active_shape_key_index = 0
    return out.reshape(-1, 3)


def variant_rig(rig, joints, pose, name):
    cp = rig.copy()
    cp.data = rig.data.copy()
    cp.name = name
    C.link(cp)
    reset_pose(cp)
    C.select_only([cp])
    bpy.ops.object.mode_set(mode='EDIT')
    eb = cp.data.edit_bones
    delta = {}

    def move(b):
        if b.name in delta:
            return
        if b.parent is not None:
            move(b.parent)
        # bones MakeHuman does not know (head_geo, eyes, goggles, twist) ride with their parent
        d = b2v(joints[b.name]) - b.head if b.name in joints else (delta[b.parent.name] if b.parent else Vector((0, 0, 0)))
        delta[b.name] = d.copy()
        b.head = b.head + d
        b.tail = b.tail + d

    for b in list(eb):
        move(b)
    # re-connect: a parent's tail follows its (single) child's head
    for b in eb:
        kids = [k for k in b.children if k.name in joints]
        if len(kids) == 1 and b.name in joints:
            b.tail = kids[0].head.copy()
    bpy.ops.object.mode_set(mode='OBJECT')
    for pb in cp.pose.bones:
        pb.matrix_basis = pose[pb.name]
    bpy.context.view_layer.update()
    return cp


def bind_seated(rig, pose, variant_joints):
    meshes = [o for o in bpy.data.objects if o.type == 'MESH' and o.parent == rig]
    vrigs = {k: variant_rig(rig, j, pose, f'VRIG_{k}') for k, j in variant_joints.items()}
    for pb in rig.pose.bones:
        pb.matrix_basis = pose[pb.name]
    bpy.context.view_layer.update()
    seated_heads = {'Basis': {pb.name: [round(float(c), 5) for c in pb.head] for pb in rig.pose.bones}}
    for k, vr in vrigs.items():
        seated_heads[k] = {pb.name: [round(float(c), 5) for c in pb.head] for pb in vr.pose.bones}
    posed = {}
    for ob in meshes:
        shapes = M.all_shapes(ob)
        posed[ob.name] = {k: eval_deformed(ob, k, rig if k == 'Basis' else vrigs[k]) for k in shapes}
    C.select_only([rig])
    bpy.ops.object.mode_set(mode='POSE')
    bpy.ops.pose.armature_apply(selected=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    for ob in meshes:
        ob.shape_key_clear()
        C.set_coords(ob, posed[ob.name]['Basis'])
        if len(posed[ob.name]) > 1:
            M.set_all_shapes(ob, posed[ob.name])
    for vr in vrigs.values():
        data = vr.data
        bpy.data.objects.remove(vr, do_unlink=True)
        bpy.data.armatures.remove(data)
    return seated_heads


def add_ik_bones(cfg, rig, grips):
    C.select_only([rig])
    bpy.ops.object.mode_set(mode='EDIT')
    eb = rig.data.edit_bones
    root = eb['Root']
    eyes = C.coords(bpy.data.objects['Eyes'])
    eye_mid = (eyes[eyes[:, 0] > 0].mean(axis=0) + eyes[eyes[:, 0] < 0].mean(axis=0)) / 2
    spots = {
        'ik_hand_l': np.array(eb['hand_l'].head), 'ik_hand_r': np.array(eb['hand_r'].head),
        'ik_foot_l': np.array(eb['foot_l'].head), 'ik_foot_r': np.array(eb['foot_r'].head),
        'ik_look': eye_mid + np.array([0.0, -2.0, 0.0]),
    }
    for name, p in spots.items():
        b = eb.new(name)
        b.head = b2v(p)
        b.tail = b2v(p + np.array([0, -0.06, 0]))
        b.parent = root
        b.use_deform = False
    bpy.ops.object.mode_set(mode='OBJECT')
    return {k: [round(float(v), 4) for v in p] for k, p in spots.items()}


def add_cam_eye(cfg, rig):
    """cockpit camera socket: an empty parented to the `head` bone (not a joint, so the skin stays at
    64), between the eyes and sockets.cam_eye.forwardM ahead of them. Blender local +Y = view direction
    and +Z = up, which the glTF exporter's Y-up conversion turns into node -Z = view, +Y = up (the
    glTF camera convention)."""
    spec = cfg['rig']['sockets']['cam_eye']
    eyes = C.coords(bpy.data.objects['Eyes'])
    mid = (eyes[eyes[:, 0] > 0].mean(axis=0) + eyes[eyes[:, 0] <= 0].mean(axis=0)) / 2
    hm = np.array(rig.data.bones['head'].matrix_local.to_3x3())
    fwd = unit3(hm[:, 2])
    up = unit3(hm[:, 1] - (hm[:, 1] @ fwd) * fwd)
    right = unit3(np.cross(fwd, up))
    pos = mid + fwd * spec['forwardM']
    ob = bpy.data.objects.new('cam_eye', None)
    C.link(ob)
    ob.empty_display_size = 0.03
    ob.parent = rig
    ob.parent_type = 'BONE'
    ob.parent_bone = spec['parentBone']
    bpy.context.view_layer.update()
    M = Matrix.Identity(4)
    for r in range(3):
        M[r][0], M[r][1], M[r][2], M[r][3] = right[r], fwd[r], up[r], pos[r]
    ob.matrix_world = rig.matrix_world @ M
    bpy.context.view_layer.update()
    return {'eyeMid': [round(float(v), 4) for v in mid], 'position': [round(float(v), 4) for v in pos],
            'forward': [round(float(v), 4) for v in fwd]}


# ── harness + cable (seated) ────────────────────────────────────────────────


def _surface_path(points, bvh, dirs, offset):
    out = []
    for p, d in zip(points, dirs):
        d = np.asarray(d, dtype=np.float64)
        d /= np.linalg.norm(d)
        loc = bvh.ray_cast(b2v(p + d * 0.4), b2v(-d), 0.8)[0]
        out.append(np.array(loc) + d * offset if loc is not None else np.asarray(p))
    return np.array(out)


def build_harness(cfg, rig):
    vest = bpy.data.objects['Vest']
    suit = bpy.data.objects['Suit']
    collar = bpy.data.objects['VestCollar']
    bvh_up = M.bvh_of([vest, collar, suit])
    J = {b.name: np.array(b.head_local) for b in rig.data.bones}
    vco = C.coords(vest)
    front_y = vco[:, 1].min()
    parts = [[], [], []]
    groups = {}
    buckle = np.array([0.0, 0.0, J['spine_01'][2] + 0.03])
    buckle = _surface_path([buckle], bvh_up, [[0, -1, 0.15]], 0.012)[0]
    web = np.array([[0.0016, 0.025], [-0.0016, 0.025], [-0.0016, -0.025], [0.0016, -0.025]])  # 50 mm webbing (APBA: belts >= 50 mm), flat box section
    strap_ranges = []
    for s, sx in (('l', 1), ('r', -1)):
        sh = J[f'upperarm_{s}']
        cl = J[f'clavicle_{s}']
        # shoulder straps: from the bolster behind the hips, up the back, over the shoulder, down the chest
        pel = J['pelvis']
        anchor = np.array([sx * 0.09, pel[1] + 0.2, 0.2])
        over = np.array([sx * abs(sh[0]) * 0.55, cl[1] + 0.02, sh[2] + 0.2])
        over = _surface_path([over], bvh_up, [[0.15 * sx, 0.1, 1.0]], 0.012)[0]
        chest_hi = np.array([sx * 0.085, front_y, sh[2] - 0.06])
        chest_lo = np.array([sx * 0.06, front_y, (sh[2] + buckle[2]) / 2 - 0.03])
        fr = _surface_path([chest_hi, chest_lo], bvh_up, [[0.1 * sx, -1, 0.25], [0.05 * sx, -1, 0.1]], 0.012)
        back_hi = _surface_path([over + np.array([0, 0.09, -0.06])], bvh_up, [[0.05 * sx, 1.0, 0.3]], 0.012)[0]
        back_lo = _surface_path([np.array([sx * 0.085, 0.0, (sh[2] + pel[2]) / 2])], bvh_up, [[0.05 * sx, 1.0, 0.0]], 0.012)[0]
        ctrl = [anchor, back_lo, back_hi, over, fr[0], fr[1], buckle + np.array([sx * 0.025, 0, 0.03])]
        path = M.catmull(ctrl, 24)
        nrm = np.gradient(path, axis=0)
        body_c = np.array([sx * 0.03, J['spine_03'][1], J['spine_03'][2] - 0.05])
        side = path - body_c
        side /= np.linalg.norm(side, axis=1, keepdims=True)
        v, f, _ = M.sweep(path, web, normals=side)
        a0, a1 = add_part(parts, v, f, 'webbing')
        strap_ranges.append((a0, a1, path, anchor, 'vest'))
        # adjuster on the chest
        k = 16
        t = path[k + 1] - path[k - 1]
        t = t / np.linalg.norm(t)
        # real 50 mm harness hardware (REFERENCES g8): an open tri-glide frame, 58 x 26 mm, 4.4 mm bar,
        # lying on the webbing (v1's 56 x 40 x 9 mm solid slide read as a chrome slab)
        nrm_k = side[k] - (side[k] @ t) * t
        nrm_k /= np.linalg.norm(nrm_k)
        acr = np.cross(t, nrm_k)
        c0 = path[k] + nrm_k * 0.0035
        hw, hl = 0.029, 0.013
        ring = [c0 + t * hl * np.cos(a) / max(abs(np.cos(a)), abs(np.sin(a))) + acr * hw * np.sin(a) / max(abs(np.cos(a)), abs(np.sin(a)))
                for a in np.linspace(0, 2 * math.pi, 29)[:-1]]
        ring = M.catmull(ring + ring[:1], 20)
        v, f, _ = M.sweep(ring, M.circle(4, 0.0024, math.pi / 4), normals=[nrm_k] * len(ring), cap=False)
        b0, b1 = add_part(parts, v, f, 'buckle')
        groups.setdefault('rigid_vest', []).append(np.arange(b0, b1))
        v, f, _ = M.sweep(M.resample([c0 - acr * hw, c0 + acr * hw], 2), M.circle(4, 0.0024, math.pi / 4), normals=[nrm_k] * 2)
        b0, b1 = add_part(parts, v, f, 'buckle')
        groups.setdefault('rigid_vest', []).append(np.arange(b0, b1))
        # lap belt from the pan side, over the hip, to the buckle
        th = J[f'thigh_{s}']
        lap_anchor = np.array([sx * 0.25, th[1] + 0.12, 0.02])
        hip = _surface_path([np.array([sx * 0.17, th[1] - 0.02, th[2] + 0.06])], bvh_up, [[sx, -0.6, 0.3]], 0.01)[0]
        belly = _surface_path([np.array([sx * 0.09, front_y, buckle[2] - 0.02])], bvh_up, [[0.2 * sx, -1, 0]], 0.012)[0]
        path = M.catmull([lap_anchor, hip, belly, buckle + np.array([sx * 0.03, 0, -0.018])], 18)
        body_c = np.array([0.0, J['pelvis'][1], J['pelvis'][2] + 0.06])
        side = path - body_c
        side /= np.linalg.norm(side, axis=1, keepdims=True)
        v, f, _ = M.sweep(path, web, normals=side)
        a0, a1 = add_part(parts, v, f, 'webbing')
        strap_ranges.append((a0, a1, path, lap_anchor, 'suit'))
    # cam-lock buckle: base plate + rotary disc + latch tongues
    bn = np.array([0.0, -1.0, 0.18])
    bn /= np.linalg.norm(bn)
    seg = M.resample([buckle - bn * 0.002, buckle + bn * 0.005], 3)
    v, f, _ = M.sweep(seg, M.rounded_rect(0.072, 0.066, 0.012, 3), up_hint=(0, 0, 1))
    b0, b1 = add_part(parts, v, f, 'buckle')
    seg = M.resample([buckle + bn * 0.006, buckle + bn * 0.017], 3)
    v, f, _ = M.sweep(seg, M.circle(24, 0.029), up_hint=(0, 0, 1), scale=[1.0, 1.0, 0.92])
    b2, b3 = add_part(parts, v, f, 'buckle')
    groups.setdefault('rigid_vest', []).append(np.arange(b0, b3))
    ob = build_parts('Harness', parts, 'M_Pilot')
    gc = np.zeros((len(C.coords(ob)), 3))
    for a0, a1, path, _anchor, _src in strap_ranges:
        gc[a0:a1] = M.sweep_gc(path, web)
    M.set_gc(ob, gc)
    # weights: body under the strap, fading to Root (the seat) off the body
    M.transfer_weights(vest, ob)
    co = C.coords(ob)
    root = ob.vertex_groups.get('Root') or ob.vertex_groups.new(name='Root')
    bvh = M.bvh_of([vest, suit, collar])
    for a0, a1, path, anchor, _src in strap_ranges:
        for i in range(a0, a1):
            p = co[i]
            _loc, _n, _fi, dist = bvh.find_nearest(b2v(p))
            off = np.clip((dist - 0.03) / 0.08, 0, 1)
            if off > 1e-3:
                for g in ob.vertex_groups:
                    if g.name == 'Root':
                        continue
                    try:
                        w = g.weight(i)
                    except RuntimeError:
                        continue
                    g.add([i], w * (1 - off), 'REPLACE')
                root.add([i], float(off), 'REPLACE')
    M.transfer_variant_keys(vest, ob, rigid_groups=groups['rigid_vest'])
    return ob


def build_dash_cable(cfg, rig):
    head = bpy.data.objects['Headset']
    hco = C.coords(head)
    attr = head.data.attributes['look']
    looks = np.empty(len(head.data.polygons), dtype=np.int32)
    attr.data.foreach_get('value', looks)
    cable_verts = set()
    for p in head.data.polygons:
        if looks[p.index] == LOOKS['cable']:
            cable_verts.update(p.vertices)
    cv = hco[sorted(cable_verts)]
    start = cv[np.argmin(cv[:, 2])]
    vest = bpy.data.objects['Vest']
    bvh = M.bvh_of([vest])
    J = {b.name: np.array(b.head_local) for b in rig.data.bones}
    clip = _surface_path([np.array([0.11, 0.0, J['spine_03'][2] - 0.02])], bvh, [[0.3, -1, 0.1]], 0.012)[0]
    dash = three_to_blender(cfg['helm']['cableDashAnchor'])
    guide = M.catmull([start, (start + clip) / 2 + np.array([0.01, -0.01, 0]), clip], 14)
    parts = [[], [], []]
    v, f, _ = M.sweep(guide, M.circle(4, 0.0032), up_hint=(0, -1, 0))
    add_part(parts, v, f, 'cable')
    # coiled cord from the chest clip to the dash, sagging between them
    n = 40
    t = np.linspace(0, 1, n)
    line = clip[None] + np.outer(t, dash - clip)
    line[:, 2] -= 0.16 * np.sin(math.pi * t)
    # the coil is a tube whose turns live in the normal map (look 'coil', gc u along it): a modelled
    # helix needs >= 8 samples per turn, ~2k triangles, and at 4 samples per turn it zig-zagged
    coil_r = 0.0026 + 0.0045 * np.clip(np.minimum(t, 1 - t) * 12, 0, 1)
    prof = M.circle(6, 1.0)
    v, f, _ = M.sweep(line, prof, up_hint=(0, 0, 1), scale=coil_r)
    c0, c1 = add_part(parts, v, f, 'coil')
    v, f, _ = M.sweep(M.resample([clip - np.array([0, 0, 0.018]), clip + np.array([0, 0, 0.018])], 3),
                      M.rounded_rect(0.012, 0.02, 0.003, 2), up_hint=(0, -1, 0))
    k0, k1 = add_part(parts, v, f, 'buckle')
    ob = build_parts('DashCable', parts, 'M_Pilot')
    co = C.coords(ob)
    sp = ob.vertex_groups.new(name='spine_03')
    root = ob.vertex_groups.new(name='Root')
    hd = ob.vertex_groups.new(name='head_geo')
    for i in range(len(co)):
        if i < c0:
            u = np.clip((co[i, 2] - clip[2]) / max(start[2] - clip[2], 1e-6), 0, 1)
            if u > 0.5:
                hd.add([i], float((u - 0.5) * 2), 'REPLACE')
            sp.add([i], float(1 - max(0, (u - 0.5) * 2)), 'REPLACE')
        elif i < c1:
            u = (i - c0) / max(c1 - c0, 1)
            sp.add([i], float(1 - u), 'REPLACE')
            root.add([i], float(u), 'REPLACE')
        else:
            sp.add([i], 1.0, 'REPLACE')
    M.transfer_variant_keys(vest, ob, rigid_groups=[np.arange(c0, len(co))])
    gc = np.zeros((len(co), 3))
    gc[c0:c1] = M.sweep_gc(line, prof)
    M.set_gc(ob, gc)
    return ob


# ── stage ───────────────────────────────────────────────────────────────────


def run(cfg, work, args):
    rep = C.load(work, 'stage_fit')
    rig = bpy.data.objects['PilotRig']
    body = rep['body']
    add_extra_bones(cfg, rig)
    pose_rep = seated_pose(cfg, rig)
    pose = capture_pose(rig)
    variant_joints = {'variant_b': body['variants']['npc_b']['jointHeads'],
                      'variant_c': body['variants']['npc_c']['jointHeads']}
    seated_heads = bind_seated(rig, pose, variant_joints)
    ik = add_ik_bones(cfg, rig, pose_rep['grips'])
    cam = add_cam_eye(cfg, rig)
    harness = build_harness(cfg, rig)
    cable = build_dash_cable(cfg, rig)
    for ob in (harness, cable):
        ob.parent = rig
        mod = ob.modifiers.new('Armature', 'ARMATURE')
        mod.object = rig
    for ob in [o for o in bpy.data.objects if o.type == 'MESH']:
        for m in ob.modifiers:
            if m.type == 'ARMATURE':
                m.object = rig
    deform = [b.name for b in rig.data.bones if b.use_deform]
    report = {'pose': pose_rep, 'ikBones': ik, 'camEye': cam, 'bones': len(rig.data.bones), 'deformBones': len(deform),
              'seatedJointHeads': seated_heads, 'fit': rep}
    report['pieces'] = {o.name: C.tri_count(o) for o in bpy.data.objects if o.type == 'MESH'}
    print(f"[pilot] rig: {report['bones']} bones ({report['deformBones']} deform), harness {C.tri_count(harness)} tris, cable {C.tri_count(cable)} tris")
    C.save(work, 'stage_rig', report)
