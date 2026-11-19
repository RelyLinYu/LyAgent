$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$temp = Join-Path ([IO.Path]::GetTempPath()) ('lyagent-task-config-' + [guid]::NewGuid().ToString('N'))
$workspace = Join-Path $temp 'workspace'
New-Item -ItemType Directory -Path $workspace -Force | Out-Null
try {
    $evaluator = Join-Path $root 'tests/test_budget_shares.py'
    $destination = Join-Path $temp 'task.json'
    $arguments = @{Workspace=$workspace;Evaluator=$evaluator;Artifact='result.md';BatchId='keyless-config-test';MaxRequests=3;MaxTokens=100;ReservationTokens=10;Destination=$destination}
    $result = & (Join-Path $PSScriptRoot 'new-dsh-task.ps1') @arguments | ConvertFrom-Json
    if ($result.modelRequests -ne 0 -or $result.batchId -ne 'keyless-config-test') { throw 'Unexpected configuration generation result.' }
    $rows = Get-Content -LiteralPath $destination -Raw | ConvertFrom-Json
    $budget = $rows[1].insert | Where-Object id -eq 'lyagent-budget'
    $acceptance = $rows[1].insert | Where-Object id -eq 'lyagent-artifact-check'
    if ($budget.config.batchId -ne 'keyless-config-test' -or $budget.config.maxRequests -ne 3 -or $budget.config.maxTokens -ne 100) { throw 'Budget configuration mismatch.' }
    if ($acceptance.config.tests.files[0].sha256 -ne (Get-FileHash -LiteralPath $evaluator -Algorithm SHA256).Hash.ToLowerInvariant()) { throw 'Evaluator digest mismatch.' }
    $rejections = 0
    if ($budget.config.maxConcurrent -ne 1) { throw 'Default concurrency changed.' }
    $parallelArgs = $arguments.Clone()
    $parallelArgs.MaxConcurrent = 2
    $parallelArgs.Destination = Join-Path $temp 'parallel.json'
    & (Join-Path $PSScriptRoot 'new-dsh-task.ps1') @parallelArgs | Out-Null
    $parallelRows = Get-Content -LiteralPath $parallelArgs.Destination -Raw | ConvertFrom-Json
    $parallelBudget = $parallelRows[1].insert | Where-Object id -eq 'lyagent-budget'
    if ($parallelBudget.config.maxConcurrent -ne 2 -or $parallelBudget.config.maxRequests -ne 3 -or $parallelBudget.config.maxTokens -ne 100) { throw 'Explicit concurrency changed authorized totals.' }
    $linkedWorkspace = Join-Path $temp 'linked-workspace'
    New-Item -ItemType Directory -Path $linkedWorkspace | Out-Null
    New-Item -ItemType Junction -Path (Join-Path $linkedWorkspace 'evaluators') -Target (Join-Path $root 'tests') | Out-Null
    foreach ($case in @('existing','parent','inside','reservation','empty-segment','invalid-character','linked-inside','concurrency')) {
        $inputArgs = $arguments.Clone()
        switch ($case) {
            'parent' { $inputArgs.Artifact = '../outside.md'; $inputArgs.Destination = Join-Path $temp 'parent.json' }
            'concurrency' { $inputArgs.MaxConcurrent = 4; $inputArgs.Destination = Join-Path $temp 'concurrency.json' }
            'inside' { $inputArgs.Workspace = $root; $inputArgs.Destination = Join-Path $temp 'inside.json' }
            'reservation' { $inputArgs.ReservationTokens = 101; $inputArgs.Destination = Join-Path $temp 'reservation.json' }
            'empty-segment' { $inputArgs.Artifact = 'nested//result.md'; $inputArgs.Destination = Join-Path $temp 'empty.json' }
            'invalid-character' { $inputArgs.Artifact = 'bad?.md'; $inputArgs.Destination = Join-Path $temp 'invalid.json' }
            'linked-inside' { $inputArgs.Workspace = (Join-Path $linkedWorkspace 'evaluators'); $inputArgs.Destination = Join-Path $temp 'linked.json' }
        }
        $denied = $false
        try { & (Join-Path $PSScriptRoot 'new-dsh-task.ps1') @inputArgs | Out-Null } catch { $denied = $true }
        if (-not $denied) { throw "Invalid configuration accepted: $case" }
        $rejections++
    }
    [pscustomobject]@{passed=$true;positive=2;rejections=$rejections;modelRequests=0} | ConvertTo-Json
} finally {
    $resolved = [IO.Path]::GetFullPath($temp)
    $parent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($parent, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notlike 'lyagent-task-config-*') { throw 'Refusing cleanup outside owned temporary directory.' }
    $junction = Join-Path $resolved 'linked-workspace/evaluators'
    if (Test-Path -LiteralPath $junction) { [IO.Directory]::Delete($junction) }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
