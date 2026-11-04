import MarkdownIt, { type Token } from "markdown-it";
import { db } from "./db";
import { HttpError } from "./validate";

/*
 * Full-text search with substring matching ("te" finds "Bitte") and * wildcards.
 *
 *  - Text is folded (lower case, accents removed, ß → ss) both when indexing and when querying,
 *    so "fur" finds "für" and "STRASSE" finds "Straße".
 *  - A trigram FTS5 index narrows the candidates; the exact check runs in JavaScript.
 *  - Wildcards are matched with a plain left-to-right scan (no regular expressions built from
 *    user input), so no query can trigger catastrophic backtracking.
 *  - Every search runs against a time budget, and a global CPU budget caps what a flood of
 *    searches can cost the server.
 */

/* ------------------------------------------------------------------ folding */

const foldChar = (ch: string): string => {
  const c = ch.charCodeAt(0);
  if (c < 128) return c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : ch;
  let s = ch
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "");
  if (s.includes("ß")) s = s.replace(/ß/g, "ss");
  if (s.includes("ς")) s = s.replace(/ς/g, "σ");
  return s;
};

/** Folds a string; identical output to foldWithMap(s).text. */
export function fold(s: string): string {
  let out = "";
  for (const ch of s) out += foldChar(ch);
  return out;
}

/** Folds a string and remembers, for every folded UTF-16 unit, where it came from in the original. */
function foldWithMap(s: string): { text: string; map: number[] } {
  let text = "";
  const map: number[] = [];
  let i = 0;
  for (const ch of s) {
    const f = foldChar(ch);
    text += f;
    for (let k = 0; k < f.length; k++) map.push(i);
    i += ch.length;
  }
  map.push(i);
  return { text, map };
}

/* ------------------------------------------------------- markdown → plain */

const md = new MarkdownIt({ html: false, linkify: false });

function inlineText(children: Token[] | null): string {
  let s = "";
  for (const c of children ?? []) {
    if (c.type === "text" || c.type === "code_inline") s += c.content;
    else if (c.type === "softbreak" || c.type === "hardbreak") s += " ";
    else if (c.type === "image") s += inlineText(c.children);
  }
  return s;
}

/** Readable text of a Markdown page, as a reader sees it (no URLs, no syntax). */
export function markdownToPlain(src: string): string {
  const out: string[] = [];
  for (const t of md.parse(src, {})) {
    if (t.type === "inline") out.push(inlineText(t.children));
    else if (t.type === "fence" || t.type === "code_block") out.push(t.content);
  }
  return out
    .join("\n")
    .replace(/\[\[([^\]|\n]{1,160})(?:\|([^\]\n]{0,160}))?\]\]/g, (_m, a: string, b?: string) => (b || a).trim()) // [[Page|label]]
    .replace(/\[!(?:info|tip|warning|danger)\]\s*/gi, "") // callout markers
    .replace(/(^|\s)@(?=\S)/g, "$1") // leftovers of the @[title](url) media syntax
    .replace(/[ \t]+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------- index */

const MAX_PLAIN = 600_000;

/** Brings the index up to date for every page written since the last search (marked by triggers). */
export function flushIndex() {
  const dirty = db().prepare("SELECT page_id FROM search_dirty LIMIT 1").get();
  if (!dirty) return;
  const pick = db().prepare("SELECT page_id FROM search_dirty LIMIT 200");
  const get = db().prepare("SELECT id, title, content FROM pages WHERE id=?");
  const del = db().prepare("DELETE FROM search_idx WHERE rowid=?");
  const ins = db().prepare("INSERT INTO search_idx(rowid, title, body, plain) VALUES(?,?,?,?)");
  const done = db().prepare("DELETE FROM search_dirty WHERE page_id=?");
  for (;;) {
    const batch = pick.all() as { page_id: number }[];
    if (!batch.length) break;
    db().transaction(() => {
      for (const { page_id } of batch) {
        const p = get.get(page_id) as { id: number; title: string; content: string } | undefined;
        del.run(page_id);
        if (p) {
          const plain = markdownToPlain(p.content).slice(0, MAX_PLAIN);
          ins.run(p.id, fold(p.title), fold(plain), plain);
        }
        done.run(page_id);
      }
    })();
  }
}

/* ------------------------------------------------------------------- query */

type Term = { phrase: boolean; glob: boolean; parts: string[]; anchorStart: boolean; anchorEnd: boolean; text: string };

const MAX_TERMS = 8;
const MAX_TERM_LEN = 64;
export const MAX_QUERY = 200;

/** Splits the query into terms: "quoted phrases", words, and words with * wildcards. */
export function parseQuery(q: string): Term[] {
  const src = q.slice(0, MAX_QUERY).replace(/[\u0000-\u001f\u007f]/g, " ");
  const terms: Term[] = [];
  for (const m of src.matchAll(/"([^"]*)"|(\S+)/g)) {
    if (terms.length >= MAX_TERMS) break;
    if (m[1] !== undefined) {
      const text = fold(m[1].trim().replace(/\s+/g, " ")).slice(0, MAX_TERM_LEN);
      if (text) terms.push({ phrase: true, glob: false, parts: [text], anchorStart: false, anchorEnd: false, text });
      continue;
    }
    const raw = fold(m[2].replace(/\*+/g, "*")).slice(0, MAX_TERM_LEN);
    if (!raw.replace(/\*/g, "")) continue; // a lone "*" says nothing
    if (!raw.includes("*")) {
      terms.push({ phrase: false, glob: false, parts: [raw], anchorStart: false, anchorEnd: false, text: raw });
      continue;
    }
    terms.push({
      phrase: false,
      glob: true,
      parts: raw.split("*").filter(Boolean),
      anchorStart: !raw.startsWith("*"),
      anchorEnd: !raw.endsWith("*"),
      text: raw,
    });
  }
  return terms;
}

/** Glob match of one word against literal parts separated by *. Linear scans, no backtracking needed. */
export function globMatch(word: string, t: Pick<Term, "parts" | "anchorStart" | "anchorEnd">): boolean {
  let pos = 0;
  const n = t.parts.length;
  for (let i = 0; i < n; i++) {
    const seg = t.parts[i];
    if (i === 0 && t.anchorStart) {
      if (!word.startsWith(seg)) return false;
      pos = seg.length;
      if (n === 1 && t.anchorEnd) return pos === word.length;
      continue;
    }
    if (i === n - 1 && t.anchorEnd) return word.length - seg.length >= pos && word.endsWith(seg);
    const at = word.indexOf(seg, pos);
    if (at < 0) return false;
    pos = at + seg.length;
  }
  return true;
}

const WORD_TRIM = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/** Calls fn(start, end) for every whitespace-separated word (punctuation trimmed) of a folded text. */
function eachWord(text: string, fn: (start: number, end: number, word: string) => boolean | void, deadline: number) {
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    if ((++n & 1023) === 0 && performance.now() > deadline) return;
    const raw = m[0];
    const word = raw.replace(WORD_TRIM, "");
    if (!word) continue;
    const lead = raw.indexOf(word);
    if (fn(m.index + lead, m.index + lead + word.length, word) === false) return;
  }
}

/** Occurrence count of one term in a folded text (capped). */
function countHits(text: string, t: Term, cap: number, deadline: number): number {
  let n = 0;
  if (!t.glob) {
    const s = t.parts[0];
    for (let at = text.indexOf(s); at >= 0 && n < cap; at = text.indexOf(s, at + s.length)) n++;
    return n;
  }
  // Cheap reject: every literal part has to occur somewhere first.
  if (!t.parts.every((p) => text.includes(p))) return 0;
  eachWord(
    text,
    (_s, _e, w) => {
      if (globMatch(w, t) && ++n >= cap) return false;
    },
    deadline,
  );
  return n;
}

/** Ranges [start, end) of hits in a folded text, for highlighting. */
function hitRanges(text: string, terms: Term[], limitTo: number, deadline: number): [number, number][] {
  const out: [number, number][] = [];
  const hay = text.slice(0, limitTo);
  for (const t of terms) {
    if (!t.glob) {
      const s = t.parts[0];
      for (let at = hay.indexOf(s), k = 0; at >= 0 && k < 200; at = hay.indexOf(s, at + s.length), k++)
        out.push([at, at + s.length]);
    } else {
      let k = 0;
      eachWord(
        hay,
        (st, en, w) => {
          if (globMatch(w, t)) {
            out.push([st, en]);
            if (++k >= 200) return false;
          }
        },
        deadline,
      );
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
}

export type Segment = { t: string; hit?: true };

/** Splits an original string into plain and highlighted segments. */
function highlight(original: string, terms: Term[], deadline: number, window?: number): Segment[] {
  const SNIP_SCAN = 120_000;
  const src = original.slice(0, SNIP_SCAN);
  const { text, map } = foldWithMap(src);
  const ranges = hitRanges(text, terms, text.length, deadline);
  let from = 0,
    to = src.length;
  if (window !== undefined) {
    const first = ranges.length ? map[ranges[0][0]] : 0;
    from = Math.max(0, first - Math.floor(window / 3));
    to = Math.min(src.length, from + window);
    // don't cut words in half
    if (from > 0) {
      const sp = src.indexOf(" ", from);
      if (sp >= 0 && sp - from < 20) from = sp + 1;
    }
    if (to < src.length) {
      const sp = src.lastIndexOf(" ", to);
      if (sp > from && to - sp < 20) to = sp;
    }
  }
  const segs: Segment[] = [];
  let cur = from;
  for (const [a, b] of ranges) {
    const s = map[a],
      e = map[b];
    if (e <= cur || s >= to) continue;
    const s2 = Math.max(s, cur),
      e2 = Math.min(e, to);
    if (s2 > cur) segs.push({ t: src.slice(cur, s2) });
    segs.push({ t: src.slice(s2, e2), hit: true });
    cur = e2;
  }
  if (cur < to) segs.push({ t: src.slice(cur, to) });
  if (window !== undefined) {
    if (from > 0) segs.unshift({ t: "… " });
    if (to < original.length) segs.push({ t: " …" });
  }
  return segs;
}

/* ------------------------------------------------------------- cpu budget */

const CPU_WINDOW_MS = 60_000;
const CPU_BUDGET_MS = 15_000; // all searches together may use at most 25 % of one core
let cpuStart = 0,
  cpuUsed = 0;
function chargeCpu(ms: number) {
  const t = Date.now();
  if (t - cpuStart > CPU_WINDOW_MS) {
    cpuStart = t;
    cpuUsed = 0;
  }
  cpuUsed += ms;
}
const cpuExhausted = () => Date.now() - cpuStart <= CPU_WINDOW_MS && cpuUsed >= CPU_BUDGET_MS;

/* ------------------------------------------------------------------ search */

export type SearchHit = { slug: string; title: Segment[]; snippet: Segment[]; score: number };
export type SearchResult = { hits: SearchHit[]; total: number; partial: boolean };

const ftsPhrase = (s: string) => `"${s.replace(/"/g, '""')}"`;
const likeArg = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const MAX_CANDIDATES = 3000;

export function search(q: string, opts: { limit?: number; budgetMs?: number } = {}): SearchResult {
  const terms = parseQuery(q);
  if (!terms.length) return { hits: [], total: 0, partial: false };
  if (cpuExhausted()) throw new HttpError(503, "Search is busy right now. Try again in a moment.");
  const started = performance.now();
  const deadline = started + (opts.budgetMs ?? 350);
  try {
    flushIndex();
    // SQL prefilter: the longest literal part of each term must occur (trigram index when ≥ 3 characters).
    const match: string[] = [];
    const where: string[] = [];
    const args: string[] = [];
    for (const t of terms) {
      const longest = t.parts.reduce((a, b) => ([...b].length > [...a].length ? b : a), "");
      if ([...longest].length >= 3) match.push(ftsPhrase(longest));
      else {
        where.push("(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')");
        args.push(likeArg(longest), likeArg(longest));
      }
    }
    if (match.length) {
      where.unshift("search_idx MATCH ?");
      args.unshift(match.join(" AND "));
    }
    const ids = db()
      .prepare(`SELECT rowid AS id FROM search_idx WHERE ${where.join(" AND ")} LIMIT ${MAX_CANDIDATES}`)
      .all(...args) as { id: number }[];

    const row = db().prepare("SELECT title, body FROM search_idx WHERE rowid=?");
    const scored: { id: number; score: number }[] = [];
    let partial = ids.length >= MAX_CANDIDATES;
    for (const { id } of ids) {
      if (performance.now() > deadline) {
        partial = true;
        break;
      }
      const r = row.get(id) as { title: string; body: string };
      let score = 0;
      let all = true;
      for (const t of terms) {
        const inTitle = countHits(r.title, t, 5, deadline);
        const inBody = countHits(r.body, t, 50, deadline);
        if (inTitle + inBody === 0) {
          all = false;
          break;
        }
        score +=
          inTitle * 20 +
          Math.min(inBody, 50) +
          (r.title === t.text ? 50 : 0) +
          (!t.glob && r.title.startsWith(t.parts[0]) ? 10 : 0);
      }
      if (all) scored.push({ id, score });
    }
    scored.sort((a, b) => b.score - a.score || a.id - b.id);
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 500);
    const page = db().prepare(
      "SELECT p.slug, p.title, s.plain FROM pages p JOIN search_idx s ON s.rowid=p.id WHERE p.id=?",
    );
    const hits: SearchHit[] = [];
    for (const { id, score } of scored.slice(0, limit)) {
      const p = page.get(id) as { slug: string; title: string; plain: string } | undefined;
      if (!p) continue;
      const late = performance.now() > deadline + 150;
      hits.push({
        slug: p.slug,
        score,
        title: late ? [{ t: p.title }] : highlight(p.title, terms, deadline + 150),
        snippet: late ? [{ t: p.plain.slice(0, 160) }] : highlight(p.plain, terms, deadline + 150, 180),
      });
    }
    return { hits, total: scored.length, partial };
  } finally {
    chargeCpu(performance.now() - started);
  }
}
