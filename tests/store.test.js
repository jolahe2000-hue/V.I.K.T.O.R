import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createStore } from "../src/store.js";

test("messages, agent definitions, memories, and logs persist locally", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "viktor-store-"));
  try {
    const store = createStore(root);
    await Promise.all([
      store.addMessage({ role: "user", content: "Hi" }),
      store.log("info", "Started"),
      store.remember("Use German"),
    ]);
    const agent = await store.createAgent({ name: "Prompt helper", description: "Improves prompts", instructions: "Keep intent." });
    const reopened = createStore(root);
    assert.equal((await reopened.getMessages()).length, 1);
    assert.equal((await reopened.getAgents())[0].id, agent.id);
    assert.equal((await reopened.getMemories())[0].content, "Use German");
    assert.equal((await reopened.getLogs())[0].message, "Started");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("user corrections are not promoted to durable preferences and cannot be submitted twice", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "viktor-store-"));
  try {
    const store = createStore(root);
    await store.remember("Prefer short answers and German", "preference");
    await store.addMessage({ role: "user", content: "My Minecraft server has a crash on startup." });
    const reply = await store.addMessage({ role: "assistant", content: "Check the server log for the first exception." });
    await store.recordFeedback({
      messageId: reply.id,
      rating: "correction",
      correction: "Ask for the full latest.log before proposing fixes.",
    });

    const reopened = createStore(root);
    const messages = await reopened.getMessages();
    assert.equal(messages.at(-1).feedback.rating, "correction");
    const memories = await reopened.getRelevantMemories("Minecraft startup crash");
    assert.equal(memories.some((item) => item.content.includes("full latest.log")), false);
    assert.equal(memories.some((item) => item.content.includes("short answers")), true);
    await assert.rejects(reopened.recordFeedback({
      messageId: reply.id,
      rating: "helpful",
      correction: "",
    }), /already been saved/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
