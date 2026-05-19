const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const TEST_DB = path.join(os.tmpdir(), `ps-test-${Date.now()}.db`);
const store = require('./store');
store.open(TEST_DB);

// Insert a dispatch
const id = store.insertDispatch({
  ts: '2026-05-18T14:00:00.000Z',
  session_id: 's1',
  cwd: '/proj',
  puppet_type: 'general-purpose',
  title: 'Audit auth flow',
  briefing: 'do the audit',
  contract: {
    scope_in: ['src/auth/**'],
    scope_out: ['.env*'],
    enforcement: 'strict',
    _auto_strict: true,
  },
  correlation_key: 'general-purpose::Audit auth flow',
});
assert.ok(id > 0, 'dispatch id');

// Look it up
const open = store.findOpenDispatch('general-purpose::Audit auth flow', 's1');
assert.ok(open && open.id === id, 'find open by correlation');

// Add violations
store.insertViolations(id, '2026-05-18T14:00:30.000Z', 'runtime', [
  { kind: 'scope_out_violated', detail: '.env touched' },
]);

// Add a return
store.insertReturn({
  dispatch_id: id,
  ts: '2026-05-18T14:00:42.000Z',
  result_text: '# Did\nstuff\n# Findings\nstuff',
  score: 60,
  duration_ms: 42000,
});

// Recent list
const recent = store.listRecent({ limit: 10 });
assert.strictEqual(recent.length, 1, 'one recent');
assert.strictEqual(recent[0].status, 'complete', 'status complete');
assert.strictEqual(recent[0].violation_count, 1, 'one violation counted');
assert.ok(recent[0].contract && recent[0].contract.scope_in[0] === 'src/auth/**', 'contract roundtrip');

// Detail
const detail = store.getDispatch(id);
assert.strictEqual(detail.violations.length, 1, 'one violation in detail');
assert.strictEqual(detail.score, 60, 'score');

// Findnoopen after return
const stillOpen = store.findOpenDispatch('general-purpose::Audit auth flow', 's1');
assert.strictEqual(stillOpen, null, 'no longer open after return');

// Stats
const s = store.stats({ days: 30 });
assert.strictEqual(s.total_dispatches, 1, 'stats total');
assert.strictEqual(s.completed, 1, 'stats completed');
assert.strictEqual(s.avg_score, 60, 'stats avg');
assert.ok(s.violations_by_kind.length === 1, 'stats violations');

store.close();
fs.unlinkSync(TEST_DB);
console.log('all store tests passed');
