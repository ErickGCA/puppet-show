/**
 * store.js — SQLite-backed storage for puppet-show.
 *
 * Schema:
 *   dispatches    — one row per Task tool invocation
 *   returns       — one row per Task tool completion
 *   violations    — return-time and (Phase 3) runtime contract violations
 *
 * All inserts are append-only. Reads are denormalized via SQL views.
 */

'use strict';

// Suppress the ExperimentalWarning for node:sqlite (it's stable enough for our use)
const origEmit = process.emit;
process.emit = function (name, data, ...args) {
  if (name === 'warning' && data && data.name === 'ExperimentalWarning' && /SQLite/.test(data.message || '')) {
    return false;
  }
  return origEmit.call(this, name, data, ...args);
};

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DEFAULT_DIR = path.join(os.homedir(), '.claude', 'puppet-show');
const DEFAULT_DB = process.env.PUPPET_SHOW_DB || path.join(DEFAULT_DIR, 'puppet-show.db');

let db;

function open(dbPath = DEFAULT_DB) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS dispatches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      session_id TEXT,
      cwd TEXT,
      puppet_type TEXT,
      title TEXT,
      briefing TEXT,
      contract_json TEXT,
      enforcement TEXT,
      auto_strict INTEGER DEFAULT 0,
      correlation_key TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dispatches_session ON dispatches(session_id);
    CREATE INDEX IF NOT EXISTS idx_dispatches_corr ON dispatches(correlation_key);
    CREATE INDEX IF NOT EXISTS idx_dispatches_ts ON dispatches(ts);

    CREATE TABLE IF NOT EXISTS returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dispatch_id INTEGER,
      ts TEXT NOT NULL,
      result_text TEXT,
      score INTEGER,
      duration_ms INTEGER,
      FOREIGN KEY (dispatch_id) REFERENCES dispatches(id)
    );
    CREATE INDEX IF NOT EXISTS idx_returns_dispatch ON returns(dispatch_id);

    CREATE TABLE IF NOT EXISTS violations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dispatch_id INTEGER,
      ts TEXT NOT NULL,
      stage TEXT,       -- 'runtime' or 'return'
      kind TEXT,
      detail TEXT,
      FOREIGN KEY (dispatch_id) REFERENCES dispatches(id)
    );
    CREATE INDEX IF NOT EXISTS idx_violations_dispatch ON violations(dispatch_id);
  `);
  return db;
}

function _db() {
  if (!db) open();
  return db;
}

function close() {
  if (db) {
    db.close();
    db = null;
  }
}

function insertDispatch({
  ts,
  session_id,
  cwd,
  puppet_type,
  title,
  briefing,
  contract,
  correlation_key,
}) {
  const stmt = _db().prepare(`
    INSERT INTO dispatches
      (ts, session_id, cwd, puppet_type, title, briefing, contract_json, enforcement, auto_strict, correlation_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    ts,
    session_id || null,
    cwd || null,
    puppet_type || null,
    title || null,
    briefing || null,
    contract ? JSON.stringify(contract) : null,
    contract ? contract.enforcement || 'warn' : 'warn',
    contract && contract._auto_strict ? 1 : 0,
    correlation_key || null
  );
  return info.lastInsertRowid;
}



function findOpenDispatch(correlation_key, session_id) {
  if (!correlation_key) return null;
  const row = _db().prepare(`
    SELECT d.* FROM dispatches d
    LEFT JOIN returns r ON r.dispatch_id = d.id
    WHERE d.correlation_key = ?
      AND (? IS NULL OR d.session_id = ?)
      AND r.id IS NULL
    ORDER BY d.ts DESC
    LIMIT 1
  `).get(correlation_key, session_id || null, session_id || null);
  return row ? hydrate(row) : null;
}

/**
 * Phase 3 lookup: given a hook firing inside a possible puppet, find the
 * matching open dispatch. Try session_id first (works if the runtime reuses
 * the parent session_id), then fall back to the most recent open dispatch
 * in the same cwd within `windowMs`. Returns null when nothing matches —
 * the hook then treats the call as Maestro-originated and bails out.
 */
function findOpenDispatchForRuntime({ session_id, cwd, windowMs = 600000 } = {}) {
  if (session_id) {
    const bySession = _db().prepare(`
      SELECT d.* FROM dispatches d
      LEFT JOIN returns r ON r.dispatch_id = d.id
      WHERE d.session_id = ?
        AND r.id IS NULL
      ORDER BY d.ts DESC
      LIMIT 1
    `).get(session_id);
    if (bySession) return hydrate(bySession);
  }
  if (cwd) {
    const since = new Date(Date.now() - windowMs).toISOString();
    const byCwd = _db().prepare(`
      SELECT d.* FROM dispatches d
      LEFT JOIN returns r ON r.dispatch_id = d.id
      WHERE d.cwd = ?
        AND r.id IS NULL
        AND d.ts >= ?
      ORDER BY d.ts DESC
      LIMIT 1
    `).get(cwd, since);
    if (byCwd) return hydrate(byCwd);
  }
  return null;
}

/**
 * Phase 4 helper: list recent dispatches sharing a correlation_key, oldest
 * first. Used to detect drift between consecutive runs of the same puppet
 * type + title.
 */
function recentByCorrelationKey(correlation_key, limit = 5) {
  if (!correlation_key) return [];
  const rows = _db().prepare(`
    SELECT d.*, r.score
    FROM dispatches d
    LEFT JOIN returns r ON r.dispatch_id = d.id
    WHERE d.correlation_key = ?
    ORDER BY d.ts DESC
    LIMIT ?
  `).all(correlation_key, limit);
  return rows.map(hydrate);
}

/**
 * Phase 4 helper: top-scoring historical dispatches whose title, puppet_type,
 * or briefing matches the query. The query is tokenized on whitespace; a row
 * is considered a match when at least one token appears in any of the three
 * fields (case-insensitive). Results are ranked by number of tokens matched,
 * then by score. Empty query returns the highest-scoring dispatches overall.
 *
 * We fetch a wider candidate pool from SQLite (ordered by score) and rank in
 * JS — keeps the SQL portable and lets us score against multiple fields
 * without building variable-length WHERE clauses.
 */
function topHistorical({ query = '', puppet_type = null, limit = 5, minScore = 85, pool = 200 } = {}) {
  const tokens = String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  const params = [minScore];
  let typeClause = '';
  if (puppet_type) {
    typeClause = 'AND d.puppet_type = ?';
    params.push(puppet_type);
  }
  params.push(pool);

  const rows = _db().prepare(`
    SELECT d.*, r.score, r.result_text
    FROM dispatches d
    JOIN returns r ON r.dispatch_id = d.id
    WHERE r.score >= ?
      ${typeClause}
    ORDER BY r.score DESC, d.ts DESC
    LIMIT ?
  `).all(...params);

  if (tokens.length === 0) {
    return rows.slice(0, limit).map(hydrate);
  }

  const ranked = rows
    .map((r) => {
      const hay = `${r.title || ''} ${r.puppet_type || ''} ${r.briefing || ''}`.toLowerCase();
      const matches = tokens.filter((t) => hay.includes(t)).length;
      return { r, matches };
    })
    .filter((x) => x.matches > 0);

  ranked.sort((a, b) => {
    if (b.matches !== a.matches) return b.matches - a.matches;
    return (b.r.score || 0) - (a.r.score || 0);
  });

  return ranked.slice(0, limit).map((x) => hydrate(x.r));
}

/**
 * Phase 4 helper: per-puppet-type aggregates over the window. Used by
 * /puppet-show:history.
 */
function statsByPuppetType({ days = 30 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  return _db().prepare(`
    SELECT
      d.puppet_type AS puppet_type,
      COUNT(*) AS dispatches,
      SUM(CASE WHEN r.id IS NOT NULL THEN 1 ELSE 0 END) AS completed,
      ROUND(AVG(r.score), 1) AS avg_score,
      MIN(r.score) AS min_score,
      MAX(r.score) AS max_score
    FROM dispatches d
    LEFT JOIN returns r ON r.dispatch_id = d.id
    WHERE d.ts >= ?
    GROUP BY d.puppet_type
    ORDER BY dispatches DESC
  `).all(since);
}

function insertReturn({ dispatch_id, ts, result_text, score, duration_ms }) {
  const stmt = _db().prepare(`
    INSERT INTO returns (dispatch_id, ts, result_text, score, duration_ms)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(
    dispatch_id || null,
    ts,
    result_text || null,
    score == null ? null : score,
    duration_ms == null ? null : duration_ms
  );
}

function insertViolations(dispatch_id, ts, stage, violations) {
  if (!violations || violations.length === 0) return;
  const stmt = _db().prepare(`
    INSERT INTO violations (dispatch_id, ts, stage, kind, detail)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const v of violations) {
    stmt.run(dispatch_id || null, ts, stage, v.kind, v.detail || '');
  }
}

function listRecent({ limit = 50, since = null } = {}) {
  const stmt = _db().prepare(`
    SELECT
      d.id, d.ts, d.session_id, d.cwd, d.puppet_type, d.title, d.briefing,
      d.contract_json, d.enforcement, d.auto_strict,
      r.ts AS returned_at, r.result_text, r.score, r.duration_ms,
      (SELECT COUNT(*) FROM violations v WHERE v.dispatch_id = d.id) AS violation_count,
      (SELECT detail FROM violations v WHERE v.dispatch_id = d.id AND v.kind = 'drift' ORDER BY v.ts ASC LIMIT 1) AS drift_detail
    FROM dispatches d
    LEFT JOIN returns r ON r.dispatch_id = d.id
    ${since ? 'WHERE d.ts > ?' : ''}
    ORDER BY d.ts DESC
    LIMIT ?
  `);
  const rows = since ? stmt.all(since, limit) : stmt.all(limit);
  return rows.map(hydrate);
}

function getDispatch(id) {
  const row = _db().prepare(`
    SELECT
      d.*, r.ts AS returned_at, r.result_text, r.score, r.duration_ms
    FROM dispatches d
    LEFT JOIN returns r ON r.dispatch_id = d.id
    WHERE d.id = ?
  `).get(id);
  if (!row) return null;
  const hydrated = hydrate(row);
  hydrated.violations = _db().prepare(`
    SELECT id, ts, stage, kind, detail FROM violations WHERE dispatch_id = ? ORDER BY ts ASC
  `).all(id);
  return hydrated;
}

function hydrate(row) {
  if (!row) return row;
  return {
    ...row,
    auto_strict: !!row.auto_strict,
    contract: row.contract_json ? safeParse(row.contract_json) : null,
    status: row.returned_at ? 'complete' : 'running',
    drift: row.drift_detail ? parseChangedFromDriftDetail(row.drift_detail) : null,
  };
}

// The drift violation's `detail` string is the source of truth for which
// contract fields diverged. We parse it back into a list so consumers (CLI,
// dashboard snapshot) can render a structured chip without re-running the
// comparison. Format produced by puppet-capture: "contract diverged from
// prior run: scope_in, scope_out, tools".
function parseChangedFromDriftDetail(detail) {
  const m = String(detail || '').match(/diverged from prior run:\s*(.+)$/);
  if (!m) return null;
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function stats({ days = 7 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const total = _db().prepare(`SELECT COUNT(*) AS n FROM dispatches WHERE ts > ?`).get(since).n;
  const completed = _db().prepare(`
    SELECT COUNT(*) AS n FROM returns r
    JOIN dispatches d ON d.id = r.dispatch_id
    WHERE r.ts > ?
  `).get(since).n;
  const avg = _db().prepare(`
    SELECT AVG(score) AS avg_score FROM returns r
    JOIN dispatches d ON d.id = r.dispatch_id
    WHERE r.ts > ? AND r.score IS NOT NULL
  `).get(since).avg_score;
  const violations_by_kind = _db().prepare(`
    SELECT kind, COUNT(*) AS n FROM violations v
    JOIN dispatches d ON d.id = v.dispatch_id
    WHERE v.ts > ?
    GROUP BY kind
    ORDER BY n DESC
  `).all(since);
  return {
    window_days: days,
    total_dispatches: total,
    completed,
    avg_score: avg == null ? null : Math.round(avg),
    violations_by_kind,
  };
}

function clear() {
  _db().exec(`DELETE FROM violations; DELETE FROM returns; DELETE FROM dispatches;`);
}

module.exports = {
  open,
  close,
  insertDispatch,
  insertReturn,
  insertViolations,
  findOpenDispatch,
  findOpenDispatchForRuntime,
  recentByCorrelationKey,
  topHistorical,
  statsByPuppetType,
  listRecent,
  getDispatch,
  stats,
  clear,
  DEFAULT_DB,
};
