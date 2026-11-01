// Turns downloaded OneDrive bytes into plain text the model can read and summarize.
// Office Open XML files (docx/xlsx/pptx) are zip archives of XML, so they are
// unzipped and walked here rather than pulling in one heavy parser per format.
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { extractText as extractPdfText } from "unpdf";

export const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "xml", "html", "htm", "log", "yaml", "yml",
  "ini", "cfg", "conf", "toml", "js", "ts", "jsx", "tsx", "py", "rb", "go", "java", "c", "h",
  "cpp", "cs", "sh", "sql", "css", "srt", "vtt",
]);
export const OOXML_EXTENSIONS = new Set(["docx", "xlsx", "pptx"]);
/** Formats OneDrive can convert to PDF server-side before we read them. */
export const CONVERTIBLE_EXTENSIONS = new Set(["doc", "xls", "ppt", "rtf", "odt", "ods", "odp", "docm", "xlsm", "pptm"]);

export type ReadStrategy = "text" | "ooxml" | "pdf" | "convert" | "unsupported";

export function extensionOf(name: string): string {
  return path.extname(name).slice(1).toLowerCase();
}

export function readStrategy(name: string): ReadStrategy {
  const ext = extensionOf(name);
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  if (OOXML_EXTENSIONS.has(ext)) return "ooxml";
  if (ext === "pdf") return "pdf";
  if (CONVERTIBLE_EXTENSIONS.has(ext)) return "convert";
  return "unsupported";
}

export function decodeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function tidy(text: string): string {
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function docxText(files: Record<string, Uint8Array>): string {
  const xml = files["word/document.xml"];
  if (!xml) throw new Error("This .docx has no document body.");
  let out = "";
  const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<\/w:p>|<w:tab\/>|<w:br\b[^>]*\/>/g;
  for (const m of strFromU8(xml).matchAll(re)) {
    if (m[1] !== undefined) out += decodeXml(m[1]);
    else if (m[0] === "<w:tab/>") out += "\t";
    else out += "\n";
  }
  return tidy(out);
}

function pptxText(files: Record<string, Uint8Array>): string {
  const slides = Object.keys(files)
    .map((f) => ({ f, n: Number(f.match(/^ppt\/slides\/slide(\d+)\.xml$/)?.[1]) }))
    .filter((s) => s.n > 0)
    .sort((a, b) => a.n - b.n);
  return tidy(slides.map(({ f, n }) => {
    let body = "";
    for (const m of strFromU8(files[f]).matchAll(/<a:t>([^<]*)<\/a:t>|<\/a:p>/g)) {
      body += m[1] !== undefined ? decodeXml(m[1]) : "\n";
    }
    return `--- Slide ${n} ---\n${tidy(body)}`;
  }).join("\n\n"));
}

function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+/g, "").toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function xlsxText(files: Record<string, Uint8Array>): string {
  const read = (p: string) => (files[p] ? strFromU8(files[p]) : "");

  const shared = [...read("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((si) =>
    decodeXml([...si[1].matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => t[1]).join("")),
  );

  // Sheet order and names come from workbook.xml; files come from its relationships.
  const rels = new Map(
    [...read("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b[^>]*>/g)].map((r) => [
      r[0].match(/\bId="([^"]+)"/)?.[1],
      r[0].match(/\bTarget="([^"]+)"/)?.[1],
    ]),
  );
  const sheets = [...read("xl/workbook.xml").matchAll(/<sheet\b[^>]*>/g)].map((s) => {
    const target = rels.get(s[0].match(/\br:id="([^"]+)"/)?.[1]) || "";
    return {
      name: decodeXml(s[0].match(/\bname="([^"]*)"/)?.[1] || "Sheet"),
      file: target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`,
    };
  });

  return tidy(sheets.filter((s) => files[s.file]).map((sheet) => {
    const rows = [...read(sheet.file).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((row) => {
      const cells: string[] = [];
      for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const inner = c[2] || "";
        const type = attrs.match(/\bt="(\w+)"/)?.[1];
        const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        let value = "";
        if (type === "s" && v !== undefined) value = shared[Number(v)] ?? "";
        else if (type === "inlineStr") value = decodeXml([...inner.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => t[1]).join(""));
        else if (type === "b" && v !== undefined) value = v === "1" ? "TRUE" : "FALSE";
        else if (v !== undefined) value = decodeXml(v);
        const ref = attrs.match(/\br="([A-Z]+\d+)"/)?.[1];
        const col = ref ? columnIndex(ref) : cells.length;
        while (cells.length < col) cells.push("");
        cells[col] = value;
      }
      return cells.join("\t").replace(/\t+$/, "");
    }).filter((r) => r.length > 0);
    return `--- Sheet: ${sheet.name} ---\n${rows.join("\n")}`;
  }).join("\n\n"));
}

export function ooxmlText(name: string, bytes: Uint8Array): string {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error(`"${name}" isn't a valid Office file (couldn't unzip it).`);
  }
  const ext = extensionOf(name);
  if (ext === "docx") return docxText(files);
  if (ext === "pptx") return pptxText(files);
  return xlsxText(files);
}

export async function pdfText(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  const { totalPages, text } = await extractPdfText(new Uint8Array(bytes), { mergePages: false });
  return {
    pages: totalPages,
    text: tidy(text.map((t, i) => (totalPages > 1 ? `--- Page ${i + 1} ---\n${t.trim()}` : t.trim())).join("\n\n")),
  };
}

export function plainText(bytes: Uint8Array): string {
  if (bytes.subarray(0, 8000).includes(0)) throw new Error("This file looks binary, not text.");
  return new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
}

/** Cuts at a paragraph or line boundary near the limit so the model never sees half a sentence. */
export function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const slice = text.slice(0, maxChars);
  const cut = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf("\n"));
  return { text: (cut > maxChars * 0.8 ? slice.slice(0, cut) : slice).trimEnd(), truncated: true };
}
