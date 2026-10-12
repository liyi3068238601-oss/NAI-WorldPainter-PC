param([string]$ExecutablePath)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not $ExecutablePath) { $ExecutablePath = Join-Path $repo 'build\windows\x64\runner\Release\worldpainter_pc.exe' }
$runKey = [Guid]::NewGuid().ToString('D')
$reports = Join-Path $repo '.tmp\credential-probe'
New-Item -ItemType Directory -Force -Path $reports | Out-Null
$results = @()
foreach ($phase in @('write', 'read')) {
  $out = Join-Path $reports "$runKey-$phase.txt"
  $err = Join-Path $reports "$runKey-$phase-error.txt"
  $process = Start-Process -FilePath $ExecutablePath -ArgumentList @('--storage-probe', '--credential-probe', "--phase=$phase", "--run-key=$runKey") -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
  $null = $process.Handle
  if (-not $process.WaitForExit(30000)) {
    $process.Kill()
    throw 'Credential probe timed out.'
  }
  $process.Refresh()
  $body = Get-Content -LiteralPath $out -Raw -Encoding UTF8
  if ($process.ExitCode -ne 0 -or $body -notmatch "CREDENTIAL_PROBE phase=$phase result=PASS") { throw "Credential $phase probe failed; see $reports" }
  $results += @{phase=$phase; passed=$true; exitCode=$process.ExitCode}
}
@{runKey=$runKey; phases=$results; syntheticCredentialRemoved=$true} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $reports "$runKey.json") -Encoding UTF8
$results | ConvertTo-Json
