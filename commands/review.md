---
description: Review changed code against the composed rules. Optional arg — a `base[...target]` range (target defaults to HEAD; use `...local` to include uncommitted work).
---

Review code against this project's composed coding rules:

@.claude/coding-rules.md

## Scope — parse the range from `$ARGUMENTS`

`$ARGUMENTS` is an optional `base[...target]` range:
- `base` = any git ref (branch, tag, or commit SHA).
- `target` = optional; defaults to `HEAD`. Special value `local` = the working
  tree (includes uncommitted + untracked). Otherwise it's another ref/commit.

Resolve the scope like this:

**Empty** → review local uncommitted work only. (Equivalent to `HEAD...local`,
since `merge-base HEAD HEAD` is `HEAD` — the empty case is just a shorthand.)
```
git diff --name-only HEAD
git ls-files --others --exclude-standard
```

**`base` (no `...`)** → alias for `base...HEAD`. **`base...HEAD`** or
**`base...<ref>`** → the branch/range diff (three-dot: from the merge-base of the
two refs to `target`). Committed changes only.
```
git rev-parse --verify --quiet "<base>^{commit}"     # bail with a clear message if this fails
git rev-parse --verify --quiet "<target>^{commit}"   # (skip when target is HEAD)
git diff --name-only "<base>"..."<target>"
git diff "<base>"..."<target>" -- <file>             # actual hunks per file
```

**`base...local`** → the same merge-base anchor, but ending at the **working
tree** — i.e. the branch diff **plus** uncommitted (staged, unstaged) and
untracked files.
```
git rev-parse --verify --quiet "<base>^{commit}"
BASE=$(git merge-base "<base>" HEAD)
git diff --name-only "$BASE"
git ls-files --others --exclude-standard
git diff "$BASE" -- <file>                           # actual hunks per file
```

Notes:
- Treat `base` (and a non-`local` `target`) as single git refs. If either doesn't
  resolve, stop and say so — don't guess.
- Untracked files only matter when the scope reaches the working tree (empty arg,
  or `...local`); ignore them for commit-to-commit ranges.

## Steps

1. List the files in scope (per the range above).
2. For each, inspect the **actual changes** (`git diff <range> -- <file>`), reading
   enough surrounding context to judge. Identify violations: file, line, broken
   rule, severity.
3. Directly fix any **major** or **critical** violation (ignore as blocking the
   modules marked WARN-ONLY).
4. End with a summary: what was fixed, and the remaining **minor** / **info** items.

If `.claude/coding-rules.md` is missing, first run `/update-coding-rules`.
Do not invent any violation: base yourself on the real code.
