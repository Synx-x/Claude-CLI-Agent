import { query } from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PROJECT_ROOT } from './config.js';
import { logger } from './logger.js';
import { runOpenRouter } from './openrouter.js';

export let openRouterModel = 'thudm/glm-4-32b:free';

export function setOpenRouterModel(model: string): void {
  openRouterModel = model;
}

const CODEX_TIMEOUT_MS = 120_000;

export async function runCodexFallback(message: string): Promise<string> {
  // Write last message to a temp file so we get clean output without parsing ANSI streams
  const tmpDir = mkdtempSync(join(tmpdir(), 'codex-'));
  const outFile = join(tmpDir, 'response.txt');

  return new Promise((resolve, reject) => {
    // On Windows, .cmd wrappers require shell:true, but shell:true with an array
    // doesn't quote args with spaces. Build a quoted command string instead.
    const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`;
    const cmdStr = `codex exec --full-auto --color never --output-last-message ${q(outFile)} -C ${q(PROJECT_ROOT)} ${q(message)}`;
    const proc = spawn(cmdStr, [], { env: process.env, shell: true });

    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill();
      rmSync(tmpDir, { recursive: true, force: true });
      reject(new Error('Codex timed out'));
    }, CODEX_TIMEOUT_MS);

    proc.on('error', (err) => {
      clearTimeout(timer);
      rmSync(tmpDir, { recursive: true, force: true });
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('codex CLI not found — install with: npm install -g @openai/codex'));
      } else {
        reject(err);
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      try {
        const text = readFileSync(outFile, 'utf-8').trim();
        rmSync(tmpDir, { recursive: true, force: true });
        if (!text && code !== 0) {
          reject(new Error(stderr.trim() || `Codex exited with code ${code}`));
        } else {
          resolve(text || '(no response from Codex)');
        }
      } catch {
        rmSync(tmpDir, { recursive: true, force: true });
        reject(new Error(stderr.trim() || `Codex exited with code ${code}`));
      }
    });
  });
}

export type AgentEvent =
  | { kind: 'tool_start'; tool: string; input: Record<string, unknown> }
  | { kind: 'tool_progress'; tool: string; elapsed: number }
  | { kind: 'provider_switch'; from: string; to: string; reason: string; errorDetail?: string };

function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  return (
    lower.includes('rate limit') ||
    lower.includes('ratelimit') ||
    lower.includes('usage limit') ||
    lower.includes('429') ||
    lower.includes('too many requests') ||
    lower.includes('overloaded') ||
    lower.includes('capacity')
  );
}

export async function runAgent(
  message: string,
  sessionId?: string,
  onTyping?: () => void,
  onEvent?: (event: AgentEvent) => void
): Promise<{ text: string | null; newSessionId?: string }> {
  let responseText: string | null = null;
  let newSessionId: string | undefined;

  // Keep typing indicator alive
  let typingInterval: ReturnType<typeof setInterval> | undefined;
  if (onTyping) {
    onTyping();
    typingInterval = setInterval(onTyping, 4000);
  }

  try {
    const options: Record<string, unknown> = {
      cwd: PROJECT_ROOT,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
    };

    if (sessionId) {
      options.resume = sessionId;
    }

    const events = query({
      prompt: message,
      options: options as Parameters<typeof query>[0]['options'],
    });

    for await (const event of events) {
      if (event.type === 'system' && 'subtype' in event && event.subtype === 'init') {
        const initEvent = event as unknown as { session_id?: string };
        if (initEvent.session_id) {
          newSessionId = initEvent.session_id;
        }
      }

      if (event.type === 'assistant') {
        const msg = event as unknown as { message: { content: Array<{ type: string; name?: string; input?: Record<string, unknown> }> } };
        for (const block of msg.message.content) {
          if (block.type === 'tool_use' && block.name) {
            logger.debug({ tool: block.name, input: block.input }, 'Tool use');
            onEvent?.({ kind: 'tool_start', tool: block.name, input: block.input ?? {} });
          }
        }
      }

      if (event.type === 'tool_progress') {
        const prog = event as unknown as { tool_name: string; elapsed_time_seconds: number };
        logger.debug({ tool: prog.tool_name, elapsed: prog.elapsed_time_seconds }, 'Tool progress');
        onEvent?.({ kind: 'tool_progress', tool: prog.tool_name, elapsed: prog.elapsed_time_seconds });
      }

      if ('result' in event) {
        responseText = (event as unknown as { result: string }).result;
      }
    }
  } catch (err) {
    logger.error({ err }, 'Agent error');
    throw err;
  } finally {
    if (typingInterval) clearInterval(typingInterval);
  }

  return { text: responseText, newSessionId };
}

// --- Generic provider fallback system ---

// Cooldown cache: provider name → Date when it becomes available again
const providerCooldowns = new Map<string, Date>();

function isProviderAvailable(name: string): boolean {
  const until = providerCooldowns.get(name);
  if (!until) return true;
  if (new Date() >= until) { providerCooldowns.delete(name); return true; }
  return false;
}

function parseRetryAfter(msg: string): Date {
  const match = msg.match(/try again at (.+?)(?:\.|$)/i);
  if (match) {
    const d = new Date(match[1]);
    if (!isNaN(d.getTime())) return d;
  }
  return new Date(Date.now() + 60 * 60 * 1000);
}

export function getProviderCooldowns(): Record<string, Date> {
  return Object.fromEntries(providerCooldowns);
}

export type ProviderResult = { text: string | null; newSessionId?: string };
type ProviderRunner = (
  message: string,
  sessionId?: string,
  onTyping?: () => void,
  onEvent?: (e: AgentEvent) => void
) => Promise<ProviderResult>;

export const providerRegistry: Record<string, ProviderRunner> = {
  claude: (msg, sessionId, onTyping, onEvent) => runAgent(msg, sessionId, onTyping, onEvent),
  codex: async (msg) => ({ text: await runCodexFallback(msg) }),
  openrouter: async (msg) => ({ text: await runOpenRouter(msg, openRouterModel) }),
};

export const providerFallbackOrder = ['claude', 'codex', 'openrouter'];

export async function runWithFallback(
  message: string,
  preferred: string,
  sessionId?: string,
  onTyping?: () => void,
  onEvent?: (e: AgentEvent) => void
): Promise<ProviderResult> {
  const order = [preferred, ...providerFallbackOrder.filter(p => p !== preferred)];
  let lastErr: unknown;

  for (const name of order) {
    const runner = providerRegistry[name];
    if (!runner) continue;

    if (!isProviderAvailable(name)) {
      logger.info({ provider: name, until: providerCooldowns.get(name) }, 'Provider in cooldown, skipping');
      continue;
    }

    try {
      return await runner(message, sessionId, onTyping, onEvent);
    } catch (err) {
      lastErr = err;
      if (isRateLimitError(err)) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const until = parseRetryAfter(errMsg);
        providerCooldowns.set(name, until);
        logger.warn({ provider: name, until }, 'Provider rate limited, caching cooldown');
        const next = order.find(p => p !== name && providerRegistry[p] && isProviderAvailable(p)) ?? 'none';
        onEvent?.({ kind: 'provider_switch', from: name, to: next, reason: 'rate limited', errorDetail: errMsg });
        continue;
      }
      throw err;
    }
  }

  onEvent?.({ kind: 'provider_switch', from: preferred, to: 'none', reason: 'rate limited' });
  throw lastErr ?? new Error('All providers exhausted or rate limited');
}
