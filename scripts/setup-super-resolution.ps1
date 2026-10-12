[CmdletBinding()]
param(
    [string]$RuntimeRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) '.tmp\sr-runtime'),
    [string]$DownloadRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) '.tmp\sr-runtime\downloads')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$repoRoot = Split-Path -Parent $PSScriptRoot
$licenseRoot = Join-Path $repoRoot 'licenses'
$runtimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)
$downloadRoot = [IO.Path]::GetFullPath($DownloadRoot)
$stageRoot = Join-Path $runtimeRoot ('.staging-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Force -Path $downloadRoot, $stageRoot

$packages = @(
    [ordered]@{
        id = 'realesrgan-ncnn-vulkan'
        version = 'v0.2.5.0'
        url = 'https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip'
        archive = 'realesrgan-ncnn-vulkan-20220424-windows.zip'
        size = 45474481L
        sha256 = 'ABC02804E17982A3BE33675E4D471E91EA374E65B70167ABC09E31ACB412802D'
        destination = 'realesrgan'
        entryPrefix = ''
        entries = @(
            'realesrgan-ncnn-vulkan.exe',
            'vcomp140.dll',
            'models/realesrgan-x4plus-anime.param',
            'models/realesrgan-x4plus-anime.bin'
        )
        licenseFiles = @('REAL_ESRGAN_NCNN_VULKAN_MIT.txt', 'REAL_ESRGAN_MODEL_BSD-3-CLAUSE.txt', 'NCNN_BSD-3-CLAUSE.txt', 'LIBWEBP_BSD-3-CLAUSE.txt', 'STB_MIT_OR_PUBLIC_DOMAIN.txt', 'DIRENT_MIT.txt')
    },
    [ordered]@{
        id = 'realcugan-ncnn-vulkan'
        version = '20220728'
        url = 'https://github.com/nihui/realcugan-ncnn-vulkan/releases/download/20220728/realcugan-ncnn-vulkan-20220728-windows.zip'
        archive = 'realcugan-ncnn-vulkan-20220728-windows.zip'
        size = 45977449L
        sha256 = 'C6E08D46C11704B1E3A1ADA9DDD591CB5005F52F132136C8633BA25DEF400E01'
        destination = 'realcugan'
        entryPrefix = 'realcugan-ncnn-vulkan-20220728-windows/'
        entries = @(
            'realcugan-ncnn-vulkan.exe',
            'vcomp140.dll',
            'models-se/up2x-conservative.param',
            'models-se/up2x-conservative.bin',
            'models-se/up4x-conservative.param',
            'models-se/up4x-conservative.bin'
        )
        licenseFiles = @('REAL_CUGAN_NCNN_VULKAN_MIT.txt', 'REAL_CUGAN_MODEL_MIT.txt', 'NCNN_BSD-3-CLAUSE.txt', 'LIBWEBP_BSD-3-CLAUSE.txt', 'STB_MIT_OR_PUBLIC_DOMAIN.txt', 'DIRENT_MIT.txt')
    }
)

function Get-Sha256([string]$Path) {
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToUpperInvariant()
}

function Copy-ZipEntry([IO.Compression.ZipArchive]$Archive, [string]$EntryName, [string]$Destination, [string]$TargetName) {
    $entry = $Archive.GetEntry($EntryName)
    if ($null -eq $entry) { throw "Required archive entry missing: $EntryName" }
    if ($entry.Length -le 0 -or $entry.Length -gt 128MB) { throw "Archive entry size is invalid: $EntryName" }
    $normalized = $TargetName.Replace('/', '\')
    if ([IO.Path]::IsPathRooted($normalized) -or $normalized.Split('\') -contains '..') {
        throw "Unsafe extraction path for archive entry: $EntryName"
    }
    $output = Join-Path $Destination $normalized
    $fullOutput = [IO.Path]::GetFullPath($output)
    $rootPrefix = [IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
    if (-not $fullOutput.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Archive entry escaped staging directory: $EntryName"
    }
    $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $fullOutput)
    $input = $entry.Open()
    try {
        $outputStream = [IO.File]::Open($fullOutput, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $input.CopyTo($outputStream) } finally { $outputStream.Dispose() }
    } finally { $input.Dispose() }
}

function Install-Package([System.Collections.IDictionary]$Package) {
    $archivePath = Join-Path $downloadRoot $Package.archive
    if (-not (Test-Path -LiteralPath $archivePath) -or (Get-Item -LiteralPath $archivePath).Length -ne $Package.size) {
        $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
        if ($null -eq $curl) { throw 'curl.exe is required to fetch the pinned upstream release archives.' }
        Write-Host "Downloading $($Package.id) $($Package.version)..."
        & $curl.Source '--fail' '--location' '--retry' '3' '--retry-all-errors' '--continue-at' '-' '--output' $archivePath $Package.url
        if ($LASTEXITCODE -ne 0) { throw "Download failed for $($Package.id)." }
    }
    $archiveInfo = Get-Item -LiteralPath $archivePath
    if ($archiveInfo.Length -ne $Package.size) { throw "Pinned archive size mismatch for $($Package.id)." }
    $archiveHash = Get-Sha256 $archivePath
    if ($archiveHash -ne $Package.sha256) { throw "Pinned archive SHA-256 mismatch for $($Package.id)." }

    $packageStage = Join-Path $stageRoot $Package.destination
    $null = New-Item -ItemType Directory -Force -Path $packageStage
    $zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            if ($name.StartsWith('/') -or $name -match '(^|/)\.\.?(/|$)') { throw "Unsafe path in upstream archive: $name" }
        }
        foreach ($entryName in $Package.entries) {
            $archiveEntryName = $Package.entryPrefix + $entryName
            Copy-ZipEntry $zip $archiveEntryName $packageStage $entryName
        }
    } finally { $zip.Dispose() }

    foreach ($licenseFile in $Package.licenseFiles) {
        $source = Join-Path $licenseRoot $licenseFile
        if (-not (Test-Path -LiteralPath $source)) { throw "License notice missing: $licenseFile" }
        $licenseDirectory = Join-Path $packageStage 'licenses'
        $null = New-Item -ItemType Directory -Force -Path $licenseDirectory
        Copy-Item -LiteralPath $source -Destination (Join-Path $licenseDirectory $licenseFile)
    }

    $installed = Get-ChildItem -LiteralPath $packageStage -File -Recurse | ForEach-Object {
        [ordered]@{
            path = $_.FullName.Substring($packageStage.Length + 1).Replace('\', '/')
            size = $_.Length
            sha256 = Get-Sha256 $_.FullName
        }
    }
    [ordered]@{
        id = $Package.id
        version = $Package.version
        source = $Package.url
        archive = $Package.archive
        archive_size = $Package.size
        archive_sha256 = $archiveHash
        installed_files = @($installed)
    }
}

try {
    $installedPackages = @($packages | ForEach-Object { Install-Package $_ })
    $licenseHashes = @{}
    foreach ($license in (Get-ChildItem -LiteralPath $licenseRoot -File)) {
        $licenseHashes[$license.Name] = Get-Sha256 $license.FullName
    }
    $manifest = [ordered]@{
        schema_version = 1
        generated_utc = [DateTime]::UtcNow.ToString('o')
        runtime = 'Windows x64; ncnn Vulkan; no CUDA/PyTorch'
        packages = $installedPackages
        license_sha256 = $licenseHashes
        source_note = 'Pinned GitHub release assets; archives are verified against the SHA-256 values recorded by this project before extraction.'
    }
    $manifestPath = Join-Path $stageRoot 'install-manifest.json'
    $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding utf8

    foreach ($package in $packages) {
        $destination = Join-Path $runtimeRoot $package.destination
        $source = Join-Path $stageRoot $package.destination
        $null = New-Item -ItemType Directory -Force -Path $destination
        Get-ChildItem -LiteralPath $source -File -Recurse | ForEach-Object {
            $relative = $_.FullName.Substring($source.Length + 1)
            $target = Join-Path $destination $relative
            $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target)
            Copy-Item -LiteralPath $_.FullName -Destination $target -Force
        }
    }
    Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $runtimeRoot 'install-manifest.json') -Force
    Write-Host "Installed pinned local SR runtimes to $runtimeRoot"
    Write-Host 'Inspect install-manifest.json for source and file hashes.'
}
finally {
    if (Test-Path -LiteralPath $stageRoot) { Remove-Item -LiteralPath $stageRoot -Recurse -Force }
}
