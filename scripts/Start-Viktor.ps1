$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$node = Join-Path $root "runtime\node.exe"
$server = Join-Path $root "src\server.js"
$uri = "http://127.0.0.1:4173"
$updater = Join-Path $root "scripts\Update-Viktor.ps1"

if (-not (Test-Path -LiteralPath $node) -or -not (Test-Path -LiteralPath $server)) {
    throw "VIKTOR ist unvollständig installiert. Führe scripts\install.ps1 erneut aus."
}

$status = $null
try {
    $status = Invoke-RestMethod -Uri "$uri/api/status" -TimeoutSec 2
} catch {
    Write-Host "Viktor ist noch nicht gestartet."
}

if (Test-Path -LiteralPath $updater) {
    $updateArguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $updater, "-Root", $root)
    if ($status) { $updateArguments += "-CheckOnly" }
    & (Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe") @updateArguments
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Die Updateprüfung ist fehlgeschlagen. Viktor startet mit der bisherigen Version."
        Add-Type -AssemblyName System.Windows.Forms
        [void][System.Windows.Forms.MessageBox]::Show(
            "Die GitHub-Updateprüfung ist fehlgeschlagen. Viktor startet mit der bisherigen Version. Details stehen im Startfenster.",
            "VIKTOR - Update",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Warning
        )
    }
}

if (-not $status) {
    Start-Process -FilePath $node -ArgumentList "`"$server`"" -WorkingDirectory $root
}

$deadline = (Get-Date).AddSeconds(30)
do {
    try {
        $status = Invoke-RestMethod -Uri "$uri/api/status" -TimeoutSec 2
        if ($status.model -and $status.workspace) { break }
    } catch {
        Start-Sleep -Seconds 1
    }
} while ((Get-Date) -lt $deadline)

if (-not $status -or -not $status.model -or -not $status.workspace) {
    throw "VIKTOR konnte nicht gestartet werden. Prüfe, ob Port 4173 bereits von einem anderen Programm verwendet wird."
}

Start-Process $uri
Write-Host "VIKTOR läuft unter $uri. Zum Beenden schließe das VIKTOR-Serverfenster."
