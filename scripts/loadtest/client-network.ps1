param(
    [Parameter(Mandatory = $true)][string]$OutputDir,
    [ValidateRange(0, 43200)][int]$DurationSeconds = 0
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$artifactRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../artifacts/loadtest'))
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDir)
$allowedPrefix = $artifactRoot.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
if (-not $resolvedOutput.StartsWith($allowedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'output_directory_outside_artifacts'
}
[void][System.IO.Directory]::CreateDirectory($resolvedOutput)
$outputPath = Join-Path $resolvedOutput 'client-network.jsonl'
$stopPath = Join-Path $resolvedOutput 'STOP-COLLECTORS'
$utf8 = [System.Text.UTF8Encoding]::new($false)
$previousAdapters = @{}
$previousSampleMs = $null
$clock = [System.Diagnostics.Stopwatch]::StartNew()

function Get-InterfaceHash([string]$InterfaceName) {
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
        $digest = $hasher.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($InterfaceName))
        return ([System.BitConverter]::ToString($digest).Replace('-', '').ToLowerInvariant()).Substring(0, 16)
    }
    finally {
        $hasher.Dispose()
    }
}

while (-not [System.IO.File]::Exists($stopPath)) {
    if ($DurationSeconds -gt 0 -and $clock.Elapsed.TotalSeconds -ge $DurationSeconds) { break }
    $cycleStartedMs = $clock.Elapsed.TotalMilliseconds
    $record = [ordered]@{
        time = [DateTimeOffset]::UtcNow.ToString('o')
        source = 'windows_get_net_adapter_statistics'
        intervalMs = if ($null -eq $previousSampleMs) { $null } else { $cycleStartedMs - $previousSampleMs }
        scope = 'whole_system_interfaces'
        processAttributed = $false
        interfaceOverlapPossible = $true
        addressesStored = $false
        interfaceNamesStored = $false
        limit = 'Includes all system traffic; virtual and physical interfaces may count the same traffic more than once.'
        adapters = @()
        totals = $null
        missing = @()
    }
    try {
        $statistics = @(Get-NetAdapterStatistics -ErrorAction Stop)
        $currentAdapters = @{}
        $receivedSum = [double]0
        $sentSum = [double]0
        $receivedDeltaSum = [double]0
        $sentDeltaSum = [double]0
        $deltaAdapterCount = 0
        foreach ($adapter in $statistics) {
            $identityHash = Get-InterfaceHash ([string]$adapter.Name)
            $received = [double]$adapter.ReceivedBytes
            $sent = [double]$adapter.SentBytes
            $item = [ordered]@{
                identityHash = $identityHash
                receivedBytes = $received
                sentBytes = $sent
                deltaReceivedBytes = $null
                deltaSentBytes = $null
                receivedBytesPerSecond = $null
                sentBytesPerSecond = $null
                counterReset = $false
            }
            if ($previousAdapters.ContainsKey($identityHash) -and $record.intervalMs -gt 0) {
                $previous = $previousAdapters[$identityHash]
                $receivedDelta = $received - $previous.received
                $sentDelta = $sent - $previous.sent
                if ($receivedDelta -lt 0 -or $sentDelta -lt 0) {
                    $item.counterReset = $true
                }
                else {
                    $item.deltaReceivedBytes = $receivedDelta
                    $item.deltaSentBytes = $sentDelta
                    $item.receivedBytesPerSecond = $receivedDelta * 1000 / $record.intervalMs
                    $item.sentBytesPerSecond = $sentDelta * 1000 / $record.intervalMs
                    $receivedDeltaSum += $receivedDelta
                    $sentDeltaSum += $sentDelta
                    $deltaAdapterCount++
                }
            }
            $currentAdapters[$identityHash] = @{ received = $received; sent = $sent }
            $receivedSum += $received
            $sentSum += $sent
            $record.adapters += [pscustomobject]$item
        }
        $record.totals = [ordered]@{
            adapterCount = $statistics.Count
            deltaAdapterCount = $deltaAdapterCount
            receivedBytes = $receivedSum
            sentBytes = $sentSum
            deltaReceivedBytes = if ($deltaAdapterCount -gt 0) { $receivedDeltaSum } else { $null }
            deltaSentBytes = if ($deltaAdapterCount -gt 0) { $sentDeltaSum } else { $null }
            receivedBytesPerSecond = if ($deltaAdapterCount -gt 0) { $receivedDeltaSum * 1000 / $record.intervalMs } else { $null }
            sentBytesPerSecond = if ($deltaAdapterCount -gt 0) { $sentDeltaSum * 1000 / $record.intervalMs } else { $null }
            deltaComplete = $deltaAdapterCount -eq $statistics.Count -and $statistics.Count -gt 0
        }
        if ($statistics.Count -eq 0) { $record.missing = @('network_interfaces_empty') }
        elseif ($null -eq $previousSampleMs) { $record.missing = @('rate_requires_second_sample') }
        elseif ($deltaAdapterCount -ne $statistics.Count) { $record.missing = @('interface_delta_incomplete_or_counter_reset') }
        $previousAdapters = $currentAdapters
        $previousSampleMs = $cycleStartedMs
    }
    catch {
        # Never emit native exception details: they can contain interface identifiers.
        $record.missing = @('network_counters_unavailable')
        $record.errorCode = 'network_counters_unavailable'
    }
    $record.collectedAt = [DateTimeOffset]::UtcNow.ToString('o')
    [System.IO.File]::AppendAllText($outputPath, (($record | ConvertTo-Json -Depth 7 -Compress) + "`n"), $utf8)
    Write-Output (([ordered]@{ event = 'client_network_sample'; time = $record.time; adapterCount = $record.adapters.Count; missing = $record.missing } | ConvertTo-Json -Compress))
    while ($clock.Elapsed.TotalMilliseconds - $cycleStartedMs -lt 5000) {
        if ([System.IO.File]::Exists($stopPath)) { break }
        if ($DurationSeconds -gt 0 -and $clock.Elapsed.TotalSeconds -ge $DurationSeconds) { break }
        Start-Sleep -Milliseconds 250
    }
}

Write-Output (([ordered]@{ event = 'client_network_finished'; time = [DateTimeOffset]::UtcNow.ToString('o'); elapsedSeconds = $clock.Elapsed.TotalSeconds } | ConvertTo-Json -Compress))
