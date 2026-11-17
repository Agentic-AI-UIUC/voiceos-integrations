# Word reading and supplied-log review

Version 2.0.6. Build dropbox-composio-v8-word-reading. The approved scope remains 14 tools and eight write confirmations.

## Log findings

The supplied logs show successful folder creation, Add and Overwrite uploads, search, metadata, copy, move and revision listing. A metadata lookup returned unavailable, then the same path succeeded after a later upload. This does not establish a persistent metadata bug or explain external file changes. No Dropbox write was repeated during this repair.

The read action retrieved the Word file reference but returned no readable text. The SDK staging warning was informational: the corresponding uploads returned successful metadata. The preview installation also resolved SDK 0.29.0 despite this repository's 0.28.0 pin, indicating the preview package was out of sync. Deploy package.json and the lockfile alongside the server; do not reinstall an older saved Studio draft.

## Word text extraction

Read a file now recognizes .docx, downloads the file reference returned by Composio and extracts text locally using Mammoth 1.13.0. The agent gets plain content and extracted_text; original download metadata remains under download. The card displays the extracted text rather than describing the document as binary-only. Empty documents are reported honestly. Failed extraction produces a readable MCP error, not a green binary-retrieval success.

Downloads are restricted to HTTPS Composio-managed R2 hosts, with no account key forwarded. Redirect destinations are revalidated. Compressed downloads are capped at 20 MiB; ZIP entry counts, entry sizes and total expanded size are bounded and actual entry sizes validated with yauzl 3.4.0. Unsupported XML declarations are rejected. Parsing uses an in-memory buffer and default-disabled external file access; no external document relationships are fetched. Cancellation and expired links have explicit handling. No extra OAuth scope, cloud conversion service or public tool was added.

Supported extraction is plain text, including paragraphs and tables; it does not preserve Word layout or OCR image-only pages. Legacy .doc, PDF and spreadsheet parsing are outside this fix. The card's long-text preview may be shortened, while the agent receives all extracted text up to the documented one-million-character read limit.

## Evidence

78 automated tests include parser fixtures, download-to-card and execution-boundary coverage, malformed/oversized archives, Unicode, table text, redirect restrictions, expired links and cancellation. Existing upload/card/browser regressions remain included. The existing local QA Word document was parsed read-only under VoiceOS's bundled Bun: 34 text characters, one paragraph, and the expected review marker. Its contents were not modified or copied into test fixtures. This local extraction check does not prove a fresh authenticated Dropbox download; retest Read a file in VoiceOS after reopening.

SDK upgrade notices remain disabled. Log level error suppresses the misleading file-staging advisory without hiding tool failures, which are still returned to the user. Deployment verification checks the actual installed SDK/parser versions against the package pins.

Parser references: https://github.com/mwilliamson/mammoth.js and https://github.com/thejoshwolfe/yauzl . No private raw logs or signed download URLs are included here.

Deployment verification: 2.0.6 installed with a backup; the frozen dependency install and bundled-Bun MCP initialization passed. Actual installed @composio/core 0.28.0, mammoth 1.13.0 and yauzl 3.4.0 matched their package pins. All 14 tools remain exposed and cached metadata is synchronized. A fresh authenticated Dropbox-to-text call remains manual QA.
