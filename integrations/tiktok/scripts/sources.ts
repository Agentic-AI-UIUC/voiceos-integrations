/**
 * What server.ts is built from, as one digest, and the Bun that builds it (QA, PR 47: the committed bundle had been
 * built with another Bun than the one the PR names, and nothing checked that it was rebuilt at all).
 *
 * scripts/build.ts writes both into server.ts's header; tests/manifest.test.ts checks them, so a bundle that wasn't
 * rebuilt after a source change, or was built with another Bun, fails `bun test` in any CI. Line endings are
 * normalized, so a Windows checkout gives the same digest. Not shipped.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** The Bun that builds server.ts: the one VoiceOS bundles (and the native CI pins), so the bundle rebuilds byte for byte. */
export const BUILD_BUN_VERSION = "1.3.14";
/** Where VoiceOS keeps that Bun on a Mac. */
export const VOICEOS_BUN = "/Applications/VoiceOS.app/Contents/Resources/bun-runtime/bun";

/** Everything the bundle is made from: src/ (with widgetKit.ts, which src/cards.ts inlines), the cards, the build and the pinned dependencies. */
const INPUTS = ["src", "confirm-card", "widgetKit.ts", "scripts/build.ts", "scripts/sources.ts", "package.json", "bun.lock"];
const SOURCE_FILE = /\.(ts|js|css|json|lock)$/;

function filesUnder(root: string, rel: string): string[] {
  if (!statSync(join(root, rel)).isDirectory()) return [rel];
  return readdirSync(join(root, rel))
    .filter((name) => !name.startsWith("."))
    .flatMap((name) => filesUnder(root, `${rel}/${name}`))
    .filter((path) => SOURCE_FILE.test(path));
}

/** SHA-256 over every input file's path and text (CRLF read as LF), in path order. */
export function sourceDigest(root: string): string {
  const hash = createHash("sha256");
  for (const rel of INPUTS.flatMap((p) => filesUnder(root, p)).sort()) {
    hash.update(`${rel}\n`);
    hash.update(readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n"));
    hash.update("\n\0");
  }
  return hash.digest("hex");
}

/** The stamp line in server.ts's header. */
export const stampLine = (bunVersion: string, digest: string) => `// built with Bun ${bunVersion} from sources sha256:${digest}`;
export const STAMP = /^\/\/ built with Bun (\S+) from sources sha256:([0-9a-f]{64})$/m;
