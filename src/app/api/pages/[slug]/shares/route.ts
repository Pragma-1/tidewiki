import { api, json } from "@/lib/api";
import { audit } from "@/lib/audit";
import { BASE_URL } from "@/lib/config";
import { consume } from "@/lib/rate-limit";
import { levelOf } from "@/lib/access";
import { getVisiblePage } from "@/lib/pages";
import { createShare, listShares, SHARE_DAYS, type ShareDays } from "@/lib/shares";
import { HttpError, SLUG_RE } from "@/lib/validate";
export const dynamic = "force-dynamic";

type P = { slug: string };
async function pageOf(slug: string, level: ReturnType<typeof levelOf>) {
  if (!SLUG_RE.test(slug) || slug.length > 80) throw new HttpError(404, "Page not found.");
  const page = await getVisiblePage(slug, level);
  if (!page) throw new HttpError(404, "Page not found.");
  return page;
}

/** The page's shared links (administrators). Tokens are never shown again; only their last 4 characters. */
export const GET = api<P>("admin", async ({ params, user }) => {
  const level = levelOf(user);
  const page = await pageOf(params.slug, level);
  return json({ links: await listShares(level, page.id) });
});

/**
 * Makes a shared link (administrators). Body: { section: boolean, days: 1 | 7 | 30 | 90 | 365 | 0 }
 * (0 = until revoked). The answer carries the link — the only time it can be seen.
 */
export const POST = api<P>("admin", async ({ params, user, body, ip }) => {
  if (!(await consume(`share:${user!.id}`, 60, 3600))) throw new HttpError(429, "Slow down a little.");
  const level = levelOf(user);
  const page = await pageOf(params.slug, level);
  const b = await body(1024);
  const days = b.days as ShareDays;
  if (!SHARE_DAYS.includes(days)) throw new HttpError(400, "Choose how long the link works.", "days");
  if (typeof b.section !== "boolean") throw new HttpError(400, "Choose what the link shares.", "section");
  const s = await createShare({ pageId: page.id, section: b.section, days, userId: user!.id, level });
  await audit(
    "page.share_created",
    user!.id,
    ip,
    `${page.slug} (${b.section ? "with sub-pages" : "page"}, ${days ? `${days} d` : "until revoked"}) #${s.id}`,
  );
  return json({ id: s.id, url: `${BASE_URL}/s/${s.token}`, expires_at: s.expires_at }, 201);
});
