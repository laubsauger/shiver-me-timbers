@echo off
rem THE DRIFT'S RENDER-FARM WORKER on this box (shiver-me-timbers: node scripts\drift-node.mjs worker), started hidden
rem at logon by the scheduled task "drift-worker" (via drift-worker.vbs), in this user's own session: headless Chrome
rem gets the real GPU (D3D12) there, which a service or an SSH session may not. It syncs first (git pull, npm ci when
rem the lockfile changed, the asset bundle from the Mac's farm hub, the GPU check when Chrome or the driver changed),
rem then works; when the worker ends it waits a minute and starts over (exit 75, a restart: at once), and a failed
rem sync is retried every 5 min.
rem Output: shiver-me-timbers\out\drift\node\worker-task.log  (node scripts\drift-node.mjs logs -f)
rem Stop it: node scripts\drift-node.mjs status (its pid), then taskkill /PID <pid> /T /F; and schtasks /end /tn drift-worker
cd /d "%USERPROFILE%\shiver-me-timbers"
if not exist out\drift\node mkdir out\drift\node
set "DRIFT_NODE_LOG=%USERPROFILE%\shiver-me-timbers\out\drift\node\worker-task.log"
:again
echo ==== %DATE% %TIME% drift-worker: sync >> "%DRIFT_NODE_LOG%"
node scripts\drift-node.mjs sync >> "%DRIFT_NODE_LOG%" 2>&1
if errorlevel 1 (
  echo ==== %DATE% %TIME% drift-worker: sync did not finish, trying again in 5 min >> "%DRIFT_NODE_LOG%"
  ping -n 301 127.0.0.1 >nul
  goto again
)
echo ==== %DATE% %TIME% drift-worker: working >> "%DRIFT_NODE_LOG%"
node scripts\drift-node.mjs worker >> "%DRIFT_NODE_LOG%" 2>&1
set "CODE=%ERRORLEVEL%"
rem exit 75: a restart the dashboard asked for, or origin/main moved on: sync and start again at once
if "%CODE%"=="75" (
  echo ==== %DATE% %TIME% drift-worker: restart asked for, syncing now >> "%DRIFT_NODE_LOG%"
  goto again
)
echo ==== %DATE% %TIME% drift-worker: the worker ended (exit %CODE%), starting over in 60 s >> "%DRIFT_NODE_LOG%"
ping -n 61 127.0.0.1 >nul
goto again
