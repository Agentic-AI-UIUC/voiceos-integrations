# TikTok (UIUC-2): handoff

This is a VoiceOS integration for TikTok that goes through Composio (OAuth2, with a customer-owned TikTok developer app). The runtime code lives in `src/`, bundled into `server.ts` by `bun run build`. `AGENTS.md` has the file layout and the dev loop. `README.md` is the user-facing page.

- Manifest: id `com.voiceos.generated.tiktok`, version `1.2.1`, runtime `bun server.ts`, macOS only.
- Composio: REST v3.1, TikTok toolkit version `20261101_00`, auth config `ac_xN0VP3Mx-Y0W` (the sandbox QA config in "Current status"; production needs a new one for the VoiceOS-owned TikTok app, see "Before production").
- Status: unit-tested against loopback mocks (868 tests; `bun test`, `bun run verify` and `bun verify.ts --package` pass as of 2026-11-10, after the UI and commands pass below) and **used live inside VoiceOS 0.1.40** on the owner's sandbox app and test account (reads, drafts, direct video posts, a photo carousel). Not published yet: VoiceOS runs it as a local-folder install, with no share link. See "UI and commands pass", "Overnight pass" and "Current status".

## Continuation verification (2026-11-10)

Recovered the rate-limited session at its six-photo episode-one carousel cover case. Source remained intact; the generated bundle was rebuilt from `src/` and `confirm-card/`.

- Build, 868 unit tests, `bun run verify`, and `bun verify.ts --package` all pass on this Mac. Automated checks use only loopback mocks; real sends below were separately approved live UI tests.
- All 12 tools have been exercised in the real VoiceOS agent. Added casual prompts for the crying cover, photo post and draft, status by description, metadata search (vertical / exported today / about a minute), drafts → post with changed caption/tags and cover at 0:05, cancellation, missing episode 99, public list, and metrics by public URL. Reviewed replacement cards were dismissed without sending another episode-one video. Sanitized turns are in `screenshots/live-cases.json`.
- The six episode-one stills posted successfully and a separate draft reached TikTok's inbox. Existing episode one, cast carousel, and new stills carousel are set to Everyone in Studio; the account is public. Public posting through this unaudited integration remains restricted, so subsequent public uploads use TikTok Studio, with the boundary stated explicitly.
- `query_videos` returned episode one's real public metrics (initially 0 views/likes/comments/shares). A public-list request before indexing caught up reported counts unavailable rather than inventing zeroes. The persisted send ledger records the visibility used at the original API send and does not track later manual privacy edits.
- Captures are real desktop crops with wallpaper, and GIFs for moving cards. Removed links to the deleted duplicate PNGs, copied the latest photo-find/cover retakes, and added the actual notification image and revision cases to the index. No captions or titles are drawn over captures.
- Content rendering remains sequential and unlimited-trial-only in the existing ChatGPT/Higgsfield conversation. Episode two's last clip was queued as `f87b7f06-d650-490b-ab56-e9117e89639e`; episodes three to five are scripted there to follow one at a time. Completed clips and job IDs remain under the local `fruit-drama` workspace. Do not claim an episode complete until its final file is assembled and verified.
- Review delivery is a draft PR from `feat/tiktok-integration`, confined to `integrations/tiktok/`. It is not a published VoiceOS share. Windows is explicitly deferred by the owner; only syafino/kidskoding can grant the repository's Mac-only exception. Other release approvals below still apply.

## New-account pass and screenshots (2026-11-10, version 1.2.1)

A fresh TikTok account, **Juicy Drama 🍓 (@rabs.cats)**, now runs the integration. It was added as a sandbox target user, and it's connected through Composio as `ca_zDsAa9g5izLy` under user id `voiceos-juicydrama` (auth config `ac_xN0VP3Mx-Y0W`). VoiceOS's TikTok setting points at it, and the account was private during direct-post testing. The continuation pass made it public, with all existing posts set to Everyone in TikTok Studio, as the owner approved. Real screenshots and GIFs of the working flows are in `screenshots/`, with titles and captions in `screenshots/README.md`. The content is AI-made fruit-drama episodes (Higgsfield Seedance 2.0 through the ChatGPT Higgsfield plugin). Direct video posts carry TikTok's AI-generated label. The photo API has no such flag; captions/bio disclose AI-made content, and drafts can be labelled in TikTok.

Changes found by using a fresh account:

- **One history per TikTok connection** (`src/ledger.ts`, `src/types.ts`, `src/mcpServer.ts`). Before this change, a new account's "recent activity" showed the previous account's drafts and carousels. Each new ledger entry now carries `account`, the first 16 hex of the SHA-256 of the connected account id (the id itself is never stored). Reads (`list`, `latest`, `get`, `byPublishId`, `size`) see only the current connection's entries, and entries written before 1.2.1 are hidden once a connection is configured. Tests: `tests/ledger-account.test.ts`.
- **Sends TikTok never finished** (`src/tools/reads.ts`). A send still processing or uploading 2 hours after it went out reads "Didn't finish" (neutral), not "Processing": TikTok gives a fetch about an hour, and our polling stops at 30 minutes. The agent's words group them as "that TikTok never finished". The three 11-06 carousels showed as "Processing · 4d ago".
- **Plainer card copy** (`src/cards.ts`): no "Sent through VoiceOS" header; "Only me and drafts, from VoiceOS" became "Private and drafts"; "No public posts" became "No public posts yet". Eyebrow labels are quiet grey instead of the accent red. A single found video says "Found it" rather than "Best match". Photo posts in lists show their own title ("Meet the Juicy Drama cast"), falling back to the folder name. File names that carry their own numbers aren't numbered twice ("01 meet the cast", not "1 01 meet the cast"). The meta line keeps the time and privacy whole and shortens the file name instead.
- 868 tests pass. The continuation pass reran `bun run build`, `bun test`, `bun run verify` and `bun verify.ts --package`; all pass.
- **Windows:** the club repo requires `win32` in `supportedPlatforms` since 2026-11-09 (PR #41), unless syafino or kidskoding adds the `macos-only-approved` label. This integration is still macOS only. The owner will add Windows later.

## UI and commands pass (2026-11-10)

The owner asked for a much cleaner UI and for more of what goes into a post (captions, tags, audience) to work by voice, within TikTok's limits. **Not yet seen live in VoiceOS:** after this build, Reload the integration (Integration Studio → My Integrations → TikTok → Reload).

- **Confirmation cards** (`confirm-card/`). The cards are compact and fit the notch without scrolling in the usual cases. Heights: direct video post 376 px (was 592–614, which scrolled), video drafts 340, photo post 415, photo drafts 342.
  - One header line (mark + action). The 9:16 tile is 76 px wide, with the facts beside it: name, one meta line, account and, on direct posts, "Who can view" as a segmented control. Until the user picks, it shows a "Pick one" hint and an amber outline.
  - The composer box starts one line tall (`rows=1`), grows to 5 lines (4 for a photo description), then scrolls inside itself. It re-measures when the card's width changes (ResizeObserver), so a box measured while the host was still laying out never stays tall. This was the "huge caption box" complaint.
  - #hashtags and @mentions are tinted in the accent colour by a mirror div under a transparent textarea, built from text nodes only. A tag has to start a word, so `me@x.com` isn't one.
  - Settings are chips: "Allow" Comments · Duet · Stitch; then AI-generated (or Add music) and Commercial content. Creator-disabled chips are struck through; the "turned off for this account" note is screen-reader only.
  - Counters show only near the limit. A photo title's counter sits inside its line once typed.
  - Removed the ledes under the titles, the "Direct post"/"Drafts" badge and "Posting as"/"Drafts for". What each card does is now its accessible description (`NOTES`).
  - Kept: TikTok's consent line, the disclosure label lines, the branded-content privacy rule, the drafts label "Caption to paste in TikTok", and one visible line on both photo cards, "Photos are hosted briefly for TikTok to fetch, then deleted." (`RELAY_LINE`), because the photos leave the Mac.
  - `hydrate()` now reads the arguments with the staged corrections overlaid, so a folded caption or a generated cover label shows exactly what a click signs.
- **More commands** (`confirm-card/card-logic.js`, `src/tools.ts`, `src/tools/writes.ts`):
  - `hashtags` and `mentions` on all four writes. The card folds them into the signed caption (or the photo description) once each, normalised ("machine learning" → `#machinelearning`), then stages both as `""`.
  - `privacy_level` takes the user's words: everyone/public, followers, friends, only me/just me/private.
  - `cover_ms` takes "0:05", "5s", "1m30s" or "at 0:05". The card stages the milliseconds and a "0:05" `cover_label`.
  - The server drops `hashtags`/`mentions` after the receipt check (`sendable()`), so only the signed text reaches TikTok, and it maps words to codes the same way the card does (a parity test checks both). TKC helpers: `privacyCode`, `foldTags`, `coverMs`, `coverLabel`. Tests are in `tests/card-commands.test.ts`.
  - TikTok's limits still apply: video drafts carry no caption (the tags land in the caption to copy), direct posts are Only me until the audit, and there's no scheduling or editing.
- **Result cards and errors** (`src/cards.ts`, `src/errors.ts`): one title, then at most one short line.
  - The completion card ("toast") dropped the caption quote and the file line; 245 px with a frame (was 291).
  - Status is a pill, a rail while live, and one meta line ("ep01-strawberry-tokens.mp4 · 7 min ago · Only me"), at 159–160 px (was 206–232).
  - Error lines are shorter, with the same meaning; "Nothing was sent" stays wherever it's true.
  - Helper cards lost their eyebrows and footnotes.
  - The posted card keeps TikTok's processing notice: "May take a few minutes to show on your profile."

## Overnight pass (2026-11-05 21:30 → 11-06 10:30)

What changed, and why (all live-tested in VoiceOS unless marked):

- **Server no longer dies after a write (root cause of "TikTok tools aren't available").** VoiceOS runs `bun` from its own PATH, which on a Mac with Bun installed is `~/.bun/bin/bun` (1.3.13 here), not its bundled 1.3.14. On 1.3.13, iterating `Bun.file(path).stream()` ends the process's stdin; the upload MD5 used it, so after every write the server exited once idle. VoiceOS 0.1.40 then marks the integration "error", drops all 12 tools (main.log: `customToolDeclarations` 168 → 156) and never reconnects on its own (only Reload/settings/app start). Fix: `src/client.ts` reads with `node:fs/promises`; `src/main.ts` logs "stdin ended"; `verify.ts` runs the Bun VoiceOS really picks; `tests/stdin-survives.test.ts` guards it. Live: 8 direct posts in a row, still connected after each.
- **What the agent actually sees (VoiceOS 0.1.40, from its code):** MCP `instructions` are never read (only tool descriptions and schemas); each turn gets the last 5 turns as plain text, no tool results; background writes return only `{status:"started"}` to the model; words spoken or typed over an open card go to a classifier (`approve` → sent without the card's receipt → refused; `revise` → the card is dropped and the words continue the same chat; `unrelated` → a fresh chat). The conversation rules therefore live in the tool descriptions (as of 11-10: upload_video 864, publish_video 886 and post_photos 856 chars; the test cap is 900 for the four writes and `find_recent_videos`, 600 for the rest).
- **Conversation steering.** Descriptions now carry: draft vs post wording, "the latest instruction wins" (switch draft↔post, new caption/hashtags, privacy, AI label or "the other one" keeps everything else), privacy words → levels, captions written on request from the title with popular tags (TikTok gives apps no trends data). Live: "upload the video from downloads about strawbery tokens" → drafts card for ep01 (found in Movies) → "acctualli i want it to be apost" → Post card for the same video → "add some trending captions…" → same card with a written caption. "send the enigma recipie video to my drafts" → "wait no post it instead, just me, ai made, caption: …" → posted.
- **Transcript hook (needs syafino's sign-off).** A hidden `voiceos_hook_transcript` (manifest `hooks.transcript`, permission `transcript`, scope agent; not one of the agent's tools, which stay 12) adds one ≤450-char note to TikTok-related turns: the video in progress, the last send, one next step and how to get the token back (`find_recent_videos` `pick:"current"`). Memory only, 1–5 ms, no paths, logs only the length. It reads every utterance the user says to VoiceOS, so it must be signed off before release.
- **Natural-language video finding** (`src/finderParse.ts`, `src/finderMatch.ts`, `src/spotlight.ts`, `src/finderApps.ts`, `src/session.ts`): `describe` (the user's own words) is parsed into time, length, orientation, source (screen recording, iPhone, AirDrop via the quarantine attribute, web download), app, quality, sound, size, order and card position; one batched `mdls` + `xattr` per search; a name match always wins over soft constraints ("not in Downloads; it's in Movies › Tiny AI Lab"); results carry a one-line `descriptor`, `why`, `confidence` (exact/likely/ambiguous/none) and `next`; ambiguous gets one question naming the difference. `source:"finder_selection"`/`"quicktime"` read the Finder selection or QuickTime's open file (first use shows macOS's Automation prompt; denial → `AUTOMATION_DENIED`; **not tested live**), `reveal:true` shows the file in Finder (**not tested live**). `web_download` replaced `downloaded` because the model mapped "from downloads" to it.
- **Photo sets by folder.** `find_recent_images` matches folder names ("the voice clone safety slides" → that folder's 11 images in name order, up to 35), set words (slides, deck, carousel, pics) aren't required, and "the pics I just downloaded" never mixes folders.
- **UI.** iMessage-style photo stack (fanned 3:4 cards, top card flicks to the back on a loop, position pill, cover chip, reduced-motion cross-fade) on the photo confirmation, bundle, completion and status cards; `prepare_photo_post` returns the stack `preview` (server-checked like the video preview) and real thumbnails; video tile 112×199; drafts card caption + copy toggle in one box (no scroll); privacy choice above the fold on post cards; numbered candidate cards with descriptor chips.
- **Sharper confirmation previews (2026-11-06, `p2`/`s2`; in the installed build, but nobody recorded how they look live).** The owner saw "a blank gray box": the 18×32 / 24×32 v1 frames upscaled to a smudge. `src/microPreview.ts` adds version 2: a CDF 9/7 wavelet (luma full size, chroma half) with a binary arithmetic coder and a 12-bit check per frame, at 45×80 for video (80×45 landscape, ≤ 360 chars a frame) and 48×64 for photos (45×80 for tall slides/screenshots, ≤ 295), so a whole `preview` stays ≤ 1,100 chars (video, real shorts 1,052–1,067) and ≤ 1,500 (stack, 11 slides 1,467). Old p1/s1 strings still decode. The server checks (`previewMisleads`/`stackMisleads`) are version-aware and compare decoded pixels, so a copy padded with trailing "A"s isn't refused and another file's frames still are; schema caps 1,100/1,500. Cards: the video tile plays its frames on one canvas (slow Ken Burns push, cross-fades, Stories-style segments, develops from a blur, film grain, click/hover pauses); the stack uses bigger cards (112×149, or 90×160 for tall photos), swipes left on a loop or by drag/click/keys, "+N more" on the last card; no or broken preview shows a designed tile (accent gradient, film glyph and file name / photos glyph and count); numbered slides read "11 slides · in order"; "More below" is a round chevron beside Post, so a two-line title fits above the fold.
- **Live posts this pass (all Only me, account private, AI label on):** ai history speedrun, enigma recipe, prompt glow-up, group chat prompt injection, new hire sitcom, hall of AI mistakes, voice on the phone, AI data center power. Plus last night's behind-the-scenes carousel.
- **Later on 11-06 (live):**
  - Result cards carry real media: a 2.5 s animated video loop (Homebrew `img2webp`, falling back to a JPEG filmstrip, then the poster) on the find, "Ready to post" (query_creator_info) and completion cards; every carousel photo in a swiping iMessage stack.
  - Confirmation cards use the v2 micro-preview codec (wavelet plus arithmetic coder): 45×80 video frames (≤1,100 chars) and 48×64 photo frames (≤1,500).
  - Status by name (`fetch_publish_status` `about`), a persisted ledger (`ledger.json` in the state dir), and `list_videos` `via_voiceos` (Only me posts and drafts) all verified live.
  - The account went public at the owner's request.
  - **API photo posts stuck:** three carousels sat in `PROCESSING_DOWNLOAD`, and `wrangler tail` showed TikTok never fetched the relay URLs, although the signature file was served and the prefix is Verified on the sandbox. Last night's carousel worked in 8.5 s. Unexplained; it may be a per-account throttle after a burst of direct posts. Carousels went through TikTok Studio web (Photos tab) instead.
- **Known gaps:** VoiceOS never shows agent text before a card, so card turns have no spoken line (the transcript hook carries the video name across turns instead); a find result is 50–100 KB because VoiceOS forwards the whole result, card HTML with base64 posters included (whether its backend strips `_voiceos_glance` before the model is unknown); Finder selection, QuickTime and reveal are untested live.

## Terms

- **publish_id**: TikTok's id for an upload or post in progress (≤ 64 chars). Every write returns one; `fetch_publish_status` takes it.
- **Drafts / inbox**: TikTok's upload mode (video `publish: false`, photos `MEDIA_UPLOAD`). The post lands in the TikTok app's inbox and the user finishes it there. Works without TikTok's audit.
- **Direct post**: posts straight to the profile (video `publish: true`, photos `DIRECT_POST`). Only when the user asks. `SELF_ONLY` until TikTok audits the app.
- **SELF_ONLY**: "Only me" visibility. Unaudited apps can only post this way, and only from private accounts.
- **Creator info**: TikTok's posting options for the account (nickname, allowed privacy levels, interactions the creator turned off, longest allowed video). `query_creator_info` fetches it right before a direct post.
- **Carousel / photo post**: 1–35 photos, converted to JPEG, that TikTok pulls from URLs on a domain verified for the TikTok app.
- **Media relay**: a short-lived image host that TikTok pulls carousel photos from (plan §4.4). Built in `relay-worker/` (a Cloudflare Worker, not shipped). A test copy runs at `tiktok-media-relay.rishabh-rb.workers.dev`, with its `/p/` prefix verified in the sandbox TikTok app; production needs a team-owned, TikTok-verified subdomain. Its base URL is `MEDIA_RELAY_BASE` in `src/config.ts`.
- **Composio user id, connected account, auth config**: the `user_id` the TikTok connection belongs to (`COMPOSIO_USER_ID`, default `default`); Composio's record of the user's TikTok OAuth (`ca_…`); the custom OAuth config that holds the TikTok app's client key and secret (`ac_…`).
- **Toolkit version**: the Composio TikTok toolkit version every execute call pins (`20261101_00`).
- **Confirmation receipt**: what a confirmation card stages: a SHA-256 digest over the exact arguments on screen, plus a time and a nonce. A write without a valid, fresh (≤ 10 minutes) and unused receipt is refused.
- **Spent receipt**: a used receipt's digest, stored so it can't be used again, also across restarts.
- **Server tokens**: `file_token`, `image_token`, `bundle_token` and `post_token`. Opaque HMAC tokens the helpers return, so the model never handles file paths, and the server can check which file, photos and creator options were approved.
- **Background tool**: a write declared `execution.mode: "background"`. VoiceOS gives the agent a task handle at once, shows the task in the side notch, and chimes with the final card.
- **Completion card**: a background write's final card. It plays the ticket's "toast": VoiceOS has no toast primitive.
- **Ledger**: the last 100 writes from the past 30 days (stage, `publish_id`, what was sent), saved to `ledger.json` in the state folder so it survives restarts and Reloads. On disk, captions are clipped to 150 characters and files are basenames; card pictures stay in memory for the newest 20 only. It answers "did it go up?" when no `publish_id` is given.
- **Content Credentials (C2PA)**: provenance data inside a file. TikTok reads it to auto-label AI content. Converting photos removes it.

## Before you ship

- [ ] syafino signs off on the tool list: the 12 tools, including the four agent-only helpers, the photo tools and the relay, the `publish_video` slug change and the opt-in "Copy caption" clipboard write (plan §2.1; message template §13.4a).
- [~] Run spikes S1–S13 (plan §10.2) and the live matrix (§10.3) inside VoiceOS, then fill in "Current status". **Done live on 2026-11-04/05:** S1, S2, S3, S4, the drafts write (S12 click path, S13 background), the direct-post refusal, list/query fields, the typed-yes refusal (spoken words take the same path) and the late-click card (both under S12 below). **Still open:** the photo spikes (S7 half done, see "Photo carousels"; S9–S11 not run), the "Ask before every action" off refusal, a real expired token.
- [ ] Remove the temporary setup fields `COMPOSIO_API_KEY`, `COMPOSIO_USER_ID`, `COMPOSIO_CONNECTED_ACCOUNT_ID` and `MEDIA_RELAY_TOKEN` (Excel pattern; each one says "temporary" in its title or description). Decide the replacements with VoiceOS. Excel's handoff records that Dario approved the paste-key and manual account-id setup for v1 QA, and that the production migration belongs to the VoiceOS team. Get the same answer for TikTok, including the relay token.
- [x] Network permission: `backend.composio.dev` + the real presigned upload host, confirmed live (S2): Cloudflare R2 `temp.4d4f16c61d89ec64e760039c4ec50717.r2.cloudflarestorage.com`, now `COMPOSIO_UPLOAD_HOST`. The build also lists the test relay host (while `MEDIA_RELAY_BASE` is set) and TikTok's two image CDN hosts, `p16-common-sign.tiktokcdn-us.com` and `p19-common-sign.tiktokcdn-us.com`, for profile pictures and post covers in result cards (`src/covers.ts`). Swap the relay host when the relay moves.
- [x] Toolkit pin: raw schemas at `20261101_00` pulled into `tests/fixtures/schemas/` (S3); returned list/query fields recorded under "How it behaves".
- [~] macOS file access (S1): from inside VoiceOS, Downloads, Desktop and Movies (one subfolder level) were read with no prompt on this Mac. `~/Pictures` and the screenshot folder aren't recorded as exercised yet.
- [~] Consent paths (S12): **a click sends** (verified live twice: drafts and direct post; the receipt was spent). **A typed "yes" is refused** like a spoken one (VoiceOS drops the staged receipt; `CONFIRMATION_REQUIRED`, reason `missing`, nothing reached TikTok), verified live three times. **A card left open stays valid by design**: it re-mints its receipt while visible (`confirm-card/card-dom.js`), so clicking after 11 minutes sent the draft (verified live). The 10-minute TTL only stops a receipt that stopped refreshing (a captured or replayed one). Still to check: "Ask before every action" off is refused.
- [~] Background writes (S13): verified the card confirms first and the task completes (drafts ~46 s for 56.5 MB) or fails cleanly (direct post). Not measured: how long VoiceOS keeps a task alive past ~1 minute.
- [ ] Icon: `icon.png`, and the `INTEGRATION_MARK` that `widgetKit.ts` draws in card headers, are TikTok's logo. TikTok's guidelines forbid using its logos "without our prior written permission" unless they come from the official asset pack. syafino decides before Publish: the official asset pack (following TikTok's Brand and Use Guidelines) or a neutral icon.
- [ ] Check `publisher` in `voiceos.integration.json` (Studio default "Made in VoiceOS" vs. author credit).
- [ ] Decide with syafino: upload videos as they are (location metadata included, as now and as the README says), or strip location first with an `avconvert` passthrough (plan §9).
- [ ] Decide with syafino: photos whose Content Credentials say AI, on `post_photos`: refuse (strict), or warn and steer to drafts (what's built; plan R-N36).
- [x] State: the spent-receipt file was created at `~/Library/Application Support/VoiceOS/integration-state/com.voiceos.generated.tiktok/spent-receipts.json` on the first live write (digests only). The post ledger now persists beside it as `ledger.json` (see Terms).
- [ ] Done flow (plan §12): post the auth config id and slug map; publish, then test a fresh install from the share link (`bun verify.ts --package` simulates one); send the share link and version to syafino; open the PR from `integrations/tiktok/` on `feat/tiktok-integration` with the share link; move UIUC-2 to In Review; post in the Discord thread.

## What we built

### Slug map (post this, as for UIUC-1)

```
TikTok (UIUC-2) — auth config: ac_xN0VP3Mx-Y0W (sandbox) — toolkit version: 20261101_00
get_user_stats        → TIKTOK_GET_USER_STATS
list_videos           → TIKTOK_LIST_VIDEOS
query_videos          → TIKTOK_QUERY_VIDEOS          (post details)
fetch_publish_status  → TIKTOK_FETCH_PUBLISH_STATUS
upload_video          → TIKTOK_UPLOAD_VIDEO {publish:false}          (default video write; drafts/inbox)
publish_video         → TIKTOK_UPLOAD_VIDEO {publish:true}           (on request; SELF_ONLY until audit)
upload_photos         → TIKTOK_POST_PHOTO {post_mode:"MEDIA_UPLOAD"} (default photo write; needs media relay)
post_photos           → TIKTOK_POST_PHOTO {post_mode:"DIRECT_POST"}  (on request; SELF_ONLY until audit; needs media relay)
query_creator_info    → TIKTOK_QUERY_CREATOR_INFO    (visibility: agent)
find_recent_videos    → (local helper)               (visibility: agent)
find_recent_images    → (local helper)               (visibility: agent)
prepare_photo_post    → (local helper)               (visibility: agent)
—                     → TIKTOK_PUBLISH_VIDEO         (not exposed: URL pull only)
—                     → TIKTOK_UPLOAD_VIDEOS         (not exposed in v1)
```

### The 12 tools

| Tool | Title | Visibility | Runs |
|---|---|---|---|
| `get_user_stats` | TikTok profile stats | user | sync |
| `list_videos` | My recent TikTok posts | user | sync |
| `query_videos` | TikTok post details | user | sync |
| `fetch_publish_status` | TikTok post status | user | sync |
| `query_creator_info` | TikTok creator posting options | agent | sync |
| `find_recent_videos` | Find recent videos on this Mac | agent | sync, local |
| `find_recent_images` | Find recent photos and screenshots on this Mac | agent | sync, local |
| `prepare_photo_post` | Prepare a TikTok photo carousel | agent | sync, local |
| `upload_video` | Send video to TikTok drafts | user | background (est. 120 s), confirmation card |
| `publish_video` | Post video to TikTok | user | background (est. 180 s), confirmation card |
| `upload_photos` | Send photo carousel to TikTok drafts | user | background (est. 120 s), confirmation card |
| `post_photos` | Post photo carousel to TikTok | user | background (est. 180 s), confirmation card |

### How it behaves

- **Reads** run with no prompt and show a glance card. `get_user_stats` always returns the display name and username with the four counts; `include_profile` adds bio, verified badge, avatar and profile link. `list_videos` returns up to 20 public posts per page (`cursor` in UTC ms). `query_videos` takes 1–20 ids and parses hashtags and mentions. `fetch_publish_status` with no id answers from the newest ledger entry.
- **Drafts are the default** for videos and photos. Direct posts happen only when the user asks, and are `SELF_ONLY` until the audit.
- **Video drafts carry no caption or privacy** (TikTok's limit). If the user gives a caption, the card shows it as "to paste in TikTok" and offers "Copy caption", off by default. When the user turns it on, the write copies the caption with `pbcopy` at the start. The clipboard is never touched otherwise.
- **Photo drafts carry the title (≤ 90) and description (≤ 4,000)** into TikTok's editor. They need TikTok app 31.8 or later.
- **Direct-post cards** follow TikTok's Content Sharing Guidelines: the creator's nickname; a privacy picker with only the creator's options and nothing preselected; Allow comments, Duet and Stitch off by default and greyed out when the creator turned them off; commercial disclosure (Your brand / Branded content) with TikTok's label prompts; branded content can't be Only me; an AI-generated toggle (video only); the music-usage consent line; the processing notice. The server re-checks all of it.
- **Consent.** Four widget confirmation cards (`confirm-card/`). Each stages a `confirmation_receipt`. The server checks it when the call arrives, before queueing and before anything is uploaded: it must match the arguments, be at most 10 minutes old (and not more than 2 minutes in the future), and be unused. Spent digests persist in the state file above. The four writes have `hidePermissionToggle: true`.
- **Writes run as background tools**, one at a time per account. A queued direct post that starts more than 10 minutes after its creator info was fetched re-fetches it, and refuses (sending nothing) if the chosen privacy is no longer allowed. Writes are never retried. A lost answer to the Composio write call (network error, timeout, 502/503/504, empty body) is `OUTCOME_UNKNOWN`: "check TikTok before trying again".
- **Polling**: 5, 10, 20 and 40 s, then every 60 s, until a final status. Then the completion card: "In your TikTok inbox …", "Posted to TikTok as Only me", or the error. After 30 minutes it stops with "TikTok is still processing it. Ask 'did it go up?' any time."
- **Account check before every call** (cached 60 s, refreshed after any auth-shaped error): the connection must be listed under `COMPOSIO_USER_ID` for the TikTok toolkit, `ACTIVE` and not disabled. `EXPIRED` → `AUTH_EXPIRED`; `REVOKED`, `INACTIVE`, `FAILED` or disabled → `AUTH_REVOKED`; missing or still connecting → `NOT_CONNECTED`; a rejected key → `NOT_CONFIGURED`.
- **Video staging**: streamed MD5 → `POST /files/upload/request` → PUT to the presigned URL (with `x-ms-blob-type: BlockBlob` on Azure storage; no PUT when Composio already has the file) → `file_to_upload`. The API key never goes to the presigned host. A failure here is `UPLOAD_FAILED`: nothing reached TikTok.
- **Photo pipeline** (after approval only): one `sips -j` canvas pass (fixes orientation, fits within 1080 × 1920, white under transparency, drops EXIF and GPS) and one `sips --matchTo` sRGB pass at JPEG quality 85. Each output is checked (JPEG bytes, ≤ 20 MB, else re-encoded at 75). Work happens in `$TMPDIR/tiktok-*`, swept after 2 hours. Then a relay batch, 4 PUTs in parallel, `TIKTOK_POST_PHOTO` with the public URLs in carousel order, and the batch is deleted once TikTok has the photos, or right away if anything fails before the TikTok call.
- **Content Credentials**: `prepare_photo_post` flags C2PA data and AI source types and returns a warning line for the card. For AI-flagged photos the agent offers drafts first, so the user can turn on TikTok's AI label in the app.
- **Rate limits** (token buckets): creator info 20 a minute, write inits 6 a minute across all four writes, status checks 25 a minute.
- **Errors**: TikTok's `error.code` and `fail_reason` maps and every user-facing line are in `src/errors.ts`. TikTok errors inside an HTTP 200 answer are caught.
- **Fields Composio returns for list and query** (live, 2026-11-04): `id, title, video_description, create_time, duration, width, height, view_count, like_count, comment_count, share_count, cover_image_url, share_url, embed_link, embed_html`. A new post appears in `list_videos` once TikTok's review finishes (~5 min; it shows as "Only me / under review" in Studio until then).
- **The 1080p rule**: assumed short side ≤ 1080 and long side ≤ 1920 until S9.

### Photo carousels: on, through a test relay

The photo tools are on. `MEDIA_RELAY_BASE` in `src/config.ts` points at the test relay (`relay-worker/`, deployed at `tiktok-media-relay.rishabh-rb.workers.dev`, with its `/p/` prefix verified in the sandbox TikTok app), so the build lists the relay host in the network permission and leaves the four photo tools enabled. Each tester needs a `MEDIA_RELAY_TOKEN` (Configure → "Media relay token"); without one, any photo write throws `RELAY_NOT_CONFIGURED` before doing any work. Empty `MEDIA_RELAY_BASE` and rebuild, and the four tools ship `disabled` again ("Photo carousels need the media relay, which isn't set up yet.").

Live so far: one direct carousel went through on the night of 11-05, in 8.5 s. On 11-06, two direct posts and one draft sat in `PROCESSING_DOWNLOAD` and TikTok never fetched the relay URLs (see "Overnight pass"; all three are still `processing` in `ledger.json`). Those carousels went out through TikTok Studio instead. Still to run: S7's draft half (a 2-photo draft), S9, S10 and S11.

To move to a production relay:

1. Deploy `relay-worker/` on a dedicated, team-owned subdomain and verify it in the TikTok app (Manage URL properties → Domain), meeting the plan §4.4 contract (no redirects on GET, ≤ 2-hour lifetime, Bearer auth).
2. Set `MEDIA_RELAY_BASE` in `src/config.ts` to its base URL.
3. Run `bun run build` (it puts the new relay host in the network permission), then `bun test && bun run verify`.
4. Give each tester a `MEDIA_RELAY_TOKEN` for the new relay.
5. Reload in VoiceOS, then rerun S7 (a 2-photo draft and a 2-photo direct post), S9, S10 and S11.

## Current status

### Live results (2026-11-04/05, with the account owner's permission)

- **Setup in use:** Composio project `rishabh.rb_workspace_first_project`, auth config `ac_xN0VP3Mx-Y0W` ("VoiceOS TikTok Sandbox", custom OAuth2, unaudited sandbox TikTok app), connection `ca_WY7YOKgrGuZT`, owned by Composio user id `voiceos-tiktok`. The TikTok account is now **Tiny AI Lab (@thetinyailab)**.
- **S3 (schemas):** pulled at `20261101_00` into `tests/fixtures/schemas/`. The pin exists and every slug resolves.
- **S4 (reads through `server.ts`, `scripts/live-read.ts`):** `get_user_stats` (with profile), `list_videos`, `fetch_publish_status`, `find_recent_videos` all OK on VoiceOS's bundled Bun; a stats read takes ~0.9–1.4 s including the account check.
- **Fixed: COMPOSIO_USER_ID.** The installed config had no user id, so 1.1.0 would have failed every call with "connected under a different Composio user ID". When the field is empty or `default`, the server now adopts the connection's owner (one extra list call, cached with the account check). An explicit user id stays strict. Tests in `tests/client.test.ts`.
- **S2 (upload host):** `/files/upload/request` returns Cloudflare R2 presigned URLs on `temp.4d4f16c61d89ec64e760039c4ec50717.r2.cloudflarestorage.com`, not `storage.composio.dev`. `COMPOSIO_UPLOAD_HOST` and the manifest's network permission now list the real host. Staging a small MP4 (request + PUT) works live.
- **S12/S13 (first real write, inside VoiceOS 0.1.40):** typed "Send my newest video … to my TikTok drafts" → `find_recent_videos` → the `upload_video` widget card (file, 0:37, 56.5 MB) → clicked **Send to drafts** → the receipt was spent (state file created) → background task ran: R2 staging, `TIKTOK_UPLOAD_VIDEO {publish:false}`, status polling → completed in ~46 s for a 56.5 MB file. "Did my TikTok video go up?" → `fetch_publish_status` from the ledger → "In your inbox" card. The draft is in the TikTok app's inbox.
- **Driving VoiceOS without a microphone:** `~/claude-shorts/tools/voiceos/vos` (CDP on a `--remote-debugging-port=9333` launch) types prompts through the notch's own `agent-text-send` IPC, clicks card buttons with real mouse events, and runs Integration Studio's Reload (`vos reload-integration tiktok`).
- **Direct post on the public account (live):** "Post my strawberry video … directly to TikTok, visible only to me" → `query_creator_info` → the `publish_video` card (Posting as Tiny AI Lab, caption, privacy picker, interactions, music-usage line) → clicked **Post** → TikTok refused (`unaudited_client_can_only_post_to_private_accounts`) → task `failed`, and "Did my direct TikTok post go through?" shows the mapped `PRIVATE_ACCOUNT_REQUIRED` card ("Switch your account to private in TikTok, then try again"). Nothing was posted; the error path is honest end to end.
- **S1 (file access inside VoiceOS):** `find_recent_videos` found `~/Movies/Tiny AI Lab/ep01-strawberry-tokens.mp4` from inside VoiceOS with no privacy prompt (Downloads, Desktop and Movies all readable on this Mac).
- **Unaudited app = drafts for public accounts.** TikTok blocks direct posts from unaudited clients unless the account is private (`unaudited_client_can_only_post_to_private_accounts`), so on a public account `publish_video` can't succeed until the audit; `upload_video` (inbox drafts) is the live path.

### Code changes in this pass (2026-11-04/05)

- `src/client.ts`: user-id auto-adopt (above), with tests in `tests/client.test.ts`.
- `src/config.ts` / `scripts/build.ts`: the real upload host; the user-id setup description now says "leave as default".
- **UI pass** on `src/cards.ts`, `src/format.ts` (`percent()`), `confirm-card/**`: the recent-posts card has a totals strip (views, likes, engagement = (likes+comments+shares)/views), per-post view bars with the top post accented, at most 5 rows plus "Showing 5 of N"; the profile card has a monogram avatar, avg likes/video and a get-started line at 0 videos; post details show four numbers and engagement; confirmation cards lead with what will happen and a share-sheet style file row, and fade scrolling content under the footer. The video-drafts card no longer scrolls (350 px). `src/tools/helpers.ts` passes width/height so landscape recordings get a landscape tile. Before/after renders: `scripts/render-cards.ts`.
- `scripts/live-read.ts`: live read smoke against real Composio (refuses writes).
- **Failed writes read as words in VoiceOS's task panel.** Found live: the panel prints a failed background task's text verbatim (all text blocks, joined) and doesn't render its card, so our JSON showed raw. `leadWithWords` (`src/results.ts`) now gives a failed or refused write a plain-words text ("Not sent. Nothing reached TikTok. Say 'post it' again, then click…") and moves the JSON, card included, to MCP `structuredContent`; `parseResult` and `verify.ts` read it from there. Successes and reads keep the one-JSON-block shape.
- **Refused writes are in the ledger.** A refusal (no receipt, stale token, bad card values) now records a `failed` entry with its error code and no media names, so "did it go up?" answers about that attempt instead of an older one (verified live). Test: `tests/tools.unit.test.ts` "after a refused write…".
- **Counts read right at one.** Found live on a new account ("5 followers and 0 likes across 1 public videos"): read summaries now use `plural()` (moved from `src/cards.ts` to `src/format.ts`), so it's "1 follower", "1 public video", "1 view", and a one-post list reads "Your latest public post has N views." Test: "summaries use the singular for a count of one".
- Seen live, not ours to fix: right after a post goes public, TikTok's `video_count` in user stats lags the post list (1 vs 3 on 2026-11-05 06:33). The agent noticed and said so; the summaries report each number as TikTok gave it.
- Checks: `bun test` 573 pass / 0 fail, `bun run verify` and `bun verify.ts --package` pass (2026-11-05 06:40, after all the changes above).

### Before the live run (historical: the state on 2026-11-04)

- **Nothing had been tested live** (this paragraph describes the state before 2026-11-04 night). Spikes S1–S13 (plan §10.2) and the live matrix (§10.3) haven't been run. No call has gone to real Composio or TikTok: OAuth, the account check, video staging and its upload host, every slug and argument shape, the returned fields, the status values, the error codes and every timing are unverified. This build's only checks are the unit tests below, against loopback mocks. (Some macOS pieces, such as the `sips` script, the MP4 reader and the Content Credentials check, were tested locally during the plan's research: verification log §2.5 and §4.)
- Target: VoiceOS 0.1.40 with its bundled Bun 1.3.14 (developed on Bun 1.3.13).
- `bun test`: 561 pass, 0 skip, 0 fail (2026-11-04, Bun 1.3.13). The darwin-only suites ran on macOS 27.2.
- `bun run verify` on VoiceOS's bundled Bun 1.3.14 with the JIT off: 63 of 63 checks pass. `bun verify.ts --package`: 65 of 65 pass (the five shared files alone, empty Bun cache).
- The server's 12 tools match the manifest both ways (`verify.ts`), and the four photo tools are `disabled` (`tests/manifest.test.ts`).
- Published: not yet. No share link yet; the version to publish is 1.1.0.
- Measured times (a stats read, a 60 MB drafts upload, a carousel of 8): not measured, because nothing has run live.
- Not tested at all: a real expired or revoked token, a TikTok app older than 31.8, a 4 GB file, macOS privacy prompts for the folders, how long VoiceOS keeps a background task alive, the media relay (not built).
- This replaces version 1.0.0, the first Studio build. Its writes made up `publish_id`s and reported success: the video tools ignored Composio's errors, and the carousel tools never called Composio. Its tools (`check_publish_status`, `upload_video_draft`, `post_video`, `upload_carousel_draft`, `post_carousel`) are gone; an install that still shows them needs a Reload.

## Differences from the spec

- **Helpers beyond the ticket's list.** `find_recent_videos`, `find_recent_images` and `prepare_photo_post` are new agent-only local helpers, and `query_creator_info` (on the list) also mints a `post_token`. A confirmation card can only show what its arguments carry, and the server needs tokens to know which file, photos and creator options the user approved. The new helpers need syafino's sign-off (context §10 item 4).
- **`publish_video` maps to `TIKTOK_UPLOAD_VIDEO` with `publish: true`**, not the ticket's `TIKTOK_PUBLISH_VIDEO`, which only pulls from a public URL. `TIKTOK_PUBLISH_VIDEO` isn't exposed.
- **Photo tools added** (`upload_photos`, `post_photos` and two helpers) through a media relay, because TikTok pulls photos only from a verified domain (context §10 item 3). They're on through a test relay (see "Photo carousels").
- **Connect/disconnect is the Composio dashboard model** (Asana/Excel precedent, plan §3.6). Connect in Composio and paste the connection id. Disconnect by deleting the connection in Composio and clearing the field; the user can also remove the app in TikTok (Settings and privacy → Security and login → Manage app permissions). There's no connect or disconnect tool and no in-app Connect card.
- **"Toast" is the completion card** of the background write: VoiceOS has no toast primitive. Loading states are VoiceOS's own: the side-notch task for writes, its loading state for reads.
- **Video drafts carry no caption**: TikTok's inbox upload takes only the file. The card says so and offers the opt-in "Copy caption".
- **Layout**: `src/` bundled into `server.ts` (GitHub #16 shape, plan §4.1), not the Studio brief's single numbered `server.ts`. The receipt core is `src/receiptCoreScript.ts`, inlined into the cards at build time, not `confirm-card/receipt-core.js`.
- **Runtime `bun server.ts`**, not the generated `/bin/zsh run.sh` that Studio's AGENTS.md said to keep: the share review rejects a shell runtime, and a shared install has no `run.sh`. `run.sh` and `run.cmd` stay, unused.
- **Tool descriptions** are reworded from the plan to avoid words the share review rejected (never, don't, stop, verbatim, "spoken yes"), and each says "Use when".
- **Id and version**: `com.voiceos.generated.tiktok` and `1.2.0` (this rebuild first shipped as `1.1.0`), not the plan draft's id and `0.3.0`. Changing the id would orphan installed settings, and `0.3.0` would look like a downgrade from the installed `1.0.0`.
- **Two gaps against TikTok's posting guidelines**: only a tiny content preview on the cards (TikTok says apps "should" show one; the v2 micro-preview is 45×80 for video, because a card can show only what the model copies into the call), and a widget can't disable VoiceOS's Post button while commercial disclosure is on with nothing picked. The card shows the rule inline and the server refuses (`DISCLOSURE_INCOMPLETE`).
- **Icon**: the Studio brief said to keep `icon.png` neutral. It's still TikTok's logo (see "Before you ship").

## Things that will surprise you

- **A spoken "yes" doesn't post.** VoiceOS 0.1.40 drops the card's staged values when the user approves by voice, so the receipt is missing and the server refuses. The writes run in the background, so the refusal arrives as a "Not sent" completion card, not as a re-shown card. Click the card's button.
- **"Ask before every action" off means no card, so every write is refused.** `hidePermissionToggle: true` hides the per-tool switch on the four writes, but it doesn't force a card.
- **Each attempt needs a new click.** A receipt is spent as soon as the write arrives, before queueing. If the write then fails, even before anything reached TikTok, trying again needs a new card.
- **The receipt holds no secret**, because keys can't go in the manifest. It stops the agent from approving its own write, but anyone who reads the manifest can compute one. Host-signed approvals from VoiceOS would close that.
- **A server restart forgets things.** Server tokens use a per-process key, so every file, image, bundle and post token goes stale (`TOKEN_STALE`) and the agent has to find the file again. The ledger survives (it's saved to `ledger.json`), but the pictures on its cards are kept in memory only.
- **Private (Only me) posts and drafts never show up in `list_videos` or `query_videos`**, which return public posts only. While the app is unaudited every direct post is Only me, so check with "did it go up?" and in the TikTok app.
- **Direct posts need the TikTok account set to Private** while the app is unaudited (`PRIVATE_ACCOUNT_REQUIRED`), and then Duet and Stitch are always off. At most 5 users can post through an unaudited app in 24 hours.
- **5 pending drafts per user in 24 hours**, videos and photos together (`DRAFTS_CAP`). Easy to hit in QA.
- **Captions read back are cut at 150 characters** by TikTok.
- **TikTok rotates refresh tokens** (2-hour access tokens, 180-day refresh tokens, a new refresh token on each refresh). A failed refresh leaves the connection `EXPIRED`: reconnect in Composio.
- **A write whose answer was lost is never retried.** `OUTCOME_UNKNOWN` means "check TikTok before sending again". That includes Composio answering HTTP 200 with `successful: false` and a timeout, a dropped connection or a 5xx in its error, because its backend may have lost TikTok's answer after TikTok took the post. TikTok's own error codes keep their meaning.
- **A card has to name the file it sends.** The card's `file_name` and a photo card's `count_label` come from the agent, so the server compares them with the file or photos behind the token. If they don't match, it refuses (`CONFIRMATION_REQUIRED`, reason `card_mismatch`) before anything is sent. A different case, macOS's narrow space in screen-recording names, or a missing extension still counts as a match.
- **VoiceOS starts the server with no `LANG` or `LC_*`** (12 environment variables on 0.1.40). Without a UTF-8 locale, `pbcopy` turns a copied "Café 🎉" caption into "Caf√© …". So every child process gets `LANG=en_US.UTF-8` (`src/proc.ts`), passed explicitly, because `Bun.spawn`'s default is the environment as it was at startup.
- **A background write can run up to 30 minutes** while it polls, and its card arrives only at the end. Whether VoiceOS keeps a task alive that long is unknown (S13).
- **Videos upload byte for byte with their metadata**, so a recorded location reaches TikTok. Photos are re-encoded, which drops EXIF, GPS and Content Credentials.
- **`widgetKit.ts` carries TikTok's logo too** (`INTEGRATION_MARK`, drawn in card headers), so replacing `icon.png` alone doesn't change the cards.
- **Bun loads a `.env` from this folder automatically**, VoiceOS's launch included, and it fills any setting VoiceOS leaves empty.

## Deferred

- `TIKTOK_UPLOAD_VIDEOS` (batch): not exposed in v1.
- `TIKTOK_PUBLISH_VIDEO` (URL pull): not exposed; local files use `TIKTOK_UPLOAD_VIDEO` with `publish: true`.
- A production media relay: `relay-worker/` runs only on a test `workers.dev` subdomain. Production needs a team-owned subdomain, a domain owner and TikTok URL verification (see "Photo carousels").
- Full-size previews on the confirmation cards (plan R-N16). The cards carry only the v2 micro-preview (≤ 1,100 characters for video, ≤ 1,500 for photos), because a preview has to travel as an argument the model copies. A real one needs a host-resolved image reference from VoiceOS.
- The AI-generated label on direct photo posts: Composio's photo tool has no `is_aigc`. AI-flagged photos go to drafts, to be labelled in TikTok.
- Cancelling a carousel in flight (`cancel_photo_post`, sign-off row 17).
- Editing, deleting or scheduling posts; likes; comments; DMs; trends; sounds; analytics beyond views, likes, comments and shares; more than one account. TikTok has no edit API, so the agent offers a corrected repost instead.
- An in-app Connect card and a "Use my TikTok connection" disconnect toggle (GitHub #16 model; the manifest and state changes are listed in plan §3.6).
- Fast intents for the reads (plan §6.17).
- `.webm` videos (plan R-N31).
- Stripping a video's location before upload (`avconvert` passthrough, plan §9): waiting on syafino.

## Before production

- Confirmed scopes: <the scopes actually granted on the TikTok app and on the Composio auth config>. Requested: `user.info.basic`, `user.info.profile`, `user.info.stats`, `video.list`, `video.upload`, `video.publish`.
- Replace the four temporary setup fields. The relay token needs a production scheme too (signed per-install tokens or VoiceOS-hosted media; plan R-N12).
- Public posting needs TikTok's audit (VoiceOS-side). The production TikTok app must be VoiceOS-owned: an organization owner, a name without "TikTok", an official website with visible Terms of Service and Privacy Policy (URLs verified), a sandbox demo video, and not internal or test-only. Switching apps means a new Composio auth config, and users reconnect.
- Composio direct execution is legacy-but-supported; sessions are the newer path (GitHub #16 uses tool-router sessions). Migration: a session per user with the TikTok toolkit and only the approved tools (tools allowlist, meta tools off), execute through it, and re-test file staging. Sessions pin no toolkit version, so keep a schema-drift guard like #16's `UPSTREAM_SNAPSHOT` that disables an action whose upstream schema changed.
- Toolkit version `20261101_00` is deprecated around Nov 1, 2027 and retired around Feb 1, 2028 (12 months after publication, then 3 more). Watch for the `Composio-Deprecated-Toolkits` header.
- The old TikTok-specific Composio MCP URLs are deprecated; this build doesn't use them.
- The MCP TypeScript SDK v1.x line has guaranteed fixes only until about late January 2027. Plan the v2 move with VoiceOS.
- OAuth callback in use: <exact URL from the Composio auth-config screen; normally `https://backend.composio.dev/api/v3/toolkits/auth/callback`>.
- The relay's ownership, monitoring, token issuance and TikTok domain verification have to survive team changes. Verify only a dedicated subdomain: verifying a domain gives the app every path under it.
- The post ledger is on disk (`ledger.json`: up to 100 writes for 30 days, with captions clipped to 150 characters and file basenames). Confirm that's acceptable to keep.
- Ask VoiceOS for: host-signed approvals (to replace receipts), forwarding staged edits on voice approval, a way for widgets to gate the confirm button, a host-resolved image reference for card previews, and wildcard network domains.
- Also ask VoiceOS (found live 2026-11-06): words over an open confirmation card are classified as approval too broadly ("upload the … video to tiktok" over its own card, "ugh fine post it" over a drafts card). Voice approval also drops the card's staged values, so the integration refuses the send and nothing goes out, yet the agent still says "Started sending". Ask for: approval by voice only on a plain yes; forwarding the card's staged values (updatedInput) on voice approval; and telling the agent when an approval came by voice rather than a click. Also: confirmation widgets can only show what the model copies into the call (no tools, no network, static data), so card previews stay tiny. A host-resolved media reference (e.g. a file token the host turns into a blob for the widget) would let the card show the real video and photos.
- VoiceOS resolves `"command": "bun"` from its own PATH (Homebrew, ~/.bun/bin …) before its bundled Bun. Ask whether integrations can pin the bundled runtime; Bun 1.3.13 had a stdin bug that killed this server after every upload.
- The TikTok client secret stays only in the Composio auth config, never in the repo.

## Dev notes

- Publish ships only `server.ts`, `widgetKit.ts`, `voiceos.integration.json`, `package.json` and `icon.png`. `server.ts` is generated from `src/`; the manifest from the running server and `confirm-card/`.
- Loop: `bun install` (once) → edit `src/` or `confirm-card/` → `bun run build` → `bun test` → `bun run verify` (and `bun verify.ts --package` before a Publish) → VoiceOS Integration Studio → My Integrations → TikTok → **Reload**.
- Don't use Studio's "Edit with AI → Save" on this folder: it reinstalls only `server.ts` and the manifest, and deletes `src/`, `tests/` and `confirm-card/`.
- VoiceOS caches the manifest in `~/Library/Application Support/VoiceOS/config.json`. Reload after every build, and quit VoiceOS if a manifest change doesn't show. A GitHub push doesn't update the installed or published copy: republish after every change.
- Test arguments, loopback only: `--composio-base-url=http://127.0.0.1:<port>/api/v3.1`, `--media-relay-base=http://127.0.0.1:<port>`, plus `--state-dir=<dir>` and `--home=<dir>`. VoiceOS passes none.
- Tests never call real Composio or TikTok, and the preview fixtures cover reads only: VoiceOS's previewer and `verify.ts` really run what they're given.
- Bun auto-loads a `.env` in this folder. Don't keep real values in one while running tests, and never commit one (the club CI fails on it). `.env.example` lists the four names.
- Club repo: `integrations/tiktok/` on `feat/tiktok-integration` (fork, then a PR into `main`). CI runs `bun install` and `bun test` on ubuntu-latest and needs at least one `*.test.ts`. Reviewers: kidskoding or syafino (CODEOWNERS).

### Setup runbook (TikTok app and Composio; details in plan §2.2)

1. **TikTok developer app** (developers.tiktok.com → Register Your App). Register it under an organization; the name can't mention TikTok. Platform: Web. Copy the client key and client secret. The secret goes only into Composio.
2. **Products and scopes**: Login Kit, the Content Posting API with Direct Post turned on, and the Display API product for the reads. Scopes: `user.info.basic`, `user.info.profile`, `user.info.stats`, `video.list`, `video.upload`, `video.publish`.
3. **Redirect URI**: register Composio's OAuth callback under Login Kit → Web, copied exactly from the Composio auth-config screen.
4. **Sandbox (QA)**: create one and add the test TikTok account as a target user (up to 10 accounts; they can take an hour to show up). Only target users can finish OAuth while the app is in sandbox.
5. **Composio auth config**: a custom OAuth2 auth config for TikTok with the client key and secret and an explicit scope list matching the TikTok app. Note its id (`ac_…`). Reconnect after any scope change. Keep the project's callback identity verification off: with it on, a dashboard-started connection can't complete.
6. **Connect**: connect the test account in Composio (the end-to-end OAuth test). Check it's `ACTIVE`, and note its id (`ca_…`) and the user id it's under.
7. **VoiceOS**: Integrations → TikTok → Configure: the Composio project API key (not a `ck_` or `uak_` key), the user id (leave `default` unless the connection is under another), and the connection id. For carousels, also the media relay token; without it, photo writes are refused (`RELAY_NOT_CONFIGURED`).
8. **Before direct posts**: set the test TikTok account to Private, or TikTok blocks the post (`unaudited_client_can_only_post_to_private_accounts`).
9. **Carousels**: the build points at the test relay. For your own relay, verify its subdomain in TikTok (Manage URL properties → Domain, DNS signature), then follow "Photo carousels: on, through a test relay" above.

A `client_key` error comes from TikTok: re-copy the key and secret (look for swapped values or trailing spaces) and check that the redirect URI matches exactly.
