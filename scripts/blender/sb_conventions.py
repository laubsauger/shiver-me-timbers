"""
Speedboat asset conventions, Blender side (docs/speedboat/asset-pipeline.md).

Everything a build script needs to produce a GLB the checker (scripts/blender/checkGlb.mjs) and
the runtime (src/speedboat/assets/) accept:

  * frame      three (x, y, z) body frame -> Blender (x, -z, y); the glTF exporter's +Y-up
               conversion maps it back, so the bow ends up on three.js +Z
  * hierarchy  root empty (asset extras) -> LOD{n} empties (lodLevel) -> <Part>_LOD{n} meshes
  * extras     Blender custom properties, exported with export_extras=True
  * LODs       decimate (collapse) + weld for generic parts; parametric hulls re-loft instead
  * UV / bake  smart-project stub + Cycles bake helpers (AO, normal, emission-as-data)
  * export     GLB, +Y up, tangents on, modifiers applied, extras on

The contract numbers (slot names, budgets, extras keys) are NOT repeated here: they are read from
src/speedboat/assets/assetContract.json, the same file the checker and runtime read.
"""
import json
import math
import os

import bpy
import bmesh

CONTRACT_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', '..', 'src', 'speedboat', 'assets', 'assetContract.json'
)


def load_contract(path=CONTRACT_PATH):
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


# ── scene ────────────────────────────────────────────────────────────────────


def reset_scene(threads=4):
    """Empty scene, metric metres, deterministic Cycles settings for the bake stubs."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = 'METRIC'
    scene.unit_settings.scale_length = 1.0
    scene.unit_settings.length_unit = 'METERS'
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.seed = 0
    scene.cycles.use_animated_seed = False
    scene.cycles.use_denoising = False
    # keep CPU bakes modest: the machine is shared with the game's GPU work
    scene.render.threads_mode = 'FIXED'
    scene.render.threads = max(1, int(threads))
    return scene


def three_to_blender(x, y, z):
    """three.js body frame -> Blender world. Proper rotation (det +1), so winding survives."""
    return (x, -z, y)


# ── hierarchy + extras ───────────────────────────────────────────────────────


def make_empty(name, parent=None, props=None):
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_type = 'PLAIN_AXES'
    bpy.context.scene.collection.objects.link(obj)
    if parent is not None:
        obj.parent = parent
    for k, v in (props or {}).items():
        obj[k] = v
    return obj


def set_props(obj, props):
    for k, v in props.items():
        obj[k] = v


def lod_group_name(contract, level):
    return contract['names']['lodGroup'].replace('{level}', str(level))


def mesh_name(contract, part, level):
    return part + contract['names']['meshSuffix'].replace('{level}', str(level))


def hull_name(contract, level):
    return contract['names']['hull'].replace('{level}', str(level))


def link_mesh_object(name, mesh, parent, lod_level, extra_props=None):
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.parent = parent
    obj['lodLevel'] = int(lod_level)
    for k, v in (extra_props or {}).items():
        obj[k] = v
    return obj


# ── materials ────────────────────────────────────────────────────────────────


def assert_slot(contract, name):
    if name not in contract['slots']:
        raise ValueError(f'material {name!r} is not a contract slot: {sorted(contract["slots"])}')


def gltf_output_group():
    """The node group the glTF exporter reads the Occlusion socket from."""
    name = 'glTF Material Output'
    group = bpy.data.node_groups.get(name)
    if group is not None:
        return group
    group = bpy.data.node_groups.new(name, 'ShaderNodeTree')
    group.interface.new_socket('Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
    group.nodes.new('NodeGroupInput')
    return group


def principled_material(contract, name, base=(0.8, 0.8, 0.8, 1.0), roughness=0.5, metallic=0.0,
                        coat=0.0, coat_roughness=0.1, transmission=0.0, ior=1.5, alpha=1.0):
    assert_slot(contract, name)
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    # the exporter maps this to doubleSided: only see-through slots render both faces
    mat.use_backface_culling = contract['slots'][name]['alphaMode'] == 'OPAQUE'
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
    bsdf.inputs['Base Color'].default_value = base
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = metallic
    bsdf.inputs['Coat Weight'].default_value = coat
    bsdf.inputs['Coat Roughness'].default_value = coat_roughness
    bsdf.inputs['Transmission Weight'].default_value = transmission
    bsdf.inputs['IOR'].default_value = ior
    bsdf.inputs['Alpha'].default_value = alpha
    return mat, bsdf


def attach_texture_set(mat, bsdf, base_color_img, orm_img, normal_img, alpha_from_base=True):
    """baseColor (RGBA, A = livery mask) + ORM (R occlusion, G roughness, B metal) + tangent normal."""
    nt = mat.node_tree
    tex_base = nt.nodes.new('ShaderNodeTexImage')
    tex_base.image = base_color_img
    nt.links.new(tex_base.outputs['Color'], bsdf.inputs['Base Color'])
    if alpha_from_base:
        # linked so the exporter keeps the channel; the build normalises alphaMode back to the
        # contract's value afterwards (the mask is data, not transparency)
        nt.links.new(tex_base.outputs['Alpha'], bsdf.inputs['Alpha'])

    tex_orm = nt.nodes.new('ShaderNodeTexImage')
    tex_orm.image = orm_img
    sep = nt.nodes.new('ShaderNodeSeparateColor')
    nt.links.new(tex_orm.outputs['Color'], sep.inputs['Color'])
    nt.links.new(sep.outputs['Green'], bsdf.inputs['Roughness'])
    nt.links.new(sep.outputs['Blue'], bsdf.inputs['Metallic'])
    group = nt.nodes.new('ShaderNodeGroup')
    group.node_tree = gltf_output_group()
    nt.links.new(sep.outputs['Red'], group.inputs['Occlusion'])

    tex_n = nt.nodes.new('ShaderNodeTexImage')
    tex_n.image = normal_img
    nmap = nt.nodes.new('ShaderNodeNormalMap')
    nt.links.new(tex_n.outputs['Color'], nmap.inputs['Color'])
    nt.links.new(nmap.outputs['Normal'], bsdf.inputs['Normal'])


# ── geometry helpers ─────────────────────────────────────────────────────────


def triangulate_object(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.triangulate(bm, faces=bm.faces[:], quad_method='BEAUTY', ngon_method='EAR_CLIP')
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


def apply_modifiers(obj):
    bpy.ops.object.select_all(action='DESELECT')
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    for mod in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=mod.name)
    obj.select_set(False)


def curve_to_mesh(curve_obj, name):
    """Evaluated curve -> standalone mesh object (bevel + caps baked in)."""
    deps = bpy.context.evaluated_depsgraph_get()
    ev = curve_obj.evaluated_get(deps)
    mesh = bpy.data.meshes.new_from_object(ev, depsgraph=deps)
    mesh.name = name
    bpy.data.objects.remove(curve_obj, do_unlink=True)
    return mesh


def tri_count(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def decimated_copy(src_obj, name, ratio, parent, lod_level, weld=1e-4):
    """LOD generation for generic parts: copy, collapse-decimate, weld. UVs ride along."""
    mesh = src_obj.data.copy()
    mesh.name = name
    obj = link_mesh_object(name, mesh, parent, lod_level)
    if ratio < 1.0:
        mod = obj.modifiers.new('LODDecimate', 'DECIMATE')
        mod.decimate_type = 'COLLAPSE'
        mod.ratio = ratio
        mod.use_symmetry = True
        mod.symmetry_axis = 'X'
        apply_modifiers(obj)
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=weld)
    bm.to_mesh(obj.data)
    bm.free()
    triangulate_object(obj)
    return obj


def smart_uv(obj, angle_deg=66.0, margin=0.004):
    """UV stub for generated/kitbashed parts. Deterministic for identical input."""
    bpy.ops.object.select_all(action='DESELECT')
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(angle_deg), island_margin=margin)
    bpy.ops.object.mode_set(mode='OBJECT')
    obj.select_set(False)


# ── bake stubs ───────────────────────────────────────────────────────────────


def new_image(name, size, non_color):
    img = bpy.data.images.new(name, width=size, height=size, alpha=True, float_buffer=False)
    img.colorspace_settings.name = 'Non-Color' if non_color else 'sRGB'
    img.generated_color = (0.0, 0.0, 0.0, 1.0)
    return img


def bake_pass(obj, image, bake_type, samples, slot_materials, margin=8):
    """
    Bake one pass of `obj` into `image`. `slot_materials` replaces the object's slots for the
    pass (each gets `image` as its active Image Texture node, which is where Cycles writes).
    """
    scene = bpy.context.scene
    scene.cycles.samples = int(samples)
    originals = [s.material for s in obj.material_slots]
    for i, mat in enumerate(slot_materials):
        nt = mat.node_tree
        node = nt.nodes.get('__bake_target') or nt.nodes.new('ShaderNodeTexImage')
        node.name = '__bake_target'
        node.image = image
        nt.nodes.active = node
        obj.material_slots[i].material = mat
    bpy.ops.object.select_all(action='DESELECT')
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    kwargs = dict(type=bake_type, margin=margin, use_clear=True)
    if bake_type == 'NORMAL':
        kwargs.update(normal_space='TANGENT')
    bpy.ops.object.bake(**kwargs)
    obj.select_set(False)
    for i, mat in enumerate(originals):
        obj.material_slots[i].material = mat


def save_png(image, path):
    image.filepath_raw = path
    image.file_format = 'PNG'
    image.save()


# ── export ───────────────────────────────────────────────────────────────────


def export_glb(path):
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format='GLB',
        export_yup=True,
        export_apply=True,
        export_extras=True,
        export_tangents=True,
        export_normals=True,
        export_texcoords=True,
        export_materials='EXPORT',
        export_image_format='AUTO',
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        use_selection=False,
    )
