"""
Course furniture Blender step (§T.187): one asset per run.

  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python-exit-code 1 \
      -P scripts/blender/course/build_course.py -- --asset course_gate_pole --out raw.glb --work <dir> \
      [--bake-size 1024] [--ao-samples 16] [--threads 4] [--blend scene.blend]

Normally driven by scripts/blender/course/build-course.mjs (checker, KTX2, meshopt, final checker).
"""
import argparse
import importlib
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import course_kit as CK  # noqa: E402

MODULES = {
    'course_gate_pole': 'gate_pole',
    'course_turn_buoy': 'turn_buoy',
    'course_bar_stake': 'bar_stake',
    'course_pylon': 'pylon',
    'course_radio_tower': 'radio_tower',
    'course_roofs': 'roofs',
}


def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument('--asset', required=True, choices=sorted(MODULES))
    p.add_argument('--out', required=True)
    p.add_argument('--work', required=True)
    p.add_argument('--bake-size', type=int, default=1024)
    p.add_argument('--ao-samples', type=int, default=16)
    p.add_argument('--threads', type=int, default=4)
    p.add_argument('--blend')
    return p.parse_args(argv)


def main():
    args = parse_args()
    os.makedirs(args.work, exist_ok=True)
    module = importlib.import_module(MODULES[args.asset])
    CK.build_asset(args.asset, module, args)


main()
