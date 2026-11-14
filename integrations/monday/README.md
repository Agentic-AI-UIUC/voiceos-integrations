# Monday.com integration — 0.1.3

## Platform and setup

This integration supports macOS and Windows (`supportedPlatforms: ["darwin", "win32"]`).
It ships with `run.sh` for macOS and `run.cmd` for Windows. The macOS launcher
has been tested in VoiceOS. Windows remains unverified.

[Install Monday.com in VoiceOS](https://api.voiceos.com/integration-share/kaRwBBcaqTCz/page).

Enter `COMPOSIO_API_KEY` in VoiceOS’s Monday.com integration settings. `.env.example`
documents the required key. The server reads the environment variable supplied by
its host. In VoiceOS, say “connect me to Monday.com” and approve the confirmation,
then finish authorization in your browser. The pending card checks for approval.

If the browser says “App is not installed,” ask a Monday.com account admin to
install the Composio app in the Monday.com account you want to connect, then
retry authorization. [Install Composio in Monday.com](https://auth.monday.com/oauth2/authorize?client_id=96b038435fc029e045f9ba800e66fefa&response_type=install).

## Tools

The approved scope covers the ten categories below. Each row maps the approved
action to its manifest entry and shows any related entries that ship with it.

| Approved category | Approved action | Preparation helper | Related functionality to review |
| --- | --- | --- | --- |
| Create item | `create_item` | `prepare_create_item` | |
| Update item values | `update_item_values` | `prepare_update_item` | Also supports moving an item between groups on the same board. |
| Get items | `get_items` | | |
| Create update/comment | `create_comment` | `prepare_comment` | Posting also supports replies. `get_comments` reads threads. `edit_comment` and `delete_comment` change or remove the connected user's top-level updates. The helper also prepares those two actions. |
| Get boards | `get_boards` | | |
| Create board | `create_board` | `prepare_create_board` | |
| Delete board | `delete_board` | `prepare_delete_board` | |
| Manage users | `manage_users` | `prepare_manage_users` | `list_board_members` is a standalone read of board owners and direct subscribers. |
| Archive board | `archive_board` | `prepare_archive_board` | |
| Create group | `create_group` | `prepare_create_group` | |

Three account/setup tools support all ten categories. `connect_account` opens
browser authorization, `connection_status` checks the connection, and
`disconnect_account` unlinks it.

## Confirmation cards

Connect and Disconnect use native cards with a Cancel/action footer. The ten
Monday.com write tools use widgets with a VoiceOS-rendered confirmation button.
Item, board, and group creation let you edit the name and review the destination
or settings. Item updates show current and proposed values, including group moves.
Update deletion previews the text before permanent removal. Board deletion shows
which board will move to Trash. Membership changes show each person’s role and
warn about ownership changes or self-removal. Read-only lookups never ask for
confirmation by default.

Preparation tools resolve targets and build the arguments for the confirmation
cards. The manifest has **25 entries** across the ten approved actions, eight
preparation helpers, four related tools listed for review, and three
account/setup tools.

## Automated tests

From `integrations/monday/`, run:

```sh
bun install
bun test
```

The repository’s existing GitHub Actions workflow runs those commands for this
integration. The tests run offline with fixture credentials and account state.

`tests/server.test.ts` starts a disposable copy of the real server and calls it
over MCP using the real Composio SDK. `tests/mock-composio.ts` intercepts fetches
with local fixtures, rejects unexpected requests, and records browser launches.
The suite uses a temporary directory for server and authorization state and
cleans it up after closing the child server.

Coverage includes:

- The business tools, preparation helpers, and account tools, with input schemas
  and confirmation definitions checked against the manifest.
- Exact Composio operations and arguments, readback after writes, partial
  outcomes, invalid inputs, and rejection of stale confirmations.
- Read-only confirmation exclusions, result-card limits, empty responses, and
  pagination while retaining full response data.
- Connection notifications, notification failures, credential redaction, and
  timeout handling without repeating writes.
- Saved, pending, expired, revoked, and disabled account states, mocked OAuth
  completion and reuse, concurrent connects, and disconnect revocation and fallback.

These offline tests complement manual checks of card rendering and browser
authorization in VoiceOS and Monday.com. [Manual VoiceOS testing guide](AGENTS.md).
