import Database from 'better-sqlite3';
import { resolve } from 'path';
import { STORE_DIR } from './config.js';
import { mkdirSync } from 'fs';

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    mkdirSync(STORE_DIR, { recursive: true });
    db = new Database(resolve(STORE_DIR, 'claudeclaw.db'));
    db.pragma('journal_mode = WAL');
  }
  return db;
}

export function initDatabase(): void {
  const d = getDb();

  // Sessions table
  d.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      chat_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Full memory tables
  d.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      topic_key TEXT,
      content TEXT NOT NULL,
      sector TEXT NOT NULL CHECK(sector IN ('semantic','episodic')),
      salience REAL NOT NULL DEFAULT 1.0,
      created_at INTEGER NOT NULL,
      accessed_at INTEGER NOT NULL
    )
  `);

  d.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      content_rowid=id
    )
  `);

  // FTS sync triggers
  d.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END
  `);
  d.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
      UPDATE memories_fts SET content = new.content WHERE rowid = old.id;
    END
  `);
  d.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      DELETE FROM memories_fts WHERE rowid = old.id;
    END
  `);

  // Scheduler table
  d.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule TEXT NOT NULL,
      next_run INTEGER NOT NULL,
      last_run INTEGER,
      last_result TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
      created_at INTEGER NOT NULL
    )
  `);
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_status_next ON scheduled_tasks(status, next_run)
  `);
}

// --- Session CRUD ---

export function getSession(chatId: string): string | undefined {
  const row = getDb().prepare('SELECT session_id FROM sessions WHERE chat_id = ?').get(chatId) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(chatId: string, sessionId: string): void {
  getDb().prepare(`
    INSERT INTO sessions (chat_id, session_id, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at
  `).run(chatId, sessionId, Math.floor(Date.now() / 1000));
}

export function clearSession(chatId: string): void {
  getDb().prepare('DELETE FROM sessions WHERE chat_id = ?').run(chatId);
}

// --- Memory CRUD ---

export function insertMemory(chatId: string, content: string, sector: 'semantic' | 'episodic', topicKey?: string): void {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(`
    INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at)
    VALUES (?, ?, ?, ?, 1.0, ?, ?)
  `).run(chatId, topicKey ?? null, content, sector, now, now);
}

export function searchMemoriesFts(query: string, limit = 3): Array<{ id: number; content: string; sector: string; salience: number }> {
  if (!query.trim()) return [];
  return getDb().prepare(`
    SELECT m.id, m.content, m.sector, m.salience
    FROM memories_fts f
    JOIN memories m ON m.id = f.rowid
    WHERE memories_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(query, limit) as Array<{ id: number; content: string; sector: string; salience: number }>;
}

export function getRecentMemories(chatId: string, limit = 5): Array<{ id: number; content: string; sector: string }> {
  return getDb().prepare(`
    SELECT id, content, sector FROM memories
    WHERE chat_id = ?
    ORDER BY accessed_at DESC
    LIMIT ?
  `).all(chatId, limit) as Array<{ id: number; content: string; sector: string }>;
}

export function touchMemory(id: number): void {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(`
    UPDATE memories SET accessed_at = ?, salience = MIN(salience + 0.1, 5.0) WHERE id = ?
  `).run(now, id);
}

export function decayMemories(): void {
  const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;
  getDb().prepare('UPDATE memories SET salience = salience * 0.98 WHERE created_at < ?').run(oneDayAgo);
  getDb().prepare('DELETE FROM memories WHERE salience < 0.1').run();
}

export function getMemoryCount(chatId: string): number {
  const row = getDb().prepare('SELECT COUNT(*) as cnt FROM memories WHERE chat_id = ?').get(chatId) as { cnt: number };
  return row.cnt;
}

// --- Scheduler CRUD ---

export function createTask(id: string, chatId: string, prompt: string, schedule: string, nextRun: number): void {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(`
    INSERT INTO scheduled_tasks (id, chat_id, prompt, schedule, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?)
  `).run(id, chatId, prompt, schedule, nextRun, now);
}

export function getDueTasks(): Array<{ id: string; chat_id: string; prompt: string; schedule: string }> {
  const now = Math.floor(Date.now() / 1000);
  return getDb().prepare(`
    SELECT id, chat_id, prompt, schedule FROM scheduled_tasks
    WHERE status = 'active' AND next_run <= ?
  `).all(now) as Array<{ id: string; chat_id: string; prompt: string; schedule: string }>;
}

export function updateTaskAfterRun(id: string, nextRun: number, result: string): void {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(`
    UPDATE scheduled_tasks SET last_run = ?, last_result = ?, next_run = ? WHERE id = ?
  `).run(now, result, nextRun, id);
}

export function listTasks(chatId?: string): Array<{ id: string; chat_id: string; prompt: string; schedule: string; status: string; next_run: number }> {
  if (chatId) {
    return getDb().prepare('SELECT id, chat_id, prompt, schedule, status, next_run FROM scheduled_tasks WHERE chat_id = ?').all(chatId) as Array<{ id: string; chat_id: string; prompt: string; schedule: string; status: string; next_run: number }>;
  }
  return getDb().prepare('SELECT id, chat_id, prompt, schedule, status, next_run FROM scheduled_tasks').all() as Array<{ id: string; chat_id: string; prompt: string; schedule: string; status: string; next_run: number }>;
}

export function deleteTask(id: string): boolean {
  const result = getDb().prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
  return result.changes > 0;
}

export function pauseTask(id: string): void {
  getDb().prepare("UPDATE scheduled_tasks SET status = 'paused' WHERE id = ?").run(id);
}

export function resumeTask(id: string): void {
  getDb().prepare("UPDATE scheduled_tasks SET status = 'active' WHERE id = ?").run(id);
}
