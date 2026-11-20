import { notFound } from "next/navigation";
import { Shell } from "@/components/shell";
import { Editor } from "@/components/editor";
import { gate } from "@/lib/guard";
import { getPage, getTree, parentOptions } from "@/lib/pages";
import { SLUG_RE } from "@/lib/validate";
import { getLang, getT } from "@/lib/i18n-server";
import { localPage, localTree, localVersions } from "@/lib/system-pages";
export const dynamic = "force-dynamic";
export async function generateMetadata() {
  return { title: (await getT())("Edit page") };
}

export default async function EditPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  await gate("edit");
  if (!SLUG_RE.test(slug)) notFound();
  const stored = await getPage(slug);
  if (!stored) notFound();
  // an unedited built-in page opens in the editor's language, as it was shown
  const local = await localVersions(await getLang());
  const page = localPage(stored, local);
  return (
    <Shell active={page.slug} rev={page.rev} editing>
      <Editor
        key={page.rev}
        mode="edit"
        slug={page.slug}
        initial={{ title: page.title, content: page.content, parentId: page.parent_id, rev: page.rev }}
        parents={parentOptions(localTree(await getTree(), local), page.id)}
      />
    </Shell>
  );
}
