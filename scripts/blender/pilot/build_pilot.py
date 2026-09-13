"""
Speedboat pilot build, headless Blender entry point (called by scripts/pilot-build.mjs).

  Blender -b --factory-startup --python-exit-code 1 -P scripts/blender/pilot/build_pilot.py -- \
      --work <dir> --out <raw.glb> [--stages body,...] [--threads 4] [--bake-size 2048] [--write-lock]

Stages run in order; each one saves <work>/stage_<name>.blend so a later stage can be re-run alone
with --stages <name> (the dev loop). A full build always runs every stage from the MPFB human up.
"""
import argparse
import os
import sys
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import common as C  # noqa: E402

STAGES = ['body', 'fit', 'rig', 'hair', 'texture', 'anim', 'lod', 'export']


def parse():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument('--work', required=True)
    p.add_argument('--out', default=None)
    p.add_argument('--stages', default=','.join(STAGES))
    p.add_argument('--threads', type=int, default=4)
    p.add_argument('--bake-size', type=int, default=2048)
    p.add_argument('--samples', type=int, default=16)
    p.add_argument('--write-lock', action='store_true')
    return p.parse_args(argv)


def main():
    a = parse()
    cfg = C.load_config()
    stages = [s for s in a.stages.split(',') if s]
    for s in stages:
        if s not in STAGES:
            raise SystemExit(f'[pilot] unknown stage {s} (have {STAGES})')
    os.makedirs(a.work, exist_ok=True)
    for s in STAGES:
        if s not in stages:
            continue
        t0 = time.time()
        print(f'\n[pilot] ── stage {s} ──')
        if s == 'body':
            import body
            body.run(cfg, a.work, write_lock=a.write_lock)
        elif s == 'fit':
            import fit
            fit.run(cfg, a.work, a)
        elif s == 'hair':
            import hair
            hair.run(cfg, a.work, a)
        elif s == 'texture':
            import texture
            texture.run(cfg, a.work, a)
        elif s == 'rig':
            import rig
            rig.run(cfg, a.work, a)
        elif s == 'anim':
            import anim
            anim.run(cfg, a.work, a)
        elif s == 'lod':
            import lod
            lod.run(cfg, a.work, a)
        elif s == 'export':
            import export
            if not a.out:
                raise SystemExit('[pilot] --out is required for the export stage')
            export.run(cfg, a.work, a)
        print(f'[pilot] stage {s} done in {time.time() - t0:.1f} s')


if __name__ == '__main__':
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        sys.exit(1)
