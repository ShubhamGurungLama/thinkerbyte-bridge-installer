$ErrorActionPreference = 'Stop'

$RepoOwner = $env:TBLAB_REPO_OWNER
if ([string]::IsNullOrWhiteSpace($RepoOwner)) { $RepoOwner = 'ShubhamGurungLama' }
$RepoName = $env:TBLAB_REPO_NAME
if ([string]::IsNullOrWhiteSpace($RepoName)) { $RepoName = 'thinkerbyte-bridge-installer' }
$RepoRef = $env:TBLAB_REPO_REF
if ([string]::IsNullOrWhiteSpace($RepoRef)) { $RepoRef = 'main' }

$ArchiveUrl = "https://github.com/$RepoOwner/$RepoName/archive/refs/heads/$RepoRef.zip"
$BaseDir = Join-Path $HOME '.thinkerbyte'
$BridgeDir = Join-Path $BaseDir 'bridge'
$BinDir = Join-Path $HOME '.thinkerbyte\bin'
$TmpDir = Join-Path $env:TEMP ("tblab-install-" + [System.Guid]::NewGuid().ToString('N'))

New-Item -ItemType Directory -Path $TmpDir -Force | Out-Null
New-Item -ItemType Directory -Path $BaseDir -Force | Out-Null
New-Item -ItemType Directory -Path $BinDir -Force | Out-Null

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js is required. Install Node LTS and re-run this command.'
}

Write-Host '[info] downloading ThinkerByte bridge bundle...'
$zipPath = Join-Path $TmpDir 'bundle.zip'
Invoke-WebRequest -Uri $ArchiveUrl -OutFile $zipPath
Expand-Archive -Path $zipPath -DestinationPath $TmpDir -Force

$srcRoot = Get-ChildItem -Path $TmpDir -Directory | Where-Object { $_.Name -like '*thinkerbyte-bridge-installer*' } | Select-Object -First 1
if (-not $srcRoot) { throw 'Unable to locate extracted installer bundle.' }

if (Test-Path $BridgeDir) { Remove-Item -Path $BridgeDir -Recurse -Force }
New-Item -ItemType Directory -Path $BridgeDir -Force | Out-Null
Copy-Item -Path (Join-Path $srcRoot.FullName 'bridge\*') -Destination $BridgeDir -Recurse -Force

$bridgeCmd = @"
@echo off
node "%USERPROFILE%\.thinkerbyte\bridge\agent\bridge-agent.js" %*
"@
Set-Content -Path (Join-Path $BinDir 'tblab-bridge.cmd') -Value $bridgeCmd -Encoding ASCII

$startCmd = @"
@echo off
set LOGDIR=%USERPROFILE%\.thinkerbyte\bridge\logs
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
start "ThinkerByteBridge" /MIN cmd /c "%USERPROFILE%\.thinkerbyte\bin\tblab-bridge.cmd > "%LOGDIR%\bridge.log" 2>&1"
"@
Set-Content -Path (Join-Path $BinDir 'tblab-bridge-start.cmd') -Value $startCmd -Encoding ASCII

Write-Host '[ok] ThinkerByte Bridge installed.'
Write-Host "[next] Start bridge: $BinDir\tblab-bridge-start.cmd"
Write-Host '[next] Health check: http://127.0.0.1:19777/health'

Remove-Item -Path $TmpDir -Recurse -Force
