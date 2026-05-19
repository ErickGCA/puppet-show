#!/usr/bin/env node
/**
 * cli-audit.js — Print recent puppet dispatches to stdout in a terminal-
 * friendly format. Called by /puppet-show:audit.
 */

'use strict';

const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const store = require(path.join(ROOT, 'lib/store'));

const limit = Math.max(1, Math.min(parseInt(process.argv[2] || '10', 10), 100));
const ALERT_BELOW = parseInt(process.env.PUPPET_SHOW_ALERT_BELOW || '70', 10);

store.open();
const rows = store.listRecent({ limit });
const s = store.stats({ days: 7 });

// ANSI
const c = {
  gold: (s) => `\x1b[33m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  italic: (s) => `\x1b[3m${s}\x1b[0m`,
};

function bandColor(score, status) {
  if (status === 'running') return c.gold;
  if (score == null) return c.dim;
  if (score >= 85) return c.green;
  if (score >= 60) return c.gold;
  return c.red;
}

console.log('');
console.log(c.bold('  🎭 puppet-show audit'));
console.log(c.dim(`  last ${rows.length} dispatches · 7-day window: ${s.total_dispatches} total, avg score ${s.avg_score ?? '—'}, ${(s.violations_by_kind || []).reduce((a, v) => a + v.n, 0)} violations`));
console.log('');

if (rows.length === 0) {
  console.log(c.dim('  no dispatches yet.'));
  process.exit(0);
}

for (const r of rows) {
  const color = bandColor(r.score, r.status);
  const scoreLabel = r.status === 'running' ? 'running' : (r.score == null ? '—' : `${r.score}/100`);
  const tStr = new Date(r.ts).toLocaleString();
  const strict = r.enforcement === 'strict' ? c.dim(' ⚐') : '';

  const alertBadge =
    r.status === 'complete' && r.score != null && r.score < ALERT_BELOW
      ? ' ' + c.red(`⚠ alert<${ALERT_BELOW}`)
      : '';
  console.log(`  ${color('●')} ${c.bold(r.title)}${strict}${alertBadge}`);
  console.log(`    ${c.dim(`${r.puppet_type} · ${tStr} · ${color(scoreLabel)}${r.duration_ms != null ? c.dim(` · ${fmtDur(r.duration_ms)}`) : ''}`)}`);

  if (r.contract) {
    const ci = r.contract.scope_in || [];
    const co = r.contract.scope_out || [];
    const ct = r.contract.tools || [];
    if (ci.length || co.length || ct.length) {
      const parts = [];
      if (ci.length) parts.push(c.green(`in: ${ci.join(', ')}`));
      if (co.length) parts.push(c.red(`out: ${co.join(', ')}`));
      if (ct.length) parts.push(c.dim(`tools: ${ct.join(', ')}`));
      console.log(`    ${parts.join(c.dim(' · '))}`);
    }
  }

  if (r.violation_count > 0) {
    const detail = store.getDispatch(r.id);
    for (const v of detail.violations) {
      console.log(`    ${c.red('⚠')} ${c.dim(v.kind)} ${v.detail}`);
    }
  }
  console.log('');
}

function fmtDur(ms) {
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  const m = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${m}m ${sec}s`;
}
