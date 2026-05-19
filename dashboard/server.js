#!/usr/bin/env node
/**
 * server.js — Dashboard backend.
 *
 * Endpoints:
 *   GET  /                    → HTML
 *   GET  /api/recent?limit=&since=  → recent dispatches with returns/violations
 *   GET  /api/dispatch/:id    → single dispatch with full violations
 *   GET  /api/stats?days=     → aggregate stats
 *   GET  /events              → SSE stream of new puppet events
 *   POST /api/clear           → wipe the DB (dev only)
 *
 * Stream events are tailed from PUPPET_SHOW_LOG_DIR/stream.jsonl (written by
 * the hook). New connections also get a snapshot via /api/recent.
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const url = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const store = require(path.join(ROOT, 'lib/store'));

const PORT = parseInt(process.env.PUPPET_SHOW_PORT || '4711', 10);
const LOG_DIR = process.env.PUPPET_SHOW_LOG_DIR || path.join(os.homedir(), '.claude', 'puppet-show');
const STREAM_FILE = path.join(LOG_DIR, 'stream.jsonl');
const HTML_FILE = path.join(__dirname, 'index.html');

fs.mkdirSync(LOG_DIR, { recursive: true });
if (!fs.existsSync(STREAM_FILE)) fs.writeFileSync(STREAM_FILE, '');

store.open();

// ─── SSE tail ────────────────────────────────────────────────────────────
const sseClients = new Set();
let lastSize = fs.statSync(STREAM_FILE).size;
let buf = '';

function broadcast(line) {
  if (!line.trim()) return;
  const payload = `data: ${line}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch {}
  }
}

fs.watch(STREAM_FILE, { persistent: true }, () => {
  fs.stat(STREAM_FILE, (err, stat) => {
    if (err) return;
    if (stat.size < lastSize) { lastSize = 0; buf = ''; }
    if (stat.size === lastSize) return;
    const stream = fs.createReadStream(STREAM_FILE, {
      start: lastSize, end: stat.size, encoding: 'utf8',
    });
    stream.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        broadcast(line);
      }
    });
    stream.on('end', () => { lastSize = stat.size; });
  });
});

// ─── HTTP ────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const p = parsed.pathname;

  if (p === '/' || p === '/index.html') {
    return fs.readFile(HTML_FILE, (err, data) => {
      if (err) { res.writeHead(500); return res.end('html not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  }

  if (p === '/api/recent') {
    const limit = Math.min(parseInt(parsed.query.limit) || 100, 500);
    const since = parsed.query.since || null;
    return json(res, store.listRecent({ limit, since }));
  }

  const dm = p.match(/^\/api\/dispatch\/(\d+)$/);
  if (dm) {
    const d = store.getDispatch(parseInt(dm[1], 10));
    if (!d) { res.writeHead(404); return res.end('not found'); }
    return json(res, d);
  }

  if (p === '/api/stats') {
    const days = parseInt(parsed.query.days) || 7;
    const s = store.stats({ days });
    s.alert_below = parseInt(process.env.PUPPET_SHOW_ALERT_BELOW || '70', 10);
    return json(res, s);
  }

  if (p === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (p === '/api/clear' && req.method === 'POST') {
    store.clear();
    fs.writeFileSync(STREAM_FILE, '');
    lastSize = 0;
    buf = '';
    return json(res, { ok: true });
  }

  res.writeHead(404);
  res.end('not found');
});

function json(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

server.listen(PORT, () => {
  console.log(`\n🎭 puppet-show — http://localhost:${PORT}`);
  console.log(`   db:    ${store.DEFAULT_DB}`);
  console.log(`   tail:  ${STREAM_FILE}\n`);
});
