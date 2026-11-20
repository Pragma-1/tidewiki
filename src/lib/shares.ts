import { createHash, randomBytes } from "node:crypto";
import { all, one, run, sql, now, tx } from "./db";
import { effectiveAccess, hiddenPages, visibleId, type Level } from "./access";
import { HttpError } from "./validate";

/*
 * Shared links: read access to one page, or to a page with its sub-pages, for anyone who has the
 * link — also when the wiki isn't readable without signing in, and also for private pages.
 *
 *  - The token is 32 random bytes (256 bits, base64url). Only its SHA-256 is stored, so a database
 *    or backup leak can't be turned into working links; the full link is shown once, when it is made.
 *  - A link works only while: it hasn't expired or been revoked, its page exists, and the person
 *    who made it is still an active administrator (or the owner) who may see the page. A page that
 *    later becomes more private than its creator may see stops being shared.
 *  - A section link covers the sub-pages that are no more private than the page itself: a sub-page
 *    that was made private on its own is not shared along.
 *  - Every way of failing looks the same to the visitor ("not found").
 */

export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const SHARE_DAYS = [1, 7, 30, 90, 365, 0] as const; // 0 = until revoked
export type ShareDays = (typeof SHARE_DAYS)[number];
const MAX_PER_PAGE = 20;
const MAX_TOTAL = 1000;

const hashToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

export type ShareRow = {
  id: number;
  hint: string;
  page_id: number;
  slug: string;
  title: string;
  section: number;
  created_at: number;
  expires_at: number | null;
  uses: number;
  last_used_at: number | null;
  creator: string | null;
};

/** Makes a link; returns the token (the only time it exists outside the visitor's address bar). */
export async function createShare(input: {
  pageId: number;
  section: boolean;
  days: ShareDays;
  userId: number;
  level: Level;
}): Promise<{ id: number; token: string; expires_at: number | null }> {
  return tx(async () => {
    if ((await effectiveAccess(input.pageId)) > input.level) throw new HttpError(404, "Page not found.");
    const perPage = await one<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM share_links WHERE page_id = ${input.pageId}
          AND (expires_at IS NULL OR expires_at > ${now()})`,
    );
    if ((perPage?.n ?? 0) >= MAX_PER_PAGE)
      throw new HttpError(409, "This page already has 20 shared links. Revoke one first.");
    const total = await one<{ n: number }>(sql`SELECT COUNT(*) AS n FROM share_links`);
    if ((total?.n ?? 0) >= MAX_TOTAL) throw new HttpError(409, "There are too many shared links. Revoke some first.");
    const token = randomBytes(32).toString("base64url");
    const t = now();
    const expires = input.days === 0 ? null : t + input.days * 86400;
    const r = await one<{ id: number }>(
      sql`INSERT INTO share_links(token_hash, hint, page_id, section, created_by, created_at, expires_at)
          VALUES (${hashToken(token)}, ${token.slice(-4)}, ${input.pageId}, ${input.section ? 1 : 0}, ${input.userId},
                  ${t}, ${expires})
          RETURNING id`,
    );
    return { id: r!.id, token, expires_at: expires };
  });
}

/** Links of pages someone at `level` may see; one page's, or all. Expired links are left out. */
export async function listShares(level: Level, pageId?: number): Promise<ShareRow[]> {
  const hidden = await hiddenPages(level);
  return all<ShareRow>(
    sql`SELECT s.id, s.hint, s.page_id, p.slug, p.title, s.section, s.created_at, s.expires_at, s.uses,
          s.last_used_at, u.username AS creator
        FROM share_links s JOIN pages p ON p.id = s.page_id LEFT JOIN users u ON u.id = s.created_by
        WHERE ${visibleId(sql`p.id`, hidden)} AND (s.expires_at IS NULL OR s.expires_at > ${now()})
          ${pageId === undefined ? sql`` : sql`AND s.page_id = ${pageId}`}
        ORDER BY s.created_at DESC, s.id DESC LIMIT 1000`,
  );
}

/** Revokes one link (of a page the person may see). The row is deleted: the link is gone for good. */
export async function revokeShare(id: number, level: Level): Promise<ShareRow | null> {
  const row = (await listShares(level)).find((s) => s.id === id);
  if (!row) return null;
  await run(sql`DELETE FROM share_links WHERE id = ${id}`);
  return row;
}

/** Revokes every link someone at `level` can see (all of them for the owner). */
export async function revokeAllShares(level: Level): Promise<number> {
  const hidden = await hiddenPages(level);
  return run(sql`DELETE FROM share_links WHERE ${visibleId(sql`page_id`, hidden)}`);
}

export const purgeExpiredShares = () =>
  run(sql`DELETE FROM share_links WHERE expires_at IS NOT NULL AND expires_at <= ${now()}`);

export type ShareScope = {
  id: number;
  rootId: number;
  section: boolean;
  /** the pages this link opens, root first, in reading order */
  pages: { id: number; slug: string; title: string; parent_id: number | null; depth: number }[];
};

/**
 * The scope a token opens, or null for anything that isn't a working link (unknown, expired,
 * revoked, creator gone or no longer allowed, page more private than its creator may see).
 */
export async function resolveShare(token: unknown): Promise<ShareScope | null> {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
  const row = await one<{
    id: number;
    page_id: number;
    section: number;
    expires_at: number | null;
    role: string;
    is_owner: number;
    disabled: number;
  }>(
    sql`SELECT s.id, s.page_id, s.section, s.expires_at, u.role, u.is_owner, u.disabled
        FROM share_links s JOIN users u ON u.id = s.created_by WHERE s.token_hash = ${hashToken(token)}`,
  );
  if (!row) return null;
  if (row.expires_at !== null && row.expires_at <= now()) return null;
  const creatorLevel = row.disabled ? -1 : row.is_owner ? 2 : row.role === "admin" ? 1 : -1;
  const rootEff = await effectiveAccess(row.page_id);
  if (creatorLevel < 0 || rootEff > creatorLevel) return null;
  const pages = row.section
    ? await all<ShareScope["pages"][number]>(
        sql`WITH RECURSIVE t(id, slug, title, parent_id, position, eff, depth, path) AS (
              SELECT id, slug, title, parent_id, position, ${rootEff}::smallint, 0, ARRAY[position, id]
              FROM pages WHERE id = ${row.page_id}
              UNION ALL
              SELECT p.id, p.slug, p.title, p.parent_id, p.position, GREATEST(p.access, t.eff)::smallint, t.depth + 1,
                t.path || ARRAY[p.position, p.id]
              FROM pages p JOIN t ON p.parent_id = t.id
              WHERE t.depth < 20 AND GREATEST(p.access, t.eff) <= ${rootEff}
            )
            SELECT id, slug, title, parent_id, depth FROM t ORDER BY path`,
      )
    : await all<ShareScope["pages"][number]>(
        sql`SELECT id, slug, title, parent_id, 0 AS depth FROM pages WHERE id = ${row.page_id}`,
      );
  if (!pages.length) return null;
  return { id: row.id, rootId: row.page_id, section: !!row.section, pages };
}

/** Counts a visit (at most one count per link and minute, so reloading doesn't inflate it). */
export async function touchShare(id: number) {
  const t = now();
  await run(
    sql`UPDATE share_links SET uses = uses + 1, last_used_at = ${t}
        WHERE id = ${id} AND (last_used_at IS NULL OR last_used_at < ${t - 60})`,
  );
}

/** Route parameter → link id; anything odd is "not found". */
export function shareId(s: string): number {
  if (!/^[1-9]\d{0,15}$/.test(s) || !Number.isSafeInteger(Number(s)))
    throw new HttpError(404, "This link doesn’t exist.");
  return Number(s);
}
