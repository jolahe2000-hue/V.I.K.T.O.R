param(
    [string]$InstallPath = (Join-Path $env:LOCALAPPDATA "Programs\Viktor"),
    [string]$GitHubRepository = ""
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$sourceRoot = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $sourceRoot "package.json") -Raw | ConvertFrom-Json).version
$model = "qwen3:4b"
$installRoot = [IO.Path]::GetFullPath($InstallPath).TrimEnd('\')
$temporaryRoot = Join-Path $installRoot (".install-" + [Guid]::NewGuid().ToString("N"))
$script:lastOllamaProbeError = ""

function Confirm-Action([string]$message) {
    while ($true) {
        $answer = (Read-Host "$message [J/N]").Trim().ToLowerInvariant()
        if ($answer -in @("j", "ja", "y", "yes")) { return $true }
        if ($answer -in @("n", "nein", "no")) { return $false }
        Write-Host "Bitte mit J oder N antworten."
    }
}

function Assert-FreeSpace([string]$path, [long]$requiredBytes, [string]$description) {
    $fullPath = [IO.Path]::GetFullPath($path)
    $driveRoot = [IO.Path]::GetPathRoot($fullPath)
    $drive = [IO.DriveInfo]::new($driveRoot)
    if ($drive.AvailableFreeSpace -lt $requiredBytes) {
        $available = [Math]::Round($drive.AvailableFreeSpace / 1GB, 1)
        $required = [Math]::Round($requiredBytes / 1GB, 1)
        throw "Zu wenig freier Speicherplatz für $description auf $driveRoot. Verfügbar: $available GB; benötigt: mindestens $required GB."
    }
}

function Get-OllamaPath {
    $command = Get-Command "ollama.exe" -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $candidate = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"
    if (Test-Path -LiteralPath $candidate) { return $candidate }
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    foreach ($directory in ($userPath -split ';')) {
        if (-not $directory.Trim()) { continue }
        $candidate = Join-Path ([Environment]::ExpandEnvironmentVariables($directory.Trim())) "ollama.exe"
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    return $null
}

function Get-InstalledModels {
    try {
        $script:lastOllamaProbeError = ""
        return (Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 3).models
    } catch {
        $script:lastOllamaProbeError = $_.Exception.Message
        return $null
    }
}

if (-not [Environment]::Is64BitOperatingSystem -or
    ($env:PROCESSOR_ARCHITECTURE -ne "AMD64" -and $env:PROCESSOR_ARCHITEW6432 -ne "AMD64")) {
    throw "Dieses Installationspaket benötigt Windows auf x64-Hardware."
}
if (-not $env:LOCALAPPDATA -or -not $env:TEMP) {
    throw "LOCALAPPDATA oder TEMP ist nicht gesetzt. Starte die Installation in einer normalen Windows-Benutzersitzung."
}

Write-Host "VIKTOR $version wird für dein Benutzerkonto eingerichtet."
Write-Host "Installationsordner: $installRoot"
Write-Host "Die Installation benötigt Internetzugriff. Node.js und Ollama werden ausschließlich von ihren offiziellen Websites bezogen."
Write-Host "Ollama und das Modell werden nicht mit Viktor gebündelt."
if ($installRoot -eq $sourceRoot.TrimEnd('\')) { throw "Installationsordner und Quellordner müssen verschieden sein." }
Assert-FreeSpace $installRoot (512MB) "Viktor und die Node.js-Laufzeit"
New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
New-Item -ItemType Directory -Path $installRoot -Force | Out-Null

try {
    $runtimePath = Join-Path $installRoot "runtime"
    $nodeExecutable = Join-Path $runtimePath "node.exe"
    if (-not (Test-Path -LiteralPath $nodeExecutable)) {
        $nodeCommand = Get-Command "node.exe" -ErrorAction SilentlyContinue
        $existingVersion = $null
        if ($nodeCommand) {
            $versionText = & $nodeCommand.Source --version
            if ($LASTEXITCODE -eq 0 -and $versionText -match '^v(\d+)\.') {
                $existingVersion = [int]$Matches[1]
            }
        }
        if ($existingVersion -ge 20) {
            Write-Host "Verwende das vorhandene Node.js $versionText und kopiere die Laufzeit in die Viktor-Installation."
            New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null
            Copy-Item -LiteralPath $nodeCommand.Source -Destination $nodeExecutable -Force
        } else {
        if (-not (Confirm-Action "Die offizielle Node.js-LTS-Laufzeit herunterladen und lokal in Viktor ablegen?")) {
            throw "Node.js ist erforderlich. Die Installation wurde abgebrochen, ohne Node.js herunterzuladen."
        }
        Assert-FreeSpace $temporaryRoot (2GB) "temporäre Node.js-Download- und Installationsdateien"
        Write-Host "Suche die aktuelle Node.js-LTS-Version auf nodejs.org ..."
        $releases = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json" -TimeoutSec 30
        $release = $releases | Where-Object { $_.lts -and $_.version -match "^v\d+\.\d+\.\d+$" } | Select-Object -First 1
        if (-not $release) { throw "Auf nodejs.org wurde keine aktuelle LTS-Version gefunden." }
        $nodeArchive = Join-Path $temporaryRoot "node-$($release.version)-win-x64.zip"
        $nodeUrl = "https://nodejs.org/dist/$($release.version)/node-$($release.version)-win-x64.zip"
        Write-Host "Lade Node.js $($release.version) von nodejs.org herunter ..."
        Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeArchive -UseBasicParsing
        $nodeExtract = Join-Path $temporaryRoot "node"
        Expand-Archive -LiteralPath $nodeArchive -DestinationPath $nodeExtract -Force
        $nodeDirectory = Get-ChildItem -LiteralPath $nodeExtract -Directory | Select-Object -First 1
        if (-not $nodeDirectory -or -not (Test-Path -LiteralPath (Join-Path $nodeDirectory.FullName "node.exe"))) {
            throw "Das Node.js-Archiv von nodejs.org ist unvollständig."
        }
        New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null
        Get-ChildItem -LiteralPath $nodeDirectory.FullName -Force | Copy-Item -Destination $runtimePath -Recurse -Force
        }
    }

    foreach ($directory in @("src", "public", "Viktor", "scripts", "tests")) {
        $sourceDirectory = Join-Path $sourceRoot $directory
        if (-not (Test-Path -LiteralPath $sourceDirectory)) { continue }
        Get-ChildItem -LiteralPath $sourceDirectory -File -Recurse -Force |
            Where-Object {
                $_.Name -ne "behavior.json" -and
                $_.FullName -notmatch "[\\/](node_modules|\.git|\.viktor|runtime)[\\/]" -and
                $_.Name -notmatch "^\.env"
            } |
            ForEach-Object {
                $relative = $_.FullName.Substring($sourceRoot.Length).TrimStart("\", "/")
                $destination = Join-Path $installRoot $relative
                New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
                Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
            }
    }
    foreach ($file in @("package.json", "README.md")) {
        Copy-Item -LiteralPath (Join-Path $sourceRoot $file) -Destination (Join-Path $installRoot $file) -Force
    }
    $sourceSettings = Join-Path $sourceRoot ".viktor"
    $destinationSettings = Join-Path $installRoot ".viktor"
    if ((Test-Path -LiteralPath $sourceSettings) -and -not (Test-Path -LiteralPath $destinationSettings)) {
        Write-Host "Übernehme vorhandene lokale Viktor-Einstellungen und Gesprächsdaten."
        Copy-Item -LiteralPath $sourceSettings -Destination $destinationSettings -Recurse
    }
    $sourceBehavior = Join-Path $sourceRoot "Viktor\Memory\Temporary\behavior.json"
    $destinationBehavior = Join-Path $installRoot "Viktor\Memory\Temporary\behavior.json"
    if ((Test-Path -LiteralPath $sourceBehavior) -and -not (Test-Path -LiteralPath $destinationBehavior)) {
        Copy-Item -LiteralPath $sourceBehavior -Destination $destinationBehavior
    }

    $sourceRelease = Join-Path $sourceRoot "release-source.json"
    $destinationRelease = Join-Path $installRoot "release-source.json"
    if (Test-Path -LiteralPath $sourceRelease) {
        Copy-Item -LiteralPath $sourceRelease -Destination $destinationRelease -Force
    } elseif ($GitHubRepository) {
        if ($GitHubRepository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
            throw "Die GitHub-Updatequelle muss im Format Benutzername/Repository angegeben werden."
        }
        $json = @{ repository = $GitHubRepository } | ConvertTo-Json
        [IO.File]::WriteAllText($destinationRelease, $json, [Text.UTF8Encoding]::new($false))
    } elseif (-not (Test-Path -LiteralPath $destinationRelease)) {
        Write-Warning "Keine GitHub-Updatequelle bekannt. Automatische Updates bleiben bis zur Einrichtung deaktiviert."
    }

    $settingsFile = Join-Path $destinationSettings "settings.json"
    if (Test-Path -LiteralPath $settingsFile) {
        $existingSettings = Get-Content -LiteralPath $settingsFile -Raw | ConvertFrom-Json
        if ($existingSettings.model -and $existingSettings.model -ne "gpt-4o-mini") {
            $model = $existingSettings.model
        }
    }

    $ollamaPath = Get-OllamaPath
    if (-not $ollamaPath) {
        if (Confirm-Action "Ollama fehlt. Den offiziellen Ollama-Installer herunterladen und starten?") {
            Assert-FreeSpace (Join-Path $env:LOCALAPPDATA "Programs\Ollama") (5GB) "Ollama (Installationsdateien und Reserve)"
            $ollamaInstaller = Join-Path $temporaryRoot "OllamaSetup.exe"
            Write-Host "Lade den Installer ausschließlich von https://ollama.com/download/OllamaSetup.exe ..."
            Invoke-WebRequest -Uri "https://ollama.com/download/OllamaSetup.exe" -OutFile $ollamaInstaller -UseBasicParsing
            Write-Host "Der offizielle Ollama-Installer wird jetzt mit seiner sichtbaren Installationsoberfläche gestartet."
            $process = Start-Process -FilePath $ollamaInstaller -Wait -PassThru
            if ($process.ExitCode -ne 0) { throw "Der Ollama-Installer wurde mit Exitcode $($process.ExitCode) beendet." }
            $ollamaPath = Get-OllamaPath
        } else {
            Write-Host "Ollama wurde übersprungen. Viktor wird installiert, benötigt zum Chatten aber Ollama."
        }
    } else {
        Write-Host "Ollama wurde gefunden: $ollamaPath"
    }

    $modelReady = $false
    $chatTestPassed = $false
    if ($ollamaPath) {
        $models = Get-InstalledModels
        if ($null -eq $models) {
            Write-Host "Starte Ollama über das Windows-Startmenü. Die Installation wartet bis zu zwei Minuten auf den lokalen Dienst."
            $deadline = (Get-Date).AddMinutes(2)
            do {
                Start-Sleep -Seconds 3
                $models = Get-InstalledModels
            } while ($null -eq $models -and (Get-Date) -lt $deadline)
        }
        if ($null -ne $models) {
            $modelReady = @($models | Where-Object { $_.name -eq $model -or $_.model -eq $model }).Count -gt 0
            if (-not $modelReady) {
                $modelPath = if ($env:OLLAMA_MODELS) { $env:OLLAMA_MODELS } else { Join-Path $HOME ".ollama\models" }
                if (Confirm-Action "Das Modell $model fehlt. Ollama benötigt dafür etwa 2,5 GB; jetzt herunterladen?") {
                    Assert-FreeSpace $modelPath (4GB) "das Ollama-Modell $model (2,5 GB plus Reserve)"
                    Write-Host "Lade $model mit Ollama herunter. Der Fortschritt wird unten angezeigt."
                    & $ollamaPath pull $model
                    if ($LASTEXITCODE -ne 0) { throw "Ollama konnte das Modell $model nicht herunterladen (Exitcode $LASTEXITCODE)." }
                    $models = Get-InstalledModels
                    $modelReady = @($models | Where-Object { $_.name -eq $model -or $_.model -eq $model }).Count -gt 0
                    if (-not $modelReady) { throw "Ollama meldet das heruntergeladene Modell $model nicht in seiner Modellliste." }
                } else {
                    Write-Host "Der Modell-Download wurde übersprungen. Viktor kann erst nach „ollama pull $model“ chatten."
                }
            }
        } else {
            Write-Warning "Der Ollama-Dienst konnte nicht erreicht werden. Starte Ollama und führe danach „ollama pull $model“ aus. Letzter Verbindungsfehler: $script:lastOllamaProbeError"
        }
    }
    if ($modelReady) {
        Write-Host "Prüfe eine lokale Chat-Anfrage mit $model ..."
        $chatBody = @{
            model = $model
            messages = @(
                @{ role = "system"; content = "Du bist Viktor. Antworte kurz auf Deutsch." }
                @{ role = "user"; content = "Antworte nur mit dem Wort bereit." }
            )
            stream = $false
        } | ConvertTo-Json -Depth 5
        try {
            $chatResponse = Invoke-RestMethod -Uri "http://127.0.0.1:11434/v1/chat/completions" -Method Post -Body $chatBody -ContentType "application/json" -TimeoutSec 180
            $chatTestPassed = [bool]$chatResponse.choices[0].message.content
            if (-not $chatTestPassed) { Write-Warning "Ollama antwortete, aber der Modelltest lieferte keinen Text." }
        } catch {
            Write-Warning "Ollama und das Modell sind installiert, aber der Chat-Test schlug fehl: $($_.Exception.Message)"
        }
    }

    $startScript = Join-Path $installRoot "scripts\Start-Viktor.ps1"
    $shell = New-Object -ComObject WScript.Shell
    $shortcutPath = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\VIKTOR.lnk"
    New-Item -ItemType Directory -Path (Split-Path -Parent $shortcutPath) -Force | Out-Null
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$startScript`""
    $shortcut.WorkingDirectory = $installRoot
    $shortcut.Description = "VIKTOR $version mit lokalem Ollama starten"
    $shortcut.Save()

    Write-Host ""
    Write-Host "VIKTOR $version wurde installiert."
    Write-Host "Startmenü: VIKTOR"
    if ($modelReady) {
        Write-Host "Ollama und $model sind verfügbar."
        if ($chatTestPassed) { Write-Host "Die lokale Chat-Verbindung wurde erfolgreich getestet." }
        if (Confirm-Action "VIKTOR jetzt starten?") {
            Start-Process -FilePath $shortcut.TargetPath -ArgumentList $shortcut.Arguments -WorkingDirectory $installRoot
        }
    } else {
        Write-Host "Ollama oder das Modell ist noch nicht bereit. VIKTOR zeigt beim Start den konkreten Einrichtungsstatus."
    }
} finally {
    if (Test-Path -LiteralPath $temporaryRoot) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
}
