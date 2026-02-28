# ClaudeClaw

```
 ██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗
██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝
██║     ██║     ███████║██║   ██║██║  ██║█████╗
██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝
╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗
 ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝╚══════╝
 ██████╗██╗      █████╗ ██╗    ██╗
██╔════╝██║     ██╔══██╗██║    ██║
██║     ██║     ███████║██║ █╗ ██║
██║     ██║     ██╔══██║██║███╗██║
╚██████╗███████╗██║  ██║╚███╔███╔╝
 ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝
```

Your phone is a remote control for Claude Code running on your machine.

Send a message on Telegram. ClaudeClaw spawns the real `claude` CLI subprocess — with your skills, MCP servers, memory, and tools — and sends the result back. It's not an API wrapper. It's the same Claude Code you use in your terminal, accessible from anywhere.

---

## What it does

- **Run Claude Code from your phone** — text, voice notes, photos, documents, video
- **Persistent memory** — dual-sector SQLite store with FTS5 search and salience decay. Remembers preferences, context, and facts across conversations
- **Session continuity** — each chat resumes where it left off via Claude Code session IDs
- **Voice in, voice out** — Groq Whisper for transcription, ElevenLabs (with Google TTS fallback) for replies
- **Cron scheduler** — run prompts on a timer. Daily briefings, autonomous tasks, reminders
- **Media handling** — analyze photos and documents inline; video via Gemini API
- **Your global skills** — any skill in `~/.claude/skills/` is automatically available
- **Auto-restart** — hot reloads when `.env` changes, kills stale processes on startup

---

## Architecture

```
Telegram
    ↓
Media handler (voice/photo/doc/video → local file)
    ↓
Memory context builder (FTS5 search + recent recall → injected above message)
    ↓
Claude Code SDK  ←→  SQLite session store (per chat)
    ↓
Response formatter (Markdown → Telegram HTML)
    ↓
Optional TTS (ElevenLabs → Google fallback) → voice reply
```

---

## Stack

| Layer | Choice |
|-------|--------|
| Messaging | Telegram (grammy) |
| AI runtime | `@anthropic-ai/claude-agent-sdk` — spawns `claude` CLI |
| Database | `better-sqlite3` (WAL mode, FTS5) |
| Voice STT | Groq Whisper (`whisper-large-v3`) |
| Voice TTS | ElevenLabs `eleven_turbo_v2_5`, falls back to Google TTS |
| Scheduler | `cron-parser` + 60s polling loop |
| Logging | `pino` + `pino-pretty` |
| Language | TypeScript, compiled to `dist/` |

---

## Source files

```
src/
  index.ts        entry point, PID lock, startup sequence
  agent.ts        Claude Code SDK wrapper — runAgent()
  bot.ts          Telegram handlers, message pipeline, voice toggle
  db.ts           SQLite schema + all query functions
  memory.ts       dual-sector memory, FTS5 search, salience decay
  voice.ts        Groq STT, ElevenLabs TTS, Google TTS fallback
  media.ts        Telegram file downloads, media cleanup
  scheduler.ts    cron task runner, 60s polling
  schedule-cli.ts CLI for managing scheduled tasks
  config.ts       env var loader
  env.ts          .env parser (no process.env pollution)
  logger.ts       pino setup

scripts/
  start.mjs       build-then-run wrapper with .env hot reload
  setup.ts        interactive setup wizard
  status.ts       health check
  notify.sh       send a Telegram message from shell
```

---

## Setup

**Prerequisites:** Node 20+, Claude Code CLI installed and logged in, Telegram account.

```bash
npm install
npm run setup    # collects API keys, writes .env, installs background service
```

The setup wizard handles everything interactively.

---

## Running

The preferred way is the startup script — opens the bot and a Claude Code session side by side in Windows Terminal:

```powershell
powershell -File scripts\startup.ps1
```

This is also registered as a Task Scheduler job so both panes launch automatically at login. To re-register after a fresh clone:

```powershell
powershell -File scripts\register-startup.ps1
```

Other options:

```bash
npm start        # bot only — builds fresh from source, then runs
npm run dev      # tsx direct, no build step (development)
npm run status   # health check — tokens, voice, DB, scheduler
```

`npm start` always rebuilds before launching so you never run stale compiled output. It also watches `.env` and restarts automatically when it changes.

---

## Environment variables

```bash
# Required
TELEGRAM_BOT_TOKEN=      # from @BotFather
ALLOWED_CHAT_ID=         # your Telegram chat ID (send /chatid after first run)

# Voice STT (pick one)
GROQ_API_KEY=            # free at console.groq.com

# Voice TTS
ELEVENLABS_API_KEY=      # elevenlabs.io
ELEVENLABS_VOICE_ID=     # voice ID from ElevenLabs dashboard

# Video + TTS fallback
GOOGLE_API_KEY=          # aistudio.google.com (free)
```

---

## Bot commands

| Command | Action |
|---------|--------|
| `/newchat` | Start a fresh conversation (clears session) |
| `/voice` | Toggle voice replies on/off (default: on) |
| `/memory` | Show memory stats |
| `/chatid` | Echo your chat ID |
| `/schedule` | Manage scheduled tasks |

Voice is on by default. Replies to voice messages are always audio.

---

## Memory system

Memories live in SQLite with two sectors:

- **Semantic** — triggered by phrases like "my", "I prefer", "remember". Long-lived.
- **Episodic** — regular conversation turns. Decay faster.

Every message: FTS5 full-text search + recent recall inject relevant past context above the prompt. Memories decay 2%/day and auto-delete below salience 0.1. Frequently accessed memories get reinforced.

Special commands in chat:
- `convolife` — check context window usage
- `checkpoint` — save a session summary to memory (safe to `/newchat` after)

---

## Scheduler

Create cron tasks from the CLI or from within the bot:

```bash
node dist/schedule-cli.js create "Summarize my emails" "0 9 * * *" YOUR_CHAT_ID
node dist/schedule-cli.js list
node dist/schedule-cli.js pause <id>
node dist/schedule-cli.js delete <id>
```

Common patterns: `0 9 * * *` (daily 9am), `0 9 * * 1` (Monday 9am), `0 */4 * * *` (every 4h).

---

## Cost to run

The Claude Code subscription you already have covers core usage. Optional:
- Groq STT: free tier, generous limits
- ElevenLabs TTS: ~$5/month starter
- Google (video + TTS fallback): free tier
