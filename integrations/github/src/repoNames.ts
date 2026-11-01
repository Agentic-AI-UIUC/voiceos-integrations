/**
 * Repository names as people say them, and as speech recognition hears them.
 *
 * VoiceOS can't be taught repository names (its speech hints are a short,
 * static list), so "BrickWrite" can arrive as "break-write". A said name is
 * matched against real repositories in tiers, strictest first, and the first
 * tier with any match decides. More than one match is returned as is: two
 * candidates mean a question, never a guess.
 */

/** How a spoken repository name compares: case, spaces and punctuation don't count. */
export const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** True when `said` (already plain) is a run of whole words of `name`: "live check" in voiceos-github-live-check. */
export function wordRun(name: string, said: string): boolean {
  const parts = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    let joined = "";
    for (let j = i; j < parts.length && joined.length < said.length; j++) {
      joined += parts[j];
      if (joined === said) return true;
    }
  }
  return false;
}

/**
 * Roughly how a name sounds: letters that sound alike folded together, silent
 * ones dropped, and vowels after the first letter ignored, since recognition
 * mostly gets vowels wrong ("break" for "brick", "cue" for "Q").
 */
function soundKey(s: string): string {
  const folded = plain(s)
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/[cq]/g, "k")
    .replace(/x/g, "ks")
    .replace(/z/g, "s")
    .replace(/wr/g, "r")
    .replace(/wh/g, "w")
    .replace(/kn/g, "n")
    .replace(/(?!^)gh/g, "");
  return (folded.charAt(0) + folded.slice(1).replace(/[aeiouy]/g, "")).replace(/(.)\1+/g, "$1");
}

/** Edits (insert, delete, substitute, swap two neighbours) between two spellings. */
function edits(a: string, b: string): number {
  let before: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) row[j] = Math.min(row[j], before[j - 2] + 1);
    }
    before = prev;
    prev = row;
  }
  return prev[b.length];
}

const SMALL = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const NUMBER = new RegExp(`\\b(?:(${TENS.join("|")})(?:[\\s-]+(${SMALL.slice(1, 10).join("|")}))?|(${SMALL.join("|")}))\\b`, "gi");

/** Numbers as people say them and as repository names write them: "stock pulse twenty six" is stockpulse26. */
function withDigits(said: string): string {
  return said.replace(NUMBER, (_m, tens?: string, unit?: string, small?: string) =>
    small ? String(SMALL.indexOf(small.toLowerCase())) : String((TENS.indexOf(tens!.toLowerCase()) + 2) * 10 + (unit ? SMALL.indexOf(unit.toLowerCase()) : 0)),
  );
}

/** A short name has to be heard exactly; a long one may be off by a letter or two, or only in its vowels. */
function heardAs(said: string, name: string): boolean {
  if (said.length < 5) return false;
  const allowed = said.length >= 9 ? 2 : 1;
  if (Math.abs(said.length - name.length) <= allowed && edits(said, name) <= allowed) return true;
  const key = soundKey(said);
  return key.length >= 3 && key === soundKey(name);
}

/**
 * The repositories in `pool` ("owner/name") that `said` names. `guess` allows
 * the loosest tier, near spellings and sound-alikes; leave it off when the
 * pool may be missing the repository that was meant. `exactOnly` keeps only
 * the name itself, for a pool so partial that any other match could be wrong.
 */
export function matchRepository(said: string, pool: string[], opts: { guess?: boolean; exactOnly?: boolean } = {}): string[] {
  const name = (full: string) => full.slice(full.indexOf("/") + 1);
  // As said, and with its numbers as digits; each tier takes either.
  const forms = [...new Set([said, withDigits(said)])].map((s) => ({ s, words: plain(s) })).filter((f) => f.words);
  if (!forms.length) return [];
  const tiers: Array<(full: string, f: { s: string; words: string }) => boolean> = [
    (full, f) => name(full).toLowerCase() === f.s.toLowerCase(),
    (full, f) => plain(name(full)) === f.words,
    (full, f) => wordRun(name(full), f.words),
    ...(opts.guess === false ? [] : [(full: string, f: { words: string }) => heardAs(f.words, plain(name(full)))]),
  ];
  for (const tier of opts.exactOnly ? tiers.slice(0, 1) : tiers) {
    const found = pool.filter((full) => forms.some((f) => tier(full, f)));
    if (found.length) return found;
  }
  return [];
}
