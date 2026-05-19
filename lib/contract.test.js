const assert = require('assert');
const {
  extractContractFromPrompt,
  checkToolCall,
  checkReturn,
  computeScore,
} = require('./contract');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('extracts a basic contract', () => {
  const prompt = `Do the thing.

---puppet-contract
scope_in: [src/auth/**]
scope_out: [.env*, src/billing/**]
tools: [Read, Grep]
return_format:
  sections: [Did, Findings]
  require_evidence: true
---

Briefing continues here.`;

  const { contract, briefing } = extractContractFromPrompt(prompt);
  assert.deepStrictEqual(contract.scope_in, ['src/auth/**']);
  assert.deepStrictEqual(contract.scope_out, ['.env*', 'src/billing/**']);
  assert.deepStrictEqual(contract.tools, ['Read', 'Grep']);
  assert.strictEqual(contract.return_format.require_evidence, true);
  assert.deepStrictEqual(contract.return_format.sections, ['Did', 'Findings']);
  assert.ok(briefing.includes('Do the thing'));
  assert.ok(briefing.includes('Briefing continues here'));
  assert.ok(!briefing.includes('puppet-contract'));
});

test('no contract returns null', () => {
  const { contract, briefing } = extractContractFromPrompt('just a prompt');
  assert.strictEqual(contract, null);
  assert.strictEqual(briefing, 'just a prompt');
});

test('auto-strict on sensitive scope', () => {
  const prompt = `---puppet-contract
scope_in: [src/**]
scope_out: [.env, secrets/]
---`;
  const { contract } = extractContractFromPrompt(prompt);
  assert.strictEqual(contract.enforcement, 'strict');
  assert.strictEqual(contract._auto_strict, true);
});

test('explicit warn beats auto-strict', () => {
  const prompt = `---puppet-contract
scope_out: [.env]
enforcement: warn
---`;
  const { contract } = extractContractFromPrompt(prompt);
  assert.strictEqual(contract.enforcement, 'warn');
  assert.ok(!contract._auto_strict);
});

test('checkToolCall: tool not allowed', () => {
  const contract = { tools: ['Read', 'Grep'], scope_in: [], scope_out: [] };
  const r = checkToolCall(contract, 'Bash', { command: 'ls' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.violations[0].kind, 'tool_not_allowed');
});

test('checkToolCall: scope_out hit', () => {
  const contract = {
    tools: ['Read'],
    scope_in: ['src/**'],
    scope_out: ['.env*'],
  };
  const r = checkToolCall(contract, 'Read', { file_path: '.env.local' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.violations.some((v) => v.kind === 'scope_out_violated'));
});

test('checkToolCall: scope_in respected', () => {
  const contract = {
    tools: ['Read'],
    scope_in: ['src/auth/**'],
    scope_out: [],
  };
  const ok = checkToolCall(contract, 'Read', { file_path: 'src/auth/login.ts' });
  assert.strictEqual(ok.ok, true);

  const bad = checkToolCall(contract, 'Read', { file_path: 'src/billing/charge.ts' });
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.violations.some((v) => v.kind === 'scope_in_violated'));
});

test('checkReturn: missing sections', () => {
  const contract = {
    return_format: { sections: ['Did', 'Findings'], require_evidence: false },
  };
  const r = checkReturn(contract, '# Did\nI did stuff.');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.violations[0].kind, 'section_missing');
});

test('checkReturn: evidence required and present', () => {
  const contract = {
    return_format: { sections: ['Did'], require_evidence: true },
  };
  const r = checkReturn(contract, '# Did\nFixed src/auth/login.ts:42 — see the diff.');
  assert.strictEqual(r.ok, true);
});

test('checkReturn: evidence required, absent', () => {
  const contract = {
    return_format: { sections: ['Did'], require_evidence: true },
  };
  const r = checkReturn(contract, '# Did\nFixed the bug.');
  assert.strictEqual(r.ok, false);
  assert.ok(r.violations.some((v) => v.kind === 'evidence_missing'));
});

test('computeScore: clean = 100', () => {
  assert.strictEqual(computeScore([]), 100);
});

test('computeScore: penalties stack', () => {
  const s = computeScore([
    { kind: 'tool_not_allowed' },
    { kind: 'section_missing' },
  ]);
  assert.strictEqual(s, 60); // 100 - 30 - 10
});

test('checkReturn: per-finding evidence — all cited', () => {
  const contract = {
    return_format: { sections: ['Findings'], require_evidence: true },
  };
  const r = checkReturn(contract, `# Findings
- Found stale session at src/auth/login.ts:42
- Token TTL ignored in middleware/session.ts:18
`);
  assert.strictEqual(r.ok, true, JSON.stringify(r.violations));
});

test('checkReturn: per-finding evidence — one item missing citation', () => {
  const contract = {
    return_format: { sections: ['Findings'], require_evidence: true },
  };
  const r = checkReturn(contract, `# Findings
- Found stale session at src/auth/login.ts:42
- The middleware seems wrong but I don't have a line
`);
  assert.ok(
    r.violations.some((v) => v.kind === 'findings_evidence_missing'),
    'expected findings_evidence_missing'
  );
});

test('checkReturn: per-finding evidence with [evidence: ...] tag', () => {
  const contract = {
    return_format: { sections: ['Findings'], require_evidence: true },
  };
  const r = checkReturn(contract, `# Findings
- The flag does not propagate [evidence: traced in src/flag.ts]
- Also broken at config/x.yml:5
`);
  assert.ok(
    !r.violations.some((v) => v.kind === 'findings_evidence_missing'),
    'evidence tag should satisfy'
  );
});

test('checkReturn: min_words_per_section flags shallow sections', () => {
  const contract = {
    return_format: {
      sections: ['Did', 'Findings'],
      require_evidence: false,
      min_words_per_section: 5,
    },
  };
  const r = checkReturn(contract, `# Did
ok.

# Findings
one two three four five
`);
  assert.ok(
    r.violations.some(
      (v) => v.kind === 'section_too_short' && /Did/.test(v.detail)
    ),
    'Did is too short'
  );
  assert.ok(
    !r.violations.some(
      (v) => v.kind === 'section_too_short' && /Findings/.test(v.detail)
    ),
    'Findings is long enough'
  );
});

test('checkReturn: min_words=0 means no per-section check', () => {
  const contract = {
    return_format: { sections: ['Did'], require_evidence: false },
  };
  const r = checkReturn(contract, '# Did\nok.');
  assert.ok(
    !r.violations.some((v) => v.kind === 'section_too_short'),
    'no check when min_words_per_section is unset'
  );
});

test('malformed yaml: produces parse error but does not crash', () => {
  const prompt = `---puppet-contract
this is not valid yaml at all : : :
---`;
  const { contract } = extractContractFromPrompt(prompt);
  // Either parses something or sets _parse_error; either way no throw
  assert.ok(contract !== undefined);
});

// Run
let pass = 0, fail = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log('  ✓', name);
    pass++;
  } catch (e) {
    console.log('  ✗', name);
    console.log('     ', e.message);
    fail++;
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
