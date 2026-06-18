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

function isAdmin(message) {
  return adminChatIds.has(String(message?.chat?.id || ""));
}

function helpText() {
  return [
    "Я пульт управления Codex.",
    "",
    "Команды:",
    "/task текст задачи - поставить задачу",
    "/ask вопрос - спросить AI без создания GitHub Issue",
    "Голосовое сообщение - расшифровать и поставить задачу",
    "/tasks - показать последние задачи",
    "/status - проверить, что бот жив",
    "/ping - быстрый тест связи",
    "/help - список команд",
    "",
    "Можно просто написать задачу обычным сообщением, я сохраню ее как /task."
  ].join("\n");
}

function githubEnabled() {
  return Boolean(githubToken && githubOwner && githubRepo);
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

  const response = await fetch(`https://api.github.com/repos/${githubOwner}/${githubRepo}/issues`, {
    method: "POST",
    headers: {
      "accept": "application/vnd.github+json",
      "authorization": `Bearer ${githubToken}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "codex-telegram-control-bot"
    },
    body: JSON.stringify({
      title: `[Telegram] ${task.text.slice(0, 80)}`,
      body,
      labels: ["telegram-task"]
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`GitHub issue creation failed: ${response.status} ${JSON.stringify(data)}`);
  }

  return data.html_url;
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
          content: "Ты краткий русскоязычный помощник владельца бизнеса ПодариТрек. Отвечай по делу."
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
  return data.output_text || null;
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
    await telegram("sendMessage", {
      chat_id: message.chat.id,
      text: "Напиши задачу после /task. Например: /task Сделай лендинг для акции 8 марта"
    });
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

  let issueUrl = null;
  try {
    issueUrl = await createGitHubIssue(task, message);
  } catch (error) {
    console.error(error);
  }

  await telegram("sendMessage", {
    chat_id: message.chat.id,
    text: [
      `Задача принята: #${task.id}`,
      "",
      task.text,
      "",
      issueUrl ? `GitHub Issue: ${issueUrl}` : "GitHub Issue: не создан"
    ].join("\n")
  });

  if (openaiApiKey) {
    const aiText = await answerWithOpenAI(task.text);
    if (aiText) {
      await telegram("sendMessage", {
        chat_id: message.chat.id,
        text: `Черновой ответ:\n\n${aiText}`
      });
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
  await telegram("sendMessage", {
    chat_id: message.chat.id,
    text: aiText || "Не получил текст ответа от OpenAI."
  });
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
        `GitHub Issues: ${githubEnabled() ? `${githubOwner}/${githubRepo}` : "не подключены"}`
      ].join("\n")
    });
    return;
  }

  if (text === "/tasks") {
    const recent = tasks.slice(0, 10);
    await telegram("sendMessage", {
      chat_id: message.chat.id,
      text: recent.length
        ? recent.map((task) => `#${task.id} ${task.text}`).join("\n\n")
        : "Пока задач нет."
    });
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
        const update = JSON.parse(raw || "{}");
        await handleUpdate(update);
        json(res, 200, { ok: true });
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
