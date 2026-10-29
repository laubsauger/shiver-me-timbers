# Proposal for studio-manager: start The Drift's render-farm worker on the studio boxes

**Status: proposed, not applied.** studio-manager's own rules apply: its SPEC changes go through `/ck:spec`, and
nothing is edited in it without the owner's go. Everything below was prepared and tested in a scratch clone.

## Why

The Drift renders on the studio's GPUs through a farm (`docs/drift/RENDER-NODE.md`, "The farm"): the Mac's dashboard
(`scripts/drift-dash.mjs`, :5190) holds a job queue, and each box runs `node scripts/drift-node.mjs worker`, which
pulls jobs, renders them and sends the results back. The worker claims a job only while the GPU is free of others'
work (ComfyUI, sd-webrtc, FluxRT, a game), and never touches their processes.

windows-monster and eeg-msi have no SSH. studio-manager's agent already runs on both, can start and stop manifest
services (`POST /api/session/up|down`) and can update a row's checkout (`/api/session/repo/update`). So the cheapest
way to start a worker there is a studio-manager service row. No one has to sit at the box, and there is nothing new
to install beyond what the GPU check reports missing (below).

## The change (one step once approved)

```sh
cd ../studio-manager
git apply ../shiver-me-timbers/docs/drift/studio-manager-drift-worker.patch
```

`docs/drift/studio-manager-drift-worker.patch` (against studio-manager `4b93916`; `git apply --check` passes) adds:

| file | what |
|---|---|
| `scripts/drift-worker.mjs` (new) | the bootstrap, glue in studio-manager as its CLAUDE.md asks. It clones `https://github.com/laubsauger/shiver-me-timbers` (public) beside the checkout if it is missing. It writes that checkout's `drift-node.json` (gitignored there) with `name` and `farm.hub` from the row's env. Then it runs `node scripts/drift-node.mjs sync` (git pull --ff-only, `npm ci` when the lockfile changed, the asset bundle from the farm hub, the GPU self-test on the first run), and then `node scripts/drift-node.mjs worker` until the agent stops the row. |
| `session.config.json` (windows-monster, `desktop-0kl6e4p`) | a `drift-worker` row |
| `nodes/204-eeg/session.config.json` (eeg-msi) | a `drift-worker` row |

The row on windows-monster (eeg-msi's differs only in `DRIFT_NODE_NAME: "eeg-msi"`):

```json
{
  "name": "drift-worker",
  "cwd": ".",
  "cmd": "node",
  "args": ["scripts/drift-worker.mjs"],
  "env": { "DRIFT_NODE_NAME": "windows-monster", "DRIFT_FARM_HUB": "http://laubs-mbp:5190" },
  "health": { "kind": "proc" },
  "group": 2,
  "enabled": false,
  "repo": "../shiver-me-timbers"
}
```

- **`enabled: false`**: it starts only when an operator starts it on the fleet card. Bulk `up` skips it, so a show day never finds a render on the card it needs.
- **`health: proc`**: healthy while the process lives (no port; schema T103).
- **`repo`** (T123): the card shows the shiver-me-timbers checkout's line, and `repo/update` pulls it. Until the first start has cloned it, the row simply has no repo line.
- **Nothing secret travels.** studio-manager's secrets are made on the box and never travel (V53), so the Mac's farm token could not reach a box this way. The farm hub instead accepts each farm box by its tailnet address, as listed in `scripts/drift-farm-nodes.json`, on the worker's own routes only, claiming only as itself. Tailscale ties that address to the box's device key. Everything else (submitting jobs, reading the queue) still needs the Mac's token (`farm.json`, gitignored).
- **linux-monster** (`nodes/rnatwoofour-linux`) is left out. It has SSH, so a worker there can be started by hand (`node scripts/drift-node.mjs worker`). The same row can be added later.

### Tested in a scratch clone of studio-manager

- Both manifests parse with `SessionManifestSchema` and keep their exact formatting (2-space JSON round trip).
- The tests that read the manifests (session, photobooth, avSharing, loom, depthcam, fleet, fleetServe, update, agentInstall, sessionAgent, contracts, autostart): 12 files, 135 tests pass.
- The full suite passes: 70 files, 604 tests. `tsc --noEmit` passes.
- These ran against a fresh `yarn install --frozen-lockfile`. The checkout's own `node_modules` here predates `smol-toml` and `yaml`, so six test files cannot load there (with or without this patch).

### SPEC (for `/ck:spec`, in its own encoding)

What the SPEC entry would say, in plain words: a `drift-worker` row on windows-monster and 204-eeg runs
`scripts/drift-worker.mjs` (`proc` health, group 2, off by default, `repo ../shiver-me-timbers`). The bootstrap clones
the public shiver-me-timbers if missing, writes its gitignored `drift-node.json` from the row's env, then runs
drift-node `sync` and `worker`. It holds no secrets: the farm hub admits the boxes by tailnet address. A failed step
ends the process with the reason in the row's log.

## After applying

1. Commit and push studio-manager (the owner's go), then on the hub's fleet tab: **update agents**. An agent reads
   its manifest at start, and the update restarts it.
2. On the Mac, the dashboard runs with `--tailnet`, so the boxes can reach `http://laubs-mbp:5190`. The bundle must
   be published there: `node scripts/drift-bundle.mjs` writes `out/drift-bundle/latest-assets.json`.
3. On windows-monster's card: start **drift-worker**. The first start clones (~1 min), runs `npm ci` (~1–2 min),
   fetches the 1.4 GB bundle from the Mac, runs the GPU check (~2 min), then waits for jobs. The row's log shows each
   step. The worker then appears in the Mac dashboard's farm workers as `waiting`.

## What each Windows box must already have

| | how it is known |
|---|---|
| Node 20+ | the agent runs on it |
| git | the agent's own self-update uses it |
| Tailscale | the Mac reaches the agents by their tailnet names |
| NVIDIA driver | the agents' `/api/session/metrics` reads the cards through nvidia-smi |
| **Google Chrome stable** | not exposed by the agent. windows-monster's projector players run Chrome kiosks (studio-manager T97), so it is very likely there. The first sync's GPU check fails with `winget install --id Google.Chrome -e` if not |
| **ffmpeg + ffprobe** (a full build: libx264, prores_ks, ffv1; hevc_nvenc optional) | not exposed by the agent. The GPU check fails with `winget install --id Gyan.FFmpeg -e` if missing. Someone at the box (or over RDP) runs that once |

## Later: the farm's progress on studio-manager's card (an idea, not in the patch)

Today the farm's progress and ETA show on the Mac's drift dashboard. To show them on studio-manager's fleet card as
well, a row could carry a progress source the agent reads, for example:

- **a health dialect**: the worker serves `GET 127.0.0.1:<port>/healthz` with `{ ready, job, frames, framesTotal, fps, etaS }`, and the row turns to `health: { kind: "http", path: "/healthz" }` with a `port`. The hub already normalises engine `/healthz` dialects into `EngineDetail` (`src/fleet/engines.ts`, FluxRT and sd-webrtc). A `drift` dialect would map frames, fps and ETA there, and `dashboard/src` would show them on the row's line. Files: `src/fleet/engines.ts` (the dialect), `src/contracts/fleet.ts` (`EngineDetail` += `progress`), the dashboard's row line, `test/engines.test.ts`.
- or **a feed**: the row's `feed` (T110) carries JSON lines that the agent listens to. Today its `FeedState` is shaped for bt-lever's presses, so it would need a more general form.

The first is the smaller change: the worker would add a tiny HTTP status server, and the row would gain a port.
