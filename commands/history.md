---
description: Show per-puppet-type aggregates and most-reused titles
argument-hint: [days]
---

Run this to see how puppets have been performing over time. Argument is
the lookback window in days (default 30):

```
node ${CLAUDE_PLUGIN_ROOT}/dashboard/cli-history.js ${ARGUMENTS}
```

After reading the output, point out: the worst-performing puppet type by
average score, and the most-reused title whose average is below 85
(candidate for refactoring the briefing).
