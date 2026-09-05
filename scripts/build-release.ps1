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
$installerSource = Join-Path $repoRoot 'installers\rp-cinematic-imagegen-tavern-helper-installer.json'
$installerName = "rp-cinematic-imagegen-tavern-helper-installer-v$version.json"
$installerPath = Join-Path $outputPath $installerName
$installerChecksumPath = "$installerPath.sha256"

function Write-Sha256File {
    param(
        [Parameter(Mandatory = $true)][string]$InputPath,
        [Parameter(Mandatory = $true)][string]$OutputPath
    )

    $stream = [System.IO.File]::OpenRead($InputPath)
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

    $fileName = Split-Path -Leaf $InputPath
    Set-Content -LiteralPath $OutputPath -Value "$hash  $fileName" -Encoding utf8
    return $hash
}

& node (Join-Path $PSScriptRoot 'check-release.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Release validation failed. ZIP was not created.' }

New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
$oldArtifacts = Get-ChildItem -LiteralPath $outputPath -File | Where-Object {
    $_.Name -like 'rp-cinematic-imagegen-v*.zip*' -or
    $_.Name -like 'rp-cinematic-imagegen-tavern-helper-installer-v*.json*'
}
foreach ($artifact in $oldArtifacts) {
    Remove-Item -LiteralPath $artifact.FullName -Force
}
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

    Compress-Archive -LiteralPath $bundleRoot -DestinationPath $archivePath -CompressionLevel Optimal
    Copy-Item -LiteralPath $installerSource -Destination $installerPath

    $archiveHash = Write-Sha256File -InputPath $archivePath -OutputPath $checksumPath
    $installerHash = Write-Sha256File -InputPath $installerPath -OutputPath $installerChecksumPath
    Write-Output "Created: $archivePath"
    Write-Output "SHA256: $archiveHash"
    Write-Output "Created: $installerPath"
    Write-Output "SHA256: $installerHash"
}
finally {
    $resolvedTemp = [System.IO.Path]::GetFullPath($tempRoot)
    $systemTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    if ($resolvedTemp.StartsWith($systemTemp, [System.StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path -Leaf $resolvedTemp).StartsWith('rpig-release-')) {
        Remove-Item -LiteralPath $resolvedTemp -Recurse -Force -ErrorAction SilentlyContinue
    }
}
