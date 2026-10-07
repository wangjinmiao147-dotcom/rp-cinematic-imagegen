[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Tag)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$dist = Join-Path $root 'dist'
$notes = Join-Path $root "docs/RELEASE_$Tag.md"
if (-not (Test-Path -LiteralPath $notes)) { throw 'Versioned Release notes are missing.' }

function Get-TaskHash([string]$File) {
    $stream = [IO.File]::OpenRead($File)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose(); $stream.Dispose() }
}
function Test-PublishedRelease {
    $metadata = & gh release view $Tag --json 'tagName,isDraft,assets' 2>$null
    if ($LASTEXITCODE -ne 0) { return $false }
    $release = $metadata | ConvertFrom-Json
    if ($release.isDraft -or $release.tagName -ne $Tag) { return $false }
    $expected = @(Get-ChildItem -LiteralPath $dist -File | ForEach-Object { $_.Name } | Sort-Object)
    $actual = @($release.assets | Where-Object state -eq 'uploaded' | ForEach-Object { $_.name } | Sort-Object)
    if ($expected.Count -ne 6 -or (Compare-Object $expected $actual)) { return $false }
    $temporary = Join-Path $root ('.release-confirm-' + [guid]::NewGuid().ToString('N'))
    try {
        New-Item -ItemType Directory -Path $temporary | Out-Null
        & gh release download $Tag --dir $temporary
        if ($LASTEXITCODE -ne 0) { return $false }
        foreach ($name in ($expected | Where-Object { -not $_.EndsWith('.sha256') })) {
            $checksum = (Get-Content -LiteralPath (Join-Path $temporary ($name + '.sha256')) -Raw).Trim() -split '\s+'
            if ($checksum[0] -ne (Get-TaskHash (Join-Path $temporary $name)) -or $checksum[1] -ne $name) { return $false }
        }
        $manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'release-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        $version = $Tag.TrimStart('v')
        Expand-Archive -LiteralPath (Join-Path $temporary "rp-cinematic-imagegen-$Tag.zip") -DestinationPath (Join-Path $temporary 'extension')
        Expand-Archive -LiteralPath (Join-Path $temporary "rp-cinematic-local-scene-llm-$Tag.zip") -DestinationPath (Join-Path $temporary 'local')
        foreach ($file in $manifest.extensionFiles) {
            if ((Get-TaskHash (Join-Path $root $file)) -ne (Get-TaskHash (Join-Path $temporary "extension/rp-cinematic-imagegen/$file"))) { return $false }
        }
        foreach ($file in $manifest.localServiceFiles) {
            if ((Get-TaskHash (Join-Path $root "tools/local-scene-llm/$file")) -ne (Get-TaskHash (Join-Path $temporary "local/rp-cinematic-local-scene-llm/$file"))) { return $false }
        }
        $installer = "rp-cinematic-imagegen-tavern-helper-installer-$Tag.json"
        if ((Get-TaskHash (Join-Path $root 'installers/rp-cinematic-imagegen-tavern-helper-installer.json')) -ne (Get-TaskHash (Join-Path $temporary $installer))) { return $false }
        return $true
    }
    finally {
        $resolved = [IO.Path]::GetFullPath($temporary)
        if ($resolved.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolved).StartsWith('.release-confirm-')) {
            Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

if (Test-PublishedRelease) {
    Write-Output 'Existing public Release verified against this source and its checksums; no changes made.'
    exit 0
}
& gh release create $Tag (Join-Path $dist '*') --title "RP cinematic imagegen $Tag" --notes-file $notes --verify-tag
if ($LASTEXITCODE -ne 0) {
    if (Test-PublishedRelease) {
        Write-Warning 'Publication returned an error, but the complete public Release was verified against the source.'
        exit 0
    }
    throw 'Release publication failed and a complete matching public Release could not be verified.'
}
