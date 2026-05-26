---
name: Don't use Playwright for visual/text changes
description: User doesn't want Playwright launched for things that don't require browser interaction to verify
type: feedback
---

Don't use Playwright for verifying CSS/text color changes, layout tweaks, or any change where reading the diff is sufficient. Playwright should only be used when actual interaction (clicks, form fills, navigation flows) is needed to confirm behavior.

**Why:** Playwright is slow and unnecessary overhead for purely visual changes — just look at the code.

**How to apply:** Before launching Playwright, ask: "do I need to click something or observe a runtime behavior, or can I confirm this by reading the code?" If the latter, skip it.
