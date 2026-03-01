#!/usr/bin/env node
import { spawn, execSync } from 'child_process';
import { watch } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = resolve(ROOT, '.env');

function build() {
  console.log('[start] Building...');
  execSync('npx tsc', { cwd: ROOT, stdio: 'inherit' });
  console.log('[start] Build complete.');
}

let child = null;
let restarting = false;

function startProcess() {
  if (child) {
    child.kill('SIGTERM');
    child = null;
  }
  child = spawn('node', ['dist/index.js'], { cwd: ROOT, stdio: 'inherit' });
  child.on('exit', (code) => {
    if (restarting) return;
    if (code === 0) return;
    console.log(`[start] Process exited with code ${code} — restarting in 1s...`);
    setTimeout(() => startProcess(), 1000);
  });
}

// Build fresh on start
build();
startProcess();

// Watch .env for changes and restart
let debounce = null;
watch(ENV_FILE, () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    console.log('[start] .env changed — restarting...');
    restarting = true;
    startProcess();
    restarting = false;
  }, 300);
});

// Forward signals
const shutdown = () => {
  child?.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
