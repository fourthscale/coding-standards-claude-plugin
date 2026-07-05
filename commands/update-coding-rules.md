---
description: (Re)generate .claude/coding-rules.md from coding-rules.config.yml (fetches local/git/npm rule packs).
---

Regenerate this project's **composed** coding rules from
`.claude/coding-rules.config.yml`.

Run the resolver from the project root:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/update-coding-rules.mjs"
```

It reads `coding-rules.config.yml` (in `./` or `./.claude/`), resolves every
`extends` source (local dirs, git repos, npm packages), filters by `select:`,
and writes the composed file to the configured `output` (default
`.claude/coding-rules.md`).

Then:
1. Report the output path and how many rule files were composed.
2. If it prints "Installing resolver dependencies (first run)…", that's expected
   the first time — it installs `js-yaml` in the plugin directory.
3. Surface any error verbatim (missing config, unreachable git/npm source, auth
   failure) — the resolver uses the machine's existing git/npm credentials, so
   an auth error means the developer must log in to that registry/remote.
