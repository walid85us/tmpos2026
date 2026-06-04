---
name: screenshot tool auth isolation
description: Why the app_preview screenshot tool shows the login page for owner/tenant routes that work in the workspace browser
---

The `app_preview` screenshot tool runs in a **separate headless browser** that does NOT
share the Firebase auth session or the DevSessionSwitcher dev session from the user's
workspace browser. For any gated route (e.g. `/owner/*`), it redirects to `/login` and
only shows the Sign In page + the DEV SESSION panel.

**Why:** auth state lives in the workspace browser's Firebase session / sessionStorage;
the screenshot browser starts fresh with `user: null`.

**How to apply:** Do not treat a login-page screenshot of a gated route as a failure of
your change. To confirm a gated page actually renders, restart the workflow and read the
**workspace** browser console via `refresh_all_logs` (look for `[AccessContext] User doc
found. role: system_owner`) and confirm no Route error after a clean reload. The
screenshot tool cannot click the dev-session buttons, so it cannot reach gated pages.
