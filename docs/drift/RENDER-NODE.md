# The Drift: render nodes (Windows, Linux)

The studio's other machines (an RTX 5090 laptop and an RTX 4090 desktop on Windows, an RTX 4090 on Linux) render The
Drift with the renderer the Mac uses (`scripts/drift-render.mjs`: headless Google Chrome on the GPU, frames piped to
ffmpeg). **One command**, in the repo root, on any of them:

```sh
node scripts/drift-node.mjs render preview-2k      # pull the current state, then render the whole show at 2048²
```

It **syncs** first: `git pull --ff-only`, `npm ci` when the lockfile changed, the asset bundle from the Mac when it
changed (over SSH on the tailnet), the GPU self-test when Chrome or the driver changed. Then it renders the preset
through the resumable render queue (§6). After a stop, the same command again goes on where it was.

| | `node scripts/drift-node.mjs …` |
|---|---|
| render the current state | `render <preset>`: `smoke` (minutes: the whole chain), `preview-2k` (the show, x264 .mp4), `master-4k` (ProRes 4444), `master-8k` (12-bit FFV1 chunks, for the Mac to make ProRes 4444 of). The presets: `scripts/drift-node-presets.jsonc` |
| … in the background | add `--detach`: a closed terminal or SSH session kills nothing; `logs -f` follows it |
| … a queue of your own | `render my-queue.jsonc` (a queue file, §6; `"to": "end"` is the show's end) |
| … what is here, no pull | add `--no-sync` |
| … with other settings | `--set ss=1` · `--set msaa=0` · `--set blur=8` · `--set from=300,to=330` · `--only <job>` |
| only pull | `sync` (`--dry-run`: say what it would do, change nothing) |
| where it stands | `status` (commit, bundle, GPU check, the job, its frames and ETA) · `logs -f` |
| farm work out (on the Mac) | `node scripts/drift-slot.mjs --farm auto -- <command>` ("The farm", below); a box takes jobs with `worker` |
| watch every machine | the studio dashboard on the Mac, `node scripts/drift-dash.mjs --tailnet` (http://<mac>:5190): each node's state, GPU, job, frames and ETA, from a heartbeat the command sends every 5 s. `dash` runs a dashboard on the node itself |

**Publishing the current state, on the Mac:** commit and push the code (a node renders what is pushed: nothing
uncommitted, no local commit), then

```sh
node scripts/drift-bundle.mjs     # the asset bundle and its latest-assets.json in out/drift-bundle/, about a minute
```

That is all: the nodes pull `out/drift-bundle/` straight from the Mac, so there is no copy step. A bundle rebuilt
without new assets costs a node nothing: `latest-assets.json` carries an id of the files in it, and a node copies the
1.4 GB only when that id is not the one of the files it has unpacked. The Mac must be awake and on the tailnet while
a node syncs; if it is not, the sync stops with that said, and `--no-sync` renders what the node has.

**The first time on a machine:** the prerequisites (§1), SSH to the Mac (§2), then

```sh
git clone https://github.com/laubsauger/shiver-me-timbers.git
cd shiver-me-timbers
# drift-node.json in the repo root, this machine's own (gitignored):
#   { "bundle": "flo@<mac-tailnet-name>:/Users/flo/work/code/shiver-me-timbers/out/drift-bundle" }
node scripts/drift-node.mjs render smoke
```

Without a `drift-node.json` the command prints what to put in it, with Windows and Linux examples. The other keys:
`"dashboard"` (default: the bundle's host on :5190), `"name"` (this machine on the dashboard; default its hostname),
`"renders"` (where preset renders go, default `out/drift/renders`; an 8K master needs terabytes: point it at a big
disk). `DRIFT_BUNDLE_SRC`, `DRIFT_DASHBOARD`, `DRIFT_NODE_NAME` override them for one shell.

**The repo is public** (GitHub lists laubsauger/shiver-me-timbers as public, so the https clone needs no account).
That is why the bundle's source is named only in the gitignored `drift-node.json`, and why **the asset bundle never
goes anywhere public**: it holds BlenderKit models that may not be passed on ([Licences](#licences)). Its source is
the Mac itself, or a folder only you can open: not a shared link, not a public share, never git.

### What `sync` does, and what it refuses

1. **Nothing is rendering here** (drift-render's lock, the render slots, a queue, a background run): code or assets
   changed under a render would change its frames mid-job.
2. **`git pull --ff-only`** on the current branch. Refused, with the reason, when a tracked file has local changes,
   the branch has no upstream, or it cannot fast-forward. Nothing is ever reset, stashed or merged: a node's local
   edits are yours to commit or set aside.
3. **`npm ci`** only when `package-lock.json` is not the one of the last sync (its sha256 in
   `out/drift/node-state.json`) or `node_modules` lacks Playwright or Vite.
4. **The asset bundle**: the source's `latest-assets.json` first (a few hundred bytes, `ssh … cat`), then only if it
   names other files: `scp` of the `.tar.gz` into `out/drift-bundle/`, its sha256 checked, `tar -xzf` (Windows'
   own tar.exe), `drift-bundle.mjs --verify --quick`. The previous tarball is deleted; the current one stays, so a
   broken unpack is redone without a copy. A bundle that is current is still checked by size, which finds an unpack
   that was cut short.
5. **The GPU self-test** (§4) on the first sync, when Chrome's version or the driver changed, or when the last one
   failed (`--gpu-check` runs it anyway). It also gives the show's length for `"to": "end"`; at a commit it has not
   seen, `render` asks the page once (a headless boot in a render slot), cached per commit; `--length <s>` skips that.

**A preset's output** goes to `<renders>/<commit>-<bundle id>/<job>…`, one folder per state of the code and the
data: "render our current state" never reuses a chunk of an older one, and the same command resumes the same state.
To finish an older state's master after the Mac has moved on, render it with `--no-sync` before syncing.

**A run in the background** (`--detach`) has its output in `out/drift/node/<date>-<what>.log`; `status` and
`logs -f` find it. Ctrl-C does not reach it: Linux `kill -INT <pid>` (the queue stops its render cleanly), Windows
`taskkill /PID <pid> /T /F` (the chunk in progress is lost, finished chunks stay); `status` prints the pid.

**The parts:** `scripts/drift-node.mjs` (the command), `scripts/drift-node-lib.mjs` (config, bundle, jobs,
heartbeat; tests/driftNode.test.ts), `scripts/drift-node-presets.jsonc`. Under it, the scripts below, each usable on
its own: `drift-bundle.mjs`, `drift-gpu-check.mjs`, `drift-queue.mjs`, `drift-render.mjs`, `drift-slot.mjs`.
`scripts/drift-node-setup.sh` (Linux) and `scripts/drift-node-setup.ps1` (Windows) check the prerequisites and
print what is missing; they install nothing.

### Shared machines: the render yields

The studio's 4090s and the 5090 laptop also run ComfyUI, sd-webrtc, FluxRT, games (the user, 2026-10-29: "we're not
assuming that we are always going to be the only users of these machines"). Before **every chunk** (and before the
GPU check) the queue reads the NVIDIA card (`nvidia-smi -q -x`: every process on it, graphics and compute) and
**waits while someone else holds it**, re-checking every 30 s. It never stops, kills or touches their processes, and a
chunk already rendering is not stopped. `status` and the dashboard show the wait: state `waiting-foreign`, who, and
how much (`ComfyUI 18.0 GB`). `--force` renders anyway.

Ours vs theirs: a process is ours when it or a parent is one of our scripts (drift-render's Chrome and its GPU
process, cine-sink's ffmpeg), or a Chrome on Playwright's throwaway profile. The desktop (dwm, Xorg) is never waited
for. On Windows, where the driver gives nvidia-smi no per-process memory, the numbers come from Windows' GPU counters
(the way studio-manager's agent reads its services' VRAM).

The policy, per machine, in `drift-node.json` (each key optional; the defaults are chosen to yield readily, not
measured on these machines):

```jsonc
"yield": {
  "foreignVramGB": 4,   // GB others may hold before we wait (an idle desktop + browser: 1–2.5; a loaded model: 4–20)
  "foreignUtil": 30,    // % GPU load by others, while nothing of ours runs, before we wait (a generating ComfyUI: 90+)
  "needVramGB": 20,     // GB free one lane needs; default 22 at 8192², 10 below (the Mac's measurements)
  "recheckS": 30        // s between checks while waiting
}
```

The code: `scripts/drift-share.mjs` (tests/driftShare.test.ts).

### The farm: the boxes take our daily work

The boxes are also a render farm for everyday work: stills, review clips, single frames (the user, 2026-10-29: "make
sure that these machines get fat work … so we have to wait less"). It is a pull model, so nothing listens on the
boxes and no SSH is needed (the Windows boxes have none).

- **The hub** is this Mac's dashboard, `node scripts/drift-dash.mjs --tailnet` (`/farm/…` on :5190; code in
  `scripts/drift-farm.mjs`). The queue lives in `out/drift/farm/`. Its token is in `farm.json`, written on the first
  start. That file is gitignored, and the dashboard refuses to write or use a `farm.json` that git would commit.
- **A worker** on each box: `node scripts/drift-node.mjs worker`. Its `drift-node.json` needs
  `{ "name": "windows-monster", "farm": { "hub": "http://laubs-mbp:5190" } }`. The three machines of
  `scripts/drift-farm-nodes.json` need no token: the hub knows them by their tailnet address, and only for their own
  work. The worker takes a job only while the GPU is free of others' work and the box is on mains power. On the
  Windows boxes, studio-manager can start it as a service (`docs/drift/studio-manager-proposal.md`).
- **Submitting** (on the Mac, as an agent would):
  `node scripts/drift-slot.mjs --farm auto -- node scripts/drift-review-stills.mjs shots.json --out out/drift/x`.
  The remote output shows in this terminal, and the files land at the `--out` path. `auto` picks the best free box,
  and falls back to a slot here when none is free or none takes the job in 60 s. `--farm <box>` pins a box.
  `DRIFT_FARM=auto` makes every agent's `drift-slot` use the farm. The render queue's own chunks never do.
- **What travels with a job**: the code as `git diff --binary origin/main`, plus untracked files under
  `src/ scripts/ tests/ public/`. Assets the boxes' bundle lacks go too, up to 200 MB; more fails, and asks for a
  bundle rebuild. Input files outside the code are sent along; paths inside a JSON file are not rewritten. On the box,
  each job gets its own tree in `../smt-farm/<job>`: `git archive` of the base, the patch, the bundle hard-linked,
  `node_modules` linked. The tree is deleted afterwards. Every frame is a pure function of t, so a box draws what this
  Mac would, up to the GPU vendor's arithmetic (the job records which box drew it).
- **Who gets what**: stills go to whoever is free. Clips and long jobs go to the fastest free box; a slower one takes
  them after 2 min of waiting. Speeds start from `drift-farm-nodes.json` (4090 desktops 1.0, the 100 W 5090 laptop
  0.5) and are learned from measured frame rates (`out/drift/farm/speeds.json`).

## 0. What a node renders

The code in git, as pushed, plus the asset bundle.

1. **Commit and push the code** you want rendered. Uncommitted work on the Mac does not reach the node, and neither
   do local commits that are not pushed. New files under `public/` that are not gitignored (e.g.
   `public/models/raft/`, `public/textures/raft/raft_*.webp`, which the page loads) travel by git too: the bundle
   script lists any it sees. The node scripts themselves (`scripts/drift-*.mjs`, `scripts/cine-*.mjs`) are files in
   the repo like any other.
2. **Build the bundle** (`out/drift-bundle/`, gitignored): `node scripts/drift-bundle.mjs`. With `--refs` it also
   bundles the `drift-narrative` folder, and `--renders latest` review renders (§Bundles); the nodes fetch only the
   assets, the others are for copying by hand.
3. Optionally **save reference frames** so the node's GPU test compares its pictures with the Mac's:
   `node scripts/drift-gpu-check.mjs --save-ref`, then commit `scripts/drift-gpu-check.ref.json` with the code.
4. **By hand instead of SSH** (a Google Drive folder, a USB disk, a NAS): copy `drift-assets-<date>.tar.gz` and
   `latest-assets.json` from `out/drift-bundle/` into a folder, and name that folder as the node's `"bundle"`. A
   cloud folder must be private to you, not shared by link ([Licences](#licences)).

## 1. Prerequisites

| | Linux (Ubuntu 24.04) | Windows 11 |
|---|---|---|
| git | `sudo apt install git` | `winget install --id Git.Git -e` |
| Node 24 | [nvm](https://github.com/nvm-sh/nvm): `nvm install 24` | the v24 installer from nodejs.org (or `fnm install 24`) |
| Google Chrome stable | `.deb` from Google (below) | `winget install --id Google.Chrome -e` |
| ffmpeg + ffprobe | `sudo apt install ffmpeg`, or a BtbN `linux64-gpl` static build | `winget install --id Gyan.FFmpeg -e` (the "full" build), or BtbN `win64-gpl` |
| NVIDIA driver | `sudo ubuntu-drivers install` (a current 570/580-series driver), reboot | the current Studio or Game Ready driver |
| Vulkan tools (diagnostics) | `sudo apt install vulkan-tools` | — |
| OpenSSH client (the bundle from the Mac) | `sudo apt install openssh-client` (usually there) | built in (Settings > System > Optional features > OpenSSH Client) |
| Tailscale (the Mac's network) | `curl -fsSL https://tailscale.com/install.sh \| sh` | `winget install --id Tailscale.Tailscale -e` |
| Python | not needed to render | not needed to render |

```sh
# Linux: Google Chrome stable
curl -fLO https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt install -y ./google-chrome-stable_current_amd64.deb
```

- **Node**: the repo has no `.nvmrc`; the Mac renders on Node 24.22. Any 24.x is fine. `winget install
  OpenJS.NodeJS.LTS` installs whatever the current LTS is (Node 26 from late October 2026, untested here), so check
  `node -v`.
- **ffmpeg** must have these encoders (`ffmpeg -encoders`): `libx264` (previews), `prores_ks` (ProRes),
  `ffv1` (the 12-bit master's intermediate), and `hevc_nvenc` for NVENC previews (optional). The GPU test lists
  what is there and test-encodes one NVENC frame.
- **Chrome**: Playwright (installed by `npm ci`) finds Google Chrome at its standard path
  (`/opt/google/chrome/chrome`, `C:\Program Files\Google\Chrome\Application\chrome.exe`). No Playwright browser
  download is needed. Playwright's own Chromium is not used: it fails to compile some of the sea's shaders.
- **Python** is only for rebuilding data (bakes, asset packs), not for rendering. If you need it:
  `python3 -m venv out/drift/data/.venv` and `out/drift/data/.venv/bin/pip install numpy pillow scipy tifffile`
  (the paths the scripts' headers use). The model exports also need Blender.

## 2. Clone, and SSH to the Mac

```sh
git clone https://github.com/laubsauger/shiver-me-timbers.git   # public: no GitHub account needed to clone
cd shiver-me-timbers
```

`node scripts/drift-node.mjs sync` runs `npm ci` itself. (`git@github.com:…` works too, with a GitHub key on the
node; https needs nothing.) On Windows, Git's default `core.autocrlf` is fine: the scripts read CRLF.

### SSH to the Mac (one time)

The nodes pull the asset bundle from the Mac over SSH, inside the studio's tailnet. Once per node:

1. **Tailscale** on the node, logged in to the same tailnet as the Mac (Windows: `winget install --id
   Tailscale.Tailscale -e`; Linux: `curl -fsSL https://tailscale.com/install.sh | sh`, then `sudo tailscale up`).
   `tailscale status` lists the Mac's name: that is `<mac-tailnet-name>` below.
2. **On the Mac, Remote Login on**: System Settings > General > Sharing > Remote Login, allowed for the user `flo`.
   macOS's own SSH server then answers on the tailnet too. (Tailscale SSH, `tailscale up --ssh`, is the other way,
   but on macOS it runs only with the open-source `tailscaled`, not the App Store or standalone app: Remote Login is
   the simple one. Not verified here.)
3. **The node's key on the Mac.** The OpenSSH client is built into Windows 10/11 and Linux.

   ```powershell
   # Windows (PowerShell)
   ssh-keygen -t ed25519                     # Enter for the defaults: no passphrase (or one held by ssh-agent), as the sync cannot ask
   type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh flo@<mac-tailnet-name> "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
   ```

   ```sh
   # Linux
   ssh-keygen -t ed25519 && ssh-copy-id flo@<mac-tailnet-name>
   ```

   Both ask for the Mac's password once (and to accept the Mac's host key: answer `yes`).
4. **Check**: `ssh flo@<mac-tailnet-name> echo ok` prints `ok` without asking for anything. The sync runs ssh with
   `BatchMode`, so it never waits at a prompt: a key that is not set up fails at once with this section's name.

A port other than 22, or another key file: a `Host` entry in the node's `~/.ssh/config` (Windows:
`%USERPROFILE%\.ssh\config`); the sync uses whatever plain `ssh` uses.

## 3. Unpack the bundles

`node scripts/drift-node.mjs sync` does this for the asset bundle (above). By hand, or for the other bundles: both
are `.tar.gz` files; Linux and Windows 10/11 have `tar` built in (PowerShell too).

```sh
# in the repo root
tar -xzf /path/to/drift-assets-20261029.tar.gz          # → public/drift/…
tar -xzf /path/to/drift-refs-20261029.tar.gz -C ..      # → ../drift-narrative/ (beside the repo; the docs point there)
tar -xzf /path/to/drift-renders-20261029.tar.gz         # optional → out/drift/…
node scripts/drift-bundle.mjs --verify                  # every file, size and sha256; --quick: sizes only
```

`--verify` finds the manifests the bundles unpacked (`out/drift-bundle/manifest-*.json`,
`../drift-narrative/.drift-bundle-manifest.json`) and prints PASS or FAIL per bundle. A bundle unpacked somewhere
else: `--verify <manifest> --base <dir>`.

## 4. GPU self-test

```sh
node scripts/drift-gpu-check.mjs
```

It launches exactly the Chrome the renderer launches, asks for the WebGPU adapter the way the page does, prints its
limits and features, then boots `drift.html` and draws one 256² frame at 40 s, 150 s and 600 s through the real
recording path (page → sink → ffmpeg), plus one 16-bit frame. It ends with PASS or FAIL and a fix for each failure.
It takes a minute or two (shader compiles). Its frames land in `out/drift/gpu-check/` to look at. It waits for a
free render slot first (see "Render slots" below; `--no-slot` skips that).

**Is it the 4090?** The lines to read:

- `adapter (as the page asks for it) — nvidia/lovelace …`: the vendor must be `nvidia`. `FALLBACK`,
  `swiftshader`, `llvmpipe` or "Microsoft Basic" mean software rendering and fail the test.
- `chrome://gpu — WebGPU: Hardware accelerated` and a Dawn line such as `… Vulkan backend - NVIDIA GeForce RTX 4090`
  (Linux) or `… D3D12 backend - NVIDIA GeForce RTX 4090` (Windows).
- `adapter choice`: fails when the page would get a different GPU than "high-performance" (a machine with an
  integrated GPU too).
- During a render, `nvidia-smi` lists Chrome's GPU process using memory.

**Chrome flags** (`scripts/drift-chrome.mjs`, shared by the renderer and the test):

| platform | flags | why |
|---|---|---|
| macOS | none | Metal; unchanged from before |
| Linux | `--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan --disable-vulkan-surface` | Chrome enables WebGPU on NVIDIA by itself only under Wayland (Chrome 147+, driver ≥ 535.183.01). Headless is not Wayland, so the blocklist is bypassed and Vulkan requested; no window surface in headless |
| Windows | none | WebGPU runs on D3D12 by default (Chrome 113+) |
| Linux, Windows | Playwright's `--enable-unsafe-swiftshader` removed | a broken GPU path then fails at once instead of rendering in software |

If the test finds no hardware adapter, try the other flag sets: `node scripts/drift-gpu-check.mjs --variants`
probes each and `--variants --save` stores the first that works in `out/drift/node-chrome.json`, which the
renderer then uses. `DRIFT_CHROME_ARGS="--flag --flag"` overrides everything for one shell; `DRIFT_HEADLESS=0`
opens a visible window (needs a logged-in desktop) for drivers that give headless no GPU.

## 5. Smoke render

```sh
node scripts/drift-node.mjs render smoke     # or, without the sync: node scripts/drift-queue.mjs scripts/drift-render-queue.example.jsonc --only smoke,smoke16
```

`smoke` renders 2 s of the beach at 512² in two 1 s chunks and joins them into `smoke.mp4` (60 frames). `smoke16`
renders 1 s at 256² through the 16-bit path into `smoke16.mov` (FFV1). Through `drift-node` they land in
`out/drift/renders/<commit>-<bundle>/`, through the example queue in `out/drift/queue/`. Run the same command again:
every chunk is skipped as done. Open `smoke.mp4` and look at it.

## 6. Queue renders

Copy `scripts/drift-render-queue.example.jsonc` to `render-queue.jsonc` in the repo root (the queue's default
file; commit it if the Mac should see it) and edit the jobs. A job is a name, `from` and `to` in seconds of show
time, `size`, and any of `fps ss blur shutter codec depth lanes chunk channel crf preset out concat extra enabled
msaa`. The GPU test prints the show's length for `to`; through `drift-node.mjs render <file>`, `"to": "end"` is it.

```sh
node scripts/drift-queue.mjs --dry-run      # what would render, what is done
node scripts/drift-queue.mjs                # everything enabled
node scripts/drift-queue.mjs --only film_8k_12bit
```

- **Chunks.** Each job is split into chunks of `chunk` seconds; each chunk is one `drift-render.mjs` run with its
  own file in `<out>/<job>/chunks/`, a `.json` with its settings and commit, and a `.log`. Pick `chunk` so a chunk
  takes about 25 minutes (the first chunk's log line says how fast it went).
- **Resumable.** A chunk is skipped when its file has exactly the right frame count and was rendered with the same
  settings. A failed chunk is retried once, then left; the queue goes on and exits non-zero. Run it again to
  render what is missing. `--decode-check` also decodes each finished chunk.
- **The join.** When all chunks of a job exist they are joined with `ffmpeg -c copy` into `<out>/<job>.<ext>` and
  the frame count is checked. `"concat": false` keeps only the chunks: for 8K masters, where a joined copy would
  double hundreds of GB. A warning says when chunks come from different commits (a seam can show a look change).
- **Render slots.** Every heavy browser job on a machine (a render chunk, the GPU test, review stills and clips)
  runs inside one of the machine's render slots, `scripts/drift-slot.mjs`: at most 2 at once by default, across
  everyone working on the machine. A chunk takes as many slots as it has lanes and waits until they are free; the
  GPU test takes one. `node scripts/drift-slot.mjs --status` shows who holds them. A 4090 node that renders
  nothing else can allow more: `DRIFT_SLOTS=3` (or 4) in the environment of the queue, after checking with
  `nvidia-smi` that the card's 24 GB hold that many pages at the job's size. A job whose `lanes` exceed the slots is
  refused at the start.
- **The machine.** One `drift-render.mjs` per repo at a time (`out/drift/.render.lock`; the queue waits for it
  rather than fail). It refuses to start a chunk on battery (macOS `pmset`, Linux sysfs, Windows' power line status:
  the 5090 laptop must stay plugged in; `--allow-battery` overrides). While it runs it
  asks the OS not to idle-sleep (`systemd-inhibit` on Linux, `SetThreadExecutionState` on Windows,
  `caffeinate` on macOS); set the machine's own sleep to "never" anyway for long jobs. Ctrl-C stops the chunk in
  progress; finished chunks stay.
- **Lanes.** `lanes` is how many Chrome pages render a chunk at once (default 1; at most 2 unless
  `"allowLanes": true`; each lane is one render slot). Start 8K masters with one lane. The faces are 4× MSAA by default (engine-findings §11), and the recommended 8K
  setting is ss 1.25: on the Mac it peaked near 23.5 GB in the page's GPU process, about 11 GB of that the page before
  any master, so it may not fit a 24 GB card (the 4090s and the 5090 laptop have 24 GB). Fall back to ss 1 (about
  2 GB less), or `"msaa": 0` (`--set msaa=0`, drift-render `--msaa 0`): the faces without their MSAA, ~80 B a face
  texel less by engine-findings §11's sum, ~2.5 GB at 8192² and ss 1.25 — at the cost of the foliage's and the
  rigging's edges. Watch `nvidia-smi` during the first chunk before trying two lanes.
- **Where it stands.** While it renders, the queue keeps `out/drift/queue/status.json`: the job, the chunk, the job's
  frames done of its total (chunks from an earlier run count), the rate and the whole job's ETA, the render's newest
  line. `drift-node.mjs status` prints it and the heartbeat sends it to the dashboard.

## Codecs

| `codec` | on macOS | on Linux / Windows | bit depth from the page | for |
|---|---|---|---|---|
| `x264` | libx264, .mp4 | the same | 8 | previews |
| `prores` / `proreshq` | ProRes 422 HQ, VideoToolbox | ProRes 422 HQ, `prores_ks` (CPU) | 8 or 16 | 10-bit masters |
| `prores4444` | ProRes 4444, 12-bit, VideoToolbox | ProRes 4444, `prores_ks`, **10-bit samples** | 8 or 16 | see below |
| `ffv1` | FFV1, lossless 12-bit 4:4:4, .mov | the same | 16 | the 12-bit master's intermediate |
| `hevc10` | — (no NVENC) | NVENC HEVC Main10 4:2:0, .mp4 | 8 or 16 | previews on NVIDIA |

macOS behaviour is unchanged: the same encoder lines as before for `x264` and the ProRes codecs.

### The 12-bit ProRes 4444 master

ffmpeg cannot make a 12-bit ProRes off the Mac. Its software ProRes encoders (`prores_ks`, `prores_aw`) take 10-bit
input only (FFmpeg 9.0.2 lists `yuv422p10le yuv444p10le yuva444p10le`); the 12-bit one is Apple's VideoToolbox.
A `prores4444` render on a node is a real ProRes 4444 file (DaVinci reads it; ffprobe reports `yuv444p12le`, which
is the decoder's format, not the precision), but its samples are 10-bit. That matters here: in
`out/drift/bitdepth_8_10_12_712s.png` the night zenith, contrast stretched ×163, still steps at 10 bits and is
smooth at 12.

So the master goes in two steps:

1. **On the node**, render `"codec": "ffv1", "depth": 16`: FFV1, lossless, 12-bit 4:4:4 in BT.709, which are
   exactly the samples a ProRes 4444 master holds (the same RGB→YUV conversion the Mac's sink does). Intra-only, so
   chunks join without re-encoding, and ffprobe counts its frames.
2. **On the Mac**, copy the job's `chunks/` folder to the same place under the repo and run
   `node scripts/drift-queue.mjs render-queue.jsonc --prores4444 --only <job>`: each FFV1 chunk becomes ProRes 4444
   on VideoToolbox (a change of bit depth, no colour math), checked frame by frame, then joined unless
   `"concat": false`. Delete the FFV1 chunks yourself once the master checks out.

Then verify the master as any master: frame count, and a macOS decode (AVFoundation), because a clean ffmpeg decode
does not prove DaVinci can read it (`docs/drift/PIPELINES.md`, "Verify a master").

Sizes (estimates; check the first chunk): ProRes 4444 at 8192² measured about 28 MiB a frame on the Mac. FFV1
measured 1.33 bytes per pixel on a detailed 2048² test frame, so plan about 130 MB a frame at 8192², about 3 TB for
the whole show at 30 fps, plus about 0.7 TB for the ProRes. Converting chunk by chunk and deleting each FFV1 chunk
after its ProRes checks out keeps the peak lower.

Alternatives measured and not used: 16-bit PNG sequences (3.2 B/px, 2.4× FFV1, slower, and they still need a
conversion for ProRes) and 16-bit TIFF (3.2 B/px). DNxHR 444 in ffmpeg is also 10-bit, no better than `prores_ks`.
If 10 bits are enough for a job (a preview master), `prores4444` on the node goes straight to DaVinci.

### NVENC previews (`hevc10`)

HEVC Main10 on the 4090's encoder: fast, small, 10-bit. HEVC's highest level (6.2) allows 35,651,584 samples a
picture, about 5968² square. 4096² is fine. 8192² encodes (NVENC goes to 8192×8192 on Ada) but is outside every
level and many decoders, likely macOS's, will refuse it: the sink warns. GeForce cards allow 8 NVENC sessions at a
time (NVIDIA's Video Codec SDK 13.0 notes), one per lane. Check a preview in QuickTime on the Mac before trusting it.

## Bundles

| bundle | unpack | contents | size |
|---|---|---|---|
| `drift-assets-<date>.tar.gz` | repo root | every gitignored file under `public/` the page loads: Earth maps, cosmic web, galaxies, flock bake, cloud noise, PBR scans and models (`public/drift/`) | 178 files, 1.58 GB → 1.39 GB gzipped (2026-10-29, 33 s to build) |
| `drift-refs-<date>.tar.gz` | beside the repo (`-C ..`) | `drift-narrative/`: README, treatments, direction per act, production design, review notes, `references/` (images, README with credits, `.sources.tsv`) | 126 files, 70 MB |
| `drift-renders-<date>.tar.gz` | repo root | `--renders latest`: the newest whole-show master, the top-level review stills and `*_review/` folders of `out/drift`; `--renders-include` adds more | 51 files, 3.6 GB (3.5 GB of it the 4K master; measured with `--dry-run`) |

Left out of the assets: Blender, ambientCG and USD source files (`.blend .zip .usdc .mtlx .tres`), and raw
sources whose processed output is in the bundle: the 4K texture sets packed into `public/drift/pbr/packed/`, the
raft scans packed for the film and the game, and the `.gltf` + textures of props, debris and rocks that load as
their own `_prop.glb` / `_lod.glb`. The list is `SOURCE_ONLY` in `scripts/drift-bundle.mjs`;
`--dry-run` prints what is kept and dropped. If the page ever fetches a left-out file, the GPU test on the node
fails with its name. `drift-narrative`'s own `.git` folder is not bundled.

Each bundle carries a manifest (path, bytes, sha256 of every file) as its last entry. Bundles are a snapshot: after
new bakes or exports on the Mac, build and copy a new one (the manifest names the commit it was built at).

### Licences

- **The asset bundle is private.** `public/drift/pbr/blenderkit/` holds BlenderKit models (the palms, wood). They are
  royalty-free for renders, but the models may not be passed on (one palm is CC0, the rest royalty-free). Keep the
  bundle on your own machines: never in git, never on a public share or download link. This repo is public, so
  nothing that names or holds the bundle is committed: `out/drift-bundle/` and the nodes' `drift-node.json` are
  gitignored. The nodes pull it from the Mac over SSH inside the tailnet; a hand copy goes to a folder only you can
  open (a Google Drive folder not shared with anyone, not "anyone with the link").
- The Poly Haven and ambientCG assets are CC0. Instead of the bundle they can be downloaded again:
  `python3 -I scripts/drift-pbr-fetch.py scripts/drift-pbr-assets.json public/drift/pbr`, then the pack and
  export scripts (`scripts/drift-pbr-pack.py`, `drift-raft-pack.py`, `drift-leaf-alpha.py`, and the Blender
  exports `drift-tree-export.py`, `drift-prop-export.py`, `drift-rock-lod.py`). The Earth, cosmic web, galaxy, flock
  and cloud data are rebuilt by `scripts/drift-earth-data.py` (`docs/drift/earth-data.md`), `drift-web-volume.py`,
  `drift-galaxy-atlas.py`, `drift-flock-bake.py`, `drift-cloud-noise.py`. The BlenderKit models can only come
  from the owner's BlenderKit account (`scripts/drift-blenderkit-fetch.py`), so in practice the bundle is the way.
- The references (`drift-narrative/references/`) are mostly Wikimedia Commons (CC BY, CC BY-SA, public domain) and
  NASA (public domain); some ESO/ESA images are CC BY 4.0 and a few sources ask to be contacted before commercial
  use. Each file's credit and licence is in `references/README.md` and `.sources.tsv`: keep them with the images.
  They are reference material, not footage for the dome.
- `drift-narrative` stays out of git (this repo's and any other).

## First run on Linux or Windows: what to check

None of this could be tested on the Mac where the scripts were written. On the first node, check and note:

1. `drift-gpu-check.mjs` passes with the default flags, and the adapter is `nvidia`. If not, which `--variants`
   set works (and tell the Mac so `scripts/drift-chrome.mjs` gets that default).
2. `texture-formats-tier1` is reported (16-bit capture), and the 16-bit test frame matches the 8-bit one.
3. The frames in `out/drift/gpu-check/` look like the Mac's (or the reference comparison passes): a shader that
   builds differently on Vulkan or D3D12 draws wrong frames, not black ones.
4. The limits allow 8192² at ss 2 (`maxTextureDimension2D` 16384+, `maxBufferSize` 512 MiB+).
5. The smoke queue finishes, resumes (a second run skips everything) and joins. Then render one 8K chunk of a few
   seconds and read its log: frames per second, and `nvidia-smi` memory during it.
6. `hevc10`: the test encode passes, and a 4096² preview plays in QuickTime on the Mac.
7. A `prores4444` and an `ffv1` chunk from the node open in DaVinci on the Mac (FFV1 after `--prores4444`).
8. Windows: the queue's keep-awake works (the machine does not sleep through a long job); the render works from a
   normal logged-in session (rendering from a service or over SSH without a desktop session is untested).
9. `drift-node.mjs`: `sync` reaches the Mac over SSH and fetches the bundle once (a second `sync` copies nothing);
   `render smoke --detach` goes on after the terminal is closed, `status` and `logs -f` find it, and the node's card
   appears on the Mac's dashboard. Windows: ssh, scp and tar.exe as the sync calls them, and npm through `shell`.
10. The 5090 laptop: unplugged, the queue refuses the next chunk (the Windows power check is new and untested).
11. Linux: `vulkaninfo --summary` shows the 4090. Reports from 2025 say Ubuntu 22.04's Vulkan loader (1.3.204) is
   too old for drivers that declare Vulkan 1.4; Ubuntu 24.04 is assumed fine.

## Troubleshooting

| symptom | fix |
|---|---|
| sync: `Permission denied (publickey)` / `Host key verification failed` / not reachable | §2 "SSH to the Mac": the node's key in the Mac's `~/.ssh/authorized_keys`; `ssh flo@<mac>` once by hand to accept the host key; Tailscale up on both, the Mac awake, Remote Login on |
| sync: "refused: local changes in N tracked file(s)" | the node's checkout has edits: commit them or set them aside yourself (sync never discards); or `render … --no-sync` |
| sync: "the copy … is not the source's" | the Mac rebuilt the bundle while it copied: run sync again |
| `requestAdapter() returned null` / "requires WebGPU" gate | driver (`nvidia-smi`), Vulkan ICD (`vulkaninfo`), then `drift-gpu-check.mjs --variants --save` |
| adapter is `swiftshader` / `FALLBACK` / not `nvidia` | as above; on a machine with an integrated GPU: Windows Settings > Display > Graphics > Chrome: High performance, or the iGPU off in the BIOS |
| `encoder hevc_nvenc missing` or its test encode fails | a full ffmpeg build; on Linux the driver's `libnvidia-encode-<version>` must match the driver |
| `--codec … needs ffmpeg's prores_ks` | a full ffmpeg build (gyan.dev "full", BtbN "gpl", Ubuntu's `ffmpeg`) |
| assets missing / HTML fallback in the GPU test | unpack the newest asset bundle, `drift-bundle.mjs --verify` |
| `no lane advanced in 180 s` | a hung GPU readback: the queue retries the chunk; if it repeats, fewer lanes or a smaller `chunk` |
| `another render is running` | one render at a time; a stale `out/drift/.render.lock` from a killed run is ignored once its process is gone |
| Chrome "No usable sandbox" (Linux) | Google's `.deb` installs Chrome's sandbox helper; reinstall it rather than running without a sandbox |

## Sources

- Chrome headless WebGPU on NVIDIA Linux: [developer.chrome.com, "Supercharge Web AI model testing"](https://developer.chrome.com/blog/supercharge-web-ai-testing)
  (flags), [gpuweb Implementation Status](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status) (Linux
  Intel default in Chrome 144, NVIDIA on Wayland in 147 with driver 535.183.01+, Windows since 113),
  [Chrome 147–148 WebGPU notes](https://developer.chrome.com/blog/new-in-webgpu-147-148).
- Playwright's default `--enable-unsafe-swiftshader` picking a software adapter: [a 2026 gist on Playwright with
  real-GPU Chrome on Linux](https://gist.github.com/davidar/be59931b655cb4a4c3fb5f064b6f2498) (also read in
  `node_modules/playwright-core`). Dawn's blocklist and old Vulkan loaders:
  [tigerabrodi.blog, WebGPU in headless Chrome on cloud GPUs](https://tigerabrodi.blog/how-to-get-webgpu-in-headless-chrome-on-cloud-gpus).
- `--use-webgpu-power-preference`: Chromium's own web-test configuration; not documented, unverified on current Chrome.
- NVENC on Ada (HEVC 8192×8192, Main10, 4:4:4; 8 GeForce sessions): [NVENC Application Note, SDK 13.0](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-application-note/index.html).
- ffmpeg encoders and pixel formats: `ffmpeg -h encoder=prores_ks` etc. on FFmpeg 9.0.2; sizes and speeds measured
  on the Mac (2026-10-29).
