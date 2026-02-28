import { Bot, Context, InputFile } from 'grammy';
import {
  TELEGRAM_BOT_TOKEN,
  ALLOWED_CHAT_ID,
  MAX_MESSAGE_LENGTH,
  TYPING_REFRESH_MS,
} from './config.js';
import { getSession, setSession, clearSession, getMemoryCount, createTask, listTasks, deleteTask, pauseTask, resumeTask, insertCheckpoint } from './db.js';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { PROJECT_ROOT } from './config.js';
import { runAgent, AgentEvent } from './agent.js';
import { buildMemoryContext, saveConversationTurn } from './memory.js';
import { transcribeAudio, synthesizeSpeech, voiceCapabilities } from './voice.js';
import { downloadMedia, buildPhotoMessage, buildDocumentMessage, buildVideoMessage } from './media.js';
import { computeNextRun } from './scheduler.js';
import { logger } from './logger.js';
import { randomUUID } from 'crypto';

// Voice mode toggle per chat — default ON for allowed chat
const voiceMode = new Set<string>(ALLOWED_CHAT_ID ? [ALLOWED_CHAT_ID] : []);

// --- Telegram HTML formatter ---

export function formatForTelegram(text: string): string {
  // Extract and protect code blocks
  const codeBlocks: string[] = [];
  let processed = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const escaped = escapeHtml(code.trimEnd());
    const block = lang ? `<pre><code class="language-${lang}">${escaped}</code></pre>` : `<pre>${escaped}</pre>`;
    codeBlocks.push(block);
    return `\x00CODEBLOCK${codeBlocks.length - 1}\x00`;
  });

  // Inline code
  processed = processed.replace(/`([^`]+)`/g, (_, code) => `<code>${escapeHtml(code)}</code>`);

  // Escape HTML in remaining text (but not our placeholders/tags)
  processed = escapeHtmlSelective(processed);

  // Headings
  processed = processed.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  // Bold: **text** or __text__
  processed = processed.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  processed = processed.replace(/__(.+?)__/g, '<b>$1</b>');

  // Italic: *text* or _text_ (not inside words)
  processed = processed.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, '<i>$1</i>');
  processed = processed.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, '<i>$1</i>');

  // Strikethrough
  processed = processed.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Links
  processed = processed.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Checkboxes
  processed = processed.replace(/- \[ \]/g, '\u2610');
  processed = processed.replace(/- \[x\]/g, '\u2611');

  // Strip horizontal rules
  processed = processed.replace(/^[-*]{3,}\s*$/gm, '');

  // Restore code blocks
  processed = processed.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, idx) => codeBlocks[parseInt(idx)]);

  return processed.trim();
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtmlSelective(text: string): string {
  // Escape & < > but skip our code placeholders and already-converted tags
  return text
    .replace(/&(?!amp;|lt;|gt;)/g, '&amp;')
    .replace(/<(?!\/?(b|i|s|u|code|pre|a)\b|!--)/g, '&lt;')
    .replace(/(?<!<\/(b|i|s|u|code|pre|a)|--)>/g, (match, group) => {
      if (group) return match;
      return '&gt;';
    });
}

export function splitMessage(text: string, limit = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(' ', limit);
    if (splitAt <= 0) splitAt = limit;

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) chunks.push(remaining);
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
  const fullMessage = memoryContext ? `${memoryContext}\n\n${rawText}` : rawText;

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
    }
  };

  try {
    const { text, newSessionId } = await runAgent(fullMessage, sessionId, sendTyping, onEvent);
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
    const chunks = splitMessage(formatted);
    for (const chunk of chunks) {
      try {
        await ctx.reply(chunk, { parse_mode: 'HTML' });
      } catch {
        await ctx.reply(chunk);
      }
    }
  } catch (err) {
    clearInterval(typingInterval);
    logger.error({ err }, 'Message handling error');
    await ctx.reply('Something went wrong. Check the logs.');
  }
}

export function createBot(): Bot {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set. Run: npm run setup');
  }

  const bot = new Bot(TELEGRAM_BOT_TOKEN);

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
      await ctx.reply('Checkpoint saved. Safe to /newchat.');
    } catch (err) {
      logger.error({ err }, 'checkpoint error');
      await ctx.reply('Failed to save checkpoint.');
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

  // Register commands in Telegram UI menu with detailed descriptions
  bot.api.setMyCommands([
    { command: 'start', description: 'Welcome + list all commands' },
    { command: 'newchat', description: 'Clear session, start fresh conversation' },
    { command: 'forget', description: 'Same as /newchat - clears session' },
    { command: 'memory', description: 'Show count of stored memories' },
    { command: 'voice', description: 'Toggle ElevenLabs voice replies ON/OFF' },
    { command: 'convolife', description: 'Check context window usage %' },
    { command: 'checkpoint', description: 'Save summary to memory (high salience)' },
    { command: 'schedule', description: 'list|create|delete|pause|resume tasks' },
    { command: 'restart', description: 'Restart the bot service' },
    { command: 'chatid', description: 'Display your Telegram chat ID' },
  ]);

  return bot;
}
