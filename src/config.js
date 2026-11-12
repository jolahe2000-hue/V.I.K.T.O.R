import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1";
const DEFAULT_MODEL = "qwen3:4b";

export async function loadEnvironment(root) {
  const allowedVariables = new Set(["VIKTOR_MODEL", "VIKTOR_PORT", "VIKTOR_WORKSPACE"]);
  try {
    const contents = await readFile(path.join(root, ".env"), "utf8");
    for (const line of contents.split(/\r?\n/u)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u);
      if (!match || !allowedVariables.has(match[1]) || Object.hasOwn(process.env, match[1])) continue;
      let value = match[2];
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[match[1]] = value;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function settingsPath(root) {
  return path.join(root, ".viktor", "settings.json");
}

export async function getSettings(root) {
  try {
    const settings = JSON.parse(await readFile(settingsPath(root), "utf8"));
    if (settings.baseUrl === "https://api.openai.com/v1" && settings.model === "gpt-4o-mini") {
      return { baseUrl: DEFAULT_BASE_URL, model: DEFAULT_MODEL };
    }
    return {
      baseUrl: DEFAULT_BASE_URL,
      model: settings.model || process.env.VIKTOR_MODEL || DEFAULT_MODEL,
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`Could not read VIKTOR's model settings: ${error.message}`);
    return {
      baseUrl: DEFAULT_BASE_URL,
      model: process.env.VIKTOR_MODEL || DEFAULT_MODEL,
    };
  }
}

export async function saveSettings(root, input) {
  const model = String(input.model || "").trim();
  if (!model || model.length > 120) throw new Error("Enter a model name (up to 120 characters).");
  const settings = { baseUrl: DEFAULT_BASE_URL, model };
  const file = settingsPath(root);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return settings;
}

export async function inspectProvider(settings, fetchImpl = fetch) {
  const result = {
    configured: true,
    ready: false,
    local: true,
    model: settings.model,
    baseUrl: DEFAULT_BASE_URL,
    message: "",
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetchImpl("http://127.0.0.1:11434/api/tags", { signal: controller.signal });
    if (!response.ok) {
      result.message = `Ollama antwortet mit HTTP ${response.status}. Prüfe, ob der lokale Ollama-Dienst läuft.`;
      return result;
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      result.message = "Ollama hat eine ungültige Modellliste zurückgegeben.";
      return result;
    }
    const models = Array.isArray(payload.models) ? payload.models : [];
    const installed = models.some((item) =>
      [item?.name, item?.model].includes(settings.model),
    );
    result.ready = installed;
    result.installedModels = models.map((item) => item.name || item.model).filter(Boolean);
    result.message = installed
      ? `Lokales Ollama-Modell ${settings.model} ist bereit.`
      : `Ollama läuft, aber ${settings.model} ist nicht installiert. Installiere es mit „ollama pull ${settings.model}“.`;
    return result;
  } catch (error) {
    result.message = error.name === "AbortError"
      ? "Ollama antwortet nicht innerhalb von 1,5 Sekunden."
      : `Ollama ist nicht erreichbar. Starte Ollama und prüfe den lokalen Dienst auf http://127.0.0.1:11434. (${error.message})`;
    return result;
  } finally {
    clearTimeout(timeout);
  }
}
