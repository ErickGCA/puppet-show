---
description: Show the last N puppet dispatches with compliance scores, in the terminal
argument-hint: [count]
---

Run this to print a terminal-readable summary of the most recent puppet
dispatches. Argument is the number of dispatches to show (default 10):

```
node ${CLAUDE_PLUGIN_ROOT}/dashboard/cli-audit.js ${ARGUMENTS}
```

(Default count is 10 when no argument is given — handled inside the script.)

Then read the output and call out the lowest-scoring dispatch and what
violation it had. If everything is at 100, congratulate the user briefly.
