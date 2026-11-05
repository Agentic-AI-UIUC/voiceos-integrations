# Todoist integration — 1.0.10

## Platform and setup

This integration supports macOS only (`supportedPlatforms: ["darwin"]`).
The bundled `run.cmd` launcher does not imply Windows support; browser authorization
currently uses macOS’s `/usr/bin/open`.

Enter `COMPOSIO_API_KEY` in VoiceOS’s Todoist integration settings. `.env.example`
documents the required key; the server reads the environment variable supplied by
its host and does not automatically load `.env` files.

## Tools

- Connect Todoist
- Todoist account (status, Connect/Disconnect/Refresh controls)
- Disconnect Todoist
- Create task
- Update task
- Close task (recurring tasks advance to their next occurrence)
- Get active tasks (filters, task IDs, pagination)
- Create project
- Delete project
- Create section
- Delete section
- List labels (`list_labels`, read-only)
- Create label
- Update label
- Delete label (confirmation required; removes the label from all tasks)
- Get productivity stats
- List projects (read-only lookup with pagination)
- List sections (read-only lookup, optional project filter, pagination)

## Confirmation cards

All actions use native cards with the same spacing and Cancel/action footer.
Task, project, section, and label creation share an editable Name field followed
by a details summary. Updates show the selected name and ID plus the requested
changes; fields absent from the request stay unchanged. Deletions always show
Name, ID, and the consequence of deleting that entity. Read-only lookups never
ask for confirmation by default.

`list_labels` only lists labels and accepts optional `limit` and `cursor` arguments.
Use `create_label`, `update_label`, and `delete_label` for changes.
There are **18 exposed tools: 15 business tools and 3 account/setup helpers**.

## Automated tests

From `integrations/todoist/`, run:

```sh
bun install
bun test
```

The repository's existing GitHub Actions workflow runs those commands for this
integration. No API keys, saved authorization, or live Todoist account are needed.

`tests/server.test.ts` starts a disposable copy of the real server and calls it
over MCP using the real Composio SDK. `tests/mock-composio.ts` intercepts every
fetch with local fixtures and rejects unexpected requests. The temporary server
copy redirects only its browser-opening import to a recording stub; the installed
integration and real OAuth state are never loaded or changed. Temporary files and
the child server are cleaned up when the suite finishes.

Coverage includes:

- The fifteen business tools, including separate label creation, updates, and deletion, and the three current
  account/setup helpers. The explicit catalog assertion documents the setup
  helpers separately; it does not imply additional business-tool approval.
- Exact Composio operations and arguments, partial updates, and invalid inputs.
- Action confirmation definitions, read-only confirmation exclusions, result-card limits, empty responses, and
  pagination while retaining full response data.
- Success/error notifications, notification failures, credential redaction,
  and SDK-wrapped timeouts without repeating writes.
- Saved, pending, expired, revoked, disabled, and rejected account states;
  mocked OAuth completion and reuse; concurrent connects; disconnect success,
  unsupported provider revocation, and failure recovery.

These offline tests complement manual checks in VoiceOS and Todoist. They verify
notification payloads and confirmation definitions, not their visual rendering.
Mocked OAuth completion also does not verify provider consent or a real token
refresh. There is no live-account test script included or run by CI.
