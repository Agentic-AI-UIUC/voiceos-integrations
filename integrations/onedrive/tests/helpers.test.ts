import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findDownloadUrl,
  itemPathOf,
  listOf,
  looksLikeItemId,
  normPath,
  safeLocalName,
  summarizeItem,
  unwrap,
  writeUnique,
} from "../onedrive.ts";

describe("normPath", () => {
  test.each([
    ["", ""],
    ["/", ""],
    ["root", ""],
    ["Root", ""],
    ["My files", ""],
    ["/Documents/", "Documents"],
    ["My files/Docs/A", "Docs/A"],
    ["/drive/root:/Documents", "Documents"],
  ])("%p → %p", (input, expected) => {
    expect(normPath(input)).toBe(expected);
  });
});

describe("looksLikeItemId", () => {
  test("recognises personal and business IDs", () => {
    expect(looksLikeItemId("D4648F06C91D9D3D!54927")).toBe(true);
    expect(looksLikeItemId("01NKDM7HMOJTVYMDOSXFDK2QJDXCDI3WUK")).toBe(true);
  });
  test("treats names and paths as not IDs", () => {
    expect(looksLikeItemId("Report.docx")).toBe(false);
    expect(looksLikeItemId("Documents/Report.docx")).toBe(false);
  });
});

describe("itemPathOf / summarizeItem", () => {
  test("decodes the Graph parent path", () => {
    expect(itemPathOf({ name: "a.pdf", parentReference: { path: "/drive/root:/My%20Docs" } })).toBe("My Docs/a.pdf");
    expect(itemPathOf({ name: "a.pdf", parentReference: { path: "/drives/abc/root:" } })).toBe("a.pdf");
  });
  test("leaves path undefined when Graph gave no parent path", () => {
    const s = summarizeItem({ id: "1", name: "x.txt", size: 3, folder: undefined });
    expect(s).toMatchObject({ id: "1", name: "x.txt", is_folder: false, size: 3 });
    expect(s.path).toBeUndefined();
  });
});

describe("unwrap / listOf", () => {
  test("unwraps nested and stringified Composio payloads", () => {
    expect(unwrap({ data: JSON.stringify({ response_data: { value: [1] } }) })).toEqual({ value: [1] });
    expect(unwrap({ id: "x", name: "y" })).toEqual({ id: "x", name: "y" });
  });
  test("finds the item array", () => {
    expect(listOf({ value: [1, 2] })).toEqual([1, 2]);
    expect(listOf({ items: [3] })).toEqual([3]);
    expect(listOf([4])).toEqual([4]);
    expect(listOf({})).toEqual([]);
  });
});

describe("findDownloadUrl", () => {
  test("prefers Composio's staged file URL", () => {
    expect(findDownloadUrl({ file: { s3url: "https://store/x" } })).toBe("https://store/x");
    expect(findDownloadUrl({ "@microsoft.graph.downloadUrl": "https://graph/y" })).toBe("https://graph/y");
  });
  test("ignores non-https values", () => {
    expect(findDownloadUrl({ file: { s3url: "http://insecure" } })).toBeUndefined();
    expect(findDownloadUrl({})).toBeUndefined();
  });
});

describe("safeLocalName", () => {
  test("can never escape the target directory", () => {
    for (const evil of ["../../.zshrc", "/etc/passwd", "..\\..\\x", "a/b/c.txt"]) {
      const name = safeLocalName(evil, "fallback.txt");
      expect(name).not.toContain("/");
      expect(name).not.toContain("\\");
      expect(name.startsWith(".")).toBe(false);
    }
  });
  test("keeps the OneDrive extension when the requested name has none", () => {
    expect(safeLocalName("report", "Q3.pdf")).toBe("report.pdf");
    expect(safeLocalName(undefined, "Q3.pdf")).toBe("Q3.pdf");
  });
});

describe("writeUnique", () => {
  test("never overwrites an existing file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onedrive-test-"));
    const a = await writeUnique(dir, "r.txt", Buffer.from("first"));
    const b = await writeUnique(dir, "r.txt", Buffer.from("second"));
    expect(path.basename(a)).toBe("r.txt");
    expect(path.basename(b)).toBe("r (1).txt");
    expect(fs.readFileSync(a, "utf8")).toBe("first");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
