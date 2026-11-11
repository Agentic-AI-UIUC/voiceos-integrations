import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TikTokError } from "../src/errors.ts";
import { BUNDLE_TTL_MS, FILE_TTL_MS, IMAGE_TTL_MS, POST_TTL_MS, TokenStore, restat } from "../src/tokens.ts";
import type { BundleRef, Clock, FileRef, ImageRef, PostRef } from "../src/types.ts";

const T0 = Date.UTC(2026, 10, 3, 18, 0, 0);
const MIN = 60_000;
/** Root ignores permission bits, so the permission case only means something for a normal user. */
const isRoot = process.getuid?.() === 0 || process.platform === "win32";

type FakeClock = Clock & { advance(ms: number): void };
function fakeClock(start = T0): FakeClock {
  let t = start;
  return { now: () => t, sleep: async () => {}, advance: (ms) => void (t += ms) };
}

const fileRef: FileRef = {
  path: "/Users/alice/Downloads/Trip Videos/final_export.mp4",
  name: "final_export.mp4",
  folder: "Downloads/Trip Videos",
  size: 12_400_000,
  mtimeMs: T0 - 3_600_000 + 0.456,
  mime: "video/mp4",
  duration_sec: 23.4,
  width: 1080,
  height: 1920,
};
const imageRef: ImageRef = {
  path: "/Users/alice/Desktop/Screenshot 2026-11-03 at 9.07 PM.png",
  name: "Screenshot 2026-11-03 at 9.07 PM.png",
  folder: "Desktop",
  size: 812_000,
  mtimeMs: T0 - 60_000,
  ext: "png",
  is_screenshot: true,
};
const bundleRef: BundleRef = {
  images: [
    { path: "/Users/alice/Pictures/Beach Trip/IMG_4821.HEIC", name: "IMG_4821.HEIC", size: 2_310_000, mtimeMs: T0 - 86_400_000, width: 4032, height: 3024, format: "heic", has_alpha: false, credentials: "none" },
    { path: imageRef.path, name: imageRef.name, size: imageRef.size, mtimeMs: imageRef.mtimeMs, width: 2880, height: 1800, format: "png", has_alpha: true, credentials: "present" },
  ],
  cover_index: 1,
};
const postRef: PostRef = {
  connected_account_id: "ca_7Qm2xYzP4kLw",
  creator_nickname: "Maya Runs",
  creator_username: "maya.runs.daily",
  privacy_options: ["SELF_ONLY"],
  comment_disabled: false,
  duet_disabled: true,
  stitch_disabled: true,
  max_duration_sec: 600,
  media_token: "ft1.mhkd4y2o.9f1c2a7b3d4e5f60718293a4.TmV2ZXItYS1yZWFsLW1hYy10b2tlbi1qdXN0LXRlc3Q",
  media_kind: "video",
  fetched_at: T0,
};

type Kind = "file" | "image" | "bundle" | "post";
const KINDS: Kind[] = ["file", "image", "bundle", "post"];
const PREFIX: Record<Kind, string> = { file: "ft1", image: "it1", bundle: "bt1", post: "pt1" };
const TTL: Record<Kind, number> = { file: FILE_TTL_MS, image: IMAGE_TTL_MS, bundle: BUNDLE_TTL_MS, post: POST_TTL_MS };
const REF: Record<Kind, unknown> = { file: fileRef, image: imageRef, bundle: bundleRef, post: postRef };

const mint = (s: TokenStore, kind: Kind): string =>
  kind === "file" ? s.mintFile(fileRef) : kind === "image" ? s.mintImage(imageRef) : kind === "bundle" ? s.mintBundle(bundleRef) : s.mintPost(postRef);
const resolve = (s: TokenStore, kind: Kind, token: unknown): unknown =>
  kind === "file" ? s.file(token) : kind === "image" ? s.image(token) : kind === "bundle" ? s.bundle(token) : s.post(token);

function failure(fn: () => unknown): TikTokError {
  try {
    fn();
  } catch (error) {
    if (error instanceof TikTokError) return error;
    throw error;
  }
  throw new Error("expected a TikTokError, but the call went through");
}
function expectStale(fn: () => unknown, kind: Kind) {
  const e = failure(fn);
  expect(e.code).toBe("TOKEN_STALE");
  expect(e.detail).toEqual({ kind });
}

describe("TokenStore", () => {
  test("round-trips all four kinds", () => {
    const s = new TokenStore(fakeClock());
    expect(s.file(s.mintFile(fileRef))).toEqual(fileRef);
    expect(s.image(s.mintImage(imageRef))).toEqual(imageRef);
    expect(s.bundle(s.mintBundle(bundleRef))).toEqual(bundleRef);
    expect(s.post(s.mintPost(postRef))).toEqual(postRef);
  });

  test("tokens are <kind>t1.<exp base36>.<24-hex nonce>.<base64url MAC>, expiring after each kind's TTL", () => {
    expect([FILE_TTL_MS, IMAGE_TTL_MS, BUNDLE_TTL_MS, POST_TTL_MS]).toEqual([15 * MIN, 30 * MIN, 30 * MIN, 10 * MIN]);
    const s = new TokenStore(fakeClock());
    for (const kind of KINDS) {
      const exp36 = (T0 + TTL[kind]).toString(36);
      expect(mint(s, kind)).toMatch(new RegExp(`^${PREFIX[kind]}\\.${exp36}\\.[0-9a-f]{24}\\.[A-Za-z0-9_-]{43}$`));
    }
  });

  test("the token string carries no part of the path, name, folder or account", () => {
    const s = new TokenStore(fakeClock());
    const secrets = [
      fileRef.path, fileRef.name, "final_export", fileRef.folder, imageRef.path, imageRef.name, bundleRef.images[0]!.path,
      postRef.connected_account_id, postRef.creator_nickname, postRef.creator_username!, postRef.media_token,
    ];
    const fragments = new Set<string>();
    for (const text of secrets) {
      fragments.add(text);
      for (const piece of text.split(/[\/ .]/)) if (piece.length >= 5) fragments.add(piece);
    }
    for (const kind of KINDS) {
      const token = mint(s, kind);
      for (const fragment of fragments) expect(token.includes(fragment) ? `${kind} token contains ${fragment}` : "").toBe("");
    }
  });

  test("each mint is a new token, and both resolve", () => {
    const s = new TokenStore(fakeClock());
    const a = s.mintFile(fileRef);
    const b = s.mintFile(fileRef);
    expect(a).not.toBe(b);
    expect(s.file(a)).toEqual(fileRef);
    expect(s.file(b)).toEqual(fileRef);
  });

  test("hands out copies: no caller can change what a token resolves to", () => {
    const s = new TokenStore(fakeClock());
    const input = structuredClone(bundleRef);
    const token = s.mintBundle(input);
    input.images[0]!.path = "/etc/passwd";
    input.cover_index = 0;
    const out = s.bundle(token);
    expect(out).toEqual(bundleRef);
    out.images.reverse();
    out.images[0]!.size = 1;
    expect(s.bundle(token)).toEqual(bundleRef);
  });

  test("expires on the injected clock: valid at its TTL, stale 1 ms later", () => {
    for (const kind of KINDS) {
      const clock = fakeClock();
      const s = new TokenStore(clock);
      const token = mint(s, kind);
      clock.advance(TTL[kind]);
      expect(resolve(s, kind, token)).toEqual(REF[kind]);
      clock.advance(1);
      expectStale(() => resolve(s, kind, token), kind);
    }
  });

  test("a post_token (10 min) goes stale while its file_token (15 min) is still good", () => {
    const clock = fakeClock();
    const s = new TokenStore(clock);
    const file = s.mintFile(fileRef);
    const post = s.mintPost({ ...postRef, media_token: file });
    clock.advance(11 * MIN);
    expectStale(() => s.post(post), "post");
    expect(s.file(file)).toEqual(fileRef);
  });

  test("a token of one kind is refused by every other accessor", () => {
    const s = new TokenStore(fakeClock());
    for (const minted of KINDS) {
      const token = mint(s, minted);
      for (const asked of KINDS) if (asked !== minted) expectStale(() => resolve(s, asked, token), asked);
    }
  });

  test("a tampered MAC, expiry, nonce or kind is refused", () => {
    const s = new TokenStore(fakeClock());
    const token = s.mintFile(fileRef);
    const [prefix, exp36, nonce, mac] = token.split(".") as [string, string, string, string];
    const flip = (c: string) => (c === "A" ? "B" : "A");
    const tampered = [
      `${prefix}.${exp36}.${nonce}.${mac.slice(0, -1)}${flip(mac.at(-1)!)}`,
      `${prefix}.${exp36}.${nonce}.${flip(mac[0]!)}${mac.slice(1)}`,
      `${prefix}.${(parseInt(exp36, 36) + 60 * MIN).toString(36)}.${nonce}.${mac}`,
      `${prefix}.${exp36}.${nonce.slice(0, -1)}${nonce.at(-1) === "0" ? "1" : "0"}.${mac}`,
    ];
    for (const t of tampered) expectStale(() => s.file(t), "file");
    // A 43-char base64url MAC ignores its last character's low 2 bits when decoded, so the next character
    // decodes to the very same bytes: the MAC must be compared as text, not as decoded bytes.
    const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const twin = `${mac.slice(0, -1)}${B64URL[B64URL.indexOf(mac.at(-1)!) + 1]}`;
    expect(Buffer.from(twin, "base64url").equals(Buffer.from(mac, "base64url"))).toBe(true);
    expectStale(() => s.file(`${prefix}.${exp36}.${nonce}.${twin}`), "file");
    // Relabelling a file token as an image token doesn't make it one.
    expectStale(() => s.image(`it1.${exp36}.${nonce}.${mac}`), "image");
    expect(s.file(token)).toEqual(fileRef);
  });

  test("junk is refused as stale", () => {
    const s = new TokenStore(fakeClock());
    const token = s.mintFile(fileRef);
    for (const junk of [undefined, null, 42, {}, [], [token], "", " ", "ft1", "ft1...", `${token}x`, `${token}.x`, token.toUpperCase(), fileRef.path]) {
      expectStale(() => s.file(junk), "file");
    }
  });

  test("tolerates whitespace around a pasted token", () => {
    const s = new TokenStore(fakeClock());
    expect(s.image(` ${s.mintImage(imageRef)}\n`)).toEqual(imageRef);
  });

  test("tokens don't survive a restart (another store refuses them, even with the same key)", () => {
    const clock = fakeClock();
    const key = new Uint8Array(32).fill(7);
    const before = new TokenStore(clock, { key });
    const after = new TokenStore(clock, { key });
    for (const kind of KINDS) expectStale(() => resolve(after, kind, mint(before, kind)), kind);
  });

  test("the registry is bounded and keeps the newest", () => {
    const s = new TokenStore(fakeClock(), { max: 3 });
    const refs = [1, 2, 3, 4, 5].map((n) => ({ ...fileRef, name: `clip${n}.mp4`, path: `/Users/alice/Movies/clip${n}.mp4` }));
    const tokens = refs.map((r) => s.mintFile(r));
    expectStale(() => s.file(tokens[0]), "file");
    expectStale(() => s.file(tokens[1]), "file");
    expect([2, 3, 4].map((i) => s.file(tokens[i]).name)).toEqual(["clip3.mp4", "clip4.mp4", "clip5.mp4"]);
  });

  test("eviction drops expired tokens before live ones", () => {
    const clock = fakeClock();
    const s = new TokenStore(clock, { max: 3 });
    const oldest = s.mintImage(imageRef); // 30 min
    const post = s.mintPost(postRef); // 10 min
    const image = s.mintImage(imageRef); // 30 min
    clock.advance(11 * MIN); // only the post token has expired
    const newest = s.mintImage(imageRef);
    expectStale(() => s.post(post), "post");
    for (const t of [oldest, image, newest]) expect(s.image(t)).toEqual(imageRef);
    // Nothing expired now: the oldest goes.
    const next = s.mintImage(imageRef);
    expectStale(() => s.image(oldest), "image");
    for (const t of [image, newest, next]) expect(s.image(t)).toEqual(imageRef);
  });

  test("holds 2000 tokens by default", () => {
    const s = new TokenStore(fakeClock());
    const tokens = Array.from({ length: 2001 }, () => s.mintPost(postRef));
    expectStale(() => s.post(tokens[0]), "post");
    expect(s.post(tokens[1])).toEqual(postRef);
    expect(s.post(tokens[2000])).toEqual(postRef);
  });

  test("a key shorter than 16 bytes is refused", () => {
    expect(() => new TokenStore(fakeClock(), { key: new Uint8Array(8) })).toThrow();
  });
});

describe("restat", () => {
  const roots: string[] = [];
  afterEach(() => {
    while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
  });
  /** A real file in a fresh "Downloads", and the ref find_recent_videos would have bound. */
  function realFile() {
    const root = mkdtempSync(join(tmpdir(), "tiktok-restat-"));
    roots.push(root);
    const dir = join(root, "Downloads");
    mkdirSync(dir);
    const path = join(dir, "final_export.mp4");
    writeFileSync(path, "x".repeat(1000));
    const st = statSync(path);
    return { dir, path, ref: { path, name: "final_export.mp4", folder: "Downloads", size: st.size, mtimeMs: st.mtimeMs } };
  }

  test("passes when size and mtime still match", () => {
    const { ref } = realFile();
    expect(() => restat(ref)).not.toThrow();
  });

  test("tolerates sub-millisecond mtime rounding", () => {
    const { ref } = realFile();
    expect(() => restat({ ...ref, mtimeMs: Math.floor(ref.mtimeMs) })).not.toThrow();
    expect(() => restat({ ...ref, mtimeMs: Math.round(ref.mtimeMs) })).not.toThrow();
  });

  test("a changed size → TOKEN_STALE", () => {
    const { path, ref } = realFile();
    appendFileSync(path, "more bytes");
    utimesSync(path, new Date(), new Date(ref.mtimeMs)); // same mtime (to the ms): only the size differs
    const e = failure(() => restat(ref));
    expect(e.code).toBe("TOKEN_STALE");
    expect(e.detail).toEqual({ reason: "file_changed", name: "final_export.mp4" });
  });

  test("a changed mtime → TOKEN_STALE", () => {
    const { path, ref } = realFile();
    utimesSync(path, new Date(), new Date(ref.mtimeMs + 60_000));
    expect(statSync(path).size).toBe(ref.size);
    expect(failure(() => restat(ref)).code).toBe("TOKEN_STALE");
    expect(failure(() => restat({ ...ref, mtimeMs: Number.NaN })).code).toBe("TOKEN_STALE");
  });

  test("a deleted file → FILE_NOT_FOUND", () => {
    const { path, ref } = realFile();
    unlinkSync(path);
    const e = failure(() => restat(ref));
    expect(e.code).toBe("FILE_NOT_FOUND");
    expect(e.detail).toEqual({ name: "final_export.mp4" });
  });

  test("a folder where the file was → FILE_NOT_FOUND", () => {
    const { path, ref } = realFile();
    unlinkSync(path);
    mkdirSync(path);
    expect(failure(() => restat(ref)).code).toBe("FILE_NOT_FOUND");
  });

  test.skipIf(isRoot)("a folder VoiceOS can no longer read → FOLDER_PERMISSION_DENIED", () => {
    const { dir, ref } = realFile();
    chmodSync(dir, 0o000);
    try {
      const e = failure(() => restat(ref));
      expect(e.code).toBe("FOLDER_PERMISSION_DENIED");
      expect(e.detail).toEqual({ name: "final_export.mp4", folders: ["Downloads"] });
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test("errors never carry the path", () => {
    const { path, ref } = realFile();
    unlinkSync(path);
    const e = failure(() => restat(ref));
    expect(JSON.stringify({ detail: e.detail, json: e.toJSON(), message: e.message })).not.toContain(ref.path);
  });
});
