import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readEnvFile } from './env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = resolve(__dirname, '..');
export const STORE_DIR = resolve(PROJECT_ROOT, 'store');

const env = readEnvFile();

// Telegram
export const TELEGRAM_BOT_TOKEN = env['TELEGRAM_BOT_TOKEN'] ?? '';
export const ALLOWED_CHAT_ID = env['ALLOWED_CHAT_ID'] ?? '';

// Voice STT
export const GROQ_API_KEY = env['GROQ_API_KEY'] ?? '';
export const OPENAI_API_KEY = env['OPENAI_API_KEY'] ?? '';

// Voice TTS
export const ELEVENLABS_API_KEY = env['ELEVENLABS_API_KEY'] ?? '';
export const ELEVENLABS_VOICE_ID = env['ELEVENLABS_VOICE_ID'] ?? '';
export const UNREAL_SPEECH_API_KEY = env['UNREAL_SPEECH_API_KEY'] ?? '';

// Video
export const GOOGLE_API_KEY = env['GOOGLE_API_KEY'] ?? '';

// OpenRouter
export const OPENROUTER_API_KEY = env['OPENROUTER_API_KEY'] ?? '';

// Limits
export const MAX_MESSAGE_LENGTH = 4096;
export const TYPING_REFRESH_MS = 4000;
