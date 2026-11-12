import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const EMPTY_STATE = { messages: [], agents: [], memories: [], logs: [] };

export function createStore(root) {
  const directory = path.join(root, ".viktor");
  const file = path.join(directory, "store.json");
  let writeQueue = Promise.resolve();

  async function readState() {
    try {
      const state = JSON.parse(await readFile(file, "utf8"));
      return {
        messages: Array.isArray(state.messages) ? state.messages : [],
        agents: Array.isArray(state.agents) ? state.agents : [],
        memories: Array.isArray(state.memories) ? state.memories : [],
        logs: Array.isArray(state.logs) ? state.logs : [],
      };
    } catch (error) {
      if (error.code === "ENOENT") return structuredClone(EMPTY_STATE);
      throw new Error(`Could not read VIKTOR's local data: ${error.message}`);
    }
  }

  async function update(change) {
    const operation = writeQueue.then(async () => {
      await mkdir(directory, { recursive: true });
      const state = await readState();
      change(state);
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      await rename(temporary, file);
      return state;
    });
    writeQueue = operation.catch(() => {});
    return operation;
  }

  return {
    async getMessages() {
      return (await readState()).messages.slice(-40);
    },
    async addMessage(message) {
      let created;
      await update((state) => {
        created = { id: randomUUID(), ...message, createdAt: new Date().toISOString() };
        state.messages.push(created);
        state.messages = state.messages.slice(-200);
      });
      return created;
    },
    async getAgents() {
      return (await readState()).agents;
    },
    async createAgent(agent) {
      let created;
      await update((state) => {
        created = { id: randomUUID(), ...agent, createdAt: new Date().toISOString() };
        state.agents.push(created);
      });
      return created;
    },
    async getMemories() {
      return (await readState()).memories.slice(-100);
    },
    async getRelevantMemories(query) {
      const state = await readState();
      const words = new Set(String(query).toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);
      return state.memories
        .map((memory, index) => {
          const text = memory.content.toLocaleLowerCase();
          const score = [...words].reduce((total, word) => total + (text.includes(word) ? 1 : 0), 0);
          const preferenceBoost = memory.kind === "preference" ? 2 : 0;
          return { memory, index, score: score + preferenceBoost };
        })
        .filter(({ memory, score }) => memory.kind === "preference" || score > 0)
        .sort((left, right) => right.score - left.score || right.index - left.index)
        .slice(0, 8)
        .map(({ memory }) => ({ ...memory, content: memory.content.slice(0, 600) }));
    },
    async remember(content, kind = "note") {
      let memory;
      await update((state) => {
        memory = { id: randomUUID(), content, kind, createdAt: new Date().toISOString() };
        state.memories.push(memory);
        state.memories = state.memories.slice(-100);
      });
      return memory;
    },
    async recordFeedback({ messageId, rating, correction }) {
      let feedback;
      await update((state) => {
        const index = state.messages.findIndex((message) => message.id === messageId && message.role === "assistant");
        if (index < 0) throw new Error("This assistant reply is no longer available for feedback.");
        const reply = state.messages[index];
        if (reply.feedback) throw new Error("Feedback has already been saved for this reply.");
        let question = "";
        for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
          if (state.messages[cursor].role === "user") {
            question = state.messages[cursor].content;
            break;
          }
        }
        if (!question) throw new Error("The original user message for this reply is no longer available.");
        const createdAt = new Date().toISOString();
        feedback = { rating, correction: correction || "", createdAt };
        reply.feedback = feedback;
        if (rating === "helpful") {
          state.memories.push({
            id: randomUUID(),
            kind: "success",
            content: `Als hilfreich bewertet. Anfrage: ${question.slice(0, 300)} Vorgehensweise: ${reply.content.slice(0, 600)}`.slice(0, 1200),
            createdAt,
          });
          state.memories = state.memories.slice(-100);
        }
      });
      return feedback;
    },
    async getLogs() {
      return (await readState()).logs.slice(-100);
    },
    async log(level, message) {
      await update((state) => {
        state.logs.push({ level, message, createdAt: new Date().toISOString() });
        state.logs = state.logs.slice(-200);
      });
    },
  };
}
