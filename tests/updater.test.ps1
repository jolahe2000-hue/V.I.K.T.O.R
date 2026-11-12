$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$updater = Join-Path $root "scripts\Update-Viktor.ps1"
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("viktor-updater-test-" + [Guid]::NewGuid().ToString("N"))
$install = Join-Path $testRoot "install"
$package = Join-Path $testRoot "package"
$archive = Join-Path $testRoot "release.zip"

function Write-TestFile([string]$base, [string]$relative, [string]$content) {
    $file = Join-Path $base $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $file) -Force | Out-Null
    [IO.File]::WriteAllText($file, $content, [Text.UTF8Encoding]::new($false))
}

function Invoke-RestMethod {
    param($Uri, $Headers, $TimeoutSec)
    if ($Uri -ne "https://api.github.com/repos/example/viktor/releases/latest") { throw "Unexpected API URI: $Uri" }
    return $global:ViktorMockRelease
}

function Invoke-WebRequest {
    param($Uri, $OutFile, [switch]$UseBasicParsing, $TimeoutSec)
    if ($Uri -ne "https://github.com/example/viktor/releases/download/v0.3.0/VIKTOR-v0.3.0-Windows.zip") {
        throw "Unexpected download URI: $Uri"
    }
    Copy-Item -LiteralPath $global:ViktorMockArchive -Destination $OutFile
}

try {
    New-Item -ItemType Directory -Path $install, $package -Force | Out-Null
    Write-TestFile $install "package.json" '{"version":"0.2.0"}'
    Write-TestFile $install "release-source.json" '{"repository":"example/viktor"}'
    Write-TestFile $install ".viktor\settings.json" '{"model":"qwen3.5:4b"}'
    Write-TestFile $install "Viktor\Memory\Temporary\behavior.json" '{"observations":["personal"]}'
    Write-TestFile $install "src\server.js" "old server"
    Write-TestFile $package "package.json" '{"version":"0.3.0"}'
    Write-TestFile $package "src\server.js" "new server"
    Write-TestFile $package "public\index.html" "new interface"
    Write-TestFile $package "scripts\Start-Viktor.ps1" "new launcher"
    Write-TestFile $package "scripts\Update-Viktor.ps1" "new updater"
    Write-TestFile $package "Viktor\Core\Personality\behavior.md" "new personality"
    Write-TestFile $package "Viktor\Memory\Temporary\behavior.json" "must not overwrite"
    Compress-Archive -Path (Join-Path $package "*") -DestinationPath $archive
    $global:ViktorMockArchive = $archive
    $global:ViktorMockRelease = @{
        draft = $false
        prerelease = $false
        tag_name = "v0.3.0"
        assets = @(@{
            name = "VIKTOR-v0.3.0-Windows.zip"
            size = (Get-Item -LiteralPath $archive).Length
            digest = "sha256:$((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash)"
            browser_download_url = "https://github.com/example/viktor/releases/download/v0.3.0/VIKTOR-v0.3.0-Windows.zip"
        })
    }

    & $updater -Root $install -CheckOnly
    if ((Get-Content -LiteralPath (Join-Path $install "src\server.js") -Raw) -ne "old server") {
        throw "CheckOnly modified the installation."
    }
    & $updater -Root $install
    if ((Get-Content -LiteralPath (Join-Path $install "src\server.js") -Raw) -ne "new server") {
        throw "The update did not install the new server."
    }
    if ((Get-Content -LiteralPath (Join-Path $install ".viktor\settings.json") -Raw) -notmatch 'qwen3.5:4b') {
        throw "Personal settings were modified."
    }
    if ((Get-Content -LiteralPath (Join-Path $install "Viktor\Memory\Temporary\behavior.json") -Raw) -notmatch 'personal') {
        throw "Temporary behavior was modified."
    }
    if ((Get-Content -LiteralPath (Join-Path $install "package.json") -Raw) -notmatch '0.3.0') {
        throw "Package version was not updated."
    }
    Write-TestFile $install "package.json" '{"version":"0.2.0"}'
    $global:ViktorMockRelease.assets[0].digest = "sha256:" + ("0" * 64)
    $failed = $false
    try { & $updater -Root $install } catch { $failed = $true }
    if (-not $failed) { throw "An invalid package hash was accepted." }
    if ((Get-Content -LiteralPath (Join-Path $install "src\server.js") -Raw) -ne "new server") {
        throw "A failed update modified the installation."
    }
    Write-Host "Updater tests passed."
} finally {
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
    Remove-Variable -Name ViktorMockRelease -Scope Global -ErrorAction SilentlyContinue
    Remove-Variable -Name ViktorMockArchive -Scope Global -ErrorAction SilentlyContinue
}
