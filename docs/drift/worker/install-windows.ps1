# The Drift's render-farm worker on a Windows box, as the logged-on user (docs/drift/RENDER-NODE.md, "The farm").
# Run in PowerShell AS THAT USER (not elevated), after the checkout is synced once
# (node scripts\drift-node.mjs sync --no-gpu-check, with drift-node.json { "name": "<box>", "farm": { "hub": "http://100.95.243.90:5190" } }).
# It copies drift-worker.cmd/.vbs to the user's home and registers the task "drift-worker": at this user's logon,
# Interactive (headless Chrome gets the GPU only in the user's own session), not elevated, hidden (wscript, no
# window: these boxes drive projectors), no time limit, one instance. Then it starts it now.
#   powershell -NoProfile -ExecutionPolicy Bypass -File "$HOME\shiver-me-timbers\docs\drift\worker\install-windows.ps1"
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Copy-Item (Join-Path $here 'drift-worker.cmd'), (Join-Path $here 'drift-worker.vbs') $HOME -Force
$me = [Security.Principal.WindowsIdentity]::GetCurrent().Name   # (not $env:USERDOMAIN: over SSH it says WORKGROUP)
$a = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$HOME\drift-worker.vbs`"" -WorkingDirectory $HOME
$t = New-ScheduledTaskTrigger -AtLogOn -User $me
$p = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName 'drift-worker' -Action $a -Trigger $t -Principal $p -Settings $s -Description 'The Drift render-farm worker (shiver-me-timbers): hidden, in this user session, at logon' -Force | Out-Null
Enable-ScheduledTask -TaskName 'drift-worker' | Out-Null
Start-ScheduledTask -TaskName 'drift-worker'
$k = Get-ScheduledTask -TaskName 'drift-worker'
"drift-worker: $($k.State), as $($k.Principal.UserId) ($($k.Principal.LogonType), $($k.Principal.RunLevel)). Log: $HOME\shiver-me-timbers\out\drift\node\worker-task.log"
