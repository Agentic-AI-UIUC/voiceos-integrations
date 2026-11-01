import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coalescer, KeyedMutex, OperationLedger, SlidingWindowLimiter, StateStore } from "../src/state.ts";

const dirs: string[] = [];
const freshDir = () => {
  const d = mkdtempSync(join(tmpdir(), "gh-state-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("StateStore", () => {
  test("updates persist to disk and survive a restart", () => {
    const dir = freshDir();
    const a = new StateStore(dir);
    a.update((s) => {
      s.identities.internal = { userId: "voiceos-github-internal-abc", createdAt: "2026-10-24T00:00:00Z" };
    });
    const b = new StateStore(dir);
    expect(b.snapshot().identities.internal?.userId).toBe("voiceos-github-internal-abc");
  });

  test("the state file is private to the user and no temp files are left behind", () => {
    const dir = freshDir();
    new StateStore(dir).update((s) => {
      s.identities.internal = { userId: "u", createdAt: "t" };
    });
    expect(statSync(join(dir, "state.json")).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  test("a corrupt state file is set aside and the store starts clean", () => {
    const dir = freshDir();
    writeFileSync(join(dir, "state.json"), "{not json");
    const store = new StateStore(dir);
    expect(store.snapshot().identities).toEqual({});
    expect(readdirSync(dir).some((f) => f.startsWith("state.json.corrupt-"))).toBe(true);
  });
});

describe("StateStore shared by two servers (VoiceOS and a Studio test run can both have the folder open)", () => {
  test("each sees and keeps the other's records", () => {
    const dir = freshDir();
    const a = new OperationLedger(new StateStore(dir));
    const b = new OperationLedger(new StateStore(dir));
    const until = Date.now() + 60_000;
    expect(a.consumeReceipt("n1", until)).toBe(true);
    expect(b.consumeReceipt("n1", until)).toBe(false);
    a.begin({ id: "op_a", tool: "create_issue", target: "acme/desktop", argsDigest: "x", generation: 1 });
    b.begin({ id: "op_b", tool: "create_issue", target: "acme/desktop", argsDigest: "y", generation: 1 });
    expect(a.get("op_b")?.status).toBe("dispatching");
    const onDisk = new StateStore(dir).snapshot();
    expect(Object.keys(onDisk.operations).sort()).toEqual(["op_a", "op_b"]);
    expect(Object.keys(onDisk.usedReceipts)).toEqual(["n1"]);
  });

  test("writers in separate processes, all at once, lose nothing", async () => {
    const dir = freshDir();
    const scripts = freshDir();
    const writer = join(scripts, "writer.ts");
    writeFileSync(
      writer,
      `import { OperationLedger, StateStore } from ${JSON.stringify(join(import.meta.dir, "../src/state.ts"))};
const ledger = new OperationLedger(new StateStore(process.argv[2]));
for (let i = 0; i < 40; i++) if (!ledger.consumeReceipt(process.argv[3] + i, Date.now() + 60_000)) process.exit(2);
`,
    );
    const procs = ["p", "q", "r", "s"].map((tag) => Bun.spawn([process.execPath, writer, dir, tag], { stdout: "ignore", stderr: "inherit" }));
    expect(await Promise.all(procs.map((p) => p.exited))).toEqual([0, 0, 0, 0]);
    expect(Object.keys(new StateStore(dir).snapshot().usedReceipts)).toHaveLength(160);
    expect(readdirSync(dir).sort()).toEqual(["state.json"]);
  });
});

describe("StateStore lock", () => {
  test("a folder that turned read-only can still be read, so the server still starts", () => {
    const dir = freshDir();
    new StateStore(dir).update((s) => {
      s.identities.internal = { userId: "u", createdAt: "t" };
    });
    chmodSync(dir, 0o500);
    try {
      const store = new StateStore(dir);
      expect(store.snapshot().identities.internal?.userId).toBe("u");
      expect(() => store.update(() => {})).toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test("a lock held by a live process is never broken, even after a stall", () => {
    const dir = freshDir();
    const store = new StateStore(dir);
    const lock = join(dir, "state.lock");
    writeFileSync(lock, String(process.ppid));
    const past = new Date(Date.now() - 5_000);
    utimesSync(lock, past, past);
    const started = Date.now();
    expect(() => store.update(() => {})).toThrow("another process is holding the GitHub state file");
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_900);
    expect(existsSync(lock)).toBe(true);
  });

  test("a lock left by a process that died is taken over at once", () => {
    const dir = freshDir();
    const store = new StateStore(dir);
    const deadPid = Bun.spawnSync(["/bin/sh", "-c", "echo $$"]).stdout.toString().trim();
    writeFileSync(join(dir, "state.lock"), deadPid);
    const started = Date.now();
    store.update((s) => {
      s.usedReceipts.n = 1;
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(existsSync(join(dir, "state.lock"))).toBe(false);
    expect(new StateStore(dir).snapshot().usedReceipts.n).toBe(1);
  });
});

describe("OperationLedger", () => {
  const now = () => Date.parse("2026-10-24T20:00:00Z");

  test("an operation id dispatches once; a repeat sees the recorded operation", () => {
    const ledger = new OperationLedger(new StateStore(freshDir()), now);
    const first = ledger.begin({ id: "op_1", tool: "create_issue", target: "acme/desktop", argsDigest: "d1", generation: 1 });
    expect(first.started).toBe(true);
    ledger.settle("op_1", { status: "succeeded", resource: { number: 123, url: "https://github.com/acme/desktop/issues/123" } });
    const again = ledger.begin({ id: "op_1", tool: "create_issue", target: "acme/desktop", argsDigest: "d1", generation: 1 });
    expect(again.started).toBe(false);
    expect(again.record.status).toBe("succeeded");
    expect(again.record.resource).toEqual({ number: 123, url: "https://github.com/acme/desktop/issues/123" });
  });

  test("an operation left 'dispatching' by a crash reads back as dispatching (unknown to callers)", () => {
    const dir = freshDir();
    new OperationLedger(new StateStore(dir), now).begin({ id: "op_2", tool: "create_issue", target: "a/b", argsDigest: "d", generation: 1 });
    const reopened = new OperationLedger(new StateStore(dir), now);
    const again = reopened.begin({ id: "op_2", tool: "create_issue", target: "a/b", argsDigest: "d", generation: 1 });
    expect(again.started).toBe(false);
    expect(again.record.status).toBe("dispatching");
  });

  test("recent unknown outcomes for the same target and text are found for duplicate warnings", () => {
    const ledger = new OperationLedger(new StateStore(freshDir()), now);
    ledger.begin({ id: "op_3", tool: "create_issue_comment", target: "acme/desktop#123", argsDigest: "same", generation: 1 });
    ledger.settle("op_3", { status: "unknown" });
    expect(ledger.recentUnknown("create_issue_comment", "acme/desktop#123", "same")?.id).toBe("op_3");
    expect(ledger.recentUnknown("create_issue_comment", "acme/desktop#123", "different")).toBeUndefined();
  });

  test("records older than the retention window are pruned", () => {
    let t = Date.parse("2026-10-01T00:00:00Z");
    const ledger = new OperationLedger(new StateStore(freshDir()), () => t);
    ledger.begin({ id: "old", tool: "create_issue", target: "a/b", argsDigest: "d", generation: 1 });
    ledger.settle("old", { status: "succeeded" });
    t = Date.parse("2026-10-24T00:00:00Z");
    ledger.begin({ id: "new", tool: "create_issue", target: "a/b", argsDigest: "d2", generation: 1 });
    expect(ledger.get("old")).toBeUndefined();
    expect(ledger.get("new")?.status).toBe("dispatching");
  });

  test("spending a receipt and recording its dispatch happen together, once", () => {
    const ledger = new OperationLedger(new StateStore(freshDir()));
    const init = { id: "op_n1", tool: "create_issue", target: "acme/desktop", argsDigest: "d", generation: 1 };
    const until = Date.now() + 60_000;
    expect(ledger.claim("n1", until, init).started).toBe(true);
    expect(ledger.claim("n1", until, init).started).toBe(false);
    ledger.notSent({ id: "op_n2", tool: "create_issue", target: "acme/desktop" }, "Not sent.", "cancelled");
    const second = ledger.claim("n2", until, { ...init, id: "op_n2" });
    expect(second.started).toBe(false);
    expect(second.record?.status).toBe("failed");
    expect(ledger.consumeReceipt("n2", until)).toBe(false);
  });

  test("a receipt nonce can be consumed once within its lifetime", () => {
    const ledger = new OperationLedger(new StateStore(freshDir()), now);
    expect(ledger.consumeReceipt("abc", now() + 60_000)).toBe(true);
    expect(ledger.consumeReceipt("abc", now() + 60_000)).toBe(false);
  });
});

describe("KeyedMutex", () => {
  test("work on the same key never overlaps; different keys run concurrently", async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];
    const job = (key: string, name: string, ms: number) =>
      mutex.run(key, async () => {
        log.push(`${name}:start`);
        await Bun.sleep(ms);
        log.push(`${name}:end`);
      });
    await Promise.all([job("acme/desktop", "a", 30), job("acme/desktop", "b", 5), job("other/repo", "c", 5)]);
    expect(log.indexOf("a:end")).toBeLessThan(log.indexOf("b:start"));
    expect(log.indexOf("c:start")).toBeLessThan(log.indexOf("a:end"));
  });

  test("a failing job releases the lock", async () => {
    const mutex = new KeyedMutex();
    await expect(mutex.run("k", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await mutex.run("k", async () => "next")).toBe("next");
  });
});

describe("SlidingWindowLimiter", () => {
  test("allows 10 per minute per key, then reports when the next slot opens", () => {
    let t = 1_000_000;
    const limiter = new SlidingWindowLimiter(10, 60_000, () => t);
    for (let i = 0; i < 10; i++) {
      expect(limiter.take("acct").ok).toBe(true);
      t += 1_000;
    }
    const blocked = limiter.take("acct");
    expect(blocked).toEqual({ ok: false, retryAfterMs: 50_000 });
    expect(limiter.take("other-acct").ok).toBe(true);
    t += 50_000;
    expect(limiter.take("acct").ok).toBe(true);
  });
});

describe("Coalescer", () => {
  test("identical concurrent reads share one upstream call", async () => {
    const co = new Coalescer();
    let calls = 0;
    const fetchOnce = () => co.run("search:q", async () => { calls++; await Bun.sleep(10); return calls; });
    const [a, b] = await Promise.all([fetchOnce(), fetchOnce()]);
    expect([a, b, calls]).toEqual([1, 1, 1]);
    expect(await fetchOnce()).toBe(2);
  });

  test("a failure reaches every waiter and is not cached", async () => {
    const co = new Coalescer();
    let calls = 0;
    const failing = () => co.run("k", async () => { calls++; throw new Error("nope"); });
    const results = await Promise.allSettled([failing(), failing()]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    await failing().catch(() => {});
    expect(calls).toBe(2);
  });
});
