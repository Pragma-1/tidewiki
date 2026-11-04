"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, RotateCcw } from "lucide-react";
import { call } from "@/lib/client-api";
import { useT } from "./i18n";
import { useConfirm } from "./confirm";

export function DeleteButton({ slug, title }: { slug: string; title: string }) {
  const t = useT();
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [dialog, confirm] = useConfirm();
  return (
    <>
      {dialog}
      <button
        type="button"
        className="btn danger sm"
        onClick={async () => {
          if (
            !(await confirm({
              title: t("Delete page?"),
              body: t(
                "Delete “{title}” and its history? Pages inside it move to the top level. This can’t be undone.",
                { title },
              ),
              confirmLabel: t("Delete page"),
              danger: true,
            }))
          )
            return;
          const r = await call(`/api/pages/${slug}`, "DELETE");
          if (r.ok) {
            router.push("/");
            router.refresh();
          } else setErr(t(r.data.error ?? "Couldn’t delete."));
        }}
      >
        <Trash2 size={15} aria-hidden />
        {t("Delete")}
      </button>
      {err && (
        <span className="error-text" role="alert">
          {err}
        </span>
      )}
    </>
  );
}

export function RestoreButton({
  slug,
  title,
  content,
  parentId,
  currentRev,
}: {
  slug: string;
  title: string;
  content: string;
  parentId: number | null;
  currentRev: number;
}) {
  const t = useT();
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className="btn sm"
        onClick={async () => {
          const r = await call<{ slug: string }>(`/api/pages/${slug}`, "PUT", {
            title,
            content,
            parentId,
            expectedRev: currentRev,
          });
          if (r.ok) {
            router.push(`/w/${slug}`);
            router.refresh();
          } else setErr(t(r.data.error ?? "Couldn’t restore."));
        }}
      >
        <RotateCcw size={15} aria-hidden />
        {t("Restore this version")}
      </button>
      {err && (
        <span className="error-text" role="alert">
          {err}
        </span>
      )}
    </>
  );
}
