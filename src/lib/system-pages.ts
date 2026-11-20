import { cache } from "react";
import { all, sql } from "./db";
import type { Lang } from "./i18n";
import { SYSTEM_PAGES } from "./seed";

export type LocalVersion = { title: string; content: string };

/**
 * The built-in pages (welcome, Markdown guide) that nobody has edited, in the reader's language:
 * slug → title and text. A page counts as unedited while its title and text are exactly one of
 * the shipped versions; edited pages are shown as written. Once per request.
 */
export const localVersions = cache(async (lang: Lang): Promise<Map<string, LocalVersion>> => {
  const rows = await all<{ slug: string; title: string; content: string; system_key: string }>(
    sql`SELECT slug, title, content, system_key FROM pages WHERE system_key IS NOT NULL`,
  );
  const out = new Map<string, LocalVersion>();
  for (const r of rows) {
    const sp = Object.hasOwn(SYSTEM_PAGES, r.system_key) ? SYSTEM_PAGES[r.system_key] : undefined;
    if (!sp) continue;
    const target = sp.versions[lang];
    if (r.title === target.title && r.content === target.content) continue;
    const pristine = [...Object.values(sp.versions), ...(sp.legacy ?? [])].some(
      (v) => v.title === r.title && v.content === r.content,
    );
    if (pristine) out.set(r.slug, target);
  }
  return out;
});

/** Same item with the title in the reader's language (only for unedited built-in pages). */
export function localTitle<T extends { slug: string; title: string }>(item: T, local: Map<string, LocalVersion>): T {
  const v = local.get(item.slug);
  return v ? { ...item, title: v.title } : item;
}

/** Same page with title and text in the reader's language (only for unedited built-in pages). */
export function localPage<T extends { slug: string; title: string; content: string }>(
  page: T,
  local: Map<string, LocalVersion>,
): T {
  const v = local.get(page.slug);
  return v ? { ...page, title: v.title, content: v.content } : page;
}

type Node = { slug: string; title: string; children: Node[] };
/** The page tree with titles in the reader's language. */
export function localTree<T extends Node>(nodes: T[], local: Map<string, LocalVersion>): T[] {
  if (local.size === 0) return nodes;
  return nodes.map((n) => ({ ...localTitle(n, local), children: localTree(n.children as T[], local) }));
}
