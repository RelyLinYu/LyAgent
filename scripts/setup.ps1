param([string]$Python = 'python')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    & $Python -c "import sys; assert sys.version_info[:2] == (3, 14), 'Tested Python version: 3.14'"
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.14 is required for this tested lock' }
    & node -e "if (Number(process.versions.node.split('.')[0]) !== 24) process.exit(1)"
    if ($LASTEXITCODE -ne 0) { throw 'Tested Node version: 24' }
    if (-not (Test-Path -LiteralPath '.venv/Scripts/python.exe')) {
        & $Python -m venv .venv
        if ($LASTEXITCODE -ne 0) { throw 'Virtual environment creation failed' }
    }
    & '.venv/Scripts/python.exe' -m pip install -r requirements-lock.txt
    if ($LASTEXITCODE -ne 0) { throw 'Locked Python installation failed' }
    & '.venv/Scripts/python.exe' -m pip check
    if ($LASTEXITCODE -ne 0) { throw 'Python dependency check failed' }
    Push-Location apps/web
    try {
        npm ci
        if ($LASTEXITCODE -ne 0) { throw 'Locked web installation failed' }
        npm run build
        if ($LASTEXITCODE -ne 0) { throw 'Web build failed' }
    } finally { Pop-Location }
} finally { Pop-Location }
