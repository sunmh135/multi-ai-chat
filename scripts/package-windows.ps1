param(
    [Parameter(Mandatory=$true)][string]$NodeDirectory,
    [string]$Version = '0.1.0'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$') { throw 'Invalid version.' }
$repoRoot = Split-Path -Parent $PSScriptRoot
$nodeRoot = (Resolve-Path -LiteralPath $NodeDirectory).Path
foreach ($name in @('node.exe', 'LICENSE')) { if (-not (Test-Path -LiteralPath (Join-Path $nodeRoot $name))) { throw "NodeDirectory must contain $name" } }
$dist = Join-Path $repoRoot 'dist'
New-Item -ItemType Directory -Path $dist -Force | Out-Null
$zipPath = Join-Path $dist "多AI聊天平台-v$Version-windows-x64.zip"
if (Test-Path -LiteralPath $zipPath) { throw 'Release ZIP already exists; choose another version or move it before rebuilding.' }
$stage = Join-Path $dist ('package-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    & (Join-Path $PSScriptRoot 'build-launcher.ps1') -OutputDirectory $stage | Out-Host
    $app = Join-Path $stage 'ai-roundtable'
    New-Item -ItemType Directory -Path $app | Out-Null
    foreach ($name in @('server.mjs', 'start-web.ps1')) { Copy-Item -LiteralPath (Join-Path $repoRoot "ai-roundtable\$name") -Destination $app }
    Copy-Item -LiteralPath (Join-Path $repoRoot 'ai-roundtable\public') -Destination (Join-Path $app 'public') -Recurse
    New-Item -ItemType Directory -Path (Join-Path $app 'runtime'), (Join-Path $app 'data') | Out-Null
    foreach ($name in @('node.exe', 'LICENSE')) { Copy-Item -LiteralPath (Join-Path $nodeRoot $name) -Destination (Join-Path $app 'runtime') }
    foreach ($name in @('LICENSE', 'THIRD_PARTY_NOTICES.md')) { Copy-Item -LiteralPath (Join-Path $repoRoot $name) -Destination $app }
    Copy-Item -LiteralPath (Join-Path $repoRoot 'docs\使用说明-分享版.txt') -Destination (Join-Path $app '使用说明.txt')
    $zip = [IO.Compression.ZipFile]::Open($zipPath, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in (Get-ChildItem -LiteralPath $stage -Recurse -File)) {
            $relative = $file.FullName.Substring($stage.Length + 1).Replace('\', '/')
            if ($relative -match '(?i)(APIkey\.txt|keys\.json|connections\.json|\.env|资料归档\.zip)$|^ai-roundtable/data/.+') { throw 'Private runtime files must not be packaged.' }
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $relative, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
        $zip.CreateEntry('ai-roundtable/data/') | Out-Null
    } finally { $zip.Dispose() }
    $hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText(($zipPath + '.sha256'), "$hash  $([IO.Path]::GetFileName($zipPath))`n", [Text.UTF8Encoding]::new($false))
    Write-Output $zipPath
} finally {
    $resolvedStage = [IO.Path]::GetFullPath($stage)
    $resolvedDist = [IO.Path]::GetFullPath($dist)
    if ((Split-Path -Parent $resolvedStage) -ne $resolvedDist -or (Split-Path -Leaf $resolvedStage) -notmatch '^package-[a-f0-9]{32}$') { throw 'Refusing to remove an unexpected staging path.' }
    if (Test-Path -LiteralPath $resolvedStage) {
        if ((Get-Item -LiteralPath $resolvedStage).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing to remove a linked staging directory.' }
        Remove-Item -LiteralPath $resolvedStage -Recurse -Force
    }
}
