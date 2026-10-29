#!/usr/bin/env bash
# The Drift render node, one command (Linux; docs/drift/RENDER-NODE.md): checks the prerequisites, installs the
# repo's npm packages, verifies the unpacked data bundles and runs the GPU self-test. It changes nothing on the system:
# whatever is missing is printed with the command that installs it, for you to run.
#
#   bash scripts/drift-node-setup.sh [--skip-npm] [--quick]      (--quick: bundle sizes only, no sha256)
set -u
cd "$(dirname "$0")/.." || exit 1
skip_npm=0; quick=""
for a in "$@"; do
  case "$a" in
    --skip-npm) skip_npm=1 ;;
    --quick) quick="--quick" ;;
  esac
done

missing=0
need() { # need <command> <what> <how to install>
  if command -v "$1" >/dev/null 2>&1; then
    printf '  ok       %-14s %s\n' "$1" "$($1 --version 2>/dev/null | head -n1)"
  else
    printf '  MISSING  %-14s %s\n           install: %s\n' "$1" "$2" "$3"; missing=1
  fi
}

echo "== prerequisites"
need git "git" "sudo apt install git"
need node "Node 24" "nvm install 24   (https://github.com/nvm-sh/nvm)"
need npm "npm (comes with Node)" "nvm install 24"
need ffmpeg "ffmpeg (libx264, prores_ks, ffv1; hevc_nvenc optional)" "sudo apt install ffmpeg   (or a BtbN linux64-gpl build on PATH)"
need ffprobe "ffprobe (ships with ffmpeg)" "sudo apt install ffmpeg"
if [ -x /opt/google/chrome/chrome ]; then
  printf '  ok       %-14s %s\n' "chrome" "$(/opt/google/chrome/chrome --version 2>/dev/null)"
else
  printf '  MISSING  %-14s %s\n           install: %s\n' "chrome" "Google Chrome stable at /opt/google/chrome" \
    "curl -fLO https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && sudo apt install -y ./google-chrome-stable_current_amd64.deb"
  missing=1
fi
if command -v nvidia-smi >/dev/null 2>&1; then
  printf '  ok       %-14s %s\n' "nvidia-smi" "$(nvidia-smi --query-gpu=name,driver_version --format=csv,noheader | head -n1)"
else
  printf '  MISSING  %-14s %s\n           install: %s\n' "nvidia-smi" "the NVIDIA driver" "sudo ubuntu-drivers install, then reboot"; missing=1
fi
command -v vulkaninfo >/dev/null 2>&1 || echo "  note     vulkaninfo not installed (diagnostics only): sudo apt install vulkan-tools"
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -lt 20 ] && { echo "  MISSING  Node 20+ (found $(node -v)): nvm install 24"; missing=1; }
  [ "$major" -ne 24 ] && [ "$major" -ge 20 ] && echo "  note     Node $(node -v): the Mac renders on 24.x"
fi
if [ "$missing" -ne 0 ]; then
  echo; echo "FAIL: install what is MISSING above, open a new shell, run this again."; exit 1
fi

if [ "$skip_npm" -eq 0 ]; then
  echo; echo "== npm ci"
  npm ci || { echo "FAIL: npm ci"; exit 1; }
fi

echo; echo "== data bundles"
if ls out/drift-bundle/manifest-*.json >/dev/null 2>&1 || [ -f ../drift-narrative/.drift-bundle-manifest.json ]; then
  node scripts/drift-bundle.mjs --verify $quick || { echo "FAIL: a bundle does not match its manifest: unpack it again (RENDER-NODE.md §3)"; exit 1; }
else
  echo "  no bundle unpacked yet: node scripts/drift-node.mjs sync fetches it (drift-node.json names the source), or in the repo root:"
  echo "    tar -xzf /path/to/drift-assets-<date>.tar.gz"
  echo "    tar -xzf /path/to/drift-refs-<date>.tar.gz -C .."
  echo "FAIL: the renderer needs the asset bundle"; exit 1
fi

echo; echo "== GPU self-test"
node scripts/drift-gpu-check.mjs || { echo; echo "FAIL: see the fixes above (RENDER-NODE.md §4)"; exit 1; }

echo
echo "READY. From here on, one command pulls and renders: node scripts/drift-node.mjs render smoke   (RENDER-NODE.md)"
