# The Drift render node, one command (Windows 11; docs/drift/RENDER-NODE.md): checks the prerequisites, installs the
# repo's npm packages, verifies the unpacked data bundles and runs the GPU self-test. It changes nothing on the system:
# whatever is missing is printed with the command that installs it, for you to run.
#
#   powershell -ExecutionPolicy Bypass -File scripts\drift-node-setup.ps1 [-SkipNpm] [-Quick]
param([switch]$SkipNpm, [switch]$Quick)
Set-Location (Join-Path $PSScriptRoot '..')
$missing = $false

function Need($cmd, $what, $how) {
  $c = Get-Command $cmd -ErrorAction SilentlyContinue
  if ($c) {
    $v = (& $cmd --version 2>$null | Select-Object -First 1)
    Write-Host ("  ok       {0,-14} {1}" -f $cmd, $v)
  } else {
    Write-Host ("  MISSING  {0,-14} {1}" -f $cmd, $what)
    Write-Host ("           install: {0}" -f $how)
    $script:missing = $true
  }
}

Write-Host '== prerequisites'
Need git 'git' 'winget install --id Git.Git -e'
Need node 'Node 24' 'the v24 installer from https://nodejs.org (or: winget install Schniz.fnm; fnm install 24)'
Need npm 'npm (comes with Node)' 'install Node 24'
Need ffmpeg 'ffmpeg (libx264, prores_ks, ffv1; hevc_nvenc optional)' 'winget install --id Gyan.FFmpeg -e   (the "full" build), then open a new shell'
Need ffprobe 'ffprobe (ships with ffmpeg)' 'winget install --id Gyan.FFmpeg -e'
$chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($chrome) {
  Write-Host ("  ok       {0,-14} {1}" -f 'chrome', (Get-Item $chrome).VersionInfo.ProductVersion)
} else {
  Write-Host '  MISSING  chrome         Google Chrome stable'
  Write-Host '           install: winget install --id Google.Chrome -e'
  $missing = $true
}
$smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if ($smi) {
  Write-Host ("  ok       {0,-14} {1}" -f 'nvidia-smi', (& nvidia-smi --query-gpu=name,driver_version --format=csv,noheader | Select-Object -First 1))
} else {
  Write-Host '  MISSING  nvidia-smi     the NVIDIA driver'
  Write-Host '           install: the current Studio or Game Ready driver from nvidia.com (or the NVIDIA App)'
  $missing = $true
}
if (Get-Command node -ErrorAction SilentlyContinue) {
  $major = [int](& node -p "process.versions.node.split('.')[0]")
  if ($major -lt 20) { Write-Host "  MISSING  Node 20+ (found $(node -v)): install Node 24"; $missing = $true }
  elseif ($major -ne 24) { Write-Host "  note     Node $(node -v): the Mac renders on 24.x" }
}
if ($missing) { Write-Host ''; Write-Host 'FAIL: install what is MISSING above, open a new shell, run this again.'; exit 1 }

if (-not $SkipNpm) {
  Write-Host ''; Write-Host '== npm ci'
  & npm ci
  if ($LASTEXITCODE -ne 0) { Write-Host 'FAIL: npm ci'; exit 1 }
}

Write-Host ''; Write-Host '== data bundles'
$manifests = @(Get-ChildItem out\drift-bundle\manifest-*.json -ErrorAction SilentlyContinue) + @(Get-Item ..\drift-narrative\.drift-bundle-manifest.json -ErrorAction SilentlyContinue)
if ($manifests.Count -gt 0) {
  if ($Quick) { & node scripts/drift-bundle.mjs --verify --quick } else { & node scripts/drift-bundle.mjs --verify }
  if ($LASTEXITCODE -ne 0) { Write-Host 'FAIL: a bundle does not match its manifest: unpack it again (RENDER-NODE.md section 3)'; exit 1 }
} else {
  Write-Host '  no bundle unpacked yet: node scripts/drift-node.mjs sync fetches it (drift-node.json names the source), or in the repo root:'
  Write-Host '    tar -xzf C:\path\to\drift-assets-<date>.tar.gz'
  Write-Host '    tar -xzf C:\path\to\drift-refs-<date>.tar.gz -C ..'
  Write-Host 'FAIL: the renderer needs the asset bundle'; exit 1
}

Write-Host ''; Write-Host '== GPU self-test'
& node scripts/drift-gpu-check.mjs
if ($LASTEXITCODE -ne 0) { Write-Host ''; Write-Host 'FAIL: see the fixes above (RENDER-NODE.md section 4)'; exit 1 }

Write-Host ''
Write-Host 'READY. From here on, one command pulls and renders: node scripts/drift-node.mjs render smoke   (RENDER-NODE.md)'
