$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    & '.venv/Scripts/python.exe' -m pytest -q tests
    if ($LASTEXITCODE -ne 0) { throw 'Backend tests failed' }
    & '.venv/Scripts/python.exe' -m pip check
    if ($LASTEXITCODE -ne 0) { throw 'Python dependency check failed' }
    Push-Location apps/web
    try {
        npm run build
        if ($LASTEXITCODE -ne 0) { throw 'Web build failed' }
    } finally { Pop-Location }
} finally { Pop-Location }
