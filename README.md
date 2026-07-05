# coding-standards-claude-plugin

A Claude Code plugin that enforces your project's coding rules while developers
work — **self-contained**, with a **zero-token, no-network** guardrail.

It does three things:

- **Compose** — `/update-coding-rules` resolves the rule packs you declare
  (local dirs, git repos, npm packages) into a single `.claude/coding-rules.md`.
- **Prevention** — the plugin's `CLAUDE.md` imports that composed file so Claude
  Code has the rules in context from the start.
- **Guarantee** — a `Stop` hook forces a review before Claude Code finishes a
  task: it re-reads the composed rules and, if code changed, blocks and asks
  Claude to re-check and fix. It reviews until the tree is stable (max 3 passes),
  and never re-fires when nothing changed.

The plugin ships **no rules of its own** — you declare them in your project.

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
  conventions: warn-only  # warn-only → composed but reported, never blocks

# Optional: prepended to the composed file, useful context for Claude.
projectContext: |
  Acme e-commerce. Node + Express. New code uses the resources/<domain>/ layout.

# Where the composed file is written (default: ./coding-rules.md, i.e. .claude/).
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
anything under a `WARN-ONLY` module as non-blocking.

### 3. Import the composed rules — project `CLAUDE.md`

```markdown
@.claude/coding-rules.md
```

(See this repo's own `CLAUDE.md` for the recommended wording, including the
"mandatory review before finishing" note.)

### 4. Generate the composed file

```
/update-coding-rules
```

This resolves every `extends` source and writes `.claude/coding-rules.md`. Run
it again whenever the config or a local rule changes, or to pull newer remote
packs. **Versioning `.claude/coding-rules.md` is your project's choice** — the
plugin reads it either way:

- **commit it** → rule changes show up in PRs; no resolver run needed just to
  read the rules (e.g. in CI).
- **gitignore it** → run `/update-coding-rules` wherever the rules are needed.

## Contents

- **`/update-coding-rules`** — composes `.claude/coding-rules.md` from the
  config's `extends` sources (local / git / npm).
- **`/review`** — re-reads changed files against `.claude/coding-rules.md` and
  fixes major/critical violations.
- **Stop hook** — guarantees a review runs before a task ends; reviews until the
  working tree is stable (max 3 passes) and skips turns that changed nothing.

## Layout

```
.
├── .claude-plugin/
│   ├── plugin.json         the plugin manifest
│   └── marketplace.json    catalog (source: "./")
├── CLAUDE.md               rules in context + mandatory-review instruction
├── commands/
│   ├── review.md           /review — manual review against the composed rules
│   └── update-coding-rules.md  /update-coding-rules — compose the rules
├── hooks/hooks.json        wires the Stop hook
└── scripts/
    ├── stop-review-hook.mjs    the guardrail (no token, no network, no deps)
    ├── update-coding-rules.mjs the resolver (build-time; git/npm allowed)
    └── vendor/js-yaml.mjs      vendored YAML parser (no npm install needed)
```

The `Stop` hook stays dependency-free, offline and token-free. Only the resolver
touches the network (to fetch git/npm packs), and its one library (js-yaml) is
**vendored** as a single file — so the plugin needs no `npm install`.

## Versioning

Bump `version` in both `.claude-plugin/plugin.json` and the entry in
`.claude-plugin/marketplace.json`, commit, tag, push. Developers update with
`/plugin marketplace update` then `/plugin update`.
