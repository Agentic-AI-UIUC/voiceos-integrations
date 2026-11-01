/**
 * Durable local state: the GitHub connection binding, the operation ledger,
 * and spent confirmation receipts. Never secrets — no API keys, no tokens, no
 * Connect Links, no issue or comment bodies. Written atomically (temp file +
 * rename), readable only by the user, and shared safely between processes:
 * VoiceOS and an Integration Studio test run can have the folder open at once.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, fstatSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

export type Environment = "internal" | "production";

export interface Identity {
  userId: string;
  createdAt: string;
}

export interface BoundAccount {
  accountId: string;
  boundAt: string;
  status: "active" | "reauth_required";
  displayName?: string;
  scopes?: string[];
  /** True when this binding replaced a different account (approvals from before it are void). */
  replaced?: boolean;
}

export interface DisconnectRecord {
  requestedAt: string;
  /** The Composio account this record describes (absent when none was connected). */
  accountId?: string;
  completedAt?: string;
  revocation?: "revoked" | "already_revoked" | "unsupported" | "failed" | "not_attempted";
  deleted?: boolean;
  error?: string;
}

/** Connection state for one (environment, Composio project key, user) tuple. */
export interface AccountState {
  generation: number;
  authConfigId?: string;
  bound?: BoundAccount;
  /** The last account ever bound here, kept across disconnects to detect identity changes. */
  lastAccountId?: string;
  pending?: { accountId: string; createdAt: string };
  session?: { id: string; configDigest: string; createdAt: string };
  disconnect?: DisconnectRecord;
  /**
   * Accounts VoiceOS disconnected. Never adopted again; their Composio cleanup
   * (revoke, then delete) is retried until it completes.
   */
  retired?: Record<string, { revocation: NonNullable<DisconnectRecord["revocation"]>; deleted: boolean; at: string }>;
}

/** incomplete: GitHub acted, but not as approved (a review it left pending). */
export type OperationStatus = "dispatching" | "succeeded" | "succeeded_with_warning" | "failed" | "incomplete" | "unknown";

export interface OperationRecord {
  id: string;
  tool: string;
  target: string;
  argsDigest: string;
  generation: number;
  status: OperationStatus;
  startedAt: string;
  settledAt?: string;
  resource?: { number?: number; url?: string; id?: string | number; state?: string };
  summary?: string;
  errorCategory?: string;
}

export interface StateFile {
  version: 1;
  identities: Partial<Record<Environment, Identity>>;
  accounts: Record<string, AccountState>;
  operations: Record<string, OperationRecord>;
  usedReceipts: Record<string, number>;
}

const empty = (): StateFile => ({ version: 1, identities: {}, accounts: {}, operations: {}, usedReceipts: {} });

/** Block briefly without yielding (state updates are synchronous). */
function pause(ms: number) {
  const bun = (globalThis as { Bun?: { sleepSync(ms: number): void } }).Bun;
  if (bun) bun.sleepSync(ms);
  else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class StateStore {
  private readonly file: string;
  private readonly lockFile: string;
  private state: StateFile = empty();
  /** Which version of the file `state` came from: another process's write changes it. */
  private seen = "";

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = join(dir, "state.json");
    this.lockFile = join(dir, "state.lock");
    // Reads need no lock: every write lands whole (temp file + rename). So a
    // folder that turned read-only still serves reads, and the server starts.
    this.refresh();
  }

  private version(): string {
    try {
      const st = statSync(this.file);
      return `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch {
      return "";
    }
  }

  /**
   * Re-read the file if it changed since this process last read or wrote it.
   * The version recorded is the one of the bytes actually read (one open
   * file), so a write landing mid-read can't pass for already seen.
   */
  private refresh() {
    if (this.version() === this.seen) return;
    let fd: number;
    try {
      fd = openSync(this.file, "r");
    } catch {
      this.state = empty();
      this.seen = "";
      return;
    }
    let text: string;
    let version: string;
    try {
      const st = fstatSync(fd);
      version = `${st.ino}:${st.size}:${st.mtimeMs}`;
      text = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
    try {
      const parsed = JSON.parse(text);
      if (!parsed || parsed.version !== 1) throw new Error("unsupported state version");
      this.state = { ...empty(), ...parsed };
      this.seen = version;
    } catch (error) {
      this.state = empty();
      this.seen = "";
      this.setAside(version, (error as Error).message);
    }
  }

  /** A file that can't be read is moved aside — only that very file, and under the lock. */
  private setAside(version: string, why: string) {
    try {
      this.locked(() => {
        if (this.version() !== version) return;
        const aside = `${this.file}.corrupt-${Date.now()}`;
        renameSync(this.file, aside);
        console.error(`[github] state file unreadable (${why}); moved aside to ${aside}`);
      });
    } catch {
      // A read-only folder: start clean in memory; a later write replaces the file.
    }
  }

  snapshot(): StateFile {
    this.refresh();
    return structuredClone(this.state);
  }

  /**
   * Apply a synchronous mutation to the latest state on disk and persist it
   * before returning. Should another writer slip in anyway (a lock taken over
   * from a crashed process), the change is redone on their state rather than
   * written over it.
   */
  update<T>(mutate: (draft: StateFile) => T): T {
    return this.locked(() => {
      for (let attempt = 1; ; attempt++) {
        this.refresh();
        const base = this.seen;
        const draft = structuredClone(this.state);
        const result = mutate(draft);
        const tmp = `${this.file}.tmp-${process.pid}`;
        writeFileSync(tmp, JSON.stringify(draft, null, 2), { mode: 0o600 });
        chmodSync(tmp, 0o600);
        if (attempt < 5 && this.version() !== base) {
          unlinkSync(tmp);
          continue;
        }
        renameSync(tmp, this.file);
        this.state = draft;
        this.seen = this.version();
        return result;
      }
    });
  }

  /** One process at a time reads the file and writes it back. */
  private locked<T>(work: () => T): T {
    const deadline = Date.now() + 3_000;
    const mine = `${process.pid}:${randomBytes(6).toString("hex")}`;
    for (;;) {
      try {
        const fd = openSync(this.lockFile, "wx", 0o600);
        try {
          writeSync(fd, mine);
        } finally {
          closeSync(fd);
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (this.lockAbandoned()) continue;
        if (Date.now() > deadline) throw new Error("another process is holding the GitHub state file");
        pause(2);
      }
    }
    try {
      return work();
    } finally {
      // Release only our own lock, never one another process holds now.
      try {
        if (readFileSync(this.lockFile, "utf8") === mine) unlinkSync(this.lockFile);
      } catch {
        // Already gone.
      }
    }
  }

  /**
   * Takes over a lock its holder abandoned: the process died (or never wrote
   * its id), or it has been stuck far longer than any update takes. A live
   * holder's lock is never broken. The takeover is a rename, so only one
   * waiter wins, and a lock that changed hands meanwhile is put back.
   */
  private lockAbandoned(): boolean {
    let holder: string;
    let age: number;
    try {
      holder = readFileSync(this.lockFile, "utf8");
      age = Date.now() - statSync(this.lockFile).mtimeMs;
    } catch {
      return false;
    }
    const pid = Number.parseInt(holder, 10);
    let alive = false;
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (error) {
        alive = (error as NodeJS.ErrnoException).code === "EPERM";
      }
    }
    const known = Number.isInteger(pid) && pid > 0;
    if (alive ? age < 30_000 : !known && age < 2_000) return false;
    const aside = `${this.lockFile}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      renameSync(this.lockFile, aside);
    } catch {
      return false;
    }
    let taken = "";
    try {
      taken = readFileSync(aside, "utf8");
    } catch {
      // Unreadable: treat as someone else's.
    }
    if (taken !== holder) {
      try {
        linkSync(aside, this.lockFile);
      } catch {
        // A third process already holds it; theirs stands.
      }
    }
    try {
      unlinkSync(aside);
    } catch {
      // Already gone.
    }
    return taken === holder;
  }
}

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_OPERATIONS = 200;
const UNKNOWN_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * At-most-one dispatch per logical operation, as far as this gateway knows.
 * An operation is recorded as "dispatching" BEFORE the upstream call, so a
 * crash mid-dispatch reads back as an unknown outcome, never as "not sent".
 */
export class OperationLedger {
  constructor(
    private readonly store: StateStore,
    private readonly now: () => number = Date.now,
  ) {}

  begin(init: { id: string; tool: string; target: string; argsDigest: string; generation: number }):
    | { started: true; record: OperationRecord }
    | { started: false; record: OperationRecord } {
    return this.store.update((s) => {
      this.prune(s);
      const existing = s.operations[init.id];
      if (existing) return { started: false as const, record: existing };
      const record: OperationRecord = { ...init, status: "dispatching", startedAt: new Date(this.now()).toISOString() };
      s.operations[init.id] = record;
      return { started: true as const, record };
    });
  }

  settle(id: string, outcome: Pick<OperationRecord, "status"> & Partial<Pick<OperationRecord, "resource" | "summary" | "errorCategory">>) {
    this.store.update((s) => {
      const record = s.operations[id];
      if (!record) return;
      Object.assign(record, outcome, { settledAt: new Date(this.now()).toISOString() });
    });
  }

  get(id: string): OperationRecord | undefined {
    return this.store.snapshot().operations[id];
  }

  recentUnknown(tool: string, target: string, argsDigest: string): OperationRecord | undefined {
    const cutoff = this.now() - UNKNOWN_LOOKBACK_MS;
    return Object.values(this.store.snapshot().operations).find(
      (op) =>
        op.tool === tool &&
        op.target === target &&
        op.argsDigest === argsDigest &&
        (op.status === "unknown" || op.status === "dispatching") &&
        Date.parse(op.startedAt) >= cutoff,
    );
  }

  /**
   * Spend a receipt and record its operation as dispatching, in one step, so
   * two servers handed the same approval can't both send it. Not started when
   * the receipt was spent or the operation already has a record.
   */
  claim(nonce: string, expiresAt: number, init: { id: string; tool: string; target: string; argsDigest: string; generation: number }): { started: boolean; record?: OperationRecord } {
    return this.store.update((s) => {
      this.prune(s);
      const nowMs = this.now();
      for (const [key, until] of Object.entries(s.usedReceipts)) if (until < nowMs) delete s.usedReceipts[key];
      const spent = !!s.usedReceipts[nonce];
      s.usedReceipts[nonce] ??= expiresAt;
      const existing = s.operations[init.id];
      if (existing || spent) return { started: false, ...(existing ? { record: existing } : {}) };
      const record: OperationRecord = { ...init, status: "dispatching", startedAt: new Date(nowMs).toISOString() };
      s.operations[init.id] = record;
      return { started: true, record };
    });
  }

  /** A change refused before anything was sent, kept so a repeated delivery gets the same answer. */
  notSent(init: { id: string; tool: string; target: string }, summary: string, errorCategory: string, receipt?: { nonce: string; expiresAt: number }) {
    this.store.update((s) => {
      this.prune(s);
      if (receipt) s.usedReceipts[receipt.nonce] ??= receipt.expiresAt;
      if (s.operations[init.id]) return;
      const at = new Date(this.now()).toISOString();
      s.operations[init.id] = { ...init, argsDigest: "", generation: 0, status: "failed", startedAt: at, settledAt: at, summary, errorCategory };
    });
  }

  /** Spend a confirmation receipt. False when it was already used. */
  consumeReceipt(nonce: string, expiresAt: number): boolean {
    return this.store.update((s) => {
      const nowMs = this.now();
      for (const [key, until] of Object.entries(s.usedReceipts)) if (until < nowMs) delete s.usedReceipts[key];
      if (s.usedReceipts[nonce]) return false;
      s.usedReceipts[nonce] = expiresAt;
      return true;
    });
  }

  private prune(s: StateFile) {
    const cutoff = this.now() - RETENTION_MS;
    const ops = Object.values(s.operations).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    ops.forEach((op, index) => {
      if (Date.parse(op.startedAt) < cutoff || index >= MAX_OPERATIONS) delete s.operations[op.id];
    });
  }
}

/** Serializes async work per key: writes to one repository never interleave. */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => gate);
    this.tails.set(key, tail);
    await previous.catch(() => {});
    try {
      return await work();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

/** At most `limit` events per `windowMs` per key. */
export class SlidingWindowLimiter {
  private readonly events = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(key: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const t = this.now();
    const recent = (this.events.get(key) ?? []).filter((at) => t - at < this.windowMs);
    if (recent.length >= this.limit) {
      this.events.set(key, recent);
      return { ok: false, retryAfterMs: this.windowMs - (t - recent[0]) };
    }
    recent.push(t);
    this.events.set(key, recent);
    return { ok: true };
  }
}

/** Identical concurrent reads share one in-flight upstream call. */
export class Coalescer {
  private readonly inflight = new Map<string, Promise<unknown>>();

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;
    const promise = work().finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }
}
