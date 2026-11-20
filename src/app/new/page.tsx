import { Shell } from "@/components/shell";
import { Editor } from "@/components/editor";
import { gate } from "@/lib/guard";
import { getTree, parentOptions } from "@/lib/pages";
import { levelOf } from "@/lib/access";
import { getLang, getT } from "@/lib/i18n-server";
import { localTree, localVersions } from "@/lib/system-pages";
export const dynamic = "force-dynamic";
export async function generateMetadata() {
  return { title: (await getT())("New page") };
}

export default async function NewPage({
  searchParams,
}: {
  searchParams: Promise<{ parent?: string; import?: string }>;
}) {
  const level = levelOf(await gate("edit"));
  const sp = await searchParams;
  const p = sp.parent;
  const parents = parentOptions(localTree(await getTree(level), await localVersions(await getLang())));
  const parentId = p && /^\d{1,9}$/.test(p) && parents.some((x) => x.id === Number(p)) ? Number(p) : null;
  return (
    <Shell live={false}>
      <Editor
        mode="new"
        initial={{ title: "", content: "", parentId, rev: 0 }}
        parents={parents}
        importMode={sp.import === "1"}
      />
    </Shell>
  );
}
