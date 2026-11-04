import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectProductionReview, productionFingerprint, validateProductionReview } from "../scripts/productionReview.ts";
import { assertProductionReviewed, productionAccessAllowed } from "../src/productionReview.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const fingerprint = "a".repeat(64);
const now = Date.parse("2026-01-02T00:00:00Z");
const record = () => ({
  schemaVersion: 1, status: "approved", artifactSha256: fingerprint,
  approvals: [
    { role: "max", reviewer: "Max", approvedAt: "2026-01-01T00:00:00Z", evidenceUrl: "https://example.com/review/max" },
    { role: "soc2", reviewer: "Security reviewer", approvedAt: "2026-01-01T00:00:00Z", evidenceUrl: "https://example.com/review/soc2" },
  ],
});

describe("production review evidence", () => {
  test("requires both dated, attributable sign-offs for the exact build", () => {
    expect(validateProductionReview(record(), fingerprint, now)).toBe(true);
    for (const r of [undefined, null, {}, [], { ...record(), status: "pending" }, { ...record(), schemaVersion: 2 },
      { ...record(), approvals: record().approvals.slice(0, 1) }, { ...record(), approvals: record().approvals.slice(1) },
      { ...record(), artifactSha256: "b".repeat(64) }]) {
      expect(validateProductionReview(r, fingerprint, now)).toBe(false);
    }
  });

  test("rejects invalid identities, dates, roles and evidence links", () => {
    for (const patch of [
      { reviewer: " " }, { reviewer: "Max" }, { approvedAt: "tomorrow" }, { approvedAt: "2026-01-03T00:00:00Z" }, { approvedAt: "2025-02-30T00:00:00Z" },
      { evidenceUrl: "" }, { evidenceUrl: "http://example.com/review" }, { evidenceUrl: "https://user:pass@example.com/review" }, { role: "developer" },
    ]) {
      const r = record();
      Object.assign(r.approvals[1], patch);
      expect(validateProductionReview(r, fingerprint, now)).toBe(false);
    }
  });

  test("a source or dependency change invalidates approval; missing/malformed evidence blocks", () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-review-")); dirs.push(dir);
    for (const sub of ["src", "scripts"]) mkdirSync(join(dir, sub));
    const inputs = ["src/main.ts", "scripts/build.ts", "package.json", "bun.lock", "widgetKit.ts", "run.sh", "run.cmd"];
    for (const file of inputs) writeFileSync(join(dir, file), file);
    const hash = productionFingerprint(dir);
    const path = join(dir, "production-review.json");
    expect(inspectProductionReview(dir).approved).toBe(false);
    writeFileSync(path, "{broken");
    expect(inspectProductionReview(dir).approved).toBe(false);
    writeFileSync(path, JSON.stringify({ ...record(), artifactSha256: hash }));
    expect(inspectProductionReview(dir).approved).toBe(true);
    for (const file of inputs) {
      writeFileSync(join(dir, file), "changed");
      expect(inspectProductionReview(dir).approved).toBe(false);
      writeFileSync(join(dir, file), file);
    }
    writeFileSync(join(dir, "src/new.ts"), "new source");
    expect(inspectProductionReview(dir).approved).toBe(false);
  });

  test("the checked-in record uses the reviewed evidence format", () => {
    const root = join(import.meta.dir, "..");
    const r = JSON.parse(readFileSync(join(root, "production-review.json"), "utf8"));
    expect(r.schemaVersion).toBe(1);
    expect(["pending", "approved"]).toContain(r.status);
    if (r.status === "pending") expect(inspectProductionReview(root).approved).toBe(false);
    else expect(inspectProductionReview(root).approved).toBe(true);
  });
});

describe("production execution", () => {
  test("unreviewed source blocks production; only the loopback fake remains available", () => {
    for (const url of ["https://backend.composio.dev", "https://example.com", "http://127.0.0.1.example.com", "https://localhost@example.com", "bad-url"]) {
      expect(productionAccessAllowed(url)).toBe(false);
      expect(() => assertProductionReviewed(url)).toThrow("Production GitHub access is blocked");
    }
    expect(productionAccessAllowed("http://127.0.0.1:12345")).toBe(true);
  });

  test("a build with validated evidence can use production", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-reviewed-build-")); dirs.push(dir);
    const output = join(dir, "reviewed.mjs");
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "../src/productionReview.ts")], target: "bun",
      define: { __GITHUB_PRODUCTION_APPROVED__: JSON.stringify(validateProductionReview(record(), fingerprint, now)) },
    });
    expect(build.success).toBe(true);
    await Bun.write(output, build.outputs[0]);
    const reviewed = await import(output);
    expect(reviewed.productionAccessAllowed("https://backend.composio.dev")).toBe(true);
    expect(() => reviewed.assertProductionReviewed("https://backend.composio.dev")).not.toThrow();
  });
});
