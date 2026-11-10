# TikTok for VoiceOS

Check your TikTok stats and posts, and send videos from your Mac to TikTok by voice. It runs through Composio with your own TikTok developer app. Every upload shows a confirmation card first, and nothing is sent until you click the card's button.

**Status: QA build.** It hasn't been tested against real TikTok yet. See `handoff.md`.

## Set up

Once per team, you need:

- a TikTok developer app with Login Kit, the Content Posting API (Direct Post on) and the Display API, and the scopes `user.info.basic`, `user.info.profile`, `user.info.stats`, `video.list`, `video.upload` and `video.publish`;
- a custom TikTok auth config in Composio that uses that app;
- your TikTok account connected in Composio (Connected accounts), with status ACTIVE.

The steps are in `handoff.md` → "Setup runbook". Then, in VoiceOS:

1. Open Integrations → TikTok → Configure and fill in:
   - **Composio project API key**: composio.dev → Settings → Project Settings → API Keys. Use a project key, not a `ck_` or `uak_` key.
   - **Composio user ID**: leave it at `default`: the integration then uses whichever Composio user owns the connection. Set it only to pin a specific user id.
   - **TikTok connected account ID**: the `ca_…` id from Composio → Connected accounts.
   - Leave **Media relay token** empty. Photo carousels aren't on yet.

   These fields are temporary, for testing.
2. Keep **Ask before every action** on. With it off, VoiceOS skips the confirmation cards, so every upload is refused and nothing is sent.
3. Approve by clicking the card's button (**Send to drafts** or **Post**). Saying "yes" doesn't send a TikTok post yet: VoiceOS doesn't pass the card's approval along when you answer by voice.
4. For direct posts, set your TikTok account to **Private** first. Until TikTok audits the app, direct posts only work from a private account and stay **Only me**. Drafts work either way.
5. Drafts finish on your phone: tap the TikTok inbox notification.

If VoiceOS can't see a folder, allow it in System Settings → Privacy & Security → Files and Folders.

**To disconnect**, delete the TikTok connection in Composio (Connected accounts) and clear the connected-account field. To also remove TikTok's access, open the TikTok app: Settings and privacy → Security and login → Manage app permissions.

## What you can say

- "How's my TikTok doing?"
- "What were my last 5 TikToks?" or "How did the cooking one do?"
- "Send my latest export to my TikTok drafts."
- "Send the one called demo to my drafts, caption 'day 3 of building VoiceOS'." TikTok drafts don't take captions, so switch on **Copy caption** on the card and paste it in TikTok.
- "Post my latest export to TikTok." You pick who can see it on the card.
- "Post it with the caption 'day 3 of the build', add #ai and #buildinpublic, and tag @maya." The card adds the tags to the end of the caption once each and highlights them; you can still edit it before you click.
- "Just for my friends", "only my followers" or "only me". Until TikTok audits the app, direct posts are Only me.
- "Use the frame at 0:05 as the cover", "allow comments and duets", "label it AI-generated", "it's a paid partnership."
- "Did it go up?"

Once photo carousels are on:

- "Make a TikTok carousel from the photos I just AirDropped."
- "Send my last 5 screenshots to my TikTok drafts, and make the second one the cover."

## What it can't do

- Post publicly. Until TikTok audits the app, direct posts are Only me.
- Put a caption on a video draft. TikTok doesn't accept one; use Copy caption.
- Edit, delete or schedule posts, like posts, read or reply to comments and messages, show trends, add sounds, show analytics beyond views, likes, comments and shares, or use more than one account.
- Show private (Only me) posts or drafts in your post list. TikTok returns public posts only, and cuts captions at 150 characters.
- Open your Photos library. Export or AirDrop the photos to your Mac first.
- Take `.webm` videos, videos over 4 GB, drafts longer than 10 minutes, or direct posts longer than your account allows.
- Send photo carousels, for now. They need a media relay that isn't set up yet.
- Take approval by voice. Click the card.

## Privacy

- No AI model runs inside the integration. It talks only to Composio (`backend.composio.dev`, plus Composio's upload host for video files) and, once carousels are on, the media relay. Composio passes your video and post details to TikTok.
- It looks only in Downloads, Desktop and Movies for videos, and in Downloads, Desktop, Pictures and your screenshot folder for photos: the top level and one folder down. The agent sees file and folder names, never full paths.
- Videos upload as they are, with their original metadata. If your camera recorded a location, TikTok gets it.
- Photos (once carousels are on) are converted to JPEG first, which removes EXIF data, GPS location and Content Credentials. They sit on the media relay briefly so TikTok can fetch them, then they're deleted.
- The clipboard is used only when you switch on Copy caption.
- On your Mac it keeps only fingerprints (SHA-256 digests) of approvals already used, so none can be used twice: `~/Library/Application Support/VoiceOS/integration-state/com.voiceos.generated.tiktok/spent-receipts.json`. No keys, captions or file paths.
- Its logs leave out keys, account ids, file paths, captions and links.
- Your Composio key is sent only to `backend.composio.dev`.

Developers: `AGENTS.md` has the layout, the rules and the dev loop; `handoff.md` has the status and the decisions.
