import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CARD_IMAGE_RE,
  STACK_JS,
  bundleCard,
  cardImage,
  cardMotion,
  orderText,
  creatorCard,
  errorCard,
  galleryCell,
  imageCandidatesCard,
  imageSize,
  postDetailsCard,
  postsDetailsCard,
  statsCard,
  statusCard,
  videoCandidatesCard,
  videoListCard,
  writeOutcomeCopy,
  writeResultCard,
  type StatusCardInput,
  type WriteResultInput,
} from "../src/cards.ts";
import { TikTokError } from "../src/errors.ts";
import type { VideoDetails, VideoSummary, Widget } from "../src/types.ts";

// Noon UTC keeps "Nov 1" the same local date in every CI time zone.
const NOW = Date.UTC(2026, 10, 4, 13, 0, 0);
const NOV_1 = Date.UTC(2026, 10, 1, 12, 0, 0) / 1000;
const HOSTILE = `<script>alert(1)</script>"><img src=x onerror=alert(2)>`;
const SHARE = "https://www.tiktok.com/@maya.makes/video/7311111111111111111";

/** The card's own markup: between <body> and the kit's runtime script. */
function markup(w: Widget): string {
  return w.html.slice(w.html.indexOf("<body>"), w.html.lastIndexOf("<script>"));
}
function hrefs(w: Widget): string[] {
  return [...markup(w).matchAll(/href="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
}
function visibleText(w: Widget): string {
  return markup(w)
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}
function expectValid(w: Widget) {
  expect(w.type).toBe("widget");
  expect(w.html.length).toBeLessThanOrEqual(300_000);
  expect(w.height).toBeGreaterThanOrEqual(60);
  expect(w.height).toBeLessThanOrEqual(420);
  expect((w.label ?? "").length).toBeGreaterThan(0);
  expect((w.label ?? "").length).toBeLessThanOrEqual(60);
  // Links: https only, TikTok's own hosts only.
  for (const h of hrefs(w)) expect(h).toMatch(/^https:\/\/([a-z0-9-]+\.)*tiktok\.com\//);
  // No network: images are the kit's mark or our own validated JPEG/PNG data URIs, and nothing points off the card.
  const imgs = [...markup(w).matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
  for (const img of imgs) {
    if (img.includes('class="k-mk-i"')) continue;
    expect(img).toMatch(/^<img class="(tt-(m|av|ps)-i(?: tt-m-mo)?|tt-m-fsi)" src="[^"]+" alt=""(?: draggable="false"| style="[^"]+")?>$/);
    expect(img.match(/src="([^"]+)"/)?.[1]).toMatch(CARD_IMAGE_RE);
  }
  expect(w.html).not.toMatch(/src="https?:/);
  expect(w.html).not.toMatch(/url\(\s*['"]?https?:/);
  // Theme comes from the bridge, never from the OS appearance.
  expect(w.html).not.toContain("prefers-color-scheme");
  // The integration mark leads the header.
  expect(markup(w)).toContain("data-k-mk");
}
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const imgCount = (w: Widget) => (markup(w).match(/<img class="tt-(m|av|ps)-i"/g) ?? []).length;
import vm from "node:vm";

// Tiny real frames (Tiny AI Lab's shorts): a 144x256 portrait and a 256x144 landscape JPEG, and a 112x112 avatar.
const FIX = join(import.meta.dir, "fixtures", "cards");
const jpeg = (name: string) => `data:image/jpeg;base64,${readFileSync(join(FIX, name)).toString("base64")}`;
const PORTRAIT = jpeg("poster-1.jpg");
const LANDSCAPE = jpeg("poster-wide.jpg");
const AVATAR = jpeg("avatar.jpg");
/** A 1x1 PNG. */
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
/** Not drawable: other types, remote URLs, script, junk after the base64. */
const BAD_IMAGES = ["data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", "https://p16-common-sign.tiktokcdn-us.com/a.jpeg", "javascript:alert(1)", `${PNG}"><script>`, "data:image/gif;base64,R0lGOD", ""];

const video = (over: Partial<VideoSummary> = {}): VideoSummary => ({
  id: "7311111111111111111",
  caption: "day 3 of building VoiceOS — shipped the notch cards today #buildinpublic #voiceos",
  create_time: NOV_1,
  duration: 23,
  width: 1080,
  height: 1920,
  share_url: SHARE,
  view_count: 8412,
  like_count: 612,
  comment_count: 41,
  share_count: 38,
  ...over,
});
const details = (over: Partial<VideoDetails> = {}): VideoDetails => ({
  ...video(),
  hashtags: ["#buildinpublic", "#voiceos"],
  mentions: [],
  caption_truncated: false,
  posted_label: "Nov 1 · 3 days ago",
  aspect: "9:16",
  ...over,
});

describe("statsCard", () => {
  const user = { username: "maya.makes", display_name: "Maya Makes", follower_count: 12_345, following_count: 312, likes_count: 1_234_567, video_count: 48 };

  test("big counts, the handle and the name", () => {
    const w = statsCard(user);
    expectValid(w);
    const text = visibleText(w);
    for (const s of ["TikTok", "Profile", "@maya.makes", "Maya Makes", "12.3K", "Followers", "1.2M", "Likes", "48", "Public videos", "312 following"]) {
      expect(text).toContain(s);
    }
    expect(hrefs(w)).toEqual([]);
    expect(text).not.toContain("Verified");
  });

  test("the profile picture is drawn round when given; anything but a JPEG/PNG data URI is ignored", () => {
    const w = statsCard({ ...user, avatar_data: AVATAR });
    expectValid(w);
    expect(markup(w)).toContain(`<span class="tt-av has-i" aria-hidden="true">MM<img class="tt-av-i" src="${AVATAR}" alt=""></span>`);
    for (const bad of BAD_IMAGES) {
      const b = statsCard({ ...user, avatar_data: bad });
      expect(imgCount(b)).toBe(0);
      expect(markup(b)).not.toContain("<script>");
    }
    expect(imgCount(statsCard({ ...user, avatar_data: `data:image/jpeg;base64,${"A".repeat(70_000)}` }))).toBe(0); // over the per-image cap
  });

  test("a monogram stands in for a missing avatar, and likes per video is derived", () => {
    const w = statsCard(user);
    expect(markup(w)).toContain('<span class="tt-av" aria-hidden="true">MM</span>');
    expect(visibleText(w)).toContain("25.7K avg likes/video"); // 1,234,567 / 48
    expect(markup(statsCard({ ...user, display_name: "Tiny AI Lab" }))).toContain(">TA</span>");
    expect(markup(statsCard({ ...user, display_name: "東京カフェ" }))).toContain(">東</span>");
    // No initials to draw: a person glyph, never an empty disc.
    expect(markup(statsCard({ ...user, display_name: "🎬🎬" }))).toMatch(/<span class="tt-av" aria-hidden="true"><svg/);
  });

  test("an account with no public videos: the 0 says it, no extra sublines", () => {
    const w = statsCard({ username: "tinyailab", display_name: "Tiny AI Lab", follower_count: 5, following_count: 12, likes_count: 0, video_count: 0 });
    expectValid(w);
    const text = visibleText(w);
    expect(text).toContain("0 Public videos");
    expect(text).not.toContain("No public videos yet");
    expect(text).not.toContain("likes/video");
    expect(w.height).toBeLessThan(statsCard({ ...user, include_profile: true, bio_description: "x" }).height + 1);
  });

  test("with the profile: verified, bio (≤ 100) and an https profile link", () => {
    const bio = "student creator · editing in CapCut · day-by-day build-in-public diary of everything I make, every single day of the week";
    const w = statsCard({ ...user, include_profile: true, is_verified: true, bio_description: bio, profile_deep_link: "https://vm.tiktok.com/ZMabc123/" });
    expectValid(w);
    const text = visibleText(w);
    expect(text).toContain("Verified");
    expect(text).toContain("student creator");
    expect(text).toContain("Open profile");
    expect(text).not.toContain(bio); // clipped
    expect(hrefs(w)).toEqual(["https://vm.tiktok.com/ZMabc123/"]);
  });

  test("a profile link that isn't https is not a link", () => {
    for (const link of ["snssdk1233://user/profile/123", "http://www.tiktok.com/@maya", "javascript:alert(1)", "https://evil.example/@maya"]) {
      const w = statsCard({ ...user, include_profile: true, profile_deep_link: link });
      expect(hrefs(w)).toEqual([]);
      expect(visibleText(w)).not.toContain("Open profile");
    }
  });

  test("missing counts never show as 0 or NaN; no counts at all says so", () => {
    const some = visibleText(statsCard({ username: "maya.makes", display_name: "Maya", follower_count: 0, likes_count: undefined, video_count: 3 }));
    expect(some).toContain("0");
    expect(some).toContain("—");
    expect(some).not.toMatch(/NaN|undefined/);
    const none = statsCard({ username: "maya.makes", display_name: "Maya" });
    expectValid(none);
    expect(visibleText(none)).toContain("TikTok didn't return the counts.");
  });

  test("hostile names and bios are escaped", () => {
    const w = statsCard({ ...user, display_name: HOSTILE, include_profile: true, bio_description: HOSTILE });
    expectValid(w);
    expect(w.html).not.toContain("<script>alert(1)");
    expect(w.html).not.toContain("<img src=x");
    expect(visibleText(w)).toContain("<script>alert(1)</script>");
  });
});

describe("videoListCard", () => {
  test("caption, likes · comments · shares, when and how long, and views on the right", () => {
    const w = videoListCard({
      videos: [
        video(),
        video({ id: "2", caption: "Lisbon weekend\nbest 3 days", duration: 0, view_count: 2200, like_count: 340, create_time: Date.UTC(2026, 9, 30, 12) / 1000, share_url: "https://www.tiktok.com/@maya.makes/photo/2" }),
        video({ id: "3", caption: "no length known", duration: undefined, share_url: undefined }),
      ],
      has_more: false,
    }, NOW);
    expectValid(w);
    const text = visibleText(w);
    for (const s of ["day 3 of building VoiceOS", "612 likes 41 comments 38 shares 3d ago · 0:23", "8.4K views", "Lisbon weekend", "340 likes 41 comments 38 shares 5d ago · Photos", "2.2K views", "Last 3 public posts"]) {
      expect(text).toContain(s);
    }
    expect(text).not.toContain("best 3 days"); // first line only
    expect(text).not.toContain("#buildinpublic"); // trailing hashtags are noise in a one-line title
    expect(hrefs(w)).toEqual([SHARE, "https://www.tiktok.com/@maya.makes/photo/2"]);
  });

  test("a row whose link isn't https renders as plain text", () => {
    const w = videoListCard({ videos: [video({ share_url: "http://www.tiktok.com/@maya.makes/video/1" }), video({ share_url: "javascript:alert(1)" })], has_more: false });
    expect(hrefs(w)).toEqual([]);
    expect(visibleText(w)).toContain("day 3 of building VoiceOS");
  });

  test("at most 4 rows under the totals, then a count; older pages are mentioned", () => {
    const many = Array.from({ length: 9 }, (_, i) => video({ id: String(i), caption: `post number ${i}` }));
    const w = videoListCard({ videos: many, has_more: true });
    expectValid(w);
    const text = visibleText(w);
    expect(text).toContain("post number 3");
    expect(text).not.toContain("post number 4");
    expect(text).toContain("Showing 4 of 9");
    expect(text).toContain("older posts available");
  });

  test("totals strip: views and likes summed, engagement weighted by views", () => {
    const posts = [
      video({ id: "1", view_count: 12_400, like_count: 1_310, comment_count: 86, share_count: 214 }),
      video({ id: "2", view_count: 3_920, like_count: 402, comment_count: 57, share_count: 33 }),
    ];
    const text = visibleText(videoListCard({ videos: posts, has_more: false }));
    // 16,320 views; 1,712 likes; (1,310+86+214+402+57+33) / 16,320 = 12.9%
    for (const s of ["16.3K views", "1.7K likes", "13% engagement"]) expect(text).toContain(s);
    // Under 100 views there's no meaningful rate: comments instead, never "0%".
    const small = visibleText(videoListCard({ videos: [video({ id: "1", view_count: 40, like_count: 4, comment_count: 2, share_count: 0 }), video({ id: "2", view_count: 30, like_count: 1, comment_count: 1, share_count: 0 })], has_more: false }));
    expect(small).toContain("3 comments");
    expect(small).not.toContain("engagement");
    expect(small).not.toContain("Engagement");
  });

  test("views bars compare the posts on the card; only the most viewed one takes the accent", () => {
    const posts = [video({ id: "1", view_count: 1000 }), video({ id: "2", view_count: 4000 }), video({ id: "3", view_count: 2000 }), video({ id: "4", view_count: undefined })];
    const html = markup(videoListCard({ videos: posts, has_more: false }));
    expect([...html.matchAll(/class="tt-meter( is-top)?"[^>]*><i style="width:(\d+)%"/g)].map((m) => [m[2], Boolean(m[1])])).toEqual([
      ["25", false],
      ["100", true],
      ["50", false],
    ]);
    // One post: nothing to compare, no bar.
    expect(markup(videoListCard({ videos: [video()], has_more: false }))).not.toContain("tt-meter");
  });

  test("singular counts and a missing caption", () => {
    const text = visibleText(videoListCard({ videos: [video({ caption: "", view_count: 1, like_count: 1 }), video({ id: "2" })], has_more: false }));
    expect(text).toContain("1 like 41 comments");
    expect(text).toContain("1 view");
    expect(text).not.toContain("1 views");
    expect(text).toContain("No caption");
  });

  test("a lone post is shown as itself: cover, caption, big views and its breakdown", () => {
    const w = videoListCard({ videos: [video({ caption: "Why do chatbots miscount the r's in strawberry? 🍓 It's all about tokens. #ai #tokens" })], has_more: true }, NOW, { covers: { "7311111111111111111": PORTRAIT } });
    expectValid(w);
    const text = visibleText(w);
    for (const s of ["1 public post", "It's all about tokens.", "8.4K views", "612 Likes", "41 Comments", "38 Shares", "Posted Nov 1 · 3 days ago", "older posts available", "Open in TikTok"]) expect(text).toContain(s);
    expect(text).not.toContain("#ai"); // trailing tags are noise on a glance card
    expect(imgCount(w)).toBe(1);
    expect(markup(w)).not.toContain("<details");
  });

  test("each row is a <details> that opens one at a time onto that post's exact breakdown", () => {
    const posts = [video({ id: "1", view_count: 12_400, like_count: 1_310, comment_count: 86, share_count: 214 }), video({ id: "2", view_count: 88, share_count: undefined })];
    const w = videoListCard({ videos: posts, has_more: false });
    const html = markup(w);
    expect(html.match(/<details class="tt-pr" name="tt-post">/g)?.length).toBe(2);
    expect(html).not.toMatch(/<details[^>]*\bopen\b/); // collapsed: the declared height is the collapsed card
    const text = visibleText(w);
    // Exact counts and the rate: (1,310 + 86 + 214) / 12,400 = 13%. Under 100 views, or without shares, no rate.
    expect(text).toContain("12,400 Views 1,310 Likes 86 Comments 214 Shares 13% Engagement");
    expect(text).toContain("88 Views 612 Likes 41 Comments");
    expect(text.match(/Engagement/g)?.length).toBe(1);
    // The link to the post lives in the breakdown, one per post.
    expect(hrefs(w)).toEqual([SHARE, SHARE]);
    expect(html).toContain('aria-label="Open in TikTok"');
    // The accordion script is plain ES5 with nothing compiled from strings; the chevrons say a row opens (no hint text).
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
    expect(script).toContain("toggle");
    expect(script).not.toMatch(/eval|Function|setTimeout|=>|\blet\b|\bconst\b/);
    expect(html).toContain('class="tt-chev"');
    expect(text).not.toContain("Tap a post");
    // Big counts compact in the breakdown so five cells stay on one line.
    expect(visibleText(videoListCard({ videos: [video({ view_count: 123_456_789, like_count: 99_999 }), video({ id: "2" })], has_more: false }))).toContain("123M Views 99,999 Likes");
  });

  test("covers by video id: one per row, invalid ones ignored, the top post ringed", () => {
    const posts = [video({ id: "a", view_count: 100 }), video({ id: "b", view_count: 900 }), video({ id: "c", view_count: 300 })];
    const w = videoListCard({ videos: posts, has_more: false }, NOW, { covers: { a: PORTRAIT, b: BAD_IMAGES[0], c: LANDSCAPE } });
    expectValid(w);
    expect(imgCount(w)).toBe(2);
    const tiles = [...markup(w).matchAll(/<span class="(tt-m z-s[^"]*)"/g)].map((m) => m[1]);
    expect(tiles).toEqual(["tt-m z-s has-i", "tt-m z-s is-top", "tt-m z-s is-w has-i"]);
    // No covers at all: every row still has its tile, with the play glyph.
    const bare = markup(videoListCard({ videos: posts, has_more: false }));
    expect(bare.match(/class="tt-m z-s/g)?.length).toBe(3);
    expect(bare).not.toContain("<img class=\"tt-m-i\"");
  });

  test("images are budgeted per card: earlier rows win and the card stays far under the cap", () => {
    const big = `data:image/jpeg;base64,${"A".repeat(63_000)}`;
    const posts = Array.from({ length: 6 }, (_, i) => video({ id: String(i) }));
    const w = videoListCard({ videos: posts, has_more: false }, NOW, { covers: Object.fromEntries(posts.map((p) => [p.id, big])) });
    expectValid(w);
    expect(imgCount(w)).toBe(3); // 3 × 63K fits the 200K budget, the 4th doesn't
    expect(w.html.length).toBeLessThan(260_000);
  });

  test("the empty state says why private posts aren't here, and where they are (§8.7)", () => {
    const w = videoListCard({ videos: [], has_more: false });
    expectValid(w);
    const text = visibleText(w);
    expect(text).toContain("No public posts yet");
    expect(text).toContain("Only me posts and drafts aren't listed here. Find them in the TikTok app.");
    expect(text).not.toContain("Ask me to send");
  });

  test("captions are untrusted: escaped, never raw", () => {
    const w = videoListCard({ videos: [video({ caption: HOSTILE })], has_more: false });
    expect(w.html).not.toContain("<script>alert(1)");
    expect(visibleText(w)).toContain("<script>alert(1)</script>");
  });
});

describe("postDetailsCard", () => {
  test("headline, stats and facts (plan §6.3, §8.5)", () => {
    const w = postDetailsCard(details({ is_aigc: true }));
    expectValid(w);
    const text = visibleText(w);
    for (const s of ["day 3 of building VoiceOS", "8.4K views", "612 Likes", "41 Comments", "38 Shares", "Posted", "Nov 1 · 3 days ago", "0:23 · 9:16", "#buildinpublic #voiceos", "AI-generated", "Open in TikTok"]) {
      expect(text).toContain(s);
    }
    expect(hrefs(w)).toEqual([SHARE]);
    // The hashtags are a fact of their own, so the headline is the caption without them, said once.
    expect(text.match(/#buildinpublic/g)?.length).toBe(1);
    expect(markup(w)).toContain(">day 3 of building VoiceOS — shipped the notch cards today</div>");
  });

  test("engagement rate when the post has one (TikTok's, else from the counts at 100+ views)", () => {
    expect(visibleText(postDetailsCard(details({ engagement_rate: 0.0821 })))).toContain("8.2% Engagement");
    expect(visibleText(postDetailsCard(details()))).toContain("8.2% Engagement"); // (612 + 41 + 38) / 8,412
    expect(visibleText(postDetailsCard(details({ view_count: 90 })))).not.toContain("Engagement");
    expect(visibleText(postDetailsCard(details({ share_count: undefined })))).not.toContain("Engagement");
  });

  test("the cover leads, shaped like the frame; a fallback tile when there's none", () => {
    const w = postDetailsCard(details(), NOW, { cover: PORTRAIT });
    expectValid(w);
    expect(markup(w)).toContain('<span class="tt-m z-xl has-i kb"');
    expect(markup(postDetailsCard(details(), NOW, { cover: LANDSCAPE }))).toContain('<span class="tt-m z-xl is-w has-i kb"');
    const bare = postDetailsCard(details());
    expect(markup(bare)).toContain('<span class="tt-m z-xl"');
    expect(imgCount(bare)).toBe(0);
    for (const bad of BAD_IMAGES) expect(imgCount(postDetailsCard(details(), NOW, { cover: bad }))).toBe(0);
  });

  test("vs your average, only with the channel's average", () => {
    const vs = (avg?: number) => visibleText(postDetailsCard(details({ view_count: 8412 }), NOW, avg === undefined ? undefined : { channelAvgViews: avg }));
    expect(vs(4000)).toContain("2.1× your average");
    expect(vs(6000)).toContain("40% above your average");
    expect(vs(8000)).toContain("About your average");
    expect(vs(20_000)).toContain("58% below your average");
    expect(vs()).not.toContain("average");
    expect(vs(0)).not.toContain("average");
    expect(markup(postDetailsCard(details(), NOW, { channelAvgViews: 4000 }))).toContain('class="tt-vs is-up"');
    expect(markup(postDetailsCard(details(), NOW, { channelAvgViews: 20_000 }))).not.toContain("is-up");
  });

  test("a caption that is only hashtags stays the headline", () => {
    expect(markup(postDetailsCard(details({ caption: "#fyp #ai" })))).toContain(">#fyp #ai</div>");
  });

  test("a 150-character caption says TikTok cuts it there", () => {
    const caption = `${"so much to say about this build ".repeat(5)}`.slice(0, 150);
    const w = postDetailsCard(details({ caption, caption_truncated: true }));
    expectValid(w);
    const text = visibleText(w);
    expect(text).toContain("TikTok shows up to 150 characters");
    expect(text).toContain(caption.trim().slice(0, 120));
  });

  test("a photo post reads Photos, and no link without https", () => {
    const w = postDetailsCard(details({ duration: 0, share_url: "ftp://x", aspect: undefined }));
    const text = visibleText(w);
    expect(text).toContain("Photos");
    expect(text).not.toContain("Open in TikTok");
    expect(hrefs(w)).toEqual([]);
  });

  test("missing stats are dashes, not zeros", () => {
    const text = visibleText(postDetailsCard(details({ view_count: undefined, like_count: undefined, comment_count: undefined, share_count: undefined })));
    expect(text).toContain("—");
    expect(text).not.toContain("Shares");
  });
});

describe("postsDetailsCard", () => {
  test("several posts compactly", () => {
    const w = postsDetailsCard([details(), details({ id: "2", caption: "cat tries ramen", view_count: 22_000 }), details({ id: "3", caption: "Lisbon weekend", duration: 0 })]);
    expectValid(w);
    const text = visibleText(w);
    for (const s of ["3 posts", "day 3 of building VoiceOS", "cat tries ramen", "22K views", "Lisbon weekend", "612 likes 41 comments", "views", "engagement"]) expect(text).toContain(s);
  });

  test("covers by id for several posts; one post gets its cover on the details card", () => {
    const w = postsDetailsCard([details({ id: "a" }), details({ id: "b" })], NOW, { covers: { a: PORTRAIT, b: PNG } });
    expectValid(w);
    expect(imgCount(w)).toBe(2);
    expect(imgCount(postsDetailsCard([details({ id: "a" })], NOW, { covers: { a: PORTRAIT } }))).toBe(1);
  });

  test("one post is the details card; none is an honest empty state", () => {
    expect(visibleText(postsDetailsCard([details()]))).toContain("Comments");
    const empty = postsDetailsCard([]);
    expectValid(empty);
    expect(visibleText(empty)).toContain("No post details");
  });
});

describe("media tiles", () => {
  test("recent videos lead with a tile shaped like the video; photos with a photo glyph", () => {
    const base = { folder: "Movies", size_label: "38.6 MB", added_label: "4 min ago", duration_label: "0:41" };
    const html = markup(
      videoCandidatesCard({
        videos: [{ name: "vertical.mp4", width: 1080, height: 1920, ...base }, { name: "screen.mov", width: 3024, height: 1964, ...base }, { name: "unknown.mov", ...base }],
        query_matched: true,
        denied_folders: [],
      }),
    );
    expect([...html.matchAll(/<span class="tt-m z-(\w+)( is-w)?/g)].map((m) => [m[1], Boolean(m[2])])).toEqual([
      ["l", false],
      ["xs", true],
      ["xs", false],
    ]);
    const photos = markup(imageCandidatesCard({ images: [{ name: "IMG_1.HEIC", folder: "Downloads", added_label: "now" }], total: 1, query_matched: true, denied_folders: [] }));
    // Photos are 3:4 tiles (the stack's shape), with the photo glyph until a thumbnail lands.
    expect(photos).toContain('<span class="tt-m z-ph"');
  });

  test("posters: the frame's own shape wins over the reported size, invalid ones fall back", () => {
    const base = { folder: "Movies", size_label: "38.6 MB", added_label: "4 min ago", duration_label: "0:41" };
    const w = videoCandidatesCard({
      videos: [{ name: "a.mp4", width: 1080, height: 1920, poster: LANDSCAPE, ...base }, { name: "b.mp4", poster: PORTRAIT, ...base }, { name: "c.mp4", poster: BAD_IMAGES[1], ...base }],
      query_matched: true,
      denied_folders: [],
    });
    expectValid(w);
    expect(imgCount(w)).toBe(2);
    expect([...markup(w).matchAll(/<span class="(tt-m z-\w+[^"]*)"/g)].map((m) => m[1])).toEqual(["tt-m z-l is-w has-i kb", "tt-m z-xs has-i", "tt-m z-xs"]);
  });

  test("imageSize reads PNG and JPEG headers and nothing else", () => {
    expect(imageSize(PNG)).toEqual({ w: 1, h: 1 });
    expect(imageSize(PORTRAIT)).toEqual({ w: 144, h: 256 });
    expect(imageSize(LANDSCAPE)).toEqual({ w: 256, h: 144 });
    expect(imageSize(AVATAR)).toEqual({ w: 112, h: 112 });
    expect(imageSize("data:image/jpeg;base64,AAAA")).toBeUndefined();
    expect(imageSize(undefined)).toBeUndefined();
    expect(cardImage(PNG)).toBe(PNG);
    for (const bad of BAD_IMAGES) expect(cardImage(bad)).toBeUndefined();
  });
});

describe("statusCard", () => {
  const LABELS: Record<StatusCardInput["state"], string> = {
    staging: "Uploading",
    uploading: "Uploading",
    processing: "Processing",
    inbox: "In your inbox",
    posted: "Posted",
    failed: "Failed",
    unknown: "Not confirmed",
    none: "Not found",
  };

  test("every state renders its label", () => {
    for (const [state, label] of Object.entries(LABELS) as Array<[StatusCardInput["state"], string]>) {
      const w = statusCard({ state, kind: "video", mode: "direct", name: "final_export.mp4", started_at: new Date(NOW - 150_000).toISOString(), now: NOW });
      expectValid(w);
      expect({ state, has: visibleText(w).includes(label) }).toEqual({ state, has: true });
    }
  });

  test("one meta line (what · when · privacy) and the processing note; no key-value rows", () => {
    const w = statusCard({ state: "processing", kind: "photos", mode: "direct", count: 8, privacy_label: "Only me", started_at: new Date(NOW - 150_000).toISOString(), now: NOW });
    const text = visibleText(w);
    for (const s of ["8 photos · 2 min ago · Only me", "Can take a few minutes."]) expect(text).toContain(s);
    for (const s of ["Type", "Started", "Privacy", "carousel"]) expect(text).not.toContain(s);
    expect(markup(w)).not.toContain("tt-kv");
    const v = visibleText(statusCard({ state: "processing", kind: "video", mode: "direct", name: "ep01-strawberry-tokens.mp4", privacy_label: "SELF_ONLY", started_at: new Date(NOW - 420_000).toISOString(), now: NOW }));
    expect(v).toContain("ep01-strawberry-tokens.mp4 · 7 min ago · Only me");
  });

  test("the rail shows progress only while it's moving; done or failed, the badge and pill say it", () => {
    expect(markup(statusCard({ state: "processing", kind: "video", mode: "direct", now: NOW }))).toContain("tt-rail");
    expect(markup(statusCard({ state: "uploading", kind: "video", mode: "drafts", now: NOW }))).toContain("tt-rail");
    for (const state of ["inbox", "posted", "failed", "unknown"] as const) {
      expect({ state, rail: markup(statusCard({ state, kind: "video", mode: "direct", now: NOW })).includes("tt-rail") }).toEqual({ state, rail: false });
    }
  });

  test("a direct post that's up says it can take a few minutes to show (TikTok's guidelines); one finished in the app says nothing extra", () => {
    expect(visibleText(statusCard({ state: "posted", kind: "video", mode: "direct", now: NOW }))).toContain("May take a few minutes to show on your profile.");
    const viaApp = visibleText(statusCard({ state: "posted", kind: "video", mode: "drafts", now: NOW }));
    expect(viaApp).not.toContain("few minutes");
    expect(viaApp).not.toContain("You finished");
  });

  test("tone follows state: good when done, bad when failed", () => {
    expect(markup(statusCard({ state: "inbox", kind: "video", mode: "drafts" }))).toContain("is-good");
    expect(markup(statusCard({ state: "posted", kind: "video", mode: "direct" }))).toContain("is-good");
    const failed = statusCard({ state: "failed", kind: "video", reason: "TikTok's spam check stopped this post because of its text." });
    expect(markup(failed)).toContain("is-bad");
    expect(visibleText(failed)).toContain("TikTok's spam check stopped this post because of its text.");
  });

  test("the inbox says how to finish; nothing found says so, with no rows", () => {
    expect(visibleText(statusCard({ state: "inbox", kind: "video", mode: "drafts" }))).toContain("Tap the TikTok notification to finish.");
    const none = visibleText(statusCard({ state: "none", kind: "video", mode: "direct", name: "final.mp4", started_at: new Date(NOW).toISOString(), now: NOW }));
    expect(none).toContain("No recent post from VoiceOS to check.");
    expect(none).not.toContain("profile");
    for (const s of ["Type", "final.mp4", "Started", "Direct post"]) expect(none).not.toContain(s);
  });

  test("a start time that isn't a date is left out, never printed raw", () => {
    const text = visibleText(statusCard({ state: "processing", kind: "video", started_at: "not a date", now: NOW }));
    expect(text).not.toContain("not a date");
    expect(text).not.toContain("Started");
  });

  test("the frame leads a status too; nothing found has no tile", () => {
    const w = statusCard({ state: "processing", kind: "video", mode: "direct", poster: PORTRAIT, now: NOW });
    expectValid(w);
    expect(imgCount(w)).toBe(1);
    expect(markup(w)).toContain('<span class="tt-m-sh"></span>');
    expect(markup(statusCard({ state: "posted", kind: "video", mode: "direct", poster: PORTRAIT }))).toContain("tt-ck");
    expect(markup(statusCard({ state: "failed", kind: "video", mode: "direct", poster: PORTRAIT }))).toContain("is-dim");
    expect(markup(statusCard({ state: "none", poster: PORTRAIT }))).not.toContain("tt-m ");
    expect(imgCount(statusCard({ state: "none", poster: PORTRAIT }))).toBe(0);
  });

  test("a single photo is a photo, not a 1-photo carousel", () => {
    expect(visibleText(statusCard({ state: "processing", kind: "photos", count: 1 }))).toContain("1 photo");
    expect(visibleText(statusCard({ state: "processing", kind: "photos", count: 1 }))).not.toContain("1 photos");
    expect(visibleText(statusCard({ state: "processing", kind: "photos", count: 1 }))).not.toContain("carousel");
  });
});

describe("writeOutcomeCopy", () => {
  const outcomes: WriteResultInput["outcome"][] = ["inbox", "posted", "processing", "failed", "unknown", "refused"];
  const kinds = ["video", "photos"] as const;
  const modes = ["drafts", "direct"] as const;

  test("every outcome × kind × mode has a short title, a body and one short spoken line", () => {
    for (const outcome of outcomes) {
      for (const kind of kinds) {
        for (const mode of modes) {
          for (const extra of [{}, { count: 8, privacy_label: "Only me", caption: "day 3 #buildinpublic", caption_copied: true, name: "final.mp4" }]) {
            const c = writeOutcomeCopy({ outcome, kind, mode, ...extra });
            const where = `${outcome}/${kind}/${mode}`;
            expect({ where, ok: c.title.length > 0 && c.title.length <= 60 }).toEqual({ where, ok: true });
            expect({ where, ok: c.body.length > 0 }).toEqual({ where, ok: true });
            expect({ where, words: words(c.spoken) <= 15 }).toEqual({ where, words: true });
            expect({ where, end: /[.!?]$/.test(c.spoken) }).toEqual({ where, end: true });
            // Facts only: the spoken line never names files or reads the caption.
            expect(c.spoken).not.toContain("final.mp4");
            expect(c.spoken).not.toContain("#buildinpublic");
            const card = writeResultCard({ outcome, kind, mode, ...extra });
            expectValid(card);
            expect(visibleText(card)).toContain(c.title);
          }
        }
      }
    }
  });

  test("drafts: the plan's toast copy (§6.5, §6.11, §8.5), one short line", () => {
    const v = writeOutcomeCopy({ outcome: "inbox", kind: "video", mode: "drafts" });
    expect(v.title).toBe("Sent to TikTok drafts");
    expect(v.body).toBe("Tap the TikTok notification to finish.");
    expect(v.body).not.toContain("caption");
    const copied = writeOutcomeCopy({ outcome: "inbox", kind: "video", mode: "drafts", caption: "day 3", caption_copied: true });
    expect(copied.body).toBe("Tap the TikTok notification to finish. Your caption is copied.");
    const p = writeOutcomeCopy({ outcome: "inbox", kind: "photos", mode: "drafts", count: 8, caption: "Lisbon weekend" });
    expect(p.title).toBe("8 photos sent to TikTok drafts");
    expect(p.body).toBe("Tap the TikTok notification to finish.");
    expect(writeOutcomeCopy({ outcome: "inbox", kind: "photos", mode: "drafts", count: 8 }).body).toBe("Tap the TikTok notification to finish.");
  });

  test("direct posts: posted as the chosen privacy (§6.6, §6.12)", () => {
    const v = writeOutcomeCopy({ outcome: "posted", kind: "video", mode: "direct", privacy_label: "Only me" });
    expect(v.title).toBe("Posted to TikTok as Only me");
    // TikTok's Content Sharing Guidelines: say a direct post can take a few minutes to process and show up.
    expect(v.body).toBe("May take a few minutes to show on your profile.");
    expect(v.spoken).toBe("Your video is posted to TikTok as Only me.");
    const p = writeOutcomeCopy({ outcome: "posted", kind: "photos", mode: "direct", count: 6, privacy_label: "SELF_ONLY" });
    expect(p.title).toBe("Posted 6 photos to TikTok as Only me");
    // No privacy known: no claim about who can see it.
    expect(writeOutcomeCopy({ outcome: "posted", kind: "video", mode: "direct" }).title).toBe("Posted to TikTok");
  });

  test("still processing at the cut-off", () => {
    const c = writeOutcomeCopy({ outcome: "processing", kind: "video", mode: "direct" });
    expect(c.title).toBe("TikTok is still processing it");
    expect(c.body).toBe("Ask 'did it go up?' in a few minutes.");
  });

  test("failures render the error's own title and card", () => {
    const e = new TikTokError("POSTING_CAP", {});
    const c = writeOutcomeCopy({ outcome: "failed", kind: "video", mode: "direct", error: e });
    expect(c.title).toBe(e.title);
    expect(c.body).toBe(e.card);
    expect(c.spoken).toBe(e.spoken);
    const safe = writeOutcomeCopy({ outcome: "failed", kind: "photos", mode: "drafts", error: new TikTokError("IMAGE_UNREADABLE", { name: "IMG_1.HEIC", nothing_sent: true }) });
    expect(safe.body).toEndWith("Nothing was sent to TikTok.");
    // Not said twice when the card already says it.
    const relay = writeOutcomeCopy({ outcome: "failed", kind: "photos", mode: "drafts", error: new TikTokError("RELAY_UNAVAILABLE", { nothing_sent: true }) });
    expect(relay.body.match(/Nothing was sent to TikTok/g)?.length).toBe(1);
  });

  test("unknown and refused default to their codes' copy", () => {
    const unknown = writeOutcomeCopy({ outcome: "unknown", kind: "video", mode: "direct" });
    expect(unknown.title).toBe(new TikTokError("OUTCOME_UNKNOWN").title);
    expect(unknown.body).toBe(new TikTokError("OUTCOME_UNKNOWN").card);
    const refused = writeOutcomeCopy({ outcome: "refused", kind: "video", mode: "direct" });
    expect(refused.title).toBe("Not sent");
    expect(refused.body).toContain(new TikTokError("CONFIRMATION_REQUIRED").card);
    expect(refused.body).toEndWith("Nothing was sent to TikTok.");
  });
});

describe("writeResultCard", () => {
  test("one title and one short line: the account, what happened, what to do; no caption quote", () => {
    const w = writeResultCard({ outcome: "inbox", kind: "video", mode: "drafts", name: "final_export.mp4", account_label: "@maya.makes", caption: "day 3 of building VoiceOS #buildinpublic", caption_copied: true });
    expectValid(w);
    const text = visibleText(w);
    for (const s of ["@maya.makes", "Sent to TikTok drafts", "Tap the TikTok notification to finish. Your caption is copied."]) expect(text).toContain(s);
    // The caption was just approved on the confirmation card: the completion card doesn't repeat it.
    expect(text).not.toContain("day 3 of building VoiceOS");
    expect(markup(w)).toContain("is-good");
    for (const outcome of ["inbox", "posted", "processing"] as const) {
      const t = visibleText(writeResultCard({ outcome, kind: "video", mode: "direct", caption: "secret plans", caption_copied: true, poster: PORTRAIT }));
      expect({ outcome, caption: t.includes("secret plans") }).toEqual({ outcome, caption: false });
    }
  });

  test("the file name stands in for a frame: shown only when there's no picture", () => {
    expect(visibleText(writeResultCard({ outcome: "inbox", kind: "video", mode: "drafts", name: "final_export.mp4" }))).toContain("final_export.mp4");
    expect(visibleText(writeResultCard({ outcome: "inbox", kind: "video", mode: "drafts", name: "final_export.mp4", poster: PORTRAIT }))).not.toContain("final_export.mp4");
  });

  test("a direct post says it can take a few minutes to show (TikTok's guidelines); processing shows the rail", () => {
    for (const kind of ["video", "photos"] as const) {
      expect(visibleText(writeResultCard({ outcome: "posted", kind, mode: "direct", count: 3, privacy_label: "SELF_ONLY" }))).toContain("May take a few minutes to show on your profile.");
    }
    const p = writeResultCard({ outcome: "processing", kind: "video", mode: "direct", poster: PORTRAIT });
    expect(markup(p)).toContain("tt-rail");
    expect(visibleText(p)).toContain("Ask 'did it go up?' in a few minutes.");
  });

  test("honest endings: a failure says nothing was sent when that's true; not confirmed says to check first; a refusal says it once", () => {
    const failed = visibleText(writeResultCard({ outcome: "failed", kind: "photos", mode: "drafts", count: 8, error: new TikTokError("IMAGE_UNREADABLE", { name: "IMG_2041.HEIC", nothing_sent: true }) }));
    expect(failed).toContain("Nothing was sent to TikTok.");
    expect(visibleText(writeResultCard({ outcome: "unknown", kind: "video", mode: "direct" }))).toContain("before trying again");
    const refused = visibleText(writeResultCard({ outcome: "refused", kind: "video", mode: "drafts" }));
    expect(refused).toContain("Not sent");
    expect(refused).toContain("click the card's button");
    expect(refused).not.toContain("Nothing was sent to TikTok.");
    // The words the task panel and the model get keep the full sentence.
    expect(writeOutcomeCopy({ outcome: "refused", kind: "video", mode: "drafts" }).body).toEndWith("Nothing was sent to TikTok.");
  });

  test("the video's frame leads, with the outcome on it: a check that draws in, a shimmer while processing, a dimmed frame when nothing went up", () => {
    const ok = writeResultCard({ outcome: "inbox", kind: "video", mode: "drafts", name: "ep09.mp4", poster: PORTRAIT });
    expectValid(ok);
    // A frame makes the completion card's tile the big one (the moment the user sees what went up).
    expect(markup(ok)).toContain('<span class="tt-m z-h has-i kb"');
    expect(markup(ok)).toContain('<span class="tt-m-b is-good"><svg class="tt-ck"');
    expect(markup(writeResultCard({ outcome: "processing", kind: "video", mode: "direct", poster: PORTRAIT }))).toContain('<span class="tt-m-sh"></span>');
    for (const outcome of ["failed", "refused"] as const) {
      const html = markup(writeResultCard({ outcome, kind: "video", mode: "direct", error: new TikTokError("POSTING_CAP"), poster: PORTRAIT }));
      expect(html).toContain("is-dim");
      expect(html).not.toContain("tt-ck");
    }
    // Landscape frames get a 16:9 tile; no frame (or a bad one) is the fallback tile, never a broken image.
    expect(markup(writeResultCard({ outcome: "inbox", kind: "video", mode: "drafts", poster: LANDSCAPE }))).toContain('<span class="tt-m z-l is-w has-i kb"');
    for (const bad of BAD_IMAGES) expect(imgCount(writeResultCard({ outcome: "inbox", kind: "video", mode: "drafts", poster: bad }))).toBe(0);
    // Photos without thumbnails: the plain stack (three still cards), the count on the top one.
    expect(markup(writeResultCard({ outcome: "inbox", kind: "photos", mode: "drafts", count: 8 }))).toContain('<span class="tt-ps-p">8</span>');
  });

  test("failure is bad-toned; an unknown outcome is not", () => {
    expect(markup(writeResultCard({ outcome: "failed", kind: "video", mode: "direct", error: new TikTokError("POSTING_CAP") }))).toContain("is-bad");
    expect(markup(writeResultCard({ outcome: "unknown", kind: "video", mode: "direct" }))).not.toContain("is-bad");
  });
});

describe("errorCard", () => {
  test("title and card text from errors.ts", () => {
    const e = new TikTokError("AUTH_EXPIRED", {});
    const w = errorCard(e);
    expectValid(w);
    const text = visibleText(w);
    expect(text).toContain(e.title);
    expect(text).toContain(e.card);
    expect(w.label).toBe(e.title);
  });

  test("nothing sent is said once: by the title when it says Not sent, else by the line", () => {
    const text = visibleText(errorCard(new TikTokError("CONFIRMATION_REQUIRED", { reason: "missing", nothing_sent: true })));
    expect(text).toContain("Not sent");
    expect(text).not.toContain("Nothing was sent to TikTok");
    const relay = visibleText(errorCard(new TikTokError("RELAY_UNAVAILABLE", { nothing_sent: true })));
    expect(relay.match(/Nothing was sent to TikTok/g)?.length).toBe(1);
    expect(visibleText(errorCard(new TikTokError("IMAGE_UNREADABLE", { name: "a.heic", nothing_sent: true })))).toContain("Nothing was sent to TikTok.");
    expect(visibleText(errorCard(new TikTokError("POSTING_CAP")))).not.toContain("Nothing was sent");
  });

  test("a refusal or an unknown outcome isn't painted as a failure", () => {
    for (const code of ["CONFIRMATION_REQUIRED", "CANCELLED", "OUTCOME_UNKNOWN", "TIMEOUT"] as const) {
      expect({ code, bad: markup(errorCard(new TikTokError(code))).includes("is-bad") }).toEqual({ code, bad: false });
    }
    expect(markup(errorCard(new TikTokError("AUTH_EXPIRED")))).toContain("is-bad");
  });

  test("hostile messages are escaped", () => {
    const w = errorCard(new TikTokError("UNKNOWN", { message: HOSTILE }));
    expect(w.html).not.toContain("<script>alert(1)");
    expect(w.html).not.toContain("<img src=x");
  });
});

describe("agent-only helper cards", () => {
  test("video candidates: name, where, size, when, length", () => {
    const w = videoCandidatesCard({
      videos: [{ name: "final_export.mp4", folder: "Downloads", duration_label: "0:23", size_label: "18.2 MB", added_label: "2 min ago" }],
      query_matched: true,
      denied_folders: [],
    });
    expectValid(w);
    const text = visibleText(w);
    for (const s of ["final_export.mp4", "0:23", "Downloads · 2 min ago"]) expect(text).toContain(s);
    // Size and shape stay in the JSON; the length is the tile's pill.
    expect(text).not.toContain("18.2 MB");
    // More than one: the newest leads, the rest are compact rows with folder · when.
    const two = visibleText(
      videoCandidatesCard({
        videos: [
          { name: "final_export.mp4", folder: "Downloads", duration_label: "0:23", size_label: "18.2 MB", added_label: "2 min ago", width: 1080, height: 1920 },
          { name: "demo.mov", folder: "Desktop", duration_label: "4:12", size_label: "312 MB", added_label: "1 hour ago" },
        ],
        query_matched: true,
        denied_folders: [],
      }),
    );
    for (const s of ["Newest", "demo.mov", "Desktop · 1 hour ago", "4:12"]) expect(two).toContain(s);
    expect(two).not.toContain("9:16");
  });

  test("video candidates: where the match was found, quiet above the videos, escaped", () => {
    const w = videoCandidatesCard({
      videos: [{ name: "ep09-ai-agents.mp4", folder: "Movies/Tiny AI Lab", duration_label: "0:38", size_label: "38.6 MB", added_label: "2 min ago" }],
      query_matched: true,
      denied_folders: [],
      note: "Not in Downloads. Found it in Movies › Tiny AI Lab.",
    });
    expectValid(w);
    const text = visibleText(w);
    expect(text).toContain("Not in Downloads. Found it in Movies › Tiny AI Lab.");
    expect(text).toContain("Best match");
    expect(markup(w).indexOf("tt-info")).toBeLessThan(markup(w).indexOf("ep09-ai-agents.mp4"));
    const hostile = videoCandidatesCard({ videos: [{ name: "a.mov", folder: "Desktop", size_label: "1 MB", added_label: "just now" }], query_matched: true, denied_folders: [], note: `Closest name to "${HOSTILE}".` });
    expect(markup(hostile)).not.toContain("<script>alert(1)");
    expect(visibleText(hostile)).toContain(`Closest name to "${HOSTILE}".`);
    expect(markup(videoCandidatesCard({ videos: [{ name: "a.mov", folder: "Desktop", size_label: "1 MB", added_label: "just now" }], query_matched: true, denied_folders: [] }))).not.toContain("tt-info");
  });

  test("video candidates: no match, denied folders and the empty state", () => {
    const w = videoCandidatesCard({ videos: [{ name: "a.mov", folder: "Desktop", size_label: "1 MB", added_label: "just now" }], query_matched: false, denied_folders: ["Movies"] });
    const text = visibleText(w);
    expect(text).toContain("No name matched; newest first.");
    expect(text).toContain("Movies");
    const empty = videoCandidatesCard({ videos: [], query_matched: true, denied_folders: [] });
    expectValid(empty);
    expect(visibleText(empty)).toContain("None in Downloads, Desktop or Movies. Say its name, or export it first.");
  });

  test("image candidates: the batch hint, rows and the rest counted", () => {
    const images = Array.from({ length: 8 }, (_, i) => ({ name: `IMG_20${i}.HEIC`, folder: "Downloads", added_label: "2 min ago", dims: "4032×3024" }));
    const w = imageCandidatesCard({ images, batch_hint: "8 images arrived together at 10:42", total: 8, query_matched: true, denied_folders: [] });
    expectValid(w);
    const text = visibleText(w);
    for (const s of ["8 images arrived together at 10:42", "IMG_200.HEIC", "Downloads · 2 min ago", "8 photos"]) expect(text).toContain(s);
    expect(text).not.toContain("4032×3024");
    expect(text).toMatch(/Showing \d of 8/);
    const empty = imageCandidatesCard({ images: [], total: 0, query_matched: true, denied_folders: [] });
    expectValid(empty);
    expect(visibleText(empty)).toContain("None in Downloads, Desktop, Pictures or Screenshots.");
  });

  test("bundle: count, order and the warning", () => {
    const w = bundleCard({ count_label: "8 photos · cover: photo 2", order_label: "1 beach · 2 sunset · 3 dinner · 4 tram", warning: "3 photos are HEIC and will be converted to JPEG" });
    expectValid(w);
    const text = visibleText(w);
    for (const s of ["8 photos · cover: photo 2", "1 beach · 2 sunset", "3 photos are HEIC and will be converted to JPEG"]) expect(text).toContain(s);
    for (const s of ["Carousel", "Nothing is uploaded"]) expect(text).not.toContain(s);
  });

  test("creator: nickname, who can view, and why it can't post", () => {
    const ok = creatorCard({ creator_nickname: "Maya Makes", privacy_labels: ["Only me"], can_post: true, duration_ok: true, max_duration_label: "10:00" });
    expectValid(ok);
    for (const s of ["Maya Makes", "Only me", "10:00"]) expect(visibleText(ok)).toContain(s);
    const no = visibleText(creatorCard({ creator_nickname: "Maya", privacy_labels: [], can_post: false }));
    expect(no).toContain(new TikTokError("CREATOR_CANNOT_POST").title);
    const long = visibleText(creatorCard({ creator_nickname: "Maya", privacy_labels: ["Only me"], can_post: true, duration_ok: false, max_duration_label: "1:00" }));
    expect(long).toContain("Longer than your account allows (1:00).");
  });
});

describe("the photo stack (iMessage style)", () => {
  /** Tiny AI Lab stills, 300 × 400 (3:4), standing in for prepare_photo_post's thumbnails. */
  const PHOTOS = [1, 2, 3, 4, 5, 6].map((i) => jpeg(`photo-${i}.jpg`));
  const css = (w: Widget) => w.html.slice(w.html.indexOf("<style>"), w.html.indexOf("</style>"));
  const stackCards = (w: Widget) => [...markup(w).matchAll(/<span class="tt-ps-c s(\d)">/g)].map((m) => Number(m[1]));
  const scripts = (w: Widget) => [...markup(w).matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");

  test("every photo of the carousel stacks as a 3:4 card in order, the first on top, each with its place", () => {
    const w = bundleCard({ count_label: "6 photos · cover: photo 3", order_label: "1 a · 2 b · 3 c · 4 d · 5 e · 6 f", count: 6, cover_index: 2, thumbs: PHOTOS });
    expectValid(w);
    expect(stackCards(w)).toEqual([0, 1, 2, 3, 4, 4]);
    expect(imgCount(w)).toBe(6);
    for (const t of PHOTOS) expect(w.html).toContain(t);
    expect([...markup(w).matchAll(/<span class="tt-ps-p">([^<]+)<\/span>/g)].map((m) => m[1])).toEqual(["1/6", "2/6", "3/6", "4/6", "5/6", "6/6"]);
    // The cover says so (on the third card), the dots count the cards, and the title reads as a count.
    expect(markup(w).split('<span class="tt-ps-c s').findIndex((part) => part.includes("tt-ps-cv"))).toBe(3);
    expect((markup(w).match(/<i( class="on")?><\/i>/g) ?? []).length).toBe(6);
    const text = visibleText(w);
    for (const s of ["6 photos", "Cover: photo 3", "1 a · 2 b"]) expect(text).toContain(s);
    expect(w.html.length).toBeLessThan(280_000);
  });

  test("a long carousel: all 35 photos, the card stays under VoiceOS's cap; no dots past twelve", () => {
    // Thumbnails as prepare_photo_post sizes them for 35 photos (~5-6K characters each).
    const many = Array.from({ length: 35 }, (_, i) => `data:image/jpeg;base64,/9j/${String(i).padStart(2, "0")}${"A".repeat(5_600)}`);
    const w = bundleCard({ count_label: "35 photos", order_label: "", count: 35, cover_index: 0, thumbs: many });
    expectValid(w);
    expect(stackCards(w)).toHaveLength(35);
    expect(w.html.length).toBeLessThan(290_000);
    expect(markup(w)).not.toContain('class="tt-ps-d"');
    expect(markup(w)).toContain('<span class="tt-ps-p">35/35</span>');
  });

  test("the stack moves by script: auto-advance, click, swipe, trackpad and keys; ES5 and nothing compiled from strings", () => {
    const w = bundleCard({ count_label: "", order_label: "", count: 3, thumbs: PHOTOS.slice(0, 3) });
    expect(markup(w)).toContain('class="tt-ps z-xl n3 is-live is-deep has-i" role="group" tabindex="0"');
    const js = scripts(w);
    expect(js).toContain(STACK_JS);
    for (const ev of ["'click'", "'pointerup'", "'wheel'", "'keydown'", "'mouseenter'", "prefers-reduced-motion: reduce"]) expect(STACK_JS).toContain(ev);
    new vm.Script(STACK_JS);
    expect(STACK_JS).not.toMatch(/=>|`|\blet\b|\bconst\b|\bclass\b|\beval\b|new Function|innerHTML/);
    // The look comes from the sheet: depths, the flick, the reduced-motion fade, transitions only under no-preference.
    const sheet = css(w);
    expect(sheet).toContain(".tt-ps-c.s0{transform:translate(0,0) rotate(0deg) scale(1);opacity:1;filter:brightness(1);z-index:6}");
    expect(sheet).toContain(".tt-ps-c.s1{transform:translate(15%,-2%) rotate(8deg)");
    expect(sheet).toContain(".tt-ps-c.out{transform:translate(-44%,-9%) rotate(-14deg) scale(.97)");
    expect(sheet).toContain("@media(prefers-reduced-motion:no-preference){.tt-ps-c{transition:");
    expect(sheet).toContain("@media(prefers-reduced-motion:reduce){.tt-ps.is-live .tt-ps-c{transform:translate(0,0) rotate(0deg) scale(1);filter:none;opacity:1;transition:opacity .48s ease}.tt-ps.is-live .tt-ps-c.fade{opacity:0}}");
    expect(sheet).toContain("html[data-k-theme=light] .tt-ps-c{");
  });

  test("the driver flicks the top card, the next comes up, the dots follow (a tiny DOM)", () => {
    const w = bundleCard({ count_label: "", order_label: "", count: 3, thumbs: PHOTOS.slice(0, 3) });
    const cards = [0, 1, 2].map((i) => ({ className: `tt-ps-c s${i}` }));
    const dots = [0, 1, 2].map((i) => ({ className: i ? "" : "on" }));
    const on: Record<string, (e: unknown) => void> = {};
    const box = { querySelectorAll: (s: string) => (s === ".tt-ps-c" ? cards : dots), addEventListener: (t: string, f: (e: unknown) => void) => (on[t] = f) };
    const timers: Array<() => void> = [];
    vm.runInNewContext(STACK_JS, {
      window: { matchMedia: () => ({ matches: false }) },
      document: { querySelectorAll: () => [box], hidden: false },
      setTimeout: (f: () => void) => (timers.push(f), timers.length),
      clearTimeout: () => {},
      Math,
    });
    on.click({});
    expect(cards.map((c) => c.className)).toEqual(["tt-ps-c out", "tt-ps-c s0", "tt-ps-c s1"]);
    expect(dots.map((d) => d.className)).toEqual(["", "on", ""]);
    // The flick's own timers (tuck in at the back, then settle); timers[0] and [3] are the auto-advance loop.
    timers[1]();
    timers[2]();
    expect(cards.map((c) => c.className)).toEqual(["tt-ps-c s2", "tt-ps-c s0", "tt-ps-c s1"]);
    // A swipe right brings the last one back on top.
    on.pointerdown({ clientX: 100 });
    on.pointerup({ clientX: 160 });
    expect(cards[0].className).toBe("tt-ps-c out under");
    expect(w.html).toContain(STACK_JS);
  });

  test("tall photos (slides) get tall 9:16 cards", () => {
    // A 9:16 JPEG header is enough: the cards read the first thumbnail's size.
    const tall = jpeg("poster-1.jpg");
    const w = bundleCard({ count_label: "", order_label: "", count: 2, thumbs: [tall, tall] });
    expect(markup(w)).toContain('class="tt-ps z-xl is-tall n2');
    expect(css(w)).toContain(".tt-ps.z-xl.is-tall{width:156px;height:207px}");
  });

  test("one photo is one card: no position, dots or loop", () => {
    const w = bundleCard({ count_label: "1 photo", order_label: "1 a", count: 1, cover_index: 0, thumbs: PHOTOS.slice(0, 1) });
    expectValid(w);
    expect(stackCards(w)).toEqual([0]);
    expect(markup(w)).not.toContain('class="tt-ps-p"');
    expect(markup(w)).not.toContain('class="tt-ps-d"');
    expect(markup(w)).not.toContain("is-live");
    expect(scripts(w)).not.toContain("tt-ps.is-live");
    expect(visibleText(w)).toContain("1 photo");
  });

  test("bad or oversized thumbnails are left out; none left is a designed stack with the count and a word", () => {
    const w = bundleCard({ count_label: "6 photos · cover: photo 1", order_label: "", count: 6, cover_index: 0, thumbs: BAD_IMAGES });
    expectValid(w);
    expect(imgCount(w)).toBe(0);
    expect(stackCards(w)).toEqual([0, 1, 2]);
    expect(markup(w)).toContain('<span class="tt-ps-p">6</span>');
    expect(markup(w)).toContain('<span class="tt-ps-nm">6 photos</span>');
    expect(markup(w)).not.toContain("is-live");
    // The stack's own budget keeps big pictures inside VoiceOS's limit.
    const big = `data:image/jpeg;base64,${"A".repeat(60_000)}`;
    const heavy = bundleCard({ count_label: "", order_label: "", count: 5, thumbs: [big, big, big, big, big] });
    expect(imgCount(heavy)).toBe(3);
    expect(heavy.html.length).toBeLessThan(290_000);
  });

  test("numbered slide names read as words: '11 slides, in order'", () => {
    const order = Array.from({ length: 11 }, (_, i) => `${i + 1} ${String(i + 1).padStart(2, "0")}`).join(" · ");
    expect(orderText(order, 11)).toBe("11 slides, in order");
    expect(visibleText(bundleCard({ count_label: "11 photos", order_label: order, count: 11 }))).toContain("11 slides, in order");
    expect(visibleText(bundleCard({ count_label: "11 photos", order_label: order, count: 11 }))).not.toContain("1 01");
    expect(orderText("1 beach · 2 sunset", 2)).toBe("1 beach · 2 sunset");
  });

  test("file names with their own numbers aren't numbered twice", () => {
    expect(orderText("1 01 meet juicy drama · 2 02 ep1 strawberry-never-paid · 3 03 ep2 two-brides …", 6)).toBe(
      "01 meet juicy drama · 02 ep1 strawberry-never-paid · 03 ep2 two-brides …",
    );
    expect(orderText("1 beach · 2 2024_sunset", 2)).toBe("1 beach · 2 2024_sunset");
  });

  test("completion, status and posting-as cards carry the same stack, still and dimmed when it failed", () => {
    const sent = writeResultCard({ outcome: "inbox", kind: "photos", mode: "drafts", count: 6, thumbs: PHOTOS, cover_index: 0 });
    expectValid(sent);
    expect(markup(sent)).toContain('<span class="tt-ps z-l n6 is-live is-deep has-i"');
    expect(markup(sent)).toContain('<span class="tt-m-b is-good"');
    const failed = writeResultCard({ outcome: "failed", kind: "photos", mode: "drafts", count: 6, error: new TikTokError("RELAY_UNAVAILABLE"), thumbs: PHOTOS });
    expect(markup(failed)).toContain('<span class="tt-ps z-l n6 is-deep is-dim has-i"');
    expect(markup(failed)).toContain('<span class="tt-m-b is-bad"');
    const up = statusCard({ state: "uploading", kind: "photos", mode: "drafts", count: 4, thumbs: PHOTOS.slice(0, 4), now: NOW });
    expectValid(up);
    expect(markup(up)).toContain('<span class="tt-ps z-l n4 is-live is-deep has-i"');
    expect(markup(up)).toContain('<span class="tt-m-sh"></span>');
    const gone = statusCard({ state: "failed", kind: "photos", mode: "drafts", count: 4, thumbs: PHOTOS.slice(0, 4), reason: "x", now: NOW });
    expect(markup(gone)).not.toContain("is-live");
    expect(imgCount(statusCard({ state: "inbox", kind: "photos", mode: "drafts", count: 2, poster: PORTRAIT, now: NOW }))).toBe(0);
    const posting = creatorCard({ creator_nickname: "Tiny AI Lab", privacy_labels: ["SELF_ONLY"], can_post: true, kind: "photos", count: 6, cover_index: 0, thumbs: PHOTOS });
    expectValid(posting);
    expect(markup(posting)).toContain('<span class="tt-ps z-xl n6 is-live');
    for (const s of ["Ready to post", "6 photos", "Who can view: Only me", "Posting as Tiny AI Lab"]) expect(visibleText(posting)).toContain(s);
  });

  test("photo candidates show each photo as a 3:4 thumbnail", () => {
    const w = imageCandidatesCard({ images: PHOTOS.slice(0, 3).map((thumb, i) => ({ name: `p${i}.png`, folder: "Downloads", added_label: "now", thumb })), total: 3, query_matched: true, denied_folders: [] });
    expectValid(w);
    expect((markup(w).match(/<span class="tt-m z-ph has-i"/g) ?? []).length).toBe(3);
    expect(imgCount(w)).toBe(3);
  });
});

describe("the video playing (moving loops)", () => {
  const WEBP = `data:image/webp;base64,${Buffer.from("RIFF\0\0\0\0WEBPVP8X").toString("base64")}`;
  const STRIP = PORTRAIT;
  test("cardMotion takes an animated WebP or a JPEG filmstrip, nothing else", () => {
    expect(cardMotion({ src: WEBP })).toEqual({ src: WEBP });
    expect(cardMotion({ src: STRIP, frames: 20, fps: 8 })).toEqual({ src: STRIP, frames: 20, fps: 8 });
    for (const bad of [null, "x", { src: STRIP }, { src: WEBP, frames: 1 }, { src: STRIP, frames: 99 }, { src: "data:image/gif;base64,R0lG" }, { src: `${WEBP}"><script>` }, { src: `data:image/webp;base64,${"A".repeat(130_000)}` }]) {
      expect(cardMotion(bad)).toBeUndefined();
    }
  });

  test("the find card's lead, the posting-as card and the completion card play the video big", () => {
    const base = { name: "enigma recipe final.mp4", folder: "Downloads", duration_label: "0:45", size_label: "64.7 MB", added_label: "Yesterday", width: 1080, height: 1920, poster: PORTRAIT };
    const find = videoCandidatesCard({ videos: [{ ...base, motion: { src: WEBP } }], query_matched: true, denied_folders: [], confidence: "exact" });
    expectValid(find);
    expect(markup(find)).toContain('<span class="tt-m z-h has-i is-mo"');
    expect(markup(find)).toContain(`<img class="tt-m-i tt-m-mo" src="${WEBP}" alt="">`);
    const legacy = videoCandidatesCard({ videos: [{ ...base, motion: { src: STRIP, frames: 20, fps: 8 } }, base], query_matched: true, denied_folders: [] });
    expect(markup(legacy)).toContain('style="width:2000%;animation-duration:2.500s;animation-timing-function:steps(20)"');
    const posting = creatorCard({ creator_nickname: "Tiny AI Lab", privacy_labels: ["SELF_ONLY"], can_post: true, kind: "video", file_name: base.name, duration_label: "0:45", width: 1080, height: 1920, poster: PORTRAIT, motion: { src: WEBP } });
    expectValid(posting);
    expect(markup(posting)).toContain("tt-m-mo");
    for (const s of ["Ready to post", "enigma recipe final.mp4", "Who can view: Only me", "Posting as Tiny AI Lab"]) expect(visibleText(posting)).toContain(s);
    const done = writeResultCard({ outcome: "inbox", kind: "video", mode: "drafts", name: base.name, poster: PORTRAIT, motion: { src: WEBP } });
    expect(markup(done)).toContain('<span class="tt-m z-h has-i is-mo"');
    // Nothing went up: a still, dimmed frame, no loop.
    expect(markup(writeResultCard({ outcome: "failed", kind: "video", mode: "drafts", name: base.name, poster: PORTRAIT, motion: { src: WEBP }, error: new TikTokError("UNKNOWN") }))).not.toContain("tt-m-mo");
    // Reduced motion shows the poster instead of the loop; a filmstrip only plays under no-preference.
    expect(find.html).toContain("@media(prefers-reduced-motion:reduce){.tt-m.is-mo:has(>.tt-m-i:not(.tt-m-mo)) .tt-m-mo{display:none}}");
    expect(find.html).toContain("@media(prefers-reduced-motion:no-preference){.tt-m-fsi{animation-name:tt-fs;");
  });

  test("posting as: the account, plus who can view only when there's one choice (the next card picks otherwise)", () => {
    const base = { creator_nickname: "Tiny AI Lab", can_post: true, kind: "video" as const, file_name: "enigma recipe final.mp4", duration_label: "0:45", width: 1080, height: 1920, poster: PORTRAIT, max_duration_label: "10 minutes" };
    const many = visibleText(creatorCard({ ...base, privacy_labels: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"] }));
    expect(many).toContain("Posting as Tiny AI Lab");
    for (const s of ["Everyone", "Who can view", "You pick", "Longest video", "10 minutes", "Only me"]) expect(many).not.toContain(s);
    expect(visibleText(creatorCard({ ...base, privacy_labels: ["SELF_ONLY"] }))).toContain("Who can view: Only me");
    const photos = visibleText(creatorCard({ ...base, kind: "photos", count: 3, thumbs: [PORTRAIT, PORTRAIT, PORTRAIT], privacy_labels: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"] }));
    expect(photos).not.toContain("Who can view");
    // A landscape video with no frame stands beside the words (a named wide tile), not a big empty box across the card.
    const bare = creatorCard({ ...base, poster: undefined, width: 3024, height: 1964, privacy_labels: ["SELF_ONLY"] });
    expect(markup(bare)).toContain('<span class="tt-m z-xl is-w"');
    expect(bare.height).toBeLessThan(200);
  });

  test("a gallery of several videos plays a small loop in every cell, within the card's budget", () => {
    const loop = (k: number) => ({ src: `data:image/webp;base64,${"U".repeat(30_000)}${k}A==` });
    const vids = [0, 1, 2, 3].map((i) => ({ name: `clip-${i}.mp4`, folder: "Downloads", duration_label: "0:30", size_label: "9 MB", added_label: "today", width: 1080, height: 1920, poster: PORTRAIT, motion: loop(i), number: i + 1 }));
    const w = videoCandidatesCard({ videos: vids, query_matched: true, denied_folders: [], confidence: "likely" });
    expectValid(w);
    for (let i = 0; i < 4; i++) expect(w.html).toContain(loop(i).src);
    expect(w.html.length).toBeLessThan(290_000);
    // Six big loops don't all fit: the rest fall back to their posters, and the card stays under the cap.
    const six = [0, 1, 2, 3, 4, 5].map((i) => ({ ...vids[0], name: `c${i}.mp4`, number: i + 1, motion: { src: `data:image/webp;base64,${"V".repeat(39_000)}${i}A==` } }));
    const big = videoCandidatesCard({ videos: six, query_matched: true, denied_folders: [], confidence: "likely" });
    expect(big.html.length).toBeLessThan(290_000);
    expect(imgCount(big)).toBe(6);
  });

  test("no media is a designed tile with the file name, never an empty box", () => {
    const posting = creatorCard({ creator_nickname: "Tiny AI Lab", privacy_labels: ["SELF_ONLY"], can_post: true, kind: "video", file_name: "enigma recipe final.mp4", duration_label: "0:45" });
    expect(markup(posting)).toContain('<span class="tt-m z-h is-named"');
    expect(markup(posting)).toContain('<span class="tt-m-n">enigma recipe final.mp4</span>');
  });

  test("the loop and the posters share the card's budget: a full find card stays under the cap", () => {
    const big = { src: `data:image/webp;base64,${"A".repeat(120_000)}` };
    const poster = `data:image/jpeg;base64,${"A".repeat(60_000)}`;
    const base = { folder: "Downloads", size_label: "1 MB", added_label: "now", poster };
    const w = videoCandidatesCard({ videos: [{ ...base, name: "a.mp4", motion: big }, { ...base, name: "b.mp4" }, { ...base, name: "c.mp4" }, { ...base, name: "d.mp4" }], query_matched: true, denied_folders: [] });
    expect(w.html.length).toBeLessThan(290_000);
    expect(markup(w)).toContain("tt-m-mo");
  });
});

describe("sharp loops on a 2× notch: AVIF, WebP stills, seam-proof filmstrips, gallery shares", () => {
  /** An AVIF's ftyp (brand avis or avif) and an `ispe` property with its size, padded to `bytes`. */
  const avif = (w: number, h: number, bytes = 64, brand = "avis") => {
    const b = new Uint8Array(Math.max(48, bytes));
    const dv = new DataView(b.buffer);
    dv.setUint32(0, 28);
    b.set(new TextEncoder().encode(`ftyp${brand}`), 4);
    dv.setUint32(28, 20);
    b.set(new TextEncoder().encode("ispe"), 32);
    dv.setUint32(40, w);
    dv.setUint32(44, h);
    return `data:image/avif;base64,${Buffer.from(b).toString("base64")}`;
  };
  const webp = (chunk: "VP8X" | "VP8 " | "VP8L", w: number, h: number) => {
    const b = new Uint8Array(40);
    b.set(new TextEncoder().encode(`RIFF\0\0\0\0WEBP${chunk}`), 0);
    if (chunk === "VP8X") b.set([(w - 1) & 0xff, ((w - 1) >> 8) & 0xff, 0, (h - 1) & 0xff, ((h - 1) >> 8) & 0xff, 0], 24);
    if (chunk === "VP8 ") b.set([0, 0, 0, 0x9d, 0x01, 0x2a, w & 0xff, w >> 8, h & 0xff, h >> 8], 20);
    if (chunk === "VP8L") {
      const bits = ((w - 1) | ((h - 1) << 14)) >>> 0;
      b.set([0x2f, bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff], 20);
    }
    return `data:image/webp;base64,${Buffer.from(b).toString("base64")}`;
  };

  test("cardMotion takes an animated AVIF like a WebP; a filmstrip is JPEG only, with its smeared edge kept", () => {
    const loop = avif(216, 384);
    expect(cardMotion({ src: loop })).toEqual({ src: loop });
    expect(cardMotion({ src: loop, frames: 16, fps: 8 })).toBeUndefined();
    expect(cardMotion({ src: webp("VP8X", 216, 384), frames: 16 })).toBeUndefined();
    expect(cardMotion({ src: PORTRAIT, frames: 16, fps: 8, edge: 0.013889 })).toEqual({ src: PORTRAIT, frames: 16, fps: 8, edge: 0.013889 });
    // An edge that makes no sense is dropped, not trusted.
    for (const edge of [-1, 0.5, Number.NaN, "0.01"]) expect(cardMotion({ src: PORTRAIT, frames: 16, fps: 8, edge })).toEqual({ src: PORTRAIT, frames: 16, fps: 8 });
    expect(cardMotion({ src: `data:image/avif;base64,${"A".repeat(130_000)}` })).toBeUndefined();
  });

  test("a filmstrip shows only the frame inside its border: wider by the edges, shifted left by one", () => {
    const strip = { src: PORTRAIT, frames: 16, fps: 8, edge: 0.013889 };
    const w = writeResultCard({ outcome: "inbox", kind: "video", mode: "drafts", name: "a.mp4", poster: PORTRAIT, motion: strip });
    expectValid(w);
    expect(markup(w)).toContain('style="width:1644.4448%;left:-1.3889%;animation-duration:2.000s;animation-timing-function:steps(16)"');
  });

  test("an AVIF loop plays on the hero tiles", () => {
    const loop = { src: avif(216, 384, 90_000) };
    const done = writeResultCard({ outcome: "posted", kind: "video", mode: "direct", name: "a.mp4", poster: PORTRAIT, motion: loop });
    expectValid(done);
    expect(markup(done)).toContain(`<img class="tt-m-i tt-m-mo" src="${loop.src}" alt="">`);
    const posting = creatorCard({ creator_nickname: "Tiny AI Lab", privacy_labels: ["SELF_ONLY"], can_post: true, kind: "video", file_name: "a.mp4", width: 1080, height: 1920, poster: PORTRAIT, motion: loop });
    expectValid(posting);
    expect(markup(posting)).toContain('<span class="tt-m z-h has-i is-mo"');
  });

  test("WebP and AVIF stills are drawable (Windows covers); imageSize reads them so tiles take their shape", () => {
    const tall = avif(1080, 1920, 64, "avif");
    expect(cardImage(tall)).toBe(tall);
    expect(cardImage(webp("VP8X", 720, 1280))).toBeDefined();
    expect(imageSize(tall)).toEqual({ w: 1080, h: 1920 });
    expect(imageSize(webp("VP8X", 720, 1280))).toEqual({ w: 720, h: 1280 });
    expect(imageSize(webp("VP8 ", 1280, 720))).toEqual({ w: 1280, h: 720 });
    expect(imageSize(webp("VP8L", 300, 400))).toEqual({ w: 300, h: 400 });
    expect(imageSize(`data:image/webp;base64,${Buffer.from("RIFF\0\0\0\0WEBPJUNK").toString("base64")}`)).toBeUndefined();
    // A landscape WebP cover gets a landscape tile.
    const w = videoListCard({ videos: [video({ id: "a" })], has_more: false }, NOW, { covers: { a: webp("VP8X", 1280, 720) } });
    expectValid(w);
    expect(markup(w)).toContain("is-w");
  });

  test("galleryCell is the box the gallery draws, and the cells' loop shares add up to the card's budget", () => {
    expect([2, 3, 4, 5, 6].map((k) => galleryCell(k, true)).map((c) => [c.w, c.h])).toEqual([[112, 150], [102, 136], [83, 124], [69, 92], [69, 92]]);
    expect(galleryCell(2, false)).toMatchObject({ w: 175, h: 98 });
    for (const k of [2, 3, 4, 5, 6]) expect(galleryCell(k, true).chars * k).toBeLessThanOrEqual(196_000);
    const base = { folder: "Downloads", duration_label: "0:30", size_label: "9 MB", added_label: "today", width: 1080, height: 1920, poster: PORTRAIT };
    const w = videoCandidatesCard({ videos: [0, 1, 2].map((i) => ({ ...base, name: `clip-${i}.mp4`, number: i + 1 })), query_matched: true, denied_folders: [], confidence: "likely" });
    expect(markup(w)).toContain('style="width:102px;height:136px"');
  });

  test("a gallery's loops can be bigger than a still (two cells: ~98K each) and all of them play", () => {
    const base = { folder: "Downloads", duration_label: "0:30", size_label: "9 MB", added_label: "today", width: 1080, height: 1920, poster: PORTRAIT };
    const two = [0, 1].map((i) => ({ ...base, name: `clip-${i}.mp4`, number: i + 1, motion: { src: avif(224, 398, 72_000 + i) } }));
    const w = videoCandidatesCard({ videos: two, query_matched: true, denied_folders: [], confidence: "ambiguous" });
    expectValid(w);
    for (const v of two) expect(w.html).toContain(v.motion.src);
    expect(w.html.length).toBeLessThan(290_000);
    // Six at their share each: every one plays.
    const six = [0, 1, 2, 3, 4, 5].map((i) => ({ ...base, name: `c${i}.mp4`, number: i + 1, motion: { src: avif(138, 246, Math.floor((galleryCell(6, true).chars - 40) * 0.75) - i) } }));
    const g = videoCandidatesCard({ videos: six, query_matched: true, denied_folders: [], confidence: "likely" });
    expectValid(g);
    for (const v of six) expect(g.html).toContain(v.motion.src);
    expect(g.html.length).toBeLessThan(290_000);
  });
});

describe("motion and theme", () => {
  test("every animation is opt-in under prefers-reduced-motion: no-preference", () => {
    const html = videoListCard({ videos: [video(), video({ id: "2" })], has_more: false }).html;
    const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
    const gate = css.indexOf("@media(prefers-reduced-motion:no-preference){\n.tt-m.kb");
    expect(gate).toBeGreaterThan(0);
    const ours = css.slice(css.indexOf("html[data-k-theme=light]{--good"));
    const before = ours.slice(0, ours.indexOf("@media(prefers-reduced-motion:no-preference){\n.tt-m.kb"));
    expect(before).not.toMatch(/animation:/);
    expect(css).toContain("html[data-k-theme=light] .tt-m{");
  });
});

describe("stress: long, wide and hostile text stays inside the card", () => {
  const LONG = `${"🎬 day 3 of building VoiceOS with a very long caption that keeps going ".repeat(40)}`;
  const CJK = "東京の夜景がとても綺麗でした。友達と一緒に新しいカフェを見つけて、最高の一日になりました！#東京 #カフェ巡り";
  const HANDLE = "a_really_long_handle_name";

  test("every card stays valid and compact", () => {
    const cards: Widget[] = [
      statsCard({ username: HANDLE.repeat(3), display_name: LONG, follower_count: 9_999_999_999, following_count: 0, likes_count: 0, video_count: 0, include_profile: true, is_verified: true, bio_description: LONG, profile_deep_link: SHARE }),
      videoListCard({ videos: Array.from({ length: 20 }, (_, i) => video({ id: String(i), caption: i % 2 ? CJK : LONG, view_count: 123_456_789_012, like_count: 0 })), has_more: true }),
      postDetailsCard(details({ caption: LONG.slice(0, 150), caption_truncated: true, hashtags: Array.from({ length: 30 }, (_, i) => `#tag${i}`), is_aigc: true })),
      postDetailsCard(details({ caption: CJK })),
      postsDetailsCard(Array.from({ length: 20 }, (_, i) => details({ id: String(i), caption: LONG }))),
      statusCard({ state: "failed", kind: "video", mode: "direct", name: LONG, privacy_label: LONG, reason: LONG, started_at: "not a date" }),
      writeResultCard({ outcome: "posted", kind: "photos", mode: "direct", count: 35, privacy_label: "Only me", caption: LONG, name: LONG, account_label: LONG }),
      writeResultCard({ outcome: "refused", kind: "video", mode: "drafts", account_label: HANDLE }),
      errorCard(new TikTokError("INVALID_PARAM", { message: LONG })),
      videoCandidatesCard({ videos: Array.from({ length: 10 }, () => ({ name: LONG, folder: LONG, duration_label: "1:02:03", size_label: "3.9 GB", added_label: "3 days ago" })), query_matched: false, denied_folders: ["Downloads", "Desktop", "Movies"] }),
      imageCandidatesCard({ images: Array.from({ length: 35 }, () => ({ name: CJK, folder: "Pictures/Trips/Lisbon", added_label: "just now", dims: "12000×9000" })), batch_hint: LONG, total: 35, query_matched: false, denied_folders: ["Pictures"] }),
      bundleCard({ count_label: LONG, order_label: LONG, warning: LONG }),
      creatorCard({ creator_nickname: LONG, privacy_labels: ["Everyone", "Friends", "Followers", "Only me"], can_post: false, duration_ok: false, max_duration_label: "10:00" }),
    ];
    for (const w of cards) {
      expectValid(w);
      // Clipped before rendering: the card is kit + CSS + a few KB of text, not the whole input.
      expect(w.html.length).toBeLessThan(60_000);
      expect(visibleText(w)).not.toMatch(/NaN|undefined|\[object/);
    }
  });
});
