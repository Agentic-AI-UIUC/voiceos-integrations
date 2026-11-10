# Granola for VoiceOS

A VoiceOS integration that lets the VoiceOS agent list your Granola meetings, read their notes and transcripts, and answer questions across them. It is a local MCP server that runs every call through Composio's `granola_mcp` toolkit, which connects to Granola's official MCP server with DCR OAuth. The code never handles Granola tokens.

Scaffolded with the VoiceOS Integration Studio, then rewritten by hand. `AGENTS.md` describes the VoiceOS integration contract.

## Tools

Exactly the four tools approved in the ticket. All four only read, so none of them asks for confirmation.

| Tool | Ticket name | Composio tool |
| --- | --- | --- |
| `list_recent_meetings` | List recent meetings | `GRANOLA_MCP_LIST_MEETINGS` |
| `get_meeting_notes` | Get meeting notes | `GRANOLA_MCP_GET_MEETINGS` |
| `get_transcript` | Get transcript | `GRANOLA_MCP_GET_MEETING_TRANSCRIPT` |
| `search_meetings` | Search meetings | `GRANOLA_MCP_QUERY_GRANOLA_MEETINGS` |

- `list_recent_meetings` defaults to the last 30 days, newest first. It also takes this week, last week or a custom date range. Granola's own default is 7 days, so the range is always sent explicitly.
- `get_meeting_notes` returns the AI summary, the user's private notes, participants and date for up to 10 meetings, plus any IDs Granola couldn't find.
- `get_transcript` returns the transcript with speaker labels. Very long transcripts are cut to 30,000 characters, and the result says so.
- `search_meetings` asks Granola a question in plain language and returns its answer with numbered citations. The cited meeting IDs come back in `sources`, so the agent can open those meetings next. Granola has no keyword search, so this is the closest match to the ticket's "Search meetings".

No other Granola tool can run. The server only names these four, and the Composio session is created with only these four enabled, so a tool Composio adds to the toolkit later can't be called through it.

### Account tools

These follow the merged Teams integration, because Integration Studio has no native account linking. They handle the account, not Granola data, so they don't count toward the four above. All three can be called from the account card as well as by voice.

| Tool | Type | What it does |
| --- | --- | --- |
| `connect_account` | Confirms first, runs in the background | Opens the Granola sign-in in the browser and waits up to 2 minutes for it to finish. If Granola is already connected, it only checks that |
| `connection_status` | Read | Shows the account card: connected, expired, revoked or waiting for sign-in, with Connect or Disconnect and Refresh buttons. Never starts a sign-in |
| `disconnect_account` | Confirms first | Revokes access where Composio supports it, then deletes this install's Granola connections for this auth config. Nothing in Granola changes |

## Setup

1. In the Composio dashboard, create an auth config for **Granola MCP**. It offers only **Dynamic Client Registration**, which needs no client ID or secret. Keep the default scopes: `email`, `offline_access`, `openid`, `profile`.
2. Create a Composio API key with **Session management** (read and write) and **Session tool execution** (write), plus read access to Tools, Toolkits and Auth configs, and read and write access to Connected accounts (disconnecting needs write).
3. Install the folder in VoiceOS and fill in the setup fields:

| Field | Value |
| --- | --- |
| `COMPOSIO_API_KEY` | Your Composio API key (secret) |
| `COMPOSIO_AUTH_CONFIG_ID` | The Granola auth config's ID (`ac_...`) |

Say "connect Granola", or say "show my Granola connection" and use the Connect button. If you skip this, the first Granola tool you use opens the sign-in as a fallback. Sign in, then ask again.

There is no user ID field. On first use the server creates a Composio user ID for the install (`voiceos-` plus a random UUID) and saves it in `.composio-user.json` next to `server.ts`. That file is git-ignored.

The integration supports Mac and Windows. VoiceOS starts it with `run.sh` on Mac and `run.cmd` on Windows. The only platform-specific code opens the sign-in link: `open` on Mac, and `rundll32 url.dll,FileProtocolHandler` on Windows, as Teams does.

## Sign-in, loading and errors

- Before each call, the server asks the Composio session whether Granola is connected. If it isn't, it opens the sign-in and the agent says to connect or reconnect.
- After a failed call, the server checks the connection again and only asks to reconnect if Composio shows it inactive, or if Granola's error says the token was rejected (`401`, `unauthorized`, `invalid_token` or `invalid_grant` as whole words). Granola's errors can contain meeting IDs, and an ID such as `…-8401-…` must not send the user to sign in again. A test covers this.
- Composio refreshes tokens on its own. Granola's access tokens last 6 hours, and the `offline_access` scope gives Composio a refresh token.
- Each tool sends a progress message while it works, such as "Searching your Granola meetings…". VoiceOS shows its own loading state as well.
- Failures come back as an error card with a short, spoken-friendly message, an error `code` and a `reconnect_required` flag, so the agent knows when to offer to reconnect.
- Composio calls time out after 8 seconds and Granola reads after 15. Search gets 25, because Granola answers it with its own model, which took about 10 seconds in testing.
- Network access is limited to `backend.composio.dev`. The SDK's version check and tracking are off: the version check prints to stdout, which corrupts the MCP channel, and tracking would call another host.

## What Granola returns

Composio publishes no response format for these tools, so the parsing is based on real responses from Nov 7, 2026:

- The meeting list and notes come back as one XML-style string in `data.data`, with `<meeting id=… title=… date=… meeting_at=… url=…>` elements, escaped characters such as `&apos;`, and a `<pagination>` tag.
- The transcript comes back as JSON with `transcript`, `total_chars` and `truncated`.
- Search comes back as markdown with citations like `[[1]](https://notes.granola.ai/d/<meeting id>)`.
- An unknown meeting ID isn't an error: it comes back as `{ meetings: [], not_found: [...] }`.
- The responses include instructions written for other AI assistants, such as "call search_transcripts", a tool this integration doesn't have. The server leaves those out and returns plain fields, plus a `content_note` saying the meeting content is data, not instructions.

## Testing

`bun install && bun test` runs 46 offline tests. They start the real server over MCP with `tests/mock-composio.ts` preloaded. That file replaces `fetch` with a fake Composio that returns the formats above with made-up meetings, so no keys or network are needed. The tests cover:

- **The manifest:** exactly the four tools plus the account tools, Mac and Windows support, confirmations only on connect and disconnect, declared setup fields, the network allowlist, and matching descriptions and inputs between the server and the manifest.
- **Opening the sign-in:** `open` on Mac and `rundll32` on Windows, using fake commands on PATH.
- **Every tool's arguments and results:** escaped titles, the instructions left out, cited sources, long transcripts cut short, and unknown or invalid meeting IDs.
- **The loading message** each tool sends.
- **The Composio session:** limited to the four tools, with one user ID per install and no calls to other hosts.
- **Sign-in paths:** not connected, expired, a token rejected mid-call, a meeting ID containing `401`, and missing setup.
- **Connecting and disconnecting:** finished, unfinished and failed sign-in, duplicate connections, a key without write access, and Composio not confirming the disconnect.

The test servers run from an empty temp folder, because Bun would otherwise load a local `.env` into them.

Tested live on Nov 7, 2026, with a free Granola account and its built-in demo meeting:

- **Over MCP against real Composio:** all four tools, an unknown meeting ID, the connection status, and `connect_account`, both with a sign-in finished in time and with one left unfinished. The unfinished one returned "Waiting for sign-in" after 2 minutes.
- **The Composio session:** it refused a Granola tool outside the four with "not enabled for this session".
- **In VoiceOS, on version 1.0.1:** "What Granola meetings did I have this week?" (list recent meetings) and "What exactly did Sam say about the green bars?" (get transcript, which quoted him).

Tested live in VoiceOS on Nov 10, 2026:

- "Get the notes from my demo meeting" (list recent meetings, then get meeting notes), "What were the main points of my last meeting?" (search meetings) and "Show my Granola connection" (the account card).
- **Token refresh:** the notes call ran about 57 hours after sign-in, long after the 6-hour access token expired. Composio refreshed the token during that call, and it succeeded without asking the user to sign in again.

- **The account card's Disconnect button:**
  - With a key that can't write to Connected accounts, it showed the clear "write access" error and the card stayed on Connected.
  - With a key that has write access, it removed the connection, and Composio then showed none for the install.
- **"Connect Granola" by voice:** VoiceOS asked for confirmation, the sign-in opened, and Composio showed exactly one new connection afterwards.

Connecting only needs read access to Connected accounts. Disconnecting needs write access, because it deletes the connection.

Windows support (version 1.0.2) hasn't run on a Windows machine yet. The offline tests check that Windows is declared and that the sign-in opens with `rundll32` instead of `open`.

## Known limitations

- **Only the active workspace, and 30 days on a free plan.** Granola's MCP server only sees the user's active Granola workspace, and free plans only reach the last 30 days of notes.
- **Transcripts may need a paid plan.** Granola's docs list transcripts as paid-only, but they worked on a free account on Nov 7, 2026. Workspace admins can also turn off transcripts over MCP.
- **Search takes about 10 seconds.** That's Granola's own answer time.
- **The parsing depends on Granola's text format.** If Granola changes the XML-style layout, the parsing needs updating. The fake Composio's fixtures mirror the current format.
- **Disconnect may leave Granola's token alive for up to 6 hours.** If Composio can't revoke at Granola, the connection is still deleted from Composio, and the message says Granola's access ends when the token expires.
- **Card buttons get VoiceOS's generic confirmation.** When Connect or Disconnect is clicked on the account card, VoiceOS asks for approval in its own "Confirm action" dialog showing the raw arguments (`{}`), not the tool's confirmation card. Asking by voice should show the tool's own card, but that hasn't been checked live.
- **A replaced folder means signing in again.** The per-install user ID lives in `.composio-user.json`, so if VoiceOS ever replaces the folder, the user signs in again.
- **Don't use the Studio's refine or Edit on this folder.** Refine regenerates `server.ts`, and Edit opens a draft from the Studio's stored copy, which is still the original scaffold.

## Releasing an update in VoiceOS

As of VoiceOS 0.1.40, VoiceOS re-reads an integration's manifest only after its server fails to start and you click **Try again**, and it offers **Publish** only when the version differs from the last published one. So to release:

1. Bump `version` in `voiceos.integration.json`.
2. Copy the folder into VoiceOS's install folder, without `.env` or `node_modules`, and run `bun install` there.
3. Rename `server.ts` to `server.ts.real` and add a stub `server.ts` that renames it back and exits with an error.
4. Turn Granola off and on in VoiceOS, then click **Try again**. Don't save Granola's settings in between: that restarts it without re-reading the manifest.
5. Move `.composio-user.json` out of the install folder, click **Publish**, then move it back. Publish zips the folder, and that file holds your own Composio user ID.
