# Review status: Microsoft Excel

Current build: `excel-review-fixed-v5-collections`. SDK pinned to 0.27.0;
default toolkit version `20261029_00`. These current notes supersede historical
v2/v4 pending-live statements in the handoff.

## Completed

- Author confirmed fresh live testing of all six writes after the v5 fixes;
  see LIVE-QA.md for the attestation and limits.
- Write timeouts report outcome unknown and require inspecting Excel before
  retrying. Writes are not retried automatically.
- Current SDK only; no deprecated v1 REST execution or alternate SDK fallbacks.
- Fixed per-action field mapping with fetched schema validation, not alias guessing.
- Account lookup fails closed on missing ownership, wrong owner, wrong toolkit,
  wrong ID, inactive status, or retrieval failure.
- Regression checks run only in bun test, not on startup.
- Cached Studio identifiers sanitized; preview arguments use Setup defaults.
- Current build marker replaces the original manual-account-restored marker.
- 132 offline tests and ten-tool MCP discovery are the automated checks.

## Manual setup decision

Dario approved temporary manual API-key/User-ID/Connected-Account-ID setup for
v1 QA. Syafino noted Todoist's native OAuth flow. Account linking remains a
production follow-up to coordinate with the VoiceOS team. This integration does
not claim to implement native linking or claim that linking is impossible.

## Separate QA still needed

Cancellation, fresh share-link installation, expired/revoked access, and actual
auth-config scopes need their own verification. The six live write successes do
not establish these additional criteria.

## Export consistency

The selected export is microsoft-excel-643af91a. Its working v5 runtime matched
the repository, but Studio had regenerated package.json with latest. Restore the
exact SDK pin and lockfile after every export, and run tests before deployment.
GitHub updates alone do not republish VoiceOS hosting.
