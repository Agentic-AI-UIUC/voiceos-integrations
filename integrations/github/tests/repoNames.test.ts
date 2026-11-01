import { describe, expect, test } from "bun:test";
import { matchRepository } from "../src/repoNames.ts";

// rishabhcli's real repositories, and the names VoiceOS's speech recognition heard for them.
const POOL = [
  "rishabhcli/BrickWrite",
  "rishabhcli/QAgent",
  "rishabhcli/StockPulse",
  "rishabhcli/voiceos-github-live-check",
  "rishabhcli/data-dive",
  "acme/happy-path",
];

describe("a repository name as it was heard", () => {
  test.each([
    ["break-write", "rishabhcli/BrickWrite"],
    ["break write", "rishabhcli/BrickWrite"],
    ["brick right", "rishabhcli/BrickWrite"],
    ["Brickwright", "rishabhcli/BrickWrite"],
    ["cue agent", "rishabhcli/QAgent"],
    ["stock pulse", "rishabhcli/StockPulse"],
    ["live check", "rishabhcli/voiceos-github-live-check"],
    ["datadive", "rishabhcli/data-dive"],
  ])("'%s' is %s", (said, repo) => {
    expect(matchRepository(said, POOL)).toEqual([repo]);
  });

  test("numbers said as words match names written with digits", () => {
    const pool = ["rishabhcli/StockPulse", "rishabhcli/stockpulse26", "rishabhcli/one-piece", "rishabhcli/IncomeStack2.0"];
    expect(matchRepository("stock pulse twenty six", pool)).toEqual(["rishabhcli/stockpulse26"]);
    expect(matchRepository("stockpulse twenty-six", pool)).toEqual(["rishabhcli/stockpulse26"]);
    expect(matchRepository("one piece", pool)).toEqual(["rishabhcli/one-piece"]);
    expect(matchRepository("income stack two", pool)).toEqual(["rishabhcli/IncomeStack2.0"]);
  });

  test("short or unrelated names match nothing", () => {
    for (const said of ["app", "qa", "website", "desktop", "brick"]) expect({ said, found: matchRepository(said, POOL) }).toEqual({ said, found: [] });
  });

  test("a name that sounds like two repositories comes back with both, never one picked", () => {
    expect(matchRepository("break-write", ["o/BrickWrite", "o/BreakRight"])).toEqual(["o/BrickWrite", "o/BreakRight"]);
  });

  test("a repository named exactly wins over its lookalikes", () => {
    expect(matchRepository("desktop", ["acme/desktops", "acme/desktop"])).toEqual(["acme/desktop"]);
  });

  test("without leave to guess, only exact, same-letter and whole-word matches count", () => {
    expect(matchRepository("break-write", POOL, { guess: false })).toEqual([]);
    expect(matchRepository("brick write", POOL, { guess: false })).toEqual(["rishabhcli/BrickWrite"]);
    expect(matchRepository("live check", POOL, { guess: false })).toEqual(["rishabhcli/voiceos-github-live-check"]);
  });
});
