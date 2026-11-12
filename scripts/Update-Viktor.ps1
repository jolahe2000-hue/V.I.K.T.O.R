param(
    [Parameter(Mandatory = $true)][string]$Root,
    [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$sourceFile = Join-Path $Root "release-source.json"
if (-not (Test-Path -LiteralPath $sourceFile)) {
    Write-Host "Keine GitHub-Updatequelle eingerichtet. Viktor startet ohne Updateprüfung."
    exit 0
}

$source = Get-Content -LiteralPath $sourceFile -Raw | ConvertFrom-Json
if ($source.repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
    throw "Ungültige GitHub-Updatequelle in release-source.json."
}
$repository = $source.repository
$headers = @{ "User-Agent" = "VIKTOR-Updater"; "Accept" = "application/vnd.github+json" }
Write-Host "Prüfe GitHub-Updates für $repository ..."
$release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repository/releases/latest" -Headers $headers -TimeoutSec 15
if ($release.draft -or $release.prerelease -or $release.tag_name -notmatch '^v(\d+)\.(\d+)\.(\d+)$') {
    throw "Das neueste GitHub-Release hat keine unterstützte stabile Versionsnummer."
}
$latestVersion = [version]$release.tag_name.Substring(1)
$currentVersion = [version](Get-Content -LiteralPath (Join-Path $Root "package.json") -Raw | ConvertFrom-Json).version
if ($latestVersion -le $currentVersion) {
    Write-Host "Viktor $currentVersion ist aktuell."
    exit 0
}

Write-Host "Viktor $latestVersion ist verfügbar."
if ($CheckOnly) {
    Write-Host "Das Update wird beim nächsten Start installiert, wenn Viktor vollständig beendet ist."
    exit 0
}
$assetName = "VIKTOR-$($release.tag_name)-Windows.zip"
$assets = @($release.assets | Where-Object { $_.name -eq $assetName })
if ($assets.Count -ne 1 -or $assets[0].digest -notmatch '^sha256:([a-fA-F0-9]{64})$') {
    throw "Das Release enthält kein eindeutig prüfbares Windows-Paket mit SHA-256-Prüfsumme."
}
if ($assets[0].size -le 0 -or $assets[0].size -gt 100MB) {
    throw "Das Updatepaket ist leer oder überschreitet die maximale Größe von 100 MB."
}
$expectedHash = $Matches[1].ToLowerInvariant()
$expectedUrl = "https://github.com/$repository/releases/download/$($release.tag_name)/$assetName"
if ($assets[0].browser_download_url -ne $expectedUrl) {
    throw "Die Downloadadresse stimmt nicht mit dem konfigurierten GitHub-Release überein."
}

$work = Join-Path $Root (".update-" + [Guid]::NewGuid().ToString("N"))
$archive = Join-Path $work "release.zip"
$staging = Join-Path $work "staging"
$backup = Join-Path $work "backup"
$copied = New-Object System.Collections.Generic.List[string]
$rollbackErrors = New-Object System.Collections.Generic.List[string]
New-Item -ItemType Directory -Path $staging, $backup -Force | Out-Null
try {
    Write-Host "Lade und prüfe Viktor $latestVersion ..."
    Invoke-WebRequest -Uri $expectedUrl -OutFile $archive -UseBasicParsing -TimeoutSec 120
    $actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) { throw "Die SHA-256-Prüfsumme des Updatepakets stimmt nicht." }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
        $unpackedSize = [long]0
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            if ($name.StartsWith('/') -or $name -match '(^|/)\.\.(/|$)' -or $name.Contains(':')) {
                throw "Das Updatepaket enthält einen ungültigen Dateipfad."
            }
            if ($name.EndsWith('/')) { continue }
            if ($name -notmatch '^(src/|public/|scripts/|Viktor/Core/|Viktor/Memory/Temporary/behavior\.template\.json$|package\.json$|README\.md$)') { continue }
            $unpackedSize += $entry.Length
            if ($unpackedSize -gt 100MB) { throw "Das entpackte Update überschreitet die maximale Größe von 100 MB." }
            $destination = Join-Path $staging $name.Replace('/', '\')
            New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $true)
        }
    } finally {
        $zip.Dispose()
    }

    foreach ($required in @("package.json", "src\server.js", "scripts\Start-Viktor.ps1", "scripts\Update-Viktor.ps1", "public\index.html", "Viktor\Core\Personality\behavior.md")) {
        if (-not (Test-Path -LiteralPath (Join-Path $staging $required) -PathType Leaf)) {
            throw "Das Updatepaket ist unvollständig: $required fehlt."
        }
    }
    $stagedVersion = (Get-Content -LiteralPath (Join-Path $staging "package.json") -Raw | ConvertFrom-Json).version
    if ($stagedVersion -ne $latestVersion.ToString()) { throw "Die Paketversion stimmt nicht mit dem GitHub-Tag überein." }

    Write-Host "Installiere Viktor $latestVersion; persönliche Daten bleiben erhalten ..."
    $files = @(Get-ChildItem -LiteralPath $staging -File -Recurse)
    foreach ($file in $files) {
        $relative = $file.FullName.Substring($staging.Length).TrimStart('\', '/')
        $destination = Join-Path $Root $relative
        $backupFile = Join-Path $backup $relative
        if (Test-Path -LiteralPath $destination) {
            New-Item -ItemType Directory -Path (Split-Path -Parent $backupFile) -Force | Out-Null
            Copy-Item -LiteralPath $destination -Destination $backupFile -Force
        }
        $copied.Add($relative)
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath $file.FullName -Destination $destination -Force
    }
    Write-Host "Update auf Viktor $latestVersion abgeschlossen."
} catch {
    $failure = $_
    for ($i = $copied.Count - 1; $i -ge 0; $i--) {
        $relative = $copied[$i]
        $destination = Join-Path $Root $relative
        $backupFile = Join-Path $backup $relative
        try {
            if (Test-Path -LiteralPath $backupFile) {
                Copy-Item -LiteralPath $backupFile -Destination $destination -Force
            } elseif (Test-Path -LiteralPath $destination) {
                Remove-Item -LiteralPath $destination -Force
            }
        } catch {
            $rollbackErrors.Add("$relative : $($_.Exception.Message)")
        }
    }
    if ($rollbackErrors.Count -gt 0) {
        throw "Update fehlgeschlagen: $($failure.Exception.Message). Wiederherstellung unvollständig; Sicherung unter $backup. Fehler: $($rollbackErrors -join '; ')"
    }
    throw "Update fehlgeschlagen; bisherige Dateien wurden wiederhergestellt: $($failure.Exception.Message)"
} finally {
    if ($rollbackErrors.Count -eq 0 -and (Test-Path -LiteralPath $work)) {
        Remove-Item -LiteralPath $work -Recurse -Force
    }
}
