"""
Stage 6 (anim): the pilot clips, authored procedurally on the seated bind pose and baked to keys.

Every clip is rotation-only (quaternion keys; no translation tracks), so a variant skeleton that the
runtime has re-bound to its own joint positions plays the same clips. The seated bind is the
identity pose, so `seated_base` is the reference for the additive clips (pilot_config.json `clips`).

Per frame: reset to the bind, apply body motion in the seat frame (world axes, parents first), then
re-solve both arms with two-bone IK to the grips on the wheel rim (they turn with the wheel in the
steer clips), so hands stay on the wheel whatever the torso does. Forearm twist bones take half of
the hand's twist. Clips:

  seated_base     1 frame  bind pose
  idle_seated     2.0 s    loop: breathing plus engine vibration (3-frame jitter on pelvis/spine/head)
  steer_left/right 0.5 s   wheel turned 90°, hands ride the rim, lean and head tilt into the turn
  throttle_push   0.8 s    torso leans/turns right, the right hand leaves the rim, grips the real
                           throttle handle (palm frame + finger wrap solved on it) and pushes the lever
                           from idle to full; the grip rides the lever's rotation
  brace_landing   0.6 s    shoulders set, spine curls, head tucks, elbows lock
  airborne_tuck   0.8 s    crouch, knees up, arms pull in
  impact_jolt     0.45 s   forward whip, rebound, settle (head lags)
  capsize_hang    2.0 s    loop: inverted and strapped in, arms and head hang toward the deck (+Y of
                           the boat), slow sway, nothing gory
  look_back       1.0 s    torso and head turn over the right shoulder, hands stay on the wheel
  victory_fist    1.5 s    right fist pumped twice above the head, left hand on the wheel
  goggles_up      1 frame  goggles pushed up on the forehead (menus, results)
"""
import math

import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector

import common as C
from rig import aim, head_of, reset_pose, rotate_about, three_to_blender, two_bone

FPS = 30
X = np.array([1.0, 0, 0])
Y = np.array([0, 1.0, 0])
Z = np.array([0, 0, 1.0])
FINGERS = ['index', 'middle', 'ring', 'pinky']


def ease(t):
    t = min(max(t, 0.0), 1.0)
    return t * t * (3 - 2 * t)


def pulse(t, a, b):
    """0 → 1 → 0 between a and b"""
    if t <= a or t >= b:
        return 0.0
    return math.sin(math.pi * (t - a) / (b - a))


class Wheel:
    """the real parts helm (pilot_config.json helm): rim hub + axis toward the pilot, and the throttle
    quadrant's lever handle as a function of the lever angle (throttle.py geometry)"""

    def __init__(self, cfg, grips):
        h = cfg['helm']
        self.c = three_to_blender(h['wheelHub'])
        n = three_to_blender(h['wheelAxis'])
        self.n = n / np.linalg.norm(n)
        self.grips = {s: np.array(g) for s, g in grips.items()}
        self.h = h

    def grip(self, s, angle):
        """grip point after turning the wheel by angle (radians, + = left turn, counter-clockwise seen by the pilot)"""
        v = Vector(self.grips[s] - self.c)
        q = Quaternion(Vector(self.n), angle)
        return self.c + np.array(q @ v)

    def lever(self, deg):
        """(handle centre, lever axis, lever up direction, pivot) in Blender armature space"""
        h = self.h
        roll = math.radians(h['throttleRollDeg'])
        Rz = np.array([[math.cos(roll), -math.sin(roll), 0], [math.sin(roll), math.cos(roll), 0], [0, 0, 1]])
        a = math.radians(deg)
        Rx = np.array([[1, 0, 0], [0, math.cos(a), -math.sin(a)], [0, math.sin(a), math.cos(a)]])
        o = np.array(h['throttleOrigin'])
        piv = o + Rz @ np.array(h['throttlePivotLocal'])
        handle = piv + Rz @ (Rx @ np.array(h['throttleHandleLocal']))
        up = Rz @ (Rx @ np.array([0.0, 1.0, 0.0]))
        axis = Rz @ np.array([1.0, 0.0, 0.0])
        return three_to_blender(handle), three_to_blender(axis), three_to_blender(up), three_to_blender(piv)


def twist_bones(rig):
    """the hand's roll about its own axis goes to lowerarm_twist (the weights ramp to 0.9 at the wrist)"""
    import grip as G
    for s in ('l', 'r'):
        G.distribute_twist(rig, s)


BIND = {}


def record_bind(rig):
    """hand, elbow and shoulder of the bind pose: the reference every clip re-solves against"""
    reset_pose(rig)
    for s in ('l', 'r'):
        BIND[s] = {
            'wrist': head_of(rig, f'hand_{s}'), 'elbow': head_of(rig, f'lowerarm_{s}'),
            'shoulder': head_of(rig, f'upperarm_{s}'), 'hand': rig.pose.bones[f'hand_{s}'].matrix.copy(),
            'spine': rig.pose.bones['spine_03'].matrix.to_3x3().copy(),
        }


def keep_hands(rig, wheel, angle=0.0, free=()):
    """hands glued to the wheel: the bind wrist and hand orientation turned with the wheel, arms
    re-solved with the elbow on the side it had in the bind (carried along by the chest). With no
    torso motion and no wheel turn this reproduces the bind exactly."""
    q = Quaternion(Vector(wheel.n), angle)
    Rq = q.to_matrix()
    chest = rig.pose.bones['spine_03'].matrix.to_3x3() @ BIND['l']['spine'].inverted()
    for s in ('l', 'r'):
        if s in free:
            continue
        b = BIND[s]
        wrist = wheel.c + np.array(Rq @ Vector(b['wrist'] - wheel.c))
        mid = (b['shoulder'] + b['wrist']) / 2
        pole = np.array(chest @ Vector(b['elbow'] - mid))
        two_bone(rig, f'upperarm_{s}', f'lowerarm_{s}', wrist, pole)
        pb = rig.pose.bones[f'hand_{s}']
        rot = (Rq @ b['hand'].to_3x3()).to_4x4()
        rot.translation = pb.matrix.translation
        pb.matrix = rot
        bpy.context.view_layer.update()


def torso(rig, pitch=0.0, roll=0.0, yaw=0.0, head_pitch=0.0, head_roll=0.0, head_yaw=0.0, neck_share=0.4):
    for name, f in (('spine_01', 0.25), ('spine_02', 0.33), ('spine_03', 0.42)):
        if pitch:
            rotate_about(rig, name, X, pitch * f)
        if roll:
            rotate_about(rig, name, Y, roll * f)
        if yaw:
            rotate_about(rig, name, Z, yaw * f)
    for name, f in (('neck_01', neck_share), ('head', 1 - neck_share)):
        if head_pitch:
            rotate_about(rig, name, X, head_pitch * f)
        if head_roll:
            rotate_about(rig, name, Y, head_roll * f)
        if head_yaw:
            rotate_about(rig, name, Z, head_yaw * f)


# ── clip definitions: fn(rig, wheel, t_seconds, duration) ───────────────────


def idle(rig, w, t, d):
    breath = math.sin(2 * math.pi * t / d)
    rng = np.random.default_rng(int(round(t * FPS)) // 3 + 101)
    j = rng.normal(0, 1, 5)
    rotate_about(rig, 'pelvis', X, math.radians(0.25 * j[0]))
    torso(rig, pitch=math.radians(1.2 * breath + 0.35 * j[1]), roll=math.radians(0.3 * j[2]),
          head_pitch=math.radians(-0.8 * breath + 0.5 * j[3]), head_roll=math.radians(0.4 * j[4]))
    keep_hands(rig, w)


def steer(sign):
    def fn(rig, w, t, d):
        k = ease(t / d)
        ang = sign * math.radians(90) * k
        torso(rig, roll=sign * math.radians(-6) * k, yaw=sign * math.radians(5) * k,
              head_roll=sign * math.radians(-5) * k, head_yaw=sign * math.radians(8) * k)
        keep_hands(rig, w, ang)
    return fn


THROTTLE = {}


def prepare_throttle(rig, w):
    """solve the right hand on the throttle handle once (at idle, torso reaching): palm frame, finger
    wrap and the torso lean/turn needed to reach the quadrant at the well wall"""
    import grip as G
    model = G.hand_model(rig, 'r')
    handle, axis, up, _piv = w.lever(w.h['throttleIdleDeg'])
    bar = G.Bar(handle, axis, w.h['throttleHandleRadius'])
    toward = np.array([0.0, 1.0, 0.0])
    pole = np.array([-0.8, 0.3, -0.5])
    best = None
    for roll in (0, 8, 16, 24, 32):
        for yaw in (0, 8, 16, 24):
            reset_pose(rig)
            torso(rig, yaw=math.radians(-yaw), roll=math.radians(-roll), pitch=math.radians(4))
            fr, st = G.best_frame(lambda al, tl: G.bar_frame(bar, 'r', up, toward, al, tl, model, 0.0015), rig, 'r', pole, model,
                                  alphas=range(0, 91, 10), tilts=(-20, 0, 20), alpha_pref=35)
            cost = (0 if st['reachRatio'] <= 0.97 else 100 * (st['reachRatio'] - 0.97)) + 0.05 * (roll + yaw) + 0.02 * st['wristBendDeg']
            if best is None or cost < best[0]:
                best = (cost, roll, yaw, fr, st)
    _c, roll, yaw, fr, st = best
    reset_pose(rig)
    torso(rig, yaw=math.radians(-yaw), roll=math.radians(-roll), pitch=math.radians(4))
    rep = G.solve_hand(rig, 'r', bar, fr, model, pole)
    names = [f'{f}_0{i}_r' for f in G.FINGERS + ['thumb'] for i in (1, 2, 3)]
    THROTTLE.update({'roll': roll, 'yaw': yaw, 'frame': fr, 'model': model, 'pole': pole, 'bar': bar,
                     'fingers': {n: rig.pose.bones[n].matrix_basis.to_quaternion() for n in names}})
    wrist = G.wrist_of(fr, model)[0]
    gap = float(np.linalg.norm(head_of(rig, 'hand_r') - wrist))
    reset_pose(rig)
    return {'torsoRollDeg': roll, 'torsoYawDeg': yaw, 'reachRatio': st['reachRatio'], 'wristBendDeg': st['wristBendDeg'],
            'handShortOfHandleM': round(gap, 3), 'gloveClearanceM': rep['gloveClearanceM']}


def throttle(rig, w, t, d):
    """right hand leaves the wheel, grips the throttle handle and pushes the lever from idle to full"""
    import grip as G
    T = THROTTLE
    reach = ease(t / 0.3)
    push = ease((t - 0.3) / 0.45)
    torso(rig, yaw=math.radians(-T['yaw']) * reach, roll=math.radians(-T['roll']) * reach, pitch=math.radians(4) * reach)
    keep_hands(rig, w, free=('r',))
    h = w.h
    deg = h['throttleIdleDeg'] + (h['throttleFullDeg'] - h['throttleIdleDeg']) * push
    _hd, axis, _up, piv = w.lever(deg)
    R = Quaternion(Vector(axis), math.radians(deg - h['throttleIdleDeg'])).to_matrix()
    R = np.array(R)
    fr = dict(T['frame'])
    fr['F'] = R @ T['frame']['F']
    fr['bonePc'] = piv + R @ (T['frame']['bonePc'] - piv)
    wrist_lever, rot_lever = G.wrist_of(fr, T['model'])
    # blend from the wheel grip (the bind) to the lever grip
    b = BIND['r']
    wrist = b['wrist'] + (wrist_lever - b['wrist']) * reach
    two_bone(rig, 'upperarm_r', 'lowerarm_r', wrist, T['pole'])
    q_bind = b['hand'].to_quaternion()
    q_lev = Matrix(rot_lever.tolist()).to_quaternion() @ rig.data.bones['hand_r'].matrix_local.to_quaternion()
    q = q_bind.slerp(q_lev, reach)
    pb = rig.pose.bones['hand_r']
    M = q.to_matrix().to_4x4()
    M.translation = pb.matrix.translation
    pb.matrix = M
    bpy.context.view_layer.update()
    for n, qf in T['fingers'].items():
        rig.pose.bones[n].rotation_mode = 'QUATERNION'
        rig.pose.bones[n].rotation_quaternion = Quaternion().slerp(qf, reach)
    bpy.context.view_layer.update()


def brace(rig, w, t, d):
    k = pulse(t, 0.0, d * 1.6) if t < d * 0.8 else 1.0
    k = ease(t / (d * 0.5))
    torso(rig, pitch=math.radians(9) * k, head_pitch=math.radians(10) * k)
    for s, sx in (('l', 1), ('r', -1)):
        rotate_about(rig, f'clavicle_{s}', Y, math.radians(-7 * sx) * k)
    keep_hands(rig, w)


def tuck(rig, w, t, d):
    k = ease(t / (d * 0.4))
    torso(rig, pitch=math.radians(14) * k, head_pitch=math.radians(6) * k)
    for s in ('l', 'r'):
        rotate_about(rig, f'thigh_{s}', X, math.radians(-14) * k)
        rotate_about(rig, f'calf_{s}', X, math.radians(18) * k)
        rotate_about(rig, f'foot_{s}', X, math.radians(-6) * k)
    keep_hands(rig, w)


def jolt(rig, w, t, d):
    f = t / d
    whip = math.sin(min(f, 1.0) * math.pi * 2.2) * math.exp(-3.2 * f)
    lag = math.sin(max(f - 0.08, 0.0) * math.pi * 2.2) * math.exp(-3.0 * f)
    torso(rig, pitch=math.radians(16) * whip, head_pitch=math.radians(14) * lag)
    keep_hands(rig, w)


def capsize(rig, w, t, d):
    sway = math.sin(2 * math.pi * t / d)
    sway2 = math.sin(2 * math.pi * t / d + 1.3)
    torso(rig, pitch=math.radians(-6), roll=math.radians(3 * sway), head_pitch=math.radians(-28), head_roll=math.radians(6 * sway2))
    for s, sx in (('l', 1), ('r', -1)):
        # arms fall toward the deck, which is "up" in the seat frame when the boat is inverted
        sh = head_of(rig, f'upperarm_{s}')
        elbow = sh + np.array([0.18 * sx, -0.05 + 0.02 * sway, 0.24])
        aim(rig, f'upperarm_{s}', elbow)
        wrist = elbow + np.array([0.06 * sx, 0.02 * sway2, 0.25])
        aim(rig, f'lowerarm_{s}', wrist)
        aim(rig, f'hand_{s}', wrist + np.array([0.02 * sx, 0.0, 0.1]))
        rotate_about(rig, f'thigh_{s}', X, math.radians(-12 - 3 * sway))
        rotate_about(rig, f'calf_{s}', X, math.radians(-10))


def look_back(rig, w, t, d):
    k = ease(t / (d * 0.45)) * (1 - ease((t - d * 0.7) / (d * 0.3)))
    torso(rig, yaw=math.radians(-24) * k, roll=math.radians(4) * k, head_yaw=math.radians(-62) * k, head_pitch=math.radians(-4) * k, neck_share=0.45)
    keep_hands(rig, w)


def victory(rig, w, t, d):
    up = ease(t / 0.35)
    pump = pulse(t, 0.45, 0.8) + pulse(t, 0.85, 1.2)
    torso(rig, pitch=math.radians(-5) * up, roll=math.radians(4) * up, head_pitch=math.radians(-10) * up)
    keep_hands(rig, w, free=('r',))
    sh = head_of(rig, 'upperarm_r')
    rest_hand = w.grip('r', 0.0)
    high = sh + np.array([-0.12, -0.08, 0.5 - 0.1 * pump])
    target = rest_hand + (high - rest_hand) * up
    elbow_pole = [-0.9, 0.2, -0.3 + 0.8 * up]
    two_bone(rig, 'upperarm_r', 'lowerarm_r', target, elbow_pole)
    aim(rig, 'hand_r', target + np.array([0, 0, 0.1]) * up + (target - sh) * 0.2 * (1 - up))


def goggles_up(rig, w, t, d):
    rotate_about(rig, 'goggles', X, math.radians(-38))
    keep_hands(rig, w)


CLIPS = {
    'seated_base': (lambda r, w, t, d: None, 1 / FPS),
    'idle_seated': (idle, 2.0),
    'steer_left': (steer(1), 0.5),
    'steer_right': (steer(-1), 0.5),
    'throttle_push': (throttle, 0.8),
    'brace_landing': (brace, 0.6),
    'airborne_tuck': (tuck, 0.8),
    'impact_jolt': (jolt, 0.45),
    'capsize_hang': (capsize, 2.0),
    'look_back': (look_back, 1.0),
    'victory_fist': (victory, 1.5),
    'goggles_up': (goggles_up, 1 / FPS),
}


def bake_clip(rig, wheel, name, fn, duration):
    frames = max(1, int(round(duration * FPS)))
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    rig.animation_data_create()
    rig.animation_data.action = act
    moved = set()
    poses = []
    for f in range(frames + 1):
        reset_pose(rig)
        fn(rig, wheel, f / FPS, duration)
        twist_bones(rig)
        q = {pb.name: pb.matrix_basis.to_quaternion() for pb in rig.pose.bones}
        poses.append(q)
        for n, qq in q.items():
            if abs(qq.w) < 0.99999:
                moved.add(n)
    if not moved:
        moved = {'pelvis'}
    for f, q in enumerate(poses):
        for n in sorted(moved):
            pb = rig.pose.bones[n]
            qq = q[n]
            if f > 0 and poses[f - 1][n].dot(qq) < 0:
                qq = -qq
                q[n] = qq
            pb.rotation_quaternion = qq
            pb.keyframe_insert('rotation_quaternion', frame=f + 1, group=n)
    rig.animation_data.action = None
    reset_pose(rig)
    return {'frames': frames + 1, 'bones': len(moved)}


def run(cfg, work, args):
    rep = C.load(work, 'stage_texture')
    rig = bpy.data.objects['PilotRig']
    for pb in rig.pose.bones:
        pb.rotation_mode = 'QUATERNION'
    sc = bpy.context.scene
    sc.render.fps = FPS
    wheel = Wheel(cfg, rep['pose']['grips'])
    record_bind(rig)
    rep['clipReports'] = {'throttle_push': prepare_throttle(rig, wheel)}
    print(f"[pilot] anim: throttle reach {rep['clipReports']['throttle_push']}")
    record_bind(rig)
    out = {}
    for name in cfg['clips']:
        if name not in CLIPS:
            raise SystemExit(f'[pilot] clip {name} in pilot_config.json has no definition in anim.py')
        fn, dur = CLIPS[name]
        out[name] = bake_clip(rig, wheel, name, fn, dur)
    rep['clips'] = out
    print(f'[pilot] anim: {out}')
    C.save(work, 'stage_anim', rep)
