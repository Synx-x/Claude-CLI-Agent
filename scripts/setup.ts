import { execSync, spawnSync } from 'child_process';
import { existsSync, writeFileSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function ok(msg: string) { console.log(`${GREEN}✓${RESET} ${msg}`); }
function warn(msg: string) { console.log(`${YELLOW}⚠${RESET} ${msg}`); }
function fail(msg: string) { console.log(`${RED}✗${RESET} ${msg}`); }
function header(msg: string) { console.log(`\n${BOLD}${msg}${RESET}\n`); }

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question}: `, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  console.log(`
${BOLD} ██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗${RESET}
${BOLD}██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝${RESET}
${BOLD}██║     ██║     ███████║██║   ██║██║  ██║█████╗  ${RESET}
${BOLD}██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝  ${RESET}
${BOLD}╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗${RESET}
${BOLD} ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝╚══════╝${RESET}
                    Setup Wizard
`);

  // Check Node version
  header('Checking requirements...');
  const nodeVersion = process.versions.node;
  const major = parseInt(nodeVersion.split('.')[0]);
  if (major >= 20) {
    ok(`Node.js v${nodeVersion}`);
  } else {
    fail(`Node.js v${nodeVersion} — need v20+`);
    process.exit(1);
  }

  // Check Claude CLI
  try {
    const result = spawnSync('claude', ['--version'], { encoding: 'utf-8', cwd: PROJECT_ROOT });
    if (result.status === 0) {
      ok(`Claude CLI: ${result.stdout.trim()}`);
    } else {
      fail('Claude CLI not found. Install it and run: claude login');
      process.exit(1);
    }
  } catch {
    fail('Claude CLI not found. Install it and run: claude login');
    process.exit(1);
  }

  // Collect config
  header('Configuration');

  const envPath = resolve(PROJECT_ROOT, '.env');
  const existing: Record<string, string> = {};

  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq > 0) {
        existing[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
      }
    }
    ok('Found existing .env');
  }

  const token = existing['TELEGRAM_BOT_TOKEN'] || await ask('Telegram bot token (from @BotFather)');
  const chatId = existing['ALLOWED_CHAT_ID'] || await ask('Your Telegram chat ID (send /chatid to bot, or leave blank)');
  const groqKey = existing['GROQ_API_KEY'] || await ask('Groq API key for voice STT (console.groq.com, or blank to skip)');
  const openaiKey = existing['OPENAI_API_KEY'] || await ask('OpenAI API key for voice STT fallback (or blank to skip)');
  const elevenKey = existing['ELEVENLABS_API_KEY'] || await ask('ElevenLabs API key for voice replies (or blank to skip)');
  const elevenVoice = existing['ELEVENLABS_VOICE_ID'] || await ask('ElevenLabs voice ID (or blank to skip)');
  const googleKey = existing['GOOGLE_API_KEY'] || await ask('Google API key for video analysis (aistudio.google.com, or blank to skip)');

  // Write .env
  const envContent = `# ClaudeClaw Configuration
TELEGRAM_BOT_TOKEN=${token}
ALLOWED_CHAT_ID=${chatId}

# Voice STT
GROQ_API_KEY=${groqKey}
OPENAI_API_KEY=${openaiKey}

# Voice TTS
ELEVENLABS_API_KEY=${elevenKey}
ELEVENLABS_VOICE_ID=${elevenVoice}

# Video
GOOGLE_API_KEY=${googleKey}

# Logging
LOG_LEVEL=info
`;

  writeFileSync(envPath, envContent);
  ok('.env written');

  // Open CLAUDE.md in editor
  header('Personalization');
  const claudeMd = resolve(PROJECT_ROOT, 'CLAUDE.md');
  console.log('Opening CLAUDE.md for personalization...');
  console.log('Replace [YOUR NAME] and [YOUR ASSISTANT NAME] with your details.\n');

  const editor = process.env.EDITOR || 'code';
  try {
    spawnSync(editor, [claudeMd], { stdio: 'inherit', cwd: PROJECT_ROOT });
  } catch {
    warn(`Could not open editor (${editor}). Edit CLAUDE.md manually.`);
  }

  // Build
  header('Building...');
  try {
    execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'inherit' });
    ok('Build successful');
  } catch {
    fail('Build failed. Fix TypeScript errors and re-run setup.');
    process.exit(1);
  }

  // Windows: PM2 instructions
  header('Background Service (Windows)');
  console.log('To run ClaudeClaw as a background service on Windows:');
  console.log('');
  console.log('  npm install -g pm2');
  console.log(`  pm2 start "${resolve(PROJECT_ROOT, 'dist', 'index.js')}" --name claudeclaw`);
  console.log('  pm2 save');
  console.log('  pm2 startup');
  console.log('');

  // Chat ID reminder
  if (!chatId) {
    header('Get your Chat ID');
    console.log('1. Start the bot: npm run start');
    console.log('2. Send /chatid to your bot on Telegram');
    console.log('3. Copy the number and add it to .env as ALLOWED_CHAT_ID');
    console.log('');
  }

  // Done
  header('Setup complete!');
  console.log('Next steps:');
  console.log('  npm run dev    — run in development mode');
  console.log('  npm run start  — run in production mode');
  console.log('  npm run status — check system health');
  console.log('');
}

main().catch((err) => {
  fail(String(err));
  process.exit(1);
});
