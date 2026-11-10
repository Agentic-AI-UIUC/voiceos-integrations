/**
 * Pull the raw schema of each Composio TikTok tool at the pinned toolkit version (plan §5.2, spike S3)
 * into tests/fixtures/schemas/<slug>@<version>.json, so the pin is recorded and reviewable. It reads tool
 * metadata only (GET /tools/{slug}); it never executes a tool.
 *
 *   COMPOSIO_API_KEY=… bun scripts/pull-schemas.ts [version]      default: TIKTOK_TOOLKIT_VERSION
 *
 * REST v3.1 on purpose: on v3, omitting `version` silently selects the 00000000_00 base version. Pass the
 * version you are about to pin; bump TIKTOK_TOOLKIT_VERSION in src/config.ts only after this pull and the
 * live matrix (plan §10.3). TIKTOK_PUBLISH_VIDEO and TIKTOK_UPLOAD_VIDEOS are pulled for the record only:
 * no tool wraps them.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMPOSIO_BASE, TIKTOK_TOOLKIT_VERSION } from "../src/config.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = process.argv[2] ?? TIKTOK_TOOLKIT_VERSION;
const SLUGS = [
  "TIKTOK_GET_USER_STATS",
  "TIKTOK_LIST_VIDEOS",
  "TIKTOK_QUERY_VIDEOS",
  "TIKTOK_FETCH_PUBLISH_STATUS",
  "TIKTOK_PUBLISH_VIDEO",
  "TIKTOK_POST_PHOTO",
  "TIKTOK_UPLOAD_VIDEO",
  "TIKTOK_QUERY_CREATOR_INFO",
  "TIKTOK_UPLOAD_VIDEOS",
];

const key = process.env.COMPOSIO_API_KEY?.trim();
if (!key) {
  console.error("Set COMPOSIO_API_KEY to a Composio project API key (composio.dev → Settings → Project Settings → API Keys).");
  process.exit(2);
}
if (!/^\d{8}_\d{2}$/.test(VERSION)) {
  console.error(`"${VERSION}" isn't a Composio toolkit version (like 20261101_00).`);
  process.exit(2);
}

const out = join(root, "tests", "fixtures", "schemas");
mkdirSync(out, { recursive: true });
let failed = 0;
for (const slug of SLUGS) {
  try {
    const res = await fetch(`${COMPOSIO_BASE}/tools/${slug}?version=${encodeURIComponent(VERSION)}`, {
      headers: { "x-api-key": key, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const tool: any = await res.json();
    if (tool?.version !== VERSION) throw new Error(`asked for ${VERSION}, got ${tool?.version}`);
    writeFileSync(join(out, `${slug}@${VERSION}.json`), `${JSON.stringify(tool, null, 2)}\n`);
    console.error(`${slug} ${tool.version}: ${Object.keys(tool.input_parameters?.properties ?? {}).join(", ")}`);
  } catch (error) {
    failed++;
    console.error(`${slug}: ${(error as Error).message}`);
  }
}
console.error(failed ? `${failed} of ${SLUGS.length} schemas failed` : `wrote ${SLUGS.length} schemas to tests/fixtures/schemas/`);
process.exit(failed ? 1 : 0);
