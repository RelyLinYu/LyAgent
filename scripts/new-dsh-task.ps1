param(
    [Parameter(Mandatory=$true)][string]$Workspace,
    [Parameter(Mandatory=$true)][string]$Evaluator,
    [Parameter(Mandatory=$true)][string]$Artifact,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-zA-Z0-9_-]{1,100}$')][string]$BatchId,
    [Parameter(Mandatory=$true)][ValidateRange(1,2147483647)][int]$MaxRequests,
    [Parameter(Mandatory=$true)][ValidateRange(1,2147483647)][int]$MaxTokens,
    [Parameter(Mandatory=$true)][ValidateRange(1,2147483647)][int]$ReservationTokens,
    [Parameter(Mandatory=$true)][string]$Destination,
    [ValidateRange(1,10485760)][int]$MaxArtifactBytes = 1048576,
    [ValidateRange(0,2)][int]$MaxRepairs = 0,
    [ValidateRange(1,3)][int]$MaxConcurrent = 1,
    [ValidateRange(1,3600000)][int]$TimeoutMs = 30000,
    [string]$Python = 'python'
)
$ErrorActionPreference = 'Stop'
$workspacePath = (Resolve-Path -LiteralPath $Workspace).ProviderPath
$evaluatorPath = (Resolve-Path -LiteralPath $Evaluator).ProviderPath
if (-not (Test-Path -LiteralPath $workspacePath -PathType Container)) { throw 'Workspace must be an existing folder.' }
if (-not (Test-Path -LiteralPath $evaluatorPath -PathType Leaf)) { throw 'Evaluator must be an existing Python test file.' }
$testName = [IO.Path]::GetFileName($evaluatorPath)
if ($testName -notmatch '^[a-zA-Z0-9_-]+\.py$') { throw 'Evaluator filename must contain letters, digits, underscores or hyphens and end with .py.' }
$artifactPath = $Artifact.Replace('\','/')
if ([IO.Path]::IsPathRooted($Artifact) -or $artifactPath.Contains(':') -or $artifactPath -match '(^|/)\.\.?(/|$)' -or $artifactPath.Split('/').Where({ -not $_.Trim() }).Count -gt 0 -or $artifactPath -match '[<>"|?*\x00-\x1f]' -or $artifactPath.Length -gt 240) { throw 'Artifact must be a bounded relative workspace path without parent traversal.' }
if ($ReservationTokens -gt $MaxTokens) { throw 'One request reservation cannot exceed the authorized token ceiling.' }
$destinationPath = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $destinationPath) { throw 'Destination already exists; no configuration replaced.' }
$parent = Split-Path -Parent $destinationPath
if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw 'Destination parent must exist.' }
$pythonCommand = (Get-Command $Python -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$resolved = & $pythonCommand -I -c 'import json,pathlib,sys;print(json.dumps([str(pathlib.Path(sys.executable).resolve()),str(pathlib.Path(sys.argv[1]).resolve(strict=True)),str(pathlib.Path(sys.argv[2]).resolve(strict=True))]))' $workspacePath $evaluatorPath
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve interpreter and filesystem paths.' }
$real = $resolved | ConvertFrom-Json
$realWorkspace = ([string]$real[1]).TrimEnd('\','/')
$realEvaluator = [string]$real[2]
if ($realEvaluator.StartsWith($realWorkspace + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Trusted evaluator must be outside the workspace, including through directory links.' }
if ((Get-Item -LiteralPath $evaluatorPath).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Evaluator must be a regular file, not a file link.' }
$batchIdentity = $BatchId
$rows = @(
    @{id='llm-retry';disabled=$true},
    @{insert=@(
        @{id='lyagent-budget';name='@deepseek-ai/dsh-lyagent-budget';config=@{
            batchId=$batchIdentity;maxRequests=$MaxRequests;maxTokens=$MaxTokens;reservationTokens=$ReservationTokens;maxConcurrent=$MaxConcurrent
            runLimits=@{maxRequests=$MaxRequests;maxTokens=$MaxTokens;childMaxRequests=$MaxRequests;childMaxTokens=$MaxTokens}
        }},
        @{id='lyagent-artifact-check';name='@deepseek-ai/dsh-lyagent-artifact-acceptance';config=@{
            taskRuns=$true;maxRepairs=$MaxRepairs
            artifacts=@(@{path=$artifactPath;minBytes=1;maxBytes=$MaxArtifactBytes;includes=@()})
            tests=@{python=[string]$real[0];root=(Split-Path -Parent $realEvaluator);files=@(@{path=[IO.Path]::GetFileName($realEvaluator);sha256=(Get-FileHash -LiteralPath $realEvaluator -Algorithm SHA256).Hash.ToLowerInvariant()});minTests=1;timeoutMs=$TimeoutMs;maxChildResultBytes=65536}
        }}
    )}
)
$json = ConvertTo-Json -InputObject $rows -Depth 12
$stream = [IO.File]::Open($destinationPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
try {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json + [Environment]::NewLine)
    $stream.Write($bytes, 0, $bytes.Length)
} finally { $stream.Dispose() }
[pscustomobject]@{configuration=$destinationPath;batchId=$batchIdentity;workspace=$realWorkspace;requests=$MaxRequests;tokens=$MaxTokens;modelRequests=0} | ConvertTo-Json
