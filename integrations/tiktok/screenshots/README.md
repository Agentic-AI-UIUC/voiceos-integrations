# TikTok integration: screenshots

Real screenshots of the TikTok integration (1.2.1) running inside VoiceOS 0.1.40 on macOS. Other apps were hidden at the moment of capture, so the desktop wallpaper shows behind the notch. Each PNG is a macOS `screencapture` of the main display, cropped only: the wallpaper margin is the same on the left, right and bottom. Nothing is drawn on or composited. The GIFs are real screen recordings of the same crop at full Retina size, for the cards that move (video loops and photo stacks).

Every turn was a real prompt typed to the VoiceOS agent. Every write was approved by clicking the card's own button. The account is a fresh TikTok account, **Juicy Drama 🍓 (@rabs.cats)**, connected through Composio with the VoiceOS TikTok developer app (sandbox). Direct-post and draft captures were made while the account was private, since this developer app is unaudited. Afterwards the owner approved switching the account and all three existing posts to public; screenshots 12, 13 and 21 show the live public reads. The API still cannot publish publicly before the audit. The videos are AI-made fruit soap operas, generated with Higgsfield (Seedance 2.0) and labeled AI-generated on TikTok.

## Videos

| # | Title | Caption |
|---|---|---|
| 01 | **Find a video** ([gif](01-find-video.gif)) | "Find my Juicy Drama episode 1 video in Movies." `find_recent_videos` finds it by name in Movies › Juicy Drama and plays a short loop of it. |
| 02 | **Ready to post** ([gif](02-ready-to-post.gif)) | "Can I post that one straight to my TikTok? Check my posting settings first." `query_creator_info` checks the account's TikTok settings and the video's length, then shows who it posts as. |
| 03 | **Confirm a post** ([gif](03-post-video-card.gif)) | `publish_video` card: the video, the caption with hashtags, Who can view (Only me), the interactions TikTok allows for this account, the AI-generated label, Commercial content, and TikTok's Music Usage Confirmation. Nothing is sent until Post is clicked. |
| 04 | **Video posted** ([gif](04-video-posted.gif)) | "Did my strawberry episode go up on TikTok?" `fetch_publish_status` reports TikTok's PUBLISH_COMPLETE: posted, Only me. |
| 11 | **Confirm video drafts** ([gif](11-video-drafts-card.gif)) | "Send my Juicy Drama episode 1 video to my TikTok drafts so I can add a trending sound in the app." `upload_video` card. TikTok's drafts API takes no caption, so the card offers it to paste in the app. |
| 11b | **Video in the inbox** ([gif](11b-video-in-inbox.gif)) | TikTok's SEND_TO_USER_INBOX: the draft waits in the TikTok app's inbox. |

## Photo carousels

| # | Title | Caption |
|---|---|---|
| 05 | **Find a photo set** ([png](05-find-photos.png)) | "i wanna put those episode one stills on tiktok, can you pull them up". `find_recent_images` finds all six episode-one stills in story order, with thumbnails. |
| 06 | **Carousel ready** ([gif](06-carousel-ready.gif)) | “make them into one TikTok carousel, use the crying photo as the cover and keep the original story order.” `prepare_photo_post` uses the crying photo as cover. This recording shows every real thumbnail in the six-photo stack, over a complete cycle. Nothing is uploaded. |
| 07 | **Confirm a photo post** ([gif](07-post-photos-card.gif)) | `post_photos` card: the slides, title, description with hashtags, Who can view (Only me), Comments, and TikTok's Music Usage Confirmation. Nothing is sent until Post is clicked. |
| 08 | **Carousel posted** ([gif](08-carousel-status.gif)) | "Did my Juicy Drama cast carousel go up on TikTok?" TikTok's PUBLISH_COMPLETE: posted, 6 photos, Only me. |
| 09 | **Confirm photo drafts** ([gif](09-photo-drafts-card.gif)) | "Send my Juicy Drama cast photos to my TikTok drafts so I can add music in the app." `upload_photos` card with a single Send to drafts button. |
| 10 | **Photos in the inbox** ([gif](10-photo-drafts-status.gif)) | TikTok's SEND_TO_USER_INBOX: the six photos wait in the TikTok app's inbox. |

## Account

| # | Title | Caption |
|---|---|---|
| 13 | **Profile stats** ([png](13-profile-stats.png)) | "how's my TikTok profile doing now?" `get_user_stats` shows the account's picture, handle and TikTok counts after public visibility was enabled. |
| 12 | **Recent posts** ([png](12-recent-posts.png)) | "show my latest public TikTok posts". `list_videos` returns the three real public posts, with TikTok covers and metrics. The ledger underneath records the original private sends and drafts; later manual privacy changes do not rewrite it. |

## Revisions and completion

| # | Title | Caption |
|---|---|---|
| 14 | **Task notification** ([png](14-done-notification.png)) | The actual VoiceOS task notification that was on screen, captured as requested. |
| 15 | **Episode-one stills: post** ([gif](15-episode-one-photo-post.gif)) | “post that episode one carousel … keep the crying photo as the cover.” The card keeps photo 2 as cover, title and hashtags; the approved post finished. The photo API cannot apply an AI label, which VoiceOS disclosed. |
| 16 | **Episode-one stills: drafts** ([gif](16-episode-one-photo-drafts.gif)) | “send those same episode one stills to drafts instead … keep the crying cover and title.” The new card preserves title, tags and cover; the approved send arrived in the TikTok inbox. This separate draft does not undo the earlier post. |
| 17 | **Confirm both outcomes** ([gif](17-episode-one-photo-status.gif)) | “did that episode one photo post finish, and did the photo draft arrive?” Status and history report the completed private post and inbox draft. |
| 18 | **Revise into a draft** ([gif](18-video-draft-revision.gif)) | “actually make that a draft … add fruit drama and story time tags.” The draft card folds the requested caption and tags together. Reviewed, then revised; this card was not sent. |
| 19 | **Switch drafts to post** ([gif](19-video-post-revision.gif)) | “wait, post it instead, just me, it’s AI made … cover at 0:05.” The replacement card shows the new caption, retained tags, AI label, Only me and Cover 0:05. Cancelled afterwards; no additional episode-one video was posted. |
| 23 | **AI-label request goes to drafts** ([gif](23-photo-ai-label-drafts.gif)) | “post my Juicy Drama cast photos with TikTok's AI-generated label; show me first.” With the routing fix, this opens `upload_photos`, where the label can be applied in TikTok. The 20-second recording shows the full confirmation-preview cycle: five tiny frames and “+1 more.” The prepared card in 06 shows every real photo; confirmation arguments are limited to 1,500 characters. Cancelled without sending. |
| 22 | **Second episode ready** ([gif](22-second-episode-ready.gif)) | “can you find that new two brides episode and check the posting options? don't upload it.” VoiceOS finds the newly exported second episode without a local path, checks creator options and shows a moving preview. No upload is made by this turn. |
| 21 | **Public post details** ([png](21-public-post-details.png)) | “how many views, likes, comments and shares does this strawberry episode have?” with its public TikTok URL. `query_videos` returns the actual four zero counts, cover, publication time, length, aspect and hashtags. |

## Tool and conversation coverage

[Sanitized live turns and tool events](live-cases.json) record all **12 tools** running in the real VoiceOS agent, including the four write executions. No tool tokens, approval receipts or private setup values are included. Additional cases include metadata (“vertical … exported today … about a minute”), a missing episode 99 (not substituted), public-post indexing delay (metrics unavailable until returned), and cancellation. File discovery used names and ordinary descriptions, not supplied local paths.

The images document the local macOS install. They do not establish Windows support, a VoiceOS published share, TikTok app audit approval or production readiness.
