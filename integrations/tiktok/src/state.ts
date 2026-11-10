/**
 * Small state files on disk (plan §6.15 "Storage"): folders private to the
 * user, JSON read forgivingly, and writes that land whole or not at all.
 *
 * The state folder is VoiceOS's per-integration one (config.defaultStateDir),
 * outside this integration's own folder, so a Studio reinstall can't wipe it.
 * Nothing secret is stored here: no keys, tokens or paths. The one exception
 * to "no user text" is ledger.json (src/ledger.ts): the sends' file and folder
 * names and the caption or title the user approved, clipped to 150 characters,
 * so "what did I post today?" survives a restart.
 *
 * Logs name the file's basename and an errno code only: Node's error messages
 * embed the full path, and JSON parse errors can quote the file's content.
 */
import { chmodSync, closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { log } from "./proc.ts";

/** The errno code of a failed fs call ("ENOENT", "EACCES", …); never its message, which holds the path. */
export const errCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : (error as Error | null)?.name || "error";
};

/**
 * mkdir -p, then make sure the folder grants nothing beyond `mode`. It only
 * ever removes permission bits: a folder someone made read-only stays
 * read-only, so writes into it still fail (and callers fail closed).
 */
export function ensureDir(dir: string, mode = 0o700): void {
  mkdirSync(dir, { recursive: true, mode });
  const st = statSync(dir);
  if (!st.isDirectory()) throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
  const current = st.mode & 0o777;
  if (current & ~mode) {
    try {
      chmodSync(dir, current & mode);
    } catch (error) {
      // Not ours to change. The files inside are still written 0600.
      log(`state: couldn't tighten ${basename(dir)} (${errCode(error)})`);
    }
  }
}

/** A cheap "has this file changed?" key (inode, size, mtime); "" when it's missing or unreadable. */
export function fileVersion(file: string): string {
  try {
    const st = statSync(file);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return "";
  }
}

/** The parsed JSON in `file`, or `fallback` when it's missing, unreadable or not valid JSON. */
export function readJson<T>(file: string, fallback: T): T {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    const code = errCode(error);
    if (code !== "ENOENT") log(`state: couldn't read ${basename(file)} (${code}); starting empty`);
    return fallback;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    log(`state: ${basename(file)} isn't valid JSON; starting empty`);
    return fallback;
  }
}

/**
 * Write `value` as JSON to a new temp file in the same folder (created
 * exclusively, mode `mode`, flushed to disk), then rename it over `file`.
 * Readers see the old file or the new one, never half of either. Throws on
 * any failure, leaving the old file as it was and no temp file behind.
 *
 * Missing parent folders are created 0700. An existing folder is left as it
 * is (this helper may be pointed anywhere); call ensureDir on folders you own.
 */
export function writeJsonAtomic(file: string, value: unknown, mode = 0o600): void {
  const text = JSON.stringify(value, null, 2);
  if (typeof text !== "string") throw new TypeError("writeJsonAtomic: value isn't JSON-serializable");
  const bytes = Buffer.from(`${text}\n`, "utf8");
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${basename(file)}.${process.pid}.${randomHex(6)}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", mode);
    fchmodSync(fd, mode);
    for (let off = 0; off < bytes.length; ) off += writeSync(fd, bytes, off, bytes.length - off);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, file);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* never created, or already renamed */
    }
    throw error;
  }
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}
