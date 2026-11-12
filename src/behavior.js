import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const TEMPORARY_DIRECTORY = path.join("Viktor", "Memory", "Temporary");

function parseBehavior(contents, file) {
  let state;
  try {
    state = JSON.parse(contents);
  } catch {
    throw new Error(`VIKTOR's temporary behavior file is invalid JSON: ${file}`);
  }
  if (state.schemaVersion !== 1 || !Array.isArray(state.observations)) {
    throw new Error(`VIKTOR's temporary behavior file has an unsupported format: ${file}`);
  }
  return state;
}

async function writeState(file, state) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

export async function createBehaviorManager(root) {
  const directory = path.join(root, TEMPORARY_DIRECTORY);
  const behaviorFile = path.join(directory, "behavior.json");
  const templateFile = path.join(directory, "behavior.template.json");
  const personalityFile = path.join(root, "Viktor", "Core", "Personality", "behavior.md");
  const personality = await readFile(personalityFile, "utf8");
  await mkdir(directory, { recursive: true });

  let state;
  try {
    state = parseBehavior(await readFile(behaviorFile, "utf8"), behaviorFile);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    state = parseBehavior(await readFile(templateFile, "utf8"), templateFile);
    await writeState(behaviorFile, state);
  }

  let writeQueue = Promise.resolve();
  return {
    getContext() {
      return {
        personality,
        observations: state.observations
          .filter((item) => item.status === "unconfirmed" && typeof item.content === "string")
          .slice(-12)
          .map(({ content }) => ({ content })),
      };
    },
    async observe(content, source = "user_feedback") {
      const text = String(content || "").trim();
      if (!text || text.length > 2000) throw new Error("A temporary behavior observation must be between 1 and 2000 characters.");
      const operation = writeQueue.then(async () => {
        const latest = parseBehavior(await readFile(behaviorFile, "utf8"), behaviorFile);
        const observation = {
          id: randomUUID(),
          content: text,
          source,
          status: "unconfirmed",
          observedAt: new Date().toISOString(),
        };
        latest.observations.push(observation);
        latest.observations = latest.observations.slice(-100);
        await writeState(behaviorFile, latest);
        state = latest;
        return observation;
      });
      writeQueue = operation.catch(() => {});
      return operation;
    },
  };
}
