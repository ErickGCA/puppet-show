---
description: Find proven high-scoring contracts that match a query, to reuse as templates
argument-hint: <query>
---

Run this when the user is about to dispatch a puppet and you want to see
if a similar one was done well before. The query matches against title
and puppet_type:

```
node ${CLAUDE_PLUGIN_ROOT}/dashboard/cli-suggest.js ${ARGUMENTS}
```

If a suggestion comes back, use its `scope_in`, `scope_out`, `tools`, and
`return_format` as the starting point for the new contract. Adjust only
what is genuinely different about the new task.
