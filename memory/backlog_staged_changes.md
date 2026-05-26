---
name: backlog-staged-changes
description: Staged changes commit pattern for scheduler-affecting edits, with single cache invalidation on apply
metadata:
  type: project
---

Changes to clocks, calendar, shows, and anything that affects the scheduler should be staged rather than applied immediately. The operator reviews all pending changes in the UI and applies them in one commit. On commit: changes are written + L1 budget cache is invalidated.

**Why:** Prevents partial state where the cache and the data are inconsistent. Gives operators a review step before a clock change ripples into the live schedule. Makes cache invalidation deterministic (one event: "changes committed") rather than per-save.

**How to apply:** Design this after the SpotBudgetService is in place. The budget service starts with an explicit invalidation hook on save of clocks, calendar entries, and campaigns. The staged-commit architecture wraps around that later. The "run template" action is a related pattern and can inform the design.
