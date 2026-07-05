---
description: Re-read the modified files against the project's composed rules and fix major/critical violations.
---

Re-read the files I just modified and check them against this project's composed
coding rules:

@.claude/coding-rules.md

Steps:
1. List the modified files (`git diff --name-only HEAD` + untracked files).
2. For each one, identify the violations, with file, line, broken rule and severity.
3. Directly fix any **major** or **critical** violation (ignore as blocking
   the modules marked WARN-ONLY).
4. End with a summary: what was fixed, and the remaining **minor**/**info** items.

If `.claude/coding-rules.md` is missing, first run `npx coding-rules-resolve`.
Do not invent any violation: base yourself on the real code.
