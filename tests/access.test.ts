import "./setup-env";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addUser, db } from "./pg";
import { now } from "@/lib/db";
import { accessInfo, accessLevel, effectiveAccess, hiddenPages, levelOf, type Level } from "@/lib/access";
import {
  backlinks,
  createPage,
  getPage,
  getTree,
  getVisiblePage,
  listPages,
  pageCount,
  readingOrder,
  recentChanges,
  recentPages,
  setPageAccess,
  updatePage,
  type TreeNode,
} from "@/lib/pages";
import { listTrash, restoreFromTrash, trashCount, trashPage, trashPages, getTrashItem } from "@/lib/trash";
import { search } from "@/lib/search";
import { subscribe, type WikiEvent } from "@/lib/events";
import { isPrivateMedia, privateMedia, storeUpload, deleteMediaMany } from "@/lib/media";
import {
  createShare,
  listShares,
  purgeExpiredShares,
  resolveShare,
  revokeAllShares,
  revokeShare,
  TOKEN_RE,
} from "@/lib/shares";
import { rewriteForShare } from "@/components/share-view";

const owner = await addUser("owner", "admin", 1);
const admin = await addUser("admin2", "admin");
const editor = await addUser("ed", "editor");
const mk = (title: string, parentId: number | null = null, content = "", level: Level = 2, access?: Level) =>
  createPage({ level, title, content, parentId, userId: owner, access });
const slugs = (ns: TreeNode[]): string[] => ns.flatMap((n) => [n.slug, ...slugs(n.children)]);
const setAccess = async (id: number, a: Level) => setPageAccess(id, a, await effectiveAccess(id));

// a small wiki: a public chapter, an admin section with a sub-page, an owner-only page inside
// the public chapter, and links between them
const pub = await mk("Handbuch");
const pubChild = await mk("Anleitung", pub.id, "siehe [[Personal]] und [[Geheimnis]]");
const adm = await mk("Personal", null, "Gehälter und so");
const admChild = await mk("Personalakten", adm.id, "Unterseite von Personal, verlinkt [[Handbuch]]");
const own = await mk("Geheimnis", pub.id, "nur für mich: Tresorcode");
await setAccess(adm.id, 1);
await setAccess(own.id, 2);

describe("access levels", () => {
  it("who sees how far", () => {
    expect(levelOf(null)).toBe(0);
    expect(levelOf({ role: "viewer", isOwner: false })).toBe(0);
    expect(levelOf({ role: "editor", isOwner: false })).toBe(0);
    expect(levelOf({ role: "admin", isOwner: false })).toBe(1);
    expect(levelOf({ role: "admin", isOwner: true })).toBe(2);
    expect(levelOf({ role: "admin", isOwner: true, needs2faSetup: true })).toBe(0);
    expect(accessLevel("all")).toBe(0);
    expect(accessLevel("owner")).toBe(2);
    for (const bad of ["", "ALL", "__proto__", 1, null, undefined, "admin"]) expect(accessLevel(bad)).toBeNull();
  });

  it("a section's level covers its sub-pages; the strictest level on the way up counts", async () => {
    expect(await effectiveAccess(pub.id)).toBe(0);
    expect(await effectiveAccess(admChild.id)).toBe(1);
    expect(await effectiveAccess(own.id)).toBe(2);
    expect([...(await hiddenPages(0))].sort()).toEqual([adm.id, admChild.id, own.id].sort());
    expect([...(await hiddenPages(1))]).toEqual([own.id]);
    expect((await hiddenPages(2)).size).toBe(0);
    const info = await accessInfo(admChild.id);
    expect(info).toMatchObject({ own: 0, inherited: 1, effective: 1, from: { slug: adm.slug } });
    // a sub-page can be stricter than its chapter, never more open
    await setAccess(admChild.id, 2);
    expect(await effectiveAccess(admChild.id)).toBe(2);
    await setAccess(admChild.id, 0);
    expect(await effectiveAccess(admChild.id)).toBe(1);
    expect(await effectiveAccess(999999)).toBe(2); // unknown: as closed as it gets
  });

  it("menu, lists, counts, search, history and links leave out what someone may not see", async () => {
    expect(slugs(await getTree(0))).toEqual([pub.slug, pubChild.slug]);
    expect(slugs(await getTree(1)).sort()).toEqual([pub.slug, pubChild.slug, adm.slug, admChild.slug].sort());
    expect(slugs(await getTree(2))).toHaveLength(5);
    expect((await readingOrder(0)).map((x) => x.slug)).not.toContain(own.slug);
    expect((await listPages(0)).map((p) => p.slug).sort()).toEqual([pub.slug, pubChild.slug].sort());
    expect(await pageCount(0)).toBe(2);
    expect(await pageCount(2)).toBe(5);
    expect((await recentPages(0, 50)).map((p) => p.slug)).not.toContain(adm.slug);
    const changes0 = (await recentChanges(0, 100)).map((r) => r.slug);
    expect(changes0).not.toContain(adm.slug);
    expect(changes0).not.toContain(own.slug);
    expect((await recentChanges(1, 100)).map((r) => r.slug)).toContain(admChild.slug);
    // search: by title and by text
    expect((await search("Gehälter", { level: 0 })).hits).toEqual([]);
    expect((await search("Gehälter", { level: 1 })).hits.map((h) => h.slug)).toEqual([adm.slug]);
    expect((await search("Tresorcode", { level: 1 })).hits).toEqual([]);
    expect((await search("Tresorcode", { level: 2 })).hits.map((h) => h.slug)).toEqual([own.slug]);
    expect((await search("Personalakten", { level: 1 })).hits.map((h) => h.slug)).toEqual([admChild.slug]);
    // "linked from" only names pages the reader sees
    expect((await backlinks(pub.slug, 0)).map((b) => b.slug)).toEqual([]);
    expect((await backlinks(pub.slug, 1)).map((b) => b.slug)).toEqual([admChild.slug]);
  });

  it("a private page doesn't exist for those who may not see it: reading, editing, moving under it", async () => {
    expect(await getVisiblePage(adm.slug, 0)).toBeUndefined();
    expect(await getVisiblePage(adm.slug, 1)).toBeDefined();
    expect(await getVisiblePage(own.slug, 1)).toBeUndefined();
    const p = (await getPage(own.slug))!;
    await expect(
      updatePage(own.slug, {
        level: 1,
        title: "übernommen",
        content: "x",
        parentId: p.parent_id,
        expectedRev: p.rev,
        userId: admin,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect((await getPage(own.slug))!.content).toBe("nur für mich: Tresorcode");
    // an editor can't file a page under a chapter they don't see — same answer as a chapter that doesn't exist
    await expect(
      createPage({ level: 0, title: "Eingeschmuggelt", content: "", parentId: adm.id, userId: editor }),
    ).rejects.toMatchObject({
      status: 400,
      message: "The selected chapter does not exist.",
    });
    const e = (await getPage(pubChild.slug))!;
    await expect(
      updatePage(pubChild.slug, {
        level: 0,
        title: e.title,
        content: e.content,
        parentId: own.id,
        expectedRev: e.rev,
        userId: editor,
      }),
    ).rejects.toMatchObject({ status: 400 });
    // a new page under a private chapter is private right away
    const inside = await createPage({
      level: 1,
      title: "Neu im Personal",
      content: "",
      parentId: adm.id,
      userId: admin,
    });
    expect(await effectiveAccess(inside.id)).toBe(1);
    // and nobody can create a page more private than they may see
    const capped = await createPage({
      level: 1,
      title: "Gekappt",
      content: "",
      parentId: null,
      userId: admin,
      access: 2,
    });
    expect((await getPage(capped.slug))!.access).toBe(1);
  });

  it("moving a page never makes it more visible; it keeps the level it had", async () => {
    const sub = await mk("Gehaltsliste", adm.id);
    expect(await effectiveAccess(sub.id)).toBe(1);
    const p = (await getPage(sub.slug))!;
    await updatePage(sub.slug, {
      level: 1,
      title: p.title,
      content: p.content,
      parentId: null,
      expectedRev: p.rev,
      userId: admin,
    });
    expect(await effectiveAccess(sub.id)).toBe(1);
    expect((await getPage(sub.slug))!.access).toBe(1);
    expect(slugs(await getTree(0))).not.toContain(sub.slug);
  });

  it("deleting a private chapter keeps its sub-pages private; the trash keeps the level", async () => {
    const sec = await mk("Vorstand");
    const kid = await mk("Protokolle", sec.id, "vertraulich");
    await setAccess(sec.id, 1);
    await trashPage(sec.slug, owner);
    // the sub-page moved to the top level, but stays as private as it was
    expect((await getPage(kid.slug))!.parent_id).toBeNull();
    expect(await effectiveAccess(kid.id)).toBe(1);
    expect(slugs(await getTree(0))).not.toContain(kid.slug);
    // the trash: only for those who saw it
    expect((await listTrash(0)).map((x) => x.slug)).not.toContain(sec.slug);
    expect((await listTrash(1)).map((x) => x.slug)).toContain(sec.slug);
    const id = (await listTrash(1)).find((x) => x.slug === sec.slug)!.id;
    expect(await getTrashItem(id, 0)).toBeUndefined();
    expect(await trashCount(0)).toBe((await listTrash(0)).length);
    await expect(restoreFromTrash(id, 0)).rejects.toMatchObject({ status: 404 });
    const back = await restoreFromTrash(id, 1);
    expect(await effectiveAccess(back.page.id)).toBe(1);
    expect((await getPage(kid.slug))!.parent_id).toBe(back.page.id);
    // bulk delete: pages someone can't see count as missing and are never touched
    const r = await trashPages([kid.slug, pubChild.slug], editor, 0, () => true);
    expect(r).toMatchObject({ missing: 1 });
    expect(await getPage(kid.slug)).toBeDefined();
    expect(await getPage(pubChild.slug)).toBeUndefined();
    const t = (await listTrash(0)).find((x) => x.slug === pubChild.slug)!;
    await restoreFromTrash(t.id, 0);
  });

  it("live events reach only readers who may see the page; titles are never sent", async () => {
    const got: WikiEvent[] = [];
    const off = subscribe((e) => got.push(e));
    const a = await mk("Live intern", adm.id);
    await new Promise((r) => setTimeout(r, 20));
    off();
    const e = got.find((x) => x.slug === a.slug)!;
    expect(e).toMatchObject({ type: "page.created", access: 1 });
    expect(JSON.stringify(e)).not.toContain("Live intern");
    // a change of visibility reaches everyone who saw it before
    const got2: WikiEvent[] = [];
    const off2 = subscribe((x) => got2.push(x));
    await setAccess(pub.id, 1);
    await setAccess(pub.id, 0);
    await new Promise((r) => setTimeout(r, 20));
    off2();
    expect(got2.filter((x) => x.slug === pub.slug).map((x) => [x.type, x.access])).toEqual([
      ["page.access", 0],
      ["page.access", 0],
    ]);
  });
});

describe("files of private pages", () => {
  const fx = (n: string) => readFileSync(path.join(import.meta.dirname, "fixtures", n));
  const stream = (b: Buffer) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(b));
        c.close();
      },
    });

  it("a file only private pages show is private too; shown on a visible page, it isn't", async () => {
    const img = await storeUpload(stream(fx("meta.png")), 0, "plan.png", owner);
    const p = await mk("Tresorplan", own.id, `![](/media/${img.name})`);
    expect(await isPrivateMedia(img.name, 0)).toBe(true);
    expect(await isPrivateMedia(img.name, 1)).toBe(true);
    expect(await isPrivateMedia(img.name, 2)).toBe(false);
    expect((await privateMedia(1)).has(img.name)).toBe(true);
    // nobody can delete a file they can't see (it is "missing")
    expect(await deleteMediaMany([img.id], { id: admin, role: "admin", isOwner: false })).toEqual([]);
    // a public page shows it too: not private any more
    const shown = await mk("Öffentlich mit Bild", null, `![](/media/${img.name})`);
    expect(await isPrivateMedia(img.name, 0)).toBe(false);
    await trashPage(shown.slug, owner);
    expect(await isPrivateMedia(img.name, 0)).toBe(true);
    // deleted private page in the trash: still private
    await trashPage(p.slug, owner);
    expect(await isPrivateMedia(img.name, 1)).toBe(true);
    // unused files and files of the look aren't private
    const free = await storeUpload(stream(fx("meta.png")), 0, "frei.png", owner);
    expect(await isPrivateMedia(free.name, 0)).toBe(false);
  });
});

describe("shared links", () => {
  it("a link is a 256-bit token; only its hash is stored", async () => {
    const s = await createShare({ pageId: pub.id, section: false, days: 7, userId: admin, level: 1 });
    expect(s.token).toMatch(TOKEN_RE);
    const row = (await db().prepare("SELECT * FROM share_links WHERE id = ?").get(s.id))!;
    expect(JSON.stringify(row)).not.toContain(s.token);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.hint).toBe(s.token.slice(-4));
    expect(Number(row.expires_at) - now()).toBeGreaterThan(7 * 86400 - 10);
    const scope = (await resolveShare(s.token))!;
    expect(scope.pages.map((p) => p.slug)).toEqual([pub.slug]); // this page only
  });

  it("anything that isn't a working link resolves to nothing — all failures look the same", async () => {
    for (const bad of [
      "",
      "x",
      "a".repeat(43),
      "a".repeat(44),
      "../../etc/passwd",
      "%00",
      null,
      undefined,
      42,
      { length: 43 },
      "A".repeat(42) + "=",
    ])
      expect(await resolveShare(bad)).toBeNull();
    // expired
    const s = await createShare({ pageId: pub.id, section: false, days: 1, userId: admin, level: 1 });
    await db()
      .prepare("UPDATE share_links SET expires_at = ? WHERE id = ?")
      .run(now() - 1, s.id);
    expect(await resolveShare(s.token)).toBeNull();
    await purgeExpiredShares();
    expect(await db().prepare("SELECT 1 FROM share_links WHERE id = ?").get(s.id)).toBeUndefined();
  });

  it("a section link covers the sub-pages, except those more private than the shared page", async () => {
    const s = await createShare({ pageId: pub.id, section: true, days: 30, userId: owner, level: 2 });
    const scope = (await resolveShare(s.token))!;
    const inScope = scope.pages.map((p) => p.slug);
    expect(inScope[0]).toBe(pub.slug);
    expect(inScope).toContain(pubChild.slug);
    expect(inScope).not.toContain(own.slug); // owner-only below a public chapter: not shared along
    // a private section shared by an administrator: its sub-pages at the same level come along
    const s2 = await createShare({ pageId: adm.id, section: true, days: 0, userId: admin, level: 1 });
    const sc2 = (await resolveShare(s2.token))!;
    expect(sc2.pages.map((p) => p.slug)).toContain(admChild.slug);
    expect(await db().prepare("SELECT expires_at FROM share_links WHERE id = ?").get(s2.id)).toEqual({
      expires_at: null,
    });
  });

  it("a link stops working when its page becomes more private than its maker may see, or the maker loses the role", async () => {
    const p = await mk("Teilbar");
    const s = await createShare({ pageId: p.id, section: false, days: 30, userId: admin, level: 1 });
    expect(await resolveShare(s.token)).not.toBeNull();
    await setAccess(p.id, 2);
    expect(await resolveShare(s.token)).toBeNull();
    await setAccess(p.id, 1);
    expect(await resolveShare(s.token)).not.toBeNull(); // admins may see it again
    await db().prepare("UPDATE users SET role = 'editor' WHERE id = ?").run(admin);
    expect(await resolveShare(s.token)).toBeNull();
    await db().prepare("UPDATE users SET role = 'admin', disabled = 1 WHERE id = ?").run(admin);
    expect(await resolveShare(s.token)).toBeNull();
    await db().prepare("UPDATE users SET disabled = 0 WHERE id = ?").run(admin);
    expect(await resolveShare(s.token)).not.toBeNull();
    // the page is deleted: the link dies with it (and doesn't come back with a restore)
    await trashPage(p.slug, owner);
    expect(await resolveShare(s.token)).toBeNull();
    const item = (await listTrash(2)).find((x) => x.slug === p.slug)!;
    await restoreFromTrash(item.id, 2);
    expect(await resolveShare(s.token)).toBeNull();
    // nobody can share a page they may not see
    await expect(
      createShare({ pageId: own.id, section: false, days: 7, userId: admin, level: 1 }),
    ).rejects.toMatchObject({
      status: 404,
    });
  });

  it("listing and revoking: only links of pages one may see; a revoked link is gone", async () => {
    const s = await createShare({ pageId: own.id, section: false, days: 7, userId: owner, level: 2 });
    expect((await listShares(1)).map((l) => l.page_id)).not.toContain(own.id);
    expect((await listShares(2)).map((l) => l.page_id)).toContain(own.id);
    expect(await revokeShare(s.id, 1)).toBeNull(); // an administrator can't revoke what they can't see
    expect(await resolveShare(s.token)).not.toBeNull();
    expect((await revokeShare(s.id, 2))?.id).toBe(s.id);
    expect(await resolveShare(s.token)).toBeNull();
    const n = await revokeAllShares(1);
    expect(n).toBeGreaterThan(0);
    expect(await listShares(1)).toEqual([]);
  });

  it("at most 20 working links per page", async () => {
    const p = await mk("Viel geteilt");
    for (let i = 0; i < 20; i++) await createShare({ pageId: p.id, section: false, days: 1, userId: owner, level: 2 });
    await expect(createShare({ pageId: p.id, section: false, days: 1, userId: owner, level: 2 })).rejects.toMatchObject(
      {
        status: 409,
      },
    );
  });

  it("a shared page's links stay inside the share; files come through it", () => {
    const html =
      '<p><a href="/w/drin">a</a> <a href="/w/drin#teil">b</a> <a href="/w/draussen">c</a> <a href="https://x.example/w/drin">d</a></p>' +
      '<img src="/media/abcdefghijklmnop.png" alt=""><video src="/media/abcdefghijklmnopqr.mp4"></video>' +
      "<p>/media/abcdefghijklmnop.png as text</p>";
    const out = rewriteForShare(html, "T".repeat(43), new Set(["drin"]));
    expect(out).toContain(`href="/s/${"T".repeat(43)}/drin"`);
    expect(out).toContain(`href="/s/${"T".repeat(43)}/drin#teil"`);
    expect(out).toContain('href="/w/draussen"');
    expect(out).toContain('href="https://x.example/w/drin"');
    expect(out).toContain(`src="/s/media/${"T".repeat(43)}/abcdefghijklmnop.png"`);
    expect(out).toContain(`src="/s/media/${"T".repeat(43)}/abcdefghijklmnopqr.mp4"`);
    expect(out).toContain("<p>/media/abcdefghijklmnop.png as text</p>");
  });
});

describe("personal data export", () => {
  it("lists a person's own versions with the titles they wrote; private pages without their address", async () => {
    const { exportUserData } = await import("@/lib/admin");
    const p = await createPage({ level: 0, title: "Mein Entwurf", content: "x", parentId: null, userId: editor });
    const cur = (await getPage(p.slug))!;
    await setAccess(p.id, 2);
    // the owner renames it afterwards: the editor's export keeps what the editor wrote
    await updatePage(p.slug, {
      level: 2,
      title: "Geheimer neuer Titel",
      content: "y",
      parentId: null,
      expectedRev: cur.rev,
      userId: owner,
    });
    const data = JSON.stringify(await exportUserData(editor, 0));
    expect(data).toContain("Mein Entwurf");
    expect(data).not.toContain("Geheimer neuer Titel");
    expect(data).not.toContain(`"${p.slug}"`);
    // the owner downloading the same person's data sees the address
    expect(JSON.stringify(await exportUserData(editor, 2))).toContain(`"${p.slug}"`);
  });
});
