[CmdletBinding()]
param(
    [string]$OutputDirectory = 'dist'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$outputPath = Join-Path $repoRoot $OutputDirectory
$manifest = Get-Content -LiteralPath (Join-Path $repoRoot 'manifest.json') -Raw | ConvertFrom-Json
$version = [string]$manifest.version
$archiveName = "rp-cinematic-imagegen-v$version.zip"
$archivePath = Join-Path $outputPath $archiveName
$checksumPath = "$archivePath.sha256"

& node (Join-Path $PSScriptRoot 'check-release.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Release validation failed. ZIP was not created.' }

New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("rpig-release-" + [guid]::NewGuid().ToString('N'))
$bundleRoot = Join-Path $tempRoot 'rp-cinematic-imagegen'

try {
    New-Item -ItemType Directory -Path (Join-Path $bundleRoot 'src') -Force | Out-Null

    $files = @(
        'manifest.json',
        'index.js',
        'style.css',
        'README.md',
        'LICENSE',
        'CHANGELOG.md',
        'SECURITY.md'
    )
    foreach ($file in $files) {
        Copy-Item -LiteralPath (Join-Path $repoRoot $file) -Destination (Join-Path $bundleRoot $file)
    }
    Get-ChildItem -LiteralPath (Join-Path $repoRoot 'src') -Filter '*.js' -File |
        Copy-Item -Destination (Join-Path $bundleRoot 'src')

    if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath -Force }
    if (Test-Path -LiteralPath $checksumPath) { Remove-Item -LiteralPath $checksumPath -Force }
    Compress-Archive -LiteralPath $bundleRoot -DestinationPath $archivePath -CompressionLevel Optimal

    $stream = [System.IO.File]::OpenRead($archivePath)
    try {
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        try {
            $hashBytes = $sha256.ComputeHash($stream)
            $hash = ([System.BitConverter]::ToString($hashBytes)).Replace('-', '').ToLowerInvariant()
        }
        finally {
            $sha256.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
    Set-Content -LiteralPath $checksumPath -Value "$hash  $archiveName" -Encoding utf8
    Write-Output "Created: $archivePath"
    Write-Output "SHA256: $hash"
}
finally {
    $resolvedTemp = [System.IO.Path]::GetFullPath($tempRoot)
    $systemTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    if ($resolvedTemp.StartsWith($systemTemp, [System.StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path -Leaf $resolvedTemp).StartsWith('rpig-release-')) {
        Remove-Item -LiteralPath $resolvedTemp -Recurse -Force -ErrorAction SilentlyContinue
    }
}
