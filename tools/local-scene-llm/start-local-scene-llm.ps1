[CmdletBinding()]
param(
    [string]$ConfigPath = '',
    [string]$NodePath = '',
    [string]$OllamaPath = '',
    [string]$ModelsPath = '',
    [string]$LogDirectory = ''
)

$ErrorActionPreference = 'Stop'
function Resolve-TaskExecutable([string]$ExplicitPath, [string]$EnvironmentPath, [string]$Name) {
    $candidate = if ($ExplicitPath) { $ExplicitPath } elseif ($EnvironmentPath) { $EnvironmentPath } else { $Name }
    $command = Get-Command $candidate -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $command) { throw "Cannot find $Name. Add it to PATH or pass its executable path." }
    return $command.Source
}

if (-not $ConfigPath) { $ConfigPath = $env:RP_SCENE_CONFIG }
if (-not $ConfigPath) {
    $ConfigPath = Join-Path $PSScriptRoot 'local-scene-config.json'
    if (-not (Test-Path -LiteralPath $ConfigPath)) { $ConfigPath = Join-Path $PSScriptRoot 'local-scene-config.example.json' }
}
$taskConfigPath = (Resolve-Path -LiteralPath $ConfigPath).Path
$taskConfig = Get-Content -LiteralPath $taskConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$taskNodePath = Resolve-TaskExecutable $NodePath $env:RP_SCENE_NODE 'node.exe'
if (-not $LogDirectory) { $LogDirectory = $env:RP_SCENE_LOG_DIR }
if (-not $LogDirectory) { $LogDirectory = Join-Path $PSScriptRoot 'runtime' }
$taskLogRoot = [System.IO.Path]::GetFullPath($LogDirectory)
New-Item -ItemType Directory -Path $taskLogRoot -Force | Out-Null
$taskProxyPath = Join-Path $PSScriptRoot 'local-scene-llm.mjs'

& $taskNodePath $taskProxyPath --check-config --config $taskConfigPath
if ($LASTEXITCODE -ne 0) { throw 'Invalid local scene configuration.' }

$taskOllama = $null
try { $taskOllama = Invoke-RestMethod -Uri ($taskConfig.ollamaUrl + '/api/version') -TimeoutSec 2 } catch {}
if (-not $taskOllama.version) {
    $taskOllamaPath = Resolve-TaskExecutable $OllamaPath $env:RP_SCENE_OLLAMA 'ollama.exe'
    if (-not $ModelsPath) { $ModelsPath = $env:RP_SCENE_MODELS }
    if ($ModelsPath) { $env:OLLAMA_MODELS = [System.IO.Path]::GetFullPath($ModelsPath) }
    $env:OLLAMA_HOST = ([uri]$taskConfig.ollamaUrl).Authority
    $env:OLLAMA_NUM_PARALLEL = '1'
    $env:OLLAMA_MAX_LOADED_MODELS = '1'
    $env:OLLAMA_FLASH_ATTENTION = '1'
    $env:OLLAMA_KV_CACHE_TYPE = 'q8_0'
    $env:OLLAMA_NO_CLOUD = '1'
    $taskOllamaProcess = Start-Process -FilePath $taskOllamaPath -ArgumentList 'serve' -WorkingDirectory $taskLogRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskLogRoot 'ollama-stdout.log') -RedirectStandardError (Join-Path $taskLogRoot 'ollama-stderr.log') -PassThru
    for ($taskAttempt = 0; $taskAttempt -lt 30; $taskAttempt++) {
        try { $taskOllama = Invoke-RestMethod -Uri ($taskConfig.ollamaUrl + '/api/version') -TimeoutSec 2; break } catch { Start-Sleep -Seconds 1 }
    }
    if (-not $taskOllama.version) { throw 'Ollama did not become ready. Check runtime logs.' }
}
$taskModels = (Invoke-RestMethod -Uri ($taskConfig.ollamaUrl + '/api/tags') -TimeoutSec 5).models
if (-not ($taskModels | Where-Object { $_.name -eq $taskConfig.model -or $_.name -eq ($taskConfig.model + ':latest') })) {
    throw ('Configured model is missing: ' + $taskConfig.model + '. See README for local import; nothing is downloaded automatically.')
}

$taskProxyBase = 'http://127.0.0.1:' + $taskConfig.listenPort
$taskExisting = $null
try { $taskExisting = Invoke-RestMethod -Uri ($taskProxyBase + '/health') -TimeoutSec 5 } catch {}
if ($taskExisting.status -eq 'ready') {
    foreach ($taskField in $taskConfig.PSObject.Properties.Name) {
        $actual = ConvertTo-Json -InputObject $taskExisting.limits.$taskField -Compress -Depth 10
        $expected = ConvertTo-Json -InputObject $taskConfig.$taskField -Compress -Depth 10
        if ($actual -ne $expected) { throw "The running proxy has a different $taskField. Nothing was stopped; select another port or restart it yourself." }
    }
    Write-Output ('Local scene LLM is ready: ' + $taskProxyBase + '/v1')
    exit 0
}
# Start-Process joins arguments; quote each path to preserve Chinese and spaces.
$taskProxyArguments = '"' + $taskProxyPath + '" --config "' + $taskConfigPath + '"'
$taskProxyProcess = Start-Process -FilePath $taskNodePath -ArgumentList $taskProxyArguments -WorkingDirectory $taskLogRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskLogRoot 'text-proxy-stdout.log') -RedirectStandardError (Join-Path $taskLogRoot 'text-proxy-stderr.log') -PassThru
for ($taskAttempt = 0; $taskAttempt -lt 15; $taskAttempt++) {
    try { $taskReady = Invoke-RestMethod -Uri ($taskProxyBase + '/health') -TimeoutSec 2; if ($taskReady.status -eq 'ready') { Write-Output ('Local scene LLM is ready: ' + $taskProxyBase + '/v1'); exit 0 } } catch {}
    if ($taskProxyProcess.HasExited) { throw 'Local proxy exited. Check text-proxy-stderr.log.' }
    Start-Sleep -Seconds 1
}
throw 'Local proxy did not become ready. Check runtime logs.'
