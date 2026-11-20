import { cache } from "react";
import { all, one, sql, type Sql } from "./db";
import { msg } from "./msg";

/*
 * Private pages. Every page has an access level; it covers the page's sub-pages as well, so what
 * counts for a page is the strictest level on its way up to the top (its *effective* level):
 *
 *   0  everyone who may read the wiki (the default)
 *   1  administrators and the owner
 *   2  only the owner
 *
 * Someone sees a page when their own level is at least the page's effective level. A page someone
 * may not see doesn't exist for them: not in the menu, search, lists, history, events or exports,
 * and its address answers "not found" — same as an address that was never used.
 */

export type Level = 0 | 1 | 2;
export const ACCESS_NAMES = ["all", "admins", "owner"] as const;
export type AccessName = (typeof ACCESS_NAMES)[number];
export const ACCESS_LABELS: Record<AccessName, string> = {
  all: msg("Everyone who can read the wiki"),
  admins: msg("Administrators and the owner"),
  owner: msg("Only the owner"),
};
export const accessName = (n: number): AccessName => ACCESS_NAMES[n] ?? "owner";
export const accessLevel = (name: unknown): Level | null => {
  const i = ACCESS_NAMES.indexOf(name as AccessName);
  return i < 0 ? null : (i as Level);
};

/** How far someone can see: the owner everything, administrators level 1, everyone else level 0. */
export function levelOf(user: { role: string; isOwner: boolean; needs2faSetup?: boolean } | null): Level {
  if (!user || user.needs2faSetup) return 0;
  if (user.isOwner) return 2;
  return user.role === "admin" ? 1 : 0;
}

/**
 * Pages someone at `level` may not see (their effective level is higher). Once per request in
 * server components. Pages that can't be reached from the top (only a damaged database could hold
 * a loop) count as hidden.
 */
export const hiddenPages = cache(async (level: Level): Promise<Set<number>> => {
  if (level >= 2) return new Set();
  const any = await one(sql`SELECT 1 FROM pages WHERE access > ${level} LIMIT 1`);
  if (!any) return new Set();
  const rows = await all<{ id: number }>(
    sql`WITH RECURSIVE t(id, eff, d) AS (
          SELECT id, access, 0 FROM pages WHERE parent_id IS NULL
          UNION ALL SELECT p.id, GREATEST(p.access, t.eff), t.d + 1 FROM pages p JOIN t ON p.parent_id = t.id
          WHERE t.d < 60
        )
        SELECT p.id FROM pages p WHERE NOT EXISTS (SELECT 1 FROM t WHERE t.id = p.id AND t.eff <= ${level})`,
  );
  return new Set(rows.map((r) => r.id));
});

/** SQL condition "this page id is visible" for a column, given the hidden set. */
export const visibleId = (column: Sql, hidden: Set<number>) =>
  hidden.size ? sql`NOT (${column} = ANY(${[...hidden]}::bigint[]))` : sql`TRUE`;

/** The effective level of one page (2 for a page that doesn't exist or sits in a loop). */
export async function effectiveAccess(pageId: number): Promise<Level> {
  const r = await one<{ eff: number | null; top: boolean | null }>(
    sql`WITH RECURSIVE up(id, parent_id, access, d) AS (
          SELECT id, parent_id, access, 0 FROM pages WHERE id = ${pageId}
          UNION ALL SELECT p.id, p.parent_id, p.access, up.d + 1 FROM pages p JOIN up ON p.id = up.parent_id
          WHERE up.d < 60
        )
        SELECT MAX(access) AS eff, bool_or(parent_id IS NULL) AS top FROM up`,
  );
  if (r?.eff === null || r?.eff === undefined || !r.top) return 2;
  return Math.min(2, Math.max(0, r.eff)) as Level;
}

/** The level a page's parent passes down (0 at the top level). */
export const inheritedAccess = async (parentId: number | null): Promise<Level> =>
  parentId === null ? 0 : effectiveAccess(parentId);

export async function canSee(pageId: number, level: Level): Promise<boolean> {
  return (await effectiveAccess(pageId)) <= level;
}

export type AccessInfo = {
  /** the page's own setting */
  own: Level;
  /** what its chapters above pass down */
  inherited: Level;
  effective: Level;
  /** the chapter the inherited level comes from (the nearest one that sets it) */
  from: { slug: string; title: string } | null;
};

export async function accessInfo(pageId: number): Promise<AccessInfo> {
  const rows = await all<{ slug: string; title: string; access: number; d: number }>(
    sql`WITH RECURSIVE up(id, slug, title, parent_id, access, d) AS (
          SELECT id, slug, title, parent_id, access, 0 FROM pages WHERE id = ${pageId}
          UNION ALL SELECT p.id, p.slug, p.title, p.parent_id, p.access, up.d + 1 FROM pages p JOIN up ON p.id = up.parent_id
          WHERE up.d < 60
        ) SELECT slug, title, access, d FROM up ORDER BY d`,
  );
  const clamp = (n: number) => Math.min(2, Math.max(0, n)) as Level;
  const own = clamp(rows[0]?.access ?? 0);
  const above = rows.slice(1);
  const inherited = clamp(Math.max(0, ...above.map((r) => r.access)));
  const src = inherited > 0 ? above.find((r) => r.access === inherited) : undefined;
  return {
    own,
    inherited,
    effective: Math.max(own, inherited) as Level,
    from: src ? { slug: src.slug, title: src.title } : null,
  };
}
