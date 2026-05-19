---
description: Start the puppet-show dashboard at http://localhost:4711
---

Run this:

```
node ${CLAUDE_PLUGIN_ROOT}/dashboard/start.js
```

The launcher is idempotent — if the dashboard is already running, it just
reports the existing process. Then tell the user the dashboard is up and
remind them to open the URL.
