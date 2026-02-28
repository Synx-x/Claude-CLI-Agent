import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { STORE_DIR, TELEGRAM_BOT_TOKEN, ALLOWED_CHAT_ID } from './config.js';
import { initDatabase } from './db.js';
import { runDecaySweep } from './memory.js';
import { cleanupOldUploads } from './media.js';
import { createBot } from './bot.js';
import { initScheduler, stopScheduler } from './scheduler.js';
import { logger } from './logger.js';

const PID_FILE = resolve(STORE_DIR, 'claudeclaw.pid');

function acquireLock(): void {
  mkdirSync(STORE_DIR, { recursive: true });

  if (existsSync(PID_FILE)) {
    const oldPid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
    if (oldPid) {
      try {
        process.kill(oldPid, 0); // Check if alive
        logger.warn({ oldPid }, 'Killing stale process');
        process.kill(oldPid, 'SIGTERM');
      } catch {
        // Process not running, stale PID file
      }
    }
  }

  writeFileSync(PID_FILE, String(process.pid));
}

function releaseLock(): void {
  try {
    unlinkSync(PID_FILE);
  } catch {
    // Ignore
  }
}

async function main(): Promise<void> {
  // Banner
  console.log(`
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
`);

  // Check token
  if (!TELEGRAM_BOT_TOKEN) {
    logger.error('TELEGRAM_BOT_TOKEN not set. Run: npm run setup');
    process.exit(1);
  }

  // Lock
  acquireLock();

  // Database
  initDatabase();
  logger.info('Database initialized');

  // Memory decay
  runDecaySweep();
  setInterval(runDecaySweep, 24 * 60 * 60 * 1000);

  // Cleanup old uploads
  cleanupOldUploads();

  // Create bot
  const bot = createBot();

  // Scheduler
  const sendFn = async (chatId: string, text: string) => {
    await bot.api.sendMessage(Number(chatId), text);
  };
  initScheduler(sendFn);

  // Graceful shutdown
  const shutdown = () => {
    logger.info('Shutting down...');
    stopScheduler();
    bot.stop();
    releaseLock();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Start
  try {
    await bot.start({
      onStart: async () => {
        logger.info('ClaudeClaw running');
        // Notify owner that bot is online
        if (ALLOWED_CHAT_ID) {
          try {
            await bot.api.sendMessage(Number(ALLOWED_CHAT_ID), '🟢 ClaudeClaw is online');
          } catch (e) {
            logger.warn({ err: e }, 'Failed to send startup notification');
          }
        }
      },
    });
  } catch (err) {
    logger.error({ err }, 'Failed to start bot. Check TELEGRAM_BOT_TOKEN in .env');
    releaseLock();
    process.exit(1);
  }
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error');
  releaseLock();
  process.exit(1);
});
