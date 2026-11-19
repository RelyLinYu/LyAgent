param([Parameter(Mandatory=$true)][string]$Package)
$ErrorActionPreference = 'Stop'
$Package = [IO.Path]::GetFullPath($Package)
$manifest = Get-Content -LiteralPath (Join-Path $Package 'manifest.json') -Raw | ConvertFrom-Json
$seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($file in $manifest.files) {
    if (-not $seen.Add($file.path)) { throw "Duplicate inventory path: $($file.path)" }
    $target = [IO.Path]::GetFullPath((Join-Path $Package $file.path))
    if (-not $target.StartsWith($Package + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Inventory escaped package directory.' }
    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw "Missing file: $($file.path)" }
    if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) { throw "Hash mismatch: $($file.path)" }
}
Write-Output "Verified $($manifest.files.Count) inventoried source files. Generated dependencies and evidence are outside this source inventory."
