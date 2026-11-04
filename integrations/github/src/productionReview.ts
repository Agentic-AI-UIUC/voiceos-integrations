import { GithubError } from "./errors.ts";

// Replaced only by scripts/build.ts after checking the evidence against the
// current source fingerprint. Running unbundled source is unapproved.
declare const __GITHUB_PRODUCTION_APPROVED__: boolean;
const approved = typeof __GITHUB_PRODUCTION_APPROVED__ !== "undefined" && __GITHUB_PRODUCTION_APPROVED__ === true;

export const PRODUCTION_REVIEW_WARNING = "⚠️ SOC 2 review pending — production is blocked until Max and the SOC 2 team sign off.";

export function productionAccessAllowed(baseUrl: string): boolean {
  if (approved) return true;
  // The existing test seam can reach only a local fake. No environment,
  // repository, manifest preference or tool argument can approve production.
  try {
    const url = new URL(baseUrl);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}

export function assertProductionReviewed(baseUrl: string): void {
  if (!productionAccessAllowed(baseUrl)) throw new GithubError({
    category: "production_review_required",
    message: "Production GitHub access is blocked until Max and the SOC 2 team sign off on this build. Nothing was sent to GitHub.",
    nextAction: "The maintainers must record both sign-offs and rebuild the reviewed release. See PRODUCTION-REVIEW.md.",
  });
}
