#!/usr/bin/env node
/**
 * ingest-sessions.js
 * Parses memory/sessions.md and upserts each dated session entry
 * into the claudeclaw.db memories table as semantic memories.
 *
 * Usage: node scripts/ingest-sessions.js
 * Safe to run repeatedly — dedupes by topic_key.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const SESSIONS_MD = resolve(
  process.env.HOME || process.env.USERPROFILE,
  '.claude/projects/C--Users-User-source-repos-claude/memory/sessions.md'
);
const DB_PATH = resolve(ROOT, 'store/claudeclaw.db');
const CHAT_ID = process.env.ALLOWED_CHAT_ID || '8254540383';

function parseSessions(md) {
  const sessions = [];
  // Split on level-2 date headers: ## YYYY-MM-DD
  const sections = md.split(/^## (\d{4}-\d{2}-\d{2})/m);

  // sections[0] = preamble, then alternates: date, content, date, content...
  for (let i = 1; i < sections.length; i += 2) {
    const date = sections[i].trim();
    const content = (sections[i + 1] || '').trim();
    if (!date || !content) continue;
    sessions.push({ date, content });
  }
  return sessions;
}

function dateToUnix(dateStr) {
  return Math.floor(new Date(dateStr + 'T12:00:00Z').getTime() / 1000);
}

function main() {
  const md = readFileSync(SESSIONS_MD, 'utf8');
  const sessions = parseSessions(md);

  if (!sessions.length) {
    console.log('No sessions found in sessions.md');
    return;
  }

  const db = new Database(DB_PATH);

  const checkStmt = db.prepare('SELECT id FROM memories WHERE topic_key = ?');
  const insertStmt = db.prepare(`
    INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at)
    VALUES (?, ?, ?, 'semantic', 5.0, ?, ?)
  `);

  let inserted = 0;
  let skipped = 0;
  const now = Math.floor(Date.now() / 1000);

  for (const { date, content } of sessions) {
    const topicKey = `session-log-${date}`;
    const existing = checkStmt.get(topicKey);
    if (existing) {
      skipped++;
      continue;
    }
    const ts = dateToUnix(date);
    const memContent = `Session log ${date}:\n${content}`;
    insertStmt.run(CHAT_ID, topicKey, memContent, ts, now);
    inserted++;
    console.log(`Inserted: ${topicKey}`);
  }

  db.close();
  console.log(`Done. Inserted: ${inserted}, skipped (already exist): ${skipped}`);
}

main();
