---
description: Review changed code against the project's coding rules. Reports violations by default; add `fix` to also apply fixes. Optional range `base[...target]` (omitted target = working tree).
---

Review code against this project's coding rules. The index below lists every
rule module in force and pulls each one into context:

@.claude/coding-rules.md

## Mode — report (default) or fix

Scan `$ARGUMENTS` for a `fix` token (case-insensitive):
- **present** → **fix mode**: apply fixes for major/critical violations.
- **absent** → **report mode (default)**: list violations only, and **do not edit
  any file**.

Then remove the `fix` token from `$ARGUMENTS`; whatever text remains is the range
used below (empty = local working changes).

## Scope — resolve the range with this exact procedure

The range is `$ARGUMENTS` with the `fix` token removed: an optional
`base[...target]`. Follow the steps in order; do not improvise or silently fall
back to a different scope.

**Step 1 — empty argument.** Review local uncommitted work and stop choosing:
```
git diff --name-only HEAD
git ls-files --others --exclude-standard
```

**Step 2 — split on `...`.**
- `base`   = the text before `...` (or the whole value when there is no `...`).
- `target` = the text after `...`, or **`local`** when there is no `...` (an
  omitted target always defaults to the working tree — consistent with bare
  `/review`). Use `...HEAD` explicitly to review committed changes only.

**Step 3 — `local` is a keyword, NOT a git ref.** If `target` is the literal word
`local`, it means "the working tree" (committed branch changes + staged + unstaged
+ untracked). **Never** pass `local` to `git rev-parse` or `git diff` as a ref.

**Step 4 — validate the real refs.** Verify `base`. Verify `target` too, UNLESS
it is `HEAD` or `local`:
```
git rev-parse --verify --quiet "<base>^{commit}"     # required
git rev-parse --verify --quiet "<target>^{commit}"   # only if target is not HEAD and not local
```
If a ref does not resolve, **STOP and report it exactly** — do not review a
different scope instead.

**Step 5 — build the diff.**
- If `target` is `local`:
  ```
  BASE=$(git merge-base "<base>" HEAD)
  git diff --name-only "$BASE"
  git ls-files --others --exclude-standard
  git diff "$BASE" -- <file>                          # hunks per file
  ```
- Otherwise (`HEAD`, a branch, a tag, or a commit):
  ```
  git diff --name-only "<base>"..."<target>"
  git diff "<base>"..."<target>" -- <file>            # hunks per file
  ```

Quick reference (an omitted target defaults to `local`): `/review` = `HEAD...local`
· `/review main` = `main...local` (branch changes **+** uncommitted) ·
`/review main...HEAD` = committed branch diff only · `/review a1b2...c3d4` =
between two commits. Untracked files matter only when the scope reaches the
working tree (i.e. whenever `target` is `local`).

## Steps

1. List the files in scope (per the range above).
2. For each, inspect the **actual changes** (`git diff <range> -- <file>`), reading
   enough surrounding context to judge. Identify violations: file, line, broken
   rule, severity.
3. Handle violations according to the mode:
   - **Report mode (default):** do **not** modify any file — only collect the
     findings.
   - **Fix mode (`fix`):** directly fix every **major** or **critical** violation
     (ignore as blocking the modules marked WARN-ONLY); leave minor/info as-is.
4. End with a summary:
   - **Report mode:** list all findings grouped by severity, each with `file:line`
     and the broken rule. Mention that re-running with `fix` would apply the
     major/critical fixes. Change no code.
   - **Fix mode:** what was fixed, and the remaining **minor** / **info** items.

If `.claude/coding-rules.md` is missing, first run `/update-coding-rules`.
If a module it references is missing, run it again — the index and
`.claude/rule-packs/` are regenerated together.
Do not invent any violation: base yourself on the real code.
