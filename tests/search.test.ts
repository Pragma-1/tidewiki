import "./setup-env";
import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createPage, deletePage, updatePage } from "@/lib/pages";
import { fold, globMatch, markdownToPlain, parseQuery, search, type Segment } from "@/lib/search";

const join = (segs: Segment[]) => segs.map((s) => s.t).join("");
const hits = (segs: Segment[]) => segs.filter((s) => s.hit).map((s) => s.t);
const slugs = (q: string) =>
  search(q, { limit: 100 })
    .hits.map((h) => h.slug)
    .sort();

describe("search", () => {
  const uid = (() => {
    const t = Math.floor(Date.now() / 1000);
    return Number(
      db()
        .prepare(
          "INSERT INTO users(username,email,password_hash,role,created_at,password_changed_at) VALUES('s','s@example.com','x','admin',?,?)",
        )
        .run(t, t).lastInsertRowid,
    );
  })();
  const mk = (title: string, content: string) => createPage({ title, content, parentId: null, userId: uid });
  mk("Bitte lesen", "Hier stehen wichtige Inhalte. Der Text ist kurz.");
  mk("Straßenbau", "Planung für die neue Straße am Hafen. Tests folgen.");
  mk("Zeitplan", "Termine: Testlauf am Montag, Taust ist kein Wort. Wiki-Pflege und Wikipedia.");
  mk(
    "Code",
    "```js\nconst geheimnis = 42;\n```\nEin [Link](https://example.org/versteckt-in-url) und [[Bitte lesen|interner Verweis]].",
  );

  it("folds case, accents and ß", () => {
    expect(fold("Straße ÄÖÜ é ﬁ")).toBe("strasse aou e fi");
    expect(fold("ΣΑΣ")).toBe("σασ");
  });

  it("finds substrings anywhere in a word, not just at the start", () => {
    expect(slugs("te")).toEqual(expect.arrayContaining(["bitte-lesen", "zeitplan", "strassenbau"]));
    expect(slugs("itte")).toEqual(["bitte-lesen"]);
    expect(slugs("halte")).toEqual(["bitte-lesen"]); // inside "Inhalte"
  });

  it("is case- and accent-insensitive in both directions", () => {
    expect(slugs("STRASSE")).toEqual(["strassenbau"]);
    expect(slugs("fur")).toEqual(["strassenbau"]);
    expect(slugs("für")).toEqual(["strassenbau"]);
    expect(slugs("hafen")).toEqual(["strassenbau"]);
  });

  it("supports * wildcards anchored to word boundaries", () => {
    expect(slugs("wiki*")).toEqual(["zeitplan"]);
    expect(slugs("*bau")).toEqual(["strassenbau"]); // title word
    expect(slugs("t*st")).toEqual(["zeitplan"]); // "Taust" (not "Test" in "Tests" or "Testlauf")
    expect(slugs("test*")).toEqual(expect.arrayContaining(["strassenbau", "zeitplan"]));
    expect(slugs("*xyz*")).toEqual([]);
    expect(slugs("*")).toEqual([]);
  });

  it("phrases and multiple terms (all must match)", () => {
    expect(slugs('"neue straße"')).toEqual(["strassenbau"]);
    expect(slugs('"straße neue"')).toEqual([]);
    expect(slugs("termine montag")).toEqual(["zeitplan"]);
    expect(slugs("termine hafen")).toEqual([]);
  });

  it("searches the readable text, not markup or link targets", () => {
    expect(slugs("versteckt")).toEqual([]);
    expect(slugs("geheimnis")).toEqual(["code"]); // code blocks are content
    expect(slugs("interner verweis")).toEqual(["code"]);
    expect(markdownToPlain("# T\n**fett** [x](https://a.b/c) @[Video](https://y.z) [[Seite|Label]]")).toBe(
      "T\nfett x Video Label",
    );
  });

  it("highlights hits as segments that reproduce the original text exactly", () => {
    const r = search("straße").hits[0];
    expect(join(r.title)).toBe("Straßenbau");
    expect(hits(r.title)).toEqual(["Straße"]);
    expect(hits(r.snippet)).toEqual(["Straße"]);
    const w = search("wiki*").hits[0];
    expect(hits(w.snippet)).toEqual(["Wiki-Pflege", "Wikipedia"]);
  });

  it("keeps the index in step with edits and deletions", () => {
    const p = mk("Flüchtig", "Einmaliger Begriff Quokka");
    expect(slugs("quokka")).toEqual([p.slug]);
    updatePage(p.slug, { title: "Flüchtig", content: "jetzt Wombat", parentId: null, expectedRev: 1, userId: uid });
    expect(slugs("quokka")).toEqual([]);
    expect(slugs("wombat")).toEqual([p.slug]);
    deletePage(p.slug);
    expect(slugs("wombat")).toEqual([]);
    // pages written without the app code (e.g. seed, import) are indexed too
    const t = Math.floor(Date.now() / 1000);
    db()
      .prepare(
        "INSERT INTO pages(slug,title,parent_id,position,content,rev,created_at,updated_at) VALUES('roh','Roh',NULL,99,'Kakapo',1,?,?)",
      )
      .run(t, t);
    expect(slugs("kakapo")).toEqual(["roh"]);
  });

  it("treats every query as data: no SQL/FTS syntax, no regex, no crash", () => {
    for (const q of [
      '"',
      '""',
      "* OR 1",
      "a AND NOT b",
      "title:x",
      "NEAR(a b)",
      "'; DROP TABLE pages;--",
      "\\",
      "%",
      "_",
      "(.*)+$",
      "\u0000\u0001",
      "💩",
      "*".repeat(300),
      "a*".repeat(100),
    ]) {
      expect(() => search(q)).not.toThrow();
    }
    expect(slugs("%")).toEqual([]);
    expect(slugs("_")).toEqual([]);
    expect(db().prepare("SELECT COUNT(*) n FROM pages").get()).toMatchObject({ n: expect.any(Number) });
  });

  it("caps terms and length, and pathological wildcards stay linear", () => {
    expect(parseQuery("a b c d e f g h i j k").length).toBe(8);
    expect(parseQuery("x".repeat(500))[0].text.length).toBe(64);
    // a classic catastrophic-backtracking shape against a long word
    const word = "a".repeat(5000) + "b";
    const t0 = performance.now();
    expect(
      globMatch(word, { parts: ["a", "a", "a", "a", "a", "a", "a", "c"], anchorStart: false, anchorEnd: true }),
    ).toBe(false);
    expect(performance.now() - t0).toBeLessThan(50);
    const big = mk("Gross", ("lorem ipsum dolor " + "a".repeat(200) + " ").repeat(1500));
    const t1 = performance.now();
    search("*a*a*a*a*a*a*c*", { budgetMs: 200 });
    expect(performance.now() - t1).toBeLessThan(1500);
    deletePage(big.slug);
  });

  it("glob matching semantics", () => {
    const g = (w: string, pat: string) => {
      const t = parseQuery(pat)[0];
      return globMatch(w, t);
    };
    expect(g("testing", "test*")).toBe(true);
    expect(g("contest", "test*")).toBe(false);
    expect(g("contest", "*test")).toBe(true);
    expect(g("tst", "t*st")).toBe(true); // * may match nothing
    expect(g("ts", "t*st")).toBe(false); // but parts must not overlap
  });
});
