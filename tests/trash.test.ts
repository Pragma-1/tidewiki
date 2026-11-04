import "./setup-env";
import { describe, expect, it } from "vitest";
import { addUser, db } from "./pg";
import { now } from "@/lib/db";
import {
  backlinks,
  createPage,
  getPage,
  getRevision,
  listRevisions,
  recentChanges,
  restoreRevision,
  updatePage,
} from "@/lib/pages";
import {
  emptyTrash,
  getTrashItem,
  listTrash,
  purgeOldTrash,
  purgeTrashItem,
  restoreFromTrash,
  trashCount,
  trashId,
  trashPage,
} from "@/lib/trash";
import { purgeExpired } from "@/lib/retention";
import { search } from "@/lib/search";
import { editComment } from "@/lib/validate";

const t0 = Math.floor(Date.now() / 1000);
const uid = await addUser("tr", "editor");
const mk = (title: string, content = "", parentId: number | null = null) =>
  createPage({ title, content, parentId, userId: uid });
const save = async (slug: string, content: string, comment?: string) => {
  const p = (await getPage(slug))!;
  return updatePage(slug, { title: p.title, content, parentId: p.parent_id, expectedRev: p.rev, userId: uid, comment });
};

describe("trash", () => {
  it("moves a page with its whole history, keeps it out of search and back-links, restores it intact", async () => {
    const target = await mk("Ziel");
    const p = await mk("Papierkorbtest", "erste Fassung Zebrafink [[Ziel]]");
    await save(p.slug, "zweite Fassung Zebrafink [[Ziel]]", "Zweiter Stand");
    await save(p.slug, "dritte Fassung Zebrafink [[Ziel]]");
    const revIdsBefore = (
      (await db().prepare("SELECT id FROM page_revisions WHERE page_id=? ORDER BY rev").all(p.id)) as { id: number }[]
    ).map((r) => r.id);
    expect((await backlinks(target.slug)).map((b) => b.slug)).toContain(p.slug);
    expect((await search("zebrafink")).hits.map((h) => h.slug)).toEqual([p.slug]);

    expect((await trashPage(p.slug, uid))?.id).toBe(p.id);
    expect(await getPage(p.slug)).toBeUndefined();
    expect(await db().prepare("SELECT COUNT(*) AS n FROM page_revisions WHERE page_id=?").get(p.id)).toEqual({ n: 0 });
    expect((await search("zebrafink")).hits).toEqual([]);
    expect((await backlinks(target.slug)).map((b) => b.slug)).not.toContain(p.slug);
    expect((await recentChanges(200)).some((r) => r.slug === p.slug)).toBe(false);
    const row = (await listTrash()).find((r) => r.slug === p.slug)!;
    expect(row).toMatchObject({ title: "Papierkorbtest", rev: 3, deleted_by_name: "tr" });
    expect(await trashPage(p.slug, uid)).toBeNull(); // second delete: nothing there

    const { page, slugChanged } = await restoreFromTrash(row.id);
    expect(slugChanged).toBe(false);
    expect(page).toMatchObject({ id: p.id, slug: p.slug, rev: 3, content: "dritte Fassung Zebrafink [[Ziel]]" });
    const revs = await listRevisions(page.id);
    expect(revs.map((r) => r.rev)).toEqual([3, 2, 1]);
    expect(revs[1].comment).toBe("Zweiter Stand");
    // original revision ids → recent changes keep their real order
    expect(
      (
        (await db().prepare("SELECT id FROM page_revisions WHERE page_id=? ORDER BY rev").all(p.id)) as { id: number }[]
      ).map((r) => r.id),
    ).toEqual(revIdsBefore);
    expect((await search("zebrafink")).hits.map((h) => h.slug)).toEqual([p.slug]);
    expect((await backlinks(target.slug)).map((b) => b.slug)).toContain(p.slug);
    expect(await getTrashItem(row.id)).toBeUndefined();
    await expect(restoreFromTrash(row.id)).rejects.toThrow(/no longer in the trash/);
  });

  it("restores under a new address if the old one was taken, and re-files sub-pages and chapter", async () => {
    const chapter = await mk("Kapitel T");
    const parent = await mk("Elternseite", "", chapter.id);
    const kid1 = await mk("Kind eins", "", parent.id);
    const kid2 = await mk("Kind zwei", "", parent.id);
    await trashPage(parent.slug, uid);
    expect((await getPage(kid1.slug))!.parent_id).toBeNull(); // sub-pages stay, at the top level
    // meanwhile: someone files kid2 elsewhere and creates a new page at the old address
    await updatePage(kid2.slug, { title: "Kind zwei", content: "", parentId: chapter.id, expectedRev: 1, userId: uid });
    const squatter = await mk("Elternseite");
    expect(squatter.slug).toBe(parent.slug);
    const item = (await listTrash()).find((r) => r.page_id === parent.id)!;
    const { page, slugChanged } = await restoreFromTrash(item.id);
    expect(slugChanged).toBe(true);
    expect(page.slug).toBe(`${parent.slug}-2`);
    expect(page.parent_id).toBe(chapter.id);
    expect((await getPage(kid1.slug))!.parent_id).toBe(page.id); // pulled back under it
    expect((await getPage(kid2.slug))!.parent_id).toBe(chapter.id); // filed elsewhere meanwhile: left alone
  });

  it("falls back to the top level when the old chapter is gone", async () => {
    const ch = await mk("Weg-Kapitel");
    const p = await mk("Waise", "", ch.id);
    await trashPage(p.slug, uid);
    await trashPage(ch.slug, uid);
    const item = (await listTrash()).find((r) => r.page_id === p.id)!;
    expect((await restoreFromTrash(item.id)).page.parent_id).toBeNull();
  });

  it("purges single items, everything, and anything older than 30 days (hourly job)", async () => {
    const a = await mk("Alt"),
      b = await mk("Frisch"),
      c = await mk("Einzeln");
    for (const p of [a, b, c]) await trashPage(p.slug, uid);
    const ids = Object.fromEntries((await listTrash()).map((r) => [r.slug, r.id]));
    await db()
      .prepare("UPDATE trash SET deleted_at=? WHERE id=?")
      .run(now() - 31 * 86400, ids[a.slug]);
    await db()
      .prepare("UPDATE trash SET deleted_at=? WHERE id=?")
      .run(now() - 29 * 86400, ids[b.slug]);
    expect((await purgeExpired()).trash).toBe(1);
    expect(await getTrashItem(ids[a.slug])).toBeUndefined();
    expect(await db().prepare("SELECT COUNT(*) AS n FROM trash_revisions WHERE trash_id=?").get(ids[a.slug])).toEqual({
      n: 0,
    });
    expect(await getTrashItem(ids[b.slug])).toBeDefined();
    expect(await purgeOldTrash()).toBe(0);
    expect((await purgeTrashItem(ids[c.slug]))?.slug).toBe(c.slug);
    expect(await purgeTrashItem(ids[c.slug])).toBeUndefined();
    const n = await trashCount();
    expect(n).toBeGreaterThan(0);
    expect(await emptyTrash()).toBe(n);
    expect(await trashCount()).toBe(0);
    expect(await db().prepare("SELECT COUNT(*) AS n FROM trash_revisions").get()).toEqual({ n: 0 });
  });

  it("a deleted account doesn't break the trash", async () => {
    const u = await addUser("gone", "editor");
    const p = await createPage({ title: "Von Gone", content: "x", parentId: null, userId: u });
    await trashPage(p.slug, u);
    await db().prepare("DELETE FROM users WHERE id=?").run(u);
    const row = (await listTrash()).find((r) => r.page_id === p.id)!;
    expect(row.deleted_by_name).toBeNull();
    expect((await restoreFromTrash(row.id)).page.created_by).toBeNull();
  });

  it("rejects malformed ids", async () => {
    for (const bad of ["0", "-1", "1e3", "abc", "1.5", "99999999999999999", " 1", "1/../2"])
      expect(() => trashId(bad)).toThrow(/no longer in the trash/);
    expect(trashId("42")).toBe(42);
  });
});

describe("versions", () => {
  it("restores an older version as a new one on top and records where it came from", async () => {
    const p = await mk("Versioniert", "eins");
    await save(p.slug, "zwei", "Zweiter Entwurf");
    await save(p.slug, "drei");
    const r = await restoreRevision(p.slug, 1, { expectedRev: 3, userId: uid });
    expect(r).toMatchObject({ rev: 4, content: "eins" });
    const v4 = (await getRevision(p.id, 4))!;
    expect(v4.restored_from).toBe(1);
    expect((await getRevision(p.id, 2))!.comment).toBe("Zweiter Entwurf");
    expect((await listRevisions(p.id)).map((x) => x.rev)).toEqual([4, 3, 2, 1]); // nothing overwritten
    // identical → refused; stale editor → conflict; unknown version → 404
    await expect(restoreRevision(p.slug, 4, { expectedRev: 4, userId: uid })).rejects.toThrow(/identical/);
    await expect(restoreRevision(p.slug, 1, { expectedRev: 4, userId: uid })).rejects.toThrow(/identical/);
    await expect(restoreRevision(p.slug, 2, { expectedRev: 3, userId: uid })).rejects.toThrow(/Someone else saved/);
    await expect(restoreRevision(p.slug, 99, { expectedRev: 4, userId: uid })).rejects.toThrow(/doesn’t exist/);
    await expect(restoreRevision("nope", 1, { expectedRev: 1, userId: uid })).rejects.toThrow(/not found/);
    const rc = (await recentChanges(5)).find((x) => x.slug === p.slug && x.rev === 4)!;
    expect(rc.restored_from).toBe(1);
  });

  it("pages through long histories", async () => {
    const p = await mk("Lang", "0");
    for (let i = 1; i < 130; i++) await save(p.slug, String(i));
    const first = await listRevisions(p.id);
    expect(first).toHaveLength(100);
    expect(first[0].rev).toBe(130);
    const rest = await listRevisions(p.id, first[first.length - 1].rev);
    expect(rest.map((r) => r.rev)).toEqual(Array.from({ length: 30 }, (_, i) => 30 - i));
  });

  it("edit summaries are one short line", async () => {
    expect(editComment(undefined)).toBeNull();
    expect(editComment("  ")).toBeNull();
    expect(editComment(" Tippfehler ")).toBe("Tippfehler");
    for (const bad of ["a\nb", "a\rb", "a\tb", "x‮y", "a b", "a".repeat(201), "\u0000", 5, {}])
      expect(() => editComment(bad)).toThrow();
  });
});
