#requires -Version 5.1
[CmdletBinding()]
param([string]$FlutterPath)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ([string]::IsNullOrWhiteSpace($FlutterPath)) {
    $FlutterPath = Join-Path $projectRoot '..\.tools\flutter\bin\flutter.bat'
}
$flutterBin = Split-Path ([IO.Path]::GetFullPath($FlutterPath))
$dart = Join-Path $flutterBin 'dart.bat'
$oldPath = $env:PATH
$oldCache = $env:PUB_CACHE
$drive = $null
$pushed = $false
try {
    # Dart's AOT build runner cannot write its output in this toolchain's
    # Chinese path. A temporary drive alias keeps all files inside PC端.
    foreach ($letter in @('T', 'U', 'V', 'W', 'X', 'Y', 'Z')) {
        if (-not (Test-Path "${letter}:\")) { $drive = "${letter}:"; break }
    }
    if (-not $drive) { throw 'No free temporary drive letter.' }
    & subst.exe $drive $projectRoot
    if ($LASTEXITCODE -ne 0) { $drive = $null; throw 'Could not create path alias.' }
    $env:PUB_CACHE = Join-Path $projectRoot '.tmp\pub-cache'
    $env:PATH = "$flutterBin;$oldPath"
    Push-Location "$drive\"
    $pushed = $true
    & $dart run sqflite_common_ffi_web:setup --no-sqlite3-wasm "$drive\"
    if ($LASTEXITCODE -ne 0) { throw 'SQLite SharedWorker build failed.' }
    # Version 1.2.0 setup defaults to SQLite 3.6.0 and ignores its URL override.
    # Fetch the asset matching our locked Dart sqlite3 version explicitly.
    $asset = Join-Path $projectRoot 'web\sqlite3.wasm'
    Invoke-WebRequest -Uri 'https://github.com/simolus3/sqlite3.dart/releases/download/sqlite3-3.7.0/sqlite3.wasm' -OutFile $asset
    $expected = 'FBCD2E8214F9231EA961E1B7706A22DD1194CFBFE6F26F13841B5AA7A0BE1A1F'
    if ((Get-FileHash -LiteralPath $asset -Algorithm SHA256).Hash -ne $expected) {
        throw 'SQLite WASM checksum mismatch; do not build or publish this asset.'
    }
    Write-Host 'SQLite preview assets ready. Build Web next; use a fixed preview port.'
}
finally {
    if ($pushed) { Pop-Location }
    $env:PATH = $oldPath
    $env:PUB_CACHE = $oldCache
    if ($drive) { & subst.exe $drive /d }
}
