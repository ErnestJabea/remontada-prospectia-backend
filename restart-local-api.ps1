$ErrorActionPreference = 'Stop'
$apiDirectory = $PSScriptRoot
$healthUrl = 'http://127.0.0.1:3012/api/v1/health'
function Get-ListeningApiPids {
    # netstat remains available when Windows denies Get-NetTCPConnection.
    netstat -ano -p tcp | ForEach-Object {
        if ($_ -match '^\s*TCP\s+\S+:3012\s+\S+\s+LISTENING\s+(\d+)\s*$') { [int]$Matches[1] }
    } | Sort-Object -Unique
}
$apiProcessIds = @(Get-ListeningApiPids)
if ($apiProcessIds.Count -gt 0) {
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 5
    if ($health.service -ne 'ERP Remontada Prospectia API' -or $health.status -ne 'ok') {
        throw 'Le port 3012 ne correspond pas a une API Remontada saine. Aucun processus arrete.'
    }
    if ($apiProcessIds.Count -ne 1) { throw 'Plusieurs processus sur le port 3012. Aucun processus arrete.' }
    $apiProcess = Get-Process -Id $apiProcessIds[0]
    if ($apiProcess.ProcessName -ne 'node') { throw 'Le processus ne correspond pas a Node.js. Aucun processus arrete.' }
    Stop-Process -Id $apiProcess.Id -ErrorAction Stop
    Wait-Process -Id $apiProcess.Id -Timeout 10 -ErrorAction SilentlyContinue
}
$nodePath = (Get-Command node -ErrorAction Stop).Source
$startedApi = Start-Process -FilePath $nodePath -ArgumentList 'server.js' -WorkingDirectory $apiDirectory -WindowStyle Hidden -RedirectStandardOutput (Join-Path $apiDirectory 'analytics-server.out.log') -RedirectStandardError (Join-Path $apiDirectory 'analytics-server.err.log') -PassThru
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 500
    $startedApi.Refresh()
    if ($startedApi.HasExited) { throw "L'API s'est arretee. Consulter analytics-server.err.log." }
    $currentListeners = @(Get-ListeningApiPids)
    if ($currentListeners.Count -ne 1 -or $currentListeners[0] -ne $startedApi.Id) { continue }
    try { $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2 } catch { continue }
    if ($health.status -eq 'ok' -and $health.service -eq 'ERP Remontada Prospectia API') {
        Write-Host "API Remontada redemarree sur le port 3012 (PID $($startedApi.Id)). Rechargez le backoffice."
        exit 0
    }
}
throw "L'API ne repond pas encore. Consulter analytics-server.err.log."
