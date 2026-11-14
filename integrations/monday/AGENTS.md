# Refreshing Monday.com in VoiceOS for testing

Verified on macOS with VoiceOS 0.1.38 on 2026-11-09.

## Important: source, installed copy, and cached manifest

- Source worktree: `/Users/duc/Documents/Agentic/voiceos-monday/integrations/monday`.
- Installed runtime: `~/Library/Application Support/VoiceOS/custom-mcps/composio-monday/`.
- Host configuration: `~/Library/Application Support/VoiceOS/config.json`.
- The app runs the **installed** `server.ts`, not the worktree or `dist/server.js`.
- Restarting alone does not refresh the installed files or the cached tool catalog.
- New tools/schema/UI definitions require updating both the installed manifest and
  `installedIntegrations[].manifest`. Keep the matching
  `customMcpServers[].confirmTools` in sync with manifest confirmation definitions.

Existing general guidance lives in `../posthog/AGENTS.md` (Reload/reinstall UI)
and `../asana/handoff.md` (manifest cache and Electron launch environment).
This guide records the programmatic refresh actually used for Monday.

## Procedure

1. Finish tests and rebuild in the **Monday worktree**. Bun is available inside
   VoiceOS even when `bun` is missing from the shell PATH:

   ```sh
   /Applications/VoiceOS.app/Contents/Resources/bun-runtime/bun test
   PATH="/Applications/VoiceOS.app/Contents/Resources/bun-runtime:$PATH" /Applications/VoiceOS.app/Contents/Resources/bun-runtime/bun run build
   ```

2. Quit VoiceOS before changing its config; a running instance can overwrite edits:

   ```sh
   osascript -e 'tell application "VoiceOS" to quit'
   pgrep -fl '^/Applications/VoiceOS.app/Contents/MacOS/VoiceOS$'
   ```

   Wait until the process check returns no match.

3. Back up the config and replaced files, copy the current source, and refresh
   only Monday's cached manifest/confirmation names. The following Python recipe
   preserves setup values, server identity, enabled state, and other integrations.
   Run it with Python 3 (or save it to a temporary script and execute that):

   ```python
   import datetime, hashlib, json, os, shutil, subprocess
   from pathlib import Path

   source = Path('/Users/duc/Documents/Agentic/voiceos-monday/integrations/monday')
   root = Path.home() / 'Library/Application Support/VoiceOS'
   config_path = root / 'config.json'
   assert subprocess.run(
       ['pgrep', '-f', '^/Applications/VoiceOS.app/Contents/MacOS/VoiceOS$'],
       capture_output=True,
   ).returncode == 1, 'VoiceOS must be stopped'
   config = json.loads(config_path.read_text())
   manifest = json.loads((source / 'voiceos.integration.json').read_text())
   matches = [e for e in config['installedIntegrations']
              if e['manifest']['id'] == manifest['id']]
   assert len(matches) == 1
   entry = matches[0]
   target = Path(entry['dirPath'])
   assert target == root / 'custom-mcps/composio-monday'
   servers = [s for s in config['customMcpServers'] if s['id'] == entry['serverId']]
   assert len(servers) == 1 and Path(servers[0]['cwd']) == target
   auth = target / '.composio-auth.json'
   auth_hash = hashlib.sha256(auth.read_bytes()).hexdigest()
   backup = root / ('monday-refresh-backup-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
   backup.mkdir(mode=0o700)
   shutil.copy2(config_path, backup / 'config.json')
   os.chmod(backup / 'config.json', 0o600)
   files = ['server.ts', 'voiceos.integration.json', 'package.json', 'README.md']
   for name in files:
       shutil.copy2(target / name, backup / name)
       shutil.copy2(source / name, target / name)
   entry['manifest'] = manifest
   servers[0]['confirmTools'] = [t['name'] for t in manifest['tools'] if t.get('confirmation')]
   temporary = root / 'config.monday-refresh.tmp'
   temporary.write_text(json.dumps(config, indent=2) + '\n')
   os.chmod(temporary, 0o600)
   temporary.replace(config_path)
   assert hashlib.sha256(auth.read_bytes()).hexdigest() == auth_hash
   assert all((source / n).read_bytes() == (target / n).read_bytes() for n in files)
   print('Refreshed tools:', [t['name'] for t in manifest['tools']])
   print('Backup:', backup)
   ```

   Do not replace `.composio-auth.json`, local `.env` files, or config credentials
   with worktree/test fixtures. Do not print the complete config: it contains keys
   and login tokens. If dependencies changed, also sync `bun.lock` and install
   dependencies in the installed directory before reopening. Add any new runtime
   modules/assets to the explicit copy list.

4. Reopen with Electron's Node-mode environment variable unset:

   ```sh
   env -u ELECTRON_RUN_AS_NODE open -a /Applications/VoiceOS.app
   pgrep -fl '^/Applications/VoiceOS.app/Contents/MacOS/VoiceOS$|bun /Users/duc/Library/Application Support/VoiceOS/custom-mcps/composio-monday/server.ts'
   ```

5. Verify a new app process and installed Monday MCP process appear. An MCP
   `listTools` request against the installed `server.ts` should currently return
   `connect_account`, `connection_status`, `disconnect_account`, `get_boards`,
   `get_items`, `prepare_create_item`, `create_item`, `prepare_update_item`,
   `update_item_values`, `get_comments`, `prepare_comment`, `create_comment`,
   `edit_comment`, `delete_comment`,
   `prepare_create_board`, `create_board`, `prepare_create_group`, `create_group`,
   `prepare_archive_board`, `archive_board`, `prepare_delete_board`, `delete_board`,
   `list_board_members`, `prepare_manage_users`, and `manage_users`.
   Tool discovery needs no Composio key and makes no provider calls.
   Update that expected list as subsequent passes add approved tools.

6. **Tell the user immediately when the refresh is ready**, then let them test:
   “Show my Monday boards,” followed by an item read on a returned board ID.
   Process startup/tool discovery verify deployment, not live provider success
   or rendered VoiceOS cards.

For rollback, quit VoiceOS, restore the config and replaced files from the printed
backup, and reopen. Backups contain credentials; keep them local and out of Git.

## Accessing the macOS agent island for integration testing

The island is a separate Electron window titled **VoiceOS Agent**. Its renderer
URL ends in `#/agent-notch`. When the island is collapsed, macOS accessibility
may show only the window and its HTML container. The packaged app disables
the in-window Developer Tools, but supports a loopback Chromium DevTools
Protocol (CDP) connection. This also works for integrations other than Monday.

1. Check `http://127.0.0.1:9227/json/list` for an existing page target ending in
   `#/agent-notch`. If it exists, reuse it. Otherwise, when the user has
   requested debug access, fully quit VoiceOS and relaunch it:

   ```sh
   env -u ELECTRON_RUN_AS_NODE open -a /Applications/VoiceOS.app --args \
     --remote-debugging-address=127.0.0.1 --remote-debugging-port=9227
   curl -fsS --max-time 3 http://127.0.0.1:9227/json/list
   lsof -nP -iTCP:9227 -sTCP:LISTEN
   ```

   Verify the listener is on loopback and select the exact `#/agent-notch`
   page. Use that page's `webSocketDebuggerUrl` for CDP. The main window and
   the island history window have different routes. Quitting VoiceOS and
   launching without the flags closes debug access. While it is enabled,
   other local processes can inspect and control the app.

2. Before submitting a test prompt, check the live VoiceOS integration registry
   (`window.api.customMcp.list()` and `getTools(server.id)`) for the connected
   integration and expected tool. The island can be ready before its tools
   finish loading.
3. The Todoist test opened the composer by reading the current bounds of
   `[data-agent-notch-geometry-key]` in the island renderer and dispatching a
   mouse press and release inside those bounds. It verified that a textarea
   had focus, preserved any existing draft, and submitted through the normal
   Enter handler. An expanded result can collapse on the first click. Read
   the bounds again before reopening the composer.
4. Subscribe to turn and completion events before submission. Capture the
   result while the panel is visible so a later collapse does not lose it.
   Capture the rendered card separately when testing appearance. Leave any
   confirmation for the user to review in VoiceOS.

The earlier **Open VoiceOS from the Island** chat in the Agentic AI project
verified composer input and response capture with Todoist. Its
`voiceos-control/read-agent.cjs` helper is a reference implementation with a
Todoist-specific readiness check. For Monday, use the matching Monday server
and tool in that check. On 2026-11-10, a fresh debug launch was verified to
expose one `#/agent-notch` target with the listener bound to `127.0.0.1:9227`.

### Prompting through the island

Run live acceptance tests through the desktop notch's composer or microphone.
Use its visible confirmation and result cards for the test. A direct MCP call
can diagnose provider behavior, and the Codex Monday.com connector can verify
the resulting board state independently. Record those checks separately from
what was observed in the notch.

Write live test prompts the way a user would speak or type. Refer to boards,
items, and people by their visible names or natural descriptions. For example,
say “Add a task called Review the draft to the Voiceos test board” or “What’s on
the Voiceos board?” Keep product IDs, MCP tool names, argument names, and
instructions about which integration calls to make out of the prompt. Use IDs
in direct MCP tests and to verify results after a live test.

Include vague requests in the test cases. Check that VoiceOS resolves a clear
match on its own, asks a focused question when the target is ambiguous, and
waits for the answer before writing. Supplying the answer or an ID in the
initial prompt skips the behavior these tests are meant to cover.
