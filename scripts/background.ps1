param(
    [ValidateSet('start', 'status', 'stop')][string]$Action = 'status',
    [ValidateRange(1024, 65535)][int]$Port = 8777,
    [string]$DataDir = ''
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$serviceScript = Join-Path $PSScriptRoot 'serve.py'
$python = Join-Path $root '.venv/Scripts/python.exe'
$stateDirectory = Join-Path $root 'artifacts/service'
$statePath = Join-Path $stateDirectory "managed-$Port.json"
if (-not $DataDir) { $DataDir = Join-Path $root 'data' }
if (-not [IO.Path]::IsPathRooted($DataDir)) { $DataDir = Join-Path $root $DataDir }
$DataDir = [IO.Path]::GetFullPath($DataDir)

function Get-Listener {
    @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}
function Get-OwnedProcess($Record) {
    $item = Get-CimInstance Win32_Process -Filter "ProcessId=$($Record.pid)" -ErrorAction SilentlyContinue
    if (-not $item -or -not $item.CreationDate -or -not $item.CommandLine) { return $null }
    $recordCreated = if ($Record.created -is [datetime]) { $Record.created.ToUniversalTime().ToString('o') } else { [string]$Record.created }
    if ($item.CreationDate.ToUniversalTime().ToString('o') -ne $recordCreated) { return $null }
    if (-not $item.CommandLine.Contains($serviceScript) -or -not $item.CommandLine.Contains($Record.data_dir)) { return $null }
    if ($item.CommandLine -notmatch "--port\s+$Port(?:\s|$)") { return $null }
    return $item
}
function Get-Health {
    $client = New-Object System.Net.WebClient
    $client.Proxy = $null
    try { ($client.DownloadString("http://127.0.0.1:$Port/api/health") | ConvertFrom-Json) }
    finally { $client.Dispose() }
}
$state = if (Test-Path -LiteralPath $statePath) { Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } else { $null }
$owned = if ($state) { Get-OwnedProcess $state } else { $null }
$listeners = @(Get-Listener)

if ($Action -eq 'status') {
    $health = $null
    if ($listeners.Count) { try { $health = Get-Health } catch {} }
    [pscustomobject]@{ port = $Port; listening = [bool]$listeners.Count; managed = [bool]$owned; pid = if ($owned) { $owned.ProcessId } else { $null }; health = $health; state_file = $statePath } | ConvertTo-Json -Depth 5
    exit 0
}
if ($Action -eq 'stop') {
    if (-not $owned) {
        if ($listeners.Count) { throw 'Listener is not owned by this manager. No process was stopped.' }
        [pscustomobject]@{ stopped = $false; reason = 'No verified managed process' } | ConvertTo-Json
        exit 0
    }
    # Recheck identity immediately before stopping. Never kill by port alone.
    $owned = Get-OwnedProcess $state
    if (-not $owned) { throw 'Process identity changed; no process was stopped.' }
    Stop-Process -Id $owned.ProcessId -ErrorAction Stop
    for ($attempt = 0; $attempt -lt 50; $attempt++) {
        if (-not (Get-OwnedProcess $state)) { break }
        Start-Sleep -Milliseconds 100
    }
    if (Get-OwnedProcess $state) { throw 'Managed process did not exit' }
    [pscustomobject]@{ stopped = $true; pid = $state.pid; effects = 'No rollback; interrupted tasks require review' } | ConvertTo-Json
    exit 0
}
if ($owned -or $listeners.Count) { throw 'Port or managed process already occupied. No process was stopped or replaced.' }
if (-not (Test-Path -LiteralPath $python)) { throw 'Independent Python environment is missing; run setup.ps1 first.' }
New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$stdout = Join-Path $stateDirectory "$Port-$stamp.stdout.log"
$stderr = Join-Path $stateDirectory "$Port-$stamp.stderr.log"
$arguments = @(('"{0}"' -f $serviceScript), '--port', $Port, '--data-dir', ('"{0}"' -f $DataDir))
$launcher = Start-Process -FilePath $python -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
try {
    $record = $null
    for ($attempt = 0; $attempt -lt 150; $attempt++) {
        $listeners = @(Get-Listener)
        if ($listeners.Count) {
            $server = Get-CimInstance Win32_Process -Filter "ProcessId=$($listeners[0].OwningProcess)"
            if ($server.ProcessId -ne $launcher.Id -and $server.ParentProcessId -ne $launcher.Id) { throw 'An unrelated process acquired the port; it was not stopped.' }
            $record = [pscustomobject]@{ pid = $server.ProcessId; created = $server.CreationDate.ToUniversalTime().ToString('o'); data_dir = $DataDir; port = $Port; stdout = $stdout; stderr = $stderr }
            if (-not (Get-OwnedProcess $record)) { throw 'Started process identity could not be verified' }
            $health = Get-Health
            if (-not $health.build.StartsWith('rewrite-')) { throw 'Unexpected backend version' }
            break
        }
        if ($launcher.HasExited) { throw "Server exited; inspect $stderr" }
        Start-Sleep -Milliseconds 100
    }
    if (-not $record) { throw "Server startup timed out; inspect $stderr" }
    $record | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
    [pscustomobject]@{ started = $true; pid = $record.pid; url = "http://127.0.0.1:$Port"; build = $health.build; configured = $health.configured; stdout = $stdout; stderr = $stderr; autostart = $false } | ConvertTo-Json
} catch {
    # Only the exact child launched by this invocation may be cleaned up.
    if ($record -and (Get-OwnedProcess $record)) { Stop-Process -Id $record.pid -ErrorAction SilentlyContinue }
    if (-not $launcher.HasExited) { $launcher.Kill() }
    throw
}
