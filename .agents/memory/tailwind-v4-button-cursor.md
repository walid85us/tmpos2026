---
name: Tailwind v4 button cursor
description: Tailwind v4 dropped the default cursor:pointer on <button>; clickable controls feel dead without an explicit class
---

Tailwind v4 changed the Preflight base so native `<button>` no longer gets `cursor: pointer`. Any custom button/tab/card/chip used as a clickable control now feels unclickable unless you add `cursor-pointer` explicitly.

**Why:** A QA HOLD ("tabs feel unclickable") in this project was purely this — the click handler worked; only the affordance was missing.

**How to apply:** When adding or reviewing interactive `<button>`-based controls (tabs, posture/stat cards, filter chips, modal Cancel/Confirm), include `cursor-pointer`. For disabled states use `cursor-not-allowed`. Don't assume the handler is broken when a control "feels dead" — check the cursor first.
