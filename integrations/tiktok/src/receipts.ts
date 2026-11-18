/**
 * Confirmation receipts: proof that a TikTok write was approved by clicking
 * its card (plan §7.1 "Receipt spec", §6.15 "Storage"; Studio brief "The
 * receipt").
 *
 * VoiceOS gives the server no signal that a card was shown. A user can switch
 * "Asks first" off, and on VoiceOS 0.1.40 a spoken "yes" approves a card
 * without its staged values. So each write's confirmation widget mints a
 * receipt over the exact signed arguments on screen and stages it as
 * `confirmation_receipt`, and the server refuses any write without a valid,
 * fresh (≤ 10 min, ≤ 2 min ahead) and unused one, before any upload, relay or
 * Composio call.
 *
 * The canonical form and SHA-256 live in src/receiptCoreScript.ts, whose exact
 * text the cards also run, so what the card signs and what the server checks
 * can't drift. The receipt holds no secret (keys can't live in the manifest):
 * it stops the agent, which never sees the card's script, from approving its
 * own write.
 *
 * Spent receipts are kept on disk for their 10-minute life, so a restart can't
 * make one usable twice. Only digests are stored: a digest is a hash of what
 * was approved, never the token, arguments or paths.
 */
import { statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { TikTokError } from "./errors.ts";
import { log } from "./proc.ts";
import TKR from "./receiptCoreScript.ts";
import { ensureDir, errCode, readJson, writeJsonAtomic } from "./state.ts";
import type { Clock, WriteTool } from "./types.ts";

export const RECEIPT_TTL_MS = 600_000;

/** Why a receipt was refused: the five TKR.verify reasons, plus "reused". */
export type ReceiptRefusal = "missing" | "malformed" | "future" | "expired" | "mismatch" | "reused";

export type ReceiptCheck =
  | { ok: true; nonce: string; issuedAt: number; digest: string }
  | { ok: false; reason: Exclude<ReceiptRefusal, "reused"> };

/** How TKR normalizes a signed field before it's signed. */
export type FieldKind = "text" | "caption" | "upper" | "bool" | "int" | "options";

/** The receipt core's API (src/receiptCoreScript.ts is plain ES5 without types). */
export interface ReceiptCore {
  utf8(text: string): number[];
  sha256(bytes: ArrayLike<number>): number[];
  hex(bytes: ArrayLike<number>): string;
  normText(value: unknown): string;
  normCaption(value: unknown): string;
  normUpper(value: unknown): string;
  normBool(value: unknown): "true" | "false";
  normInt(value: unknown): string;
  normOptions(value: unknown): string;
  /** Signed fields per write, in signing order. */
  readonly SPECS: Readonly<Record<WriteTool, ReadonlyArray<readonly [field: string, kind: FieldKind]>>>;
  /** Throws for a tool that has no canonical form. */
  canonical(tool: string, args: Record<string, unknown>): string;
  mint(tool: string, args: Record<string, unknown>, nowMs: number, nonceHex: string): string;
  verify(tool: string, args: Record<string, unknown>, token: unknown, nowMs: number, ttlMs: number): ReceiptCheck;
}

export const receiptCore = TKR as unknown as ReceiptCore;

/** 32 random hex characters, as the card draws them with crypto.getRandomValues. */
export function randomNonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Mint a receipt the way a confirmation card does (tests and verify.ts; the server only verifies). */
export function mintReceipt(tool: WriteTool, args: Record<string, unknown>, nowMs: number, nonceHex: string = randomNonce()): string {
  return receiptCore.mint(tool, args, nowMs, nonceHex);
}

const WRITE_TOOLS: ReadonlySet<string> = new Set<WriteTool>(["upload_video", "publish_video", "upload_photos", "post_photos"]);
const DIGEST = /^[0-9a-f]{64}$/;

/** One spent receipt, exactly as stored. */
export interface SpentEntry {
  digest: string;
  tool: WriteTool;
  /** issuedAt + RECEIPT_TTL_MS: after this, TKR.verify refuses the receipt as expired anyway. */
  exp: number;
}

interface SpentFile {
  version: 1;
  spent: SpentEntry[];
}

function refusal(tool: string, reason: ReceiptRefusal): TikTokError {
  log(`receipt ${tool}: refused (${reason})`);
  return new TikTokError("CONFIRMATION_REQUIRED", { reason, nothing_sent: true });
}

/** Identifies one version of the file: every atomic write is a new inode. "" when there's no file. */
function fileVersion(file: string): string {
  try {
    const st = statSync(file);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return "";
  }
}

function parseSpent(raw: unknown): { entries: SpentEntry[]; bad: number } {
  const list = raw !== null && typeof raw === "object" ? (raw as Partial<SpentFile>).spent : undefined;
  if (!Array.isArray(list)) return { entries: [], bad: 1 };
  const entries: SpentEntry[] = [];
  let bad = 0;
  for (const item of list as unknown[]) {
    const e = item as Partial<SpentEntry> | null;
    if (
      e !== null && typeof e === "object" &&
      typeof e.digest === "string" && DIGEST.test(e.digest) &&
      typeof e.tool === "string" && WRITE_TOOLS.has(e.tool) &&
      typeof e.exp === "number" && Number.isFinite(e.exp)
    ) {
      entries.push({ digest: e.digest, tool: e.tool, exp: e.exp });
    } else {
      bad++;
    }
  }
  return { entries, bad };
}

/**
 * The digests of receipts already used, persisted at `file` (mode 0600, in a
 * 0700 folder). Each check merges in what's on disk whenever the file changed,
 * so two servers sharing the folder (VoiceOS and a Studio test run) see each
 * other's spends, and a spend never drops the other's entries. Not locked: two
 * spends landing in the same instant in two processes could still drop one
 * entry from the file (each process keeps its own in memory).
 */
export class SpentReceipts {
  private entries = new Map<string, SpentEntry>();
  /** Version of the file last merged into `entries`. */
  private seen = "";

  constructor(
    private readonly file: string,
    private readonly clock: Clock,
  ) {
    this.refresh();
  }

  /** True when `digest` was spent and its receipt hasn't expired. */
  has(digest: string): boolean {
    this.refresh();
    const e = this.entries.get(digest);
    return e !== undefined && e.exp >= this.clock.now();
  }

  /**
   * Record `digest` as spent, persisted before returning; expired entries are
   * pruned on the way. Throws CONFIRMATION_REQUIRED ("reused") if it's already
   * spent, and UNKNOWN if it can't be written, in which case nothing is marked
   * and the caller must send nothing.
   */
  spend(digest: string, tool: WriteTool, issuedAt: number): void {
    if (!DIGEST.test(digest) || !WRITE_TOOLS.has(tool) || !Number.isFinite(issuedAt)) {
      throw new TypeError("spend() takes a receipt digest, a write tool and the receipt's issue time");
    }
    this.refresh();
    const now = this.clock.now();
    const prior = this.entries.get(digest);
    if (prior && prior.exp >= now) throw refusal(tool, "reused");
    const next = new Map<string, SpentEntry>();
    for (const [key, e] of this.entries) if (e.exp >= now) next.set(key, e);
    next.set(digest, { digest, tool, exp: issuedAt + RECEIPT_TTL_MS });
    try {
      ensureDir(dirname(this.file));
      writeJsonAtomic(this.file, { version: 1, spent: [...next.values()] } satisfies SpentFile);
    } catch (error) {
      log(`receipts: couldn't record a spent receipt (${errCode(error)}); nothing sent`);
      throw new TikTokError("UNKNOWN", { message: "Couldn't record the approval, so nothing was sent.", nothing_sent: true });
    }
    // Only now is it marked: a failed write leaves the approval unspent, as nothing was sent.
    this.entries = next;
  }

  /** Merge the file into memory if it changed. Missing or unreadable: keep what this process knows. */
  private refresh(): void {
    // Stat before reading: if the file changes in between, the newer content is
    // merged and the next check sees a new version and merges again (harmless).
    const version = fileVersion(this.file);
    if (version === this.seen) return;
    this.seen = version;
    if (!version) return;
    const raw = readJson<unknown>(this.file, undefined);
    if (raw === undefined) return;
    const { entries, bad } = parseSpent(raw);
    if (bad) log(`receipts: ignored ${bad} unreadable entr${bad === 1 ? "y" : "ies"} in ${basename(this.file)}`);
    const now = this.clock.now();
    for (const e of entries) {
      if (e.exp < now) continue;
      const mine = this.entries.get(e.digest);
      if (!mine || mine.exp < e.exp) this.entries.set(e.digest, e);
    }
  }
}

/**
 * Accept the write's `confirmation_receipt` (in `args`) exactly once: verify it
 * against the signed arguments (TKR.verify: format, ≤ 2 min ahead, ≤ 10 min
 * old, digest), refuse it if already spent, then spend it, persisted, before
 * returning its digest. Call it first, before any token check, upload, relay or
 * Composio call. Refusals: TikTokError("CONFIRMATION_REQUIRED", { reason,
 * nothing_sent: true }); a failed persist: TikTokError("UNKNOWN").
 */
export function acceptReceipt(tool: WriteTool, args: Record<string, unknown>, spent: SpentReceipts, now: number): string {
  const a = args ?? {};
  const check = receiptCore.verify(tool, a, a.confirmation_receipt, now, RECEIPT_TTL_MS);
  if (!check.ok) throw refusal(tool, check.reason);
  if (spent.has(check.digest)) throw refusal(tool, "reused");
  spent.spend(check.digest, tool, check.issuedAt);
  return check.digest;
}
