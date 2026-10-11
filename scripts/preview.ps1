param(
    [int]$Port = 5080,
    [switch]$Build,
    [string]$Flutter = '',
    [string]$Python = ''
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
if ($Build -and -not $Flutter) {
    $Flutter = Join-Path (Split-Path $projectRoot -Parent) '.tools\flutter\bin\flutter.bat'
    if (-not (Test-Path -LiteralPath $Flutter)) { $Flutter = (Get-Command flutter).Source }
}
if (-not $Python) {
    $Python = Join-Path $projectRoot '.venv\Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $Python)) { $Python = (Get-Command python).Source }
}
Push-Location -LiteralPath $projectRoot
$originalCache = $env:PUB_CACHE
try {
    $env:PUB_CACHE = Join-Path $projectRoot '.tmp\pub-cache'
    if ($Build) {
        & $Flutter pub get
        if ($LASTEXITCODE -ne 0) { throw 'Flutter dependency resolution failed.' }
        & $Flutter build web --release --no-web-resources-cdn --no-wasm-dry-run --no-pub
        if ($LASTEXITCODE -ne 0) { throw 'Flutter web build failed.' }
    }
    if (-not (Test-Path -LiteralPath 'build\web\index.html')) {
        throw 'No preview build found. Run this script with -Build first.'
    }
    Write-Host "Prototype: http://127.0.0.1:$Port/ (Ctrl+C to stop)"
    & $Python -m http.server $Port --bind 127.0.0.1 --directory build/web
} finally {
    $env:PUB_CACHE = $originalCache
    Pop-Location
}
