# Internal coding rules (behavior)

This project enforces internal coding rules (architecture, security, conventions).
The effective rules for THIS project are **composed** in the file:

@.claude/coding-rules.md

Follow them **while you write code**, not only at the end. If this file is
missing, ask to run `npx coding-rules-resolve` (it generates the composed rules
from `coding-rules.config.yml`).

## Mandatory review before finishing

Before considering a task done, **re-read the modified files** and check them
against `.claude/coding-rules.md`. Fix any **major** or **critical** violation.
Report the **minor** / **info** ones (and ignore as blocking those marked
WARN-ONLY).

> A `Stop` hook will trigger this review automatically if you forget it —
> only once per task (no loop).
