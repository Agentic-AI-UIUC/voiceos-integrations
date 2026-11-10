/**
 * Constants and configuration as VoiceOS provides it.
 *
 * VoiceOS injects each manifest preference as `process.env.<name>`; an
 * undeclared variable is silently empty. Test seams arrive only as
 * command-line arguments (VoiceOS launches `bun server.ts` with none):
 *   --composio-base-url=http://127.0.0.1:<port>/api/v3.1   loopback only
 *   --media-relay-base=http://127.0.0.1:<port>              loopback only
 *   --state-dir=<dir>
 *   --home=<dir>                                            where Downloads/Desktop/… are looked up
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** IMMUTABLE once installed: VoiceOS keys settings and secrets off it. */
export const INTEGRATION_ID = "com.voiceos.generated.tiktok";
export const INTEGRATION_VERSION = "1.2.1";

/** The Composio TikTok toolkit version every execute call pins (plan §5.1, spike S3). Bump only after pull-schemas + the live matrix. */
export const TIKTOK_TOOLKIT_VERSION = "20261101_00";

export const COMPOSIO_BASE = "https://backend.composio.dev/api/v3.1";

/**
 * The media relay on a TikTok-verified domain (plan §4.4; the worker is in relay-worker/, not shipped).
 * No trailing slash: src/relay.ts adds /v1/…; TikTok pulls from its verified public prefix
 * https://tiktok-media-relay.rishabh-rb.workers.dev/p/ (live 2026-11-05). Set, so the build lists its host
 * in the network permission and ships the four photo tools enabled. Empty would ship them disabled, and
 * any photo write throws RELAY_NOT_CONFIGURED before doing any work (as it still does without a
 * MEDIA_RELAY_TOKEN).
 */
export const MEDIA_RELAY_BASE = "https://tiktok-media-relay.rishabh-rb.workers.dev";

/** TikTok's brand red: the cards' single accent colour (a colour, not a logo). */
export const ACCENT = "#fe2c55";

/**
 * Composio's presigned-upload host. Spike S2 (2026-11-04, live): `/files/upload/request` hands out Cloudflare R2
 * URLs on this bucket host, not the documented storage.composio.dev. If Composio moves buckets, the first
 * upload logs the new host ("composio upload host …"); update this and rebuild.
 */
export const COMPOSIO_UPLOAD_HOST = "temp.4d4f16c61d89ec64e760039c4ec50717.r2.cloudflarestorage.com";

/**
 * TikTok's image CDN, for the profile picture and post covers on the result cards (src/covers.ts). Exact hosts
 * only (VoiceOS has no wildcard domains): the ones TikTok's avatar_url_100 and cover_image_url pointed at, seen
 * live on 2026-11-05. A URL on any other host is skipped and the card shows its fallback tile; the build adds
 * these to the manifest's network permission.
 */
export const TIKTOK_IMAGE_HOSTS: readonly string[] = Object.freeze(["p16-common-sign.tiktokcdn-us.com", "p19-common-sign.tiktokcdn-us.com"]);

export interface Config {
  /** COMPOSIO_API_KEY (password preference). Undefined when unset. */
  apiKey?: string;
  /** COMPOSIO_USER_ID, or "default" when empty. */
  userId: string;
  /** COMPOSIO_CONNECTED_ACCOUNT_ID (ca_…). Undefined when unset. */
  connectedAccountId?: string;
  /** MEDIA_RELAY_TOKEN (password preference). Undefined when unset. */
  relayToken?: string;
  /** Composio REST base, no trailing slash. */
  baseUrl: string;
  /** Media relay base, no trailing slash; "" when not deployed. */
  relayBase: string;
  /** Where spent receipts persist. */
  stateDir: string;
  /** Home folder used to resolve ~/Downloads, ~/Desktop, ~/Movies, ~/Pictures. */
  home: string;
}

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/;

/** Only loopback overrides are honoured, so nothing can point a real install (and its API key) elsewhere. */
export function resolveBaseUrl(override?: string): string {
  return override && LOOPBACK.test(override) ? override.replace(/\/+$/, "") : COMPOSIO_BASE;
}

export function resolveRelayBase(override?: string): string {
  if (override && LOOPBACK.test(override)) return override.replace(/\/+$/, "");
  return MEDIA_RELAY_BASE.replace(/\/+$/, "");
}

export function argument(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

/** VoiceOS's per-integration state folder (the Manus convention), so Studio reinstalls of this folder don't wipe it. */
export function defaultStateDir(home: string, platform: NodeJS.Platform = process.platform, appData = process.env.APPDATA): string {
  if (platform === "win32" && appData) return join(appData, "VoiceOS", "integration-state", INTEGRATION_ID);
  return join(home, "Library", "Application Support", "VoiceOS", "integration-state", INTEGRATION_ID);
}

export function loadConfig(env: Record<string, string | undefined>, argv: string[] = []): Config {
  const text = (name: string) => {
    const v = env[name]?.trim();
    return v ? v : undefined;
  };
  const home = argument(argv, "home") ?? homedir();
  return {
    apiKey: text("COMPOSIO_API_KEY"),
    userId: text("COMPOSIO_USER_ID") ?? "default",
    connectedAccountId: text("COMPOSIO_CONNECTED_ACCOUNT_ID"),
    relayToken: text("MEDIA_RELAY_TOKEN"),
    baseUrl: resolveBaseUrl(argument(argv, "composio-base-url")),
    relayBase: resolveRelayBase(argument(argv, "media-relay-base")),
    stateDir: argument(argv, "state-dir") ?? defaultStateDir(home),
    home,
  };
}
