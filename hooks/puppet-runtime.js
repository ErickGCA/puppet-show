#!/usr/bin/env node
/**
 * puppet-runtime.js — PreToolUse hook for file/tool-touching tools
 * (Read, Write, Edit, Grep, Glob, Bash, WebFetch).
 *
 * Runs on every such tool call. When the call belongs to an active puppet
 * dispatch (matched via session_id, or as a fallback the most recent open
 * dispatch in the same cwd), it validates against the contract. With
 * `enforcement: warn` it logs a runtime violation and lets the call through.
 * With `enforcement: strict` it blocks the call by emitting the Claude Code
 * hook `block` decision.
 *
 * Non-blocking on any internal failure — we never crash the session.
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const { checkToolCall } = require(path.join(ROOT, 'lib/contract'));
const store = require(path.join(ROOT, 'lib/store'));

const STREAM_DIR = process.env.PUPPET_SHOW_LOG_DIR || path.join(os.homedir(), '.claude', 'puppet-show');
const STREAM_FILE = path.join(STREAM_DIR, 'stream.jsonl');
const FORCE = (process.env.PUPPET_SHOW_ENFORCE || '').toLowerCase();

fs.mkdirSync(STREAM_DIR, { recursive: true });

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try { handle(raw); } catch (err) {
    process.stderr.write(`[puppet-show:runtime] ${err.stack || err.message}\n`);
    process.exit(0);
  }
});

function handle(rawInput) {
  if (!rawInput.trim()) return process.exit(0);
  const input = JSON.parse(rawInput);
  const toolName = input.tool_name;
  if (!toolName || toolName === 'Task') return process.exit(0);

  const sessionId = input.session_id || null;
  const cwd = input.cwd || null;

  store.open();
  const dispatch = store.findOpenDispatchForRuntime({ session_id: sessionId, cwd });
  if (!dispatch || !dispatch.contract) return process.exit(0);

  const contract = dispatch.contract;
  const enforcement = FORCE === 'strict' ? 'strict' : (contract.enforcement || 'warn');

  const { violations } = checkToolCall(contract, toolName, input.tool_input || {});
  if (violations.length === 0) return process.exit(0);

  const ts = new Date().toISOString();
  store.insertViolations(dispatch.id, ts, 'runtime', violations);
  emitStream({
    kind: 'runtime_violation',
    id: dispatch.id,
    ts,
    session_id: sessionId,
    tool_name: toolName,
    enforcement,
    violations,
  });

  if (enforcement === 'strict') {
    const reason = violations
      .map((v) => `${v.kind}: ${v.detail}`)
      .join('; ');
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: `puppet-show blocked ${toolName} — ${reason}`,
    }));
    return process.exit(0);
  }

  return process.exit(0);
}

function emitStream(event) {
  try {
    fs.appendFileSync(STREAM_FILE, JSON.stringify(event) + '\n');
  } catch (err) {
    process.stderr.write(`[puppet-show:runtime] stream write failed: ${err.message}\n`);
  }
}
