import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { COMPOSIO_BASE, INTEGRATION_ID, MEDIA_RELAY_BASE, defaultStateDir, loadConfig, resolveBaseUrl, resolveRelayBase } from "../src/config.ts";
import { realClock, run } from "../src/proc.ts";
import TKR from "../src/receiptCoreScript.ts";

describe("config", () => {
  test("reads the four preferences; user id defaults to 'default'; blanks are unset", () => {
    const c = loadConfig({ COMPOSIO_API_KEY: " key ", COMPOSIO_CONNECTED_ACCOUNT_ID: "ca_1", COMPOSIO_USER_ID: "  ", MEDIA_RELAY_TOKEN: "" }, []);
    expect(c.apiKey).toBe("key");
    expect(c.connectedAccountId).toBe("ca_1");
    expect(c.userId).toBe("default");
    expect(c.relayToken).toBeUndefined();
    expect(c.baseUrl).toBe(COMPOSIO_BASE);
    // The deployed relay unless a test points it at a loopback mock.
    expect(c.relayBase).toBe(MEDIA_RELAY_BASE);
  });
  test("only loopback base URLs are honoured (the key can't be pointed elsewhere)", () => {
    expect(resolveBaseUrl("http://127.0.0.1:4010/api/v3.1/")).toBe("http://127.0.0.1:4010/api/v3.1");
    expect(resolveBaseUrl("http://localhost:9/api/v3.1")).toBe("http://localhost:9/api/v3.1");
    expect(resolveBaseUrl("https://evil.example.com/api/v3.1")).toBe(COMPOSIO_BASE);
    expect(resolveBaseUrl("http://127.0.0.1.evil.com/api")).toBe(COMPOSIO_BASE);
    expect(resolveRelayBase("http://127.0.0.1:5000")).toBe("http://127.0.0.1:5000");
    expect(resolveRelayBase("https://relay.example.com")).toBe(MEDIA_RELAY_BASE);
  });
  test("test seams arrive as arguments", () => {
    const c = loadConfig({}, ["--state-dir=/tmp/s", "--home=/tmp/h", "--composio-base-url=http://127.0.0.1:1/api/v3.1"]);
    expect(c.stateDir).toBe("/tmp/s");
    expect(c.home).toBe("/tmp/h");
    expect(c.baseUrl).toBe("http://127.0.0.1:1/api/v3.1");
  });
  test("state lives in VoiceOS's integration-state folder, keyed by the manifest id", () => {
    expect(defaultStateDir("/Users/u", "darwin")).toBe(`/Users/u/Library/Application Support/VoiceOS/integration-state/${INTEGRATION_ID}`);
    expect(defaultStateDir("C:\\Users\\u", "win32", "C:\\AppData")).toContain(INTEGRATION_ID);
  });
});

describe("receipt core (the one script cards and server share)", () => {
  const sha = (s: string) => TKR.hex(TKR.sha256(TKR.utf8(s)));
  test("SHA-256 test vectors", () => {
    expect(sha("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  test("matches node:crypto on emoji, CJK and block boundaries", () => {
    for (const s of ["🚀 é\r\n#café ".repeat(300), "👨‍👩‍👧‍👦", "x".repeat(55), "x".repeat(56), "x".repeat(64), "日本語".repeat(1000)]) {
      expect(sha(s)).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
    }
  });
  test("signed fields per write, in the plan's order", () => {
    expect(TKR.SPECS.upload_video.map((f: string[]) => f[0])).toEqual(["file_token", "caption", "copy_caption"]);
    expect(TKR.SPECS.publish_video.map((f: string[]) => f[0])).toEqual([
      "post_token", "file_token", "creator_nickname", "privacy_options", "caption", "privacy_level", "allow_comment", "allow_duet",
      "allow_stitch", "commercial_disclosure", "brand_organic", "brand_content", "is_aigc", "cover_ms",
    ]);
    expect(TKR.SPECS.upload_photos.map((f: string[]) => f[0])).toEqual(["bundle_token", "title", "description"]);
    expect(TKR.SPECS.post_photos.map((f: string[]) => f[0])).toEqual([
      "bundle_token", "post_token", "creator_nickname", "privacy_options", "title", "description", "privacy_level", "allow_comment",
      "auto_add_music", "commercial_disclosure", "brand_organic", "brand_content",
    ]);
  });
  test("normalization: captions verbatim but CRLF, text trimmed, enums upper, toggles strict, ints decimal, options joined", () => {
    const c = JSON.parse(
      TKR.canonical("publish_video", {
        post_token: " pt ", caption: "  day 3\r\n#build  ", privacy_level: " self_only ", allow_comment: "TRUE", allow_duet: true,
        allow_stitch: "true", cover_ms: "0030", privacy_options: " self_only , mutual_follow_friends,", creator_nickname: " Maya ",
      }),
    );
    const get = (k: string) => c.find((p: unknown) => Array.isArray(p) && p[0] === k)[1];
    expect(get("post_token")).toBe("pt");
    expect(get("caption")).toBe("  day 3\n#build  ");
    expect(get("privacy_level")).toBe("SELF_ONLY");
    expect(get("allow_comment")).toBe("false"); // only true or "true"
    expect(get("allow_duet")).toBe("true");
    expect(get("allow_stitch")).toBe("true");
    expect(get("cover_ms")).toBe("30");
    expect(get("privacy_options")).toBe("SELF_ONLY,MUTUAL_FOLLOW_FRIENDS");
    expect(get("creator_nickname")).toBe("Maya");
    expect(get("file_token")).toBe(""); // missing → ""
    expect(TKR.canonical("publish_video", { cover_ms: 3000 })).toContain('["cover_ms","3000"]');
  });
  test("an array and a comma string of privacy options sign the same", () => {
    expect(TKR.canonical("post_photos", { privacy_options: ["SELF_ONLY", "FOLLOWER_OF_CREATOR"] })).toBe(
      TKR.canonical("post_photos", { privacy_options: "self_only, follower_of_creator" }),
    );
  });
  test("a boolean and its string form sign the same (the bridge sends strings)", () => {
    expect(TKR.canonical("upload_video", { copy_caption: true })).toBe(TKR.canonical("upload_video", { copy_caption: "true" }));
    expect(TKR.canonical("upload_video", { copy_caption: false })).toBe(TKR.canonical("upload_video", {}));
  });
  test("mint → verify, and every refusal reason", () => {
    const now = 1_790_000_000_000;
    const nonce = "0123456789abcdef0123456789abcdef";
    const args = { file_token: "ft1.a", caption: "hi", copy_caption: "false" };
    const t = TKR.mint("upload_video", args, now, nonce);
    expect(t).toMatch(/^r1\.[0-9a-z]+\.[0-9a-f]{32}\.[0-9a-f]{64}$/);
    expect(TKR.verify("upload_video", args, t, now + 1000, 600_000)).toMatchObject({ ok: true, nonce, issuedAt: now });
    expect(TKR.verify("upload_video", args, undefined, now, 600_000)).toEqual({ ok: false, reason: "missing" });
    expect(TKR.verify("upload_video", args, "  ", now, 600_000)).toEqual({ ok: false, reason: "missing" });
    expect(TKR.verify("upload_video", args, "r2.x.y.z", now, 600_000)).toEqual({ ok: false, reason: "malformed" });
    expect(TKR.verify("upload_video", args, t, now - 121_000, 600_000)).toEqual({ ok: false, reason: "future" });
    expect(TKR.verify("upload_video", args, t, now + 600_001, 600_000)).toEqual({ ok: false, reason: "expired" });
    expect(TKR.verify("upload_video", { ...args, caption: "hi!" }, t, now, 600_000)).toEqual({ ok: false, reason: "mismatch" });
    expect(TKR.verify("publish_video", args, t, now, 600_000)).toEqual({ ok: false, reason: "mismatch" });
    expect(TKR.verify("no_such_tool", args, t, now, 600_000)).toEqual({ ok: false, reason: "mismatch" });
  });
});

// The children are Bun itself (process.execPath), so these run on macOS, Linux and Windows alike.
const script = (js: string) => [process.execPath, "-e", js];

describe("child processes", () => {
  test("captures stdout/stderr and the exit code", async () => {
    const r = await run(script('process.stdout.write("out\\n"); process.stderr.write("err\\n"); process.exit(3)'));
    expect(r).toMatchObject({ code: 3, stdout: "out\n", stderr: "err\n", timedOut: false });
  });
  test("feeds stdin", async () => {
    const r = await run(script("process.stdout.write(await Bun.stdin.text())"), { stdin: "day 3 🚀" });
    expect(r.stdout).toBe("day 3 🚀");
  });
  test("children get a UTF-8 locale: VoiceOS starts integrations with no LANG or LC_*, and pbcopy then garbles 'Café 🎉'", async () => {
    const keys = ["LANG", "LC_ALL", "LC_CTYPE"] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    const show = script('process.stdout.write(["LANG", "LC_CTYPE", "LC_ALL"].map((k) => process.env[k] ?? "unset").join("|"))');
    try {
      delete process.env.LANG;
      delete process.env.LC_CTYPE;
      process.env.LC_ALL = "C";
      expect((await run(show)).stdout).toBe("en_US.UTF-8|en_US.UTF-8|unset");
      // A UTF-8 locale the user already has is kept.
      process.env.LANG = "fr_FR.UTF-8";
      delete process.env.LC_ALL;
      expect((await run(show)).stdout).toBe("fr_FR.UTF-8|fr_FR.UTF-8|unset");
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
  test("kills a hung child at its deadline (users' Macs have no `timeout`)", async () => {
    const started = Date.now();
    const r = await run(script("setTimeout(() => {}, 5000)"), { timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.code).toBe(124);
    expect(Date.now() - started).toBeLessThan(2000);
  });
  test("a missing binary is a result, not a crash", async () => {
    const r = await run(["/definitely/not/here"]);
    expect(r.code).not.toBe(0);
  });
  test("realClock.sleep honours abort", async () => {
    const ac = new AbortController();
    const p = realClock.sleep(10_000, ac.signal);
    ac.abort(new Error("stop"));
    await expect(p).rejects.toThrow("stop");
  });
});
