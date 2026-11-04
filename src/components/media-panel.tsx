"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, ExternalLink, Film, Trash2 } from "lucide-react";
import { call } from "@/lib/client-api";
import { useToast } from "./ui";
import { useConfirm } from "./confirm";
import { useDate, useT } from "./i18n";

type File = {
  id: number;
  name: string;
  mime: string;
  kind: "image" | "video";
  size: number;
  original_name: string | null;
  username: string | null;
  created_at: number;
  used_in: number;
};
const size = (b: number) =>
  b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;

export function MediaPanel({ files, used, quota }: { files: File[]; used: number; quota: number }) {
  const t = useT();
  const date = useDate();
  const router = useRouter();
  const toast = useToast();
  const setNote = toast.show;
  const [filter, setFilter] = useState<"all" | "unused">("all");
  const [dialog, confirm] = useConfirm();
  const del = async (f: File) => {
    const ok = await confirm({
      title: t("Delete this file permanently?"),
      confirmLabel: t("Delete"),
      danger: true,
      body: (
        <>
          <strong>{f.original_name ?? f.name}</strong>
          {f.used_in ? (
            <p>{t("This file is still used on {n} page(s); it will show as broken there.", { n: f.used_in })}</p>
          ) : null}
        </>
      ),
    });
    if (!ok) return;
    const r = await call(`/api/media/${f.id}`, "DELETE");
    if (r.ok) {
      setNote({ ok: true, text: t("File deleted.") });
      router.refresh();
    } else setNote({ ok: false, text: t(r.data.error ?? "Something went wrong.") });
  };
  const shown = files.filter((f) => filter === "all" || f.used_in === 0);
  return (
    <section>
      <div className="row between section-head">
        <div className="usage" title={`${size(used)} / ${size(quota)}`}>
          <span className="hint">{t("{used} of {quota} used", { used: size(used), quota: size(quota) })}</span>
          <span className="bar">
            <span style={{ width: `${Math.min(100, (used / quota) * 100)}%` }} />
          </span>
        </div>
        <select
          className="input"
          style={{ width: "12rem" }}
          value={filter}
          onChange={(e) => setFilter(e.target.value as "all" | "unused")}
          aria-label={t("Show")}
        >
          <option value="all">{t("All files")}</option>
          <option value="unused">{t("Unused files only")}</option>
        </select>
      </div>
      {toast.node}
      {dialog}
      <p className="hint">
        {t(
          "Editors upload images and videos in the page editor (button, paste or drag & drop). Metadata such as GPS location is removed from images on upload.",
        )}
      </p>
      <div className="table-wrap">
        <table className="data media-table">
          <thead>
            <tr>
              <th>{t("File")}</th>
              <th>{t("Size")}</th>
              <th>{t("Uploaded")}</th>
              <th>{t("Used on")}</th>
              <th>
                <span className="sr-only">{t("Actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((f) => (
              <tr key={f.id}>
                <td>
                  <div className="file-cell">
                    {f.kind === "image" ? (
                      <img src={`/media/${f.name}`} alt="" loading="lazy" />
                    ) : (
                      <span className="thumb">
                        <Film size={20} aria-hidden />
                      </span>
                    )}
                    <span>
                      <strong>{f.original_name ?? f.name}</strong>
                      <br />
                      <span className="hint mono">{f.mime}</span>
                    </span>
                  </div>
                </td>
                <td className="nowrap">{size(f.size)}</td>
                <td className="nowrap">
                  {date(f.created_at)}
                  <br />
                  <span className="hint">{f.username ?? t("deleted account")}</span>
                </td>
                <td>
                  {f.used_in ? t("{n} page(s)", { n: f.used_in }) : <span className="badge warn">{t("unused")}</span>}
                </td>
                <td className="right nowrap">
                  <button
                    type="button"
                    className="btn ghost sm"
                    title={t("Copy Markdown")}
                    onClick={() =>
                      void navigator.clipboard?.writeText(
                        f.kind === "video"
                          ? `@[${f.original_name ?? ""}](/media/${f.name})`
                          : `![${f.original_name ?? ""}](/media/${f.name})`,
                      )
                    }
                  >
                    <Copy size={15} aria-hidden />
                  </button>{" "}
                  <a
                    className="btn ghost sm"
                    href={`/media/${f.name}`}
                    target="_blank"
                    rel="noreferrer"
                    title={t("Open")}
                  >
                    <ExternalLink size={15} aria-hidden />
                  </a>{" "}
                  <button type="button" className="btn danger sm" onClick={() => void del(f)} title={t("Delete")}>
                    <Trash2 size={15} aria-hidden />
                  </button>
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={5} className="hint" style={{ textAlign: "center", padding: "2rem" }}>
                  {t("No files yet.")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
