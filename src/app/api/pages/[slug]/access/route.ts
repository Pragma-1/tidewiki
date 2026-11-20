import { api, json } from "@/lib/api";
import { audit } from "@/lib/audit";
import { consume } from "@/lib/rate-limit";
import { accessInfo, accessLevel, accessName, levelOf } from "@/lib/access";
import { setPageAccess, getVisiblePage } from "@/lib/pages";
import { HttpError, SLUG_RE } from "@/lib/validate";
export const dynamic = "force-dynamic";

/**
 * Who may see a page and its sub-pages. Body: { access: "all" | "admins" | "owner" }.
 * Administrators; "only the owner" is the owner's to set (an administrator would lock themselves out).
 */
export const PUT = api<{ slug: string }>("admin", async ({ body, user, params, ip }) => {
  if (!SLUG_RE.test(params.slug) || params.slug.length > 80) throw new HttpError(404, "Page not found.");
  if (!(await consume(`write:${user!.id}`, 120, 600))) throw new HttpError(429, "Slow down a little.");
  const level = levelOf(user);
  const page = await getVisiblePage(params.slug, level);
  if (!page) throw new HttpError(404, "Page not found.");
  const b = await body(1024);
  const want = accessLevel(b.access);
  if (want === null) throw new HttpError(400, "Choose who may see the page.", "access");
  if (want > level) throw new HttpError(403, "Only the owner can make a page visible to the owner alone.");
  const before = await accessInfo(page.id);
  if (before.own !== want) {
    await setPageAccess(page.id, want, before.effective);
    await audit(
      "page.access_changed",
      user!.id,
      ip,
      `${page.slug}: ${accessName(before.own)} → ${accessName(want)}${before.inherited ? ` (inherits ${accessName(before.inherited)})` : ""}`,
    );
  }
  const after = await accessInfo(page.id);
  return json({ access: accessName(after.own), effective: accessName(after.effective) });
});
