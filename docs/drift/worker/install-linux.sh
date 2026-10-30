#!/bin/sh
# The Drift's render-farm worker on a Linux box: a systemd user service (docs/drift/RENDER-NODE.md, "The farm").
# Run as the render user, after the checkout is synced once; needs lingering (loginctl show-user $USER -p Linger:
# yes) so it runs without a login, and Node 24 in ~/.local/node24 (the unit puts it first on PATH).
#   sh ~/shiver-me-timbers/docs/drift/worker/install-linux.sh
set -e
mkdir -p ~/.config/systemd/user
cp "$(dirname "$0")/drift-worker.service" ~/.config/systemd/user/drift-worker.service
systemctl --user daemon-reload
systemctl --user enable --now drift-worker.service
systemctl --user --no-pager status drift-worker.service | head -5
echo "log: ~/shiver-me-timbers/out/drift/node/worker-service.log"
