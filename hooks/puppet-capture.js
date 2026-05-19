#!/usr/bin/env node
/**
 * puppet-capture.js — Hook for PreToolUse:Task and PostToolUse:Task.
 *
 * Reads the Claude Code hook JSON from stdin, extracts the contract from the
 * puppet's prompt, persists everything to SQLite, validates the return when
 * applicable, and writes one event line to a JSONL "fan-out" file that the
 * dashboard server tails (kept for streaming simplicity).
 *
 * Non-blocking: any failure prints to stderr and exits 0. We never break the
 * Claude Code session.
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const { extractContractFromPrompt, checkReturn, computeScore } = require(path.join(ROOT, 'lib/contract'));
const store = require(path.join(ROOT, 'lib/store'));

const STREAM_DIR = process.env.PUPPET_SHOW_LOG_DIR || path.join(os.homedir(), '.claude', 'puppet-show');
const STREAM_FILE = path.join(STREAM_DIR, 'stream.jsonl');
const ALERT_BELOW = parseInt(process.env.PUPPET_SHOW_ALERT_BELOW || '70', 10);

fs.mkdirSync(STREAM_DIR, { recursive: true });

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try { handle(raw); } catch (err) {
    process.stderr.write(`[puppet-show] ${err.stack || err.message}\n`);
  }
  process.exit(0);
});

function handle(rawInput) {
  if (!rawInput.trim()) return;
  const input = JSON.parse(rawInput);
  if (input.tool_name !== 'Task') return;

  const eventName = input.hook_event_name || '';
  const ts = new Date().toISOString();
  const toolInput = input.tool_input || {};
  const sessionId = input.session_id || null;
  const cwd = input.cwd || null;
  const puppetType = toolInput.subagent_type || 'general-purpose';
  const title = toolInput.description || '(untitled)';
  const correlationKey = `${puppetType}::${title}`;

  if (eventName === 'PreToolUse') {
    const { contract, briefing } = extractContractFromPrompt(toolInput.prompt || '');
    store.open();

    // Phase 4 drift detection — compare against last dispatch with same key
    let drift = null;
    if (contract) {
      const prior = store.recentByCorrelationKey(correlationKey, 1)[0];
      if (prior && prior.contract) {
        drift = detectDrift(prior.contract, contract);
      }
    }

    const id = store.insertDispatch({
      ts,
      session_id: sessionId,
      cwd,
      puppet_type: puppetType,
      title,
      briefing,
      contract,
      correlation_key: correlationKey,
    });

    if (drift && drift.changed.length > 0) {
      store.insertViolations(id, ts, 'drift', [
        { kind: 'drift', detail: `contract diverged from prior run: ${drift.changed.join(', ')}` },
      ]);
      emitStream({
        kind: 'drift',
        id,
        ts,
        session_id: sessionId,
        title,
        changed: drift.changed,
        diff: drift.diff,
      });
    }

    emitStream({
      kind: 'dispatch',
      id,
      ts,
      session_id: sessionId,
      puppet_type: puppetType,
      title,
      briefing,
      contract,
      drift: drift && drift.changed.length > 0 ? drift.changed : null,
    });
    return;
  }

  if (eventName === 'PostToolUse') {
    store.open();
    const open = store.findOpenDispatch(correlationKey, sessionId);
    const dispatchId = open ? open.id : null;
    const contract = open && open.contract ? open.contract : null;

    const resultText = normalizeResult(input.tool_response);

    // Validate return against contract
    const { violations } = checkReturn(contract, resultText);
    const score = computeScore(violations);

    let durationMs = null;
    if (open && open.ts) {
      durationMs = Date.parse(ts) - Date.parse(open.ts);
      if (isNaN(durationMs)) durationMs = null;
    }

    if (dispatchId && violations.length) {
      store.insertViolations(dispatchId, ts, 'return', violations);
    }
    store.insertReturn({
      dispatch_id: dispatchId,
      ts,
      result_text: resultText,
      score,
      duration_ms: durationMs,
    });

    const alert = score != null && score < ALERT_BELOW;

    emitStream({
      kind: 'complete',
      id: dispatchId,
      ts,
      session_id: sessionId,
      puppet_type: puppetType,
      title,
      result_text: resultText,
      score,
      duration_ms: durationMs,
      violations,
      contract,
      alert,
      alert_threshold: ALERT_BELOW,
    });
    return;
  }
}

function normalizeResult(resp) {
  if (resp == null) return '';
  if (typeof resp === 'string') return resp;
  // tool_response can be an object with content blocks, or just text
  if (resp.content && Array.isArray(resp.content)) {
    return resp.content
      .map((b) => (typeof b === 'string' ? b : b.text || ''))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof resp === 'object') {
    return JSON.stringify(resp);
  }
  return String(resp);
}

function emitStream(event) {
  try {
    fs.appendFileSync(STREAM_FILE, JSON.stringify(event) + '\n');
  } catch (err) {
    process.stderr.write(`[puppet-show] stream write failed: ${err.message}\n`);
  }
}

/**
 * Compare two contracts and return the list of fields that diverged plus a
 * compact per-field diff. Drift signals that the Maestro's briefing for the
 * same puppet+title has changed shape since last time — could be intentional
 * (new requirement) or accidental (forgot a constraint).
 */
function detectDrift(prior, current) {
  const changed = [];
  const diff = {};
  const checkArr = (field, prev, now) => {
    const a = (prev || []).slice().sort().join('|');
    const b = (now || []).slice().sort().join('|');
    if (a !== b) {
      changed.push(field);
      diff[field] = { prior: prev || [], current: now || [] };
    }
  };
  checkArr('scope_in', prior.scope_in, current.scope_in);
  checkArr('scope_out', prior.scope_out, current.scope_out);
  checkArr('tools', prior.tools, current.tools);
  if ((prior.enforcement || 'warn') !== (current.enforcement || 'warn')) {
    changed.push('enforcement');
    diff.enforcement = { prior: prior.enforcement, current: current.enforcement };
  }
  const ps = (prior.return_format && prior.return_format.sections) || [];
  const cs = (current.return_format && current.return_format.sections) || [];
  if (ps.slice().sort().join('|') !== cs.slice().sort().join('|')) {
    changed.push('return_format.sections');
    diff['return_format.sections'] = { prior: ps, current: cs };
  }
  return { changed, diff };
}
