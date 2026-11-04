/**
 * Result cards for the notch, built on the Widget Kit.
 *
 * Widgets rather than native glance blocks for one reason: results need links
 * (Open on GitHub, Connect GitHub), and native blocks can't carry any. The
 * visual language is GitHub's own — state pills, muted #numbers, monospace
 * only for code (SHAs, branches, paths, queries) — so a glance reads the way
 * GitHub does. Color means state and nothing else. Every string is escaped,
 * and only https github.com / connect.composio.dev links are ever rendered.
 */
import { clip, esc, markHtml, renderCustom } from "../widgetKit.ts";
import type { GithubError } from "./errors.ts";
import type { CodeFacts, IssueFacts, LabelFact, PullFacts, RepoFacts } from "./normalize.ts";
import type { DisconnectRecord } from "./state.ts";

export interface Widget {
  type: "widget";
  html: string;
  height: number;
  label: string;
}

// Octicons (MIT, github/primer).
const PATHS: Record<string, string> = {
  "issue-opened": '<path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z"/>',
  "issue-closed": '<path d="M11.28 6.78a.75.75 0 0 0-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l3.5-3.5Z"/><path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0Zm-1.5 0a6.5 6.5 0 1 0-13 0 6.5 6.5 0 0 0 13 0Z"/>',
  skip: '<path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm9.78-2.22-5.5 5.5a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l5.5-5.5a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042Z"/>',
  pr: '<path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"/>',
  "pr-merged": '<path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z"/>',
  "pr-closed": '<path d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-2.03-5.273a.75.75 0 0 1 1.06 0l.97.97.97-.97a.748.748 0 0 1 1.265.332.75.75 0 0 1-.205.729l-.97.97.97.97a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-.97-.97-.97.97a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l.97-.97-.97-.97a.75.75 0 0 1 0-1.06ZM2.5 12.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 1.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 9.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/>',
  "pr-draft": '<path d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 14a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM14 7.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm0-4.25a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z"/>',
  check: '<path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/>',
  alert: '<path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/>',
  stop: '<path d="M4.47.22A.749.749 0 0 1 5 0h6c.199 0 .389.079.53.22l4.25 4.25c.141.14.22.331.22.53v6a.749.749 0 0 1-.22.53l-4.25 4.25A.749.749 0 0 1 11 16H5a.749.749 0 0 1-.53-.22L.22 11.53A.749.749 0 0 1 0 11V5c0-.199.079-.389.22-.53Zm.84 1.28L1.5 5.31v5.38l3.81 3.81h5.38l3.81-3.81V5.31L10.69 1.5ZM8 4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/>',
  comment: '<path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/>',
  repo: '<path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z"/>',
  lock: '<path d="M4 4a4 4 0 0 1 8 0v2h.25c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 12.25 15h-8.5A1.75 1.75 0 0 1 2 13.25v-5.5C2 6.784 2.784 6 3.75 6H4Zm8.25 3.5h-8.5a.25.25 0 0 0-.25.25v5.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25ZM10.5 6V4a2.5 2.5 0 1 0-5 0v2Z"/>',
  file: '<path d="M4 1.75C4 .784 4.784 0 5.75 0h5.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v8.586A1.75 1.75 0 0 1 14.25 15h-9a.75.75 0 0 1 0-1.5h9a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 10 4.25V1.5H5.75a.25.25 0 0 0-.25.25v2.5a.75.75 0 0 1-1.5 0Zm1.72 4.97a.75.75 0 0 1 1.06 0l2 2a.75.75 0 0 1 0 1.06l-2 2a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l1.47-1.47-1.47-1.47a.75.75 0 0 1 0-1.06ZM3.28 7.78 1.81 9.25l1.47 1.47a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-2-2a.75.75 0 0 1 0-1.06l2-2a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042Zm8.22-6.218V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z"/>',
  star: '<path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z"/>',
  chevron: '<path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"/>',
  commit: '<path d="M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"/>',
};

const icon = (name: keyof typeof PATHS | string, cls = "") =>
  `<svg class="gh-i${cls ? ` ${cls}` : ""}" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">${PATHS[name] ?? ""}</svg>`;

export const CARD_CSS = `
:root{--gh-open:#3fb950;--gh-done:#a371f7;--gh-closed:#f85149;--gh-muted:#8b949e;--gh-link:#4493f8;--gh-warn:#d29922;--gh-btn:#238636;--gh-mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace}
html[data-k-theme=light]{--gh-open:#1a7f37;--gh-done:#8250df;--gh-closed:#cf222e;--gh-muted:#59636e;--gh-link:#0969da;--gh-warn:#9a6700;--gh-btn:#1f883d}
.gh{padding:13px 15px 14px;display:flex;flex-direction:column;gap:10px;min-width:0}
.gh-i{width:16px;height:16px;flex:none;display:block}
.s-open{--gh-c:var(--gh-open)}.s-done{--gh-c:var(--gh-done)}.s-closed{--gh-c:var(--gh-closed)}.s-muted{--gh-c:var(--gh-muted)}
.gh-pill{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 9px 0 7px;border-radius:999px;font-size:12px;font-weight:600;color:#fff;background:var(--gh-c);width:max-content;flex:none}
.gh-pill .gh-i{width:14px;height:14px}
.gh-obj{display:flex;flex-direction:column;gap:6px;min-width:0}
.gh-title{font-size:15px;font-weight:600;letter-spacing:-.01em;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.gh-num{color:var(--ink-3);font-weight:400;font-variant-numeric:tabular-nums}
.gh-meta{font-size:12px;color:var(--ink-3);line-height:1.45}
.gh-chips{display:flex;flex-wrap:wrap;gap:5px}
.gh-chip{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px;border-radius:999px;font-size:11.5px;font-weight:500;color:var(--ink-2);background:var(--fill-1);border:1px solid var(--line);max-width:160px;white-space:nowrap;overflow:hidden}
.gh-chip span{overflow:hidden;text-overflow:ellipsis}
.gh-chip i{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dot,var(--ink-4))}
.gh-tlink{color:inherit;text-decoration:none}
.gh-tlink:hover{color:var(--gh-link)}
.gh-list{display:flex;flex-direction:column;min-width:0}
.gh-row{display:flex;align-items:flex-start;gap:9px;padding:7px 0;border-top:1px solid var(--line);color:inherit;text-decoration:none;min-width:0}
.gh-row:first-child{border-top:0;padding-top:0}
.gh-row>.gh-i{margin-top:2px;color:var(--gh-c,var(--ink-3))}
.gh-row-m{flex:1;min-width:0}
.gh-row-t{display:block;font-size:13.5px;font-weight:600;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
a.gh-row:hover .gh-row-t{color:var(--gh-link)}
.gh-row-s{display:block;font-size:11.5px;color:var(--ink-3);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gh-row-tr{flex:none;display:flex;align-items:center;gap:3px;font-size:11.5px;color:var(--ink-3);font-variant-numeric:tabular-nums;margin-top:2px}
.gh-row-tr .gh-i{width:12px;height:12px}
.gh-tag{flex:none;font-size:11px;font-weight:600;padding:1px 7px;border-radius:999px;border:1px solid var(--line);color:var(--ink-2);margin-top:1px}
.gh-more{font-size:11.5px;color:var(--ink-4);padding-top:7px;border-top:1px solid var(--line)}
.gh-sub{font-size:13px;font-weight:600;color:var(--ink-1)}
.gh-foot{font-size:11.5px;color:var(--ink-4);line-height:1.45}
.gh-q{font-family:var(--gh-mono);font-size:11.5px;color:var(--ink-2);background:var(--fill-1);border:1px solid var(--line);border-radius:6px;padding:4px 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gh-mono{font-family:var(--gh-mono);font-size:12px}
.gh-path{display:flex;min-width:0;font-family:var(--gh-mono);font-size:12.5px;white-space:nowrap;line-height:1.35}
.gh-dir{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--ink-3)}
.gh-path b{flex:none;max-width:100%;overflow:hidden;text-overflow:ellipsis;font-weight:600;color:var(--ink-1)}
a.gh-row:hover .gh-path b{color:var(--gh-link)}
.gh-frag{display:block;font-family:var(--gh-mono);font-size:11px;color:var(--ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.gh-done{display:flex;align-items:center;gap:7px;font-size:15px;font-weight:600;letter-spacing:-.01em;line-height:1.3}
.gh-done>.gh-i{color:var(--gh-c,var(--gh-open))}
.gh-quote{font-size:12.5px;line-height:1.45;color:var(--ink-2);padding:1px 0 1px 10px;border-left:2px solid var(--line);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;white-space:pre-wrap}
.gh-summary{border-top:1px solid var(--line);padding-top:10px}
.gh-summary-text{margin:0;font-size:13px;line-height:1.45;color:var(--ink-1);overflow-wrap:anywhere;white-space:normal}
.gh-warn{display:flex;gap:7px;align-items:flex-start;font-size:12px;line-height:1.4;color:var(--ink-2)}
.gh-warn>.gh-i{color:var(--gh-warn);width:14px;height:14px;margin-top:1px}
.gh-changes{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font-size:12.5px;margin:0}
.gh-changes dt{color:var(--ink-3)}
.gh-changes dd{margin:0;min-width:0;display:flex;align-items:center;gap:6px;flex-wrap:wrap;overflow-wrap:anywhere}
.gh-changes del{color:var(--ink-4)}.gh-changes .gh-i{width:12px;height:12px;color:var(--ink-4)}
.gh-err{display:flex;align-items:center;gap:7px;font-size:15px;font-weight:600;line-height:1.3}
.gh-err>.gh-i{color:var(--gh-closed)}.gh-err.unk>.gh-i{color:var(--gh-warn)}
.gh-msg{font-size:12.5px;line-height:1.45;color:var(--ink-2);overflow-wrap:anywhere}
.gh-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 14px;border-radius:6px;background:var(--gh-btn);color:#fff;font-size:13px;font-weight:600;text-decoration:none;width:max-content;box-shadow:inset 0 0 0 1px rgba(255,255,255,.1)}
.gh-btn:hover{filter:brightness(1.08)}
.gh-btn.alt{background:var(--fill-2);color:var(--ink-1);box-shadow:inset 0 0 0 1px var(--line)}
.gh-btn:focus-visible,.gh-tlink:focus-visible,a.gh-row:focus-visible{outline:2px solid var(--gh-link);outline-offset:2px;border-radius:6px}
.gh-wait{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:600;line-height:1.3}
.gh-spin{width:14px;height:14px;border-radius:50%;border:2px solid var(--line);border-top-color:var(--gh-link);flex:none}
@media (prefers-reduced-motion:no-preference){.gh-spin{animation:gh-spin .9s linear infinite}}
@keyframes gh-spin{to{transform:rotate(360deg)}}
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function ago(iso: string | undefined | null, now: number): string {
  const t = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(t)) return "recently";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 45) return "just now";
  if (s < 90) return "1 minute ago";
  if (s < 45 * 60) return `${Math.round(s / 60)} minutes ago`;
  if (s < 90 * 60) return "1 hour ago";
  if (s < 22 * 3600) return `${Math.round(s / 3600)} hours ago`;
  if (s < 36 * 3600) return "yesterday";
  if (s < 26 * 86400) return `${Math.round(s / 86400)} days ago`;
  const d = new Date(t);
  const sameYear = d.getUTCFullYear() === new Date(now).getUTCFullYear();
  return `on ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" })}`;
}

export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 999_950) return `${(n / 1000).toFixed(n < 10_000 ? 1 : n < 100_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

const and = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

const safeHref = (url: string | undefined, allowConnect = false): string | undefined => {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return undefined;
    if (u.hostname === "github.com") return u.toString();
    if (allowConnect && u.hostname === "connect.composio.dev") return u.toString();
  } catch {
    return undefined;
  }
  return undefined;
};

function header(trailing?: string): string {
  return `<div class="k-hd"><div class="k-hd-l">${markHtml()}<span class="k-hd-t">GitHub</span></div>${
    trailing ? `<span class="k-hd-tr">${esc(clip(trailing, 28))}</span>` : ""
  }</div>`;
}

function render(body: string, height: number, label: string): Widget {
  const card = renderCustom({ css: CARD_CSS, body: `<div class="gh">${body}</div>`, height, label: clip(label, 60) });
  return { type: "widget", html: card.html, height: card.height, label: card.label ?? clip(label, 60) };
}

export function glance(widget: Widget) {
  return { _voiceos_glance: { blocks: [widget] } };
}

function issueState(i: Pick<IssueFacts, "state" | "state_reason" | "is_pull_request">): { cls: string; icon: string; label: string } {
  if (i.is_pull_request) return i.state === "open" ? { cls: "s-open", icon: "pr", label: "Open" } : { cls: "s-closed", icon: "pr-closed", label: "Closed" };
  if (i.state === "open") return { cls: "s-open", icon: "issue-opened", label: "Open" };
  if (i.state_reason === "not_planned") return { cls: "s-muted", icon: "skip", label: "Not planned" };
  return { cls: "s-done", icon: "issue-closed", label: "Closed" };
}

const PULL_STATES: Record<PullFacts["status"], { cls: string; icon: string; label: string }> = {
  open: { cls: "s-open", icon: "pr", label: "Open" },
  draft: { cls: "s-muted", icon: "pr-draft", label: "Draft" },
  merged: { cls: "s-done", icon: "pr-merged", label: "Merged" },
  closed: { cls: "s-closed", icon: "pr-closed", label: "Closed" },
};

function labelChips(labels: LabelFact[], max = 4): string {
  if (!labels.length) return "";
  const shown = labels.slice(0, max);
  const chips = shown
    .map((l) => `<span class="gh-chip"${l.color ? ` style="--dot:#${esc(l.color)}"` : ""}><i></i><span>${esc(clip(l.name, 40))}</span></span>`)
    .join("");
  const more = labels.length > max ? `<span class="gh-chip"><span>+${labels.length - max}</span></span>` : "";
  return `<div class="gh-chips">${chips}${more}</div>`;
}

function issueBlock(i: IssueFacts, now: number): string {
  const st = issueState(i);
  const parts = [`Opened ${ago(i.created_at, now)}${i.author ? ` by ${esc(i.author)}` : ""}.`];
  if (i.state === "closed") parts.push(`Closed ${ago(i.closed_at, now)}.`);
  parts.push(`${plural(i.comments, "comment")}.`);
  if (i.locked) parts.push("Conversation locked.");
  const assigned = i.assignees.length ? `<div class="gh-meta">Assigned to ${esc(i.assignees.slice(0, 4).join(", "))}${i.assignees.length > 4 ? ` and ${i.assignees.length - 4} more` : ""}</div>` : "";
  return `<div class="gh-obj">
    <span class="gh-pill ${st.cls}">${icon(st.icon)}${st.label}</span>
    <div class="gh-title">${titleLink(i.html_url, `${esc(clip(i.title, 300))} <span class="gh-num">#${i.number}</span>`)}</div>
    <div class="gh-meta">${parts.join(" ")}</div>
    ${labelChips(i.labels)}
    ${assigned}
  </div>`;
}

const warnings = (list: string[]) =>
  list.map((w) => `<div class="gh-warn">${icon("alert")}<span>${esc(w)}</span></div>`).join("");

/** Every card links the same way: the item's own title or headline is the link (as PR and search rows are). */
const titleLink = (url: string | undefined, inner: string) => {
  const href = safeHref(url);
  return href ? `<a class="gh-tlink" href="${esc(href)}">${inner}</a>` : inner;
};

// ---------------------------------------------------------------------------
// Read results
// ---------------------------------------------------------------------------

export function issueCard(i: IssueFacts, owner: string, repo: string, now = Date.now()): Widget {
  const body = `${header(`${owner}/${repo}`)}${issueBlock(i, now)}`;
  const height = 120 + (i.labels.length ? 26 : 0) + (i.assignees.length ? 18 : 0) + (i.title.length > 44 ? 20 : 0);
  return render(body, height, `GitHub ${i.is_pull_request ? "pull request" : "issue"} #${i.number}`);
}

/**
 * Pull requests a list card shows, and so a page of the list: "more" asks for the next page, which has to be the
 * next rows on the card (user, 2026-10-28: it skipped to row 21, or to an empty page 2). Three rows and the
 * longest summary fit 420px.
 */
export const PULL_ROWS = 3;

export function pullListCard(input: {
  owner?: string;
  repo?: string;
  state: "open" | "closed" | "all";
  page: number;
  perPage: number;
  pulls: Array<PullFacts & { repository?: string }>;
  /** Pull requests from your own repositories: each row names its repository, and the footer says how many were read. */
  across?: { repositories: number; unread?: number; account?: string };
  /** How many come after these rows: exactly, or at least this many while the end of the list hasn't been read. */
  rest?: { count: number; atLeast?: boolean };
  author?: string;
  scanned?: number;
  /** One pull request looked up by number: its own heading, no paging footer. */
  title?: string;
  /** VoiceOS's answer, grounded in this result's descriptions and metadata. */
  summary?: string;
  now?: number;
}): Widget {
  const now = input.now ?? Date.now();
  const stateWord = input.state === "all" ? "" : `${input.state} `;
  const heading = input.author
    ? `${input.author}'s ${stateWord}pull requests`
    : `${stateWord.charAt(0).toUpperCase()}${stateWord.slice(1)}pull requests`.replace(/^P/, input.state === "all" ? "P" : "P");
  const title =
    input.title ??
    (input.across && !input.author ? "Your open pull requests" : input.author ? heading : input.state === "all" ? "Pull requests" : `${input.state === "open" ? "Open" : "Closed"} pull requests`);
  // No raw description first: Agent Mode's summary would then replace it, which flashes. The summary only ever adds.
  const summary = input.summary ?? "";
  // The same rows whether or not a summary has arrived: the agent's summary lands below them a moment later, and
  // dropping rows to make room for it read as the card glitching.
  const shown = input.pulls.slice(0, PULL_ROWS);
  const rows = shown
    .map((p) => {
      const st = PULL_STATES[p.status];
      const href = safeHref(p.html_url);
      // A single PR's pill already says it, and under an "Open pull requests" heading a plain open row needs no tag.
      const tag = !input.title && (p.status !== "open" || input.state !== "open") ? `<span class="gh-tag">${st.label}</span>` : "";
      // Across your repositories the heading already says whose they are, and each row says where it is.
      const place = p.repository ? `${esc(p.repository)} ` : "";
      const by = p.author && !input.across ? ` by ${esc(p.author)}` : "";
      const inner = `${icon(st.icon)}<span class="gh-row-m"><span class="gh-row-t">${esc(clip(p.title, 200))}</span><span class="gh-row-s">${place}#${p.number}${by}, updated ${ago(p.updated_at, now)}</span></span>${tag}`;
      return href ? `<a class="gh-row ${st.cls}" href="${esc(href)}">${inner}</a>` : `<div class="gh-row ${st.cls}">${inner}</div>`;
    })
    .join("");
  const more = input.rest && input.rest.count > 0
    ? `<div class="gh-more">${input.rest.count.toLocaleString("en-US")}${input.rest.atLeast ? "+" : ""} more</div>`
    : "";
  const unread = input.across?.unread ?? 0;
  const coverage = input.across
    ? `From ${input.across.repositories.toLocaleString("en-US")} of your repositories${unread ? `, ${unread.toLocaleString("en-US")} not read` : ""}`
    : input.author
      ? `From the ${input.scanned ?? input.pulls.length} most recent`
      : `Page ${input.page}`;
  // Repositories left unread can't be counted as having none.
  const where = input.across
    ? unread ? `the ${input.across.repositories === 1 ? "repository" : `${input.across.repositories.toLocaleString("en-US")} repositories`} read` : "your repositories"
    : esc(`${input.owner}/${input.repo}`);
  // One PR looked up by number: its state pill replaces the heading, since the row already says #N. Its row is the link.
  const single = input.title && input.pulls.length === 1 ? input.pulls[0] : undefined;
  const pill = single ? `<span class="gh-pill ${PULL_STATES[single.status].cls}">${icon(PULL_STATES[single.status].icon)}${PULL_STATES[single.status].label}</span>` : "";
  const askedNames = single ? [...(single.requested_reviewers ?? []), ...(single.requested_teams ?? [])] : [];
  const asked = askedNames.length
    ? `<div class="gh-meta">Review requested from ${esc(and(askedNames.length > 4 ? [...askedNames.slice(0, 3), `${askedNames.length - 3} others`] : askedNames))}</div>`
    : "";
  const whose = input.across ? (input.author ? ` by ${esc(input.author)}` : " of yours") : "";
  const empty = !input.pulls.length
    ? `<div class="gh-msg">No ${input.page > 1 ? "more " : ""}${input.state === "all" ? "" : `${input.state} `}pull requests${whose} in ${where}.</div>`
    : "";
  const body = `${header(input.across ? input.across.account : `${input.owner}/${input.repo}`)}${pill || `<div class="gh-sub">${esc(title)}</div>`}${
    rows ? `<div class="gh-list">${rows}${more}</div>` : empty
  }${asked}${summary ? `<section class="gh-summary" aria-label="VoiceOS summary"><p class="gh-summary-text">${esc(summary)}</p></section>` : ""}${input.title ? "" : `<div class="gh-foot">${coverage}</div>`}`;
  const height = 90 + (shown.length ? shown.length * 48 : 22) + (more ? 26 : 0) + (summary ? 22 + Math.ceil(summary.length / 53) * 19 : 0) + (pill ? 4 : 0) + (asked ? 28 : 0);
  return render(body, height, input.across ? "Your open GitHub pull requests" : `GitHub pull requests in ${input.owner}/${input.repo}`);
}

type SearchDisplay = { start: number; end: number; count: number };
function searchPosition(input: { page: number; perPage: number; display?: SearchDisplay; hasNext?: boolean }, count: number): string {
  const start = input.display?.start ?? (input.page - 1) * input.perPage + 1;
  const end = input.display?.end ?? start + count - 1;
  return `${count ? `Results ${start}–${end}` : "No results on this page"} · Page ${input.page}`;
}

export function repoSearchCard(input: { query: string; total: number; incomplete: boolean; page: number; perPage: number; repos: RepoFacts[]; display?: SearchDisplay; hasNext?: boolean; sort?: string; order?: string }): Widget {
  const shown = input.repos.slice(0, 5);
  const rows = shown
    .map((r) => {
      const href = safeHref(r.html_url);
      const flags = [r.private ? "Private" : "", r.archived ? "Archived" : "", r.fork ? "Fork" : ""].filter(Boolean);
      const sub = [r.description, r.language, ...flags].filter(Boolean).join(" · ");
      const inner = `${icon(r.private ? "lock" : "repo")}<span class="gh-row-m"><span class="gh-row-t">${esc(r.full_name)}</span>${
        sub ? `<span class="gh-row-s">${esc(clip(sub, 140))}</span>` : ""
      }</span><span class="gh-row-tr">${icon("star")}${compact(r.stars)}</span>`;
      return href ? `<a class="gh-row" href="${esc(href)}">${inner}</a>` : `<div class="gh-row">${inner}</div>`;
    })
    .join("");
  const more = input.repos.length > shown.length ? `<div class="gh-more">${input.repos.length - shown.length} more on this page</div>` : "";
  const notes = [
    !input.repos.length ? `<div class="gh-msg">No matches returned for this query.</div>` : "",
    input.incomplete ? warnings(["GitHub returned partial results for this search."]) : "",
  ].join("");
  const body = `${header(plural(input.total, "match", "matches"))}<div class="gh-q">${esc(clip(input.query, 200))}</div>${
    rows ? `<div class="gh-list">${rows}${more}</div>` : ""
  }${notes}<div class="gh-foot">${esc(searchPosition(input, shown.length))}${input.sort ? ` · ${esc(input.sort)} ${input.order === "asc" ? "ascending" : "descending"}` : ""}</div>`;
  const height = 116 + shown.length * 48 + (more ? 26 : 0) + (input.repos.length ? 0 : 24) + (input.incomplete ? 22 : 0);
  return render(body, height, "GitHub repository search");
}

export function codeSearchCard(input: { query: string; total: number; incomplete: boolean; page: number; perPage: number; hits: CodeFacts[]; display?: SearchDisplay; hasNext?: boolean }): Widget {
  const shown = input.hits.slice(0, 5);
  const rows = shown
    .map((h) => {
      const href = safeHref(h.html_url);
      const slash = h.path.lastIndexOf("/");
      const dir = slash >= 0 ? h.path.slice(0, slash + 1) : "";
      const name = h.path.slice(slash + 1);
      const inner = `${icon("file")}<span class="gh-row-m"><span class="gh-path"><span class="gh-dir">${esc(dir)}</span><b>${esc(name)}</b></span>${
        h.fragment ? `<span class="gh-frag">${esc(clip(h.fragment.replace(/\s+/g, " "), 160))}</span>` : `<span class="gh-row-s">${esc(h.repository)} · No code excerpt</span>`
      }</span>`;
      return href ? `<a class="gh-row" href="${esc(href)}">${inner}</a>` : `<div class="gh-row">${inner}</div>`;
    })
    .join("");
  const more = input.hits.length > shown.length ? `<div class="gh-more">${input.hits.length - shown.length} more on this page</div>` : "";
  const notes = [
    !input.hits.length ? `<div class="gh-msg">No matches returned for this query.</div>` : "",
    input.incomplete ? warnings(["GitHub returned partial results for this search."]) : "",
  ].join("");
  const body = `${header(plural(input.total, "file"))}<div class="gh-q">${esc(clip(input.query, 200))}</div>${
    rows ? `<div class="gh-list">${rows}${more}</div>` : ""
  }${notes}<div class="gh-foot">${esc(searchPosition(input, shown.length))}</div>`;
  const height = 136 + shown.length * 48 + (more ? 26 : 0) + (input.hits.length ? 0 : 24) + (input.incomplete ? 22 : 0);
  return render(body, height, "GitHub code search");
}

// ---------------------------------------------------------------------------
// Write results
// ---------------------------------------------------------------------------

export function issueCreatedCard(input: { owner: string; repo: string; issue: IssueFacts; warnings: string[]; now?: number }): Widget {
  const now = input.now ?? Date.now();
  const target = `${input.owner}/${input.repo}#${input.issue.number}`;
  const body = `${header(`${input.owner}/${input.repo}`)}<div class="gh-done s-open">${icon("check")}<span>Created ${esc(target)}.</span></div>${issueBlock(
    input.issue,
    now,
  )}${warnings(input.warnings)}`;
  const height = 124 + (input.issue.labels.length ? 26 : 0) + (input.issue.assignees.length ? 18 : 0) + input.warnings.length * 34;
  return render(body, height, `Created GitHub issue #${input.issue.number}`);
}

export interface FieldChange {
  field: string;
  before: string;
  after: string;
}

export function issueUpdatedCard(input: { owner: string; repo: string; headline: string; changes: FieldChange[]; issue: IssueFacts; warnings: string[]; now?: number }): Widget {
  const rows = input.changes
    .map(
      (c) =>
        `<dt>${esc(c.field)}</dt><dd><del>${esc(clip(c.before || "none", 120))}</del>${icon("chevron")}<span>${esc(clip(c.after || "none", 160))}</span></dd>`,
    )
    .join("");
  const st = issueState(input.issue);
  const body = `${header(`${input.owner}/${input.repo}`)}<div class="gh-done ${st.cls}">${icon(st.icon)}<span>${esc(input.headline)}</span></div><div class="gh-title">${titleLink(
    input.issue.html_url,
    `${esc(clip(input.issue.title, 300))} <span class="gh-num">#${input.issue.number}</span>`,
  )}</div>${rows ? `<dl class="gh-changes">${rows}</dl>` : ""}${warnings(input.warnings)}`;
  const height = 130 + input.changes.length * 24 + input.warnings.length * 34;
  return render(body, height, `Updated GitHub issue #${input.issue.number}`);
}

export function commentPostedCard(input: { owner: string; repo: string; number: number; isPullRequest: boolean; body: string; url?: string; warnings?: string[] }): Widget {
  const target = `${input.owner}/${input.repo}#${input.number}`;
  const body = `${header(`${input.owner}/${input.repo}`)}<div class="gh-done s-open">${icon("comment")}<span>${titleLink(input.url, `Comment posted on ${esc(target)}.`)}</span></div><div class="gh-quote">${esc(
    clip(input.body, 600),
  )}</div>${warnings(input.warnings ?? [])}`;
  return render(body, 124 + (input.warnings?.length ?? 0) * 34, `Comment posted on #${input.number}`);
}

export function reviewSubmittedCard(input: {
  owner: string;
  repo: string;
  number: number;
  prTitle?: string;
  state: string;
  commit: string;
  body: string;
  url?: string;
  warnings?: string[];
}): Widget {
  const short = input.commit.slice(0, 7);
  const target = `${input.owner}/${input.repo}#${input.number}`;
  const verdict =
    input.state === "APPROVED"
      ? { cls: "s-open", icon: "check", headline: `Approved ${target} at ${short}.` }
      : input.state === "CHANGES_REQUESTED"
        ? { cls: "s-closed", icon: "stop", headline: `Requested changes on ${target}.` }
        : { cls: "s-muted", icon: "comment", headline: `Review comment posted on PR #${input.number}.` };
  const body = `${header(`${input.owner}/${input.repo}`)}<div class="gh-done ${verdict.cls}">${icon(verdict.icon)}<span>${titleLink(input.url, esc(verdict.headline))}</span></div>${
    input.prTitle ? `<div class="gh-title">${esc(clip(input.prTitle, 300))} <span class="gh-num">#${input.number}</span></div>` : ""
  }<div class="gh-meta">Commit <span class="gh-mono">${esc(short)}</span></div>${
    input.body ? `<div class="gh-quote">${esc(clip(input.body, 600))}</div>` : ""
  }${warnings(input.warnings ?? [])}`;
  return render(body, 124 + (input.body ? 40 : 0) + (input.warnings?.length ?? 0) * 34, `Review on pull request #${input.number}`);
}

// ---------------------------------------------------------------------------
// Errors, connection, and policy
// ---------------------------------------------------------------------------

export function errorCard(error: GithubError, ctx: { target?: string; openUrl?: string } = {}): Widget {
  const warning = error.category === "unknown_outcome" || error.category === "production_review_required";
  const href = safeHref(ctx.openUrl);
  const body = `${header(ctx.target)}<div class="gh-err${warning ? " unk" : ""}"${error.category === "production_review_required" ? ' role="alert"' : ""}>${icon(warning ? "alert" : "stop")}<span>${titleLink(href, esc(error.title))}</span></div><div class="gh-msg">${esc(
    error.message,
  )}</div>${error.nextAction ? `<div class="gh-meta">${esc(error.nextAction)}</div>` : ""}`;
  const height = 110 + (error.message.length > 90 ? 18 : 0) + (error.nextAction ? 20 : 0);
  return render(body, height, error.title);
}

function scopeSentence(scopes: string[]): string {
  if (scopes.length === 1 && scopes[0] === "repo") return "Repo access: your public and private repositories";
  if (scopes.length === 1 && scopes[0] === "public_repo") return "Repo access: your public repositories";
  return `Scopes: ${scopes.join(", ")}`;
}

export function connectCard(input: {
  stage: "not_connected" | "connecting" | "reauth_required";
  connectUrl?: string;
  scopes: string[];
  /** A refused change's draft came back with the result. */
  draftSaved?: boolean;
}): Widget {
  const href = safeHref(input.connectUrl, true);
  const copy = {
    not_connected: { trailing: "Not connected", title: "Connect GitHub", button: "Connect GitHub", lead: "" },
    connecting: { trailing: "Waiting for browser", title: "Finish connecting in your browser", button: "Open sign-in again", lead: "" },
    reauth_required: {
      trailing: "Reconnect needed",
      title: "Reconnect GitHub",
      button: "Reconnect GitHub",
      lead: `GitHub access expired or was revoked.${input.draftSaved ? " Your draft is saved." : ""}`,
    },
  }[input.stage];
  const titleRow =
    input.stage === "connecting"
      ? `<div class="gh-wait"><span class="gh-spin" role="presentation"></span><span>${copy.title}</span></div>`
      : `<div class="gh-sub" style="font-size:15px">${copy.title}</div>`;
  const button = href
    ? `<a class="gh-btn" href="${esc(href)}">${copy.button}</a>`
    : `<div class="gh-msg">Ask again for a sign-in link.</div>`;
  const body = `${header(copy.trailing)}${titleRow}${copy.lead ? `<div class="gh-msg">${copy.lead}</div>` : ""}<div class="gh-msg">${esc(
    scopeSentence(input.scopes),
  )}</div>${button}`;
  const height = 150 + (copy.lead ? 36 : 0);
  return render(body, height, copy.title);
}

export function disconnectedCard(record: DisconnectRecord | undefined): Widget {
  const none = record?.revocation === "not_attempted";
  const confirmed = none || record?.revocation === "revoked" || record?.revocation === "already_revoked";
  const status = none
    ? "No GitHub account was connected."
    : confirmed
      ? record?.revocation === "revoked"
        ? "Composio revoked the GitHub token."
        : "The GitHub token was already revoked."
      : "VoiceOS couldn't confirm GitHub revoked the token. Remove Composio under GitHub's authorized apps to be sure.";
  const lead = none
    ? "“Use my GitHub connection” is off in Configure."
    : "VoiceOS stopped using this account.";
  const body = `${header("Disconnected")}<div class="gh-err unk">${icon("alert")}<span>GitHub is disconnected</span></div><div class="gh-msg">${lead}</div><div class="gh-meta">${status}</div>${
    confirmed ? "" : `<a class="gh-btn alt" href="https://github.com/settings/applications">GitHub authorized apps</a>`
  }`;
  return render(body, confirmed ? 130 : 170, "GitHub is disconnected");
}

/** A repeated delivery of an already-settled write: same outcome, no second mutation. */
export function replayCard(input: { owner: string; repo: string; summary: string; url?: string }): Widget {
  const body = `${header(`${input.owner}/${input.repo}`)}<div class="gh-done s-open">${icon("check")}<span>${titleLink(input.url, esc(input.summary))}</span></div><div class="gh-meta">Already done.</div>`;
  return render(body, 120, "GitHub request already done");
}
