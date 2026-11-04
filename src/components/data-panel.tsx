"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, FileArchive, Upload } from "lucide-react";
import { Actions, Notice } from "./ui";
import { useT } from "./i18n";

type PlanItem = {
  path: string;
  title: string;
  slug: string;
  parent: string | null;
  action: "create" | "overwrite" | "skip" | "copy";
};
type Result = {
  pages: PlanItem[];
  media: number;
  mediaReused: number;
  warnings: string[];
  created: number;
  updated: number;
  skipped: number;
};

export function DataPanel() {
  const t = useT();
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [conflict, setConflict] = useState<"skip" | "overwrite" | "copy">("skip");
  const [plan, setPlan] = useState<Result | null>(null);
  const [done, setDone] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async (mode: "preview" | "apply") => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/import?mode=${mode}&conflict=${conflict}&name=${encodeURIComponent(file.name.slice(0, 120))}`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/octet-stream" },
          body: file,
        },
      );
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(t(d.error ?? "Something went wrong."));
        return;
      }
      if (mode === "preview") setPlan(d);
      else {
        setDone(d);
        setPlan(null);
        setFile(null);
        router.refresh();
      }
    } catch {
      setError(t("Can’t reach the server. Check your connection."));
    } finally {
      setBusy(false);
    }
  };
  const ACTION = { create: t("new"), overwrite: t("new version"), skip: t("skip"), copy: t("copy") } as const;

  return (
    <div className="settings-grid">
      <section className="panel">
        <h2 className="section-title">
          <Download size={18} aria-hidden /> {t("Export")}
        </h2>
        <p>
          {t(
            "Download the whole wiki as a ZIP: every page as a Markdown file (with its title in the front matter), chapters as folders, and all uploaded files in _media/. The archive can be imported here again or opened with any Markdown tool.",
          )}
        </p>
        <p className="hint">{t("Single pages can be downloaded as .md from the page itself.")}</p>
        <Actions>
          <a className="btn" href="/api/export" download>
            <FileArchive size={16} aria-hidden />
            {t("Export wiki (.zip)")}
          </a>
        </Actions>
      </section>
      <section className="panel">
        <h2 className="section-title">
          <Upload size={18} aria-hidden /> {t("Import")}
        </h2>
        <p>
          {t(
            "Import a ZIP export, any ZIP with a folder of Markdown files, or a single .md file. Folders become chapters; the title comes from the front matter, the first heading or the file name.",
          )}
        </p>
        {error && <Notice kind="error">{error}</Notice>}
        {done && (
          <Notice>
            {t("Import finished: {c} created, {u} updated, {s} skipped, {m} files.", {
              c: done.created,
              u: done.updated,
              s: done.skipped,
              m: done.media,
            })}
          </Notice>
        )}
        <div className="field">
          <label htmlFor="imp-file">{t("File")}</label>
          <input
            id="imp-file"
            ref={input}
            className="input"
            type="file"
            accept=".zip,.md,.markdown,application/zip,text/markdown"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setPlan(null);
              setDone(null);
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="imp-conflict">{t("If a page with the same address exists")}</label>
          <select
            id="imp-conflict"
            className="input"
            value={conflict}
            onChange={(e) => {
              setConflict(e.target.value as typeof conflict);
              setPlan(null);
            }}
          >
            <option value="skip">{t("Keep the existing page (skip)")}</option>
            <option value="overwrite">{t("Save the imported text as a new version")}</option>
            <option value="copy">{t("Import as an additional page")}</option>
          </select>
        </div>
        <Actions>
          <button type="button" className="btn ghost" disabled={!file || busy} onClick={() => void send("preview")}>
            {busy && !plan ? t("Checking…") : t("Preview")}
          </button>
          <button type="button" className="btn" disabled={!plan || busy} onClick={() => void send("apply")}>
            {busy && plan ? t("Importing…") : t("Import now")}
          </button>
        </Actions>
      </section>
      {plan && (
        <section className="panel" style={{ gridColumn: "1 / -1" }}>
          <h2 className="section-title">{t("Preview")}</h2>
          <p className="hint">
            {t("{n} pages, {m} files. Nothing has been changed yet.", { n: plan.pages.length, m: plan.media })}
          </p>
          {plan.warnings.length > 0 && (
            <Notice kind="error">
              <strong>{t("Notes")}:</strong>
              <ul className="plain-list">
                {plan.warnings.slice(0, 50).map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </Notice>
          )}
          <div className="table-wrap audit-box">
            <table className="data">
              <thead>
                <tr>
                  <th>{t("File")}</th>
                  <th>{t("Title")}</th>
                  <th>{t("Chapter")}</th>
                  <th>{t("Action")}</th>
                </tr>
              </thead>
              <tbody>
                {plan.pages.map((p) => (
                  <tr key={p.path}>
                    <td className="mono">{p.path}</td>
                    <td>{p.title}</td>
                    <td>{p.parent ?? <span className="hint">{t("Top level")}</span>}</td>
                    <td>
                      <span className={`badge ${p.action === "skip" ? "" : p.action === "overwrite" ? "warn" : ""}`}>
                        {ACTION[p.action]}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
