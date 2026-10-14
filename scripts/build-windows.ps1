#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$FlutterPath
)

$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$temporaryRoot = Join-Path $projectRoot '.tmp'
$junctionPath = Join-Path $temporaryRoot 'windows-build-source'
$sdkRoot = Split-Path -Parent $projectRoot
if ([string]::IsNullOrWhiteSpace($FlutterPath)) {
    $FlutterPath = Join-Path $sdkRoot '.tools\flutter\bin\flutter.bat'
}

if (-not (Test-Path -LiteralPath $FlutterPath -PathType Leaf)) {
    throw "Flutter CLI not found: $FlutterPath"
}
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot '.dart_tool\package_config.json') -PathType Leaf)) {
    throw 'Missing .dart_tool/package_config.json; resolve packages before running this release build.'
}
if (-not (Test-Path -LiteralPath $temporaryRoot -PathType Container)) {
    New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
}

# Flutter's assemble stamp can claim that wrapper sources were unpacked even
# when those outputs are missing. Preserve that stale cache before asking the
# Flutter tool to generate the outputs again; never copy SDK files by hand.
$wrapperSourceNames = @(
    'core_implementations.cc',
    'standard_codec.cc',
    'plugin_registrar.cc',
    'flutter_engine.cc',
    'flutter_view_controller.cc'
)
$ephemeralWrapperDirectory = Join-Path $projectRoot 'windows\flutter\ephemeral\cpp_client_wrapper'
$missingWrapperSources = @($wrapperSourceNames | Where-Object {
    -not (Test-Path -LiteralPath (Join-Path $ephemeralWrapperDirectory $_) -PathType Leaf)
})
if ($missingWrapperSources.Count -gt 0) {
    $flutterBinDirectory = Split-Path -Parent $FlutterPath
    $flutterSdkRoot = Split-Path -Parent $flutterBinDirectory
    $sdkWrapperDirectory = Join-Path $flutterSdkRoot 'bin\cache\artifacts\engine\windows-x64\cpp_client_wrapper'
    $missingSdkWrapperSources = @($wrapperSourceNames | Where-Object {
        -not (Test-Path -LiteralPath (Join-Path $sdkWrapperDirectory $_) -PathType Leaf)
    })
    if ($missingSdkWrapperSources.Count -gt 0) {
        throw "Flutter SDK Windows wrapper artifact is incomplete; missing: $($missingSdkWrapperSources -join ', '). Run 'flutter precache --windows' and retry."
    }

    $flutterBuildCache = Join-Path $projectRoot '.dart_tool\flutter_build'
    if (Test-Path -LiteralPath $flutterBuildCache -PathType Container) {
        $resolvedFlutterBuildCache = (Resolve-Path -LiteralPath $flutterBuildCache).Path.TrimEnd('\')
        $resolvedProjectRoot = (Resolve-Path -LiteralPath $projectRoot).Path.TrimEnd('\')
        if (-not $resolvedFlutterBuildCache.StartsWith($resolvedProjectRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to move a Flutter build cache outside the PC workspace: $resolvedFlutterBuildCache"
        }
        $cacheBackupPath = Join-Path $temporaryRoot ("flutter-build-cache-backup-{0}" -f (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
        if (Test-Path -LiteralPath $cacheBackupPath) {
            throw "Refusing to overwrite an existing Flutter build cache backup: $cacheBackupPath"
        }
        Move-Item -LiteralPath $flutterBuildCache -Destination $cacheBackupPath
        Write-Host "Preserved stale Flutter build cache at $cacheBackupPath (generated Windows wrapper sources were missing)."
    }
}

$junctionCreated = $false
$driveCreated = $false
$locationPushed = $false
$oldPubCache = $env:PUB_CACHE
$hadPubCache = Test-Path Env:PUB_CACHE
$driveLetter = $null
$buildExitCode = 1
$logPath = Join-Path $temporaryRoot ("windows-release-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))

function Get-Sha256([string]$Path) {
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToUpperInvariant()
}

function Get-CheckedWorkspacePath([string]$Path, [string]$WorkspaceRoot) {
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $rootPath = [System.IO.Path]::GetFullPath($WorkspaceRoot).TrimEnd('\')
    if (-not [string]::Equals($fullPath, $rootPath, [System.StringComparison]::OrdinalIgnoreCase) -and
        -not $fullPath.StartsWith($rootPath + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to access a runtime bundle path outside the PC workspace: $fullPath"
    }
    return $fullPath
}

function Assert-NoWorkspaceReparsePoints([string]$Path, [string]$WorkspaceRoot) {
    $cursor = Get-CheckedWorkspacePath $Path $WorkspaceRoot
    $rootPath = [System.IO.Path]::GetFullPath($WorkspaceRoot).TrimEnd('\')
    while ($true) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing to use a reparse point in the runtime bundle path: $cursor"
            }
        }
        if ([string]::Equals($cursor.TrimEnd('\'), $rootPath, [System.StringComparison]::OrdinalIgnoreCase)) {
            break
        }
        $parent = [System.IO.Path]::GetDirectoryName($cursor)
        if ([string]::IsNullOrWhiteSpace($parent) -or [string]::Equals($parent, $cursor, [System.StringComparison]::OrdinalIgnoreCase)) {
            break
        }
        $cursor = $parent
    }
}

function ConvertTo-CheckedRuntimeRelativePath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw 'The local SR runtime manifest contains an empty relative path.'
    }
    $normalized = $Path.Replace('\', '/')
    if ($normalized.StartsWith('/') -or $normalized.Contains(':') -or
        $normalized -match '(^|/)\.\.?(/|$)' -or $normalized.Contains('//')) {
        throw "The local SR runtime manifest contains an unsafe relative path: $Path"
    }
    return $normalized
}

function Install-VerifiedSrRuntimeBundle(
    [string]$WorkspaceRoot,
    [string]$RuntimeRoot,
    [string]$EvidencePath,
    [string]$ReleaseRoot,
    [string]$SetupScript
) {
    $runtimeRoot = Get-CheckedWorkspacePath $RuntimeRoot $WorkspaceRoot
    $manifestPath = Get-CheckedWorkspacePath (Join-Path $runtimeRoot 'install-manifest.json') $WorkspaceRoot
    $evidencePath = Get-CheckedWorkspacePath $EvidencePath $WorkspaceRoot
    $releaseRoot = Get-CheckedWorkspacePath $ReleaseRoot $WorkspaceRoot
    $destinationRoot = Get-CheckedWorkspacePath (Join-Path $releaseRoot 'data\sr') $WorkspaceRoot
    $setupScript = Get-CheckedWorkspacePath $SetupScript $WorkspaceRoot
    $setupCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$setupScript`""

    $expectedRuntimeFolders = @('realesrgan', 'realcugan')
    $missingRuntimeFolders = @($expectedRuntimeFolders | Where-Object {
        -not (Test-Path -LiteralPath (Join-Path $runtimeRoot $_) -PathType Container)
    })
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $evidencePath -PathType Leaf) -or
        $missingRuntimeFolders.Count -gt 0) {
        throw "The pinned local super-resolution runtime is missing or incomplete. Run this setup command manually, then rerun the Windows build: $setupCommand (the build script does not download runtimes)."
    }

    foreach ($path in @($runtimeRoot, $manifestPath, $evidencePath, $releaseRoot)) {
        Assert-NoWorkspaceReparsePoints $path $WorkspaceRoot
    }
    foreach ($folder in $expectedRuntimeFolders) {
        Assert-NoWorkspaceReparsePoints (Join-Path $runtimeRoot $folder) $WorkspaceRoot
    }

    try {
        $installManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        $evidence = Get-Content -LiteralPath $evidencePath -Raw | ConvertFrom-Json
    }
    catch {
        throw "Could not read the local SR install manifest or allowlist evidence: $($_.Exception.Message)"
    }
    if ($installManifest.schema_version -ne 1 -or $evidence.platform -ne 'Windows x64') {
        throw 'The local SR install manifest or evidence uses an unsupported schema/platform.'
    }

    $evidenceAssets = @($evidence.release_assets)
    $installPackages = @($installManifest.packages)
    if ($evidenceAssets.Count -ne 2 -or $installPackages.Count -ne 2) {
        throw 'The local SR allowlist and install manifest must contain exactly the two pinned Windows runtimes.'
    }
    $packagesById = @{}
    foreach ($package in $installPackages) {
        if ([string]::IsNullOrWhiteSpace([string]$package.id) -or $packagesById.ContainsKey([string]$package.id)) {
            throw 'The local SR install manifest contains a missing or duplicate package ID.'
        }
        $packagesById[[string]$package.id] = $package
    }

    $bundleFiles = @()
    foreach ($asset in $evidenceAssets) {
        $folderName = switch ([string]$asset.id) {
            'realesrgan-ncnn-vulkan' { 'realesrgan' }
            'realcugan-ncnn-vulkan' { 'realcugan' }
            default { throw "The local SR evidence contains an unapproved package ID: $($asset.id)" }
        }
        if (-not $packagesById.ContainsKey([string]$asset.id)) {
            throw "The local SR install manifest is missing package $($asset.id)."
        }
        $package = $packagesById[[string]$asset.id]
        if (-not [string]::Equals([string]$package.version, [string]$asset.version, [System.StringComparison]::Ordinal) -or
            -not [string]::Equals([string]$package.source, [string]$asset.url, [System.StringComparison]::Ordinal) -or
            -not [string]::Equals([string]$package.archive, [string]$asset.archive, [System.StringComparison]::Ordinal) -or
            [long]$package.archive_size -ne [long]$asset.size_bytes -or
            -not [string]::Equals(([string]$package.archive_sha256).ToUpperInvariant(), ([string]$asset.sha256).ToUpperInvariant(), [System.StringComparison]::Ordinal)) {
            throw "Pinned source/archive metadata does not match the evidence allowlist for $($asset.id)."
        }

        $expectedFiles = @{}
        foreach ($selectedFile in @($asset.selected_files)) {
            $relativePath = ConvertTo-CheckedRuntimeRelativePath ([string]$selectedFile.path)
            if ($expectedFiles.ContainsKey($relativePath)) {
                throw "The evidence allowlist contains a duplicate path for $($asset.id): $relativePath"
            }
            $expectedFiles[$relativePath] = [pscustomobject]@{
                size = [long]$selectedFile.size_bytes
                sha256 = ([string]$selectedFile.sha256).ToUpperInvariant()
            }
        }
        foreach ($licenseName in @($asset.license_files)) {
            if ([string]::IsNullOrWhiteSpace([string]$licenseName) -or
                ([string]$licenseName).Contains('/') -or ([string]$licenseName).Contains('\')) {
                throw "The evidence allowlist contains an unsafe license filename for $($asset.id)."
            }
            $licenseHashProperty = $evidence.license_file_sha256.PSObject.Properties[[string]$licenseName]
            if ($null -eq $licenseHashProperty) {
                throw "The evidence allowlist has no SHA-256 for license $licenseName."
            }
            $relativePath = "licenses/$licenseName"
            if ($expectedFiles.ContainsKey($relativePath)) {
                throw "The evidence allowlist contains a duplicate path for $($asset.id): $relativePath"
            }
            $expectedFiles[$relativePath] = [pscustomobject]@{
                size = $null
                sha256 = ([string]$licenseHashProperty.Value).ToUpperInvariant()
            }
            $manifestLicenseHash = $installManifest.license_sha256.PSObject.Properties[[string]$licenseName]
            if ($null -eq $manifestLicenseHash -or
                -not [string]::Equals(([string]$manifestLicenseHash.Value).ToUpperInvariant(), ([string]$licenseHashProperty.Value).ToUpperInvariant(), [System.StringComparison]::Ordinal)) {
                throw "Installed license hash does not match the evidence allowlist: $licenseName"
            }
        }

        $manifestFiles = @{}
        foreach ($fileRecord in @($package.installed_files)) {
            $relativePath = ConvertTo-CheckedRuntimeRelativePath ([string]$fileRecord.path)
            if ($manifestFiles.ContainsKey($relativePath)) {
                throw "The local SR install manifest contains a duplicate path for $($asset.id): $relativePath"
            }
            $manifestFiles[$relativePath] = $fileRecord
        }
        if ($manifestFiles.Count -ne $expectedFiles.Count) {
            throw "Installed file allowlist differs from evidence for $($asset.id): expected $($expectedFiles.Count), found $($manifestFiles.Count)."
        }

        $packageRoot = Get-CheckedWorkspacePath (Join-Path $runtimeRoot $folderName) $WorkspaceRoot
        $actualFiles = @(Get-ChildItem -LiteralPath $packageRoot -File -Recurse -Force)
        $allPackageItems = @(Get-ChildItem -LiteralPath $packageRoot -Recurse -Force)
        foreach ($item in $allPackageItems) {
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "The local SR package contains a reparse point: $($item.FullName)"
            }
        }
        if ($actualFiles.Count -ne $expectedFiles.Count) {
            throw "Runtime directory file count differs from its allowlist for $($asset.id): expected $($expectedFiles.Count), found $($actualFiles.Count)."
        }

        foreach ($relativePath in $expectedFiles.Keys) {
            if (-not $manifestFiles.ContainsKey($relativePath)) {
                throw "The install manifest omits an allowlisted file for $($asset.id): $relativePath"
            }
            $fileRecord = $manifestFiles[$relativePath]
            $allowlisted = $expectedFiles[$relativePath]
            $sourcePath = Get-CheckedWorkspacePath (Join-Path $packageRoot ($relativePath.Replace('/', '\'))) $WorkspaceRoot
            if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
                throw "An allowlisted local SR runtime file is missing: $sourcePath. Run the setup command manually, then rerun the Windows build: $setupCommand (the build script does not download runtimes)."
            }
            Assert-NoWorkspaceReparsePoints $sourcePath $WorkspaceRoot
            $sourceFile = Get-Item -LiteralPath $sourcePath
            $sourceHash = Get-Sha256 $sourcePath
            if ([long]$sourceFile.Length -ne [long]$fileRecord.size -or
                -not [string]::Equals($sourceHash, ([string]$fileRecord.sha256).ToUpperInvariant(), [System.StringComparison]::Ordinal) -or
                -not [string]::Equals($sourceHash, [string]$allowlisted.sha256, [System.StringComparison]::Ordinal) -or
                ($null -ne $allowlisted.size -and [long]$sourceFile.Length -ne [long]$allowlisted.size)) {
                throw "Local SR runtime file failed size/SHA-256 verification: $sourcePath"
            }
            $bundleFiles += [pscustomobject]@{
                source = $sourcePath
                destination = Get-CheckedWorkspacePath (Join-Path $destinationRoot (Join-Path $folderName ($relativePath.Replace('/', '\')))) $WorkspaceRoot
                size = [long]$sourceFile.Length
                sha256 = $sourceHash
            }
        }
    }

    $sourceManifestHash = Get-Sha256 $manifestPath
    $destinationManifest = Get-CheckedWorkspacePath (Join-Path $destinationRoot 'install-manifest.json') $WorkspaceRoot
    $allDestinations = @($bundleFiles) + @([pscustomobject]@{
        source = $manifestPath
        destination = $destinationManifest
        size = [long](Get-Item -LiteralPath $manifestPath).Length
        sha256 = $sourceManifestHash
    })
    $allowedDestinationFiles = @{}
    $allowedDestinationDirectories = @{}
    $destinationPrefixLength = $destinationRoot.TrimEnd('\').Length
    foreach ($file in $allDestinations) {
        $relativePath = $file.destination.Substring($destinationPrefixLength + 1).Replace('\', '/')
        $allowedDestinationFiles[$relativePath] = $true
        $parts = $relativePath.Split('/')
        $parent = ''
        for ($index = 0; $index -lt ($parts.Length - 1); $index++) {
            $parent = if ($parent.Length -eq 0) { $parts[$index] } else { "$parent/$($parts[$index])" }
            $allowedDestinationDirectories[$parent] = $true
        }
        Assert-NoWorkspaceReparsePoints $file.destination $WorkspaceRoot
        if (Test-Path -LiteralPath $file.destination) {
            if (-not (Test-Path -LiteralPath $file.destination -PathType Leaf)) {
                throw "A runtime bundle destination is not a file; preserving it: $($file.destination)"
            }
            $existing = Get-Item -LiteralPath $file.destination
            if ([long]$existing.Length -ne [long]$file.size -or
                -not [string]::Equals((Get-Sha256 $file.destination), [string]$file.sha256, [System.StringComparison]::Ordinal)) {
                throw "A different file already exists at a runtime bundle destination; preserving it: $($file.destination)"
            }
        }
    }

    if ((Test-Path -LiteralPath $destinationRoot) -and
        -not (Test-Path -LiteralPath $destinationRoot -PathType Container)) {
        throw "The Release SR bundle path is not a directory; preserving it: $destinationRoot"
    }
    if (Test-Path -LiteralPath $destinationRoot -PathType Container) {
        foreach ($existingItem in @(Get-ChildItem -LiteralPath $destinationRoot -Recurse -Force)) {
            if (($existingItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "The Release SR bundle contains a reparse point; preserving it: $($existingItem.FullName)"
            }
            $relativePath = $existingItem.FullName.Substring($destinationPrefixLength + 1).Replace('\', '/')
            if ($existingItem.PSIsContainer) {
                if (-not $allowedDestinationDirectories.ContainsKey($relativePath)) {
                    throw "The Release SR bundle contains an unapproved directory; preserving it: $($existingItem.FullName)"
                }
            }
            elseif (-not $allowedDestinationFiles.ContainsKey($relativePath)) {
                throw "The Release SR bundle contains an unapproved file; preserving it: $($existingItem.FullName)"
            }
        }
    }

    $null = New-Item -ItemType Directory -Force -Path $destinationRoot
    foreach ($file in $bundleFiles) {
        $null = New-Item -ItemType Directory -Force -Path (Split-Path -Path $file.destination -Parent)
        if (-not (Test-Path -LiteralPath $file.destination -PathType Leaf)) {
            Copy-Item -LiteralPath $file.source -Destination $file.destination
        }
        if ((Get-Item -LiteralPath $file.destination).Length -ne [long]$file.size -or
            -not [string]::Equals((Get-Sha256 $file.destination), [string]$file.sha256, [System.StringComparison]::Ordinal)) {
            throw "Copied local SR runtime file failed SHA-256 verification: $($file.destination)"
        }
    }
    if (-not (Test-Path -LiteralPath $destinationManifest -PathType Leaf)) {
        Copy-Item -LiteralPath $manifestPath -Destination $destinationManifest
    }
    if (-not [string]::Equals((Get-Sha256 $destinationManifest), $sourceManifestHash, [System.StringComparison]::Ordinal)) {
        throw 'Copied local SR install manifest does not match its verified source.'
    }
    Write-Host "Bundled verified local SR runtimes under $destinationRoot (downloads/staging excluded)."
    Write-Host "Runtime install manifest SHA-256: $sourceManifestHash"
}

try {
    if (Test-Path -LiteralPath $junctionPath) {
        $link = Get-Item -LiteralPath $junctionPath -Force
        if (($link.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) {
            throw "Refusing to use or replace a non-link path: $junctionPath"
        }

        $target = @($link.Target | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) | Select-Object -First 1
        if (-not $target) {
            throw "Cannot verify the existing directory link target: $junctionPath"
        }
        $targetFullPath = [System.IO.Path]::GetFullPath($target).TrimEnd('\')
        if (-not [string]::Equals($targetFullPath, $projectRoot.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "The existing directory link points somewhere else: $junctionPath -> $targetFullPath"
        }
    }
    else {
        New-Item -ItemType Junction -Path $junctionPath -Target $projectRoot | Out-Null
        $junctionCreated = $true
    }

    $occupiedDrives = @{}
    foreach ($root in [System.Environment]::GetLogicalDrives()) {
        $occupiedDrives[$root.Substring(0, 1).ToUpperInvariant()] = $true
    }
    foreach ($psDrive in Get-PSDrive -PSProvider FileSystem) {
        if ($psDrive.Name.Length -eq 1) {
            $occupiedDrives[$psDrive.Name.ToUpperInvariant()] = $true
        }
    }

    foreach ($candidate in @('Z','Y','X','V','U','T','S','R','Q','P','O','N','M','L','K','J','I','H','G','F','E','D')) {
        if (-not $occupiedDrives.ContainsKey($candidate)) {
            $driveLetter = $candidate
            break
        }
    }
    if (-not $driveLetter) {
        throw 'No free drive letter is available for the temporary ASCII build path.'
    }

    $substExe = Join-Path $env:SystemRoot 'System32\subst.exe'
    & $substExe ("${driveLetter}:") $temporaryRoot
    if ($LASTEXITCODE -ne 0) {
        throw "Could not map ${driveLetter}: to the PC workspace temporary directory."
    }
    $driveCreated = $true

    $projectAlias = "${driveLetter}:\windows-build-source"
    if (-not (Test-Path -LiteralPath $projectAlias -PathType Container)) {
        throw "The temporary ASCII project path is unavailable: $projectAlias"
    }

    $env:PUB_CACHE = Join-Path $projectAlias '.tmp\pub-cache'
    Push-Location -LiteralPath $projectAlias
    $locationPushed = $true

    $windowsBuildDirectory = Join-Path $projectRoot 'build\windows'
    $cmakeCache = Join-Path $windowsBuildDirectory 'x64\CMakeCache.txt'
    if (Test-Path -LiteralPath $cmakeCache -PathType Leaf) {
        $cacheLine = Get-Content -LiteralPath $cmakeCache | Where-Object { $_ -like 'CMAKE_HOME_DIRECTORY:INTERNAL=*' } | Select-Object -First 1
        if ($cacheLine) {
            $cachedSource = $cacheLine.Substring('CMAKE_HOME_DIRECTORY:INTERNAL='.Length).Replace('/', '\').TrimEnd('\')
            $expectedSource = (Join-Path $projectAlias 'windows').Replace('/', '\').TrimEnd('\')
            if (-not [string]::Equals($cachedSource, $expectedSource, [System.StringComparison]::OrdinalIgnoreCase)) {
                $resolvedBuildDirectory = (Resolve-Path -LiteralPath $windowsBuildDirectory).Path.TrimEnd('\')
                $resolvedProjectRoot = (Resolve-Path -LiteralPath $projectRoot).Path.TrimEnd('\')
                if (-not $resolvedBuildDirectory.StartsWith($resolvedProjectRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
                    throw "Refusing to move a build directory outside the PC workspace: $resolvedBuildDirectory"
                }
                $backupPath = Join-Path $temporaryRoot ("windows-cache-backup-{0}" -f (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
                if (Test-Path -LiteralPath $backupPath) {
                    throw "Refusing to overwrite an existing build cache backup: $backupPath"
                }
                Move-Item -LiteralPath $windowsBuildDirectory -Destination $backupPath
                Write-Host "Preserved the prior Windows build cache at $backupPath (source path changed from $cachedSource)."
            }
        }
    }

    Write-Host "Building Windows Release from $projectAlias"
    Write-Host "Flutter: $FlutterPath"
    Write-Host "Log: $logPath"

    $developmentData = Join-Path $projectRoot 'data\desktop'
    $developmentDataBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($developmentData))
    # Flutter 3.47.7's Windows asset target can reuse an old icon subset after
    # Dart-only changes (its inputs omit app.dill). Ship the complete 1.6 MiB
    # Material font so newly added controls cannot silently lose their icons.
    & $FlutterPath build windows --release --no-pub --no-tree-shake-icons "--dart-define=WORLDPAINTER_DATA_DIR_BASE64=$developmentDataBase64" --verbose 2>&1 | Tee-Object -FilePath $logPath
    $buildExitCode = $LASTEXITCODE
    if ($buildExitCode -ne 0) {
        throw "Flutter Windows Release build failed with exit code $buildExitCode. See $logPath"
    }

    $artifactPath = Join-Path $projectRoot 'build\windows\x64\runner\Release\worldpainter_pc.exe'
    if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) {
        throw "Flutter reported success, but the expected executable was not found: $artifactPath"
    }
    $artifact = Get-Item -LiteralPath $artifactPath
    Write-Host "Windows Release executable: $($artifact.FullName) ($($artifact.Length) bytes)"

    $fontLicenseSource = Join-Path $projectRoot 'assets\fonts\OFL.txt'
    $fontLicenseBundle = Join-Path $projectRoot 'build\windows\x64\runner\Release\data\flutter_assets\assets\fonts\OFL.txt'
    if (-not (Test-Path -LiteralPath $fontLicenseSource -PathType Leaf)) {
        throw "The Noto Sans SC font license source is missing: $fontLicenseSource"
    }
    if (-not (Test-Path -LiteralPath $fontLicenseBundle -PathType Leaf)) {
        throw "The Windows Release bundle does not contain the Noto Sans SC font license: $fontLicenseBundle"
    }
    $sourceLicenseHash = (Get-FileHash -LiteralPath $fontLicenseSource -Algorithm SHA256).Hash
    $bundleLicenseHash = (Get-FileHash -LiteralPath $fontLicenseBundle -Algorithm SHA256).Hash
    if (-not [string]::Equals($sourceLicenseHash, $bundleLicenseHash, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "The bundled font license does not match its source. Source SHA-256: $sourceLicenseHash; bundle SHA-256: $bundleLicenseHash"
    }
    Write-Host "Bundled font license SHA-256: $bundleLicenseHash"

    Install-VerifiedSrRuntimeBundle `
        -WorkspaceRoot $projectRoot `
        -RuntimeRoot (Join-Path $temporaryRoot 'sr-runtime') `
        -EvidencePath (Join-Path $projectRoot 'docs\evidence\local-sr-runtime-manifest.json') `
        -ReleaseRoot (Join-Path $projectRoot 'build\windows\x64\runner\Release') `
        -SetupScript (Join-Path $projectRoot 'scripts\setup-super-resolution.ps1')
}
finally {
    if ($locationPushed) {
        Pop-Location
    }
    if ($hadPubCache) {
        $env:PUB_CACHE = $oldPubCache
    }
    else {
        Remove-Item Env:PUB_CACHE -ErrorAction SilentlyContinue
    }
    if ($driveCreated) {
        & (Join-Path $env:SystemRoot 'System32\subst.exe') ("${driveLetter}:") /d
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Could not remove the temporary ${driveLetter}: mapping."
        }
    }
    if ($junctionCreated -and (Test-Path -LiteralPath $junctionPath)) {
        Remove-Item -LiteralPath $junctionPath -Force
    }
}
