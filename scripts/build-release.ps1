[CmdletBinding()]
param([string]$OutputDirectory = 'dist')
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$outputPath = [IO.Path]::GetFullPath((Join-Path $repoRoot $OutputDirectory))
if (-not $outputPath.StartsWith($repoRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Build output must be inside this repository.' }
$manifest = Get-Content -LiteralPath (Join-Path $repoRoot 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$files = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'release-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$manifest.version

function Write-Sha256File([string]$InputPath) {
    $stream = [IO.File]::OpenRead($InputPath)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose(); $stream.Dispose() }
    $fileName = Split-Path -Leaf $InputPath
    [IO.File]::WriteAllText($InputPath + '.sha256', "$hash  $fileName`n", [Text.UTF8Encoding]::new($false))
    Write-Output "Created: $fileName ($hash)"
}
function Copy-ReleaseFiles([string]$SourceRoot, [string]$DestinationRoot, [string[]]$FileList) {
    foreach ($file in $FileList) {
        $source = [IO.Path]::GetFullPath((Join-Path $SourceRoot $file))
        if (-not $source.StartsWith([IO.Path]::GetFullPath($SourceRoot) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Release path escaped its source root.' }
        $destination = Join-Path $DestinationRoot $file
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $destination
    }
}
& node (Join-Path $PSScriptRoot 'check-release.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Release validation failed.' }
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
$tempRoot = Join-Path $outputPath ('.rpig-build-' + [guid]::NewGuid().ToString('N'))
$extensionRoot = Join-Path $tempRoot 'rp-cinematic-imagegen'
$localRoot = Join-Path $tempRoot 'rp-cinematic-local-scene-llm'
try {
    Copy-ReleaseFiles $repoRoot $extensionRoot $files.extensionFiles
    Copy-ReleaseFiles (Join-Path $repoRoot 'tools\local-scene-llm') $localRoot $files.localServiceFiles
    $extensionZip = Join-Path $outputPath "rp-cinematic-imagegen-v$version.zip"
    $localZip = Join-Path $outputPath "rp-cinematic-local-scene-llm-v$version.zip"
    Compress-Archive -LiteralPath $extensionRoot -DestinationPath $extensionZip -CompressionLevel Optimal -Force
    Compress-Archive -LiteralPath $localRoot -DestinationPath $localZip -CompressionLevel Optimal -Force
    # Verify actual compressed contents by extracting the newly produced ZIPs.
    $verification = Join-Path $tempRoot 'verify'
    Expand-Archive -LiteralPath $extensionZip -DestinationPath (Join-Path $verification 'extension')
    Expand-Archive -LiteralPath $localZip -DestinationPath (Join-Path $verification 'local')
    & node (Join-Path $PSScriptRoot 'check-artifacts.mjs') (Join-Path $verification 'extension\rp-cinematic-imagegen') (Join-Path $verification 'local\rp-cinematic-local-scene-llm')
    if ($LASTEXITCODE -ne 0) { throw 'Extracted ZIP validation failed.' }
    $installer = Join-Path $outputPath "rp-cinematic-imagegen-tavern-helper-installer-v$version.json"
    Copy-Item -LiteralPath (Join-Path $repoRoot 'installers\rp-cinematic-imagegen-tavern-helper-installer.json') -Destination $installer -Force
    Write-Sha256File $extensionZip
    Write-Sha256File $localZip
    Write-Sha256File $installer
}
finally {
    $resolved = [IO.Path]::GetFullPath($tempRoot)
    if ($resolved.StartsWith($outputPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolved).StartsWith('.rpig-build-')) {
        Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
    }
}
