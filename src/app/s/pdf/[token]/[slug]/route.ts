import { api } from "@/lib/api";
import { BASE_URL } from "@/lib/config";
import { getPage } from "@/lib/pages";
import { pdfResponse } from "@/lib/pdf-response";
import { consume } from "@/lib/rate-limit";
import { getSettings } from "@/lib/settings";
import { resolveShare } from "@/lib/shares";
import { localPage, localVersions } from "@/lib/system-pages";
import { HttpError, SLUG_RE } from "@/lib/validate";
export const dynamic = "force-dynamic";

/** A page of a shared link as a PDF — only pages the link opens. */
export const GET = api<{ token: string; slug: string }>("public", async ({ params, ip, lang }) => {
  if (ip && !(await consume(`share-view:${ip}`, 300, 300))) throw new HttpError(429, "Slow down a little.");
  if (ip && !(await consume(`pdf:ip:${ip}`, 30, 600))) throw new HttpError(429, "Slow down a little.");
  if (!SLUG_RE.test(params.slug) || params.slug.length > 80) throw new HttpError(404, "Page not found.");
  const scope = await resolveShare(params.token);
  const entry = scope?.pages.find((p) => p.slug === params.slug);
  if (!entry) throw new HttpError(404, "Page not found.");
  const stored = await getPage(entry.slug);
  if (!stored) throw new HttpError(404, "Page not found.");
  const page = localPage(stored, await localVersions(lang));
  return pdfResponse(page, {
    lang,
    siteName: (await getSettings()).site_name,
    // a PDF gets passed on: it carries the wiki's address, never the link's secret token
    pageUrl: BASE_URL,
  });
});
