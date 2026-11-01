import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { RECEIPT_CORE_JS } from "../src/confirmations.ts";
import { receiptCore } from "../src/receiptCore.ts";

const enc = (s: string) => Array.from(new TextEncoder().encode(s));

describe("sha256 (pure JS, shared with the widget)", () => {
  test("FIPS 180-2 vectors", () => {
    expect(receiptCore.hex(receiptCore.sha256(enc("")))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(receiptCore.hex(receiptCore.sha256(enc("abc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(
      receiptCore.hex(
        receiptCore.sha256(enc("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
      ),
    ).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  test("UTF-8 encoding matches node:crypto for non-ASCII input", () => {
    const text = "Café — 日本語 🎉\nline2";
    const ours = receiptCore.hex(receiptCore.sha256(receiptCore.utf8(text)));
    const theirs = createHash("sha256").update(text, "utf8").digest("hex");
    expect(ours).toBe(theirs);
  });
});

describe("canonical form", () => {
  test("create_issue normalizes ids, text and lists", () => {
    expect(
      receiptCore.canonical("create_issue", {
        owner: " Acme ",
        repo: "Desktop",
        title: "Sign-in freezes\r\n",
        body: "line 1\r\nline 2",
        labels: "bug, urgent,BUG, ",
      }),
    ).toBe(
      '["create_issue",["owner","acme"],["repo","desktop"],["title","Sign-in freezes"],["body","line 1\\nline 2"],["labels","bug\\nurgent"],["assignees",""]]',
    );
  });

  test("numbers and numeric strings canonicalize identically", () => {
    const a = receiptCore.canonical("create_issue_comment", {
      owner: "acme", repo: "desktop", issue_number: 55, body: "hi",
    });
    const b = receiptCore.canonical("create_issue_comment", {
      owner: "acme", repo: "desktop", issue_number: "55", body: "hi",
    });
    expect(a).toBe(b);
    expect(a).toContain('["issue_number","55"]');
  });

  test("update_issue distinguishes an omitted field from an empty one", () => {
    const base = { owner: "a", repo: "b", issue_number: 1, expected_updated_at: "t" };
    const omitted = receiptCore.canonical("update_issue", { ...base });
    const cleared = receiptCore.canonical("update_issue", { ...base, body: "" });
    const labelsCleared = receiptCore.canonical("update_issue", { ...base, labels: [] });
    expect(omitted).toContain('["body",null]');
    expect(cleared).toContain('["body",""]');
    expect(omitted).toContain('["labels",null]');
    expect(labelsCleared).toContain('["labels",""]');
  });

  test("review canonical uppercases event and lowercases commit", () => {
    expect(
      receiptCore.canonical("create_pull_request_review", {
        owner: "acme", repo: "desktop", pull_number: 55,
        commit_id: "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
        event: "request_changes", body: "Please add a test.",
      }),
    ).toBe(
      '["create_pull_request_review",["owner","acme"],["repo","desktop"],["pull_number","55"],["pr_title",""],["commit_id","abcdef0123456789abcdef0123456789abcdef01"],["event","REQUEST_CHANGES"],["body","Please add a test."]]',
    );
  });

  test("a body keeps its first line's indentation (Markdown code); only blank lead lines and trailing space go", () => {
    expect(receiptCore.normBody("\n  \r\n    const x = 1;\r\n\r\nDone.  \n")).toBe("    const x = 1;\n\nDone.");
    expect(receiptCore.normBody("   ")).toBe("");
    expect(receiptCore.normBody(undefined)).toBe("");
    const base = { owner: "acme", repo: "desktop", issue_number: 3 };
    const indented = receiptCore.canonical("create_issue_comment", { ...base, body: "    code" });
    expect(indented).toContain('["body","    code"]');
    expect(indented).not.toBe(receiptCore.canonical("create_issue_comment", { ...base, body: "code" }));
    expect(receiptCore.canonical("update_issue", { ...base, expected_updated_at: "t", body: "  x" })).toContain('["body","  x"]');
    expect(receiptCore.canonical("create_issue", { owner: "a", repo: "b", title: "  T  ", body: "  x" })).toContain('["title","T"],["body","  x"]');
  });

  test("list text splits on commas and every kind of line break, as the card shows it", () => {
    expect(receiptCore.normList("bug\rurgent")).toEqual(["bug", "urgent"]);
    expect(receiptCore.normList("bug\r\nurgent, ui")).toEqual(["bug", "urgent", "ui"]);
  });

  test("unknown tool has no canonical form", () => {
    expect(() => receiptCore.canonical("search_code", { q: "x" })).toThrow();
  });
});

describe("receipts", () => {
  const args = { owner: "acme", repo: "desktop", issue_number: 123, body: "I can reproduce this." };
  const now = 1_800_000_000_000;

  test("a minted receipt verifies against the same args", () => {
    const token = receiptCore.mint("create_issue_comment", args, now, "00112233445566778899aabbccddeeff");
    const result = receiptCore.verify("create_issue_comment", args, token, now + 1000, 15 * 60_000);
    expect(result).toEqual({ ok: true, nonce: "00112233445566778899aabbccddeeff", issuedAt: now });
  });

  test("edited text after minting fails verification", () => {
    const token = receiptCore.mint("create_issue_comment", args, now, "00112233445566778899aabbccddeeff");
    const tampered = { ...args, body: "Something else" };
    expect(receiptCore.verify("create_issue_comment", tampered, token, now, 900_000).reason).toBe("mismatch");
  });

  test("a receipt for one tool cannot authorize another", () => {
    const token = receiptCore.mint("create_issue_comment", args, now, "00112233445566778899aabbccddeeff");
    expect(receiptCore.verify("update_issue", args, token, now, 900_000).ok).toBe(false);
  });

  test("expired, future-dated, malformed and missing receipts are rejected", () => {
    const token = receiptCore.mint("create_issue_comment", args, now, "00112233445566778899aabbccddeeff");
    expect(receiptCore.verify("create_issue_comment", args, token, now + 900_001, 900_000).reason).toBe("expired");
    expect(receiptCore.verify("create_issue_comment", args, token, now - 10 * 60_000, 900_000).reason).toBe("expired");
    expect(receiptCore.verify("create_issue_comment", args, "r1.zz.00.11", now, 900_000).reason).toBe("malformed");
    expect(receiptCore.verify("create_issue_comment", args, "", now, 900_000).reason).toBe("missing");
    expect(receiptCore.verify("create_issue_comment", args, undefined, now, 900_000).reason).toBe("missing");
  });

  test("an old keyed receipt (r1) is refused", () => {
    expect(receiptCore.verify("create_issue_comment", args, "r1.zz.00112233445566778899aabbccddeeff." + "a".repeat(64), now, 900_000).reason).toBe("malformed");
  });
});

describe("the widget runs the identical source", () => {
  test("RECEIPT_CORE_JS evaluated as a classic script mints the same token", () => {
    const sandbox: Record<string, unknown> = {};
    new Function("window", `${RECEIPT_CORE_JS}\n;window.GHR = GHR;`)(sandbox);
    const widgetCore = sandbox.GHR as typeof receiptCore;
    const a = { owner: "acme", repo: "desktop", title: "Crash ✨", labels: ["bug"], assignees: "octocat" };
    const fromWidget = widgetCore.mint("create_issue", a, 1_800_000_000_000, "ffeeddccbbaa99887766554433221100");
    expect(receiptCore.verify("create_issue", a, fromWidget, 1_800_000_000_500, 900_000).ok).toBe(true);
  });
});
