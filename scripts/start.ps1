param([int]$Port = 8777, [string]$DataDir = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    throw "Port $Port is occupied. No process was stopped."
}
if (-not $DataDir) { $DataDir = Join-Path $root 'data' }
$env:LYAGENT_DATA_DIR = [IO.Path]::GetFullPath($DataDir)
Push-Location $root
try {
    & (Join-Path $root '.venv/Scripts/python.exe') scripts/serve.py --port $Port --data-dir $env:LYAGENT_DATA_DIR
    if ($LASTEXITCODE -ne 0) { throw 'Workbench server failed' }
} finally { Pop-Location }
