/**
 * The user's own words about a video ("the vertical one from yesterday", "the 40-second screen recording",
 * "the one I downloaded from YouTube", "the second newest", "that video") → constraints find_recent_videos can
 * check against metadata. Deterministic and local: regular expressions over a normalized string, a small
 * typo-correcting vocabulary, and the Mac's local time zone for days and times of day (`now` is injected).
 *
 * Each recognised phrase is cut out of the text; whatever is left (minus filler words) becomes keywords for
 * the file name, title, tags, comment, folder and where-from host. Nothing here touches the disk.
 */
import { editDistance, normName } from "./finderText.ts";

export type Orientation = "vertical" | "landscape" | "square";
export type SourceKind = "screen_recording" | "phone" | "camera" | "airdrop" | "downloaded";
export type Quality = "4k" | "1080p" | "720p" | "hd";

export interface TimeWindow {
  from: number;
  to: number;
  /** "yesterday", "this morning", "Monday", "about 2 hours ago". */
  label: string;
  /** "added": when it arrived (downloaded, AirDropped); "either": arrived or recorded/rendered then. */
  basis: "added" | "either";
}

export interface DurationWant {
  min?: number;
  max?: number;
  /** The length the user said, for ranking by closeness. */
  target?: number;
  /** "about 40 seconds", "under a minute". */
  label: string;
}

export interface OrderWant {
  by: "added" | "duration" | "size";
  dir: "desc" | "asc";
  /** 1-based. */
  index: number;
  /** "newest", "second oldest", "longest". */
  label: string;
}

export interface Describe {
  time?: TimeWindow;
  duration?: DurationWant;
  /** "the long one" / "the short one": a preference, not a limit. */
  lengthPref?: "long" | "short";
  sizePref?: "big" | "small";
  orientation?: Orientation;
  /** Every one must hold. "camera" also accepts a phone. */
  sources: SourceKind[];
  /** Site keys (youtube, instagram, slack…): any one must hold. */
  sites: string[];
  /** App keys (capcut, finalcut, remotion…): any one must hold. */
  apps: string[];
  quality?: Quality;
  audio?: "silent" | "sound";
  order?: OrderWant;
  /** "the second one", "number 3": a position on the card the user saw (1-based). */
  listRef?: number;
  relative?: "before" | "after" | "other";
  /** it / that video / the same one / the one we just sent: the video in progress. "strong" when nothing else was said. */
  current?: "strong" | "soft";
  finder?: boolean;
  quicktime?: boolean;
  reveal?: boolean;
  /** Downloads / Desktop / Movies. */
  folders: string[];
  keywords: string[];
  /** The words export/final/render: boost names that carry them. */
  boost: boolean;
  /** "recorded", "filmed": prefer captured video (screen, phone, camera). */
  captured: boolean;
  /** What was understood, in plain words, in the order said: ["vertical", "from yesterday"]. */
  understood: string[];
  /** Typos fixed on the way: [["yesterady", "yesterday"]]. */
  corrections: Array<[string, string]>;
}

/** True when the description constrains or orders anything (keywords included). */
export function described(d: Describe): boolean {
  return Boolean(
    d.time || d.duration || d.lengthPref || d.sizePref || d.orientation || d.sources.length || d.sites.length || d.apps.length ||
      d.quality || d.audio || d.order || d.listRef || d.relative || d.current || d.finder || d.quicktime || d.keywords.length || d.boost,
  );
}

export function emptyDescribe(): Describe {
  return { sources: [], sites: [], apps: [], folders: [], keywords: [], boost: false, captured: false, understood: [], corrections: [] };
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

const MS = { min: 60_000, hour: 3_600_000, day: 86_400_000 };

export const SITES: Record<string, { label: string; words: string; hosts: string[] }> = {
  youtube: { label: "YouTube", words: "youtube|you tube|yt|youtu\\.?be", hosts: ["youtube.com", "youtu.be", "googlevideo.com", "ytimg.com"] },
  tiktok: { label: "TikTok", words: "tiktok|tik tok", hosts: ["tiktok.com", "tiktokcdn.com", "tiktokv.com", "musical.ly"] },
  instagram: { label: "Instagram", words: "instagram|insta|ig|reels?", hosts: ["instagram.com", "cdninstagram.com"] },
  twitter: { label: "X (Twitter)", words: "twitter|x\\.com|tweet", hosts: ["twitter.com", "x.com", "twimg.com", "t.co"] },
  reddit: { label: "Reddit", words: "reddit", hosts: ["reddit.com", "redd.it", "redditmedia.com"] },
  facebook: { label: "Facebook", words: "facebook|fb", hosts: ["facebook.com", "fbcdn.net", "fb.watch"] },
  vimeo: { label: "Vimeo", words: "vimeo", hosts: ["vimeo.com", "vimeocdn.com"] },
  drive: { label: "Google Drive", words: "google drive|gdrive|drive", hosts: ["drive.google.com", "googleusercontent.com", "docs.google.com"] },
  dropbox: { label: "Dropbox", words: "dropbox", hosts: ["dropbox.com", "dropboxusercontent.com"] },
  icloud: { label: "iCloud", words: "icloud", hosts: ["icloud.com", "icloud-content.com"] },
  slack: { label: "Slack", words: "slack", hosts: ["slack.com", "slack-edge.com", "slack-files.com"] },
  discord: { label: "Discord", words: "discord", hosts: ["discord.com", "discordapp.com", "discordapp.net"] },
  whatsapp: { label: "WhatsApp", words: "whatsapp|whats app", hosts: ["whatsapp.com", "whatsapp.net"] },
  telegram: { label: "Telegram", words: "telegram", hosts: ["telegram.org", "t.me"] },
  messages: { label: "Messages", words: "imessage|messages|text message", hosts: [] },
  email: { label: "email", words: "email|e mail|mail|gmail|outlook", hosts: ["mail.google.com", "outlook.live.com", "outlook.office.com"] },
  wetransfer: { label: "WeTransfer", words: "wetransfer|we transfer", hosts: ["wetransfer.com", "we.tl"] },
  loom: { label: "Loom", words: "loom", hosts: ["loom.com"] },
};

export const APPS: Record<string, { label: string; words: string }> = {
  capcut: { label: "CapCut", words: "capcut|cap cut" },
  imovie: { label: "iMovie", words: "imovie|i movie" },
  finalcut: { label: "Final Cut Pro", words: "final cut(?: pro)?|fcpx?" },
  premiere: { label: "Premiere Pro", words: "(?:adobe )?premiere(?: pro)?" },
  davinci: { label: "DaVinci Resolve", words: "davinci(?: resolve)?|da vinci(?: resolve)?|resolve" },
  quicktime: { label: "QuickTime", words: "quick ?time(?: player)?" },
  remotion: { label: "Remotion", words: "remotion" },
  ffmpeg: { label: "ffmpeg", words: "ffmpeg|lavf" },
  handbrake: { label: "HandBrake", words: "handbrake|hand brake" },
  obs: { label: "OBS", words: "obs(?: studio)?" },
  screenstudio: { label: "Screen Studio", words: "screen studio" },
  descript: { label: "Descript", words: "descript" },
  canva: { label: "Canva", words: "canva" },
  clipchamp: { label: "Clipchamp", words: "clipchamp|clip champ" },
  photobooth: { label: "Photo Booth", words: "photo ?booth" },
  aftereffects: { label: "After Effects", words: "after effects" },
  keynote: { label: "Keynote", words: "keynote" },
};

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_ABBR: Record<string, number> = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_ABBR: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, a: 1, an: 1, couple: 2, few: 3, several: 4,
};
const ORDINALS: Record<string, number> = {
  first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4, fifth: 5, "5th": 5, sixth: 6, "6th": 6,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6,
};
const ORDINAL_WORDS = "first|second|third|fourth|fifth|sixth|1st|2nd|3rd|4th|5th|6th";

/** Words the typo pass may correct to (6+ letters, so short file-name words are left alone). */
const VOCAB = [
  "yesterday", "tonight", "morning", "afternoon", "evening", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "august", "september", "october", "november", "december", "weekend", "minutes", "minute", "seconds", "second",
  "vertical", "portrait", "landscape", "horizontal", "square", "widescreen", "screen", "recording", "recorded", "airdrop", "airdropped",
  "download", "downloaded", "downloads", "desktop", "movies", "youtube", "instagram", "twitter", "iphone", "android", "camera",
  "longest", "shortest", "biggest", "largest", "smallest", "newest", "latest", "oldest", "earliest", "previous", "selected", "finder",
  "quicktime", "capcut", "imovie", "premiere", "davinci", "remotion", "handbrake", "silent", "recent", "recently", "earlier", "before",
  "another", "different", "reveal", "around", "roughly", "approximately", "longer", "shorter", "exported", "rendered",
];
const VOCAB_SET = new Set(VOCAB);
/** Common slips the edit-distance pass can't (too short, or too far). */
const SLIPS: Record<string, string> = {
  toady: "today", tody: "today", todya: "today", tdy: "today", yday: "yesterday", yest: "yesterday", ysterday: "yesterday",
  yesteday: "yesterday", tonite: "tonight", vid: "video", vids: "videos", mins: "minutes", secs: "seconds", sec: "second",
  hr: "hour", hrs: "hours", wk: "week", wks: "weeks", vert: "vertical", horiz: "horizontal", scrn: "screen", rec: "recording",
  airdroped: "airdropped", airdorpped: "airdropped", dl: "downloaded", dled: "downloaded", "dl'd": "downloaded", iphne: "iphone",
  ipone: "iphone", ihpone: "iphone", youtbue: "youtube", yotube: "youtube", youtub: "youtube",
};

/** Filler: never keywords. */
const STOP = new Set(
  (
    "a an the my me i i'm i've im ive we our us you your yours it its it's is was were be been being am are that this these those which what where who " +
    "with without from of about for to in on at by and or but nor so some any all one ones thing things stuff please pls can could would should will shall " +
    "may might must just find pick use get grab want wanna need like called named titled latest newest recent recently last there here now then ok okay " +
    "hey hi um uh er actually also again instead put add make made do did does done have has had show see look up out into onto as more most less very " +
    "really kind sort version vid vids video videos clip clips file files movie movies footage film recording recordings upload uploading uploaded post " +
    "posting posted publish send sending sent share draft drafts tiktok tiktoks inbox let lets let's go going gonna take took same other another before " +
    "after next previous earlier thanks thank yeah yes no not only which whichever whatever mine own way same got get gets tagged tag tags " +
    "labeled labelled color colour folder folders saved"
  ).split(" "),
);
const BOOST_WORD = /^(?:export|exports|exported|exporting|final|finals|render|renders|rendered|rendering)$/;

/** Filler said with a typo ("acctualli", "apost" for "a post"): the words people wrap a request in. */
const FILLER = ["actually", "instead", "please", "upload", "uploading", "publish", "posting", "drafts", "change", "switch", "rather", "wanted", "thanks", "video", "videos", "tiktok"];
function isFiller(w: string): boolean {
  if (/^an?[a-z]{3,}$/.test(w) && STOP.has(w.replace(/^an?/, ""))) return true;
  if (w.length < 5 || /\d/.test(w)) return false;
  const budget = w.length >= 9 ? 2 : 1;
  return FILLER.some((f) => f[0] === w[0] && editDistance(w, f, budget) <= budget);
}

// ---------------------------------------------------------------------------
// Local calendar helpers (the Mac's time zone)
// ---------------------------------------------------------------------------

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const addDays = (ms: number, n: number) => {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  return d.getTime();
};
const atHour = (dayStart: number, h: number) => {
  const d = new Date(dayStart);
  d.setHours(h, 0, 0, 0);
  return d.getTime();
};
/** Monday 00:00 of the week holding `ms`. */
const startOfWeek = (ms: number) => {
  const sod = startOfDay(ms);
  const dow = new Date(sod).getDay();
  return addDays(sod, -((dow + 6) % 7));
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

interface Ctx {
  s: string;
  d: Describe;
  now: number;
  /** Day the user named (for "at 9 pm" on that day). */
  day?: { from: number; to: number; label: string };
  clock?: { minutes: number; label: string; exact: boolean };
  basis: TimeWindow["basis"];
}

/** Runs `re` (global) over the working text; each hit is handed to `on` and blanked out unless `on` returns false. */
function take(c: Ctx, re: RegExp, on: (m: RegExpExecArray) => boolean | void): void {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  const rx = new RegExp(re.source, flags);
  let out = "";
  let last = 0;
  for (let m = rx.exec(c.s); m; m = rx.exec(c.s)) {
    if (m[0] === "") {
      rx.lastIndex++;
      continue;
    }
    const keep = on(m) === false;
    out += c.s.slice(last, m.index) + (keep ? m[0] : " ".repeat(m[0].length));
    last = m.index + m[0].length;
  }
  c.s = out + c.s.slice(last);
}

const say = (c: Ctx, text: string) => {
  if (!c.d.understood.includes(text)) c.d.understood.push(text);
};

/** Normalize: NFKC, lower case, curly quotes, possessives, hyphenated numbers, punctuation → spaces. */
function normalize(text: string): string {
  return ` ${normName(text)
    .toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/(\w)'s\b/g, "$1")
    .replace(/&/g, " and ")
    .replace(/(\d)\s*-\s*(?=[a-z])/g, "$1 ")
    .replace(/([a-z])-(?=[a-z])/g, "$1 ")
    .replace(/(\d),(\d{3})\b/g, "$1$2")
    .replace(/[,;!?()[\]{}"*_|<>=]+/g, " ")
    .replace(/(?<!\d)\.|\.(?!\d)/g, (m, i, s) => (/\w/.test(s[i - 1] ?? "") && /[a-z]/.test(s[i + 1] ?? "") ? m : " "))
    .replace(/\s+/g, " ")
    .trim()} `;
}

/** Fix typos word by word against the vocabulary (and a list of common slips). */
function correct(c: Ctx): void {
  c.s = c.s.replace(/[a-z][a-z']*/g, (w) => {
    const slip = SLIPS[w];
    if (slip) {
      if (slip !== w && !/^(vid|vids|mins|secs|sec|hr|hrs|wk|wks|rec|dl)$/.test(w)) c.d.corrections.push([w, slip]);
      return slip;
    }
    if (w.length < 6 || VOCAB_SET.has(w) || STOP.has(w)) return w;
    let best = "";
    let bestD = 99;
    let tie = false;
    const budget = w.length >= 9 ? 2 : 1;
    for (const v of VOCAB) {
      if (v[0] !== w[0] || Math.abs(v.length - w.length) > budget) continue;
      const dist = editDistance(w, v, budget);
      if (dist > budget) continue;
      if (dist < bestD) {
        best = v;
        bestD = dist;
        tie = false;
      } else if (dist === bestD && v !== best) tie = true;
    }
    if (!best || tie) return w;
    c.d.corrections.push([w, best]);
    return best;
  });
}

/** "forty five seconds" → "45 seconds", "a minute" → "1 minute", "two days ago" → "2 days ago". */
function numberWords(c: Ctx): void {
  c.s = c.s
    .replace(/\b(?:a |an |one )?(minute|hour) and a half\b/g, (_m, u: string) => (u === "minute" ? "90 seconds" : "90 minutes"))
    .replace(/\bhalf (?:a |an )?(minute|hour)\b/g, (_m, u: string) => (u === "minute" ? "30 seconds" : "30 minutes"))
    .replace(/\b(\d+) and a half (minutes?|hours?)\b/g, (_m, n: string, u: string) => `${n}.5 ${u}`)
    .replace(/\b(?:one|1) and a half (minutes?|hours?)\b/g, (_m, u: string) => `1.5 ${u}`);
  const word = Object.keys(NUMBER_WORDS).filter((w) => !["a", "an", "couple", "few", "several"].includes(w)).join("|");
  const unit = "(?=\\s*(?:seconds?|minutes?|hours?|days?|weeks?|months?)\\b)";
  c.s = c.s.replace(new RegExp(`\\b(${word})(?:[ -](${word}))?\\s+${unit}`, "g"), (_m, a: string, b?: string) => {
    const n = NUMBER_WORDS[a] + (b ? NUMBER_WORDS[b] : 0);
    return `${n} `;
  });
  c.s = c.s.replace(new RegExp(`\\b(?:a|an|one)\\s+${unit}`, "g"), "1 ");
  c.s = c.s.replace(new RegExp(`\\ba\\s+couple(?:\\s+of)?\\s+${unit}`, "g"), "~2 ");
  c.s = c.s.replace(new RegExp(`\\b(?:a\\s+)?few\\s+${unit}`, "g"), "~3 ");
  c.s = c.s.replace(new RegExp(`\\bseveral\\s+${unit}`, "g"), "~4 ");
}

const UNIT_RE = "(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)";
const unitSec = (u: string) => (u.startsWith("h") ? 3600 : u.startsWith("m") ? 60 : 1);

function setTime(c: Ctx, from: number, to: number, label: string): void {
  if (c.d.time) {
    // A second phrase narrows the first ("yesterday afternoon" is handled as one; "last week on Monday" intersects).
    const f = Math.max(c.d.time.from, from);
    const t = Math.min(c.d.time.to, to);
    if (f < t) c.d.time = { ...c.d.time, from: f, to: t, label: `${c.d.time.label}, ${label}` };
    return;
  }
  c.d.time = { from, to, label, basis: c.basis };
  say(c, /^(?:from|in the) |ago$/.test(label) ? label : `from ${label}`);
}

const PART: Record<string, [number, number]> = { morning: [5, 12], afternoon: [12, 17], evening: [17, 24], night: [17, 29] };

function parseTime(c: Ctx): void {
  const now = c.now;
  const sod = startOfDay(now);
  const end = now + MS.min;
  if (/\b(recorded|filmed|shot|took|taken|made|rendered|exported|created|edited|captured|filmed)\b/.test(c.s)) c.basis = "either";
  else if (/\b(downloaded|airdropped|airdrop|received|saved|added|got)\b/.test(c.s)) c.basis = "added";
  else c.basis = "either";

  // N units ago / a few hours ago / just now
  take(c, /(?<![\w~.])(~?)(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?|months?)\s+ago\b/, (m) => {
    const n = Number(m[2]);
    const approx = Boolean(m[1]);
    const u = m[3];
    if (u.startsWith("min")) {
      const tol = Math.max(10 * MS.min, n * 0.5 * MS.min) * (approx ? 2 : 1);
      setTime(c, now - n * MS.min - tol, Math.min(end, now - n * MS.min + tol), approx ? "a few minutes ago" : `about ${n} min ago`);
    } else if (u.startsWith("h")) {
      if (approx) setTime(c, now - (n + 3) * MS.hour, now - 50 * MS.min, n <= 2 ? "a couple of hours ago" : "a few hours ago");
      else {
        const tol = Math.max(45 * MS.min, n * 0.35 * MS.hour);
        setTime(c, now - n * MS.hour - tol, Math.min(end, now - n * MS.hour + tol), `about ${n} hour${n === 1 ? "" : "s"} ago`);
      }
    } else if (u.startsWith("d")) {
      const lo = approx ? n + 2 : n;
      const hi = approx ? 1 : n;
      setTime(c, addDays(sod, -lo), addDays(sod, -hi + 1), approx ? "a few days ago" : n === 1 ? "yesterday" : `${n} days ago`);
    } else if (u.startsWith("w")) {
      setTime(c, addDays(sod, -(n * 7 + 3)), addDays(sod, -(n * 7 - 4)), `about ${n} week${n === 1 ? "" : "s"} ago`);
    } else {
      setTime(c, addDays(sod, -(n * 30 + 15)), addDays(sod, -(n * 30 - 15)), `about ${n} month${n === 1 ? "" : "s"} ago`);
    }
  });
  // "just now", "I just downloaded": the newest first, not a time limit (it may have been an hour or two).
  take(c, /\b(?:just now|right now|a (?:minute|moment|second|sec) ago|moments? ago|a little while ago|a bit ago)\b|\b(?:i |we )?just (?=(?:downloaded|airdropped|recorded|exported|rendered|made|saved|got|finished|shot|filmed|took|created|edited))/, () => {
    say(c, "the newest");
  });
  take(c, /\b(?:the )?(?:past|last) (\d+|~\d+) (hours?|days?)\b/, (m) => {
    const n = Number(m[1].replace("~", ""));
    const ms = m[2].startsWith("h") ? n * MS.hour : n * MS.day;
    setTime(c, now - ms, end, `in the last ${n} ${m[2]}`);
  });
  take(c, /\b(?:in the )?(?:past|last) (hour|day|week|month)\b(?! ago)/, (m) => {
    const ms = m[1] === "hour" ? MS.hour : m[1] === "day" ? MS.day : m[1] === "week" ? 7 * MS.day : 31 * MS.day;
    // "last week" is the calendar week (below); "the past week" / "in the last week" is the last 7 days.
    if (m[1] === "week" && !/past|in the/.test(m[0])) return false;
    if (m[1] === "month" && !/past|in the/.test(m[0])) return false;
    setTime(c, now - ms, end, `in the last ${m[1]}`);
  });

  // yesterday / today + part of day; this morning; last night; tonight
  take(c, /\b(yesterday|today|this|last|tonight)(?:\s+(morning|afternoon|evening|night))?\b/, (m) => {
    const word = m[1];
    const part = m[2];
    if ((word === "this" || word === "last") && !part) return false;
    if (word === "last" && part !== "night") return false;
    if (word === "tonight" || (word === "this" && part === "night")) {
      setTime(c, atHour(sod, 17), Math.max(end, atHour(sod, 29)), "tonight");
      c.day = { from: sod, to: addDays(sod, 1), label: "today" };
      return;
    }
    if (word === "last") {
      setTime(c, atHour(addDays(sod, -1), 17), atHour(sod, 5), "last night");
      c.day = { from: addDays(sod, -1), to: sod, label: "yesterday" };
      return;
    }
    const base = word === "yesterday" ? addDays(sod, -1) : sod;
    const dayLabel = word === "yesterday" ? "yesterday" : "today";
    c.day = { from: base, to: addDays(base, 1), label: dayLabel };
    if (!part) {
      setTime(c, base, word === "today" ? end : addDays(base, 1), dayLabel);
      return;
    }
    const [h0, h1] = PART[part];
    const label = word === "this" ? `this ${part}` : part === "night" ? `${dayLabel} night` : `${dayLabel} ${part}`;
    setTime(c, atHour(base, h0), word === "yesterday" ? atHour(base, h1) : Math.max(Math.min(end, atHour(base, h1)), atHour(base, h0) + MS.min), label);
  });
  take(c, /\b(earlier(?: today)?|this (?:afternoon|evening))\b/, (m) => {
    if (m[1].startsWith("earlier")) {
      setTime(c, sod, end, "earlier today");
      c.day = { from: sod, to: addDays(sod, 1), label: "today" };
    }
  });
  // weeks, weekends, months
  take(c, /\b(this|last|past) (week|weekend|month)\b/, (m) => {
    const sow = startOfWeek(now);
    if (m[2] === "week") {
      if (m[1] === "this") setTime(c, sow, end, "this week");
      else setTime(c, addDays(sow, -7), sow, "last week");
    } else if (m[2] === "weekend") {
      const dow = new Date(sod).getDay();
      // The weekend holding today (Sat/Sun), else the one just gone.
      const sat = dow === 6 ? sod : dow === 0 ? addDays(sod, -1) : addDays(sod, -((dow + 1) % 7));
      const from = m[1] === "this" ? sat : dow === 6 || dow === 0 ? addDays(sat, -7) : sat;
      setTime(c, from, Math.min(end, addDays(from, 2)), m[1] === "this" ? "this weekend" : "last weekend");
    } else {
      const d = new Date(sod);
      const first = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
      if (m[1] === "this") setTime(c, first, end, "this month");
      else setTime(c, new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime(), first, "last month");
    }
  });
  // weekdays: "on Monday", "last Tuesday", "Monday morning"
  const wd = [...WEEKDAYS, ...Object.keys(WEEKDAY_ABBR)].join("|");
  take(c, new RegExp(`\\b(?:(?:on|last|this|past) )?(${wd})(?:\\s+(morning|afternoon|evening|night))?\\b`), (m) => {
    const name = m[1];
    const target = WEEKDAYS.includes(name) ? WEEKDAYS.indexOf(name) : WEEKDAY_ABBR[name];
    // "sat" / "sun" alone are too ambiguous unless introduced.
    if (!WEEKDAYS.includes(name) && !/^(on|last|this|past) /.test(m[0])) return false;
    const dow = new Date(sod).getDay();
    let back = (dow - target + 7) % 7;
    if (back === 0 && !/^this /.test(m[0])) back = 7;
    const day = addDays(sod, -back);
    const label = cap(WEEKDAYS[target]);
    c.day = { from: day, to: addDays(day, 1), label };
    if (m[2]) {
      const [h0, h1] = PART[m[2]];
      setTime(c, atHour(day, h0), atHour(day, h1), `${label} ${m[2]}`);
    } else setTime(c, day, Math.min(addDays(day, 1), end), label);
  });
  // dates: "November 3", "Nov 3rd", "3rd of November", "11/3"
  const mo = [...MONTHS, ...Object.keys(MONTH_ABBR)].join("|");
  const dateOf = (month: number, dayN: number, year?: number): number | undefined => {
    if (!(dayN >= 1 && dayN <= 31)) return undefined;
    const y = year ?? new Date(now).getFullYear();
    let t = new Date(y, month, dayN).getTime();
    if (year === undefined && t > now) t = new Date(y - 1, month, dayN).getTime();
    return new Date(t).getMonth() === month ? t : undefined;
  };
  const monthIndex = (w: string) => (MONTHS.includes(w) ? MONTHS.indexOf(w) : MONTH_ABBR[w]);
  const dateLabel = (t: number) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  take(c, new RegExp(`\\b(?:on )?(${mo}) (\\d{1,2})(?:st|nd|rd|th)?(?: (20\\d\\d))?\\b`), (m) => {
    const t = dateOf(monthIndex(m[1]), Number(m[2]), m[3] ? Number(m[3]) : undefined);
    if (t === undefined) return false;
    c.day = { from: t, to: addDays(t, 1), label: dateLabel(t) };
    setTime(c, t, addDays(t, 1), dateLabel(t));
  });
  take(c, new RegExp(`\\b(?:on )?(?:the )?(\\d{1,2})(?:st|nd|rd|th)? of (${mo})(?: (20\\d\\d))?\\b`), (m) => {
    const t = dateOf(monthIndex(m[2]), Number(m[1]), m[3] ? Number(m[3]) : undefined);
    if (t === undefined) return false;
    c.day = { from: t, to: addDays(t, 1), label: dateLabel(t) };
    setTime(c, t, addDays(t, 1), dateLabel(t));
  });
  take(c, /\b(?:on )?(1[0-2]|0?[1-9])\/(3[01]|[12]\d|0?[1-9])(?:\/(20\d\d|\d\d))?\b/, (m) => {
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : undefined;
    const t = dateOf(Number(m[1]) - 1, Number(m[2]), y);
    if (t === undefined) return false;
    c.day = { from: t, to: addDays(t, 1), label: dateLabel(t) };
    setTime(c, t, addDays(t, 1), dateLabel(t));
  });
  // time of day: "at 9 pm", "around 9:07", "9pm"
  take(c, /\b(at|around|about|from|by)? ?(1[0-2]|0?[1-9]|1[3-9]|2[0-3])(?:[:.]([0-5]\d))? ?(am|pm|a\.m|p\.m|in the morning|in the evening|at night|o'?clock)\b/, (m) => {
    let h = Number(m[2]);
    const min = m[3] ? Number(m[3]) : 0;
    const mer = m[4];
    if (/^p|evening|night/.test(mer) && h < 12) h += 12;
    if (/^a|morning/.test(mer) && h === 12) h = 0;
    c.clock = { minutes: h * 60 + min, label: `${((h + 11) % 12) + 1}${m[3] ? `:${m[3]}` : ""} ${h < 12 ? "AM" : "PM"}`, exact: Boolean(m[3]) };
  });
  take(c, /\b(at|around) (1[0-9]|2[0-3]|0?[0-9])[:.]([0-5]\d)\b/, (m) => {
    const h = Number(m[2]);
    c.clock = { minutes: h * 60 + Number(m[3]), label: `${((h + 11) % 12) + 1}:${m[3]} ${h < 12 ? "AM" : "PM"}`, exact: true };
  });
  if (c.clock) {
    const tol = (c.clock.exact ? 15 : 45) * MS.min;
    let day = c.day ?? { from: sod, to: addDays(sod, 1), label: "today" };
    let at = day.from + c.clock.minutes * MS.min;
    if (!c.day && at - tol > now) {
      day = { from: addDays(sod, -1), to: sod, label: "yesterday" };
      at = day.from + c.clock.minutes * MS.min;
    }
    const label = `${day.label === "today" ? "" : `${day.label} `}around ${c.clock.label}`.trim();
    // The clock narrows the day the user named, or stands alone.
    if (c.d.time) c.d.time = { ...c.d.time, from: Math.max(c.d.time.from, at - tol), to: Math.min(c.d.time.to, at + tol), label };
    else setTime(c, at - tol, at + tol, label);
    const i = c.d.understood.findIndex((u) => /^from /.test(u));
    if (i >= 0) c.d.understood[i] = `from ${label}`;
  }
}

function setDuration(c: Ctx, w: DurationWant): void {
  if (!c.d.duration) {
    c.d.duration = w;
    say(c, w.label);
  }
}

const fmtSec = (s: number) => {
  if (s < 60) return `${Math.round(s)} seconds`;
  const m = s / 60;
  if (Number.isInteger(m)) return `${m} minute${m === 1 ? "" : "s"}`;
  const whole = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  return rest ? `${whole}:${String(rest).padStart(2, "0")}` : `${whole} minutes`;
};

function parseDuration(c: Ctx): void {
  const APPROX = "(?:about|around|roughly|approximately|approx|~|like|nearly|almost|close to|maybe|circa)";
  const UNDER = "(?:under|less than|shorter than|below|at most|max|maximum|no more than|no longer than|within|up to|not more than)";
  const OVER = "(?:over|more than|longer than|above|at least|min|minimum|no less than|no shorter than|not less than)";
  const want = (sec: number, how: "exact" | "approx" | "under" | "over"): DurationWant => {
    if (how === "under") return { max: sec, label: `under ${fmtSec(sec)}` };
    if (how === "over") return { min: sec, label: `over ${fmtSec(sec)}` };
    const tol = how === "approx" ? Math.max(5, sec * 0.25) : Math.max(3, sec * 0.12);
    return { min: Math.max(0, sec - tol), max: sec + tol, target: sec, label: `${how === "approx" ? "about " : ""}${fmtSec(sec)} long` };
  };
  const howOf = (pre?: string, post?: string): "exact" | "approx" | "under" | "over" => {
    if (pre && new RegExp(`^${UNDER}$`).test(pre)) return "under";
    if (pre && new RegExp(`^${OVER}$`).test(pre)) return "over";
    if (post && /^(?:or less|or shorter|max|tops|at most)$/.test(post)) return "under";
    if (post && /^(?:or more|or longer|plus|\+)$/.test(post)) return "over";
    if ((pre && new RegExp(`^${APPROX}$`).test(pre)) || (post && /^(?:ish|or so|give or take)$/.test(post))) return "approx";
    return "exact";
  };
  // between 30 and 60 seconds
  take(c, new RegExp(`\\bbetween (\\d+(?:\\.\\d+)?) ?${UNIT_RE}? (?:and|to|-) (\\d+(?:\\.\\d+)?) ?${UNIT_RE}\\b`), (m) => {
    const u2 = unitSec(m[4]);
    const a = Number(m[1]) * (m[2] ? unitSec(m[2]) : u2);
    const b = Number(m[3]) * u2;
    setDuration(c, { min: Math.min(a, b), max: Math.max(a, b), target: (a + b) / 2, label: `${fmtSec(Math.min(a, b))} to ${fmtSec(Math.max(a, b))}` });
  });
  take(c, new RegExp(`\\b(?:(${APPROX}|${UNDER}|${OVER}) )?(?:a )?(an hour|hour long)( ish| or so| or less| or more| max| tops)?\\b`), (m) => {
    const sec = 3600;
    setDuration(c, want(sec, howOf(m[1], m[3]?.trim())));
  });
  // 1:12 (not a time of day)
  take(c, new RegExp(`\\b(?:(${APPROX}|${UNDER}|${OVER}) )?(\\d{1,2}):([0-5]\\d)\\b(?! ?(?:am|pm|a\\.m|p\\.m))( ?ish| or so| or less| or more)?`), (m) => {
    const before = c.s.slice(Math.max(0, m.index - 4), m.index);
    if (/\bat $/.test(before)) return false;
    setDuration(c, want(Number(m[2]) * 60 + Number(m[3]), howOf(m[1], m[4]?.trim())));
  });
  // 40 seconds, 2 min, 1.5 minutes, 1 minute 12 seconds, 40s, 40 sec long
  take(
    c,
    new RegExp(`(?<![\\w.])(?:(${APPROX}|${UNDER}|${OVER}) )?(~?\\d+(?:\\.\\d+)?) ?${UNIT_RE}(?: (?:and )?(\\d+) ?(seconds?|secs?|s))?\\b(?: ?(ish|or so|or less|or more|or shorter|or longer|max|tops|plus|give or take))?(?: long)?`),
    (m) => {
      const approxNum = m[2].startsWith("~");
      const n = Number(m[2].replace("~", ""));
      if (!Number.isFinite(n) || n <= 0) return false;
      const u = m[3];
      // "4 k" isn't here; a lone "m"/"s"/"h" needs digits glued to it ("40s"), not "the 2 s…".
      if (/^[smh]$/.test(u) && /\d [smh]\b/.test(m[0])) return false;
      let sec = n * unitSec(u);
      if (m[4]) sec += Number(m[4]);
      const how = approxNum ? "approx" : howOf(m[1], m[6]);
      setDuration(c, want(sec, how));
    },
  );
  // a few seconds long / a couple of minutes long
  take(c, /\b(?:just |only )?a (few|couple of|couple) (seconds|minutes)(?: long)?\b/, (m) => {
    const unit = m[2] === "seconds" ? 1 : 60;
    const n = m[1] === "few" ? 3 : 2;
    setDuration(c, { min: unit === 1 ? 0 : n * 60 * 0.5, max: unit === 1 ? 12 : n * 60 * 1.6, target: n * unit, label: `a ${m[1]} ${m[2]} long` });
  });
}

function setOrder(c: Ctx, o: OrderWant): void {
  if (!c.d.order) {
    c.d.order = o;
    say(c, o.label);
  }
}

function parseOrder(c: Ctx): void {
  const SUPER: Record<string, [OrderWant["by"], OrderWant["dir"], string]> = {
    newest: ["added", "desc", "newest"], latest: ["added", "desc", "newest"], "most recent": ["added", "desc", "newest"], recent: ["added", "desc", "newest"],
    oldest: ["added", "asc", "oldest"], earliest: ["added", "asc", "oldest"], longest: ["duration", "desc", "longest"], shortest: ["duration", "asc", "shortest"],
    biggest: ["size", "desc", "biggest"], largest: ["size", "desc", "biggest"], heaviest: ["size", "desc", "biggest"], smallest: ["size", "asc", "smallest"],
    tiniest: ["size", "asc", "smallest"], lightest: ["size", "asc", "smallest"],
  };
  const sup = Object.keys(SUPER).join("|");
  const ordinalLabel = (n: number, base: string) => `${["", "", "second", "third", "fourth", "fifth", "sixth"][n] ?? `${n}th`} ${base}`;
  // "second newest", "3rd oldest", "next newest"
  take(c, new RegExp(`\\b(${ORDINAL_WORDS}|next) (${sup}|most recent)\\b`), (m) => {
    const n = m[1] === "next" ? 2 : ORDINALS[m[1]];
    const [by, dir, base] = SUPER[m[2]];
    setOrder(c, { by, dir, index: n, label: n === 1 ? base : ordinalLabel(n, base) });
  });
  // "second to last", "one before the latest"
  take(c, new RegExp(`\\b(${ORDINAL_WORDS}) to last\\b`), (m) => {
    const n = ORDINALS[m[1]];
    setOrder(c, { by: "added", dir: "desc", index: n, label: ordinalLabel(n, "newest") });
  });
  take(c, /\b(?:the )?(?:very )?last (?:one|video|clip|file|recording|thing|export|render)\b/, (m) => {
    // "the last export" keeps its boost word for the keyword pass.
    const boost = /export|render/.exec(m[0]);
    setOrder(c, { by: "added", dir: "desc", index: 1, label: "newest" });
    if (boost) c.d.boost = true;
  });
  take(c, /\b(?:the )?(?:one|video|clip) before the (?:latest|newest|last|most recent)(?: one)?\b/, () => setOrder(c, { by: "added", dir: "desc", index: 2, label: "second newest" }));
  // longer/shorter/bigger one (comparative used as "the longer one")
  take(c, /\bthe (longer|shorter|bigger|larger|smaller) (?:one|video|clip)\b/, (m) => {
    const [by, dir, base] = SUPER[{ longer: "longest", shorter: "shortest", bigger: "biggest", larger: "biggest", smaller: "smallest" }[m[1]]!];
    setOrder(c, { by, dir, index: 1, label: base });
  });
  take(c, new RegExp(`\\b(${sup})\\b`), (m) => {
    const [by, dir, base] = SUPER[m[1]];
    // "newest"/"latest"/"recent" are the default order: noted only.
    if (by === "added" && dir === "desc") {
      setOrder(c, { by, dir, index: 1, label: base });
      return;
    }
    setOrder(c, { by, dir, index: 1, label: base });
  });
}

function parseRefs(c: Ctx): void {
  // relative to the video in progress
  take(c, /\b(?:the )?(?:one |video |clip )?(?:right )?before (?:that|this|it)(?: one)?\b|\b(?:the )?previous (?:one|video|clip)\b|\b(?:an? )?older one\b|\bone before\b/, () => {
    c.d.relative = "before";
    say(c, "the one before that");
  });
  take(c, /\b(?:the )?(?:one |video |clip )?(?:right )?after (?:that|this|it)(?: one)?\b|\b(?:the )?next (?:one|video|clip)\b|\b(?:a )?newer one\b/, () => {
    c.d.relative = "after";
    say(c, "the one after that");
  });
  take(c, /\b(?:the )?other (?:one|video|clip|file)\b|\bthe other\b|\b(?:an|a )?other one\b|\banother one\b|\ba different (?:one|video|clip)\b|\bdifferent one\b|\bnot (?:that|this|the same) one\b|\bsomething else\b/, () => {
    c.d.relative = "other";
    say(c, "the other one");
  });
  // a position on the card: "the second one", "number 3", "#2", "option two", "the top one"
  take(c, new RegExp(`\\b(?:the )?(${ORDINAL_WORDS}) (?:one|video|clip|option|choice|thumbnail|poster|result|file)\\b`), (m) => {
    c.d.listRef = ORDINALS[m[1]];
    say(c, `number ${c.d.listRef} on the card`);
  });
  take(c, /(?:\b(?:number|no|option|choice|video|clip)|#) ?(\d|one|two|three|four|five|six)\b/, (m) => {
    const n = ORDINALS[m[1]];
    if (!n) return false;
    c.d.listRef = n;
    say(c, `number ${n} on the card`);
  });
  take(c, /\bthe top one\b/, () => {
    c.d.listRef = 1;
    say(c, "number 1 on the card");
  });
  take(c, new RegExp(`\\bthe (${ORDINAL_WORDS})\\s*$`), (m) => {
    c.d.listRef = ORDINALS[m[1]];
    say(c, `number ${c.d.listRef} on the card`);
  });
  // "the first one I recorded today" with a time: the earliest in that window
  if (c.d.listRef === 1 && c.d.time && !c.d.order) {
    c.d.listRef = undefined;
    c.d.understood = c.d.understood.filter((u) => u !== "number 1 on the card");
    setOrder(c, { by: "added", dir: "asc", index: 1, label: "first" });
  }
}

function parseApps(c: Ctx): void {
  // Finder: reveal ("show it in Finder") before selection ("the one selected in Finder")
  // Only the verb and "in Finder" go: "show me that video in Finder" keeps "that video" (the one in progress).
  let reveal = false;
  take(c, /\b(?:show|reveal|open|find|locate|highlight|point to)(?:\s+me)?\b(?=(?:\s+[^\s]+){0,5}?\s+(?:in|on)\s+(?:the\s+)?(?:finder|file explorer|windows explorer)\b)|\breveal\b|\bwhere(?:'s| is| did)\b(?=\s+(?:it|that|this|the)\b)|\bopen (?:the|its|that) (?:folder|location)\b|\bshow me where\b/, () => {
    reveal = true;
  });
  if (reveal) {
    take(c, /\b(?:in|on)\s+(?:the\s+)?(?:finder|file explorer|windows explorer)\b|\b(?:saved|stored|located|go|live)\s*$/, () => {});
    c.d.reveal = true;
    say(c, "show it in Finder");
  }
  take(c, /\b(?:(?:i(?:'ve| have)?|i've got|i got) )?(?:selected|highlighted|clicked(?: on)?)(?: (?:in|on) (?:the )?finder)?\b|\b(?:in|on) (?:the )?(?:finder|file explorer|windows explorer)\b|\b(?:finder|file explorer|windows explorer) selection\b|\bthe selection\b|\bselected (?:one|video|file)\b/, () => {
    c.d.finder = true;
    say(c, "selected in Finder");
  });
  // QuickTime: what's open in it, unless it's how the video was made
  const made = /\b(?:made|edited|exported|created|rendered|recorded|saved|produced|cut|trimmed|done) (?:in|with|on|using|through|from|by) quick ?time\b|\bquick ?time (?:export|recording|render)\b/;
  if (!made.test(c.s)) {
    take(c, /\b(?:(?:that'?s|that is|which is|currently|is|i have|i've got|i got)\s+)?(?:open|opened|playing|showing|paused|up|loaded)?\s*(?:in|on)\s+quick ?time(?: player)?\b|\bquick ?time(?: player)? (?:window|has|is (?:showing|playing|open))\b/, () => {
      c.d.quicktime = true;
      say(c, "open in QuickTime");
    });
  }
}

function parseSources(c: Ctx): void {
  const addSource = (k: SourceKind, label: string) => {
    if (!c.d.sources.includes(k)) c.d.sources.push(k);
    say(c, label);
  };
  take(c, /\bscreen ?(?:recordings?|recorded|records?|rec|captures?|cap|casts?|grabs?|videos?)\b|\bscreencasts?\b|\brecord(?:ed|ing)? (?:of )?(?:my|the) screen\b/, () => addSource("screen_recording", "screen recording"));
  // folders before "downloaded": the Downloads folder is a place, a download is a source
  take(c, /\b(?:(?:in|from|on|inside|under|out of) )?(?:my |the )?(downloads?|desktop|movies)(?: folder)?\b/, (m) => {
    const f = m[1].startsWith("download") ? "Downloads" : m[1] === "desktop" ? "Desktop" : "Movies";
    // "my movies" without a preposition or "folder" is just "my videos".
    if (f === "Movies" && !/^(in|from|on|inside|under|out of) |folder$/.test(m[0].trim())) return;
    if (f === "Downloads" && m[1] === "download" && !/folder/.test(m[0])) return false;
    if (!c.d.folders.includes(f)) c.d.folders.push(f);
    say(c, `in ${f}`);
  });
  take(c, /\bair ?drop(?:ped|ed|s)?\b/, () => addSource("airdrop", "AirDropped"));
  take(c, /\b(?:i ?phone|iphone|android|pixel|galaxy|samsung)\b|\b(?:my|the|from|on|with) (?:cell ?)?phone\b|\bphone (?:video|clip|recording)\b/, () => addSource("phone", "from a phone"));
  take(c, /\b(?:my |the |a )?(?:camera|cam|gopro|go pro|dslr|mirrorless|drone|insta ?360)\b/, () => addSource("camera", "from a camera"));
  // sites: "downloaded from YouTube", "the YouTube one", "from Slack"
  for (const [key, site] of Object.entries(SITES)) {
    const re = new RegExp(`\\b(?:(?:downloaded|saved|grabbed|ripped|pulled|got|received|sent)(?: it)? (?:from|off|on|via|in|through) |(?:from|off|via) )?(?:${site.words})\\b(?: (?:download|video|clip|one|link|rip))?`);
    take(c, re, (m) => {
      const said = m[0].trim();
      // "upload to TikTok" / "post it on TikTok" / "TikTok draft" aren't about where it came from.
      if (key === "tiktok" && !/^(downloaded|saved|grabbed|ripped|pulled|got|received|from|off|via)\b|download|rip$/.test(said)) return;
      // "drive", "mail", "reels", "ig", "fb" alone are too loose without a preposition.
      if (/^(drive|mail|reels?|ig|fb|messages|loom|tweet)$/.test(said)) return false;
      if (!c.d.sites.includes(key)) c.d.sites.push(key);
      if (!c.d.sources.includes("downloaded") && key !== "messages") c.d.sources.push("downloaded");
      say(c, `from ${site.label}`);
    });
  }
  // From a website or browser only when one is named ("from YouTube" above, "off Safari", "from the internet").
  take(c, /\b(?:downloaded |saved |got it |grabbed )?(?:from|off|in|with|via|on|using) (?:safari|chrome|google chrome|firefox|arc|brave|edge|opera|the browser)\b|\b(?:from|off) the (?:internet|web)\b|\bonline\b/, () =>
    addSource("downloaded", "downloaded from a website"),
  );
  // "the one I downloaded" (no site named) means the Downloads folder, newest first.
  take(c, /\b(?:i |we )?(?:downloaded|downloading|download|dowloaded|donwloaded)\b/, () => {
    if (c.d.sources.includes("downloaded")) return;
    if (!c.d.folders.includes("Downloads")) c.d.folders.push("Downloads");
    say(c, "in Downloads");
  });
  // apps: "made in CapCut", "the CapCut export", "Final Cut"
  for (const [key, app] of Object.entries(APPS)) {
    const re = new RegExp(`\\b(?:(?:made|edited|exported|created|rendered|cut|built|done|recorded|saved|produced|trimmed)(?: it)? (?:in|with|on|using|through|from|by) )?(?:${app.words})\\b`);
    take(c, re, (m) => {
      // "resolve" alone is an ordinary word.
      if (key === "davinci" && m[0].trim() === "resolve") return false;
      if (!c.d.apps.includes(key)) c.d.apps.push(key);
      say(c, `made in ${app.label}`);
    });
  }
  take(c, /\b(?:i )?(?:recorded|filmed|shot|took|captured)\b/, () => {
    c.d.captured = true;
  });
}

/** long/short/big/small as preferences ("the long landscape clip", "the short one"), not "a short about AI". */
function parsePrefs(c: Ctx): void {
  const NOUN = "(?:one|ones|video|videos|clip|clips|vid|recording|movie|file|version)";
  const LOOK = "(?:vertical|portrait|landscape|horizontal|square|screen|4k|hd|iphone|phone)";
  take(c, new RegExp(`\\b(?:really |very |pretty |super |quite )?(long|lengthy|short|quick|brief)(?=\\s+(?:${LOOK}\\s+)?${NOUN}\\b)|\\b(?:really |very |super )(long|short)\\b|\\b(long|short)\\s*$`), (m) => {
    const w = m[1] ?? m[2] ?? m[3];
    c.d.lengthPref = w === "long" || w === "lengthy" ? "long" : "short";
    say(c, c.d.lengthPref === "long" ? "long" : "short");
  });
  take(c, new RegExp(`\\b(?:really |very |pretty |super )?(big|large|huge|heavy|small|tiny|little)(?=\\s+(?:${LOOK}\\s+)?${NOUN}\\b)`), (m) => {
    c.d.sizePref = /big|large|huge|heavy/.test(m[1]) ? "big" : "small";
    say(c, c.d.sizePref === "big" ? "big file" : "small file");
  });
}

function parseLooks(c: Ctx): void {
  take(c, /\b(vertical|portrait|tall|upright|9 ?[:x/] ?16|9 by 16|phone shaped)\b/, () => {
    c.d.orientation ??= "vertical";
    say(c, "vertical");
  });
  take(c, /\b(landscape|horizontal|wide|widescreen|sideways|16 ?[:x/] ?9|16 by 9)\b/, () => {
    c.d.orientation ??= "landscape";
    say(c, "landscape");
  });
  take(c, /\b(square|1 ?[:x] ?1)\b/, () => {
    c.d.orientation ??= "square";
    say(c, "square");
  });
  take(c, /\b(4 ?k|uhd|ultra ?hd|2160p?)\b/, () => {
    c.d.quality ??= "4k";
    say(c, "4K");
  });
  take(c, /\b(1080p?|full ?hd|fhd)\b/, () => {
    c.d.quality ??= "1080p";
    say(c, "1080p");
  });
  take(c, /\b(720p?)\b/, () => {
    c.d.quality ??= "720p";
    say(c, "720p");
  });
  take(c, /\bhd\b/, () => {
    c.d.quality ??= "hd";
    say(c, "HD");
  });
  take(c, /\b(?:no|without|zero|missing|with no) (?:sound|audio|music|voice)\b|\b(?:silent|muted|mute|soundless)\b/, () => {
    c.d.audio ??= "silent";
    say(c, "no sound");
  });
  take(c, /\b(?:with|has|have|got) (?:sound|audio|music|voice ?over|voice|narration)\b|\b(?:sound|audio) on\b/, () => {
    c.d.audio ??= "sound";
    say(c, "with sound");
  });
}

function parseCurrent(c: Ctx): void {
  let hit = false;
  take(
    c,
    /\b(?:the )?same (?:one|video|clip|file)\b|\bthe same\b|\b(?:that|this) (?:one|video|clip|file|recording)\b|\bthe (?:one|video|clip) (?:we|you|i) (?:just )?(?:sent|posted|uploaded|drafted|used|picked|chose|found|showed|talked about|were (?:talking|working) (?:about|on)|was (?:talking|working) (?:about|on))\b|\b(?:we|you|i) (?:just )?(?:sent|posted|uploaded|drafted)\b|\bthe (?:one|video) from before\b|\b(?:the )?(?:current|in progress) (?:one|video)\b|\bthe one in progress\b|\bit\b|\bthat\b|\bthis\b|\bsame\b/,
    () => {
      hit = true;
    },
  );
  if (hit) c.d.current = "soft";
}

/**
 * Parses up to 160 characters of the user's description. `now` is epoch ms; days, mornings and "at 9 pm" use
 * the process's local time zone (the Mac's).
 */
export function parseDescribe(text: string | undefined, now: number): Describe {
  const d = emptyDescribe();
  const raw = String(text ?? "").slice(0, 160);
  if (!raw.trim()) return d;
  const c: Ctx = { s: normalize(raw), d, now, basis: "either" };
  correct(c);
  numberWords(c);
  parseApps(c); // reveal / Finder / QuickTime first: they carry "in Finder", "in QuickTime"
  parseTime(c);
  parseDuration(c);
  parsePrefs(c);
  parseOrder(c);
  parseRefs(c);
  parseSources(c);
  parseLooks(c);
  parseCurrent(c);
  if (d.relative && d.current) d.current = undefined;
  // Leftovers: keywords (boost words boost; filler goes)
  const words = c.s
    .split(/[^\p{L}\p{N}.'+-]+/u)
    .map((w) => w.replace(/^[.'+-]+|[.'+-]+$/g, ""))
    .filter((w) => w && !STOP.has(w) && !/^[a-z]$/.test(w) && !/^~/.test(w));
  for (const w of words) {
    if (isFiller(w)) continue;
    if (BOOST_WORD.test(w)) d.boost = true;
    else if (!d.keywords.includes(w)) d.keywords.push(w);
  }
  if (d.boost) say(c, "an export");
  if (d.keywords.length) say(c, `named like "${d.keywords.join(" ")}"`);
  if (d.current) {
    // "that vid I downloaded": a folder said too makes "that" a hint, not a reference.
    const other = described({ ...d, current: undefined, reveal: undefined }) || d.folders.length > 0;
    d.current = other ? "soft" : "strong";
    if (d.current === "strong") say(c, "the video in progress");
  }
  return d;
}
