import { describe, expect, test } from "bun:test";
import {
  FAIL_REASON_MAP,
  TIKTOK_CODE_MAP,
  TikTokError,
  failReasonError,
  isAuthShaped,
  normalizeError,
  privacyLabel,
  tiktokErrorFrom,
} from "../src/errors.ts";

describe("TikTok error.code → our code (plan §5.5)", () => {
  const expected: Record<string, string> = {
    access_token_invalid: "AUTH_EXPIRED",
    scope_not_authorized: "SCOPE_MISSING",
    rate_limit_exceeded: "RATE_LIMITED",
    spam_risk_too_many_posts: "POSTING_CAP",
    spam_risk_too_many_pending_share: "DRAFTS_CAP",
    spam_risk_user_banned_from_posting: "CREATOR_CANNOT_POST",
    reached_active_user_cap: "CREATOR_CANNOT_POST",
    unaudited_client_can_only_post_to_private_accounts: "PRIVATE_ACCOUNT_REQUIRED",
    privacy_level_option_mismatch: "PRIVACY_MISMATCH",
    url_ownership_unverified: "URL_OWNERSHIP_UNVERIFIED",
    invalid_file_upload: "UPLOAD_FAILED",
    invalid_param: "INVALID_PARAM",
    invalid_params: "INVALID_PARAM",
    invalid_publish_id: "INVALID_PARAM",
    token_not_authorized_for_specified_publish_id: "INVALID_PARAM",
    app_version_check_failed: "APP_VERSION_TOO_OLD",
    internal_error: "TIKTOK_SERVER",
  };
  for (const [tiktok, ours] of Object.entries(expected)) {
    test(`${tiktok} → ${ours}`, () => {
      expect(TIKTOK_CODE_MAP[tiktok]).toBe(ours as never);
      const e = tiktokErrorFrom({ code: tiktok, message: "m", log_id: "log_1" });
      expect(e.code).toBe(ours as never);
      expect(e.detail.log_id).toBe("log_1");
      expect(e.message.length).toBeGreaterThan(0);
      expect(e.card.length).toBeGreaterThan(0);
    });
  }

  test("scope errors name the missing scope when TikTok says it", () => {
    const e = tiktokErrorFrom({ code: "scope_not_authorized", message: "The user did not authorize the scope required: user.info.stats" });
    expect(e.card).toBe("Reconnect and allow user.info.stats.");
  });
});

describe("fail_reason → our code (TikTok's 13 values)", () => {
  const expected: Record<string, string> = {
    file_format_check_failed: "UNSUPPORTED_FORMAT",
    duration_check_failed: "FILE_TOO_LONG",
    frame_rate_check_failed: "UNSUPPORTED_FORMAT",
    picture_size_check_failed: "UNSUPPORTED_FORMAT",
    internal: "TIKTOK_SERVER",
    video_pull_failed: "PROCESSING_FAILED",
    photo_pull_failed: "RELAY_EXPIRED",
    publish_cancelled: "CANCELLED",
    auth_removed: "AUTH_REVOKED",
    spam_risk_too_many_posts: "POSTING_CAP",
    spam_risk_user_banned_from_posting: "CREATOR_CANNOT_POST",
    spam_risk_text: "CAPTION_FLAGGED",
    spam_risk: "POST_BLOCKED",
  };
  test("all 13 are mapped", () => expect(Object.keys(FAIL_REASON_MAP).sort()).toEqual(Object.keys(expected).sort()));
  for (const [reason, ours] of Object.entries(expected)) {
    test(`${reason} → ${ours}`, () => expect(failReasonError(reason).code).toBe(ours as never));
  }
  test("auth_removed says not to retry; spam_risk_text says fix first", () => {
    expect(failReasonError("auth_removed").detail.retry).toBe("no");
    expect(failReasonError("spam_risk_text").detail.retry).toBe("fix-first");
    expect(failReasonError("spam_risk_text").card).toContain("Edit the caption");
  });
  test("an unknown reason is shown, not hidden", () => {
    const e = failReasonError("brand_new_reason");
    expect(e.code).toBe("PROCESSING_FAILED");
    expect(e.card).toBe("Reason: brand_new_reason.");
  });
});

describe("normalizeError", () => {
  test("passes our errors through", () => {
    const e = new TikTokError("DRAFTS_CAP");
    expect(normalizeError(e)).toBe(e);
  });
  test("TikTok error objects, also nested under error", () => {
    expect(normalizeError({ code: "spam_risk_too_many_pending_share" }).code).toBe("DRAFTS_CAP");
    expect(normalizeError({ data: {}, error: { code: "url_ownership_unverified", message: "x" } }).code).toBe("URL_OWNERSHIP_UNVERIFIED");
  });
  test("JSON strings and free text that name a TikTok code", () => {
    expect(normalizeError('{"error":{"code":"rate_limit_exceeded"}}').code).toBe("RATE_LIMITED");
    expect(normalizeError("Error 403: url_ownership_unverified (photo host)").code).toBe("URL_OWNERSHIP_UNVERIFIED");
    // the longest code wins over a shorter prefix
    expect(normalizeError("tiktok said spam_risk_too_many_posts").code).toBe("POSTING_CAP");
  });
  test("a code inside a longer identifier isn't matched", () => {
    expect(normalizeError("xinvalid_param_name is fine").code).toBe("UNKNOWN");
  });
  test("a TikTok error object our map doesn't list keeps TikTok's code and message (a write then reads as refused, not unknown)", () => {
    const e = normalizeError({ data: {}, error: { code: "video_too_long_for_inbox", message: "Too long for the inbox.", log_id: "202611120000AA" } });
    expect(e.code).toBe("UNKNOWN");
    expect(e.detail).toMatchObject({ tiktok_code: "video_too_long_for_inbox", message: "Too long for the inbox.", log_id: "202611120000AA" });
    // Not TikTok's shape: Composio's numeric codes, one-word codes, and objects without a message or log_id.
    for (const raw of [{ code: 812, message: "x" }, { code: "error", message: "x" }, { code: "Some_Code", message: "x" }, { code: "video_too_long" }]) {
      expect(normalizeError(raw).detail.tiktok_code).toBeUndefined();
    }
  });
  test("Composio's own refusals by slug say Composio answered them", () => {
    for (const slug of ["ActionExecute_ConnectedAccountNotFound", "ConnectedAccountExpired", "ConnectedAccountInactive", "InvalidApiKey", "RateLimit_Exceeded"]) {
      expect(normalizeError({ error: { message: "x", slug } }).detail.source).toBe("composio");
    }
    expect(normalizeError({ composioStatus: 429 }).detail.source).toBeUndefined();
  });
  test("Composio slugs and statuses", () => {
    expect(normalizeError({ error: { message: "no account", slug: "ActionExecute_ConnectedAccountNotFound", status: 404 } }).code).toBe("NOT_CONNECTED");
    expect(normalizeError({ composioStatus: 401, message: "bad key" }, { composioOwn: true }).code).toBe("NOT_CONFIGURED");
    expect(normalizeError({ composioStatus: 401, message: "unauthorized" }).code).toBe("AUTH_EXPIRED");
    expect(normalizeError({ composioStatus: 429 }).code).toBe("RATE_LIMITED");
    expect(normalizeError({ composioStatus: 503 }).code).toBe("TIKTOK_SERVER");
  });
  test("timeouts and plain errors", () => {
    const t = new Error("timed out");
    t.name = "TimeoutError";
    expect(normalizeError(t).code).toBe("TIMEOUT");
    const u = normalizeError(new Error("something odd"));
    expect(u.code).toBe("UNKNOWN");
    expect(u.card).toBe("something odd Nothing was retried.");
  });
  test("unknown messages are trimmed to 200 characters", () => {
    const e = normalizeError("x".repeat(500));
    expect(String(e.detail.message).length).toBeLessThanOrEqual(200);
  });
});

describe("copy", () => {
  test("PRIVACY_MISMATCH lists the allowed options in plain words, and asks for a pick when none was made", () => {
    expect(new TikTokError("PRIVACY_MISMATCH", { chosen: "PUBLIC_TO_EVERYONE", options: ["SELF_ONLY"] }).card).toBe("Pick one of: Only me.");
    expect(new TikTokError("PRIVACY_MISMATCH", { chosen: "", options: ["SELF_ONLY", "MUTUAL_FOLLOW_FRIENDS"] }).card).toBe(
      "Pick who can see it on the card. Options: Only me, Friends.",
    );
  });
  test("FILE_TOO_LONG states both numbers", () => {
    expect(new TikTokError("FILE_TOO_LONG", { max: 60, dur: 161 }).card).toBe("Max 60s; this one is 161s. Send it to drafts instead and trim it in TikTok.");
  });
  test("FILE_TOO_LONG for a draft doesn't suggest drafts", () => {
    const card = new TikTokError("FILE_TOO_LONG", { max: 600, dur: 734, mode: "drafts" }).card;
    expect(card).toBe("Max 600s from apps; this one is 734s. Trim it, then send it again.");
    expect(card).not.toContain("drafts instead");
  });
  test("NOT_CONNECTED explains a user-id mismatch and an unfinished connection", () => {
    expect(new TikTokError("NOT_CONNECTED", { reason: "other_user" }).card).toContain("different Composio user ID");
    expect(new TikTokError("NOT_CONNECTED", { reason: "connecting" }).card).toContain("hasn't finished connecting");
    expect(new TikTokError("NOT_CONNECTED").card).toContain("Connected accounts");
  });
  test("a rejected key says so", () => {
    expect(new TikTokError("NOT_CONFIGURED", { reason: "key_rejected" }).card).toContain("didn't accept the API key");
  });
  test("CONFIRMATION_REQUIRED tells the user how to send it", () => {
    const e = new TikTokError("CONFIRMATION_REQUIRED");
    expect(e.message).toBe("Not sent. Nothing reached TikTok.");
    // Why a yes did nothing, the one action, and the fix when no card appears; short enough for the notch.
    expect(e.card).toContain("click the card's button");
    expect(e.card).toContain("saying yes sends nothing");
    expect(e.card).toContain("Ask before every action");
    expect(e.card.length).toBeLessThanOrEqual(120);
  });
  test("CONFIRMATION_REQUIRED for a card that showed other media says so, and how to fix it", () => {
    expect(new TikTokError("CONFIRMATION_REQUIRED", { reason: "card_mismatch", kind: "video" }).card).toBe(
      "The card named a different video. Ask again and check the file name.",
    );
    expect(new TikTokError("CONFIRMATION_REQUIRED", { reason: "card_mismatch", kind: "photos" }).card).toBe(
      "The card showed a different number of photos. Ask again and check the card.",
    );
    expect(new TikTokError("CONFIRMATION_REQUIRED", { reason: "mismatch" }).card).toContain("click the card's button");
  });
  test("toJSON carries the code and both texts, nothing else", () => {
    const j = new TikTokError("DRAFTS_CAP", { secret: "x" }).toJSON();
    expect(Object.keys(j).sort()).toEqual(["code", "detail", "message"]);
    expect(JSON.stringify(j)).not.toContain("secret");
  });
  test("every code has a title ≤ 60 chars and non-empty texts", () => {
    const codes = [
      "NOT_CONFIGURED", "NOT_CONNECTED", "AUTH_EXPIRED", "AUTH_REVOKED", "SCOPE_MISSING", "CREATOR_CANNOT_POST", "DRAFTS_CAP", "POSTING_CAP",
      "PRIVATE_ACCOUNT_REQUIRED", "PRIVACY_MISMATCH", "BRANDED_PRIVATE_BLOCKED", "DISCLOSURE_INCOMPLETE", "URL_OWNERSHIP_UNVERIFIED",
      "FILE_NOT_FOUND", "FOLDER_PERMISSION_DENIED", "FILE_TOO_LONG", "FILE_TOO_LARGE", "UNSUPPORTED_FORMAT", "TOO_MANY_PHOTOS", "NO_PHOTOS",
      "IMAGE_TOO_LARGE", "IMAGE_UNREADABLE", "INVALID_PARAM", "CAPTION_TOO_LONG", "TITLE_TOO_LONG", "DESCRIPTION_TOO_LONG",
      "RELAY_NOT_CONFIGURED", "RELAY_UNAVAILABLE", "RELAY_EXPIRED", "RATE_LIMITED", "PROCESSING_FAILED", "UPLOAD_FAILED", "TOKEN_STALE",
      "APP_VERSION_TOO_OLD", "MIXED_MEDIA_NOT_SUPPORTED", "CONFIRMATION_REQUIRED", "OUTCOME_UNKNOWN", "CAPTION_FLAGGED", "POST_BLOCKED",
      "CANCELLED", "TIMEOUT", "TIKTOK_SERVER", "UNKNOWN",
    ] as const;
    for (const c of codes) {
      const e = new TikTokError(c);
      expect(e.title.length).toBeGreaterThan(0);
      expect(e.title.length).toBeLessThanOrEqual(60);
      expect(e.message.length).toBeGreaterThan(0);
      expect(e.card.length).toBeGreaterThan(0);
      // Cards are a glance: at most two short sentences' worth (a long TikTok message is clipped by the card).
      expect({ c, long: e.card.length > 125 }).toEqual({ c, long: false });
    }
  });
  test("the text limits each name their own field's number", () => {
    expect(new TikTokError("CAPTION_TOO_LONG").card).toContain("2,200");
    expect(new TikTokError("TITLE_TOO_LONG").card).toContain("90");
    expect(new TikTokError("DESCRIPTION_TOO_LONG").card).toContain("4,000");
  });
  test("an unknown outcome still says to check TikTok before sending again", () => {
    expect(new TikTokError("OUTCOME_UNKNOWN").card).toContain("before trying again");
    expect(new TikTokError("RELAY_UNAVAILABLE").card).toContain("Nothing was sent to TikTok.");
    expect(new TikTokError("UPLOAD_FAILED").card).toContain("Nothing was posted.");
    expect(new TikTokError("AUTH_EXPIRED").card).toContain("Nothing was posted.");
  });
});

test("isAuthShaped", () => {
  expect(isAuthShaped(new TikTokError("AUTH_EXPIRED"))).toBe(true);
  expect(isAuthShaped(new TikTokError("UNKNOWN", { status: 401 }))).toBe(true);
  expect(isAuthShaped(new TikTokError("DRAFTS_CAP"))).toBe(false);
});

test("privacyLabel", () => {
  expect(privacyLabel("self_only")).toBe("Only me");
  expect(privacyLabel("FOLLOWER_OF_CREATOR")).toBe("Followers");
  expect(privacyLabel("WHATEVER")).toBe("WHATEVER");
});
