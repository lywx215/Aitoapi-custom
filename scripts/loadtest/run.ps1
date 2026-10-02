param(
    [ValidateSet('full','calibrate','explore','capacity','wave','sustain','report','status','recover','debug-wave','collect')]
    [string]$Action = 'full',
    [Parameter(Mandatory=$true)][string]$OutputDir,
    [string]$Profile = '',
    [ValidateRange(1,300)][int]$Concurrency = 1,
    [ValidateSet('sse','json')][string]$Mode = 'sse',
    [ValidateSet('analysis','verbatim')][string]$Workload = 'analysis',
    [ValidateSet('response','tokens')][string]$SuccessMetric = 'response'
)
$ErrorActionPreference = 'Stop'
$aitoProcess = $null
$aitoModelRef = $null
$aitoManagementRef = $null
try {
    $aitoModelRef = & 'C:\Users\lywx2\.codex\private\aitoapi\credentials.ps1' -Action Get
    $aitoManagementRef = & 'C:\Users\lywx2\.codex\private\aitoapi\credentials.ps1' -Action Get -Purpose ManagementApi
    $aitoStartInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $aitoStartInfo.FileName = (Get-Command node -ErrorAction Stop).Source
    $aitoStartInfo.UseShellExecute = $false
    $aitoStartInfo.CreateNoWindow = $true
    $aitoStartInfo.RedirectStandardInput = $true
    $aitoStartInfo.WorkingDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
    $aitoEntryScript = if ($Action -eq 'collect') { 'collect.js' } else { 'runner.js' }
    foreach ($aitoArgument in @((Join-Path $PSScriptRoot $aitoEntryScript),'--action',$Action,'--output-dir',[IO.Path]::GetFullPath($OutputDir),'--profile',$Profile,'--concurrency',"$Concurrency",'--mode',$Mode,'--workload',$Workload,'--success-metric',$SuccessMetric)) {
        $aitoStartInfo.ArgumentList.Add($aitoArgument)
    }
    $aitoProcess = [System.Diagnostics.Process]::new()
    $aitoProcess.StartInfo = $aitoStartInfo
    if (-not $aitoProcess.Start()) { throw 'loadtest_process_start_failed' }
    # Decrypted keys only cross an anonymous process pipe, never arguments or files.
    $aitoSecretEnvelope = @{
        modelKey = $aitoModelRef.ModelApiCredential.GetNetworkCredential().Password
        managementKey = $aitoManagementRef.ManagementApiCredential.GetNetworkCredential().Password
    } | ConvertTo-Json -Compress
    $aitoProcess.StandardInput.WriteLine($aitoSecretEnvelope)
    $aitoProcess.StandardInput.Close()
    $aitoSecretEnvelope = $null
    $aitoModelRef = $null
    $aitoManagementRef = $null
    $aitoProcess.WaitForExit()
    exit $aitoProcess.ExitCode
} catch {
    # Never surface process/HTTP exception text that could contain credentials.
    Write-Error 'Load-test launcher failed; no credential details are emitted.'
    exit 1
} finally {
    $aitoModelRef = $null
    $aitoManagementRef = $null
    if ($aitoProcess) { $aitoProcess.Dispose() }
}
