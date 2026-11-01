import { describe, expect, test } from "bun:test";
import { SearchMemory, repositoryQuery } from "../src/search.ts";

describe("search continuation boundaries", () => {
  test("cursors are scoped to the tool and account, expire, and replay the same slice", () => {
    let now = 1000;
    const memory = new SearchMemory(() => now);
    const snapshot = memory.save("search_repositories", "account-one", { q: "user:acme", page: 1, per_page: 10 }, { total_count: 10, items: Array.from({ length: 10 }, (_, id) => ({ id })) });
    const cursor = memory.slice(snapshot).next!.arguments.cursor;
    for (let n = 0; n < 2; n++) {
      const next = memory.resume("search_repositories", "account-one", cursor);
      expect(memory.slice(next.snapshot, next.offset).items.map((x) => x.id)).toEqual([5, 6, 7, 8, 9]);
    }
    expect(() => memory.resume("search_code", "account-one", cursor)).toThrow("expired or belongs");
    expect(() => memory.resume("search_repositories", "account-two", cursor)).toThrow("expired or belongs");
    now += 600_001;
    expect(() => memory.resume("search_repositories", "account-one", cursor)).toThrow("expired or belongs");
  });

  test("the last search page cannot display or continue beyond result 1,000", () => {
    const memory = new SearchMemory(() => 1);
    const snapshot = memory.save("search_code", "one", { q: "token", page: 34, per_page: 30 }, { total_count: 4000, items: Array.from({ length: 30 }, (_, id) => ({ id })) });
    let page = memory.slice(snapshot);
    expect(page.display).toEqual({ start: 991, end: 995, count: 5 });
    const next = memory.resume("search_code", "one", page.next!.arguments.cursor);
    page = memory.slice(next.snapshot, next.offset);
    expect(page.display).toEqual({ start: 996, end: 1000, count: 5 });
    expect(page.next).toBeUndefined();
  });

  test("malformed upstream searches cannot masquerade as empty results", () => {
    const memory = new SearchMemory(() => 1);
    for (const data of [{}, { items: [], total_count: -1 }, { total_count: 0 }, { items: "not an array", total_count: 0 }]) {
      expect(() => memory.save("search_code", "one", { q: "x", page: 1, per_page: 5 }, data)).toThrow("could not read");
    }
  });

  test("fork intent preserves other qualifiers and never silently contradicts them", () => {
    expect(repositoryQuery("user:acme language:python", true)).toBe("user:acme language:python fork:true");
    expect(repositoryQuery("user:acme is:private fork:true", true)).toBe("user:acme is:private fork:true");
    expect(repositoryQuery("user:acme fork:only")).toBe("user:acme fork:only");
    expect(repositoryQuery("user:acme", false)).toBe("user:acme fork:false");
    expect(() => repositoryQuery("user:acme fork:false", true)).toThrow("conflicts");
  });

  test("plain fork and next-page follow-ups retain ordering when the model omits it", () => {
    const memory = new SearchMemory(() => 1000);
    const args = { q: "user:acme language:python", sort: "updated", order: "desc", page: 1, per_page: 5 };
    memory.slice(memory.save("search_repositories", "one", args, { total_count: 20, items: Array.from({ length: 5 }, (_, id) => ({ id })) }));
    const forks = memory.inherit("search_repositories", "one", { q: "language:python fork:true user:acme", page: 1, per_page: 5 });
    expect(forks).toMatchObject({ sort: "updated", order: "desc" });
    memory.slice(memory.save("search_repositories", "one", forks, { total_count: 20, items: Array.from({ length: 5 }, (_, id) => ({ id })) }));
    expect(memory.inherit("search_repositories", "one", { q: "user:acme language:python fork:true", page: 2, per_page: 5 })).toMatchObject({ sort: "updated", order: "desc" });
    for (const q of ["user:globex language:python fork:true", "user:acme language:rust fork:true", "user:acme language:python is:private fork:true"]) {
      expect(memory.inherit("search_repositories", "one", { q, page: 2, per_page: 5 }).sort).toBeUndefined();
    }
    expect(memory.inherit("search_repositories", "one", { q: forks.q, page: 2, sort: "stars", order: "asc" })).toMatchObject({ sort: "stars", order: "asc" });
  });
});
