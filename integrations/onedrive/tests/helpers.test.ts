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
  localUploadPath,
  MAX_LOCAL_UPLOAD_BYTES,
  mimeTypeOf,
  nameMatchesTerms,
  readLocalUpload,
  searchTerms,
  looksLikeItemId,
  normPath,
  safeLocalName,
  clipboardCommand,
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
    expect(looksLikeItemId("0123456789ABCDEF!54927")).toBe(true);
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
  test("replaces characters Windows doesn't allow in file names", () => {
    const name = safeLocalName('Q3: plan <draft> "v2" | what? *final*', "x.docx");
    expect(name).not.toMatch(/[<>:"\/\\|?*]/);
    expect(name).toBe("Q3_ plan _draft_ _v2_ _ what_ _final_.docx");
  });
  test("drops trailing dots and spaces, which Windows strips silently", () => {
    expect(safeLocalName("notes. . ", "a.txt")).toBe("notes.txt");
  });
  test("avoids Windows device names", () => {
    for (const reserved of ["CON", "nul.txt", "com1", "LPT9.pdf", "aux"]) {
      expect(safeLocalName(reserved, "a.txt").startsWith("_")).toBe(true);
    }
    expect(safeLocalName("console", "a.txt")).toBe("console.txt");
  });
  test("caps very long names and keeps the extension", () => {
    const name = safeLocalName("a".repeat(400), "b.pdf");
    expect(name.length).toBeLessThanOrEqual(200);
    expect(name.endsWith(".pdf")).toBe(true);
  });
});

describe("clipboardCommand", () => {
  test("uses pbcopy on macOS and clip on Windows", () => {
    expect(clipboardCommand("darwin")).toBe("pbcopy");
    expect(clipboardCommand("win32")).toBe("clip");
    expect(clipboardCommand("linux")).toBeNull();
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

describe("search terms", () => {
  test.each([
    ["find a book", ["book"]],
    ["look for the cedar budget", ["cedar", "budget"]],
    ["Book 1.xlsx", ["book", "1"]],
    ["the budget PDF", ["budget"]],
    ["my file", ["my"]],
  ])("%p → %p", (q, terms) => expect(searchTerms(q)).toEqual(terms));

  test("a name matches only when it holds every term", () => {
    expect(nameMatchesTerms("Book 1.xlsx", ["book", "1"])).toBe(true);
    expect(nameMatchesTerms("book_club-notes.md", ["book"])).toBe(true);
    expect(nameMatchesTerms("Report.pdf", ["pdf"])).toBe(true);
    expect(nameMatchesTerms("Budget.xlsx", ["book"])).toBe(false);
    expect(nameMatchesTerms("Budget.xlsx", [])).toBe(false);
  });
});

describe("local uploads", () => {
  const home = os.homedir();
  test("resolves ~, home-relative and absolute paths", () => {
    expect(localUploadPath("~/Downloads/a.pdf")).toBe(path.join(home, "Downloads/a.pdf"));
    expect(localUploadPath("Desktop/b.png")).toBe(path.join(home, "Desktop/b.png"));
    expect(localUploadPath(`file://${home}/Pictures/c.jpg`)).toBe(path.join(home, "Pictures/c.jpg"));
    expect(localUploadPath("~/Documents/Work/Plan.docx")).toBe(path.join(home, "Documents/Work/Plan.docx"));
  });

  test("refuses hidden files and folders", () => {
    expect(() => localUploadPath("~/.ssh/id_ed25519")).toThrow(/hidden/);
    expect(() => localUploadPath("~/Documents/.env")).toThrow(/hidden/);
    expect(() => localUploadPath("~/Downloads/../.aws/credentials")).toThrow(/hidden/);
  });

  test("refuses anything outside the user's own folders", () => {
    const mac = { home: "/Users/pat", platform: "darwin" as const };
    expect(() => localUploadPath("~/Library/Keychains/login.keychain-db", mac)).toThrow(/only sends files from your Desktop, Documents/);
    expect(() => localUploadPath("~/Library/Application Support/Google/Chrome/Default/Cookies", mac)).toThrow(/outside them/);
    expect(() => localUploadPath("/etc/passwd", mac)).toThrow(/outside them/);
    expect(() => localUploadPath("/Users/other/Documents/a.pdf", mac)).toThrow(/outside them/);
    expect(() => localUploadPath("~/Downloads/../Library/x", mac)).toThrow(/outside them/);
    expect(() => localUploadPath("~/Documents-old/a.pdf", mac)).toThrow(/outside them/);
    expect(() => localUploadPath("~/notes.txt", mac)).toThrow(/outside them/);
    expect(localUploadPath("~/documents/a.pdf", mac)).toBe("/Users/pat/documents/a.pdf"); // case-insensitive volume
    expect(localUploadPath("~/Movies/clip.mov", mac)).toBe("/Users/pat/Movies/clip.mov");
  });

  test("on Windows, refuses AppData and other drives, allows OneDrive known folders", () => {
    const win = { home: "C:\\Users\\Pat", platform: "win32" as const };
    expect(() => localUploadPath("C:\\Users\\Pat\\AppData\\Roaming\\Microsoft\\Credentials\\x", win)).toThrow(/outside them/);
    expect(() => localUploadPath("~\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cookies", win)).toThrow(/outside them/);
    expect(() => localUploadPath("C:\\Windows\\System32\\config\\SAM", win)).toThrow(/outside them/);
    expect(() => localUploadPath("D:\\Documents\\a.pdf", win)).toThrow(/outside them/);
    expect(() => localUploadPath("C:\\Users\\Pat\\OneDrive\\AppData\\x", win)).toThrow(/outside them/);
    expect(localUploadPath("~\\Downloads\\Report.pdf", win)).toBe("C:\\Users\\Pat\\Downloads\\Report.pdf");
    expect(localUploadPath("c:\\users\\pat\\videos\\a.mp4", win)).toBe("c:\\users\\pat\\videos\\a.mp4");
    expect(localUploadPath("C:\\Users\\Pat\\OneDrive - UIUC\\Documents\\a.docx", win)).toBe("C:\\Users\\Pat\\OneDrive - UIUC\\Documents\\a.docx");
  });

  test("refuses a link from an allowed folder into ~/Library", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "od-home-"));
    fs.mkdirSync(path.join(home, "Downloads"));
    fs.mkdirSync(path.join(home, "Library/Keychains"), { recursive: true });
    fs.writeFileSync(path.join(home, "Library/Keychains/login.keychain-db"), "secret");
    fs.symlinkSync(path.join(home, "Library/Keychains/login.keychain-db"), path.join(home, "Downloads/report.pdf"));
    fs.symlinkSync(path.join(home, "Library"), path.join(home, "Downloads/lib"));
    await expect(readLocalUpload("~/Downloads/report.pdf", { home })).rejects.toThrow(/outside them/);
    await expect(readLocalUpload("~/Downloads/lib/Keychains/login.keychain-db", { home })).rejects.toThrow(/outside them/);
    // A missing file outside the allowed folders doesn't list that folder's contents either.
    await expect(readLocalUpload("~/Library/Keychains/login", { home })).rejects.toThrow(/outside them/);
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("names the type OneDrive should store", () => {
    expect(mimeTypeOf("Report.PDF")).toBe("application/pdf");
    expect(mimeTypeOf("Book 1.xlsx")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(mimeTypeOf("blob.weird")).toBe("application/octet-stream");
  });

  test("reads a file, and explains a missing, empty, folder or oversized one", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "od-up-"));
    const dir = path.join(home, "Downloads");
    const env = { home };
    fs.mkdirSync(path.join(dir, "Sub"), { recursive: true });
    fs.writeFileSync(path.join(dir, "Quarterly Report.pdf"), "pdf bytes");
    fs.writeFileSync(path.join(dir, "empty.txt"), "");
    fs.writeFileSync(path.join(dir, "big.bin"), Buffer.alloc(MAX_LOCAL_UPLOAD_BYTES + 1));
    const ok = await readLocalUpload(path.join(dir, "Quarterly Report.pdf"), env);
    expect(ok.bytes.toString()).toBe("pdf bytes");
    await expect(readLocalUpload(path.join(dir, "quarterly.pdf"), env)).rejects.toThrow(/no file at .*Quarterly Report.pdf/);
    await expect(readLocalUpload(path.join(dir, "empty.txt"), env)).rejects.toThrow(/empty/);
    await expect(readLocalUpload(path.join(dir, "Sub"), env)).rejects.toThrow(/is a folder/);
    await expect(readLocalUpload(path.join(dir, "big.bin"), env)).rejects.toThrow(/limited to/);
    fs.rmSync(home, { recursive: true, force: true });
  });
});
