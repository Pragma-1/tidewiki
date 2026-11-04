import { api, json } from "@/lib/api";
import { LIMITS } from "@/lib/config";
import { createPage } from "@/lib/pages";
import { HttpError, int, str } from "@/lib/validate";
import { audit } from "@/lib/audit";
import { consume } from "@/lib/rate-limit";
export const dynamic = "force-dynamic";

export const POST = api("editor", async ({ body, user, ip }) => {
  if (!consume(`write:${user!.id}`, 120, 600)) throw new HttpError(429, "Slow down a little.");
  const b = await body(LIMITS.pageBytes + 8192);
  const title = str(b.title, "Title", { max: LIMITS.titleChars });
  const content = str(b.content, "Content", { max: LIMITS.pageBytes, optional: true, trim: false });
  const parentId = b.parentId === null || b.parentId === undefined ? null : int(b.parentId, "Chapter");
  if (Buffer.byteLength(content) > LIMITS.pageBytes) throw new HttpError(413, "This page is too large.");
  const p = createPage({ title, content, parentId, userId: user!.id });
  audit("page.created", user!.id, ip, `${p.slug} (${p.title})`);
  return json({ slug: p.slug, rev: p.rev }, 201);
});
