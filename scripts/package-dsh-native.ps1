param([string]$Destination)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$source = Join-Path $root 'dsh'
if (-not $Destination) { $Destination = Join-Path $root ('artifacts/dsh-native/source-' + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
$Destination = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $Destination) { throw 'Destination already exists; no files replaced.' }
if ($Destination.StartsWith($source + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Destination must be outside the source checkout.' }
$files = @(& git -c core.quotepath=false -C $source ls-files --cached --others --exclude-standard)
if ($LASTEXITCODE -ne 0) { throw 'Cannot enumerate source checkout.' }
$files = @($files | Sort-Object -Unique)
$blocked = @($files | Where-Object { $_ -notmatch '\.example$' -and $_ -match '(^|/)(\.env(?:\..*)?|node_modules|\.sessions|\.storages)(/|$)|\.(p12|pfx|pem|key)$' })
if ($blocked.Count) { throw 'Sensitive or runtime paths found in source inventory; inspect locally before packaging.' }
New-Item -ItemType Directory -Path (Join-Path $Destination 'dsh') -Force | Out-Null
$inventory = foreach ($relative in $files) {
    $inputFile = [IO.Path]::GetFullPath((Join-Path $source $relative))
    if (-not $inputFile.StartsWith($source + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Source inventory escaped checkout.' }
    $target = Join-Path $Destination "dsh/$relative"
    if (-not (Test-Path -LiteralPath $inputFile -PathType Leaf)) { throw "Missing source file: $relative" }
    New-Item -ItemType Directory -Path (Split-Path $target) -Force | Out-Null
    Copy-Item -LiteralPath $inputFile -Destination $target
    [pscustomobject]@{path="dsh/$relative";sha256=(Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()}
}
New-Item -ItemType Directory -Path (Join-Path $Destination 'scripts') -Force | Out-Null
foreach ($name in @('dsh-service.ps1','setup-dsh-native.ps1','new-dsh-task.ps1')) {
    $target = Join-Path $Destination "scripts/$name"
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $target
    $inventory += [pscustomobject]@{path="scripts/$name";sha256=(Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()}
}
Copy-Item -LiteralPath (Join-Path $root 'DSH_NATIVE.md') -Destination (Join-Path $Destination 'README.md')
$inventory += [pscustomobject]@{path='README.md';sha256=(Get-FileHash -LiteralPath (Join-Path $Destination 'README.md') -Algorithm SHA256).Hash.ToLowerInvariant()}
[pscustomobject]@{upstreamCommit=(& git -C $source rev-parse HEAD);created=(Get-Date).ToUniversalTime().ToString('o');kind='source-candidate';files=$inventory} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $Destination 'manifest.json') -Encoding utf8
Write-Output "Source candidate created: $Destination ($($inventory.Count) files). Clean build and task acceptance remain separate checks."
