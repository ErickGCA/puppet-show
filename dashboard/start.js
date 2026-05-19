#!/usr/bin/env node
/**
 * start.js — Cross-platform launcher for the puppet-show dashboard.
 *
 * Spawns server.js detached, writes the child PID to ~/.claude/puppet-show/
 * server.pid, and redirects its stdout/stderr to server.log. If a previous
 * instance is already running (PID file present and process alive), it
 * reports the existing process and exits — no duplicate spawn.
 */

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const LOG_DIR = process.env.PUPPET_SHOW_LOG_DIR || path.join(os.homedir(), '.claude', 'puppet-show');
const PID_FILE = path.join(LOG_DIR, 'server.pid');
const LOG_FILE = path.join(LOG_DIR, 'server.log');
const SERVER = path.join(__dirname, 'server.js');
const PORT = process.env.PUPPET_SHOW_PORT || '4711';

fs.mkdirSync(LOG_DIR, { recursive: true });

if (fs.existsSync(PID_FILE)) {
  const existing = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
  if (existing && isAlive(existing)) {
    console.log(`\n🎭 puppet-show already running (pid ${existing}) — http://localhost:${PORT}\n`);
    process.exit(0);
  }
  fs.unlinkSync(PID_FILE);
}

const out = fs.openSync(LOG_FILE, 'a');
const child = spawn(process.execPath, [SERVER], {
  detached: true,
  stdio: ['ignore', out, out],
  windowsHide: true,
  env: process.env,
});
child.unref();

fs.writeFileSync(PID_FILE, String(child.pid));

console.log(`\n🎭 puppet-show dashboard running at http://localhost:${PORT}`);
console.log(`   pid:  ${child.pid}`);
console.log(`   log:  ${LOG_FILE}`);
console.log(`   (override port with PUPPET_SHOW_PORT)\n`);

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
