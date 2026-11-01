import { describe, expect, test } from "bun:test";
import "./no-connect.ts";
import { strToU8, zipSync } from "fflate";
import { decodeXml, ooxmlText, pdfText, plainText, previewText, readStrategy, truncateText } from "../server.ts";

const zip = (files: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

/** Smallest valid one-page PDF that draws `text` with a standard font. */
function makePdf(text: string): Uint8Array {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return strToU8(out);
}

describe("readStrategy", () => {
  test.each([
    ["notes.md", "text"],
    ["data.CSV", "text"],
    ["Q3 Report.docx", "ooxml"],
    ["budget.xlsx", "ooxml"],
    ["deck.pptx", "ooxml"],
    ["scan.pdf", "pdf"],
    ["legacy.doc", "convert"],
    ["photo.jpg", "unsupported"],
    ["README", "unsupported"],
  ])("%p → %p", (name, expected) => {
    expect(readStrategy(name)).toBe(expected);
  });
});

describe("Word (.docx)", () => {
  test("keeps paragraphs, tabs and entities", () => {
    const doc = `<w:document><w:body>
      <w:p><w:r><w:t>Q3 revenue</w:t></w:r><w:r><w:t xml:space="preserve"> grew &amp; beat plan</w:t></w:r></w:p>
      <w:p><w:r><w:t>Region</w:t><w:tab/><w:t>EMEA</w:t></w:r></w:p>
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    </w:body></w:document>`;
    expect(ooxmlText("r.docx", zip({ "word/document.xml": doc }))).toBe("Q3 revenue grew & beat plan\nRegion\tEMEA\nCell");
  });
  test("rejects a file that isn't a zip", () => {
    expect(() => ooxmlText("r.docx", strToU8("not a zip"))).toThrow(/valid Office file/);
  });
});

describe("PowerPoint (.pptx)", () => {
  test("reads slides in numeric order", () => {
    const slide = (t: string) => `<p:sld><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:sld>`;
    const text = ooxmlText("d.pptx", zip({
      "ppt/slides/slide10.xml": slide("Ten"),
      "ppt/slides/slide2.xml": slide("Two"),
      "ppt/slides/slide1.xml": slide("One"),
    }));
    expect(text).toBe("--- Slide 1 ---\nOne\n\n--- Slide 2 ---\nTwo\n\n--- Slide 10 ---\nTen");
  });
});

describe("Excel (.xlsx)", () => {
  test("resolves shared strings, sheet names, and empty columns", () => {
    const text = ooxmlText("b.xlsx", zip({
      "xl/workbook.xml": `<workbook><sheets><sheet name="Budget &amp; Plan" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
      "xl/sharedStrings.xml": `<sst><si><t>Item</t></si><si><t>Cost</t></si><si><r><t>Lap</t></r><r><t>top</t></r></si></sst>`,
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>
        <row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>1299.5</v></c><c r="D2" t="b"><v>1</v></c></row>
        <row r="3"><c r="A3" t="inlineStr"><is><t>Mouse</t></is></c></row>
      </sheetData></worksheet>`,
    }));
    expect(text).toBe("--- Sheet: Budget & Plan ---\nItem\t\tCost\nLaptop\t\t1299.5\tTRUE\nMouse");
  });
});

describe("PDF", () => {
  test("extracts page text", async () => {
    const { text, pages } = await pdfText(makePdf("Hello OneDrive"));
    expect(pages).toBe(1);
    expect(text).toContain("Hello OneDrive");
  });
});

describe("plain text", () => {
  test("decodes UTF-8 and strips a BOM", () => {
    expect(plainText(strToU8("﻿café ☕"))).toBe("café ☕");
  });
  test("refuses binary data", () => {
    expect(() => plainText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))).toThrow(/binary/);
  });
});

describe("decodeXml / truncateText", () => {
  test("decodes named and numeric entities", () => {
    expect(decodeXml("&lt;a&gt; &amp;amp; &#65;&#x42; &quot;q&quot; &apos;")).toBe(`<a> &amp; AB "q" '`);
  });
  test("cuts at a line boundary and flags truncation", () => {
    const text = `${"a".repeat(90)}\n${"b".repeat(50)}`;
    expect(truncateText(text, 200)).toEqual({ text, truncated: false });
    expect(truncateText(text, 100)).toEqual({ text: "a".repeat(90), truncated: true });
  });
});

describe("previewText", () => {
  test("hides section markers in the one-line card preview", () => {
    expect(previewText("--- Page 1 ---\nGet started\n\n--- Page 2 ---\nwith OneDrive")).toBe("Get started with OneDrive");
    expect(previewText("--- Sheet: Budget ---\nItem\tCost")).toBe("Item Cost");
    expect(previewText("--- Slide 3 ---\nRoadmap")).toBe("Roadmap");
  });
});
