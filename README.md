# puppet-show

> Contract-bound puppets for Claude Code. Every subagent dispatch ships with a
> machine-verifiable contract — and the dashboard tells you when puppets ignore it.

`puppet-show` is a Claude Code plugin built for the **Maestro + Puppets**
pattern: one orchestrator that delegates work to short-lived, specialized
subagents. It does three things:

1. **Forces every dispatch to carry a contract** — a YAML block embedded in the
   puppet's prompt that declares allowed file scope, allowed tools, and the
   shape of the return.
2. **Validates the puppet's return against that contract** automatically.
   Missing sections, missing evidence citations, anything that deviates from
   what was promised — each one becomes a logged violation with a compliance
   score from 0 to 100.
3. **Shows you all of this** in a live web dashboard and a terminal audit
   command. You can finally tell, at a glance, whether your puppet did what it
   said it would.

Zero external dependencies. SQLite for storage. Single Node 22+ runtime.

## Install

```bash
# inside Claude Code
/plugin marketplace add ErickGCA/puppet-show
/plugin install puppet-show
```

Requires Node.js ≥ 22 (uses the builtin `node:sqlite` module).

## Use

Start the dashboard:

```
/puppet-show:start
```

Open `http://localhost:4711`.

Audit the last N dispatches in the terminal:

```
/puppet-show:audit 20
```

Aggregate view by puppet type and most-reused titles:

```
/puppet-show:history 30
```

Find proven, high-scoring historical contracts to reuse:

```
/puppet-show:suggest audit auth flow
```

Stop the dashboard:

```
/puppet-show:stop
```

## The contract format

The Maestro embeds a YAML block inside the puppet's prompt, between
`---puppet-contract` and `---`:

```
# Role
Security auditor for session lifecycle.

# Goal
Find every code path that keeps a session alive past its TTL.

---puppet-contract
scope_in:  [src/auth/**, middleware/session*]
scope_out: [.env*, src/billing/**]
tools:     [Read, Grep, Glob]
return_format:
  sections: [Did, Findings, OpenQuestions]
  require_evidence: true
---

# Inputs
... briefing continues ...
```

The Skill `briefing` (installed with the plugin) reminds the Maestro of the
format and the rules every time it's about to dispatch.

## What gets validated

At return time, puppet-show checks:

| Check | What it looks for | Violation kind | Weight |
|---|---|---|---|
| Sections | All `return_format.sections` are present (`# Heading` or `**Heading**`) | `section_missing` | 10 |
| Evidence (global) | If `require_evidence: true`, the return cites at least one `path:line` or `[evidence: ...]` tag | `evidence_missing` | 15 |
| Per-finding evidence | If `require_evidence: true` and a `Findings` section exists, every list item must carry its own citation | `findings_evidence_missing` | 8 |
| Section depth | If `return_format.min_words_per_section: N` is set, each required section has at least N words | `section_too_short` | 5 |
| Tools (runtime) | Each tool the puppet uses is in `tools` | `tool_not_allowed` | 30 |
| Scope in (runtime) | Every path touched matches `scope_in` | `scope_in_violated` | 20 |
| Scope out (runtime) | No path touched is in `scope_out` | `scope_out_violated` | 40 |
| Drift | Same `puppet_type::title` ran before with a different contract (informational) | `drift` | 0 |

Each violation has a weight; the score is `100 - Σ weights`, floor 0. Runtime
violations (`scope_*`, `tool_not_allowed`) are validated by
`hooks/puppet-runtime.js` and either logged (warn) or **blocked at the source**
via Claude Code's `{"decision":"block"}` protocol (strict).

## Auto-strict

Some scopes are dangerous by nature (`.env*`, `secrets/`, `migrations/`,
`/production/`, `*.pem`, `credentials*`, etc). When the Maestro writes a
contract that touches one of these and does not explicitly set `enforcement`,
puppet-show promotes it to `strict`. The dashboard shows the `⚐ auto-strict`
badge so you know it happened.

You can also override globally:

```bash
PUPPET_SHOW_ENFORCE=strict  # turn every contract strict
```

## Architecture

```
                        ┌────────────────────────────────────────┐
                        │   MAESTRO                              │
                        │   (your conversation, uses `briefing`) │
                        └──────────────────┬─────────────────────┘
                                           │ Task() with contract
                                           ▼
   PreToolUse:Task ─────────► hooks/puppet-capture.js ─► SQLite (dispatches)
                                                       └► stream.jsonl (SSE fanout)

                                           ▼ puppet runs in isolated context

   PostToolUse:Task ────────► hooks/puppet-capture.js ─► validates return
                                                       └► SQLite (returns, violations)
                                                       └► stream.jsonl (SSE fanout)
                                           ▼
                          dashboard/server.js  ─SSE─►  index.html  (browser)
                          dashboard/cli-audit.js ────► terminal
```

## Configuration

| Variable | Default | What it does |
|---|---|---|
| `PUPPET_SHOW_PORT` | `4711` | Dashboard port |
| `PUPPET_SHOW_DB` | `~/.claude/puppet-show/puppet-show.db` | SQLite database path |
| `PUPPET_SHOW_LOG_DIR` | `~/.claude/puppet-show` | Where `stream.jsonl`, `server.pid`, and `server.log` live |
| `PUPPET_SHOW_ENFORCE` | unset | Set to `strict` to force every contract strict |
| `PUPPET_SHOW_ALERT_BELOW` | `70` | Returns scoring below this are flagged with an `alert` in the stream event and a `⚠` badge in the CLI audit |

## Files

```
puppet-show/
├── .claude-plugin/plugin.json   manifest
├── settings.json                hook registration (PreToolUse:Task + Pre*: file tools + PostToolUse:Task)
├── hooks/
│   ├── puppet-capture.js        Pre/PostToolUse:Task — dispatch capture, return validation, drift detection
│   └── puppet-runtime.js        PreToolUse:Read|Write|Edit|... — runtime scope/tool enforcement
├── lib/
│   ├── contract.js              YAML parser, validators (return + tool), scoring
│   ├── contract.test.js         (18 tests)
│   ├── store.js                 SQLite layer
│   └── store.test.js
├── dashboard/
│   ├── server.js                HTTP + SSE backend
│   ├── start.js                 cross-platform launcher (PID file, idempotent)
│   ├── stop.js                  cross-platform shutdown
│   ├── cli-audit.js             /puppet-show:audit
│   ├── cli-history.js           /puppet-show:history — aggregates by puppet_type, reused titles
│   ├── cli-suggest.js           /puppet-show:suggest — historical high-scoring contracts as templates
│   └── index.html               dashboard UI
├── skills/briefing/SKILL.md     briefing protocol (+ reuse and drift sections)
├── commands/
│   ├── start.md                 /puppet-show:start
│   ├── stop.md                  /puppet-show:stop
│   ├── audit.md                 /puppet-show:audit
│   ├── history.md               /puppet-show:history
│   └── suggest.md               /puppet-show:suggest
├── ROADMAP.md                   project state, design decisions, change log
└── README.md
```

## Roadmap

- **Phase 1:** contract parsing, return validation, score, SQLite, dashboard, CLI audit. ✓
- **Phase 2:** richer evidence parsing — per-finding citations (`findings_evidence_missing`), per-section content checks (`min_words_per_section` → `section_too_short`), alerts (`PUPPET_SHOW_ALERT_BELOW`). ✓
- **Phase 3:** runtime enforcement via `PreToolUse:Read|Write|Edit|Grep|Glob|Bash|WebFetch|NotebookEdit`. Strict contracts **block at the source** via `{"decision":"block"}`; warn contracts log a `runtime` violation and let the call through. Active puppet lookup is by `session_id`, falling back to `cwd + recency` (10-minute window) — this is a heuristic; the README is honest about it. ✓
- **Phase 4:** memory of orchestration — `/puppet-show:history` aggregates by puppet type and surfaces most-reused titles; `/puppet-show:suggest <query>` returns proven high-scoring contracts as reusable templates; drift detection compares each new contract to the last run with the same `puppet_type::title` and flags divergence in scope/tools/sections. ✓

## License

MIT — see [LICENSE](./LICENSE).
