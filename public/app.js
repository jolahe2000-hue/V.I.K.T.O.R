const $ = (selector) => document.querySelector(selector);
const viewTitles = {
  chat: "Chat mit Viktor",
  agents: "Agenten",
  workspace: "Projekt",
  memory: "Memory & Logs",
  settings: "Einstellungen",
};
const state = { messages: [], agents: [], currentView: "chat", busy: false, providerStatus: null };

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Anfrage fehlgeschlagen (${response.status}).`);
  return result;
}

function setProviderStatus(status) {
  state.providerStatus = status;
  const dot = $("#provider-dot");
  const label = $("#provider-status");
  dot.classList.toggle("ready", status.ready);
  dot.classList.toggle("error", !status.ready);
  label.textContent = status.ready
    ? `Ollama · ${status.model}`
    : "Ollama-Modell nicht bereit";
  $("#workspace-name").textContent = status.workspace;
  $("#project-title").textContent = status.workspace;
  const notice = $("#model-notice");
  notice.hidden = status.ready;
  $("#model-notice-title").textContent = "Ollama oder das ausgewählte Modell ist noch nicht startbereit.";
  $("#model-notice-text").textContent = status.message;
  $("#local-setup-actions").hidden = false;
  $("#ollama-pull-command").textContent = `ollama pull ${status.model}`;
}

function renderMessages() {
  const list = $("#message-list");
  list.replaceChildren();
  if (!state.messages.length) {
    const welcome = document.createElement("div");
    welcome.className = "welcome";
    welcome.innerHTML = '<div class="welcome-mark">V</div><span class="eyebrow">WAS KANN ICH FÜR DICH TUN?</span><h2>Hey, ich bin Viktor.</h2><p>Ich kann mit dir Ideen durchdenken, dein Projekt untersuchen, Dateien bearbeiten und spezialisierte Agenten erstellen.</p><div class="suggestions"><button class="suggestion" data-prompt="Analysiere die Struktur dieses Projekts.">Projekt analysieren</button><button class="suggestion" data-prompt="Erstelle einen spezialisierten Agenten für meine Aufgabe.">Agent erstellen</button><button class="suggestion" data-prompt="Hilf mir, einen kleinen Prompt-Fixer zu bauen und zu testen.">Prompt-Fixer bauen</button></div>';
    list.append(welcome);
    return;
  }
  for (const message of state.messages) {
    const row = document.createElement("article");
    row.className = `message ${message.role}`;
    if (message.id) row.dataset.messageId = message.id;
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = message.role === "user" ? "D" : "V";
    const body = document.createElement("div");
    body.className = "message-body";
    const meta = document.createElement("div");
    meta.className = "message-meta";
    meta.textContent = message.role === "user" ? "Du" : "Viktor";
    const content = document.createElement("div");
    content.className = "message-text";
    content.textContent = message.content;
    body.append(meta, content);
    if (message.role === "assistant" && message.id) {
      const actions = document.createElement("div");
      actions.className = "feedback-actions";
      if (message.feedback) {
        const status = document.createElement("span");
        status.className = "feedback-status";
        status.textContent = message.feedback.rating === "helpful"
          ? "✓ Als hilfreich gespeichert"
          : "✓ Deine Korrektur wurde gespeichert";
        actions.append(status);
      } else {
        const helpful = document.createElement("button");
        helpful.className = "feedback-button";
        helpful.type = "button";
        helpful.dataset.rating = "helpful";
        helpful.textContent = "👍 Hilfreich";
        const correct = document.createElement("button");
        correct.className = "feedback-button";
        correct.type = "button";
        correct.dataset.rating = "correction";
        correct.textContent = "↩ Viktor korrigieren";
        const form = document.createElement("form");
        form.className = "feedback-form";
        form.hidden = true;
        const input = document.createElement("input");
        input.name = "correction";
        input.maxLength = 2000;
        input.required = true;
        input.placeholder = "Was sollte Viktor künftig anders machen?";
        input.setAttribute("aria-label", "Korrektur für Viktor");
        const submit = document.createElement("button");
        submit.className = "feedback-submit";
        submit.type = "submit";
        submit.textContent = "Lernen speichern";
        form.append(input, submit);
        actions.append(helpful, correct, form);
      }
      body.append(actions);
    }
    row.append(avatar, body);
    list.append(row);
  }
  list.scrollTop = list.scrollHeight;
}

function renderAgents() {
  const select = $("#agent-select");
  const selected = select.value;
  select.replaceChildren(new Option("Viktor · Allgemein", ""));
  for (const agent of state.agents) select.add(new Option(agent.name, agent.id));
  if ([...select.options].some((option) => option.value === selected)) select.value = selected;

  const container = $("#agent-list");
  container.replaceChildren();
  $("#agents-empty").hidden = state.agents.length > 0;
  for (const agent of state.agents) {
    const card = document.createElement("article");
    card.className = "info-card";
    const heading = document.createElement("h3");
    heading.textContent = agent.name;
    const description = document.createElement("p");
    description.textContent = agent.description;
    const created = document.createElement("time");
    created.textContent = new Date(agent.createdAt).toLocaleString("de-DE");
    card.append(heading, description, created);
    container.append(card);
  }
}

async function loadStatus() {
  setProviderStatus(await api("/api/status"));
}

async function loadAgents() {
  state.agents = await api("/api/agents");
  renderAgents();
}

async function loadWorkspace() {
  const workspace = await api("/api/workspace");
  $("#project-title").textContent = workspace.name;
  $("#workspace-name").textContent = workspace.name;
  const list = $("#file-list");
  list.replaceChildren();
  if (!workspace.files.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Noch keine Projektdateien vorhanden.";
    list.append(empty);
    return;
  }
  for (const file of workspace.files) {
    const row = document.createElement("div");
    row.className = "file-row";
    const name = document.createElement("span");
    name.textContent = file.name;
    const type = document.createElement("span");
    type.className = "file-type";
    type.textContent = file.type === "folder" ? "Ordner" : `${file.size.toLocaleString("de-DE")} Bytes`;
    row.append(name, type);
    list.append(row);
  }
}

async function loadMemoryAndLogs() {
  const [memories, logs] = await Promise.all([api("/api/memories"), api("/api/logs")]);
  const memoryList = $("#memory-list");
  memoryList.replaceChildren();
  if (!memories.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Noch keine Erinnerungen. Viktor kann hilfreiche Fakten auf Wunsch lokal speichern.";
    memoryList.append(empty);
  }
  for (const memory of memories) {
    const card = document.createElement("article");
    card.className = "info-card";
    const content = document.createElement("p");
    content.textContent = memory.content;
    const created = document.createElement("time");
    created.textContent = new Date(memory.createdAt).toLocaleString("de-DE");
    card.append(content, created);
    memoryList.append(card);
  }
  const logList = $("#log-list");
  logList.replaceChildren();
  if (!logs.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Noch keine protokollierten Aufgaben.";
    logList.append(empty);
  }
  for (const log of logs.slice().reverse()) {
    const row = document.createElement("div");
    row.className = "log-row";
    const message = document.createElement("span");
    message.textContent = log.message;
    const timestamp = document.createElement("time");
    timestamp.textContent = new Date(log.createdAt).toLocaleTimeString("de-DE");
    row.append(message, timestamp);
    logList.append(row);
  }
}

async function loadSettings() {
  const settings = await api("/api/settings");
  $("#model-name").value = settings.model;
}

function showView(name) {
  state.currentView = name;
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${name}`));
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  $("#page-title").textContent = viewTitles[name];
  if (name === "workspace") loadWorkspace().catch(showError);
  if (name === "agents") loadAgents().catch(showError);
  if (name === "memory") loadMemoryAndLogs().catch(showError);
  if (name === "settings") loadSettings().catch(showError);
}

function showError(error) {
  const stateLabel = $("#task-state span:last-child");
  stateLabel.textContent = error.message;
  $("#task-state .status-dot").classList.add("error");
}

async function sendMessage(text) {
  const message = text.trim();
  if (!message || state.busy) return;
  state.messages.push({ role: "user", content: message });
  renderMessages();
  $("#message-input").value = "";
  state.busy = true;
  $("#send-button").disabled = true;
  $("#task-state span:last-child").textContent = "Viktor arbeitet …";
  $("#task-state .status-dot").classList.add("ready");
  const pending = { role: "assistant", content: "Ich kümmere mich darum …" };
  state.messages.push(pending);
  renderMessages();
  try {
    const result = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        message,
        agentId: $("#agent-select").value || null,
        allowTests: $("#allow-tests").checked,
        allowCodeExecution: $("#allow-code").checked,
      }),
    });
    pending.content = result.answer;
    pending.id = result.messageId;
    $("#task-state span:last-child").textContent = "Bereit";
    $("#task-state .status-dot").classList.remove("error");
    if (state.currentView === "memory") await loadMemoryAndLogs();
    await loadAgents();
  } catch (error) {
    pending.content = error.message;
    pending.role = "assistant error";
    $("#task-state span:last-child").textContent = "Aufgabe fehlgeschlagen";
    $("#task-state .status-dot").classList.add("error");
  } finally {
    state.busy = false;
    $("#send-button").disabled = false;
    renderMessages();
  }
}

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => showView(button.dataset.view));
});
$("#chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  sendMessage($("#message-input").value);
});
$("#message-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-prompt]");
  if (button?.dataset.prompt) {
    $("#message-input").value = button.dataset.prompt;
    $("#message-input").focus();
    return;
  }
  const feedbackButton = event.target.closest("[data-rating]");
  if (!feedbackButton) return;
  const article = feedbackButton.closest(".message");
  const message = state.messages.find((item) => item.id === article.dataset.messageId);
  if (feedbackButton.dataset.rating === "correction") {
    const form = article.querySelector(".feedback-form");
    form.hidden = false;
    form.querySelector("input").focus();
  } else {
    saveFeedback(message, "helpful");
  }
});
$("#message-list").addEventListener("submit", (event) => {
  const form = event.target.closest(".feedback-form");
  if (!form) return;
  event.preventDefault();
  const article = form.closest(".message");
  const message = state.messages.find((item) => item.id === article.dataset.messageId);
  saveFeedback(message, "correction", form.elements.correction.value.trim());
});
$("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const feedback = $("#settings-feedback");
  feedback.textContent = "";
  feedback.classList.remove("error");
  try {
    await api("/api/settings", {
      method: "POST",
      body: JSON.stringify({ model: $("#model-name").value }),
    });
    feedback.textContent = "Gespeichert.";
    await loadStatus();
  } catch (error) {
    feedback.textContent = error.message;
    feedback.classList.add("error");
  }
});

async function initialize() {
  try {
    const [status, messages, agents] = await Promise.all([
      api("/api/status"),
      api("/api/history"),
      api("/api/agents"),
    ]);
    setProviderStatus(status);
    state.messages = messages;
    state.agents = agents;
    renderMessages();
    renderAgents();
  } catch (error) {
    showError(error);
  }
}

initialize();

async function saveFeedback(message, rating, correction = "") {
  if (!message?.id) return;
  const article = [...document.querySelectorAll(".message")].find((item) => item.dataset.messageId === message.id);
  const actions = article?.querySelector(".feedback-actions");
  if (!actions) return;
  actions.querySelectorAll("button, input").forEach((control) => { control.disabled = true; });
  try {
    const result = await api("/api/feedback", {
      method: "POST",
      body: JSON.stringify({ messageId: message.id, rating, correction }),
    });
    message.feedback = result.feedback;
    renderMessages();
    if (result.warning) showError(new Error(result.warning));
    if (state.currentView === "memory") await loadMemoryAndLogs();
  } catch (error) {
    actions.querySelectorAll("button, input").forEach((control) => { control.disabled = false; });
    const notice = document.createElement("span");
    notice.className = "feedback-status";
    notice.textContent = error.message;
    actions.append(notice);
  }
}
