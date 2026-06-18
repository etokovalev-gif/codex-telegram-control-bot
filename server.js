import http from "node:http";
import { randomUUID } from "node:crypto";

const token = process.env.TELEGRAM_BOT_TOKEN;
const adminChatId = process.env.ADMIN_CHAT_ID;
const adminChatIds = new Set(
  (process.env.ADMIN_CHAT_IDS || adminChatId || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);
const port = Number(process.env.PORT || 3000);
const webhookSecret = process.env.WEBHOOK_SECRET || "";
const openaiApiKey = process.env.OPENAI_API_KEY || "";
const githubToken = process.env.GITHUB_TOKEN || "";
const githubOwner = process.env.GITHUB_OWNER || "";
const githubRepo = process.env.GITHUB_REPO || "";
const transcriptionModel = process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe";
const businessContext = process.env.BUSINESS_CONTEXT || "";
const statusLabels = ["status:new", "status:in-progress", "status:done", "status:blocked"];

if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN is required");
}

if (!adminChatId) {
  throw new Error("ADMIN_CHAT_ID or ADMIN_CHAT_IDS is required");
}

const tasks = [];

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

async function telegram(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });

  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Telegram ${method} failed: ${JSON.stringify(data)}`);
  }
  return data.result;
}

async function sendTelegramText(chatId, text) {
  const maxLength = 3900;
  const cleanText = text || "Пустой ответ.";

  for (let i = 0; i < cleanText.length; i += maxLength) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: cleanText.slice(i, i + maxLength)
    });
  }
}

function htmlToPlain(text) {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"");
}

async function sendFormattedText(chatId, text) {
  const maxLength = 3600;
  const cleanText = text || "Пустой ответ.";

  for (let i = 0; i < cleanText.length; i += maxLength) {
    const chunk = cleanText.slice(i, i + maxLength);
    try {
      await telegram("sendMessage", {
        chat_id: chatId,
        text: chunk,
        parse_mode: "HTML",
        disable_web_page_preview: true
      });
    } catch (error) {
      console.error(error);
      await sendTelegramText(chatId, htmlToPlain(chunk));
    }
  }
}

function isAdmin(message) {
  return adminChatIds.has(String(message?.chat?.id || ""));
}

function helpText() {
  return [
    "🤖 Я пульт управления Codex.",
    "",
    "📌 Команды:",
    "/task текст задачи - поставить задачу",
    "/ask вопрос - спросить AI без создания GitHub Issue",
    "/tasks - показать открытую очередь задач",
    "/work номер - взять задачу в работу",
    "/done номер - отметить задачу готовой",
    "/block номер причина - заблокировать задачу",
    "/todo номер - вернуть задачу в новые",
    "/status - проверить, что бот жив",
    "/ping - быстрый тест связи",
    "/help - список команд",
    "",
    "🎙 Голосовое сообщение тоже работает: я расшифрую его и поставлю задачу.",
    "",
    "Можно просто написать задачу обычным сообщением, я сохраню ее как /task."
  ].join("\n");
}

function githubEnabled() {
  return Boolean(githubToken && githubOwner && githubRepo);
}

async function githubRequest(path, options = {}) {
  if (!githubEnabled()) {
    throw new Error("GitHub Issues are not configured");
  }

  const response = await fetch(`https://api.github.com/repos/${githubOwner}/${githubRepo}${path}`, {
    ...options,
    headers: {
      "accept": "application/vnd.github+json",
      "authorization": `Bearer ${githubToken}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "codex-telegram-control-bot",
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`GitHub request failed: ${response.status} ${JSON.stringify(data)}`);
  }

  return data;
}

async function createGitHubIssue(task, message) {
  if (!githubEnabled()) {
    return null;
  }

  const body = [
    "## Задача из Telegram",
    "",
    task.text,
    "",
    "## Метаданные",
    "",
    `- Task ID: ${task.id}`,
    `- Created at: ${task.createdAt}`,
    `- Telegram from: ${message.from?.first_name || "admin"}`,
    `- Telegram user id: ${message.from?.id || "unknown"}`,
    `- Telegram chat id: ${message.chat?.id || "unknown"}`,
    "",
    "## Ожидаемое действие",
    "",
    "Разобрать задачу, при необходимости уточнить детали у владельца, выполнить работу и отчитаться результатом."
  ].join("\n");

  const data = await githubRequest("/issues", {
    method: "POST",
    body: JSON.stringify({
      title: `[Telegram] ${task.text.slice(0, 80)}`,
      body,
      labels: ["telegram-task", "status:new"]
    })
  });

  return { number: data.number, url: data.html_url };
}

function statusLabel(issue) {
  const label = (issue.labels || []).find((item) => statusLabels.includes(item.name));
  return label?.name || "status:new";
}

function statusTitle(label) {
  return {
    "status:new": "🆕 новая",
    "status:in-progress": "🔧 в работе",
    "status:done": "✅ готово",
    "status:blocked": "⛔ заблокирована"
  }[label] || "🆕 новая";
}

async function listGitHubTasks(limit = 10) {
  const params = new URLSearchParams({
    state: "open",
    labels: "telegram-task",
    per_page: String(limit),
    sort: "created",
    direction: "desc"
  });

  return githubRequest(`/issues?${params.toString()}`, { method: "GET" });
}

async function setIssueStatus(issueNumber, nextStatus, note = "") {
  const issue = await githubRequest(`/issues/${issueNumber}`, { method: "GET" });
  const nextLabel = `status:${nextStatus}`;
  const labels = new Set((issue.labels || []).map((label) => label.name));

  for (const label of statusLabels) {
    labels.delete(label);
  }
  labels.add("telegram-task");
  labels.add(nextLabel);

  const body = { labels: [...labels] };
  if (nextStatus === "done") {
    body.state = "closed";
    body.state_reason = "completed";
  } else if (issue.state === "closed") {
    body.state = "open";
  }

  const updated = await githubRequest(`/issues/${issueNumber}`, {
    method: "PATCH",
    body: JSON.stringify(body)
  });

  if (note) {
    await githubRequest(`/issues/${issueNumber}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: `Telegram status note:\n\n${note}` })
    });
  }

  return updated;
}

async function answerWithOpenAI(prompt) {
  if (!openaiApiKey) {
    return null;
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${openaiApiKey}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-5.4-mini",
      input: [
        {
          role: "system",
          content: [
            "Ты русскоязычный бизнес-помощник владельца сервиса ПодариТрек.",
            "Отвечай по конкретному бизнесу, а не типовыми списками.",
            "Если в контексте есть релевантные факты, используй их и называй ФАКТ.",
            "Если делаешь предположение, называй ГИПОТЕЗА и уровень уверенности.",
            "Давай максимум 5 пунктов. Сначала главный вывод одним предложением.",
            "Оформляй ответ красиво для Telegram.",
            "Используй только Telegram HTML: <b>заголовки</b>, <i>акценты и призывы</i>, <u>важные смыслы</u>, <code>короткие команды</code>.",
            "Не используй Markdown: не пиши **жирный** и ###.",
            "Используй тематические эмодзи в заголовках: 🎯, 📊, ⚠️, 💰, ✅, 🚫, 🔥.",
            "Делай короткие абзацы, пустые строки между блоками, максимум 5 смысловых блоков.",
            "Главное должно быть видно за первые 2 строки.",
            "Не раскрывай внутренние цифры без необходимости. Если цифра нужна для ответа, используй только релевантные факты.",
            "Если данных не хватает, прямо скажи: недостаточно данных.",
            businessContext ? `\nКонтекст бизнеса:\n${businessContext}` : "\nКонтекст бизнеса не подключен."
          ].join("\n")
        },
        {
          role: "user",
          content: prompt
        }
      ]
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI request failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  return extractResponseText(data);
}

function extractResponseText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const chunks = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") {
        chunks.push(content.text);
      }
      if (typeof content.output_text === "string") {
        chunks.push(content.output_text);
      }
    }
  }

  return chunks.join("\n").trim() || null;
}

async function downloadTelegramFile(fileId) {
  const file = await telegram("getFile", { file_id: fileId });
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);

  if (!response.ok) {
    throw new Error(`Telegram file download failed: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    fileName: file.file_path.split("/").pop() || "voice.ogg"
  };
}

async function transcribeTelegramVoice(fileId) {
  if (!openaiApiKey) {
    throw new Error("OPENAI_API_KEY is required for voice transcription");
  }

  const { buffer, fileName } = await downloadTelegramFile(fileId);
  const form = new FormData();
  form.append("model", transcriptionModel);
  form.append("response_format", "json");
  form.append(
    "prompt",
    "Русская речь владельца бизнеса ПодариТрек. Возможные слова: ПодариТрек, Telegram, Railway, GitHub, Codex, лендинг, бот, воронка, оффер, апсейл."
  );
  form.append("file", new Blob([buffer], { type: "audio/ogg" }), fileName);

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${openaiApiKey}`
    },
    body: form
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`OpenAI transcription failed: ${response.status} ${JSON.stringify(data)}`);
  }

  return data.text || "";
}

async function createTask(message, text) {
  const taskText = text.trim();
  if (!taskText) {
    await sendFormattedText(message.chat.id, [
      "<b>⚠️ Не вижу текст задачи</b>",
      "",
      "Напиши после команды, что нужно сделать.",
      "",
      "<i>Пример: /task Сделай лендинг для акции 8 марта</i>"
    ].join("\n"));
    return;
  }

  const task = {
    id: randomUUID().slice(0, 8),
    text: taskText,
    createdAt: new Date().toISOString(),
    from: message.from?.first_name || "admin"
  };
  tasks.unshift(task);
  tasks.splice(20);

  let issue = null;
  try {
    issue = await createGitHubIssue(task, message);
  } catch (error) {
    console.error(error);
  }

  await sendFormattedText(message.chat.id, [
    "<b>✅ Задача принята</b>",
    "",
    issue ? `<b>GitHub:</b> #${issue.number}` : `<b>ID:</b> #${task.id}`,
    `<b>Статус:</b> ${statusTitle("status:new")}`,
    "",
    task.text,
    "",
    issue
      ? `<i>Команды: /work ${issue.number}, /done ${issue.number}, /block ${issue.number} причина</i>`
      : "<i>GitHub Issue не создан.</i>"
  ].join("\n"));

  if (openaiApiKey) {
    const aiText = await answerWithOpenAI(task.text);
    if (aiText) {
      await sendFormattedText(message.chat.id, `<b>Черновой ответ:</b>\n\n${aiText}`);
    }
  }
}

async function askAssistant(message, text) {
  const prompt = text.trim();
  if (!prompt) {
    await telegram("sendMessage", {
      chat_id: message.chat.id,
      text: "Напиши вопрос после /ask. Например: /ask Какие слабые места у нашей воронки?"
    });
    return;
  }

  if (!openaiApiKey) {
    await telegram("sendMessage", {
      chat_id: message.chat.id,
      text: "OpenAI API пока не подключен. Сохрани OPENAI_API_KEY в Railway Variables, и я начну отвечать."
    });
    return;
  }

  const aiText = await answerWithOpenAI(prompt);
  await sendFormattedText(message.chat.id, aiText || "Не получил текст ответа от OpenAI.");
}

async function sendTasksList(message) {
  if (!githubEnabled()) {
    await sendFormattedText(message.chat.id, "<b>⚠️ GitHub Issues не подключены</b>\n\nНе могу показать очередь задач.");
    return;
  }

  const issues = await listGitHubTasks(10);
  if (!issues.length) {
    await sendFormattedText(message.chat.id, "<b>✅ Открытых задач нет</b>\n\nОчередь сейчас пустая.");
    return;
  }

  const lines = ["<b>📋 Очередь задач</b>", ""];
  for (const issue of issues) {
    lines.push(`<b>#${issue.number}</b> ${statusTitle(statusLabel(issue))}`);
    lines.push(issue.title.replace(/</g, "&lt;").replace(/>/g, "&gt;"));
    lines.push("");
  }
  lines.push("<i>Команды: /work номер, /done номер, /block номер причина, /todo номер</i>");
  await sendFormattedText(message.chat.id, lines.join("\n"));
}

async function handleStatusCommand(message, text, nextStatus) {
  const match = text.match(/^\/\w+(?:@\w+)?\s+(\d+)(?:\s+([\s\S]+))?$/);
  if (!match) {
    await sendFormattedText(message.chat.id, [
      "<b>⚠️ Нужен номер задачи</b>",
      "",
      "<i>Пример: /work 12</i>",
      "<i>Пример: /block 12 жду материалы от клиента</i>"
    ].join("\n"));
    return;
  }

  if (!githubEnabled()) {
    await sendFormattedText(message.chat.id, "<b>⚠️ GitHub Issues не подключены</b>\n\nНе могу менять статусы.");
    return;
  }

  const issueNumber = Number(match[1]);
  const note = (match[2] || "").trim();
  const issue = await setIssueStatus(issueNumber, nextStatus, note);

  await sendFormattedText(message.chat.id, [
    "<b>✅ Статус обновлен</b>",
    "",
    `<b>Задача:</b> #${issue.number}`,
    `<b>Статус:</b> ${statusTitle(`status:${nextStatus}`)}`,
    "",
    issue.title.replace(/</g, "&lt;").replace(/>/g, "&gt;")
  ].join("\n"));
}

function parseVoiceIntent(text) {
  const normalized = text.trim();
  const askMatch = normalized.match(/^(вопрос|спроси|ask)[:,.!?\s-]+(.+)/i);
  const taskMatch = normalized.match(/^(задача|task)[:,.!?\s-]+(.+)/i);

  if (askMatch) {
    return { kind: "ask", text: askMatch[2] };
  }

  if (taskMatch) {
    return { kind: "task", text: taskMatch[2] };
  }

  return { kind: "task", text: normalized };
}

async function handleVoice(message) {
  if (!openaiApiKey) {
    await telegram("sendMessage", {
      chat_id: message.chat.id,
      text: "Голосовые пока не работают: OpenAI API не подключен."
    });
    return;
  }

  await telegram("sendMessage", {
    chat_id: message.chat.id,
    text: "Слушаю голосовое и расшифровываю..."
  });

  const transcript = await transcribeTelegramVoice(message.voice.file_id);
  const intent = parseVoiceIntent(transcript);

  await telegram("sendMessage", {
    chat_id: message.chat.id,
    text: `Расшифровка:\n\n${transcript}`
  });

  if (intent.kind === "ask") {
    await askAssistant(message, intent.text);
    return;
  }

  await createTask(message, intent.text);
}

async function handleMessage(message) {
  if (!isAdmin(message)) {
    await telegram("sendMessage", {
      chat_id: message.chat.id,
      text: [
        "Доступ закрыт.",
        "",
        `Твой chat_id: ${message.chat.id}`,
        "",
        "Отправь этот номер владельцу, чтобы он добавил тебя в админы."
      ].join("\n")
    });
    return;
  }

  const text = message.text || "";

  if (message.voice) {
    await handleVoice(message);
    return;
  }

  if (text === "/start" || text === "/help") {
    await telegram("sendMessage", { chat_id: message.chat.id, text: helpText() });
    return;
  }

  if (text === "/ping") {
    await telegram("sendMessage", { chat_id: message.chat.id, text: "pong" });
    return;
  }

  if (text === "/status") {
    await telegram("sendMessage", {
      chat_id: message.chat.id,
      text: [
        "Бот работает.",
        `Задач в памяти: ${tasks.length}`,
        `OpenAI: ${openaiApiKey ? "подключен" : "не подключен"}`,
        `GitHub Issues: ${githubEnabled() ? `${githubOwner}/${githubRepo}` : "не подключены"}`,
        `Business context: ${businessContext ? "подключен" : "не подключен"}`
      ].join("\n")
    });
    return;
  }

  if (text === "/tasks") {
    await sendTasksList(message);
    return;
  }

  if (text.startsWith("/work")) {
    await handleStatusCommand(message, text, "in-progress");
    return;
  }

  if (text.startsWith("/done")) {
    await handleStatusCommand(message, text, "done");
    return;
  }

  if (text.startsWith("/block")) {
    await handleStatusCommand(message, text, "blocked");
    return;
  }

  if (text.startsWith("/todo")) {
    await handleStatusCommand(message, text, "new");
    return;
  }

  if (text.startsWith("/task")) {
    await createTask(message, text.replace(/^\/task(@\w+)?/i, ""));
    return;
  }

  if (text.startsWith("/ask")) {
    await askAssistant(message, text.replace(/^\/ask(@\w+)?/i, ""));
    return;
  }

  await createTask(message, text);
}

async function handleUpdate(update) {
  if (update.message) {
    await handleMessage(update.message);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && req.url === "/telegram") {
      if (webhookSecret) {
        const headerSecret = req.headers["x-telegram-bot-api-secret-token"];
        if (headerSecret !== webhookSecret) {
          json(res, 403, { ok: false });
          return;
        }
      }

      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", async () => {
        try {
          const update = JSON.parse(raw || "{}");
          await handleUpdate(update);
          json(res, 200, { ok: true });
        } catch (error) {
          console.error(error);
          json(res, 200, { ok: true, handled: false });
        }
      });
      return;
    }

    json(res, 404, { ok: false });
  } catch (error) {
    console.error(error);
    json(res, 500, { ok: false, error: "internal_error" });
  }
});

server.listen(port, () => {
  console.log(`Telegram control bot listening on ${port}`);
});
