"""
Hero parts build, driven by scripts/blender/parts/manifest.json (called from
scripts/blender/build_pipeline_test.py --parts, which asset-build.mjs passes by default).

  build_lod0()        each manifest part → its module's build(anchors, **args) → Pieces →
                      objects, finished (weld, bevel, weighted normals). They occlude the hull bake.
  bake_and_texture()  per slot: pack UVs at one texel density (tiers), bake data passes, composite
                      wear, attach baseColor/ORM/normal to the slot material.
  assemble_lods()     per part per LOD: join the pieces that survive to that LOD into one node
                      <Part>_LOD<n> (one primitive per slot), collapse-decimate LOD1/2 to the
                      manifest's lodTris, carry animation pivots as extras, enforce the parts
                      triangle budget (fails the build loud).

Animated parts stay identity-transformed (contract): the pivot and axis ride as extras in the body
frame (`animRole`, `pivot`, `axis`), and the runtime re-pivots them.
"""
import importlib
import json
import math
import os
import sys
import time

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import anchors as AN  # noqa: E402
import bake as BK  # noqa: E402
import kit  # noqa: E402

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import sb_conventions as sb  # noqa: E402

SLOT_ORDER = ['M_Carbon', 'M_Metal', 'M_Cockpit', 'M_Perspex']


class HeroParts:
    def __init__(self, hull, manifest_path, contract, mats, lods, args):
        with open(manifest_path, 'r', encoding='utf-8') as f:
            self.manifest = json.load(f)
        self.A = AN.Anchors(hull, self.manifest)
        self.contract = contract
        self.mats = mats
        self.lods = lods
        self.args = args
        self.parts = []  # (spec, pieces, extras)
        self.report = {}
        self.only = set(filter(None, os.environ.get('SB_PARTS_ONLY', '').split(',')))

    # ── LOD0 pieces ─────────────────────────────────────────────────────────
    def build_lod0(self):
        print('[parts] anchors ' + json.dumps(self.A.summary()))
        col = bpy.data.collections.new('HeroPieces')
        bpy.context.scene.collection.children.link(col)
        for spec in self.manifest['parts']:
            if self.only and spec['id'] not in self.only:
                continue
            mod = importlib.import_module(spec['module'])
            res = mod.build(self.A, **spec.get('args', {}))
            pieces, extras = res['pieces'], res.get('extras', {})
            for i, p in enumerate(pieces):
                if p.slot not in SLOT_ORDER:
                    raise SystemExit(f"[parts] {spec['id']}/{p.name}: slot {p.slot} is not a parts slot {SLOT_ORDER}")
                sb.assert_slot(self.contract, p.slot)
                p.name = f"{spec['id']}__{i:03d}_{p.name}"
                ob = kit.make_object(p, col)
                ob.data.materials.append(self.mats[p.slot])
                kit.finish(p)
            self.parts.append((spec, pieces, extras))
            tris = sum(sb.tri_count(p.obj) for p in pieces)
            print(f"[parts] {spec['id']}: {len(pieces)} pieces, LOD0 {tris} tris")
            if os.environ.get('SB_PARTS_DEBUG'):
                for p in sorted(pieces, key=lambda p: -sb.tri_count(p.obj))[:6]:
                    print(f"[parts]    {sb.tri_count(p.obj):6d}  {p.name}")

    def all_pieces(self):
        return [p for _, pieces, _ in self.parts for p in pieces]

    # ── UV + bake + composite ───────────────────────────────────────────────
    def bake_and_texture(self):
        tiers = self.manifest['texelDensity']
        scale = max(0.125, self.args.bake_size / 1024.0)
        work = self.args.work
        density = {}
        for slot in SLOT_ORDER:
            pieces = [p for p in self.all_pieces() if p.slot == slot]
            if not pieces:
                continue
            size = int(self.manifest['slots'][slot]['size'] * scale)
            size = 1 << max(6, int(round(math.log2(size))))
            margin = max(2, size // 512)
            t0 = time.time()
            dens, used = BK.pack_slot(pieces, tiers, margin_px=margin * 2, size=size)
            print(f'[parts] {slot}: pack {time.time() - t0:.1f}s')
            density[slot] = {'size': size, 'pxPerM': dens, 'uvUsed': used}
            print(f'[parts] {slot}: {len(pieces)} pieces, atlas {size}², UV used {used:.0%}, px/m {dens}')
            data, id_of = BK.bake_slot(slot, pieces, size, self.args.ao_samples, margin)
            t0 = time.time()
            base, orm, normal, stats = BK.composite(slot, data, id_of, pieces, size)
            print(f'[parts] {slot}: composite {time.time() - t0:.1f}s')
            del data
            print(f'[parts] {slot}: composite {stats}')
            tag = slot[2:].lower()
            sc = self.manifest['slots'][slot]
            img_b = BK.save_rgba(f'parts_{tag}_baseColor', BK.downsample(base, sc.get('baseScale', 1.0)), work, non_color=False)
            img_o = BK.save_rgba(f'parts_{tag}_orm', BK.downsample(orm, sc.get('ormScale', 1.0)), work, non_color=True)
            img_n = BK.save_rgba(f'parts_{tag}_normal', normal, work, non_color=True)
            mat = self.mats[slot]
            bsdf = mat.node_tree.nodes['Principled BSDF']
            sb.attach_texture_set(mat, bsdf, img_b, img_o, img_n, alpha_from_base=slot in ('M_Carbon', 'M_Perspex'))
        self.report['texelDensity'] = density

    # ── LOD nodes ───────────────────────────────────────────────────────────
    def _join(self, name, objs, parent, lod):
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

    def assemble_lods(self):
        """Per part per LOD: join the surviving pieces and decimate to lodTris; then join the parts that
        share a manifest `nodes` name into one node (one primitive per slot) — the draw budget."""
        levels = len(self.lods)
        totals = [0] * levels
        table = {}
        groups = [dict() for _ in range(levels)]  # node name → [(object, extras)]
        for spec, pieces, extras in self.parts:
            row = []
            for lod in range(levels):
                keep = [p.obj for p in pieces if p.max_lod >= lod]
                # lodTris[lod] for lod > 0: target tris, or null = the part drops out at that LOD
                target = (spec.get('lodTris') or [None] * levels)[lod] if lod > 0 else None
                if not keep or (lod > 0 and target is None):
                    row.append(0)
                    continue
                ob = self._join(f"__part_{spec['id']}_{lod}", keep, self.lods[lod], lod)
                tris = sb.tri_count(ob)
                if lod > 0 and target and tris > target:
                    m = ob.modifiers.new('LOD', 'DECIMATE')
                    m.decimate_type = 'COLLAPSE'
                    m.ratio = max(0.01, target / tris)
                    m.use_collapse_triangulate = True
                    sb.apply_modifiers(ob)
                    ob.data.set_sharp_from_angle(angle=math.radians(45))
                sb.triangulate_object(ob) if lod > 0 else _triangulate_keep_normals(ob)
                t = sb.tri_count(ob)
                row.append(t)
                totals[lod] += t
                node = (spec.get('nodes') or [spec['id']] * levels)[lod] or spec['id']
                groups[lod].setdefault(node, []).append((ob, extras if node == spec['id'] else {}))
            table[spec['id']] = row
        group_extras = self.manifest.get('nodeGroups', {})
        drives_src = {}
        for spec, _, extras in self.parts:
            if spec['id'] == 'Outboard_C':
                drives_src = {'trimPivot': extras['trimPivot'], 'trimAxis': extras['trimAxis'],
                              'steerPivot': extras['steerPivot'], 'steerAxis': extras['steerAxis']}
        self.report['nodes'] = []
        for lod in range(levels):
            for node, members in groups[lod].items():
                objs = [o for o, _ in members]
                merged = self._join(sb.mesh_name(self.contract, node, lod), objs, self.lods[lod], lod)
                for o in objs:
                    if o.name in bpy.data.objects:
                        bpy.data.objects.remove(o, do_unlink=True)
                for _, ex in members:
                    for k, v in ex.items():
                        merged[k] = v
                for k, v in (group_extras.get(node) or {}).items():
                    merged[k] = v
                if node == 'Drives':
                    for k, v in drives_src.items():  # the three tilt tubes are colinear: one trim axis
                        merged[k] = v
                if len(members) > 1:
                    merged['mergedParts'] = len(members)
                self.report['nodes'].append((lod, merged.name, len(merged.data.materials)))
        for p in self.all_pieces():
            bpy.data.objects.remove(p.obj, do_unlink=True)
        col = bpy.data.collections.get('HeroPieces')
        if col:
            bpy.data.collections.remove(col)
        self.report['tris'] = table
        self.report['totals'] = totals
        for k, row in table.items():
            print(f'[parts] tris {k:14s} ' + ' / '.join(str(v) for v in row))
        print('[parts] tris TOTAL          ' + ' / '.join(str(v) for v in totals))
        budget = self.manifest['budget']['partsTris']
        over = [f'LOD{i} {totals[i]} > {budget[i]}' for i in range(min(levels, len(budget))) if totals[i] > budget[i]]
        if over and not self.only:
            raise SystemExit('[parts] parts triangle budget exceeded: ' + ', '.join(over))

    def root_extras(self):
        return {
            'partsVersion': int(self.manifest['version']),
            'partsAnchors': json.dumps(self.A.summary()),
            'partsTris': json.dumps(self.report.get('totals')),
            'partsTexelDensity': json.dumps(self.report.get('texelDensity')),
        }


def _triangulate_keep_normals(ob):
    m = ob.modifiers.new('Tri', 'TRIANGULATE')
    m.quad_method = 'BEAUTY'
    m.ngon_method = 'BEAUTY'
    m.keep_custom_normals = True
    sb.apply_modifiers(ob)
