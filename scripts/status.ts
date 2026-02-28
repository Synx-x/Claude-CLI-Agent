import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { request } from 'https';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function ok(msg: string) { console.log(`  ${GREEN}✓${RESET} ${msg}`); }
function fail(msg: string) { console.log(`  ${RED}✗${RESET} ${msg}`); }
function warn(msg: string) { console.log(`  ${YELLOW}⚠${RESET} ${msg}`); }
function header(msg: string) { console.log(`\n${BOLD}${msg}${RESET}`); }

function readEnv(): Record<string, string> {
  const envPath = resolve(PROJECT_ROOT, '.env');
  if (!existsSync(envPath)) return {};
  const result: Record<string, string> = {};
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) result[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return result;
}

function testTelegramToken(token: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(`https://api.telegram.org/bot${token}/getMe`, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString());
          resolve(json.ok === true);
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

async function main() {
  console.log(`\n${BOLD}ClaudeClaw Status${RESET}`);

  // Node
  header('Runtime');
  const nodeVersion = process.versions.node;
  const major = parseInt(nodeVersion.split('.')[0]);
  if (major >= 20) ok(`Node.js v${nodeVersion}`);
  else fail(`Node.js v${nodeVersion} (need v20+)`);

  // Claude CLI
  try {
    const result = spawnSync('claude', ['--version'], { encoding: 'utf-8' });
    if (result.status === 0) ok(`Claude CLI: ${result.stdout.trim()}`);
    else fail('Claude CLI not found');
  } catch {
    fail('Claude CLI not found');
  }

  // Config
  header('Configuration');
  const env = readEnv();

  if (env['TELEGRAM_BOT_TOKEN']) {
    const valid = await testTelegramToken(env['TELEGRAM_BOT_TOKEN']);
    if (valid) ok('Telegram bot token: valid');
    else fail('Telegram bot token: invalid');
  } else {
    fail('Telegram bot token: not set');
  }

  if (env['ALLOWED_CHAT_ID']) ok(`Chat ID: ${env['ALLOWED_CHAT_ID']}`);
  else warn('Chat ID: not set (open mode)');

  // Voice
  header('Voice');
  if (env['GROQ_API_KEY']) ok('Groq STT: configured');
  else warn('Groq STT: not configured');

  if (env['OPENAI_API_KEY']) ok('OpenAI STT: configured');
  else warn('OpenAI STT: not configured');

  if (env['ELEVENLABS_API_KEY'] && env['ELEVENLABS_VOICE_ID']) ok('ElevenLabs TTS: configured');
  else warn('ElevenLabs TTS: not configured');

  // Video
  header('Video');
  if (env['GOOGLE_API_KEY']) ok('Google/Gemini: configured');
  else warn('Google/Gemini: not configured');

  // Database
  header('Database');
  const dbPath = resolve(PROJECT_ROOT, 'store', 'claudeclaw.db');
  if (existsSync(dbPath)) {
    ok('Database exists');
    try {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(dbPath, { readonly: true });
      const memCount = (db.prepare('SELECT COUNT(*) as cnt FROM memories').get() as { cnt: number }).cnt;
      ok(`Memories: ${memCount}`);
      const taskCount = (db.prepare('SELECT COUNT(*) as cnt FROM scheduled_tasks').get() as { cnt: number }).cnt;
      ok(`Scheduled tasks: ${taskCount}`);
      db.close();
    } catch (err) {
      warn(`Could not read DB: ${err}`);
    }
  } else {
    warn('Database not created yet (run the bot first)');
  }

  // PID
  header('Process');
  const pidFile = resolve(PROJECT_ROOT, 'store', 'claudeclaw.pid');
  if (existsSync(pidFile)) {
    const pid = readFileSync(pidFile, 'utf-8').trim();
    try {
      process.kill(parseInt(pid), 0);
      ok(`Running (PID ${pid})`);
    } catch {
      warn(`PID file exists (${pid}) but process not running`);
    }
  } else {
    warn('Not running (no PID file)');
  }

  console.log('');
}

main().catch(console.error);
