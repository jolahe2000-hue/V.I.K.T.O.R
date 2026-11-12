import { inspectProvider } from "./config.js";
import { toolDefinitions } from "./tools.js";

const MAX_TOOL_ROUNDS = 6;

function endpoint(baseUrl) {
  return `${baseUrl.replace(/\/+$/u, "")}/chat/completions`;
}

export async function runAgent({
  settings,
  messages,
  agent,
  memories,
  behavior = { personality: "", observations: [] },
  executeTool,
  permissions,
  fetchImpl = fetch,
}) {
  const status = await inspectProvider(settings, fetchImpl);
  if (!status.ready) throw new Error(status.message);

  const systemParts = [
    "You are VIKTOR, a personal AI assistant. Match the user's language.",
    "Plan briefly for multi-step work, use the provided tools when they help, and report actual results honestly. Never claim a file was changed or a test passed unless a tool confirms it.",
    "The workspace is the only approved file area. Do not request or expose secrets. Do not install dependencies or perform external actions. Use run_tests or run_code only when the user explicitly enabled its matching permission for this request.",
    "You may save reusable specialist agents with create_agent; the user can then select them from the interface.",
    "When the user asks for an improved prompt, preserve their intent and return a clearer version without inventing requirements.",
  ];
  if (behavior.personality) systemParts.push(`VIKTOR's internal personality and behavior rules:\n${behavior.personality}`);
  if (behavior.observations.length) {
    systemParts.push(
      `Unbestätigte temporäre Verhaltensbeobachtungen. Behandle sie nur als vorsichtigen Kontext, nicht als feste Persönlichkeitsregeln; berücksichtige sie nur, wenn sie für die aktuelle Anfrage relevant sind:\n${behavior.observations.map((item) => `- ${item.content}`).join("\n")}`,
    );
  }
  if (agent) systemParts.push(`Active specialist agent: ${agent.name}\n${agent.instructions}`);
  if (memories.length) systemParts.push(`Relevant saved local memories:\n${memories.map((item) => `- ${item.content}`).join("\n")}`);

  const conversation = [
    { role: "system", content: systemParts.join("\n\n") },
    ...messages.map(({ role, content }) => ({ role, content })),
  ];

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    let response;
    try {
      response = await fetchImpl(endpoint(settings.baseUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: settings.model,
          messages: conversation,
          tools: toolDefinitions,
          tool_choice: "auto",
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error.name === "AbortError") throw new Error("The Ollama request timed out after 60 seconds.");
      throw new Error(`Could not connect to Ollama: ${error.message}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      let detail = "";
      try {
        const errorPayload = await response.json();
        detail = typeof errorPayload.error === "string" ? ` ${errorPayload.error.slice(0, 300)}` : "";
      } catch {
        detail = "";
      }
      if (response.status === 404) {
        throw new Error(`Ollama kann das Modell „${settings.model}“ nicht finden. Prüfe den Modellnamen oder installiere es mit „ollama pull ${settings.model}“.${detail}`);
      }
      throw new Error(`Ollama antwortet mit HTTP ${response.status}.${detail} Prüfe, ob Ollama läuft und das Modell ${settings.model} verfügbar ist.`);
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Ollama returned an invalid response.");
    }
    const message = payload.choices?.[0]?.message;
    if (!message) throw new Error("Ollama's response did not contain a chat message.");
    if (!message.tool_calls?.length) {
      if (typeof message.content !== "string" || !message.content.trim()) {
        throw new Error("The model returned an empty response.");
      }
      return message.content.trim();
    }
    if (round === MAX_TOOL_ROUNDS) {
      conversation.push({ role: "assistant", content: "I reached the tool-use limit for this request." });
      break;
    }

    conversation.push(message);
    for (const call of message.tool_calls) {
      let result;
      try {
        const args = JSON.parse(call.function.arguments || "{}");
        result = await executeTool(call.function.name, args, permissions);
      } catch (error) {
        result = `Tool error: ${error.message}`;
      }
      conversation.push({
        role: "tool",
        tool_call_id: call.id,
        content: String(result).slice(0, 12_000),
      });
    }
  }
  throw new Error("VIKTOR reached its maximum number of tool-use steps. Try a smaller task.");
}
