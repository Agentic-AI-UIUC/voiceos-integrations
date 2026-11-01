import { describe, expect, test } from "bun:test";
import "./no-connect.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cardTheme,
  describeShape,
  findDownloadUrl,
  itemKind,
  itemPathOf,
  listOf,
  looksLikeItemId,
  normPath,
  safeLocalName,
  spokenName,
  summarizeItem,
  themePin,
  unwrap,
  uploadableText,
  writeUnique,
} from "../server.ts";

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
    expect(s).toMatchObject({ id: "1", name: "x.txt", kind: "other", size: 3 });
    expect(s.path).toBeUndefined();
  });
});

describe("unwrap / listOf", () => {
  test("unwraps nested and stringified Composio payloads", () => {
    expect(unwrap({ data: JSON.stringify({ response_data: { value: [1] } }) })).toEqual({ value: [1] });
    expect(unwrap({ id: "x", name: "y" })).toEqual({ id: "x", name: "y" });
  });
  test("keeps siblings when `data` is only a status message", () => {
    const res = { data: "File downloaded successfully", file: { s3url: "https://store/x" } };
    expect(unwrap(res)).toEqual(res);
  });
  test("finds the item array", () => {
    expect(listOf({ value: [1, 2] })).toEqual([1, 2]);
    expect(listOf({ items: [3] })).toEqual([3]);
    expect(listOf([4])).toEqual([4]);
    expect(listOf({})).toEqual([]);
  });
});

describe("findDownloadUrl", () => {
  test("finds the signed URL wherever Composio puts it", () => {
    expect(findDownloadUrl({ file: { s3url: "https://store/x" } })).toBe("https://store/x");
    expect(findDownloadUrl({ file_url: "https://store/y" })).toBe("https://store/y");
    expect(findDownloadUrl({ downloaded_file_content: { name: "a", s3url: "https://store/z" } })).toBe("https://store/z");
    expect(findDownloadUrl({ "@microsoft.graph.downloadUrl": "https://graph/y" })).toBe("https://graph/y");
    expect(findDownloadUrl(JSON.stringify({ file: { s3url: "https://store/json" } }))).toBe("https://store/json");
  });
  test("ignores web page links and non-https values", () => {
    expect(findDownloadUrl({ webUrl: "https://onedrive.live.com/page", file: { s3url: "https://store/x" } })).toBe("https://store/x");
    expect(findDownloadUrl({ webUrl: "https://onedrive.live.com/page" })).toBeUndefined();
    expect(findDownloadUrl({ file: { s3url: "http://insecure" } })).toBeUndefined();
    expect(findDownloadUrl({})).toBeUndefined();
  });
});

describe("describeShape", () => {
  test("lists field names and types without leaking values", () => {
    const shape = describeShape({ data: "secret text", file: { name: "a.pdf", size: 3 }, items: [{ id: "x" }] });
    expect(shape).toBe("{data: string, file: {name: string, size: number}, items: [{id: string}]}");
    expect(shape).not.toContain("secret");
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

describe("itemKind", () => {
  test("classifies folders, packages, files and special items", () => {
    expect(itemKind({ folder: { childCount: 2 } })).toBe("folder");
    expect(itemKind({ package: { type: "oneNote" } })).toBe("folder");
    expect(itemKind({ file: { mimeType: "application/pdf" } })).toBe("file");
    // Personal Vault comes back with neither facet and size 0.
    expect(itemKind({ name: "Personal Vault", size: 0 })).toBe("other");
    expect(summarizeItem({ name: "Personal Vault", size: 0 })).toMatchObject({ kind: "other" });
  });
});

describe("uploadableText", () => {
  test("never sends a 0-byte body to OneDrive's upload session", () => {
    expect(uploadableText("")).toEqual({ content: "\n", padded: true });
    expect(uploadableText("hello")).toEqual({ content: "hello", padded: false });
    expect(uploadableText(" ")).toEqual({ content: " ", padded: false });
  });
});

describe("card theme", () => {
  test("reads the CARD_THEME preference, defaulting to auto", () => {
    expect(cardTheme("dark")).toBe("dark");
    expect(cardTheme(" Light ")).toBe("light");
    expect(cardTheme("auto")).toBe("auto");
    expect(cardTheme(undefined)).toBe("auto");
    expect(cardTheme("purple")).toBe("auto");
  });
  test("auto leaves the theme to VoiceOS", () => {
    expect(themePin("auto")).toEqual({ css: "", js: "" });
  });
  test("a chosen theme paints its own surface and survives VoiceOS's init", () => {
    expect(themePin("light").css).toBe("html{background:#fff}");
    expect(themePin("dark").css).toBe("html{background:#000}");
    expect(themePin("light").js).toContain("MutationObserver");
    expect(themePin("light").js).toContain("t='light'");
  });
});

describe("spokenName", () => {
  test.each([
    ["Getting started with OneDrive.pdf", "getting started with onedrive"],
    ["Getting started with OneDrive PDF", "getting started with onedrive"],
    ["q3_budget-final.xlsx", "q3 budget final"],
    ["the roadmap deck", "the roadmap"],
    ["notes", "notes"],
  ])("%p → %p", (input, expected) => {
    expect(spokenName(input)).toBe(expected);
  });
});
