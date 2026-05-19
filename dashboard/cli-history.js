#!/usr/bin/env node
/**
 * cli-history.js — Aggregate view of historical puppet behavior.
 *
 * Prints two tables:
 *   1. Per-puppet-type stats over the window (default 30 days).
 *   2. Top reused titles with average score and trend.
 *
 * Usage: node cli-history.js [days]
 */

'use strict';

const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const store = require(path.join(ROOT, 'lib/store'));

const days = Math.max(1, Math.min(parseInt(process.argv[2] || '30', 10), 365));

store.open();

const c = {
  gold: (s) => `\x1b[33m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function band(score) {
  if (score == null) return c.dim;
  if (score >= 85) return c.green;
  if (score >= 60) return c.gold;
  return c.red;
}

console.log('');
console.log(c.bold(`  🎭 puppet-show history · last ${days} days`));
console.log('');

const byType = store.statsByPuppetType({ days });
if (byType.length === 0) {
  console.log(c.dim('  no dispatches in window.'));
  process.exit(0);
}

console.log(c.bold('  By puppet type'));
console.log(c.dim('  ─────────────────────────────────────────────────────────'));
console.log(c.dim('  type                       count   done   avg   min   max'));
for (const r of byType) {
  const colorAvg = band(r.avg_score);
  const line =
    '  ' +
    pad(r.puppet_type || '(none)', 25) +
    pad(String(r.dispatches), 7) +
    pad(String(r.completed), 7) +
    colorAvg(pad(r.avg_score == null ? '—' : String(r.avg_score), 6)) +
    pad(r.min_score == null ? '—' : String(r.min_score), 6) +
    pad(r.max_score == null ? '—' : String(r.max_score), 6);
  console.log(line);
}
console.log('');

// Top reused titles: aggregate on correlation_key
const recent = store.listRecent({ limit: 500 });
const grouped = new Map();
for (const r of recent) {
  if (!r.title) continue;
  const key = `${r.puppet_type}::${r.title}`;
  if (!grouped.has(key)) grouped.set(key, { title: r.title, type: r.puppet_type, runs: [], scores: [] });
  grouped.get(key).runs.push(r);
  if (r.score != null) grouped.get(key).scores.push(r.score);
}

const reused = [...grouped.values()].filter((g) => g.runs.length >= 2).sort((a, b) => b.runs.length - a.runs.length);
if (reused.length === 0) {
  console.log(c.dim('  No titles used more than once yet.'));
  process.exit(0);
}

console.log(c.bold('  Most reused titles'));
console.log(c.dim('  ─────────────────────────────────────────────────────────'));
for (const g of reused.slice(0, 10)) {
  const avg = g.scores.length ? Math.round(g.scores.reduce((a, b) => a + b, 0) / g.scores.length) : null;
  const colorAvg = band(avg);
  console.log(`  ${c.bold(g.title)} ${c.dim(`(${g.type})`)}`);
  console.log(`    ${c.dim(`runs: ${g.runs.length}`)} · avg ${colorAvg(avg == null ? '—' : avg)} · last score ${band(g.runs[0].score)(g.runs[0].score == null ? '—' : g.runs[0].score)}`);
}
console.log('');

store.close();

function pad(s, n) {
  s = String(s);
  if (s.length >= n) return s + ' ';
  return s + ' '.repeat(n - s.length);
}
