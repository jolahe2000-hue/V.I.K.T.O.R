import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBehaviorManager } from "../src/behavior.js";

test("behavior manager loads personality and stores tentative observations separately", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "viktor-behavior-"));
  const behaviorDirectory = path.join(root, "Viktor", "Memory", "Temporary");
  try {
    await mkdir(path.join(root, "Viktor", "Core", "Personality"), { recursive: true });
    await mkdir(behaviorDirectory, { recursive: true });
    await writeFile(
      path.join(root, "Viktor", "Core", "Personality", "behavior.md"),
      "Antworte freundlich und knapp.",
    );
    await writeFile(
      path.join(behaviorDirectory, "behavior.template.json"),
      JSON.stringify({ schemaVersion: 1, observations: [] }),
    );

    const behavior = await createBehaviorManager(root);
    assert.equal(behavior.getContext().personality, "Antworte freundlich und knapp.");
    assert.deepEqual(behavior.getContext().observations, []);

    await behavior.observe("Bitte bei unklaren Anforderungen erst nachfragen.");
    const saved = JSON.parse(await readFile(path.join(behaviorDirectory, "behavior.json"), "utf8"));
    assert.equal(saved.observations[0].status, "unconfirmed");
    assert.equal(behavior.getContext().observations[0].content, saved.observations[0].content);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
