# Monday.com — 0.1.1

macOS VoiceOS integration using Composio-managed OAuth. This version exposes three account tools and two read tools:

- **Connect Monday.com** (`connect_account`): open browser authorization and immediately return its pending state and link, or verify a saved active connection.
- **Monday.com account** (`connection_status`): check connection status (active, pending, disconnected, or expired). Read-only; does not start OAuth.
- **Disconnect Monday.com** (`disconnect_account`): revoke access where supported, otherwise disable the connection in Composio, then clear local connection references.
- **Get Monday.com boards** (`get_boards`): list boards or retrieve specific IDs, with workspace, visibility, and state filters and page-based pagination.
- **Get Monday.com items** (`get_items`): retrieve specific item IDs, or read a board/group's items with column values and cursor-based pagination.

Account actions have native confirmation cards, loading/progress feedback, result cards, and success/error notifications. Lookups run without confirmation and without triggering notifications. Read cards and default spoken responses summarize the first three names followed by “and N more,” without raw IDs. All returned records, IDs, and metadata remain available to the agent for follow-up calls or explicit detail requests. Counts refer to the returned page; summaries note when more pages may exist.

Board discovery is explicitly labeled **Boards found**, with `resultType: "boards"`. Task results use **Tasks**, with `resultType: "tasks"`. For “What are my tasks on the Voiceos board?”, the agent is instructed to resolve the board internally, prefer an exact name match or use a unique clear partial match (for example, **Voiceos test**), and ask when multiple boards could match. It must fetch tasks before giving the task answer, rather than narrating board names as tasks. An intermediate board card can still appear, but its label distinguishes it from the final answer.

The agent passes the exact resolved name as optional `board_name` display context alongside `board_id`, producing a summary such as **Tasks on "Voiceos test": Task 1, Task 2, Task 3, and 4 more.** This name is never sent to Composio or used to select a board; provider-returned board names take precedence when available. Cursor reads can carry the same display context. Item-ID reads may span boards, so they do not accept `board_name`. A failed task fetch reports an error instead of falling back to a board list. VoiceOS controls narration; the lookup sequencing and spoken result still require in-app verification.

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

Only `MONDAY_BOARDS`, `MONDAY_GET_ITEMS`, and `MONDAY_ITEMS_PAGE` are executed, through the Composio SDK using the saved installation identity and connected account, pinned to toolkit version `20261101_00`. Reads verify an active Monday connection first and have a 20-second account-check/execution deadline. Composio failures and Monday GraphQL errors are returned as errors, with reconnect guidance for invalid authorization. Reads never initiate OAuth automatically.

The remaining seven business tools are planned for later passes. The current allowlist is exactly five MCP tools: the three account controls and the two reads above.

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

Tests run a disposable copy of the real MCP server with the real Composio SDK. All HTTP and browser calls are intercepted locally; real credentials and installed OAuth state are never loaded. Coverage includes the exact five-tool allowlist and manifest/schema parity, confirmation contracts, OAuth completion/reuse/recovery, concurrent account calls, disconnect revocation/fallback/failures, credential redaction, and notifications. Read coverage includes saved-account/version routing, progress, filters, page/cursor pagination, column-value preservation, invalid inputs, empty and malformed results, GraphQL/HTTP failures, and expired/revoked/disabled connections.

Manual checks in VoiceOS are still required for rendered confirmation/result cards and notifications, and a live Monday login is required to verify real consent. The integration does not claim that offline tests verify provider token refresh.

Live pass-1 acceptance checks:

- List boards, retrieve a returned board ID, and request another page.
- Read that board's items and verify names, IDs, and column values against Monday.
- Continue using a returned cursor, and retrieve an item by its returned ID.
- In VoiceOS, verify loading and result cards, with no read confirmation or read notifications.
- Revoke authorization in a test account and verify actionable reconnect messaging without losing the saved connection reference.
