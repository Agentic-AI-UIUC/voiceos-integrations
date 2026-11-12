# TikTok for VoiceOS: handoff

Version 1.3.2 of a VoiceOS integration that reads a creator's TikTok stats and posts, and sends videos and photo carousels from the computer to TikTok. Every TikTok call goes through Composio's REST API v3.1, using a TikTok developer app the team owns. It supports macOS and Windows, and so far it has run inside VoiceOS on macOS only.

The code lives in `src/` and `confirm-card/`. `bun run build` turns them into `server.ts` and `voiceos.integration.json`, so edit the sources, not those two files. `README.md` is the user-facing page.

## Terms

- **Composio**: a third-party service that stores each user's TikTok OAuth token and runs TikTok API calls for us. A **connected account** (`ca_…`) is one user's TikTok login there, filed under a Composio **user id**.
- **Drafts (inbox)**: TikTok's upload mode. The post lands in the TikTok app's inbox, and the user finishes it there. A **direct post** goes straight to the profile.
- **Only me** (`SELF_ONLY`): TikTok's most private audience. The others are Friends, Followers and Everyone.
- **Creator info**: what TikTok returns about the account just before a direct post: its nickname, the audiences it may use (`privacy_options`), which interactions its owner turned off, and the longest video it may post. The interactions are comments, Duet and Stitch (TikTok features that let others reuse a video in their own).
- **Audit**: TikTok's review of an app's posting flow. Until it passes, direct posts are Only me.
- **URL property**: a domain or URL prefix that the TikTok app has proven it controls. TikTok fetches carousel photos from public URLs (its `PULL_FROM_URL` source), and only from these.
- **Media relay**: `relay-worker/`, a Cloudflare Worker that holds carousel photos briefly so TikTok can fetch them from a verified URL. Publish doesn't ship it.
- **Confirmation receipt**: what a confirmation card stages: a SHA-256 digest of the exact arguments on screen, with a time and a nonce. The server refuses a write without a matching, unused receipt under 10 minutes old.
- **Setup field**: a manifest `preferences` entry. Users fill it in under Integrations → TikTok → Configure, and the server reads it as an environment variable.

## Tools

There are 12 tools, defined in `src/tools.ts`. The four helpers are agent-only (`visibility: "agent"`): the agent calls them, and users don't see them. The four writes run in the background, each behind a confirmation card, and end with a completion card.

| Tool | Type | What it does | Composio slug |
|---|---|---|---|
| `get_user_stats` | Read | Followers, following, likes and public video count; with `include_profile`, also bio, verified badge, picture and profile link | `TIKTOK_GET_USER_STATS` |
| `list_videos` | Read | Public posts, newest first, plus what went through VoiceOS in the last 7 days | `TIKTOK_LIST_VIDEOS` |
| `query_videos` | Read | Details and stats for 1–20 public posts | `TIKTOK_QUERY_VIDEOS` |
| `fetch_publish_status` | Read | Whether a send is processing, in the inbox, posted or failed | `TIKTOK_FETCH_PUBLISH_STATUS` |
| `query_creator_info` | Helper | Creator info before a direct post; returns a short-lived `post_token` | `TIKTOK_QUERY_CREATOR_INFO` |
| `find_recent_videos` | Helper, local | Finds the video the user means; returns a `file_token` | none |
| `find_recent_images` | Helper, local, photo | Finds recent photos and screenshots; returns `image_token`s | none |
| `prepare_photo_post` | Helper, local, photo | Checks the photos, their order and the cover; returns a `bundle_token` | none |
| `upload_video` | Write | Sends a video to drafts | `TIKTOK_UPLOAD_VIDEO` with `publish: false` |
| `publish_video` | Write | Posts a video directly | `TIKTOK_UPLOAD_VIDEO` with `publish: true` |
| `upload_photos` | Write, photo | Sends 1–35 photos to drafts | `TIKTOK_POST_PHOTO` with `post_mode: "MEDIA_UPLOAD"` |
| `post_photos` | Write, photo | Posts 1–35 photos directly | `TIKTOK_POST_PHOTO` with `post_mode: "DIRECT_POST"` |

- **The four photo tools ship disabled.** While `MEDIA_RELAY_BASE` in `src/config.ts` is empty, `photoToolsEnabled()` is false and the build marks them `disabled` ("Photo carousels need the media relay, which isn't set up yet."). See "Deploy the media relay".
- The writes run one at a time per account, are never retried, and poll `TIKTOK_FETCH_PUBLISH_STATUS` for up to 30 minutes. Every Composio tool call pins the TikTok toolkit version `20261101_00`.
- `TIKTOK_PUBLISH_VIDEO` (pulls a video from a URL) and `TIKTOK_UPLOAD_VIDEOS` (batch upload) aren't exposed.
- VoiceOS also calls one hidden tool, `voiceos_hook_transcript`. It isn't one of the 12; see "Open approvals".

## Setup fields to remove

The four setup fields are temporary, for testing, and each says so in its title or description. They're defined in the `preferences` list in `scripts/build.ts`, which writes them into the manifest. VoiceOS passes each one to the server as `process.env.<name>`, and only `loadConfig` in `src/config.ts` reads them.

| Field | Type | Holds | Used in |
|---|---|---|---|
| `COMPOSIO_API_KEY` | password, required | Composio project API key | `src/client.ts`, sent as `x-api-key` to `backend.composio.dev` only |
| `COMPOSIO_USER_ID` | text, default `default` | The Composio user id the connection is filed under | `assertAccount` in `src/client.ts`; at `default` it adopts the connection's owner |
| `COMPOSIO_CONNECTED_ACCOUNT_ID` | text, required | The ACTIVE TikTok connection (`ca_…`) | Every call in `src/client.ts`; the write queue and post-token check in `src/tools/writes.ts`; the per-account history in `src/ledger.ts` |
| `MEDIA_RELAY_TOKEN` | password, optional | Bearer token for the media relay | `src/relay.ts` |

**What replaces them:** a VoiceOS-managed Composio connection. VoiceOS holds the Composio key, runs the TikTok sign-in through a VoiceOS-owned TikTok app, and gives the server the user's connection, so users paste nothing. The relay token needs its own scheme, such as per-install tokens from VoiceOS or VoiceOS hosting the photos. Keep a stable id per connection: the history and the write queue key off it.

**When you remove them,** also update the `setupGuide` steps in `scripts/build.ts` that say to paste the key and connection id, the `NOT_CONFIGURED` and `NOT_CONNECTED` copy in `src/errors.ts`, the settings wording in `CAPABILITY_GUIDANCE` (`src/mcpServer.ts`), `tests/manifest.test.ts` (it pins exactly these four fields), `verify.ts` (it passes them to the mock), `.env.example` and the README's "Set up" section.

## Deploy the media relay

TikTok takes carousel photos only as URLs it fetches, on a URL property verified for the app; anything else gets `url_ownership_unverified` (shown as `URL_OWNERSHIP_UNVERIFIED`). So once the user approves a card, the server converts the photos to JPEG, uploads them to the relay, and passes TikTok the relay URLs. The relay is `relay-worker/`: one Cloudflare Worker plus one SQLite-backed Durable Object per batch, which works on the Workers Free plan.

1. In `integrations/tiktok/relay-worker/`, signed in to a team-owned Cloudflare account (`npx wrangler@4.158.0 login`), set the token with `npx wrangler@4.158.0 secret put RELAY_TOKEN`. Use at least 32 random characters, for example from `openssl rand -hex 32`; with a shorter token the worker refuses every upload call (401).
2. Deploy with `npx wrangler@4.158.0 deploy`. The relay serves on `https://tiktok-media-relay.<your-subdomain>.workers.dev`, or on a dedicated team subdomain if you add one as a Workers custom domain.
3. Verify the relay with TikTok. In the TikTok developer app, add the relay's `https://<relay host>/p/` prefix as a URL property with URL-prefix verification. Put TikTok's signature file name and contents in `vars.TIKTOK_VERIFICATION` in `wrangler.jsonc`, for example `{"tiktokXXXX.txt": "tiktok-developers-site-verification=…"}`, deploy again, then click verify. The worker serves the file at `/<name>` and `/p/<name>`. Photo URLs use the host the server calls, so verify the same host you put in `MEDIA_RELAY_BASE`.
4. Set `MEDIA_RELAY_BASE` in `src/config.ts` to the relay's HTTPS origin. The client accepts HTTPS only.
5. Run `bun run build`. It adds the relay host to the manifest's network permission (`networkDomains()` in `scripts/build.ts`), drops `disabled` and `disabledReason` from the four photo tools, and switches the manifest description and the relay token field to their relay wording. Then run the checks under "How to verify" and Reload the integration in VoiceOS.
6. Give each tester the token. They paste it into the **Media relay token** field (`MEDIA_RELAY_TOKEN`). Without it, a photo write is refused before any work (`RELAY_NOT_CONFIGURED`).

The relay takes JPEG and WebP only, up to 35 photos per batch and 20 MB per photo. It logs only the method, status, the batch id's first 6 characters and a byte count, and Workers Logs are off. The server deletes a batch once TikTok reports a final status, or as soon as a send fails before TikTok takes it. Any other batch, such as one whose outcome is unknown, expires after 2 hours.

## Scopes

On 2026-11-11, Composio's connected-account records showed that the TikTok auth config requests exactly these six scopes, and both test connections were granted all six. The TikTok app needs Login Kit, the Content Posting API with Direct Post on, and the Display API to offer them.

| Scope | Gives | Tools |
|---|---|---|
| `user.info.basic` | Display name and profile picture | `get_user_stats` |
| `user.info.profile` | Username, bio, verified badge and profile link | `get_user_stats` |
| `user.info.stats` | Follower, following, like and video counts | `get_user_stats` |
| `video.list` | Public posts and their stats | `list_videos`, `query_videos` |
| `video.upload` | Sending to drafts | `upload_video`, `upload_photos`, `fetch_publish_status` |
| `video.publish` | Direct posts and creator info | `publish_video`, `post_photos`, `query_creator_info`, `fetch_publish_status` |

- `username` is a `user.info.profile` field, not a basic one: TikTok's user fields and Composio's `TIKTOK_GET_USER_STATS` schema agree. `get_user_stats` asks for it on every call. Without `user.info.profile`, it retries with the basic and stats fields and says the username needs that scope (`src/tools/reads.ts`).
- `fetch_publish_status` works with either `video.upload` or `video.publish`.
- A missing scope comes back as `scope_not_authorized` and shows as "Permission missing" with the scope's name (`SCOPE_MISSING`).

## TikTok audit

Until TikTok audits the app, it takes direct posts only from private accounts, and only as Only me. A public account gets `unaudited_client_can_only_post_to_private_accounts`, which the server reports as `PRIVATE_ACCOUNT_REQUIRED` (`src/errors.ts`). TikTok also caps how many people can post through the app each day (`reached_active_user_cap`, reported as `CREATOR_CANNOT_POST`). Drafts work from any account.

What the audit needs, all on VoiceOS's side:

- A production TikTok app owned by VoiceOS's organization, with the same products and six scopes, and a Composio auth config for it. Users then reconnect once, through the new app.
- TikTok's review of the Content Posting API with Direct Post: the app's website, Terms of Service and Privacy Policy, and a demo video of the posting flow, checked against TikTok's Content Sharing Guidelines.
- After approval, creator info returns the wider audiences, and the cards list them with no code change. Update the "Only me until TikTok audits the app" wording in `src/tools.ts`, `src/mcpServer.ts`, `scripts/build.ts`, `src/tools/helpers.ts`, `src/errors.ts`, `confirm-card/card-logic.js` and the README.

How the direct-post cards (`confirm-card/`) and the server's `directRules` (`src/tools/writes.ts`) meet those guidelines:

| Guideline | What the code does |
|---|---|
| Show who's posting | The card shows `creator_nickname` from creator info. The server refuses a card whose nickname or audience list differs from its `post_token` (`TOKEN_STALE`). |
| The user picks the audience; nothing is preselected | The card lists only the account's `privacy_options`, none selected, with a "Pick who can see this post" prompt. It preselects an audience only when the user named that audience by voice and the account allows it. When the user asks for a wider audience than the account allows, privacy stays empty and the user picks. The server refuses an empty or unlisted choice (`PRIVACY_MISMATCH`). |
| Interaction settings | Comments, Duet and Stitch start off unless the user asked (photos have comments only). Any the account turned off are greyed out and sent as off. |
| Commercial content disclosure | A "Commercial content" toggle opens "Your brand" and "Branded content", with TikTok's label lines ("Promotional content", "Paid partnership"). The server refuses disclosure with neither picked (`DISCLOSURE_INCOMPLETE`), and branded content as Only me (`BRANDED_PRIVATE_BLOCKED`). |
| Consent line | Always shown beside the Post button: "By posting, you agree to TikTok's Music Usage Confirmation", plus the Branded Content Policy when branded content is on, both linked. |
| Duration limit | `query_creator_info` flags a video longer than the account's `max_duration_sec`, and the server refuses it (`FILE_TOO_LONG`). If creator info is over 10 minutes old when the write's turn comes, the server fetches it again and re-checks the audience and length. |
| Preview, editable text, processing notice | The card plays a small preview of the video (or a photo stack) above an editable caption. The posted card says it may take a few minutes to show on the profile. |

Two gaps remain. The card preview is small (about 1,100 characters for a video), because a card shows only what the agent passes in the call. And a card can't disable VoiceOS's Post button while disclosure is incomplete; the card shows the rule, and the server refuses.

## Open approvals

None of these block QA.

- [ ] **Transcript hook: VoiceOS sign-off.** VoiceOS sends everything the user says to the agent to a hidden `voiceos_hook_transcript` tool (`src/conversation.ts`; manifest permission `transcript`, scope `agent`), which checks the words in memory and, when they're about a TikTok video handled in the last 45 minutes, adds a note of up to 450 characters naming that video and the next step. It keeps none of the words and logs only the note's length; the note is built from the send history and an in-memory record of the video in progress (`src/session.ts`), which lapses 2 hours after its last use.
- [ ] **Publisher branding.** `icon.png` and the card mark embedded in `widgetKit.ts` (`INTEGRATION_MARK`, drawn on result and confirmation cards) are TikTok's logo, which TikTok doesn't allow without permission. Replace both, with a neutral icon or with TikTok's permission. `publisher` in the manifest is still Studio's default ("Made in VoiceOS"), and the build keeps whatever the manifest has.
- [ ] **A team-owned relay**, deployed and verified as above, with an owner for its Cloudflare account, token and TikTok URL property. The photo tools stay disabled until then.
- [ ] **The TikTok audit**, on a VoiceOS-owned production TikTok app (see "TikTok audit").
- [ ] **The setup fields**, replaced by a VoiceOS-managed connection (see "Setup fields to remove").
- [ ] **New tools need sign-off first.** The 12 tools are the approved list, and `tests/manifest.test.ts` pins it.

## Known limits and risks

- **Toolkit pin.** Every Composio tool call pins `TIKTOK_TOOLKIT_VERSION` (`20261101_00`, `src/config.ts`), and a direct post depends on `publish: true` (videos) and `post_mode: "DIRECT_POST"` (photos) in `src/client.ts`. The argument tests run against our own mock, so a newer toolkit that dropped or renamed `publish` or `privacy_level` would still pass them, and a post could quietly land in drafts (the completion card would just say "Sent to TikTok drafts"). Bump the pin only after re-pulling Composio's schemas at the new version and re-running the live checks; live Only me posts confirm it works at `20261101_00`.
- **Upload host.** Video staging PUTs the file to a presigned URL on one Composio-owned Cloudflare R2 host, hard-coded as `COMPOSIO_UPLOAD_HOST` in `src/config.ts`, and the build writes that host into the manifest's network permission. If Composio moves buckets, uploads go to a host the manifest doesn't declare, and can fail, until someone updates the constant and rebuilds. The first upload to each host logs `[tiktok] composio upload host <host>` (`src/client.ts`).
- **Unknown video length.** The length comes from the file's MP4/MOV header (`src/media.ts`), or from Spotlight on macOS. When neither has one, for example in a fragmented MP4 with no duration in its header, the server skips its length checks (the account's maximum for direct posts, TikTok's 10 minutes for drafts), and TikTok refuses a too-long video only after the whole upload (`duration_check_failed`, shown as "Video too long").
- **Relay token.** The relay has one shared bearer token and no per-client quota, so anyone holding it can put JPEG or WebP images at public URLs under the TikTok-verified prefix for 2 hours. Add per-tester tokens or a rate limit to the worker before handing it out.
- **`COMPOSIO_USER_ID` left at `default`.** The server then adopts whichever Composio user owns the configured connection id (`autoUser` and `adoptOwner` in `src/client.ts`), so in a shared Composio project a wrong connection id would read from, and after a card click post to, someone else's TikTok. Testers in a shared project should set their own user id, which makes the server refuse another user's connection; the field goes away with the VoiceOS-managed connection.
- **Receipts aren't secret.** A receipt is an unkeyed SHA-256 of the tool, a time, a nonce and the arguments on the card (`src/receiptCoreScript.ts`), so anyone with the arguments can compute one. It stops the agent from approving its own write, but it's no defense if Ask before every action is off and injected content gets a receipt computed. The four writes set `hidePermissionToggle: true` in the manifest; keep Ask before every action on.
- **Local data.** `ledger.json` keeps up to 100 sends for 30 days, with file basenames and the captions, titles and descriptions the user approved, clipped to 150 characters (`src/ledger.ts`). Beside it, `ledger-pictures.json` keeps stills of the 8 newest sends and `spent-receipts.json` keeps receipt digests, all in `~/Library/Application Support/VoiceOS/integration-state/com.voiceos.generated.tiktok/` on macOS or `%APPDATA%\VoiceOS\integration-state\com.voiceos.generated.tiktok\` on Windows, outside the install folder, so reinstalls keep them (`defaultStateDir` in `src/config.ts`).
- **Video location.** Videos upload exactly as they are on disk (`stageFile` in `src/client.ts`), so a location the camera saved goes to Composio and TikTok. Photos are redrawn as new JPEGs (`src/images.ts`), which drops their location. The README says so; removing it from videos would mean rewriting the file before upload.

## How to verify

From `integrations/tiktok/`:

```sh
bun install --frozen-lockfile
bun run build            # src/ and confirm-card/ → server.ts, the manifest, read-only preview fixtures
bun test                 # offline suite against loopback mocks of Composio and the relay
bun run verify           # starts server.ts the way VoiceOS does and calls the tools over MCP, against the mock
bun verify.ts --package  # the five shipped files alone, in an empty folder with an empty Bun cache
```

None of these reach real Composio, TikTok or a relay: test base URLs must be loopback (`src/config.ts`), and no write has a preview fixture.

`server.ts` is built with one Bun, 1.3.14, the version VoiceOS bundles (`BUILD_BUN_VERSION` in `scripts/sources.ts`), because Bun versions bundle the same source with different variable names. On another Bun, `bun run build` switches to VoiceOS's bundled Bun when it's installed, and warns otherwise. The build stamps `server.ts` with the Bun it used and a SHA-256 of every input (`src/`, `confirm-card/`, `widgetKit.ts`, the build scripts and `package.json`, whose dependency versions are exact pins; not `bun.lock`, which the club CI's plain `bun install` may rewrite), and `tests/manifest.test.ts` fails until a stale or differently built bundle is rebuilt and committed. That check runs inside `bun test`, so the club CI runs it too.

The club CI (`.github/workflows/ci.yml`) runs on `ubuntu-latest` only. For each changed integration it fails on a committed `.env`, requires `*.test.ts` files and both `darwin` and `win32` in `supportedPlatforms`, then runs `bun install` and `bun test`. It doesn't run the build or either verify, and the macOS-only and Windows-only tests skip there. The native Windows and Linux runs (build on Bun 1.3.14, unit tests, `tests/windows.test.ts` and both verifies) come from `tiktok-native.yml` on a `ci/` branch of the PR author's fork, outside this PR, so reviewers shouldn't read the club CI's green check as Windows coverage.

## Changes after QA (2026-11-11)

Version 1.3.2. Every change has unit tests that fail on 1.3.1; none of it ran against real Composio or TikTok.

- **Unknown, not failed.** When Composio reports a write as failed without TikTok's own error code, the result is now "Not sure it went through" (`OUTCOME_UNKNOWN`), so the user checks before sending again instead of posting twice. The next write checks the connection afresh (`src/client.ts`).
- **Stats without the profile scope.** The retry asks only for stats and basic fields. It used to ask for `username` again, a `user.info.profile` field, so it failed the same way. A plain stats question gets the retry too (`src/tools/reads.ts`).
- **No preselected audience.** For "make it public" on an unaudited app, the agent now shows the card with privacy empty, and the user picks; it used to be told to fill in Only me (`src/tools.ts`, `src/mcpServer.ts`).
- **Relay batches** are deleted only when TikTok reports a final status (inbox, posted or failed). They used to go at any status but `PROCESSING_DOWNLOAD`, `PROCESSING_UPLOAD` included, which can come before TikTok pulls the photos (`src/tools/writes.ts`).
- **Child processes** (sips, osascript, PowerShell, FFmpeg) no longer inherit the Composio key, the relay token or the other setup variables (`src/proc.ts`).
- **Card labels are checked.** The server refuses a card whose video length, size or cover time disagrees with the file token or `cover_ms`, or whose photo warning is missing or different, before anything is sent. The card fills the cover label in from `cover_ms` itself (`src/tools/writes.ts`, `confirm-card/card-logic.js`).
- **Files are re-checked at upload time,** right before the upload and again once read, so a re-export saved over the same path after approval isn't sent (`src/tools/writes.ts`).
- **Windows:** PowerShell jobs for folders, file attributes and the clipboard get 15 s for a cold start instead of 5 s, and a job folder Windows won't delete yet (EBUSY) is retried in the background instead of throwing (`src/windows.ts`).
- **`verify.ts`** falls back to the Bun running it, never `bun` by name.
- **Bundle pin and check:** see "How to verify". This commit's `server.ts` is built with Bun 1.3.14.
- **Privacy text:** the manifest description now says the send history keeps approved captions, titles and descriptions for 30 days. The README says the same, and that videos keep their location metadata while photos lose it.
- **Flaky tests:** the relay 409 test sometimes counted two PUTs because a PUT aborted in the previous test was still on a pooled socket and reached the shared mock relay after `reset()`; each relay test now gets its own mock relay. The microPreview decoder check (about 2,200 decodes, 7.7 s on slow cores) gets a 30 s limit instead of Bun's 5 s default. `src/relay.ts` didn't change.
