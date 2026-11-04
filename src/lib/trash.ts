import { all, one, run, sql, syncIdentity, tx, vacuum, now, type Sql } from "./db";
import { HttpError } from "./validate";
import { publish } from "./events";
import { assertParentOk, getPage, getPageById, saveLinks, uniqueSlug, type PageRow } from "./pages";

/** Deleted pages stay in the trash this long, then they are removed for good by the hourly job. */
export const TRASH_DAYS = 30;

export type TrashRow = {
  id: number;
  page_id: number;
  slug: string;
  title: string;
  rev: number;
  deleted_at: number;
  deleted_by_name: string | null;
  author: string | null;
  parent_title: string | null;
  size: number;
};

/**
 * Moves a page and its whole history into the trash, in one transaction. Revisions are copied
 * with INSERT … SELECT, so even a page with hundreds of large versions never passes through JS.
 * Sub-pages are not deleted: they move to the top level (as before), and the trash remembers
 * them so a restore can put them back under the page.
 */
export async function trashPage(slug: string, userId: number | null): Promise<PageRow | null> {
  const t = now();
  const page = await tx(async () => {
    const p = await getPage(slug);
    if (!p) return null;
    const children = (await all<{ id: number }>(sql`SELECT id FROM pages WHERE parent_id = ${p.id}`)).map((c) => c.id);
    const r = await one<{ id: number }>(
      sql`INSERT INTO trash(page_id, slug, title, parent_id, position, content, rev, created_by, updated_by,
            created_at, updated_at, system_key, children, deleted_by, deleted_at)
          SELECT id, slug, title, parent_id, position, content, rev, created_by, updated_by, created_at, updated_at,
            system_key, ${JSON.stringify(children)}, ${userId}, ${t}
          FROM pages WHERE id = ${p.id} RETURNING id`,
    );
    await run(
      sql`INSERT INTO trash_revisions(trash_id, orig_id, rev, title, content, author_id, created_at, comment, restored_from)
          SELECT ${r!.id}, id, rev, title, content, author_id, created_at, comment, restored_from
          FROM page_revisions WHERE page_id = ${p.id}`,
    );
    await run(sql`DELETE FROM pages WHERE id = ${p.id}`); // revisions, links and search entries cascade
    return p;
  });
  if (page) publish({ type: "page.deleted", slug: page.slug });
  return page;
}

export function listTrash(): Promise<TrashRow[]> {
  return all<TrashRow>(
    sql`SELECT t.id, t.page_id, t.slug, t.title, t.rev, t.deleted_at, length(t.content) AS size,
          du.username AS deleted_by_name, cu.username AS author, pp.title AS parent_title
        FROM trash t LEFT JOIN users du ON du.id = t.deleted_by LEFT JOIN users cu ON cu.id = t.created_by
        LEFT JOIN pages pp ON pp.id = t.parent_id
        ORDER BY t.deleted_at DESC, t.id DESC LIMIT 500`,
  );
}

export const trashCount = async () => (await one<{ n: number }>(sql`SELECT COUNT(*) AS n FROM trash`))?.n ?? 0;

/** Route parameter → trash id; anything odd is simply "not in the trash". */
export function trashId(s: string): number {
  if (!/^[1-9]\d{0,15}$/.test(s) || !Number.isSafeInteger(Number(s)))
    throw new HttpError(404, "This page is no longer in the trash.");
  return Number(s);
}

export type TrashItem = {
  id: number;
  page_id: number;
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
  system_key: string | null;
  children: string;
  deleted_by: number | null;
  deleted_at: number;
};

export const getTrashItem = (id: number) => one<TrashItem>(sql`SELECT * FROM trash WHERE id = ${id}`);

export const trashRevisionCount = async (id: number) =>
  (await one<{ n: number }>(sql`SELECT COUNT(*) AS n FROM trash_revisions WHERE trash_id = ${id}`))?.n ?? 0;

/** Parses the stored child list defensively — it is our own JSON, but a restored backup is input too. */
export function childIds(raw: string): number[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((n): n is number => Number.isSafeInteger(n) && n > 0).slice(0, 5000) : [];
  } catch {
    return [];
  }
}

/**
 * Puts a page back with its whole history. Keeps the old address unless another page took it
 * meanwhile (then "-2" etc.), the old chapter if it still exists (else the top level), and pulls
 * former sub-pages back under it — but only those still at the top level, so nothing that was
 * filed elsewhere in the meantime is moved.
 */
export async function restoreFromTrash(id: number): Promise<{ page: PageRow; slugChanged: boolean }> {
  const res = await tx(async () => {
    const item = await getTrashItem(id);
    if (!item) throw new HttpError(404, "This page is no longer in the trash.");
    const page = await reinsertPage(
      {
        ...item,
        revisions: sql`SELECT orig_id, rev, title, content, author_id, created_at, comment, restored_from
                       FROM trash_revisions WHERE trash_id = ${id}`,
      },
      childIds(item.children),
    );
    await run(sql`DELETE FROM trash WHERE id = ${id}`);
    return page;
  });
  publish({ type: "page.created", slug: res.page.slug, title: res.page.title, rev: res.page.rev });
  return res;
}

/**
 * Inserts a page (from the trash or from a backup) with its revisions, inside the caller's
 * transaction. Shared by trash restore and single-page backup restore, so both behave the same.
 * `revisions` is a query returning (orig_id, rev, title, content, author_id, created_at, comment, restored_from).
 */
export async function reinsertPage(
  item: Omit<TrashItem, "id" | "children" | "deleted_by" | "deleted_at"> & {
    revisions: Sql;
  },
  children: number[],
): Promise<{ page: PageRow; slugChanged: boolean }> {
  const slug = await uniqueSlug(item.slug);
  let parentId: number | null = item.parent_id;
  if (parentId !== null) {
    try {
      await assertParentOk(null, parentId);
    } catch {
      parentId = null;
    }
  }
  // the old id keeps links from the event stream and old backups stable, when it's still free
  const idFree = !(await one(sql`SELECT 1 FROM pages WHERE id = ${item.page_id}`));
  // a built-in page key must stay unique; if a new copy exists, the restored one is a normal page
  const sysKey =
    item.system_key && !(await one(sql`SELECT 1 FROM pages WHERE system_key = ${item.system_key}`))
      ? item.system_key
      : null;
  const r = await one<{ id: number }>(
    sql`INSERT INTO pages(id, slug, title, parent_id, position, content, rev, created_by, updated_by, created_at,
          updated_at, system_key)
        VALUES (COALESCE(${idFree ? item.page_id : null}::bigint, nextval(pg_get_serial_sequence('pages', 'id'))),
          ${slug}, ${item.title}, ${parentId}, ${item.position}, ${item.content}, ${item.rev},
          (SELECT id FROM users WHERE id = ${item.created_by}), (SELECT id FROM users WHERE id = ${item.updated_by}),
          ${item.created_at}, ${item.updated_at}, ${sysKey})
        RETURNING id`,
  );
  const pageId = r!.id;
  await syncIdentity("pages");
  // Original revision ids keep "recent changes" in its real order; if one was reused, take a new one.
  await run(
    sql`INSERT INTO page_revisions(id, page_id, rev, title, content, author_id, created_at, comment, restored_from)
        SELECT CASE WHEN src.orig_id IS NULL OR EXISTS (SELECT 1 FROM page_revisions x WHERE x.id = src.orig_id)
                 THEN nextval(pg_get_serial_sequence('page_revisions', 'id')) ELSE src.orig_id END,
          ${pageId}::bigint, src.rev, src.title, src.content,
          (SELECT id FROM users WHERE id = src.author_id), src.created_at, src.comment, src.restored_from
        FROM (${item.revisions}) AS src ORDER BY src.rev`,
  );
  await syncIdentity("page_revisions");
  // A page always has at least its current version in the history.
  await run(
    sql`INSERT INTO page_revisions(page_id, rev, title, content, author_id, created_at)
        SELECT ${pageId}::bigint, ${item.rev}::bigint, ${item.title}, ${item.content},
          (SELECT id FROM users WHERE id = ${item.updated_by}), ${item.updated_at}::bigint
        ON CONFLICT (page_id, rev) DO NOTHING`,
  );
  await saveLinks(pageId, item.content);
  for (const c of children) {
    if (!(await one(sql`SELECT 1 FROM pages WHERE id = ${c} AND parent_id IS NULL`))) continue;
    try {
      await assertParentOk(c, pageId);
      await run(sql`UPDATE pages SET parent_id = ${pageId} WHERE id = ${c} AND parent_id IS NULL`);
    } catch {
      /* too deep now, or would form a cycle: leave it where it is */
    }
  }
  return { page: (await getPageById(pageId))!, slugChanged: slug !== item.slug };
}

/** Removes for good. */
export async function purgeTrashItem(id: number): Promise<TrashItem | undefined> {
  const item = await one<TrashItem>(sql`DELETE FROM trash WHERE id = ${id} RETURNING *`);
  if (item) await vacuum(["trash", "trash_revisions"]);
  return item;
}

export async function emptyTrash(): Promise<number> {
  const n = await run(sql`DELETE FROM trash`);
  if (n) await vacuum(["trash", "trash_revisions"]);
  return n;
}

/** Called by the hourly retention job. */
export async function purgeOldTrash(days = TRASH_DAYS): Promise<number> {
  const n = await run(sql`DELETE FROM trash WHERE deleted_at < ${now() - days * 86400}`);
  if (n) await vacuum(["trash", "trash_revisions"]);
  return n;
}
