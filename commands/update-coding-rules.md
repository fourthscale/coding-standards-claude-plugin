---
description: (Re)generate the .claude/coding-rules.md index from coding-rules.config.yml (fetches local/git/npm rule packs).
---

Regenerate this project's coding-rules **index** from
`.claude/coding-rules.config.yml`.

Run the resolver from the project root:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/update-coding-rules.mjs"
```

It reads `coding-rules.config.yml` (in `./` or `./.claude/`), resolves every
`extends` source (local dirs, git repos, npm packages), filters by `select:`,
and writes:

- the index at the configured `output` (default `.claude/coding-rules.md`) —
  one line per selected module, each ending in an `@` reference to it;
- `.claude/rule-packs/` — materialized copies of the selected rules that don't
  already live at a stable path inside the project (git/npm packs), so the
  index can reference them. Rewritten and pruned on every run.

The index deliberately does **not** copy the modules' text: Claude Code loads
each referenced file itself, and dedups it against the `.claude/rules/`
auto-scan, so nothing lands in context twice.

Then:
1. Report the output path and how many modules were indexed (and how many packs
   were materialized or pruned, when the script mentions it).
2. Relay any `warning:` line verbatim — it usually means a rule that `select:`
   excludes still sits under `.claude/rules/`, where Claude Code auto-loads it
   regardless.
3. Surface any error verbatim (missing config, unreachable git/npm source, auth
   failure) — the resolver uses the machine's existing git/npm credentials, so
   an auth error means the developer must log in to that registry/remote.
