$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$source = Join-Path $root 'dsh'
$logs = Join-Path $root 'artifacts/dsh-native'
New-Item -ItemType Directory -Path $logs -Force | Out-Null
if (Get-NetTCPConnection -LocalPort 8790 -State Listen -ErrorAction SilentlyContinue) { throw 'Port 8790 occupied; no process replaced.' }
foreach ($name in @('DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY')) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
$env:DSH_HOME = Join-Path $root 'dsh-home'
$env:DSH_AGENTS_HOME = Join-Path $root 'dsh-agents'
$env:DSH_TELEMETRY_DISABLED = '1'
$node = (Get-Command node).Source
$entry = Join-Path $source 'apps/cli/lib/bin.js'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stdout = Join-Path $logs "$stamp.stdout.log"
$stderr = Join-Path $logs "$stamp.stderr.log"
$process = Start-Process -FilePath $node -ArgumentList @(('"{0}"' -f $entry), '--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', '8790') -WorkingDirectory $source -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
[pscustomobject]@{pid=$process.Id; port=8790; source=$source; home=$env:DSH_HOME; stdout=$stdout; stderr=$stderr} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $logs 'current.json')
Write-Output "Started isolated native DSH on port 8790; PID $($process.Id). Authentication URL is in the local stdout log."
