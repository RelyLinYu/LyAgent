param(
    [ValidateSet('start','status','stop')][string]$Action = 'status',
    [ValidateRange(1024,65535)][int]$Port = 8791,
    [switch]$Orchestration,
    [switch]$Knowledge,
    [string]$TaskOverlay
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$source = Join-Path $root 'dsh'
$logs = Join-Path $root 'artifacts/dsh-native'
$statePath = Join-Path $logs "managed-$Port.json"
$entry = Join-Path $source 'apps/cli/lib/bin.js'
$overlay = Join-Path $source 'lyagent.overlay.yml'
$orchestrationOverlay = Join-Path $source 'lyagent-orchestration.overlay.yml'
$knowledgeOverlay = Join-Path $source 'lyagent-knowledge.overlay.yml'
$taskUiOverlay = Join-Path $source 'lyagent-tasks.overlay.yml'
$taskConfig = $null
if ($TaskOverlay) {
    $taskConfig = [IO.Path]::GetFullPath($TaskOverlay)
    if (-not (Test-Path -LiteralPath $taskConfig -PathType Leaf)) { throw 'Task overlay must be an existing trusted configuration file.' }
}
$dataHome = Join-Path $root "lyagent-native-home-$Port"
function Get-Listener { @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Port -eq $Port }) }
function Get-Owned($record) {
    if (-not $record) { return $null }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($record.pid)" -ErrorAction SilentlyContinue
    if (-not $process -or -not $process.CreationDate -or -not $process.CommandLine) { return $null }
    $created = if ($record.created -is [datetime]) { $record.created.ToUniversalTime().ToString('o') } else { [string]$record.created }
    if ($process.CreationDate.ToUniversalTime().ToString('o') -ne $created) { return $null }
    if (-not $process.CommandLine.Contains($entry) -or -not $process.CommandLine.Contains($overlay) -or $process.CommandLine -notmatch "--port\s+$Port(?:\s|$)") { return $null }
    if ($record.orchestration -and -not $process.CommandLine.Contains($orchestrationOverlay)) { return $null }
    if ($record.knowledge -and -not $process.CommandLine.Contains($knowledgeOverlay)) { return $null }
    if ($record.taskOverlay -and (-not $process.CommandLine.Contains($record.taskOverlay) -or -not $process.CommandLine.Contains($taskUiOverlay))) { return $null }
    return $process
}
$record = if (Test-Path -LiteralPath $statePath) { Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } else { $null }
$owned = Get-Owned $record
$listeners = Get-Listener
if ($Action -eq 'status') {
    [pscustomobject]@{port=$Port; listening=[bool]$listeners.Count; managed=[bool]$owned; pid=if($owned){$owned.ProcessId}else{$null}; home=$dataHome} | ConvertTo-Json
    exit 0
}
if ($Action -eq 'stop') {
    if (-not $owned) {
        if ($listeners.Count) { throw 'Listener not owned; no process stopped.' }
        Write-Output 'No verified service to stop.'; exit 0
    }
    $owned = Get-Owned $record
    if (-not $owned) { throw 'Identity changed; no process stopped.' }
    Stop-Process -Id $owned.ProcessId
    Write-Output 'Stopped verified service. Workspace files and histories retained.'
    exit 0
}
if ($owned -or $listeners.Count) { throw 'Port or managed process occupied; no replacement.' }
if (-not (Test-Path -LiteralPath $entry)) { throw 'Build native DSH first.' }
New-Item -ItemType Directory -Path $logs -Force | Out-Null
foreach ($name in @('DEEPSEEK_API_KEY','DEEPSEEK_BASE_URL','OPENAI_API_KEY','OPENAI_BASE_URL','ANTHROPIC_API_KEY')) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
$env:DSH_HOME = $dataHome
$env:DSH_AGENTS_HOME = Join-Path $root "lyagent-native-agents-$Port"
$env:DSH_TELEMETRY_DISABLED = '1'
$env:DSH_CLIENT_TITLE = 'LyAgent'
$env:DSH_CLIENT_COMPETITION = 'true'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$stdout = Join-Path $logs "$Port-$stamp.stdout.log"
$stderr = Join-Path $logs "$Port-$stamp.stderr.log"
$node = (Get-Command node).Source
$arguments = @(('"{0}"' -f $entry),'--profile','web','--patch',('"{0}"' -f $overlay))
if ($Orchestration) { $arguments += @('--patch',('"{0}"' -f $orchestrationOverlay)) }
if ($Knowledge) { $arguments += @('--patch',('"{0}"' -f $knowledgeOverlay)) }
if ($taskConfig) { $arguments += @('--patch',('"{0}"' -f $taskConfig),'--patch',('"{0}"' -f $taskUiOverlay)) }
$arguments += @('--no-open','--host','127.0.0.1','--port',$Port)
$process = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $source -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
$identity = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.Id)" -ErrorAction SilentlyContinue
if (-not $identity -or -not $identity.CreationDate) { throw "Service exited before identity capture; inspect $stderr" }
$record = [pscustomobject]@{pid=$process.Id;created=$identity.CreationDate.ToUniversalTime().ToString('o');port=$Port;source=$source;home=$dataHome;stdout=$stdout;stderr=$stderr;orchestration=[bool]$Orchestration;knowledge=[bool]$Knowledge;taskOverlay=$taskConfig}
if (-not (Get-Owned $record)) { throw 'Started identity mismatch; no process stopped.' }
$record | ConvertTo-Json | Set-Content -LiteralPath $statePath
for ($attempt=0; $attempt -lt 90; $attempt++) {
    Start-Sleep -Milliseconds 500
    $identity = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.Id)" -ErrorAction SilentlyContinue
    if (-not $identity) { throw "Service exited; inspect $stderr" }
    $text = if (Test-Path -LiteralPath $stdout) { Get-Content -LiteralPath $stdout -Raw } else { '' }
    if ($text -match 'dsh web: http://') {
        if (-not (Get-Owned $record)) { throw 'Started identity mismatch.' }
        Write-Output "Started LyAgent native service on $Port. Local authentication URL: $stdout"
        exit 0
    }
}
throw "Startup timed out; inspect $stdout and $stderr. No unverified process was stopped."

