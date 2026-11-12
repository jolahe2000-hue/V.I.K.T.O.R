import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runAgent } from "../src/agent.js";
import { createBehaviorManager } from "../src/behavior.js";

test("agent sends the selected Ollama model, behavior, and conversation context", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "viktor-agent-"));
  const personalityDirectory = path.join(root, "Viktor", "Core", "Personality");
  const temporaryDirectory = path.join(root, "Viktor", "Memory", "Temporary");
  const requests = [];
  try {
    await mkdir(personalityDirectory, { recursive: true });
    await mkdir(temporaryDirectory, { recursive: true });
    await writeFile(path.join(personalityDirectory, "behavior.md"), "Antworte freundlich und natürlich.");
    await writeFile(path.join(temporaryDirectory, "behavior.template.json"), JSON.stringify({
      schemaVersion: 1,
      observations: [],
    }));
    const behavior = await createBehaviorManager(root);
    await behavior.observe("Bei unklaren Anforderungen gezielt nachfragen.");

    const fetchImpl = async (url, options) => {
      requests.push({ url: String(url), options });
      if (String(url).endsWith("/api/tags")) {
        return new Response(JSON.stringify({ models: [{ name: "qwen3:4b" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: "Klar, ich helfe dir." } }],
      }), { status: 200 });
    };
    const answer = await runAgent({
      settings: { baseUrl: "http://127.0.0.1:11434/v1", model: "qwen3:4b" },
      messages: [
        { role: "user", content: "Wir sprechen Deutsch." },
        { role: "assistant", content: "Verstanden." },
        { role: "user", content: "Antworte kurz." },
      ],
      memories: [],
      behavior: behavior.getContext(),
      agent: null,
      permissions: { allowTests: false },
      executeTool: async () => "unused",
      fetchImpl,
    });

    assert.equal(answer, "Klar, ich helfe dir.");
    assert.equal(requests[0].url, "http://127.0.0.1:11434/api/tags");
    assert.equal(requests[1].url, "http://127.0.0.1:11434/v1/chat/completions");
    assert.equal(requests[1].options.headers.Authorization, undefined);
    const body = JSON.parse(requests[1].options.body);
    assert.equal(body.model, "qwen3:4b");
    assert.deepEqual(body.messages.slice(1), [
      { role: "user", content: "Wir sprechen Deutsch." },
      { role: "assistant", content: "Verstanden." },
      { role: "user", content: "Antworte kurz." },
    ]);
    assert.match(body.messages[0].content, /Antworte freundlich und natürlich/u);
    assert.match(body.messages[0].content, /unbestätigte temporäre Verhaltensbeobachtungen/iu);
    assert.match(body.messages[0].content, /nicht als feste Persönlichkeitsregeln/u);
    assert.match(body.messages[0].content, /Bei unklaren Anforderungen gezielt nachfragen/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent reports a missing Ollama model before sending a chat request", async () => {
  const urls = [];
  await assert.rejects(runAgent({
    settings: { baseUrl: "http://127.0.0.1:11434/v1", model: "missing-model" },
    messages: [{ role: "user", content: "Hallo" }],
    memories: [],
    agent: null,
    permissions: { allowTests: false },
    executeTool: async () => "unused",
    fetchImpl: async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    },
  }), /missing-model ist nicht installiert/u);
  assert.equal(urls.length, 1);
});
