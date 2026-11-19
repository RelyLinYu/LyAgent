param(
    [Parameter(Mandatory=$true)][string]$Package,
    [Parameter(Mandatory=$true)][string]$Destination
)
$ErrorActionPreference = 'Stop'
$Package = [IO.Path]::GetFullPath($Package)
$Destination = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $Destination) { throw 'Archive destination already exists; no overwrite.' }
$manifestPath = Join-Path $Package 'manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$paths = @($manifest.files | ForEach-Object { $_.path }) + @('manifest.json')
$seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($relative in $paths) {
    if (-not $seen.Add($relative)) { throw 'Duplicate archive path.' }
    $source = [IO.Path]::GetFullPath((Join-Path $Package $relative))
    if (-not $source.StartsWith($Package + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path escaped package.' }
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing source: $relative" }
}
foreach ($file in $manifest.files) {
    if ((Get-FileHash -LiteralPath (Join-Path $Package $file.path) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) { throw "Source hash mismatch: $($file.path)" }
}
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stream = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew)
$zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
try {
    foreach ($relative in $paths) {
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $Package $relative), $relative.Replace('\','/'), [IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
} finally { $zip.Dispose() }
$zip = [IO.Compression.ZipFile]::OpenRead($Destination)
try {
    if ($zip.Entries.Count -ne $paths.Count) { throw 'Archive member count mismatch.' }
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        foreach ($file in $manifest.files) {
            $entry = $zip.GetEntry($file.path.Replace('\','/'))
            if (-not $entry) { throw "Archive entry missing: $($file.path)" }
            $inputStream = $entry.Open()
            try { $actual = ([BitConverter]::ToString($sha.ComputeHash($inputStream))).Replace('-','').ToLowerInvariant() } finally { $inputStream.Dispose() }
            if ($actual -ne $file.sha256) { throw "Archive hash mismatch: $($file.path)" }
        }
        $manifestEntry = $zip.GetEntry('manifest.json').Open()
        try { $manifestHash = ([BitConverter]::ToString($sha.ComputeHash($manifestEntry))).Replace('-','').ToLowerInvariant() } finally { $manifestEntry.Dispose() }
        if ($manifestHash -ne (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()) { throw 'Archived manifest differs.' }
    } finally { $sha.Dispose() }
} finally { $zip.Dispose() }
[pscustomobject]@{archive=$Destination;members=$paths.Count;sha256=(Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant();bytes=(Get-Item -LiteralPath $Destination).Length;verified=$true} | ConvertTo-Json
