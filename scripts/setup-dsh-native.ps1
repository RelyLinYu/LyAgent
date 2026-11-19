$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$source = Join-Path $root 'dsh'
$nodeVersion = & node -p 'process.versions.node'
if ($LASTEXITCODE -ne 0 -or [version]$nodeVersion -lt [version]'24.9.0') { throw 'Node.js >=24.9.0 is required.' }
foreach ($name in @('DEEPSEEK_API_KEY','DEEPSEEK_BASE_URL','OPENAI_API_KEY','OPENAI_BASE_URL','ANTHROPIC_API_KEY')) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
$env:DSH_CLIENT_TITLE = 'LyAgent'
$env:DSH_CLIENT_COMPETITION = 'true'
$env:LEFTHOOK = '0'
$env:CI = 'true'
$manifestPath = Join-Path $root 'manifest.json'
if (Test-Path -LiteralPath $manifestPath) {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.upstreamCommit -notmatch '^[0-9a-f]{40}$') { throw 'Invalid source commit in package manifest.' }
    $env:DSH_CLIENT_COMMIT_HASH = $manifest.upstreamCommit
    $env:GIT_CEILING_DIRECTORIES = $root
}
Push-Location $source
try {
    & corepack pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw 'Frozen dependency installation failed.' }
    & corepack pnpm run build:artifacts
    if ($LASTEXITCODE -ne 0) { throw 'Artifact build failed.' }
    & corepack pnpm run build:check
    if ($LASTEXITCODE -ne 0) { throw 'Build checks failed.' }
} finally { Pop-Location }
Write-Output 'Build and checks passed. Start with scripts/dsh-service.ps1 -Action start.'
