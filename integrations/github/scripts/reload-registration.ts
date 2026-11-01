/** Refresh only this installed integration's cached manifest. VoiceOS must be quit. */
import { execFileSync } from "node:child_process";
import { constants, closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

try {
  execFileSync("pgrep", ["-f", "^/Applications/VoiceOS.app/Contents/MacOS/VoiceOS( |$)"], { stdio: "ignore" });
  throw new Error("Quit VoiceOS before refreshing its registration, so saved settings cannot race with this update.");
} catch (error) {
  if ((error as { status?: number }).status !== 1) throw error;
}
const root = resolve(import.meta.dir, "..");
const path = join(homedir(), "Library/Application Support/VoiceOS/config.json");
const bytes = readFileSync(path);
const original = JSON.parse(bytes.toString("utf8"));
const updated = structuredClone(original);
const manifest = JSON.parse(readFileSync(join(root, "voiceos.integration.json"), "utf8"));
const matches = updated.installedIntegrations.filter((entry: any) => entry.dirPath === root);
if (matches.length !== 1 || matches[0].manifest.id !== manifest.id) throw new Error("Expected exactly one matching installed directory and integration identity.");
if (JSON.stringify(matches[0].manifest.runtime) !== JSON.stringify(manifest.runtime)) throw new Error("Runtime changed; refusing to alter the installed registration.");
const previousManifest = matches[0].manifest;
matches[0].manifest = manifest;
const comparison = structuredClone(updated);
comparison.installedIntegrations.find((entry: any) => entry.dirPath === root).manifest = previousManifest;
if (JSON.stringify(comparison) !== JSON.stringify(original)) throw new Error("Unexpected settings change.");

const backup = join(tmpdir(), `voiceos-before-github-registration-${Date.now()}.json`);
writeFileSync(backup, bytes, { mode: 0o600, flag: "wx" });
const temporary = `${path}.github-reload-${process.pid}.tmp`;
try {
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { writeFileSync(fd, JSON.stringify(updated, null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  // Check again immediately before replacing the settings file.
  if (!readFileSync(path).equals(bytes)) throw new Error("VoiceOS settings changed during refresh; registration was not replaced.");
  renameSync(temporary, path);
} finally { if (existsSync(temporary)) unlinkSync(temporary); }
console.log(`Registered ${manifest.name} ${manifest.version}; connection, preferences and confirmation settings preserved.`);
console.log(`Private settings backup: ${backup}`);
