# Internal coding rules (behavior)

This project enforces internal coding rules (architecture, security, conventions).
The effective rules for THIS project are **composed** in the file:

@.claude/coding-rules.md

Follow them **while you write code**, not only at the end. If this file is
missing, ask to run `/update-coding-rules` (it generates the composed rules
from `coding-rules.config.yml`).

## Mandatory review before finishing

Before considering a task done, **re-read the modified files** and check them
against `.claude/coding-rules.md`. Fix any **major** or **critical** violation.
Report the **minor** / **info** ones (and ignore as blocking those marked
WARN-ONLY).

> A `Stop` hook will trigger this review automatically if you forget it. It
> re-reviews until the working tree is stable (a pass that changes nothing),
> capped at 3 passes, and never re-fires on a turn that changed nothing.
