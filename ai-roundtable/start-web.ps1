param(
  [switch]$NoBrowser,
  [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
$appRoot = [IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path)).TrimEnd('\')
$dataRoot = Join-Path $appRoot 'data'
$nodeExe = Join-Path $appRoot 'runtime\node.exe'
$stateFile = Join-Path $dataRoot 'launcher-state.json'
$sha = [Security.Cryptography.SHA256]::Create()
try { $instanceId = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($appRoot.ToLowerInvariant()))).Replace('-', '').ToLowerInvariant() }
finally { $sha.Dispose() }
function Test-OwnService([int]$servicePort) {
  try {
    $setup = Invoke-RestMethod -Uri "http://127.0.0.1:$servicePort/api/setup" -TimeoutSec 2 -ErrorAction Stop
    return $setup.instanceId -eq $instanceId
  } catch { return $false }
}
function Test-FreePort([int]$servicePort) {
  $probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $servicePort)
  try { $probe.Start(); return $true } catch { return $false } finally { $probe.Stop() }
}
try {
  if (-not (Test-Path -LiteralPath $nodeExe)) {
    $systemNode = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $systemNode) { throw 'Install Node.js 24 or extract the whole portable ZIP before starting.' }
    $nodeExe = $systemNode.Source
  }
  New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
  $port = 0
  if (Test-Path -LiteralPath $stateFile) {
    try {
      $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
      if ($state.instanceId -eq $instanceId -and $state.port -ge 8765 -and $state.port -le 8864 -and (Test-OwnService ([int]$state.port))) { $port = [int]$state.port }
    } catch {}
  }
  if (-not $port) {
    for ($candidate = 8765; $candidate -le 8864; $candidate++) {
      if (Test-FreePort $candidate) { $port = $candidate; break }
      if (Test-OwnService $candidate) { $port = $candidate; break }
    }
  }
  if (-not $port) { throw 'No available local port was found between 8765 and 8864.' }
  if (-not (Test-OwnService $port)) {
    $environmentNames = @('PORT', 'HOST', 'AI_ROUNDTABLE_DATA_DIR', 'AI_ROUNDTABLE_AUTO_EXIT', 'APP_USER', 'APP_PASSWORD')
    $savedEnvironment = @{}
    foreach ($name in $environmentNames) { $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
    try {
      $env:PORT = [string]$port
      $env:HOST = '127.0.0.1'
      $env:AI_ROUNDTABLE_DATA_DIR = $dataRoot
      $env:AI_ROUNDTABLE_AUTO_EXIT = '1'
      $env:APP_USER = ''
      $env:APP_PASSWORD = ''
      $server = Start-Process -FilePath $nodeExe -ArgumentList 'server.mjs' -WorkingDirectory $appRoot -WindowStyle Hidden -PassThru
    } finally {
      foreach ($name in $environmentNames) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
    }
    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
      if (Test-OwnService $port) { $ready = $true; break }
      if ($server.HasExited) { break }
      Start-Sleep -Milliseconds 250
    }
    if (-not $ready) { throw 'The local server did not start. Keep all files together and try again.' }
  }
  [IO.File]::WriteAllText($stateFile, (@{ instanceId = $instanceId; port = $port } | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
  $url = "http://127.0.0.1:$port"
  Write-Host "Web address: $url" -ForegroundColor Green
  if (-not $NoBrowser) { Start-Process -FilePath $url }
  exit 0
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  if (-not $NoPause) { Read-Host 'Press Enter to close' }
  exit 1
}
