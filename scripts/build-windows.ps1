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
    & $FlutterPath build windows --release --no-pub "--dart-define=WORLDPAINTER_DATA_DIR_BASE64=$developmentDataBase64" --verbose 2>&1 | Tee-Object -FilePath $logPath
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
