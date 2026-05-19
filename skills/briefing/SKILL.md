---
name: briefing
description: Use this skill EVERY TIME the Maestro is about to dispatch a puppet (subagent) via the Task tool. It enforces a structured YAML contract block inside the puppet's prompt — scope_in, scope_out, tools, return_format. The contract is parsed by puppet-show hooks and validated at return time, producing a compliance score per dispatch. Trigger before any Task() call.
---

# Puppet Briefing Protocol — Contract-Bound

Every puppet receives a **contract** (machine-verifiable) and a **briefing**
(human-readable) inside the `prompt` field of the `Task` tool call. The contract
is parsed by puppet-show and validated when the puppet returns. Use this skill
every single time you dispatch a puppet, even one created on the fly.

## The prompt format

```
# Role
<one sentence: who this puppet is for this run>

# Goal
<the single outcome to produce. one sentence, no buts>

---puppet-contract
scope_in:  [path/glob, path/glob]
scope_out: [path/glob, path/glob]
tools:     [Read, Grep, Glob]
enforcement: warn       # or 'strict' — omit to let puppet-show decide
return_format:
  sections: [Did, Findings, OpenQuestions]
  require_evidence: true
---

# Inputs
<paths, IDs, prior decisions paste verbatim — puppets cannot read Maestro history>

# Constraints
<style/quality/security rules; perf budgets; etc.>

# Return format
<re-state the structure for the puppet's benefit; mirror return_format above>
```

The Task tool's `description` field becomes the puppet's headline in the
dashboard. Write a sharp 3-7 word title in sentence case. Bad: "research stuff".
Good: "Audit auth flow for stale sessions".

## Contract fields

- **`scope_in`** — glob patterns the puppet MAY read/edit. Empty = no path
  restriction. Use specific patterns: `src/auth/**`, not `**/*`.
- **`scope_out`** — patterns the puppet MUST NOT touch. Takes precedence over
  scope_in. Always include at least one explicit `scope_out` entry, even
  redundant — it forces deliberate scoping.
- **`tools`** — allowed tools by name (`Read`, `Grep`, `Glob`, `Edit`, `Write`,
  `Bash`, `WebFetch`, etc.). Empty = all tools.
- **`enforcement`** — `warn` (log violations) or `strict` (Phase 3 will block).
  Omit unless overriding. puppet-show auto-promotes to `strict` when scope
  touches `.env*`, `secrets/`, `/infra/`, `/production/`, `*.pem`, `*.key`,
  `credentials*`, `private*key*`, `migrations/`.
- **`return_format.sections`** — required headings in the puppet's return.
  Default `[Did, Findings, OpenQuestions]`.
- **`return_format.require_evidence`** — when `true`, the return must contain
  file:line citations (e.g. `src/auth/login.ts:42`) or `[evidence: ...]` tags.

## Hard rules

1. **Every dispatch has a contract.** No exceptions. Even a 30-second puppet.
2. **scope_out is mandatory** when the puppet touches anything outside `tests/`,
   `docs/`, or a single file the user named explicitly. State at least one
   thing the puppet must not do.
3. **No hidden context.** If a decision came up earlier in your conversation,
   paste it verbatim in `# Inputs`. Puppets start clean — they cannot read your
   history.
4. **One puppet, one goal.** Stacking goals is the #1 cause of low compliance
   scores. Dispatch two puppets instead.
5. **Return format is a contract clause.** When the puppet returns, verify the
   shape matches before integrating. puppet-show flags missing sections and
   missing evidence — read the score before acting.

## Parallel vs sequential

- **Parallel** (multiple Task calls in one message): goals are independent and
  don't read each other's output.
- **Sequential** (one Task, await result, then next): the second puppet needs
  the first puppet's output as input. Use the result text to compose the second
  briefing.

Never spawn a puppet whose briefing is "wait for the other one and then do X".
That coordination is the Maestro's job.

## Example: a tight, contract-bound briefing

```
# Role
Security auditor for session lifecycle.

# Goal
Find every code path that keeps a session alive past its declared TTL.

---puppet-contract
scope_in:  [src/auth/**, middleware/session*]
scope_out: [.env*, src/billing/**, src/admin/**]
tools:     [Read, Grep, Glob]
return_format:
  sections: [Did, Findings, OpenQuestions]
  require_evidence: true
---

# Inputs
TTL constant is SESSION_TTL=3600 in config/auth.ts.
Earlier discussion ruled the /admin/* bypass out of scope for this audit.

# Constraints
Read-only. Do not edit any file.
If you find more than 5 issues, return the top 3 by severity.

# Return format
- Did: bullet list of what you actually inspected (paths, greps run).
- Findings: numbered list; each finding cites file:line.
- OpenQuestions: anything you couldn't determine from the codebase.
```

When this returns, puppet-show will produce a compliance score. 100 means the
puppet honored every clause of the contract. Below 85, read the violations
before trusting the output.

## Reusing proven contracts

Before writing a new contract from scratch, especially for a recurring task,
run `/puppet-show:suggest <short description>` to surface historical
dispatches with the same intent that scored ≥85. Use their `scope_in`,
`scope_out`, `tools`, and `return_format` as your starting point — adjust
only what is genuinely different. Reuse is the cheapest path to high
compliance.

## Drift

When you dispatch a puppet whose `correlation_key` (puppet_type + title)
matches a prior run, puppet-show compares the contracts and flags any
change in scope/tools/sections as a `drift` event. Drift isn't always a
problem — sometimes you genuinely tightened the constraints. But if a
puppet's scope keeps quietly expanding across runs, that's worth noticing.
