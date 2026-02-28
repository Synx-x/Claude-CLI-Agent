import { getDb, initDatabase } from '../src/db.js';
import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { STORE_DIR } from '../src/config.js';

initDatabase();
const db = getDb();

// Export all tables
const sessions = db.prepare('SELECT * FROM sessions').all();
const memories = db.prepare('SELECT * FROM memories').all();
const tasks = db.prepare('SELECT * FROM scheduled_tasks').all();

const export_data = {
  sessions,
  memories,
  tasks,
  timestamp: new Date().toISOString(),
};

const filename = resolve(STORE_DIR, `claudeclaw_export_${Date.now()}.json`);
writeFileSync(filename, JSON.stringify(export_data, null, 2));

console.log(`Export saved to: ${filename}`);
console.log(JSON.stringify(export_data, null, 2));
