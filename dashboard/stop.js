#!/usr/bin/env node
/**
 * stop.js — Cross-platform shutdown for the puppet-show dashboard.
 *
 * Reads the PID written by start.js, sends a termination signal, and clears
 * the PID file. Handles the common stale-state cases (no PID file, dead PID).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const LOG_DIR = process.env.PUPPET_SHOW_LOG_DIR || path.join(os.homedir(), '.claude', 'puppet-show');
const PID_FILE = path.join(LOG_DIR, 'server.pid');

if (!fs.existsSync(PID_FILE)) {
  console.log('puppet-show was not running');
  process.exit(0);
}

const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
fs.unlinkSync(PID_FILE);

if (!pid) {
  console.log('puppet-show was not running (stale pid file removed)');
  process.exit(0);
}

try {
  process.kill(pid);
  console.log(`puppet-show stopped (pid ${pid})`);
} catch (err) {
  if (err.code === 'ESRCH') {
    console.log(`puppet-show was already stopped (pid ${pid} stale)`);
  } else {
    console.error(`failed to stop pid ${pid}: ${err.message}`);
    process.exit(1);
  }
}
