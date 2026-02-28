import {
  insertMemory,
  searchMemoriesFts,
  getRecentMemories,
  touchMemory,
  decayMemories as dbDecay,
} from './db.js';
import { logger } from './logger.js';

const SEMANTIC_PATTERN = /\b(my|i am|i'm|i prefer|remember|always|never)\b/i;

export async function buildMemoryContext(chatId: string, userMessage: string): Promise<string> {
  // FTS search: sanitize query
  const sanitized = userMessage.replace(/[^a-zA-Z0-9\s]/g, '').trim();
  const ftsQuery = sanitized
    .split(/\s+/)
    .filter(w => w.length > 2)
    .map(w => `${w}*`)
    .join(' OR ');

  let ftsResults: Array<{ id: number; content: string; sector: string; salience: number }> = [];
  if (ftsQuery) {
    try {
      ftsResults = searchMemoriesFts(ftsQuery, 3);
    } catch (err) {
      logger.debug({ err }, 'FTS search failed');
    }
  }

  // Recent memories
  const recent = getRecentMemories(chatId, 5);

  // Deduplicate by id
  const seen = new Set<number>();
  const all: Array<{ id: number; content: string; sector: string }> = [];

  for (const r of ftsResults) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      all.push(r);
    }
  }
  for (const r of recent) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      all.push(r);
    }
  }

  if (all.length === 0) return '';

  // Touch each accessed memory
  for (const m of all) {
    touchMemory(m.id);
  }

  const lines = all.map(m => `- ${m.content} (${m.sector})`);
  return `[Memory context]\n${lines.join('\n')}`;
}

export async function saveConversationTurn(
  chatId: string,
  userMsg: string,
  assistantMsg: string
): Promise<void> {
  // Skip short or command messages
  if (userMsg.length <= 20 || userMsg.startsWith('/')) return;

  const sector = SEMANTIC_PATTERN.test(userMsg) ? 'semantic' : 'episodic';

  // Save a condensed version of the exchange
  const content = `User: ${userMsg.slice(0, 200)}${userMsg.length > 200 ? '...' : ''} | Assistant: ${assistantMsg.slice(0, 200)}${assistantMsg.length > 200 ? '...' : ''}`;

  insertMemory(chatId, content, sector);
}

export function runDecaySweep(): void {
  try {
    dbDecay();
    logger.info('Memory decay sweep completed');
  } catch (err) {
    logger.error({ err }, 'Memory decay sweep failed');
  }
}
