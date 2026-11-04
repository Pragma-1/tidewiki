import { db, now } from "./db";
import { LIMITS } from "./config";
import { HttpError, slugify } from "./validate";
import { publish } from "./events";
import { needsRelink } from "./db";

/* ------------------------------------------------------------------ links */

/** Wiki-internal link targets in a page's Markdown: [[Title]] and [text](/w/slug). */
export function extractLinks(md: string): string[] {
  const out = new Set<string>();
  for (const m of md.matchAll(/\[\[([^\]\n|]{1,160})(?:\|[^\]\n]{0,160})?\]\]/g)) out.add(slugify(m[1].trim()));
  for (const m of md.matchAll(/\]\(\/w\/([a-z0-9-]{1,80})(?:[#?)][^)]*)?\)?/g)) out.add(m[1]);
  return [...out].filter((s) => SLUG_OK.test(s)).slice(0, 500);
}
const SLUG_OK = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function saveLinks(pageId: number, content: string) {
  db().prepare("DELETE FROM page_links WHERE from_id=?").run(pageId);
  const ins = db().prepare("INSERT OR IGNORE INTO page_links(from_id,to_slug) VALUES(?,?)");
  for (const s of extractLinks(content)) ins.run(pageId, s);
}

export function rebuildLinks() {
  db().transaction(() => {
    db().prepare("DELETE FROM page_links").run();
    for (const p of db().prepare("SELECT id, content FROM pages").all() as { id: number; content: string }[])
      saveLinks(p.id, p.content);
  })();
}

/** Pages that link here. */
export function backlinks(slug: string) {
  if (needsRelink()) rebuildLinks();
  return db()
    .prepare(
      `SELECT p.slug, p.title FROM page_links l JOIN pages p ON p.id=l.from_id WHERE l.to_slug=? AND p.slug<>? ORDER BY p.title COLLATE NOCASE LIMIT 100`,
    )
    .all(slug, slug) as { slug: string; title: string }[];
}

/** Every saved version across the wiki, newest first (MediaWiki's "recent changes"). */
export function recentChanges(limit = 50, before?: number) {
  return db()
    .prepare(
      `SELECT r.id, r.rev, r.title, r.created_at, p.slug, u.username AS author,
      (SELECT LENGTH(r2.content) FROM page_revisions r2 WHERE r2.page_id=r.page_id AND r2.rev=r.rev-1) AS prev_len, LENGTH(r.content) AS len
    FROM page_revisions r JOIN pages p ON p.id=r.page_id LEFT JOIN users u ON u.id=r.author_id
    ${before ? "WHERE r.id < ?" : ""} ORDER BY r.id DESC LIMIT ?`,
    )
    .all(...(before ? [before, limit] : [limit])) as {
    id: number;
    rev: number;
    title: string;
    created_at: number;
    slug: string;
    author: string | null;
    prev_len: number | null;
    len: number;
  }[];
}

/** Depth-first reading order, for "previous / next" links. */
export function readingOrder(): { slug: string; title: string }[] {
  const walk = (ns: TreeNode[]): { slug: string; title: string }[] =>
    ns.flatMap((n) => [{ slug: n.slug, title: n.title }, ...walk(n.children)]);
  return walk(getTree());
}

export type PageRow = {
  id: number;
  slug: string;
  title: string;
  parent_id: number | null;
  position: number;
  content: string;
  rev: number;
  created_by: number | null;
  updated_by: number | null;
  created_at: number;
  updated_at: number;
  author?: string | null;
  editor?: string | null;
};
export type TreeNode = { id: number; slug: string; title: string; parent_id: number | null; children: TreeNode[] };

const SELECT = `SELECT p.*, cu.username AS author, uu.username AS editor FROM pages p
  LEFT JOIN users cu ON cu.id=p.created_by LEFT JOIN users uu ON uu.id=p.updated_by`;

export const getPage = (slug: string) => db().prepare(`${SELECT} WHERE p.slug=?`).get(slug) as PageRow | undefined;
export const getPageById = (id: number) => db().prepare(`${SELECT} WHERE p.id=?`).get(id) as PageRow | undefined;

export function getTree(): TreeNode[] {
  const rows = db()
    .prepare("SELECT id, slug, title, parent_id FROM pages ORDER BY position, title COLLATE NOCASE")
    .all() as Omit<TreeNode, "children">[];
  const nodes = new Map<number, TreeNode>(rows.map((r) => [r.id, { ...r, children: [] }]));
  const roots: TreeNode[] = [];
  for (const n of nodes.values()) {
    const parent = n.parent_id ? nodes.get(n.parent_id) : undefined;
    (parent ? parent.children : roots).push(n);
  }
  return roots;
}

export const recentPages = (limit = 8) =>
  db().prepare(`${SELECT} ORDER BY p.updated_at DESC LIMIT ?`).all(limit) as PageRow[];

function uniqueSlug(base: string): string {
  const exists = db().prepare("SELECT 1 FROM pages WHERE slug=?");
  if (!exists.get(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const s = `${base.slice(0, 74)}-${i}`;
    if (!exists.get(s)) return s;
  }
  throw new HttpError(409, "Could not create a unique address for this page.");
}

function depthOf(id: number | null): number {
  let d = 0,
    cur = id;
  while (cur) {
    const r = db().prepare("SELECT parent_id FROM pages WHERE id=?").get(cur) as
      { parent_id: number | null } | undefined;
    if (!r) break;
    d++;
    cur = r.parent_id;
    if (d > 20) break;
  }
  return d;
}

function assertParentOk(pageId: number | null, parentId: number | null) {
  if (parentId === null) return;
  const parent = getPageById(parentId);
  if (!parent) throw new HttpError(400, "The selected chapter does not exist.", "parentId");
  if (pageId !== null) {
    // refuse cycles: parent must not be the page itself or one of its descendants
    let cur: number | null = parentId,
      guard = 0;
    while (cur && guard++ < 50) {
      if (cur === pageId) throw new HttpError(400, "A page can’t be moved inside itself.", "parentId");
      cur =
        (db().prepare("SELECT parent_id FROM pages WHERE id=?").get(cur) as { parent_id: number | null } | undefined)
          ?.parent_id ?? null;
    }
  }
  if (depthOf(parentId) >= LIMITS.maxPageDepth)
    throw new HttpError(400, `Chapters can be nested ${LIMITS.maxPageDepth} levels deep at most.`, "parentId");
}

export function createPage(input: {
  title: string;
  content: string;
  parentId: number | null;
  userId: number;
  slug?: string;
}): PageRow {
  const t = now();
  const page = db()
    .transaction(() => {
      assertParentOk(null, input.parentId);
      const slug = uniqueSlug(slugify(input.slug || input.title));
      const pos = (
        db().prepare("SELECT COALESCE(MAX(position),0)+1 AS n FROM pages WHERE parent_id IS ?").get(input.parentId) as {
          n: number;
        }
      ).n;
      const info = db()
        .prepare(
          `INSERT INTO pages(slug,title,parent_id,position,content,rev,created_by,updated_by,created_at,updated_at)
      VALUES(?,?,?,?,?,1,?,?,?,?)`,
        )
        .run(slug, input.title, input.parentId, pos, input.content, input.userId, input.userId, t, t);
      const id = Number(info.lastInsertRowid);
      db()
        .prepare("INSERT INTO page_revisions(page_id,rev,title,content,author_id,created_at) VALUES(?,?,?,?,?,?)")
        .run(id, 1, input.title, input.content, input.userId, t);
      saveLinks(id, input.content);
      return getPageById(id)!;
    })
    .immediate();
  publish({ type: "page.created", slug: page.slug, title: page.title, rev: page.rev });
  return page;
}

export function updatePage(
  slug: string,
  input: { title: string; content: string; parentId: number | null; expectedRev: number; userId: number },
): PageRow {
  const t = now();
  const page = db()
    .transaction(() => {
      const cur = getPage(slug);
      if (!cur) throw new HttpError(404, "Page not found.");
      if (cur.rev !== input.expectedRev)
        throw new HttpError(
          409,
          "Someone else saved this page while you were editing. Copy your changes, reload, and merge them.",
        );
      if (input.parentId !== cur.parent_id) assertParentOk(cur.id, input.parentId);
      const rev = cur.rev + 1;
      db()
        .prepare("UPDATE pages SET title=?, content=?, parent_id=?, rev=?, updated_by=?, updated_at=? WHERE id=?")
        .run(input.title, input.content, input.parentId, rev, input.userId, t, cur.id);
      db()
        .prepare("INSERT INTO page_revisions(page_id,rev,title,content,author_id,created_at) VALUES(?,?,?,?,?,?)")
        .run(cur.id, rev, input.title, input.content, input.userId, t);
      saveLinks(cur.id, input.content);
      return getPageById(cur.id)!;
    })
    .immediate();
  publish({ type: "page.updated", slug: page.slug, title: page.title, rev: page.rev });
  return page;
}

export function deletePage(slug: string): boolean {
  const ok = db().prepare("DELETE FROM pages WHERE slug=?").run(slug).changes > 0;
  if (ok) publish({ type: "page.deleted", slug });
  return ok;
}

export const listRevisions = (pageId: number) =>
  db()
    .prepare(
      `SELECT r.rev, r.title, r.created_at, u.username AS author FROM page_revisions r
    LEFT JOIN users u ON u.id=r.author_id WHERE r.page_id=? ORDER BY r.rev DESC LIMIT 200`,
    )
    .all(pageId) as { rev: number; title: string; created_at: number; author: string | null }[];

export const getRevision = (pageId: number, rev: number) =>
  db()
    .prepare("SELECT rev, title, content, created_at FROM page_revisions WHERE page_id=? AND rev=?")
    .get(pageId, rev) as { rev: number; title: string; content: string; created_at: number } | undefined;

export function breadcrumbs(page: PageRow): { slug: string; title: string }[] {
  const out: { slug: string; title: string }[] = [];
  let cur = page.parent_id,
    guard = 0;
  while (cur && guard++ < 10) {
    const p = getPageById(cur);
    if (!p) break;
    out.unshift({ slug: p.slug, title: p.title });
    cur = p.parent_id;
  }
  return out;
}

export const pageCount = () => (db().prepare("SELECT COUNT(*) AS n FROM pages").get() as { n: number }).n;

/** Chapters a page may be filed under (nesting is capped, and a page can't become its own child). */
export function parentOptions(
  nodes: TreeNode[],
  excludeId?: number,
  depth = 0,
): { id: number; title: string; depth: number }[] {
  return nodes.flatMap((n) =>
    n.id === excludeId || depth > 1
      ? []
      : [{ id: n.id, title: n.title, depth }, ...parentOptions(n.children, excludeId, depth + 1)],
  );
}
