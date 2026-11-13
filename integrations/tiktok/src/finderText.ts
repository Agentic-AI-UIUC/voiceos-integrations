/**
 * Matching words against file names (and other text about a file): normalization, a bounded
 * Damerau–Levenshtein distance, and the scoring find_recent_videos/find_recent_images rank by. Pure functions.
 * src/files.ts re-exports normName, editDistance and matchScore, as before.
 */

/** NFKC, and the no-break spaces macOS puts in names (U+202F before AM/PM) → a plain space. */
export function normName(s: string): string {
  return s.normalize("NFKC").replace(/[   ]/g, " ");
}

const STOP_WORDS = new Set([
  "my", "the", "a", "an", "latest", "newest", "recent", "last", "video", "videos", "clip", "clips", "file", "files", "one",
  "called", "named", "photo", "photos", "image", "images", "picture", "pictures", "screenshot", "screenshots", "of", "that", "this",
]);
/** Query words that boost rather than filter: "my latest export" means the newest file, preferring export/final/render names. */
const BOOST_WORD = /^(?:export|exports|exported|exporting|final|finals|render|renders|rendered|rendering)$/;
const BOOST_NAME = /export|final|render/;

export interface Query {
  /** Words every matching name must contain. */
  required: string[];
  /** The query mentioned export/final/render. */
  boost: boolean;
  /** Anything left after stop words. */
  meaningful: boolean;
}

export function parseQuery(query: string | undefined): Query {
  const words = normName(query ?? "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !STOP_WORDS.has(w) && !/^[a-z]$/.test(w));
  const required = words.filter((w) => !BOOST_WORD.test(w));
  return { required, boost: required.length < words.length, meaningful: words.length > 0 };
}

/** A query from words already picked out (src/finderParse.ts keywords). */
export function queryOf(words: string[], boost: boolean): Query {
  const required = words.map((w) => normName(w).toLowerCase()).filter((w) => w && !/^[a-z]$/.test(w));
  return { required, boost, meaningful: required.length > 0 || boost };
}

/**
 * Damerau–Levenshtein distance (optimal string alignment: one swap of neighbours counts as one edit), or
 * max + 1 as soon as it's sure to exceed max.
 */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const x = [...a], y = [...b];
  let prev2: number[] = [];
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) d = Math.min(d, prev2[j - 2] + 1);
      cur.push(d);
      if (d < best) best = d;
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[y.length];
}

/** A typo a query word may carry and still match a name word: none under 5 letters, 1 from 5, 2 from 9. */
const typoBudget = (w: string): number => (!/\p{L}/u.test(w) ? 0 : [...w].length >= 9 ? 2 : [...w].length >= 5 ? 1 : 0);

/** A light English stem: "cloning"/"clone"/"cloned" → "clon", "slides" → "slid". Only for words with letters. */
export function stemOf(w: string): string {
  if (!/^\p{L}+$/u.test(w) || w.length < 5) return w;
  return w.replace(/(?:ing|ed|es|s|e)$/u, "");
}

/** How one query word matched a name: a whole word, part of one (or of the name with punctuation removed), or a near spelling. */
const EXACT = 1, PART = 0.9, FUZZY = 0.6;

export interface NameScore {
  score: number;
  /** The query's words matched this text (for query_matched). */
  hit: boolean;
  /** Some word only matched as a near spelling. */
  fuzzy: boolean;
  /** Near spellings used: [query word, word in the text]. */
  near?: Array<[string, string]>;
}

/** `hit`: the query's words matched this name (for query_matched); `fuzzy`: some word only matched as a near spelling. */
export function scoreName(q: Query, name: string): NameScore {
  const hay = normName(name).toLowerCase();
  const bonus = q.boost && BOOST_NAME.test(hay) ? 0.5 : 0;
  if (!q.required.length) return { score: 1 + bonus, hit: !q.meaningful || bonus > 0, fuzzy: false };
  const compact = hay.replace(/[^\p{L}\p{N}]+/gu, "");
  const words = hay.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  // Neighbouring words joined too, so "jordans" is a whole-word match for "Jordan's".
  const tokens = new Set([...words, ...words.slice(1).map((w, i) => words[i] + w)]);
  let score = 0;
  let fuzzy = false;
  const near: Array<[string, string]> = [];
  for (const t of q.required) {
    if (tokens.has(t)) score += EXACT;
    else if (hay.includes(t) || compact.includes(t)) score += PART;
    else {
      const budget = typoBudget(t);
      // A near spelling, or the same word with another ending ("cloning" for "clone", "tokens" for "token").
      const st = stemOf(t);
      const hit = budget || st.length >= 4
        ? [...tokens].find((w) => /\p{L}/u.test(w) && ((budget && editDistance(t, w, budget) <= budget) || (st.length >= 4 && stemOf(w) === st)))
        : undefined;
      if (!hit) return { score: 0, hit: false, fuzzy: false };
      score += FUZZY;
      fuzzy = true;
      near.push([t, hit]);
    }
  }
  return { score: Math.round((score + bonus) * 100) / 100, hit: true, fuzzy, ...(near.length ? { near } : {}) };
}

/**
 * 0 = no match. Both sides are normalized (normName + lower case); the query is
 * split into words, stop words dropped ("my latest video called demo" → "demo"),
 * and every remaining word must appear in the basename: as a whole word (1),
 * inside one or in the name with punctuation removed (0.9, so "jordan" finds
 * "Jordans_trip"), or misspelled by at most one edit for a word of 5+ letters
 * and two for 9+ (0.6, so "strawbery" finds "strawberry"). Score = the sum
 * (1 when no meaningful words remain: newest wins) + 0.5 when the query says
 * export/final/render and the name contains any of them; those three words
 * boost instead of filter, so "latest export" still lists the newest files.
 */
export function matchScore(name: string, query: string): number {
  return scoreName(parseQuery(query), name).score;
}
