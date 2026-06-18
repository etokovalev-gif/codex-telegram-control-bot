import http from "node:http";
import { randomUUID } from "node:crypto";

const token = process.env.TELEGRAM_BOT_TOKEN;
const adminChatId = process.env.ADMIN_CHAT_ID;
const port = Number(process.env.PORT || 3000);
const webhookSecret = process.env.WEBHOOK_SECRET || "";
const openaiApiKey = process.env.OPENAI_API_KEY || "";

if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN is required");
}

if (!adminChatId) {
  throw new Error("ADMIN_CHAT_ID is required");
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
  return String(message?.chat?.id || "") === String(adminChatId);
}

function helpText() {
  return [
    "Я пульт управления Codex.",
    "",
    "Команды:",
    "/task текст задачи - поставить задачу",
    "/tasks - показать последние задачи",
    "/status - проверить, что бот жив",
    "/ping - быстрый тест связи",
    "/help - список команд",
    "",
    "Можно просто написать задачу обычным сообщением, я сохраню ее как /task."
  ].join("\n");
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

  await telegram("sendMessage", {
    chat_id: message.chat.id,
    text: `Задача принята: #${task.id}\n\n${task.text}`
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

async function handleMessage(message) {
  if (!isAdmin(message)) {
    await telegram("sendMessage", {
      chat_id: message.chat.id,
      text: "Доступ закрыт."
    });
    return;
  }

  const text = message.text || "";

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
        `OpenAI: ${openaiApiKey ? "подключен" : "не подключен"}`
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
