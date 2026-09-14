"""
Stage 8 (export): final Blender materials, root extras, raw GLB.

The exporter writes what glTF can express: skinned meshes per LOD, morph targets `variant_b` /
`variant_c`, the skeleton, every action as a clip, baseColor / ORM / normal textures. The node step
(scripts/pilot-build.mjs) then adds what Blender cannot export: alphaMode per slot, the lens
clearcoat, the hair flow and detail-normal textures (named, referenced from material extras),
KHR_materials_variants for the skin albedos, and KTX2 + meshopt packaging.
"""
import json
import math
import os

import bpy
import numpy as np

import common as C
from rig import three_to_blender  # noqa: F401  (frame helpers live there)


def blender_to_three(p):
    x, y, z = p
    return [round(float(x), 5), round(float(z), 5), round(float(-y), 5)]


def image(work, name, colorspace):
    img = bpy.data.images.load(os.path.join(work, name + '.png'), check_existing=True)
    img.name = name
    img.colorspace_settings.name = colorspace
    # alpha is data (accent mask, SSS thickness, coverage): never let it premultiply the colour
    img.alpha_mode = 'CHANNEL_PACKED'
    return img


def gltf_output_group():
    name = 'glTF Material Output'
    group = bpy.data.node_groups.get(name)
    if group is None:
        group = bpy.data.node_groups.new(name, 'ShaderNodeTree')
        group.interface.new_socket('Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
        group.nodes.new('NodeGroupInput')
    return group


def textured(mat, base, orm=None, normal=None, alpha=False, roughness=0.5, metallic=0.0):
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    bs = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(bs.outputs['BSDF'], out.inputs['Surface'])
    tb = nt.nodes.new('ShaderNodeTexImage')
    tb.image = base
    nt.links.new(tb.outputs['Color'], bs.inputs['Base Color'])
    if alpha:
        nt.links.new(tb.outputs['Alpha'], bs.inputs['Alpha'])
    bs.inputs['Roughness'].default_value = roughness
    bs.inputs['Metallic'].default_value = metallic
    if orm is not None:
        to = nt.nodes.new('ShaderNodeTexImage')
        to.image = orm
        sep = nt.nodes.new('ShaderNodeSeparateColor')
        nt.links.new(to.outputs['Color'], sep.inputs['Color'])
        nt.links.new(sep.outputs['Green'], bs.inputs['Roughness'])
        nt.links.new(sep.outputs['Blue'], bs.inputs['Metallic'])
        g = nt.nodes.new('ShaderNodeGroup')
        g.node_tree = gltf_output_group()
        nt.links.new(sep.outputs['Red'], g.inputs['Occlusion'])
    if normal is not None:
        tn = nt.nodes.new('ShaderNodeTexImage')
        tn.image = normal
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nt.links.new(tn.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], bs.inputs['Normal'])
    return bs


def setup_materials(work):
    m = bpy.data.materials['M_Pilot']
    textured(m, image(work, 'T_Pilot_base', 'sRGB'), image(work, 'T_Pilot_orm', 'Non-Color'), image(work, 'T_Pilot_normal', 'Non-Color'), alpha=True)
    m = bpy.data.materials['M_PilotSkin']
    bs = textured(m, image(work, 'T_PilotSkin_base_hero', 'sRGB'), image(work, 'T_PilotSkin_orm', 'Non-Color'),
                  image(work, 'T_PilotSkin_normal', 'Non-Color'), alpha=True)
    m = bpy.data.materials['M_PilotHair']
    bs = textured(m, image(work, 'T_PilotHair_base', 'sRGB'), None, None, alpha=True, roughness=0.55)
    m.use_backface_culling = False
    m = bpy.data.materials['M_PilotLens']
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    bs = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(bs.outputs['BSDF'], out.inputs['Surface'])
    bs.inputs['Base Color'].default_value = (0.62, 0.34, 0.08, 1.0)
    bs.inputs['Alpha'].default_value = 0.5
    bs.inputs['Roughness'].default_value = 0.12
    bs.inputs['Coat Weight'].default_value = 1.0
    bs.inputs['Coat Roughness'].default_value = 0.05
    for name in ('M_Pilot', 'M_PilotSkin', 'M_PilotLens'):
        bpy.data.materials[name].use_backface_culling = True


def root_extras(cfg, rep, rig):
    root = bpy.data.objects['SB_Pilot']
    seat = cfg['seat']
    seated = rep['seatedJointHeads']
    variants = {}
    for vname, key in (('hero', 'Basis'), ('npc_b', 'variant_b'), ('npc_c', 'variant_c')):
        v = cfg['variants'][vname]
        variants[vname] = {
            'label': v['label'], 'morph': None if key == 'Basis' else key, 'skinMaterialVariant': vname,
            'hairStyle': v['hair'], 'hairColor': v['hairColor'],
            # IK / look-at targets are placed by the runtime; every variant starts them at the hero rest
            'jointHeads': {**{b.name: blender_to_three(b.head_local) for b in rig.data.bones},
                           **{b: blender_to_three(p) for b, p in seated[key].items()}},
        }
    ik = {
        'hand_l': {'target': 'ik_hand_l', 'effector': 'hand_l', 'links': ['lowerarm_l', 'upperarm_l']},
        'hand_r': {'target': 'ik_hand_r', 'effector': 'hand_r', 'links': ['lowerarm_r', 'upperarm_r']},
        'foot_l': {'target': 'ik_foot_l', 'effector': 'foot_l', 'links': ['calf_l', 'thigh_l']},
        'foot_r': {'target': 'ik_foot_r', 'effector': 'foot_r', 'links': ['calf_r', 'thigh_r']},
        'look': {'target': 'ik_look', 'bones': ['neck_01', 'head'], 'weights': [0.35, 0.65]},
        'twist': {'lowerarm_twist_l': {'follows': 'hand_l', 'share': 1.0}, 'lowerarm_twist_r': {'follows': 'hand_r', 'share': 1.0},
                  'note': 'after IK, copy the hand bone twist about its own Y onto lowerarm_twist (weights ramp to 0.9 at the wrist)'},
    }
    helm = cfg['helm']
    pose = rep['pose']
    to3 = lambda p: blender_to_three(p)  # noqa: E731
    cam = rep['camEye']
    extras = {
        'assetKind': 'pilot',
        'contractVersion': cfg['version'],
        'frame': 'seat socket: metres, +Y up, +Z bow; origin = the hull JSON seat station on the seat pan top (pilot_config.json seat)',
        'seatSocket': 'PilotSeatSocket',
        'heightM': cfg['body']['heightM'],
        # `eye` IS the cam_eye socket (the cockpit camera position, forwardM ahead of the eye midpoint), so a consumer of
        # the extras and one of the node agree; the parts anchor error stays measured at the eye midpoint
        'seated': {'hipsZ': pose['hipsZ'], 'leanDeg': pose['leanDeg'], 'eye': to3(cam['position']),
                   'partsEyeAnchor': helm['eyeAnchorParts'], 'partsEyeAnchorError': to3(pose['eyeError'])},
        'helm': {'source': 'parts build sockets (Helm_LOD0 pivot/axis, helm.py rim), pilot frame',
                 'hub': helm['wheelHub'], 'axis': helm['wheelAxis'], 'rimRadius': helm['wheelRadius'], 'rimTube': helm['rimTube'],
                 'gripClockDeg': helm['gripClockDeg'], 'grips': {s: to3(g) for s, g in pose['grips'].items()},
                 'gripFrames': pose['gripFrames']},
        'throttle': {'source': 'parts build Throttle_LOD0 pivot/axis/idleDeg/fullDeg + throttle.py handle', 'origin': helm['throttleOrigin'],
                     'rollDeg': helm['throttleRollDeg'], 'pivotLocal': helm['throttlePivotLocal'], 'handleLocal': helm['throttleHandleLocal'],
                     'idleDeg': helm['throttleIdleDeg'], 'fullDeg': helm['throttleFullDeg'], 'reach': rep.get('clipReports', {}).get('throttle_push')},
        'cableDashAnchor': {'position': helm['cableDashAnchor'], 'assumed': helm['cableDashAnchorAssumed']},
        'ik': ik,
        'clips': cfg['clips'],
        'clipsRotationOnly': True,
        'variants': variants,
        'firstPerson': {'collapseBone': 'head_geo', 'cameraNode': 'cam_eye', 'nearMaxM': cfg['rig']['sockets']['cam_eye']['nearMaxM'],
                        'note': 'cockpit camera = cam_eye world matrix (child of the head joint: -Z view, +Y up). Scale head_geo to ~0 to hide the face, hair, eyes, goggles and headset; head and cam_eye keep their transform. Hands, sleeves and the goggle strap edge may show.'},
        'hairWind': {'attribute': 'TEXCOORD_1', 'x': 'along card 0 (root, pinned) -> 1 (tip)', 'y': 'per-card phase 0..1'},
        'hairStyles': cfg['hair']['styles'],
        'lodScreenFraction': [0.25, 0.08],
        'triangles': rep['lod']['tris'],
    }
    for k, v in extras.items():
        root[k] = json.dumps(v) if isinstance(v, (dict, list)) else v
    root['extrasJson'] = True


def run(cfg, work, args):
    rep = C.load(work, 'stage_lod')
    rig = bpy.data.objects['PilotRig']
    setup_materials(work)
    root_extras(cfg, rep, rig)
    rig.data.pose_position = 'REST'
    for pb in rig.pose.bones:
        pb.matrix_basis = pb.matrix_basis.__class__.Identity(4)
    if rig.animation_data:
        rig.animation_data.action = None
    bpy.context.scene.frame_set(1)
    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=out, export_format='GLB', export_yup=True, export_apply=False, export_extras=True,
        export_tangents=True, export_normals=True, export_texcoords=True, export_materials='EXPORT',
        export_image_format='AUTO', export_cameras=False, export_lights=False, use_selection=False,
        export_skins=True, export_influence_nb=4, export_def_bones=False, export_leaf_bone=False,
        export_rest_position_armature=True, export_morph=True, export_morph_normal=False, export_morph_tangent=False,
        export_animations=True, export_animation_mode='ACTIONS', export_force_sampling=False,
        export_optimize_animation_size=True, export_anim_single_armature=True, export_bake_animation=False,
        export_anim_slide_to_zero=True,
    )
    rig.data.pose_position = 'POSE'
    C.save(work, 'stage_export', rep)
    with open(os.path.join(work, 'build_report.json'), 'w', encoding='utf-8') as f:
        json.dump({k: rep[k] for k in ('pose', 'lod', 'clips', 'clipReports', 'texture', 'hair', 'ikBones', 'camEye', 'bones', 'deformBones', 'fitReport') if k in rep}, f, indent=2)
    print(f'[pilot] export: {out} ({os.path.getsize(out)} B)')
