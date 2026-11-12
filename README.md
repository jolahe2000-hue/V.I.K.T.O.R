# VIKTOR 0.2.0

VIKTOR is a local personal AI assistant for Windows. It uses Ollama as its only model backend; conversations and inference stay on the computer. No API key or cloud account is used.

## Install on Windows

1. Once a GitHub repository and release have been published, open its **Releases** page and download the latest `VIKTOR-vX.Y.Z-Windows.zip`.
2. Extract the ZIP, then open PowerShell in the extracted project folder.
3. Run:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
   ```

To install onto D: instead:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -InstallPath 'D:\Apps\Viktor'
```

The installer asks before downloading or installing additional components. It copies an existing Node.js 20+ runtime when available, otherwise offers to download the current Node.js LTS runtime directly from [nodejs.org](https://nodejs.org/). If Ollama is missing, it offers the official [Ollama for Windows installer](https://ollama.com/download/windows); Ollama's Windows installer installs for the current user without administrator rights. The Ollama setup window remains visible. The installer then offers to download the selected model using Ollama and creates a **VIKTOR** Start-menu shortcut. The model is not included in the repository or release ZIP. Existing project settings, chat data and temporary behavior observations are copied to a fresh installation; an existing installation's data is not overwritten.

The package currently needs Windows on x64, internet access during setup, and at least **5 GB free** on the Ollama installation drive, **4 GB free** where Ollama stores models, and **2 GB free** in the temporary download location. `qwen3:4b` is about **2.5 GB**; the additional space is a safety margin. If all locations are on one drive, allow at least **11 GB free** before installing. Larger models need correspondingly more storage. The installer checks available space before downloads; it does not change `OLLAMA_MODELS`.

If you decline the Ollama or model download, Viktor is still installed and can be started from the Start menu after completing setup manually. The chat shows an explicit status when Ollama or the selected model is unavailable. To install the default model later, run `ollama pull qwen3:4b` in PowerShell.

## Start and configure

Select **VIKTOR** from the Windows Start menu. It opens <http://127.0.0.1:4173>. The Ollama model can be changed in **Einstellungen** after installing that model with `ollama pull <modellname>`. Viktor sends the selected model and the recent conversation history to Ollama; it checks both the local service and model availability before each chat.

### Automatische Updates

Ein aus einem GitHub-Release installiertes Paket kennt sein Repository. Bei jedem Start prüft Viktor dessen neuestes stabiles Release. Ein neueres Windows-ZIP wird heruntergeladen, anhand der von GitHub veröffentlichten SHA-256-Prüfsumme geprüft und installiert. Einstellungen, Gespräche, temporäres Verhaltensgedächtnis, Ollama und Modelle bleiben erhalten. Bei einem Fehler startet die bisherige Version und eine Warnung erscheint. Dafür ist Internetzugriff auf GitHub erforderlich.

Läuft noch ein Viktor-Server, wird nur geprüft: Das Update wird erst installiert, nachdem der Server beendet und Viktor erneut gestartet wurde. Schließe dafür das Viktor-Serverfenster. Eine aus dem Quellordner oder über **Code → Download ZIP** installierte Version hat ohne zusätzliche Angabe keine Updatequelle. Wenn das öffentliche Repository existiert, installiere erneut mit seiner Adresse im Format `Benutzername/Repository`:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -InstallPath 'D:\Apps\Viktor' -GitHubRepository 'Benutzername/Repository'
```

Nur Releases dieses Repositories mit einem zum `package.json` passenden Tag wie `v0.2.0` und dem erwarteten Windows-ZIP werden verwendet. Private Repositories werden ohne zusätzliche Anmeldung nicht unterstützt. Vertraue der Updatequelle: Ein erfolgreicher Hashvergleich bestätigt die Paketintegrität, nicht die Vertrauenswürdigkeit des Repository-Besitzers.

The internal personality rules live in `Viktor/Core/Personality/behavior.md`. Temporary observations are kept separately in `Viktor/Memory/Temporary/behavior.json`; corrections start as unconfirmed observations, not permanent rules. The generated file is local and ignored by Git.

## GitHub releases

Pushing a tag that matches the `package.json` version, such as `v0.2.0`, or publishing a GitHub Release for that tag runs tests and publishes `VIKTOR-v0.2.0-Windows.zip` through the workflow in `.github/workflows/release.yml`. If the release already exists, the workflow attaches the ZIP to it. The workflow embeds its GitHub repository name for the updater. The ZIP contains the project source and PowerShell installer, not Ollama binaries or model weights. The installer obtains Node.js and Ollama from their official sources at install time. A GitHub repository and release must actually exist before downloads or automatic updates can work; the workflow alone does not publish this local folder.

Official setup references:

- [Ollama Windows documentation](https://docs.ollama.com/windows) — user-level Windows install, disk requirements, and model storage.
- [Ollama Windows download](https://ollama.com/download/windows) — official installer and documented Windows automation entry point (`irm https://ollama.com/install.ps1 | iex`). Viktor uses the official GUI installer so its installation remains visible and user-approved.
- [Ollama qwen3 model registry](https://ollama.com/library/qwen3) — model variants and current sizes.
- [Node.js downloads](https://nodejs.org/en/download) — official Node.js distributions.

## Prüfstatus vor der ersten Veröffentlichung

- Ollama mit dem lokal vorhandenen Modell `qwen3.5:4b` wurde bereits mit einer echten Antwort getestet. Die automatisierten Tests prüfen zusätzlich Ollama-Aufruf, Modellwahl, Kontext und Persönlichkeit mit einer simulierten API.
- Der Updatepfad wird mit simulierten GitHub-Releases getestet. Einen vollständigen Installationstest auf einer sauberen Windows-VM und einen echten GitHub-Release-Test vor der öffentlichen Veröffentlichung nachholen.

## Development

Requirements: Node.js 20 or newer and Ollama with `qwen3:4b` installed.

```powershell
npm.cmd test
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tests\updater.test.ps1
npm.cmd start
```

Then open <http://127.0.0.1:4173>. To install the model separately, run `ollama pull qwen3:4b`. The project has no npm dependencies.
