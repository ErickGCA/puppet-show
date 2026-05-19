/**
 * contract.js — Single source of truth for puppet contracts.
 *
 * The Maestro embeds a YAML contract block inside the Task tool's `prompt`,
 * delimited by these markers:
 *
 *     ---puppet-contract
 *     scope_in: [src/auth/**]
 *     scope_out: [.env*, src/billing/**]
 *     tools: [Read, Grep, Glob]
 *     enforcement: warn      # or strict
 *     return_format:
 *       sections: [Did, Findings, OpenQuestions]
 *       require_evidence: true
 *     ---
 *
 * Everything outside the block is the human-readable briefing. The contract
 * stays attached to the dispatch through the entire lifecycle.
 *
 * No external deps: tiny purpose-built YAML subset parser, only what we need.
 */

'use strict';

const SENSITIVE_PATTERNS = [
  /\.env(\.|$)/,
  /^secrets?\//,
  /\/secrets?\//,
  /private[_-]?key/i,
  /\/infra\//,
  /\/production\//,
  /^migrations\//,
  /\.pem$/,
  /\.key$/,
  /credentials/i,
];

const CONTRACT_OPEN = /^---puppet-contract\s*$/m;
const CONTRACT_CLOSE = /^---\s*$/m;

/**
 * Extract the YAML contract block from a puppet's prompt.
 * Returns { contract, briefing } where briefing is the prompt with the block
 * stripped. If no contract is found, contract is null and briefing is the
 * original prompt.
 */
function extractContractFromPrompt(prompt) {
  if (!prompt || typeof prompt !== 'string') {
    return { contract: null, briefing: prompt || '' };
  }

  const openMatch = prompt.match(CONTRACT_OPEN);
  if (!openMatch) return { contract: null, briefing: prompt };

  const start = openMatch.index + openMatch[0].length;
  const after = prompt.slice(start);
  const closeMatch = after.match(CONTRACT_CLOSE);
  if (!closeMatch) return { contract: null, briefing: prompt };

  const yamlBody = after.slice(0, closeMatch.index).trim();
  const briefing = (
    prompt.slice(0, openMatch.index) +
    after.slice(closeMatch.index + closeMatch[0].length)
  ).trim();

  try {
    const parsed = parseTinyYaml(yamlBody);
    return { contract: normalizeContract(parsed), briefing };
  } catch (err) {
    return {
      contract: { _parse_error: err.message, _raw: yamlBody },
      briefing,
    };
  }
}

/**
 * Tiny YAML parser that handles the subset we need:
 *   - key: value
 *   - key: [a, b, c]   (inline lists)
 *   - key:
 *       - item
 *       - item
 *   - nested:
 *       key: value
 *
 * Two indentation levels. Values are strings unless they look like bool/number.
 */
function parseTinyYaml(text) {
  const lines = text.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  const root = {};
  const stack = [{ indent: -1, obj: root }];

  for (const rawLine of lines) {
    const indent = rawLine.match(/^(\s*)/)[1].length;
    const line = rawLine.trim();

    // Pop stack to current indent
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].obj;

    if (line.startsWith('- ')) {
      const value = parseValue(line.slice(2).trim());
      if (!Array.isArray(parent)) {
        throw new Error(`list item at unexpected position: ${line}`);
      }
      parent.push(value);
      continue;
    }

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) throw new Error(`bad line: ${line}`);
    const key = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();

    if (rest === '') {
      // Could be a map or a list — defer; create an object placeholder.
      const child = [];
      // Peek next non-empty line to decide. To keep it simple, default to []
      // then convert to {} on the first key:value child.
      parent[key] = child;
      stack.push({ indent, obj: child, _key: key, _parent: parent });
    } else if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1).trim();
      parent[key] = inner === '' ? [] : inner.split(',').map((s) => parseValue(s.trim()));
    } else {
      parent[key] = parseValue(rest);
    }
  }

  // Convert empty-array placeholders that ended up with k:v children into objects
  function fixTypes(obj) {
    if (Array.isArray(obj)) {
      obj.forEach(fixTypes);
      return obj;
    }
    if (obj && typeof obj === 'object') {
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        // If a "list" actually has zero items but was the start of a nested map,
        // we may end up with the wrong type. Caller normalization handles this
        // because we know the expected shape per field.
        fixTypes(v);
      }
    }
    return obj;
  }
  return fixTypes(root);
}

function parseValue(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null' || raw === '~') return null;
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return parseFloat(raw);
  // Strip surrounding quotes
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

/**
 * Normalize a parsed contract into a stable shape with defaults.
 * Also auto-detects sensitive scope and suggests enforcement.
 */
function normalizeContract(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const c = {
    scope_in: asArray(raw.scope_in),
    scope_out: asArray(raw.scope_out),
    tools: asArray(raw.tools),
    enforcement: raw.enforcement === 'strict' ? 'strict' : 'warn',
    return_format: normalizeReturnFormat(raw.return_format),
    notes: typeof raw.notes === 'string' ? raw.notes : '',
  };

  // Auto-strict if the contract touches sensitive paths and the user didn't
  // explicitly set enforcement.
  if (raw.enforcement === undefined && touchesSensitive(c)) {
    c.enforcement = 'strict';
    c._auto_strict = true;
  }

  return c;
}

function asArray(v) {
  if (Array.isArray(v)) return v.map(String);
  if (v == null) return [];
  return [String(v)];
}

function normalizeReturnFormat(rf) {
  if (!rf || typeof rf !== 'object') {
    return {
      sections: ['Did', 'Findings', 'OpenQuestions'],
      require_evidence: false,
      min_words_per_section: 0,
    };
  }
  return {
    sections: asArray(rf.sections).length
      ? asArray(rf.sections)
      : ['Did', 'Findings', 'OpenQuestions'],
    require_evidence: rf.require_evidence === true,
    min_words_per_section: parseInt(rf.min_words_per_section, 10) || 0,
  };
}

function touchesSensitive(contract) {
  const all = [...(contract.scope_in || []), ...(contract.scope_out || [])];
  return all.some((p) => SENSITIVE_PATTERNS.some((re) => re.test(p)));
}

/**
 * Phase 2/3 hook: check a tool call against the contract.
 * Returns { ok, violations: [{kind, detail}] }.
 */
function checkToolCall(contract, toolName, toolInput) {
  const violations = [];
  if (!contract) return { ok: true, violations };

  // Tool restriction
  if (contract.tools && contract.tools.length > 0) {
    if (!contract.tools.includes(toolName)) {
      violations.push({
        kind: 'tool_not_allowed',
        detail: `${toolName} not in contract.tools (${contract.tools.join(', ')})`,
      });
    }
  }

  // Path restriction (very rough — Phase 3 will use proper glob matching)
  const path = extractPathFromInput(toolName, toolInput);
  if (path) {
    if (contract.scope_out && contract.scope_out.some((p) => simpleMatch(p, path))) {
      violations.push({
        kind: 'scope_out_violated',
        detail: `${toolName} touched ${path} which is in scope_out`,
      });
    }
    if (
      contract.scope_in &&
      contract.scope_in.length > 0 &&
      !contract.scope_in.some((p) => simpleMatch(p, path))
    ) {
      violations.push({
        kind: 'scope_in_violated',
        detail: `${toolName} touched ${path} outside scope_in`,
      });
    }
  }

  return { ok: violations.length === 0, violations };
}

function extractPathFromInput(toolName, input) {
  if (!input || typeof input !== 'object') return null;
  return input.file_path || input.path || input.notebook_path || null;
}

function simpleMatch(pattern, path) {
  // Convert ** to .*, * to [^/]*, ? to ., escape rest
  const re = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '@@DOUBLESTAR@@')
        .replace(/\*/g, '[^/]*')
        .replace(/@@DOUBLESTAR@@/g, '.*')
        .replace(/\?/g, '.') +
      '$'
  );
  return re.test(path);
}

/**
 * Phase 2 hook: validate the puppet's RETURN against the return_format.
 */
function checkReturn(contract, resultText) {
  const violations = [];
  if (!contract || !contract.return_format) return { ok: true, violations };

  const rf = contract.return_format;
  const text = typeof resultText === 'string' ? resultText : JSON.stringify(resultText || '');

  // Section presence (case-insensitive, match # Heading or **Heading**)
  for (const section of rf.sections) {
    const re = new RegExp(
      `(^|\\n)\\s*(#+\\s*${section}|\\*\\*${section}\\*\\*)\\b`,
      'i'
    );
    if (!re.test(text)) {
      violations.push({
        kind: 'section_missing',
        detail: `expected section "${section}" not found in return`,
      });
    }
  }

  // Evidence (global) — at least one citation anywhere in the return.
  if (rf.require_evidence) {
    const hasFileCite = /\b[\w./-]+\.\w+:\d+/.test(text);
    const hasEvidenceTag = /\[evidence:[^\]]+\]/i.test(text);
    if (!hasFileCite && !hasEvidenceTag) {
      violations.push({
        kind: 'evidence_missing',
        detail: 'return claims facts but cites no file:line or [evidence: ...] tag',
      });
    }
  }

  const sections = parseSections(text);

  // Per-section minimum word count (only when contract opts in).
  if (rf.min_words_per_section > 0) {
    for (const required of rf.sections) {
      const found = matchSection(sections, required);
      if (!found) continue; // already reported as section_missing
      const wc = countWords(found.content);
      if (wc < rf.min_words_per_section) {
        violations.push({
          kind: 'section_too_short',
          detail: `section "${required}" has ${wc} words (min ${rf.min_words_per_section})`,
        });
      }
    }
  }

  // Per-finding evidence — strictly when a Findings section exists and
  // require_evidence is on. Each list item must carry its own citation.
  if (rf.require_evidence) {
    const findings = matchSection(sections, 'Findings');
    if (findings) {
      const items = parseListItems(findings.content);
      if (items.length > 0) {
        const without = items.filter((item) => !itemHasEvidence(item));
        if (without.length > 0) {
          violations.push({
            kind: 'findings_evidence_missing',
            detail: `${without.length}/${items.length} findings have no path:line or [evidence: ...] citation`,
          });
        }
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Parse the return into a list of sections keyed by heading text.
 * Recognizes `#`+ headings and `**Heading**` lines as section breaks.
 * Returns [{name, content}] preserving order.
 */
function parseSections(text) {
  const lines = text.split('\n');
  const out = [];
  let current = null;
  let buf = [];
  for (const line of lines) {
    const h = line.match(/^\s*(?:#+\s*(.+?)|\*\*(.+?)\*\*)\s*$/);
    if (h) {
      if (current) out.push({ name: current, content: buf.join('\n') });
      current = (h[1] || h[2]).trim();
      buf = [];
    } else if (current !== null) {
      buf.push(line);
    }
  }
  if (current) out.push({ name: current, content: buf.join('\n') });
  return out;
}

function matchSection(sections, name) {
  const lower = name.toLowerCase();
  return sections.find((s) => s.name.toLowerCase() === lower) || null;
}

function countWords(text) {
  return (text.match(/\b\w+\b/g) || []).length;
}

/**
 * Parse list items from a section body. Handles `-`, `*`, and `1.` bullets.
 * Continuation lines (indented or non-bullet, non-blank) belong to the
 * previous item — important for multi-line findings.
 */
function parseListItems(text) {
  const lines = text.split('\n');
  const items = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^\s*(?:-|\*|\d+\.)\s+(.*)$/);
    if (m) {
      if (cur !== null) items.push(cur);
      cur = m[1];
    } else if (cur !== null && line.trim() !== '') {
      cur += '\n' + line;
    } else if (cur !== null && line.trim() === '') {
      // blank line ends the item
      items.push(cur);
      cur = null;
    }
  }
  if (cur !== null) items.push(cur);
  return items;
}

function itemHasEvidence(item) {
  return /\b[\w./-]+\.\w+:\d+/.test(item) || /\[evidence:[^\]]+\]/i.test(item);
}

/**
 * Compute a compliance score 0-100 from a list of violations.
 * Per-kind weights so a tool-not-allowed counts more than a missing section.
 */
const VIOLATION_WEIGHTS = {
  tool_not_allowed: 30,
  scope_out_violated: 40,
  scope_in_violated: 20,
  section_missing: 10,
  evidence_missing: 15,
  findings_evidence_missing: 8,
  section_too_short: 5,
  drift: 0, // informational only — does not reduce score
};

function computeScore(violations) {
  if (!violations || violations.length === 0) return 100;
  let penalty = 0;
  for (const v of violations) {
    penalty += VIOLATION_WEIGHTS[v.kind] || 5;
  }
  return Math.max(0, 100 - penalty);
}

module.exports = {
  extractContractFromPrompt,
  normalizeContract,
  checkToolCall,
  checkReturn,
  computeScore,
  touchesSensitive,
  SENSITIVE_PATTERNS,
  VIOLATION_WEIGHTS,
};
