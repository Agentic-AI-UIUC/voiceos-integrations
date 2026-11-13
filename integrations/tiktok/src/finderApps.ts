/**
 * Videos the user points at instead of describing: what's selected in Finder, and what's open in QuickTime
 * Player; and showing a video in Finder (`open -R`). AppleScript runs through the injected Runner (tests fake
 * it) as `osascript -e <fixed script>`: nothing from the user is ever spliced into a script.
 *
 * The first call asks macOS for permission ("VoiceOS wants to control Finder"); a denial is error -1743
 * (AUTOMATION_DENIED here, with plain words). QuickTime is only asked if it's already running, so it's never
 * launched. Pointed-at files may be outside Downloads/Desktop/Movies (the user chose them), so each is
 * checked: a regular, readable, non-empty .mp4/.mov, not a symlink, not inside an app or library package.
 * Logs carry counts and codes, never paths.
 */
import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, sep } from "node:path";
import { log } from "./proc.ts";
import type { Runner } from "./types.ts";

const OSASCRIPT = "/usr/bin/osascript";
const OPEN = "/usr/bin/open";
/** Long enough for the user to answer macOS's first "allow VoiceOS to control Finder?" prompt. */
const APPLESCRIPT_TIMEOUT_MS = 12_000;
const MAX_POINTED = 20;

const FINDER_SELECTION = `tell application "Finder"
  set out to ""
  set n to 0
  repeat with x in (get selection)
    set n to n + 1
    if n > ${MAX_POINTED} then exit repeat
    try
      set out to out & POSIX path of (x as alias) & linefeed
    end try
  end repeat
  return out
end tell`;

const QUICKTIME_DOCUMENTS = `if application "QuickTime Player" is running then
  tell application "QuickTime Player"
    set out to ""
    set n to 0
    repeat with d in documents
      set n to n + 1
      if n > ${MAX_POINTED} then exit repeat
      try
        set f to file of d
        if f is not missing value then set out to out & POSIX path of f & linefeed
      end try
    end repeat
    return out
  end tell
else
  return "NOT_RUNNING"
end if`;

export type PointedFailure = "automation_denied" | "not_running" | "timed_out" | "unavailable";

export interface Pointed {
  /** Absolute paths, front-most / first-selected first. */
  paths: string[];
  failure?: PointedFailure;
  /** Selected or open items that aren't usable videos (folders, photos, .mkv…). */
  skipped: number;
}

/** -1743: "Not authorized to send Apple events"; -1744: consent would be required (prompting disabled). */
const DENIED = /-1743|-1744|not authori[sz]ed to send apple events|not allowed to send keystrokes/i;

async function runScript(script: string, runner: Runner): Promise<{ out: string } | { failure: PointedFailure }> {
  let r;
  try {
    r = await runner([OSASCRIPT, "-e", script], { timeoutMs: APPLESCRIPT_TIMEOUT_MS });
  } catch (e) {
    log(`pointed: osascript failed to start (${(e as Error).name})`);
    return { failure: "unavailable" };
  }
  if (r.timedOut) return { failure: "timed_out" };
  if (r.code !== 0) {
    if (DENIED.test(r.stderr)) return { failure: "automation_denied" };
    if (/-600\b|isn.t running/i.test(r.stderr)) return { failure: "not_running" };
    log(`pointed: osascript exit ${r.code}`);
    return { failure: "unavailable" };
  }
  return { out: r.stdout };
}

const VIDEO_EXT = /\.(mp4|mov)$/i;
const PACKAGE_DIR = /\.(app|photoslibrary|imovielibrary|fcpbundle|theater|tvlibrary|bundle|framework|pkg|screenflow|screenstudio|lrlibrary|band|logicx)$/i;

/** A file the user pointed at is usable when it's a regular, readable, non-empty .mp4/.mov outside any package. */
export function usableVideo(path: string): boolean {
  if (!isAbsolute(path) || !VIDEO_EXT.test(path) || /[\u0000-\u001f\u007f]/.test(path)) return false;
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size <= 0) return false;
    accessSync(path, constants.R_OK);
    const real = realpathSync(path);
    if (real.split(sep).some((part) => PACKAGE_DIR.test(part))) return false;
    if (basename(real).startsWith(".")) return false;
    return true;
  } catch {
    return false;
  }
}

function pointed(out: string): Pointed {
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const paths: string[] = [];
  let skipped = 0;
  for (const l of lines) {
    if (l.endsWith("/")) {
      skipped++; // a folder
      continue;
    }
    if (usableVideo(l) && !paths.includes(l)) paths.push(l);
    else skipped++;
  }
  return { paths, skipped };
}

/** What's selected in Finder (the front window's or the Desktop's selection). */
export async function finderSelection(runner: Runner): Promise<Pointed> {
  const r = await runScript(FINDER_SELECTION, runner);
  if ("failure" in r) return { paths: [], failure: r.failure, skipped: 0 };
  return pointed(r.out);
}

/** The saved files open in QuickTime Player, front-most first. Never launches QuickTime. */
export async function quicktimeDocuments(runner: Runner): Promise<Pointed> {
  const r = await runScript(QUICKTIME_DOCUMENTS, runner);
  if ("failure" in r) return { paths: [], failure: r.failure, skipped: 0 };
  if (r.out.trim() === "NOT_RUNNING") return { paths: [], failure: "not_running", skipped: 0 };
  return pointed(r.out);
}

/** Shows the file selected in a Finder window (`open -R`). True when it worked. */
export async function revealInFinder(path: string, runner: Runner): Promise<boolean> {
  try {
    const r = await runner([OPEN, "-R", path], { timeoutMs: 5_000 });
    if (r.code !== 0 || r.timedOut) log(`reveal: open -R exit ${r.code}${r.timedOut ? " (timed out)" : ""}`);
    return r.code === 0 && !r.timedOut;
  } catch {
    return false;
  }
}

/** The display folder of a pointed-at file outside home: its parent folder's name. */
export const parentName = (path: string): string => basename(dirname(path)) || "/";
