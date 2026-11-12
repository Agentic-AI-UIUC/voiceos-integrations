# Monday.com — 0.1.3

macOS VoiceOS integration using Composio-managed OAuth. This version exposes three account tools, two read tools, and four write tools:

- **Connect Monday.com** (`connect_account`): open browser authorization and immediately return its pending state and link, or verify a saved active connection.
- **Monday.com account** (`connection_status`): check connection status (active, pending, disconnected, or expired). Read-only; does not start OAuth.
- **Disconnect Monday.com** (`disconnect_account`): revoke access where supported, otherwise disable the connection in Composio, then clear local connection references.
- **Get Monday.com boards** (`get_boards`): list boards or retrieve specific IDs, with workspace, visibility, and state filters and page-based pagination.
- **Get Monday.com items** (`get_items`): retrieve specific item IDs, or read a board/group's items with column values and cursor-based pagination.

Connecting and disconnecting Monday.com show native confirmation cards, progress, result cards, and desktop notifications. Business tools show progress and result cards. Get Boards and Get Items show up to six list rows. Get Boards uses a **Monday.com boards** header and shows workspace names when available. Get Items uses the board name as its header and shows status or group labels when available. For a longer page, the sixth row says “and X more,” counting the hidden items on that page. The agent can offer the next page when a cursor is available. The agent gives a brief spoken summary and can use all returned records, IDs, and metadata for follow-ups.

Board discovery is labeled **Monday.com boards**, with `resultType: "boards"`. Task results use **Tasks**, with `resultType: "tasks"`. For “What are my tasks on the Voiceos board?”, the agent is instructed to resolve the board internally, prefer an exact name match or use a unique clear partial match (for example, **Voiceos test**), and ask when multiple boards could match. It must fetch tasks before giving the task answer, rather than narrating board names as tasks. An intermediate board card can still appear, but its label distinguishes it from the final answer.

The agent passes the exact resolved name as optional `board_name` display context alongside `board_id`. The card shows the board name and the agent can say “Here are the first few items on Voiceos test.” Provider-returned board names take precedence when available. Cursor reads can carry the same display context. Item-ID reads may span boards and omit `board_name`. A failed task fetch reports the error. VoiceOS controls narration.

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

The MCP allowlist contains three account controls, two browsing tools, one read-only preparation tool, and four writes. Delete board, archive board, and membership changes remain for pass 3.

## Write tools (pass 2)

- `prepare_create_item`: pass `board_name` or a verified `board_id` when the user specifies a board. Otherwise the card lists boards and asks the user to say or type a board name. Use their reply as `board_name` and pass the returned `pending_item.draft_id` as `replaces_draft_id`. The first active group is the default. For a voice revision, pass `replaces_draft_id` or the exact pending item name as `revises_item_name`. This step only reads Monday.
- `create_item`: use the returned `create_item_arguments`. In VoiceOS, edit the item name or choose an active group on the selected board before creating the item. The board and column details are read-only.
- `update_item_values`: required `board_id`, `item_id`, and nonempty `column_values` keyed by actual column IDs.
- `create_update`: required `item_id` and nonempty `body` to post an update/comment.
- `create_board`: required `board_name` and explicit `board_kind` (`public`, `private`, or `share`); optional `workspace_id`, `folder_id`, and `description`. Membership assignment is reserved for pass 3.

IDs use the same positive safe integer contract as reads. Column values accept an object or JSON object string and are validated before execution. The create action receives a canonical JSON string; the update action receives each typed value, which Composio serializes according to its schema. Null column values and nested arrays are not supported by the pinned update action. Resolve actual IDs and column types from Monday; provider validation remains authoritative for board-specific column formats.

```json
{"name":"prepare_create_item","arguments":{"board_id":123,"item_name":"Review proposal","column_values":{"status":{"label":"Working on it"}}}}
{"name":"update_item_values","arguments":{"board_id":123,"item_id":456,"column_values":{"status":{"label":"Done"},"text":"Reviewed"}}}
{"name":"create_update","arguments":{"item_id":456,"body":"Review completed."}}
{"name":"create_board","arguments":{"board_name":"Project planning","board_kind":"private"}}
```

The Composio catalog schemas were checked during implementation and are retained in `tests/catalog/`. The four provider actions are `MONDAY_CREATE_ITEM`, `MONDAY_UPDATE_ITEM`, `MONDAY_CREATE_UPDATE`, and `MONDAY_CREATE_BOARD`, all pinned to `20261101_00`. `MONDAY_UPDATE_ITEM` changes one column per request. Multi-column updates run sequentially and are **not atomic**: an error identifies completed columns, the unconfirmed column, and unattempted remaining columns. No rollback or automatic retry occurs. SDK execution disables HTTP retries; intercepted HTTP 500 tests verify one attempt.

Each dispatched write shows progress and a result card. A successful write returns the confirmed created or updated ID, including when Composio wraps the Monday response in `raw_response`. Desktop notifications are reserved for connecting and disconnecting Monday.com. Invalid MCP schema inputs are rejected by the SDK before execution; malformed column JSON is reported through the write feedback handler. Missing or malformed provider IDs produce an uncertain-outcome error. Check Monday before retrying any uncertain write to avoid duplicates.

Pass 2 verification exercises the real MCP server and Composio SDK with intercepted HTTP responses for all four tools. It covers account and version routing, partial updates, missing targets, permission and GraphQL failures, malformed columns, the live create response envelope, and the absence of business notifications. For an in-app check, refresh the installed runtime using `AGENTS.md` and verify a dedicated create-board → create-item → retrieve → update → comment workflow.

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

Tests run a disposable copy of the real MCP server with the real Composio SDK. All HTTP and browser calls are intercepted locally; real credentials and installed OAuth state are never loaded. Coverage includes the exact nine-tool allowlist and manifest/schema parity, confirmation contracts, OAuth completion/reuse/recovery, concurrent account calls, disconnect revocation/fallback/failures, credential redaction, and notifications. Read coverage includes saved-account/version routing, progress, filters, page/cursor pagination, column-value preservation, invalid inputs, empty and malformed results, GraphQL/HTTP failures, and expired/revoked/disabled connections.

Manual checks in VoiceOS are still required for rendered confirmation/result cards and notifications, and a live Monday login is required to verify real consent. The integration does not claim that offline tests verify provider token refresh.

Live pass-1 acceptance checks:

- List boards, retrieve a returned board ID, and request another page.
- Read that board's items and verify names, IDs, and column values against Monday.
- Continue using a returned cursor, and retrieve an item by its returned ID.
- In VoiceOS, verify loading and result cards, with no read confirmation or read notifications.
- Revoke authorization in a test account and verify actionable reconnect messaging without losing the saved connection reference.
