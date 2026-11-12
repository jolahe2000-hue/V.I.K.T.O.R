import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvironment, inspectProvider, getSettings, saveSettings } from "./config.js";
import { runAgent } from "./agent.js";
import { createBehaviorManager } from "./behavior.js";
import { createStore } from "./store.js";
import { createToolExecutor } from "./tools.js";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await loadEnvironment(appRoot);
const behavior = await createBehaviorManager(appRoot);
const workspaceRoot = path.resolve(process.env.VIKTOR_WORKSPACE || appRoot);
const publicRoot = path.join(appRoot, "public");
const store = createStore(workspaceRoot);
const executeTool = createToolExecutor(workspaceRoot, store, {
  protectViktorCore: workspaceRoot === appRoot,
});
const PORT = Number(process.env.VIKTOR_PORT || 4173);
let taskRunning = false;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(data));
}

async function readJson(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk.toString();
    if (Buffer.byteLength(raw, "utf8") > 1_000_000) throw new Error("Request body exceeds 1 MB.");
  }
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

async function serveStatic(pathname, response) {
  const requested = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const file = path.resolve(publicRoot, requested);
  const relative = path.relative(publicRoot, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    sendJson(response, 404, { error: "Not found." });
    return;
  }
  try {
    const contents = await readFile(file);
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(file)] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:",
      "Referrer-Policy": "no-referrer",
    });
    response.end(contents);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") {
      sendJson(response, 404, { error: "Not found." });
      return;
    }
    throw error;
  }
}

async function getWorkspaceSummary() {
  const entries = await readdir(workspaceRoot, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".env") || [".git", ".viktor", "Viktor", "node_modules", "runtime"].includes(entry.name)) continue;
    const info = await stat(path.join(workspaceRoot, entry.name));
    files.push({ name: entry.name, type: entry.isDirectory() ? "folder" : "file", size: info.size });
    if (files.length >= 100) break;
  }
  return { name: path.basename(workspaceRoot), files };
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/status") {
    const settings = await getSettings(workspaceRoot);
    sendJson(response, 200, { ...(await inspectProvider(settings)), workspace: path.basename(workspaceRoot), taskRunning });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/settings") {
    sendJson(response, 200, await getSettings(workspaceRoot));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/settings") {
    const input = await readJson(request);
    const settings = await saveSettings(workspaceRoot, input);
    sendJson(response, 200, settings);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/history") {
    sendJson(response, 200, await store.getMessages());
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/feedback") {
    const input = await readJson(request);
    if (typeof input.messageId !== "string" || !["helpful", "correction"].includes(input.rating)) {
      sendJson(response, 400, { error: "Feedback must reference a reply and be marked helpful or correction." });
      return;
    }
    const correction = typeof input.correction === "string" ? input.correction.trim() : "";
    if (input.rating === "correction" && (!correction || correction.length > 2000)) {
      sendJson(response, 400, { error: "Enter a correction of 1 to 2000 characters." });
      return;
    }
    let feedback;
    try {
      feedback = await store.recordFeedback({ messageId: input.messageId, rating: input.rating, correction });
    } catch (error) {
      const status = error.message.includes("no longer available") ? 404 : 409;
      sendJson(response, status, { error: error.message });
      return;
    }
    let warning = "";
    if (input.rating === "correction") {
      try {
        await behavior.observe(correction);
      } catch (error) {
        warning = `Die Korrektur wurde gespeichert, aber die temporäre Verhaltensbeobachtung konnte nicht gespeichert werden: ${error.message}`;
        try {
          await store.log("error", warning);
        } catch (logError) {
          warning += ` Auch das Aktivitätsprotokoll konnte nicht geschrieben werden: ${logError.message}`;
        }
      }
    }
    await store.log("info", "Saved feedback as a local learning.");
    sendJson(response, 200, { feedback, warning });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/agents") {
    sendJson(response, 200, await store.getAgents());
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/memories") {
    sendJson(response, 200, await store.getMemories());
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/logs") {
    sendJson(response, 200, await store.getLogs());
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/workspace") {
    sendJson(response, 200, await getWorkspaceSummary());
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/chat") {
    if (taskRunning) {
      sendJson(response, 409, { error: "VIKTOR is already working on a request." });
      return;
    }
    const input = await readJson(request);
    const text = typeof input.message === "string" ? input.message.trim() : "";
    if (!text || text.length > 8000) {
      sendJson(response, 400, { error: "Enter a message of 1 to 8000 characters." });
      return;
    }
    const agents = await store.getAgents();
    const agent = input.agentId ? agents.find((item) => item.id === input.agentId) : null;
    if (input.agentId && !agent) {
      sendJson(response, 400, { error: "That agent no longer exists. Refresh the agent list and try again." });
      return;
    }
    if (taskRunning) {
      sendJson(response, 409, { error: "VIKTOR is already working on a request." });
      return;
    }

    taskRunning = true;
    try {
      await store.addMessage({ role: "user", content: text });
      await store.log("info", agent ? `Started a task with ${agent.name}.` : "Started a chat task.");
      const settings = await getSettings(workspaceRoot);
      const history = await store.getMessages();
      const memories = await store.getRelevantMemories(text);
      const answer = await runAgent({
        settings,
        messages: history.map(({ role, content }) => ({ role, content })),
        agent,
        memories,
        behavior: behavior.getContext(),
        executeTool,
        permissions: {
          allowTests: input.allowTests === true,
          allowCodeExecution: input.allowCodeExecution === true,
        },
      });
      const reply = await store.addMessage({ role: "assistant", content: answer });
      await store.log("info", "Task completed.");
      sendJson(response, 200, { answer, messageId: reply.id });
    } catch (error) {
      let message = error.message;
      try {
        await store.log("error", `Task failed: ${message}`);
      } catch (logError) {
        message = `${message} (The local activity log also failed: ${logError.message})`;
      }
      sendJson(response, 502, { error: message });
    } finally {
      taskRunning = false;
    }
    return;
  }
  sendJson(response, 404, { error: "API endpoint not found." });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
    } else if (request.method === "GET") {
      await serveStatic(url.pathname, response);
    } else {
      sendJson(response, 405, { error: "Method not allowed." });
    }
  } catch (error) {
    const status = error.message.includes("Request body") || error.message.includes("Enter a valid") ? 400 : 500;
    sendJson(response, status, { error: error.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`VIKTOR is available at http://127.0.0.1:${PORT}`);
  console.log(`Workspace: ${workspaceRoot}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
