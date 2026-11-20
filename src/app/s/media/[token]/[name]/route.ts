import { api } from "@/lib/api";
import { all, sql } from "@/lib/db";
import { MEDIA_FILE_NAME, serveMedia } from "@/lib/media-serve";
import { consume } from "@/lib/rate-limit";
import { resolveShare } from "@/lib/shares";
import { HttpError } from "@/lib/validate";
export const dynamic = "force-dynamic";

/**
 * A file shown by a shared page, for the link's visitors: only files that a page inside the share
 * shows right now — the link opens nothing else of the media library.
 */
export const GET = api<{ token: string; name: string }>("public", async ({ params, req, ip }) => {
  if (ip && !(await consume(`share-view:${ip}`, 300, 300))) throw new HttpError(429, "Slow down a little.");
  if (!MEDIA_FILE_NAME.test(params.name)) throw new HttpError(404, "File not found.");
  const scope = await resolveShare(params.token);
  if (!scope) throw new HttpError(404, "File not found.");
  const shown = await all(
    sql`SELECT 1 FROM pages WHERE id = ANY(${scope.pages.map((p) => p.id)}::bigint[])
          AND strpos(content, ${`/media/${params.name}`}) > 0 LIMIT 1`,
  );
  if (!shown.length) throw new HttpError(404, "File not found.");
  return serveMedia(params.name, req, { "X-Robots-Tag": "noindex, nofollow" });
});
