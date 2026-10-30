' The Drift's render-farm worker, started by the scheduled task "drift-worker" at logon: drift-worker.cmd with no
' window at all (0 = hidden; this box drives projectors and kiosks, where a console window must never appear)
Set sh = CreateObject("WScript.Shell")
sh.Run "cmd.exe /c """ & sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\drift-worker.cmd""", 0, True
