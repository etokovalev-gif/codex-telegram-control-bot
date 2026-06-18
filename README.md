# Codex Telegram Control Bot

Telegram-пульт для приема задач и уведомлений.

## Переменные окружения

- `TELEGRAM_BOT_TOKEN` - токен от BotFather.
- `ADMIN_CHAT_ID` - Telegram chat id владельца.
- `WEBHOOK_SECRET` - секрет webhook, можно любой длинной строкой.
- `OPENAI_API_KEY` - опционально, для черновых AI-ответов прямо в Telegram.
- `OPENAI_MODEL` - опционально, по умолчанию `gpt-5.4-mini`.
- `GITHUB_TOKEN` - токен GitHub с правом создавать issues.
- `GITHUB_OWNER` - владелец репозитория очереди задач.
- `GITHUB_REPO` - репозиторий очереди задач.

## Команды

- `/start`
- `/help`
- `/task текст задачи`
- `/tasks`
- `/status`
- `/ping`

Если подключены `GITHUB_TOKEN`, `GITHUB_OWNER` и `GITHUB_REPO`, каждая задача автоматически создает GitHub Issue.
