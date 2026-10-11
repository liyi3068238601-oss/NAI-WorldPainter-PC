#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$ExecutablePath,
    [ValidateRange(1, 60)]
    [int]$TimeoutSeconds = 60
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ExecutablePath)) {
    $ExecutablePath = Join-Path $PSScriptRoot '..\build\windows\x64\runner\Release\worldpainter_pc.exe'
}

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$temporaryRoot = Join-Path $projectRoot '.tmp'
$probeRoot = Join-Path $temporaryRoot 'windows-storage-probe'
$reportDirectory = Join-Path $probeRoot 'reports'
$executable = [System.IO.Path]::GetFullPath($ExecutablePath)

if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw "Windows probe executable not found: $executable"
}
if (-not (Test-Path -LiteralPath $temporaryRoot -PathType Container)) {
    New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
}

$resolvedProjectRoot = (Resolve-Path -LiteralPath $projectRoot).Path.TrimEnd('\')
$resolvedTemporaryRoot = (Resolve-Path -LiteralPath $temporaryRoot).Path.TrimEnd('\')

function Assert-WithinDirectory([string]$Root, [string]$Path) {
    $resolvedPath = (Resolve-Path -LiteralPath $Path).Path.TrimEnd('\')
    $prefix = $Root.TrimEnd('\') + '\'
    if (-not $resolvedPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to write outside the PC workspace temporary directory: $resolvedPath"
    }
    return $resolvedPath
}

if (-not $resolvedTemporaryRoot.StartsWith(($resolvedProjectRoot + '\'), [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to use a .tmp directory outside the PC workspace: $resolvedTemporaryRoot"
}

if (-not (Test-Path -LiteralPath $probeRoot -PathType Container)) {
    New-Item -ItemType Directory -Path $probeRoot | Out-Null
}
$probeRoot = Assert-WithinDirectory $resolvedTemporaryRoot $probeRoot
$reportDirectory = Join-Path $probeRoot 'reports'
if (-not (Test-Path -LiteralPath $reportDirectory -PathType Container)) {
    New-Item -ItemType Directory -Path $reportDirectory | Out-Null
}
$reportDirectory = Assert-WithinDirectory $probeRoot $reportDirectory

$runId = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$dataDirectory = Join-Path $probeRoot ("绘世数据 {0}" -f $runId)
$writeReportPath = Join-Path $reportDirectory ("{0}-write.json" -f $runId)
$readReportPath = Join-Path $reportDirectory ("{0}-read.json" -f $runId)

function Assert-InTemporaryRoot([string]$Path) {
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $prefix = $resolvedTemporaryRoot.TrimEnd('\') + '\'
    if (-not $fullPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to write outside PC端\.tmp: $fullPath"
    }
    return $fullPath
}

$dataDirectory = Assert-InTemporaryRoot $dataDirectory
$writeReportPath = Assert-InTemporaryRoot $writeReportPath
$readReportPath = Assert-InTemporaryRoot $readReportPath

function Invoke-ProbePhase([string]$Phase, [string]$ReportPath) {
    $stdoutPath = Join-Path $reportDirectory ("{0}-{1}.stdout.log" -f $runId, $Phase)
    $stderrPath = Join-Path $reportDirectory ("{0}-{1}.stderr.log" -f $runId, $Phase)
    $argumentLine = '--storage-probe --phase={0} --data-dir="{1}" --report="{2}"' -f $Phase, $dataDirectory, $ReportPath

    Write-Host "Running hidden Windows storage probe phase '$Phase'."
    $process = Start-Process -FilePath $executable -ArgumentList $argumentLine -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    $processHandle = $process.Handle
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    $timeoutMilliseconds = $TimeoutSeconds * 1000

    while (-not $process.HasExited) {
        $process.Refresh()
        if ($process.HasExited) {
            break
        }

        if (Test-Path -LiteralPath $ReportPath -PathType Leaf) {
            try {
                $earlyReport = Get-Content -LiteralPath $ReportPath -Raw -Encoding UTF8 | ConvertFrom-Json
                if ($earlyReport.ok -eq $false) {
                    $process.Kill()
                    $process.WaitForExit()
                    throw "Probe phase '$Phase' failed: $($earlyReport.error)"
                }
            }
            catch {
                if ($_.Exception.Message -like "Probe phase '$Phase' failed:*") {
                    throw
                }
                # The report may still be in the middle of its atomic write.
            }
        }

        if ($timer.ElapsedMilliseconds -ge $timeoutMilliseconds) {
            $process.Kill()
            $process.WaitForExit()
            throw "Probe phase '$Phase' did not exit within $TimeoutSeconds seconds. Reports and process logs are under $probeRoot."
        }
        Start-Sleep -Milliseconds 250
    }

    $process.WaitForExit()
    $process.Refresh()
    $exitCode = $process.ExitCode
    if ($exitCode -ne 0) {
        $detail = ''
        if (Test-Path -LiteralPath $ReportPath -PathType Leaf) {
            try {
                $failedReport = Get-Content -LiteralPath $ReportPath -Raw -Encoding UTF8 | ConvertFrom-Json
                $detail = " Report: $($failedReport.error)"
            }
            catch {
                $detail = ' The phase report could not be parsed.'
            }
        }
        throw "Probe phase '$Phase' exited with code $exitCode.$detail Logs are under $probeRoot."
    }
    if (-not (Test-Path -LiteralPath $ReportPath -PathType Leaf)) {
        throw "Probe phase '$Phase' exited successfully without writing its report. Logs are under $probeRoot."
    }

    $report = Get-Content -LiteralPath $ReportPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($report.ok -ne $true -or $report.phase -ne $Phase) {
        throw "Probe phase '$Phase' returned an invalid report: $ReportPath"
    }
    return $report
}

$writeReport = Invoke-ProbePhase 'write' $writeReportPath
$readReport = Invoke-ProbePhase 'read' $readReportPath

if ($writeReport.databasePath -ne $readReport.databasePath -or
    $writeReport.revision -ne $readReport.revision -or
    $writeReport.imagePath -ne $readReport.imagePath -or
    $writeReport.imageSha256 -ne $readReport.imageSha256) {
    throw "The write and read processes did not report matching persisted values. Reports: $writeReportPath and $readReportPath"
}

Write-Host "Windows storage probe passed for SQLite persistence, Unicode paths, and PNG SHA-256."
Write-Host "Database: $($readReport.databasePath)"
Write-Host "Image SHA-256: $($readReport.imageSha256)"
Write-Host "Reports: $writeReportPath ; $readReportPath"
