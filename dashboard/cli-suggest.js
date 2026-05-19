#!/usr/bin/env node
/**
 * cli-suggest.js — Phase 4 reuse helper.
 *
 * Given a free-text query (typically the title or puppet type the Maestro
 * is about to dispatch), finds historical high-scoring dispatches whose
 * title or puppet_type matches, and prints their contracts as reusable
 * templates. Min score defaults to 85.
 *
 * Usage: node cli-suggest.js <query> [--min=85] [--limit=3]
 */

'use strict';

const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const store = require(path.join(ROOT, 'lib/store'));

const args = process.argv.slice(2);
let query = '';
let minScore = 85;
let limit = 3;
for (const a of args) {
  if (a.startsWith('--min=')) {
    const v = parseInt(a.slice(6), 10);
    if (!isNaN(v)) minScore = v;
  } else if (a.startsWith('--limit=')) {
    const v = parseInt(a.slice(8), 10);
    if (!isNaN(v) && v > 0) limit = v;
  } else {
    query += (query ? ' ' : '') + a;
  }
}

const c = {
  gold: (s) => `\x1b[33m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

store.open();

console.log('');
console.log(c.bold(`  🎭 puppet-show suggest · query: "${query || '(any)'}", min score ${minScore}`));
console.log('');

const rows = store.topHistorical({ query, minScore, limit });
if (rows.length === 0) {
  console.log(c.dim(`  no historical dispatches with score ≥ ${minScore} match "${query}".`));
  console.log(c.dim('  try lowering --min or broadening the query.'));
  process.exit(0);
}

for (const r of rows) {
  console.log(`  ${c.green('●')} ${c.bold(r.title)} ${c.dim(`(${r.puppet_type})`)} — ${c.green(r.score + '/100')}`);
  console.log(c.dim(`    ${new Date(r.ts).toLocaleString()}`));
  if (r.contract) {
    const ci = r.contract.scope_in || [];
    const co = r.contract.scope_out || [];
    const tools = r.contract.tools || [];
    const rf = r.contract.return_format || {};
    console.log(c.dim('    ── proven contract ──'));
    if (ci.length) console.log(`    scope_in:  [${ci.join(', ')}]`);
    if (co.length) console.log(`    scope_out: [${co.join(', ')}]`);
    if (tools.length) console.log(`    tools:     [${tools.join(', ')}]`);
    if (rf.sections) console.log(`    sections:  [${rf.sections.join(', ')}]`);
    if (rf.require_evidence) console.log(`    require_evidence: true`);
    if (rf.min_words_per_section) console.log(`    min_words_per_section: ${rf.min_words_per_section}`);
    console.log(`    enforcement: ${r.contract.enforcement || 'warn'}`);
  }
  console.log('');
}

store.close();
