import { Bot, Context, InputFile, InlineKeyboard } from 'grammy';
import type { MessageEntity } from 'grammy/types';
import { markdownToFormattable } from '@gramio/format/markdown';
import {
  TELEGRAM_BOT_TOKEN,
  ALLOWED_CHAT_ID,
  MAX_MESSAGE_LENGTH,
  TYPING_REFRESH_MS,
} from './config.js';
import { getSession, setSession, clearSession, getMemoryCount, createTask, listTasks, deleteTask, pauseTask, resumeTask, insertCheckpoint, kvGet, kvSet } from './db.js';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { execFile } from 'child_process';
import { homedir } from 'os';
import { PROJECT_ROOT } from './config.js';
import { runWithFallback, AgentEvent, setOpenRouterModel, openRouterModel } from './agent.js';
import { fetchOpenRouterModels } from './openrouter.js';
import { buildMemoryContext, saveConversationTurn } from './memory.js';
import { transcribeAudio, synthesizeSpeech, voiceCapabilities } from './voice.js';
import { downloadMedia, buildPhotoMessage, buildDocumentMessage, buildVideoMessage } from './media.js';
import { computeNextRun } from './scheduler.js';
import { logger } from './logger.js';
import { randomUUID } from 'crypto';
import { generateImage } from './imagine.js';

// Voice mode toggle per chat — default ON for allowed chat
const voiceMode = new Set<string>(ALLOWED_CHAT_ID ? [ALLOWED_CHAT_ID] : []);

// Active provider per chat — 'claude' | 'codex' | 'openrouter', default claude
const activeProvider = new Map<string, 'claude' | 'codex' | 'openrouter'>();

const OR_PER_PAGE = 8;

// --- Telegram entity-based formatter ---

interface Formattable {
  text: string;
  entities: MessageEntity[];
}

export function formatForTelegram(markdown: string): Formattable {
  const result = markdownToFormattable(markdown.trim());
  return { text: result.text, entities: (result.entities ?? []) as MessageEntity[] };
}

export function splitMessage(formattable: Formattable, limit = MAX_MESSAGE_LENGTH): Formattable[] {
  const { text, entities } = formattable;
  if (text.length <= limit) return [formattable];

  const chunks: Formattable[] = [];
  let offset = 0;

  while (offset < text.length) {
    let end = Math.min(offset + limit, text.length);

    // Try to split on newline or space to avoid cutting words
    if (end < text.length) {
      const slice = text.slice(offset, end);
      const nlPos = slice.lastIndexOf('\n');
      const spPos = slice.lastIndexOf(' ');
      if (nlPos > 0) end = offset + nlPos + 1;
      else if (spPos > 0) end = offset + spPos + 1;
    }

    const chunkText = text.slice(offset, end).trimEnd();
    const chunkStart = offset;

    // Re-map entities that fall within this chunk
    const chunkEntities: MessageEntity[] = entities
      .filter(e => e.offset < end && e.offset + e.length > chunkStart)
      .map(e => ({
        ...e,
        offset: Math.max(e.offset, chunkStart) - chunkStart,
        length: Math.min(e.offset + e.length, end) - Math.max(e.offset, chunkStart),
      }))
      .filter(e => e.length > 0);

    if (chunkText) {
      chunks.push({ text: chunkText, entities: chunkEntities });
    }

    offset = end;
    // Skip leading newlines at new offset
    while (offset < text.length && text[offset] === '\n') offset++;
  }

  return chunks;
}

function formatToolInput(tool: string, input: Record<string, unknown>): string {
  const clip = (s: string, n = 80) => s.length > n ? s.slice(0, n) + '…' : s;
  switch (tool) {
    case 'Bash':        return `<code>${clip(String(input.command ?? ''))}</code>`;
    case 'Read':        return clip(String(input.file_path ?? ''));
    case 'Write':       return clip(String(input.file_path ?? ''));
    case 'Edit':        return clip(String(input.file_path ?? ''));
    case 'Glob':        return clip(String(input.pattern ?? ''));
    case 'Grep':        return `"${clip(String(input.pattern ?? ''))}"`;
    case 'WebSearch':   return `"${clip(String(input.query ?? ''))}"`;
    case 'WebFetch':    return clip(String(input.url ?? ''));
    case 'Task':        return clip(String(input.description ?? ''));
    default:            return clip(JSON.stringify(input));
  }
}

function isAuthorised(chatId: number): boolean {
  if (!ALLOWED_CHAT_ID) return true; // First-run mode
  return String(chatId) === ALLOWED_CHAT_ID;
}

async function handleMessage(ctx: Context, rawText: string, forceVoiceReply = false): Promise<void> {
  const chatId = String(ctx.chat?.id);
  if (!chatId || !ctx.chat) return;

  if (!isAuthorised(ctx.chat.id)) {
    await ctx.reply(`Unauthorized. Your chat ID: ${ctx.chat.id}`);
    return;
  }

  // Build memory context
  const memoryContext = await buildMemoryContext(chatId, rawText);
  const formatInstruction = '\n\n[Use rich Telegram-compatible Markdown to make your response as clear and readable as possible: **bold** for key terms and headers, _italic_ for emphasis, `inline code` for technical terms, ```fenced code blocks``` for multi-line code, [links](url) for URLs, numbered or bullet lists for steps/options, and bold labels instead of tables. Default to structured formatting — plain prose only for short conversational replies. Never use HTML or markdown tables. Do not announce or describe your formatting choices — just apply them.]';
  const fullMessage = (memoryContext ? `${memoryContext}\n\n${rawText}` : rawText) + formatInstruction;

  // Get existing session
  const sessionId = getSession(chatId);

  // Typing indicator
  const sendTyping = () => {
    ctx.api.sendChatAction(ctx.chat!.id, 'typing').catch(() => {});
  };
  sendTyping();
  const typingInterval = setInterval(sendTyping, TYPING_REFRESH_MS);

  // Live status message (created lazily on first tool event)
  let statusMsgId: number | null = null;
  let lastStatusUpdate = 0;
  let lastTool = '';

  const updateStatus = (text: string) => {
    const now = Date.now();
    if (now - lastStatusUpdate < 2000) return;
    lastStatusUpdate = now;
    if (statusMsgId === null) {
      ctx.reply(text, { parse_mode: 'HTML' })
        .then(msg => { statusMsgId = msg.message_id; })
        .catch(() => {});
    } else {
      ctx.api.editMessageText(ctx.chat!.id, statusMsgId, text, { parse_mode: 'HTML' }).catch(() => {});
    }
  };

  const onEvent = (event: AgentEvent) => {
    if (event.kind === 'tool_start') {
      lastTool = event.tool;
      const detail = formatToolInput(event.tool, event.input);
      updateStatus(`⚙️ <b>${event.tool}</b>\n${detail}`);
    } else if (event.kind === 'tool_progress' && event.elapsed >= 3) {
      updateStatus(`⚙️ <b>${lastTool}</b> (${Math.round(event.elapsed)}s)`);
    } else if (event.kind === 'provider_switch') {
      if (event.errorDetail) {
        ctx.reply(`<code>${event.errorDetail}</code>`, { parse_mode: 'HTML' }).catch(() => {});
      }
      const labelOf = (p: string) =>
        p === 'codex' ? 'OpenAI Codex' : p === 'openrouter' ? `OpenRouter (${openRouterModel})` : 'Claude';
      if (event.to === 'none') {
        ctx.reply(`🚫 <b>All providers rate limited</b>`, { parse_mode: 'HTML' }).catch(() => {});
      } else {
        const reasonLabel = event.reason === 'rate limited' ? 'rate limited' : 'unavailable';
        ctx.reply(`🔄 <b>${labelOf(event.from)} ${reasonLabel}</b> — switched to ${labelOf(event.to)}`, { parse_mode: 'HTML' }).catch(() => {});
      }
    }
  };

  const provider = activeProvider.get(chatId) ?? 'claude';

  try {
    let text: string | null = null;
    let newSessionId: string | undefined;

    ({ text, newSessionId } = await runWithFallback(fullMessage, provider, sessionId, sendTyping, onEvent));

    clearInterval(typingInterval);

    // Remove live status message
    if (statusMsgId !== null) {
      ctx.api.deleteMessage(ctx.chat!.id, statusMsgId).catch(() => {});
      statusMsgId = null;
    }

    // Save session
    if (newSessionId) {
      setSession(chatId, newSessionId);
    }

    if (!text) {
      await ctx.reply('(no response)');
      return;
    }

    // Save to memory
    await saveConversationTurn(chatId, rawText, text);

    // Voice reply?
    const caps = voiceCapabilities();
    // Voice reply
    if (caps.tts && (forceVoiceReply || voiceMode.has(chatId))) {
      try {
        const audio = await synthesizeSpeech(text);
        await ctx.replyWithVoice(new InputFile(audio, 'reply.mp3'));
      } catch (err) {
        logger.error({ err }, 'TTS failed, skipping voice reply');
      }
    }

    // Text reply (always sent)
    const formatted = formatForTelegram(text);
    const chunks = splitMessage(formatted).filter(c => c.text.trim());
    if (chunks.length === 0) {
      await ctx.reply('(no response)');
      return;
    }
    for (const chunk of chunks) {
      await ctx.reply(chunk.text, {
        entities: chunk.entities.length > 0 ? chunk.entities : undefined,
      });
    }
  } catch (err) {
    clearInterval(typingInterval);
    logger.error({ err }, 'Message handling error');
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`<b>Error</b>\n<code>${msg}</code>`, { parse_mode: 'HTML' });
  }
}

export function getProviderStatus(): string {
  const provider = ALLOWED_CHAT_ID ? (activeProvider.get(ALLOWED_CHAT_ID) ?? 'claude') : 'claude';
  if (provider === 'openrouter') return `OpenRouter — ${openRouterModel}`;
  if (provider === 'codex') return 'OpenAI Codex';
  return 'Claude';
}

export function createBot(): Bot {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set. Run: npm run setup');
  }

  const bot = new Bot(TELEGRAM_BOT_TOKEN);

  // Restore last provider + model from persistent state
  if (ALLOWED_CHAT_ID) {
    const savedProvider = kvGet(`provider:${ALLOWED_CHAT_ID}`);
    const savedModel = kvGet('openrouter:model');
    if (savedProvider === 'claude' || savedProvider === 'codex' || savedProvider === 'openrouter') {
      activeProvider.set(ALLOWED_CHAT_ID, savedProvider);
    }
    if (savedModel) setOpenRouterModel(savedModel);
  }

  // --- Commands ---

  bot.command('start', async (ctx) => {
    await ctx.reply(
      'ClaudeClaw is running. Send me a message and I\'ll pass it to Claude Code on your machine.\n\n' +
      'Commands:\n/newchat - Start a fresh conversation\n/chatid - Show your chat ID\n/memory - Show memory stats\n/voice - Toggle voice replies\n/schedule - Manage scheduled tasks\n/restart - Restart the bot service'
    );
  });

  bot.command('chatid', async (ctx) => {
    await ctx.reply(`Your chat ID: ${ctx.chat.id}`);
  });

  bot.command('newchat', async (ctx) => {
    clearSession(String(ctx.chat.id));
    await ctx.reply('Session cleared. Starting fresh.');
  });

  bot.command('forget', async (ctx) => {
    clearSession(String(ctx.chat.id));
    await ctx.reply('Session cleared. Starting fresh.');
  });

  bot.command('memory', async (ctx) => {
    const chatId = String(ctx.chat.id);
    if (!isAuthorised(ctx.chat.id)) return;
    const count = getMemoryCount(chatId);
    await ctx.reply(`Memory: ${count} stored memories for this chat.`);
  });

  bot.command('voice', async (ctx) => {
    const chatId = String(ctx.chat.id);
    const caps = voiceCapabilities();
    if (!caps.tts) {
      await ctx.reply('Voice replies not configured (no ElevenLabs API key).');
      return;
    }
    if (voiceMode.has(chatId)) {
      voiceMode.delete(chatId);
      await ctx.reply('Voice replies OFF. Responses will be text.');
    } else {
      voiceMode.add(chatId);
      await ctx.reply('Voice replies ON. Responses will be audio.');
    }
  });

  bot.command('convolife', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;

    try {
      // Convert project path to Claude's session directory naming convention
      const projectPath = PROJECT_ROOT.replace(/\\/g, '/');
      const normalizedPath = projectPath.replace(/^[A-Z]:/, (m) => m.toLowerCase());
      const sessionDirName = normalizedPath.replace(/\//g, '-').replace(/^-/, '');
      const claudeProjectsDir = join(homedir(), '.claude', 'projects', sessionDirName);

      if (!existsSync(claudeProjectsDir)) {
        await ctx.reply(`Session directory not found: ${claudeProjectsDir}`);
        return;
      }

      // Find latest JSONL file
      const files = readdirSync(claudeProjectsDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({ name: f, mtime: statSync(join(claudeProjectsDir, f)).mtime }))
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

      if (files.length === 0) {
        await ctx.reply('No session files found.');
        return;
      }

      const latestFile = join(claudeProjectsDir, files[0].name);
      const content = readFileSync(latestFile, 'utf-8');
      const lines = content.trim().split('\n');

      // Find last cache_read_input_tokens value
      let lastTokens = 0;
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]);
          if (entry.cache_read_input_tokens) {
            lastTokens = entry.cache_read_input_tokens;
            break;
          }
        } catch { /* skip invalid JSON lines */ }
      }

      const maxTokens = 200000;
      const percentUsed = ((lastTokens / maxTokens) * 100).toFixed(1);
      const tokensRemaining = maxTokens - lastTokens;
      const tokensRemainingK = (tokensRemaining / 1000).toFixed(0);

      await ctx.reply(`Context window: ${percentUsed}% used - ~${tokensRemainingK}k tokens remaining`);
    } catch (err) {
      logger.error({ err }, 'convolife error');
      await ctx.reply('Failed to check context window.');
    }
  });

  bot.command('checkpoint', async (ctx) => {
    const chatId = String(ctx.chat.id);
    if (!isAuthorised(ctx.chat.id)) return;

    const text = ctx.message?.text?.replace('/checkpoint', '').trim();
    if (!text) {
      await ctx.reply('Usage: /checkpoint <summary of key decisions/findings>\n\nExample: /checkpoint - Set up ElevenLabs voice\n- Added Google TTS fallback\n- Fixed API key issue');
      return;
    }

    try {
      insertCheckpoint(chatId, text);
      const script = resolve(PROJECT_ROOT, 'scripts/ingest-sessions.js');
      execFile(process.execPath, [script], (err, stdout, stderr) => {
        if (err) logger.warn({ err, stderr }, 'ingest-sessions failed on checkpoint');
        else logger.info({ output: stdout.trim() }, 'ingest-sessions complete on checkpoint');
      });
      await ctx.reply('Checkpoint saved. Safe to /newchat.');
    } catch (err) {
      logger.error({ err }, 'checkpoint error');
      await ctx.reply('Failed to save checkpoint.');
    }
  });

  bot.command('provider', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;

    const chatId = String(ctx.chat.id);
    const arg = ctx.message?.text?.replace('/provider', '').trim().toLowerCase();
    const current = activeProvider.get(chatId) ?? 'claude';

    if (!arg) {
      const modelNote = current === 'openrouter' ? `\nModel: \`${openRouterModel}\`` : '';
      await ctx.reply(`Active provider: **${current}**${modelNote}\n\nSwitch with: /provider claude, /provider codex, or /provider openrouter`);
      return;
    }

    if (arg === 'claude' || arg === 'codex') {
      activeProvider.set(chatId, arg);
      kvSet(`provider:${chatId}`, arg);
      await ctx.reply(`Switched to **${arg}**. All messages will now go to ${arg === 'codex' ? 'OpenAI Codex' : 'Claude'}.`);
      return;
    }

    if (arg === 'openrouter') {
      const keyboard = new InlineKeyboard()
        .text('🆓 Free', 'or:l:free:0')
        .text('💰 Paid', 'or:l:paid:0')
        .text('📋 All', 'or:l:all:0');
      await ctx.reply('OpenRouter — pick a filter:', { reply_markup: keyboard });
      return;
    }

    await ctx.reply('Unknown provider. Use: /provider claude, /provider codex, or /provider openrouter');
  });

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith('or:')) { await ctx.answerCallbackQuery(); return; }

    const chatId = String(ctx.chat?.id ?? ctx.callbackQuery.from.id);
    if (!isAuthorised(Number(chatId))) { await ctx.answerCallbackQuery('Unauthorized'); return; }

    if (data.startsWith('or:l:')) {
      // or:l:<filter>:<page>
      const parts = data.split(':');
      const filter = parts[2];
      const page = parseInt(parts[3]);

      let models;
      try {
        models = await fetchOpenRouterModels();
      } catch (err) {
        await ctx.answerCallbackQuery('Failed to fetch models');
        return;
      }

      const filteredWithIdx = models
        .map((m, i) => ({ m, i }))
        .filter(({ m }) => filter === 'free' ? m.isFree : filter === 'paid' ? !m.isFree : true);

      const start = page * OR_PER_PAGE;
      const pageItems = filteredWithIdx.slice(start, start + OR_PER_PAGE);

      const keyboard = new InlineKeyboard();
      for (const { m, i } of pageItems) {
        const label = (m.isFree ? '🆓 ' : '💰 ') + m.name.slice(0, 35);
        keyboard.text(label, `or:s:${i}`).row();
      }

      const navRow: Array<[string, string]> = [];
      if (page > 0) navRow.push(['◀ Prev', `or:l:${filter}:${page - 1}`]);
      if (start + OR_PER_PAGE < filteredWithIdx.length) navRow.push(['Next ▶', `or:l:${filter}:${page + 1}`]);
      if (navRow.length > 0) {
        for (const [label, cb] of navRow) keyboard.text(label, cb);
      }

      const filterLabel = filter === 'free' ? '🆓 Free' : filter === 'paid' ? '💰 Paid' : '📋 All';
      const totalPages = Math.ceil(filteredWithIdx.length / OR_PER_PAGE);
      await ctx.editMessageText(
        `${filterLabel} models — ${filteredWithIdx.length} total (page ${page + 1}/${totalPages}):`,
        { reply_markup: keyboard }
      );
      await ctx.answerCallbackQuery();

    } else if (data.startsWith('or:s:')) {
      const index = parseInt(data.slice(5));
      let models;
      try {
        models = await fetchOpenRouterModels();
      } catch {
        await ctx.answerCallbackQuery('Failed to fetch models');
        return;
      }
      const model = models[index];
      if (!model) { await ctx.answerCallbackQuery('Model not found'); return; }

      setOpenRouterModel(model.id);
      activeProvider.set(chatId, 'openrouter');
      kvSet(`provider:${chatId}`, 'openrouter');
      kvSet('openrouter:model', model.id);

      await ctx.editMessageText(
        `✅ Switched to OpenRouter\nModel: <b>${model.name}</b>\n<code>${model.id}</code>`,
        { parse_mode: 'HTML' }
      );
      await ctx.answerCallbackQuery('Model selected');
    }
  });

  bot.command('imagine', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;

    const prompt = ctx.message?.text?.replace('/imagine', '').trim();
    if (!prompt) {
      await ctx.reply('Usage: /imagine <your prompt>');
      return;
    }

    const statusMsg = await ctx.reply('🎨 Generating image...', { parse_mode: 'HTML' });

    try {
      const imageBuffer = await generateImage(prompt);
      await ctx.api.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {});
      await ctx.replyWithPhoto(new InputFile(imageBuffer, 'image.png'), { caption: prompt });
    } catch (err) {
      logger.error({ err }, 'Image generation error');
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, `<b>Failed</b>\n<code>${msg}</code>`, { parse_mode: 'HTML' }).catch(() => {});
    }
  });

  bot.command('restart', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    await ctx.reply('Restarting bot service...');
    logger.info('Restart requested via /restart command');
    // Exit with code 1 so the process manager restarts the service
    setTimeout(() => process.exit(1), 500);
  });

  bot.command('schedule', async (ctx) => {
    const chatId = String(ctx.chat.id);
    if (!isAuthorised(ctx.chat.id)) return;

    const text = ctx.message?.text ?? '';
    const parts = text.replace('/schedule', '').trim().split(/\s+/);
    const subCmd = parts[0];

    if (!subCmd || subCmd === 'list') {
      const tasks = listTasks(chatId);
      if (tasks.length === 0) {
        await ctx.reply('No scheduled tasks.\n\nCreate one: /schedule create "prompt" "cron"');
        return;
      }
      const lines = tasks.map(t => {
        const next = new Date(t.next_run * 1000).toLocaleString();
        return `${t.id} [${t.status}] ${t.schedule} - ${t.prompt.slice(0, 40)}... (next: ${next})`;
      });
      await ctx.reply('Scheduled tasks:\n\n' + lines.join('\n'));
    } else if (subCmd === 'create') {
      // Parse: create "prompt" "cron"
      const match = text.match(/create\s+"([^"]+)"\s+"([^"]+)"/);
      if (!match) {
        await ctx.reply('Usage: /schedule create "Your prompt here" "0 9 * * *"');
        return;
      }
      const [, prompt, cron] = match;
      try {
        const nextRun = computeNextRun(cron);
        const id = randomUUID().slice(0, 8);
        createTask(id, chatId, prompt, cron, nextRun);
        await ctx.reply(`Task ${id} created. Next run: ${new Date(nextRun * 1000).toLocaleString()}`);
      } catch {
        await ctx.reply('Invalid cron expression.');
      }
    } else if (subCmd === 'delete') {
      const id = parts[1];
      if (!id) { await ctx.reply('Usage: /schedule delete <id>'); return; }
      if (deleteTask(id)) await ctx.reply(`Deleted: ${id}`);
      else await ctx.reply('Task not found.');
    } else if (subCmd === 'pause') {
      const id = parts[1];
      if (!id) { await ctx.reply('Usage: /schedule pause <id>'); return; }
      pauseTask(id);
      await ctx.reply(`Paused: ${id}`);
    } else if (subCmd === 'resume') {
      const id = parts[1];
      if (!id) { await ctx.reply('Usage: /schedule resume <id>'); return; }
      resumeTask(id);
      await ctx.reply(`Resumed: ${id}`);
    } else {
      await ctx.reply('Unknown subcommand. Use: list, create, delete, pause, resume');
    }
  });

  // --- Message handlers ---

  bot.on('message:text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) return; // Already handled by command handlers
    await handleMessage(ctx, ctx.message.text);
  });

  bot.on('message:voice', async (ctx) => {
    const chatId = String(ctx.chat.id);
    if (!isAuthorised(ctx.chat.id)) return;

    const caps = voiceCapabilities();
    if (!caps.sttGroq && !caps.sttOpenai) {
      await ctx.reply('Voice transcription not configured.');
      return;
    }

    try {
      const file = await ctx.getFile();
      const localPath = await downloadMedia(TELEGRAM_BOT_TOKEN, file.file_id, `voice_${Date.now()}.oga`);
      const transcript = await transcribeAudio(localPath);
      logger.info({ transcript: transcript.slice(0, 100) }, 'Voice transcribed');
      await handleMessage(ctx, `[Voice transcribed]: ${transcript}`, true);
    } catch (err) {
      logger.error({ err }, 'Voice handling error');
      await ctx.reply('Failed to process voice message.');
    }
  });

  bot.on('message:photo', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    try {
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      const localPath = await downloadMedia(TELEGRAM_BOT_TOKEN, largest.file_id, `photo_${Date.now()}.jpg`);
      const message = buildPhotoMessage(localPath, ctx.message.caption);
      await handleMessage(ctx, message);
    } catch (err) {
      logger.error({ err }, 'Photo handling error');
      await ctx.reply('Failed to process photo.');
    }
  });

  bot.on('message:document', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    try {
      const doc = ctx.message.document;
      const localPath = await downloadMedia(TELEGRAM_BOT_TOKEN, doc.file_id, doc.file_name);
      const message = buildDocumentMessage(localPath, doc.file_name ?? 'document', ctx.message.caption);
      await handleMessage(ctx, message);
    } catch (err) {
      logger.error({ err }, 'Document handling error');
      await ctx.reply('Failed to process document.');
    }
  });

  bot.on('message:video', async (ctx) => {
    if (!isAuthorised(ctx.chat.id)) return;
    try {
      const video = ctx.message.video;
      const localPath = await downloadMedia(TELEGRAM_BOT_TOKEN, video.file_id, `video_${Date.now()}.mp4`);
      const message = buildVideoMessage(localPath, ctx.message.caption);
      await handleMessage(ctx, message);
    } catch (err) {
      logger.error({ err }, 'Video handling error');
      await ctx.reply('Failed to process video.');
    }
  });

  bot.catch((err) => {
    logger.error({ err: err.error }, 'Bot error');
  });

  // Register commands in Telegram UI menu (non-fatal on rate limit)
  bot.api.setMyCommands([
    { command: 'start', description: 'Welcome + list all commands' },
    { command: 'newchat', description: 'Clear session, start fresh conversation' },
    { command: 'forget', description: 'Same as /newchat - clears session' },
    { command: 'memory', description: 'Show count of stored memories' },
    { command: 'voice', description: 'Toggle ElevenLabs voice replies ON/OFF' },
    { command: 'convolife', description: 'Check context window usage %' },
    { command: 'checkpoint', description: 'Save summary to memory (high salience)' },
    { command: 'schedule', description: 'list|create|delete|pause|resume tasks' },
    { command: 'provider', description: 'Switch provider: claude or codex' },
    { command: 'imagine', description: 'Generate an image with Nano Banana (Gemini)' },
    { command: 'restart', description: 'Restart the bot service' },
    { command: 'chatid', description: 'Display your Telegram chat ID' },
  ]).catch((err) => logger.warn({ err }, 'setMyCommands failed (non-fatal)'));

  return bot;
}
