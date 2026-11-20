import { api } from "@/lib/api";
import { BASE_URL } from "@/lib/config";
import { levelOf } from "@/lib/access";
import { getVisiblePage } from "@/lib/pages";
import { pdfResponse } from "@/lib/pdf-response";
import { consume } from "@/lib/rate-limit";
import { getSettings } from "@/lib/settings";
import { localPage, localVersions } from "@/lib/system-pages";
import { HttpError, SLUG_RE } from "@/lib/validate";
export const dynamic = "force-dynamic";

/** A page as a PDF, for everyone who may read it (signed out too, when the wiki is readable without an account). */
export const GET = api<{ slug: string }>(
  "public",
  async ({ params, user, ip, lang }) => {
    if (!SLUG_RE.test(params.slug) || params.slug.length > 80) throw new HttpError(404, "Page not found.");
    // per person or address (an unknown address has no bucket: one visitor mustn't use up everyone's;
    // the two-at-a-time limit and the cache protect the server either way)
    const who = user ? `u${user.id}` : ip ? `ip:${ip}` : null;
    if (who && !(await consume(`pdf:${who}`, 30, 600))) throw new HttpError(429, "Slow down a little.");
    const stored = await getVisiblePage(params.slug, levelOf(user));
    if (!stored) throw new HttpError(404, "Page not found.");
    const page = localPage(stored, await localVersions(lang));
    return pdfResponse(page, {
      lang,
      siteName: (await getSettings()).site_name,
      pageUrl: `${BASE_URL}/w/${page.slug}`,
    });
  },
  { readGate: true },
);
