# Dropbox 2.0.16 live QA

The 14 Dropbox file actions were exercised on earlier Windows builds. Version 2.0.16 adds account tools and changes upload confirmation and local file access. These need targeted live checks after republishing; the 98 passing offline tests do not prove VoiceOS host behavior. One Windows symlink test was skipped because creating a file symlink requires a privilege unavailable in this environment; path resolution and Mac/Windows path rules were tested separately.

1. Install fresh from the share link. Save the Composio API key; leave the optional manual account ID blank. Confirm the first-launch log says version 2.0.16, `14 approved tools`, and `Connected — discovered 17 tools`. Run `node scripts/verify-install-log.mjs <first-launch-log>` against that log.
2. Ask “Connect my Dropbox account.” First press **Cancel** and verify the integration log has no `connect_account` call. Repeat, approve, complete OAuth in the browser, then ask “Check my Dropbox connection status.” Verify Connected appears in a plain card without account action buttons.
3. Ask “Disconnect my Dropbox account.” First press **Cancel** and verify the account still works and no `disconnect_account` call appears. Repeat, approve, and verify status says Disconnected. Reconnect for remaining tests. Do not delete a real account's Dropbox files.
4. Put a disposable Word file in your home Downloads folder. Ask to upload it to a new Dropbox path. Verify the confirmation shows the full source path and an Add/Overwrite dropdown. Cancel, then repeat and approve. Confirm the file content in Dropbox. A path under the repository or AppData should be rejected before staging.
5. List revisions. Verify the card shows readable dates without raw revision IDs or ISO timestamps; the agent must still receive the revision IDs for restore.

Mac and Windows VoiceOS QA should also verify Cancel sends no tool request and edits on a confirmation card reach the tool. This document records required checks, not claims that they already passed.
