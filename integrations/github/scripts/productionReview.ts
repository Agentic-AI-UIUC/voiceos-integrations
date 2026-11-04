/** Release evidence is maintained by reviewers, never a user preference. */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** All executable source and dependency/build inputs; excludes the evidence itself and generated outputs. */
export function productionFingerprint(root: string): string {
  const files = ["package.json", "bun.lock", "widgetKit.ts", "run.sh", "run.cmd"];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`Release inputs must be regular files: ${path}`);
    }
  };
  walk("src");
  walk("scripts");
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    const bytes = readFileSync(join(root, file));
    hash.update(`${file}\0${bytes.length}\0`).update(bytes);
  }
  return hash.digest("hex");
}

export function validateProductionReview(record: unknown, fingerprint: string, now = Date.now()): boolean {
  if (!record || typeof record !== "object") return false;
  const r = record as Record<string, any>;
  if (r.schemaVersion !== 1 || r.status !== "approved" || !/^[a-f0-9]{64}$/.test(fingerprint) || r.artifactSha256 !== fingerprint) return false;
  if (!Array.isArray(r.approvals)) return false;
  const approvals = ["max", "soc2"].map((role) => r.approvals.find((a: any) => {
    if (!a || a.role !== role || typeof a.reviewer !== "string" || !a.reviewer.trim()) return false;
    if (typeof a.approvedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(a.approvedAt)) return false;
    const time = Date.parse(a.approvedAt);
    const normalized = a.approvedAt.includes(".") ? a.approvedAt : a.approvedAt.replace("Z", ".000Z");
    if (!Number.isFinite(time) || time > now || new Date(time).toISOString() !== normalized) return false;
    try {
      const url = new URL(a.evidenceUrl);
      return url.protocol === "https:" && !!url.hostname && !url.username && !url.password;
    } catch { return false; }
  }));
  return approvals.every(Boolean) && approvals[0].reviewer.trim().toLowerCase() !== approvals[1].reviewer.trim().toLowerCase();
}

export function inspectProductionReview(root = ROOT) {
  const fingerprint = productionFingerprint(root);
  let record: unknown;
  try { record = JSON.parse(readFileSync(join(root, "production-review.json"), "utf8")); } catch { /* Missing or malformed evidence fails closed. */ }
  return { fingerprint, approved: validateProductionReview(record, fingerprint) };
}

if (import.meta.main) {
  const review = inspectProductionReview();
  console.log(`Production artifact SHA-256: ${review.fingerprint}`);
  if (!review.approved) {
    console.error("SOC 2 review required: production is blocked until Max and the SOC 2 team sign off on this fingerprint in production-review.json. See PRODUCTION-REVIEW.md.");
    process.exitCode = 1;
  } else console.log("SOC 2 production review evidence matches this build.");
}
