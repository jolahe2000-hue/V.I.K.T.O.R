import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getSettings, inspectProvider, loadEnvironment, saveSettings } from "../src/config.js";

test("settings use the Ollama endpoint and allow selecting a model", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "viktor-config-"));
  try {
    const defaults = await getSettings(root);
    assert.equal(defaults.model, "qwen3:4b");
    assert.equal(defaults.baseUrl, "http://127.0.0.1:11434/v1");
    const saved = await saveSettings(root, { model: "local-model" });
    assert.equal(saved.model, "local-model");
    assert.equal(saved.baseUrl, "http://127.0.0.1:11434/v1");
    assert.equal(JSON.parse(await readFile(path.join(root, ".viktor", "settings.json"), "utf8")).baseUrl, saved.baseUrl);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("environment loading ignores legacy API credentials and provider URLs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "viktor-config-"));
  const names = ["VIKTOR_API_KEY", "VIKTOR_BASE_URL", "VIKTOR_MODEL", "VIKTOR_PORT"];
  const original = new Map(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    await writeFile(path.join(root, ".env"), [
      "VIKTOR_API_KEY=must-not-be-loaded",
      "VIKTOR_BASE_URL=https://provider.example/v1",
      "VIKTOR_MODEL=local-model",
      "VIKTOR_PORT=4242",
    ].join("\n"));
    await loadEnvironment(root);
    assert.equal(process.env.VIKTOR_API_KEY, undefined);
    assert.equal(process.env.VIKTOR_BASE_URL, undefined);
    assert.equal(process.env.VIKTOR_MODEL, "local-model");
    assert.equal(process.env.VIKTOR_PORT, "4242");
  } finally {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy default OpenAI settings migrate to the API-free Ollama default", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "viktor-config-"));
  try {
    await mkdir(path.join(root, ".viktor"));
    await writeFile(path.join(root, ".viktor", "settings.json"), JSON.stringify({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
    }));
    const settings = await getSettings(root);
    assert.equal(settings.baseUrl, "http://127.0.0.1:11434/v1");
    assert.equal(settings.model, "qwen3:4b");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Ollama status requires both a running server and the selected model", async () => {
  const settings = { baseUrl: "http://127.0.0.1:11434/v1", model: "qwen3:4b" };
  const unavailable = await inspectProvider(settings, async () => { throw new Error("offline"); });
  assert.equal(unavailable.local, true);
  assert.equal(unavailable.ready, false);
  assert.match(unavailable.message, /Ollama ist nicht erreichbar/u);

  const missingModel = await inspectProvider(settings, async (url) => {
    assert.equal(String(url), "http://127.0.0.1:11434/api/tags");
    return new Response(JSON.stringify({ models: [{ name: "llama3.2:3b" }] }), { status: 200 });
  });
  assert.equal(missingModel.ready, false);
  assert.match(missingModel.message, /qwen3:4b ist nicht installiert/u);

  const ready = await inspectProvider(settings, async () => new Response(
    JSON.stringify({ models: [{ name: "qwen3:4b" }] }),
    { status: 200 },
  ));
  assert.equal(ready.ready, true);

  const invalidServer = await inspectProvider(settings, async () => new Response("", { status: 404 }));
  assert.equal(invalidServer.ready, false);
  assert.match(invalidServer.message, /HTTP 404/u);
});

test("settings keep Ollama as the only model endpoint", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "viktor-config-"));
  try {
    const settings = await saveSettings(root, {
      baseUrl: "https://provider.example/v1",
      model: "qwen3:4b",
    });
    assert.equal(settings.baseUrl, "http://127.0.0.1:11434/v1");
    await assert.rejects(saveSettings(root, { model: "" }), /Enter a model name/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
