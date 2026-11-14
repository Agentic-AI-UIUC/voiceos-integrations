# Monday.com — 0.1.3

macOS VoiceOS integration using Composio-managed OAuth.

- **Connect Monday.com** (`connect_account`): open browser authorization and immediately return its pending state and link, or verify a saved active connection.
- **Monday.com account** (`connection_status`): check connection status (active, pending, disconnected, or expired). Read-only; does not start OAuth.
- **Disconnect Monday.com** (`disconnect_account`): revoke access where supported, otherwise disable the connection in Composio, then clear local connection references.
- **Get Monday.com boards** (`get_boards`): list boards or retrieve specific IDs, with workspace, visibility, and state filters and page-based pagination.
- **Get Monday.com items** (`get_items`): retrieve specific item IDs, or read a board/group's items with column values and cursor-based pagination.

Connecting and disconnecting Monday.com show native confirmation cards, progress, result cards, and desktop notifications. Business tools show progress and result cards. Get Boards and Get Items show up to six list rows. Get Boards uses a **Monday.com boards** header and shows workspace names when available. Get Items uses the board name as its header and shows status or group labels when available. For a longer page, the sixth row says “and X more,” counting the hidden items on that page. The agent can offer the next page when a cursor is available. The agent gives a brief spoken summary and can use all returned records, IDs, and metadata for follow-ups.

Board discovery is labeled **Monday.com boards**, with `resultType: "boards"`. Task results use **Tasks**, with `resultType: "tasks"`. For “What are my tasks on the Voiceos board?”, the agent is instructed to resolve the board internally, prefer an exact name match or use a unique clear partial match (for example, **Voiceos test**), and ask when multiple boards could match. It must fetch tasks before giving the task answer, rather than narrating board names as tasks. An intermediate board card can still appear, but its label distinguishes it from the final answer.

The agent passes the exact resolved name as optional `board_name` display context alongside `board_id`. The card shows the board name and the agent can say “Here are the first few items on Voiceos test.” Provider-returned board names take precedence when available. Cursor reads can carry the same display context. Item-ID reads may span boards and omit `board_name`. A failed task fetch reports the error. VoiceOS controls narration.

## Board membership

- Ask “Who's on the Marketing board?” to list its owners and direct subscribers without a confirmation. A board can also be accessible through a team or its visibility.
- Ask “Add Alex to the Marketing board” to prepare a subscriber addition. Specify “as an owner” to grant board ownership. For “Remove me from the Marketing board,” VoiceOS uses the connected Monday identity and warns that you could lose access.
- The confirmation shows the board and workspace, each person's name, email and role, and any ownership or self-removal warning. Give the workspace or a person's full name or email if VoiceOS asks which one you meant. Approval applies the reviewed changes. Removal is available for direct subscribers.
- VoiceOS speaks the outcome and displays it on the result card. For a partial or uncertain outcome, check the board before requesting another change.

## Read tools (pass 1)

Board cards have a **Boards** row containing board names. Task cards have a **Tasks** row containing task names, plus a separate **Board** row when the resolved board name is available. Neither uses a generic “Results” row. Cards also indicate when additional pages may exist.

After connecting, try **“Show my Monday boards”**, **“Show items on Monday board 123”**, or **“Get Monday items 456 and 789”**. Use actual board/item IDs from your account.

Examples of tool inputs:

```json
{"name":"get_boards","arguments":{"page":1,"limit":25,"state":"active"}}
{"name":"get_boards","arguments":{"ids":[123],"workspace_ids":[45]}}
{"name":"get_items","arguments":{"ids":[456,789],"page":1,"limit":25}}
{"name":"get_items","arguments":{"board_id":123,"group_id":"topics","limit":25}}
{"name":"get_items","arguments":{"cursor":"<pagination.nextCursor from prior result>","limit":25}}
```

IDs are positive safe integers; lists accept 1–100 IDs and page sizes default to 25 (maximum 100). `get_items` requires exactly one of `ids`, `board_id`, or `cursor`. `page`, `newest_first`, and `exclude_nonactive` apply only to item-ID reads; `group_id` applies only to initial board reads. Pass the cursor, optional limit, and optional resolved `board_name` display context for subsequent board pages. Cursor expiry is reported as an error; restart with the board ID to fetch fresh pages.

Results contain `records` and `pagination`. Board and item-ID reads return `nextPage` when a full page suggests another page may exist; it is not a guarantee of more results. Board-item reads return `nextCursor` (null at the end).

Board and item browsing use `MONDAY_BOARDS`, `MONDAY_GET_ITEMS`, and `MONDAY_ITEMS_PAGE` through the Composio SDK using the saved installation identity and connected account, pinned to toolkit version `20261101_00`. Reads verify an active Monday connection first and have a 20-second account-check/execution deadline. Composio failures and Monday GraphQL errors are returned as errors, with reconnect guidance for invalid authorization. Reads never initiate OAuth automatically.

## Comments

- `get_comments` lists an item's threads and replies using Monday’s GraphQL API through Composio Proxy Execute. The Monday connection needs `updates:read`. Use the item name, optionally with its board name, or a verified item ID. Use `pagination.nextPage` and the returned item ID to continue.
- `prepare_comment` resolves the item and, for a reply, edit, or deletion, the target comment. Select by quoted text, a verified comment ID, or `latest: true` for a request such as “my last comment.” Ask the returned question when the match is ambiguous, then use the selected ID. Use `replaces_draft_id` with the complete revised request to replace a pending card.
- `create_comment` posts a new comment or reply using the exact text shown on the card. This replaces the former `create_update` tool.
- `edit_comment` shows the original and revised text. `delete_comment` separately shows the comment, author, item, and permanent deletion warning.

Edit and delete apply to the connected user's own top-level comments. Replies can be read and posted. Every write takes the corresponding arguments from `prepare_comment` and consumes that draft on approval. Approval rechecks the item and, where applicable, the selected comment and current user.

```json
{"name":"get_comments","arguments":{"item_name":"Launch","board_name":"Roadmap"}}
{"name":"prepare_comment","arguments":{"operation":"create","item_name":"Launch","board_name":"Roadmap","body":"Review completed."}}
{"name":"prepare_comment","arguments":{"operation":"delete","item_name":"Launch","board_name":"Roadmap","latest":true}}
```

## Write tools (pass 2)

- `prepare_create_item`: pass `board_name` or a verified `board_id` when the user specifies a board. Otherwise the card lists boards and asks the user to say or type a board name. Use their reply as `board_name` and pass the returned `pending_item.draft_id` as `replaces_draft_id`. The first active group is the default. For a voice revision, pass `replaces_draft_id` or the exact pending item name as `revises_item_name`. This step only reads Monday.
- `create_item`: use the returned `create_item_arguments`. In VoiceOS, edit the item name or choose an active group on the selected board before creating the item. The board and column details are read-only.
- `prepare_update_item`: find the exact item using the browsing tools and pass its `item_id` and optional verified `board_id`. Omit `column_values` to get editable columns and labels. Pass the desired values keyed by actual column ID or title. Supported types are item name, status, dropdown, people, date, timeline, text, long text, numbers, and checkbox. Use `null` to clear a value explicitly. For an assignee change that preserves other assignments, use `{ "operation": "add", "names": ["Jordan"] }` or `{ "operation": "remove", "names": ["Jordan"] }`.
- `update_item_values`: pass the returned `update_item_arguments` verbatim to show the item's current and proposed values on one VoiceOS card. To revise it by voice, call `prepare_update_item` with `replaces_draft_id` and the complete revised set of changes. **Save changes** rechecks the preview and sends one mutation. The result reports which values were verified on the item after saving.
- To move an item within its board, pass the destination group title or ID in `destination_group` to `prepare_update_item`. The same confirmation shows the current and destination groups and any column edits. VoiceOS saves and verifies column edits first, then attempts and verifies the move.
- `prepare_create_group`: pass the destination as `board_name` or a verified `board_id`, and the new group's `group_name`. Placement defaults to the bottom. Pass `position.placement` as `top`, `bottom`, `before`, or `after`, with `position.reference_group` for a relative placement. Use the latest draft ID as `replaces_draft_id` when answering a clarification or revising a draft.
- `create_group`: use `create_group_arguments` to open the **Create group** card. It shows the destination board and lets the user edit the name and position. Approval creates one empty group using Monday's `create_group` mutation through Composio Proxy Execute. The result includes the confirmed group ID. For an uncertain outcome, check Monday before trying again.
- `prepare_archive_board`: pass the board name or a verified board ID. If the name matches multiple boards, use the returned choices to clarify which one the user means. Pass `replaces_draft_id` to revise an open confirmation by voice.
- `archive_board`: pass the returned `archive_board_arguments` to open the **Archive board** card. The board picker preselects the requested board and shows workspace names when available. Approval rechecks the selected board and archives it through Composio Proxy Execute. Check Monday.com before retrying an uncertain outcome.
- `prepare_delete_board`: pass the board name or a verified board ID. Use the returned choices to clarify ambiguous names. Pass `replaces_draft_id` or `revises_board_name` to revise a pending deletion by voice.
- `delete_board`: use `delete_board_arguments` to open the **Delete board** card. The editable board picker shows workspace names when available. Approval rechecks the selected board, then moves it to Monday.com Trash, where it can be recovered for 30 days. Check Monday.com before retrying an uncertain outcome.
- `prepare_create_board`: pass the known `board_name`, `board_kind` (`public`, `private`, or `share`), `description`, and `workspace` name. If the board name is missing or the workspace lookup has no unique match, the result includes a question and a `pending_board.draft_id`. For a follow-up to that question or an edit before approval, pass the latest draft ID as `replaces_draft_id` and the changed fields. Use `workspace: null` to switch to the default workspace.
- `create_board`: pass the returned `create_board_arguments` to show the VoiceOS confirmation for standalone and chained requests. The user can edit the name, visibility, description, and workspace. Public and the default workspace are preselected when omitted. The default workspace remains available when the connection lacks workspace read access. After approval, the result includes the confirmed ID, name, and board URL when available. VoiceOS shows an **Open board** action when it has a verified link.
- When Monday definitively rejects the requested visibility, use `retry_create_board_arguments` to show a fresh confirmation with the error and the submitted values. Wait for approval again. For an uncertain outcome, check Monday before another create.
- For “create a board and add an item,” pass `item_follow_up` as `prepare_confirmation` with `follow_up_item_name` for a named item, or `ask_name` for an unnamed one. Before board approval, an explicit item rename updates only `follow_up_item_name` on the pending board draft. After board creation, use `item_destination` with `prepare_create_item`. An item rename on the item confirmation revises that draft with the new `item_name` and keeps the destination. If the item step is canceled or fails, the board remains available and the retry starts with item preparation.

IDs use the same positive safe integer contract as reads. Column values accept an object or JSON object string and are validated before execution. The create and update flows send a JSON string keyed by actual Monday column IDs. The update preparation resolves values against the board’s column types and settings.

```json
{"name":"prepare_create_item","arguments":{"board_id":123,"item_name":"Review proposal","column_values":{"status":{"label":"Working on it"}}}}
{"name":"prepare_update_item","arguments":{"board_id":123,"item_id":456,"column_values":{"name":"Final review","Status":"Done","Notes":"Reviewed"}}}
{"name":"prepare_create_board","arguments":{"board_name":"Project planning"}}
```

The predefined create actions use Composio toolkit version `20261101_00`. Item updates use Monday's `change_multiple_column_values` mutation through Composio Proxy Execute with the saved account. A scoped Composio project key needs Proxy Execute permission in addition to its existing permissions. The update reads back affected fields before reporting success and makes one write attempt, even after a timeout.

Each dispatched write shows progress and a result card. A successful write returns the confirmed created or updated ID, including when Composio wraps the Monday response in `raw_response`. Desktop notifications are reserved for connecting and disconnecting Monday.com. Invalid MCP schema inputs are rejected by the SDK before execution; malformed column JSON is reported through the write feedback handler. Missing or malformed provider IDs produce an uncertain-outcome error. Check Monday before retrying any uncertain write to avoid duplicates.

Pass 2 verification exercises the real MCP server and Composio SDK with intercepted HTTP responses for all four tools. It covers account and version routing, the multi-column mutation and readback, missing targets, permission and GraphQL failures, malformed columns, the live create response envelope, and the absence of business notifications. For an in-app check, refresh the installed runtime using `AGENTS.md` and verify a dedicated create-board → create-item → retrieve → update → comment workflow.

## Setup

1. Enter `COMPOSIO_API_KEY` in the integration's VoiceOS settings. The host supplies it as an environment variable; the server does not load `.env` files.
2. Say **“connect me to Monday.com”** and approve the confirmation. The browser opens and VoiceOS immediately returns **Authorization pending**, with an authorization link. Select the intended Monday account and complete approval in the browser.
3. Say **“connect me to Monday.com”** again after approval to verify the saved connection. An active connection returns **Connected** without opening the browser again.
4. Say **“disconnect Monday.com”** to unlink. Boards, items, comments, and board memberships remain untouched.

### Troubleshooting: “App is not installed”

If the **Authorize Composio** page reports **“App is not installed — Please ensure that your admin have installed this app”**, Composio's app has not been installed in the selected Monday account. This is a Monday setup prerequisite, not a requirement to install the Monday desktop app; a web account and browser are sufficient.

Installation and authorization are separate steps: installation makes Composio available to the Monday account, while authorization grants access on your behalf.

1. As a Monday account admin, open the Composio installation link below. If you created the Monday account yourself, you should normally be its admin; otherwise, ask your account admin to install it.
2. Select the **same Monday account** you intend to connect to VoiceOS and complete installation.
3. Return to VoiceOS and say **“connect me to Monday.com”** again, complete browser approval, then run Connect once more to verify.

<https://auth.monday.com/oauth2/authorize?client_id=96b038435fc029e045f9ba800e66fefa&response_type=install>

See [Composio's Monday documentation](https://docs.composio.dev/toolkits/monday). You can create your own Monday work-management account for testing; a Pro trial supports private-board testing later.

Connect is a short, synchronous browser handoff; it opens browser authorization and immediately returns a pending status with its link rather than blocking VoiceOS or scheduling an orphaned sidebar task. A non-blocking background watcher monitors Composio for browser approval and surfaces a completion notification once active. Retrying Connect generates a fresh authorization link (since visited Composio link sessions expire) or verifies an active connection. Concurrent Connect calls share a single authorization attempt; Connect and Disconnect cannot run at the same time.

Composio stores provider tokens and manages their lifecycle. `.composio-auth.json` stores only this installation's random identity and connected-account/pending-link references, with owner-only file permissions. It is ignored by Git. Disconnect reports whether provider authorization was revoked or access was only disabled in Composio; in the latter case an admin can remove provider consent in Monday's installed apps.

## Verification

For deploying worktree changes into the installed app and restarting it for manual testing, see [the agent refresh guide](AGENTS.md).

```sh
bun install
bun test
bun run build
```

Tests run a disposable copy of the real MCP server with the real Composio SDK. All HTTP and browser calls are intercepted locally; real credentials and installed OAuth state are never loaded. Coverage includes the tool allowlist and manifest/schema parity, confirmation contracts, OAuth completion/reuse/recovery, concurrent account calls, disconnect revocation/fallback/failures, credential redaction, and notifications. Read coverage includes saved-account/version routing, progress, filters, page/cursor pagination, column-value preservation, invalid inputs, empty and malformed results, GraphQL/HTTP failures, and expired/revoked/disabled connections.

### Agent testing through the desktop notch

For a live VoiceOS test, open the **VoiceOS Agent** notch on the desktop and submit a natural-language request through its composer or microphone. Use visible board and person names, just as a user would. Observe the response and any confirmation or result card in the notch. To test spoken output, use the voice interaction and verify the audio separately.

For approved writes on a dedicated test board, use the notch's confirmation card and verify the resulting Monday state independently with the Codex Monday.com connector. Direct MCP calls can diagnose provider issues. Record those results separately from notch tests.

See [the agent refresh and notch guide](AGENTS.md#accessing-the-macos-agent-island-for-integration-testing) for setup and troubleshooting. A live Monday connection is required to test real authorization.

For board membership, start with “Who's on the VoiceOS move destination test board?” Then exercise add and remove using an existing test user. Check the default subscriber role, the explicit-owner and self-removal warnings, and that canceling a confirmation leaves membership unchanged.

Live pass-1 acceptance checks:

- List boards, retrieve a returned board ID, and request another page.
- Read that board's items and verify names, IDs, and column values against Monday.
- Continue using a returned cursor, and retrieve an item by its returned ID.
- In VoiceOS, verify loading and result cards, with no read confirmation or read notifications.
- Revoke authorization in a test account and verify actionable reconnect messaging without losing the saved connection reference.
