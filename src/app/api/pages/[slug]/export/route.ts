import { api } from "@/lib/api";
import { getPage } from "@/lib/pages";
import { toMarkdownFile } from "@/lib/transfer";
import { download } from "@/lib/download";
import { HttpError, SLUG_RE } from "@/lib/validate";
export const dynamic = "force-dynamic";

// One page as a Markdown file with front matter — signed-in people only.
export const GET = api<{ slug: string }>("user", async ({ params }) => {
  if (!SLUG_RE.test(params.slug) || params.slug.length > 80) throw new HttpError(404, "Page not found.");
  const p = getPage(params.slug);
  if (!p) throw new HttpError(404, "Page not found.");
  return download(toMarkdownFile(p.title, p.content), `${p.slug}.md`, "text/markdown");
});
