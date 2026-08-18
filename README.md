# coding-standards-claude-plugin

A Claude Code plugin that enforces your project's coding rules while developers
work — **self-contained**, with a **zero-token, no-network** guardrail.

It does three things:

- **Compose** — `/update-coding-rules` resolves the rule packs you declare
  (local dirs, git repos, npm packages) into `.claude/coding-rules.md`, an
  **index** of the selected modules that references each one with `@`.
- **Prevention** — your `CLAUDE.md` imports that index, so Claude Code has the
  rules in context from the start.
- **Guarantee** — a `Stop` hook forces a review before Claude Code finishes a
  task: if code changed, it blocks and asks Claude to re-check the changes
  against the indexed modules and fix. It reviews until the tree is stable
  (max 3 passes), and never re-fires when nothing changed.

The plugin ships **no rules of its own** — you declare them in your project.

### Why an index and not one big file

Claude Code already loads every `.md` under `.claude/rules/` as project
instructions, recursively. A composed file that **copied** those bodies put the
same text in context twice — on a real repo, 37 KB of composed file on top of
23 KB of sources, ~5.8k tokens of pure duplication per session.

So the composed file lists the modules instead of copying them, and pulls each
one in with an `@` reference. Claude Code dedups imports against the
`.claude/rules/` auto-scan by absolute path, and processes `CLAUDE.md` (and its
imports) **before** that scan — so every module lands in context exactly once,
whichever way it got there. Same rules in context, ~19 KB less per session on
that repo.

`@` references only work for stable paths inside the project, so rules that live
outside it (git/npm packs, cached under sha-named, gitignored directories) are
**materialized** into `.claude/rule-packs/` first — see below.

## Install

```
/plugin marketplace add git@github.com:fourthscale/coding-standards-claude-plugin.git
/plugin install coding-standards@fourthscale-standards
```

The repo is its own marketplace: `.claude-plugin/marketplace.json` lists the
plugin with `source: "./"` (the plugin lives at the repo root).

## Setup — what to put in your project

Everything lives under `.claude/` in the project you want to enforce.

### 1. Declare your rules — `.claude/coding-rules.config.yml`

```yaml
# Ordered list of rule-pack sources. On conflict (same rule id), the LAST wins.
extends:
  - "./rules"                       # local: a path (string) to a dir of .md rule files
  - git:  github.com/acme/std-rules # git repo
    ref:  v1.2.0                     #   branch / tag / commit (default branch if omitted)
    path: rules                      #   sub-dir inside the repo (optional)
    include: ["security/*.md"]       #   glob filter, relative to root/path (optional)
  - npm:  "@acme/coding-rules"       # npm package
    version: "^1.3.0"                #   semver range (optional)
    path: rules                      #   sub-dir inside the package (optional)

# Whitelist by the rule's `category`. Categories not listed here are dropped.
select:
  archi: all           # all       → enforced normally (major/critical block)
  security: all
  conventions: warn-only  # warn-only → indexed and reported, never blocks

# Optional: prepended to the index, useful context for Claude.
projectContext: |
  Acme e-commerce. Node + Express. New code uses the resources/<domain>/ layout.

# Where the index is written (default: ./coding-rules.md, i.e. .claude/).
output: "./coding-rules.md"
```

Paths and `output` are relative to the config file's directory (`.claude/`).
Auth for private git/npm sources uses the machine's existing credentials
(`git` remotes, `.npmrc`) — the plugin stores nothing.

### 2. Write rule packs (or point at remote ones)

A rule file is markdown with YAML frontmatter. One file = one `category`;
several files may share a category. `id` is the unique key used for "last wins".

```markdown
---
id: project-gotchas
category: gotchas
title: Critical gotchas
---

# Critical gotchas — DO NOT

## Middleware order in app.js
- The middleware sequence is load-bearing; add new middleware at the end.
- Severity: **critical**.
```

Severity is per section (`- Severity: **critical|major|minor|info**.`). The
`Stop` hook fixes **major**/**critical**, reports **minor**/**info**, and treats
anything under a `WARN-ONLY` module as non-blocking. `title` and the WARN-ONLY
flag are surfaced on the module's line in the index.

### 3. Import the index — project `CLAUDE.md`

```markdown
@.claude/coding-rules.md
```

(See this repo's own `CLAUDE.md` for the recommended wording, including the
"mandatory review before finishing" note.)

### 4. Generate the index

```
/update-coding-rules
```

This resolves every `extends` source and writes two things:

- `.claude/coding-rules.md` — the index: one line per selected module (title,
  id, category, pack, `WARN-ONLY`) ending in an `@` reference to it.
- `.claude/rule-packs/` — **generated**: a copy of every selected rule that does
  not already sit at a stable path inside the project (git and npm packs). The
  directory is rewritten and pruned on every run, so it matches the selection
  exactly; the script refuses to touch it if its
  `.generated-by-coding-standards` marker is missing.

Run it again whenever the config or a local rule changes, or to pull newer
remote packs. **Versioning these two is your project's choice** — but treat them
the same way, since the index points into the packs directory:

- **commit both** → rule changes show up in PRs; a fresh clone has the rules
  without a resolver run (e.g. in CI).
- **gitignore both** → run `/update-coding-rules` wherever the rules are needed.

`.claude/.coding-rules-cache/` (the raw git/npm checkouts) should always stay
gitignored.

### What `select:` can and cannot exclude

`select:` decides what goes into the index and what gets materialized. It
**cannot** keep a file out of the context if that file sits under
`.claude/rules/`, because Claude Code auto-loads that directory whatever the
config says. The resolver prints a warning naming any such file — move it
outside `.claude/rules/` (e.g. `.claude/rule-sources/`) and the index becomes the
only thing deciding what is loaded.

## Contents

- **`/update-coding-rules`** — writes the `.claude/coding-rules.md` index from
  the config's `extends` sources (local / git / npm), materializing the
  out-of-project ones into `.claude/rule-packs/`.
- **`/review [base[...target]] [fix]`** — reviews changed code against
  `.claude/coding-rules.md`. **Reports** major/critical violations by default; add
  the `fix` keyword to also apply the fixes (e.g. `/review main fix`). An omitted
  `target` defaults to `local` (the working tree), so the scopes are:
  - `/review` — local uncommitted work (`HEAD...local`).
  - `/review main` — the whole branch vs `main`, **including** your uncommitted +
    untracked work (`main...local`).
  - `/review main...HEAD` — committed branch changes only (PR-style, from the
    merge-base).
  - `/review <a>...<b>` — any range between two refs/commits (e.g.
    `abc123...def456`).
- **Stop hook** — guarantees a review runs before a task ends; reviews until the
  working tree is stable (max 3 passes) and skips turns that changed nothing.
  It ignores its own generated artifacts (`.claude/coding-rules.md`,
  `.claude/rule-packs/`), so regenerating them never triggers a review.

## Layout

```
.
├── .claude-plugin/
│   ├── plugin.json         the plugin manifest
│   └── marketplace.json    catalog (source: "./")
├── CLAUDE.md               rules in context + mandatory-review instruction
├── commands/
│   ├── review.md           /review — manual review against the indexed modules
│   └── update-coding-rules.md  /update-coding-rules — build the index
├── hooks/hooks.json        wires the Stop hook
└── scripts/
    ├── stop-review-hook.mjs    the guardrail (no token, no network, no deps)
    ├── update-coding-rules.mjs the resolver (build-time; git/npm allowed)
    └── vendor/js-yaml.mjs      vendored YAML parser (no npm install needed)
```

And in a project that uses it:

```
.claude/
├── coding-rules.config.yml   what you declare
├── rules/                    your own rule modules (auto-loaded by Claude Code)
├── coding-rules.md           GENERATED — the index
├── rule-packs/               GENERATED — materialized git/npm packs
└── .coding-rules-cache/      raw git/npm checkouts (gitignore this)
```

The `Stop` hook stays dependency-free, offline and token-free. Only the resolver
touches the network (to fetch git/npm packs), and its one library (js-yaml) is
**vendored** as a single file — so the plugin needs no `npm install`.

## Versioning

Bump `version` in both `.claude-plugin/plugin.json` and the entry in
`.claude-plugin/marketplace.json`, commit, tag, push. Developers update with
`/plugin marketplace update` then `/plugin update`.
