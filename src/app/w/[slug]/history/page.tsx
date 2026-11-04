import Link from "next/link";
import { notFound } from "next/navigation";
import { diffLines } from "diff";
import { GitCompare } from "lucide-react";
import { Shell } from "@/components/shell";
import { RestoreButton } from "@/components/page-actions";
import { gate } from "@/lib/guard";
import { getPage, getRevision, listRevisions } from "@/lib/pages";
import { renderMarkdown } from "@/lib/markdown";
import { getLang, getT } from "@/lib/i18n-server";
import { formatDate, makeT, type T } from "@/lib/i18n";
import { SLUG_RE } from "@/lib/validate";
import { getSettings } from "@/lib/settings";
export const dynamic = "force-dynamic";
export async function generateMetadata() {
  return { title: (await getT())("History") };
}

const revParam = (v?: string) => (v && /^\d{1,6}$/.test(v) ? Number(v) : undefined);

/** Line diff, rendered as escaped text by React. Long unchanged stretches collapse to 3 lines of context. */
function Diff({ from, to, t }: { from: string; to: string; t: T }) {
  // Time-boxed: two completely different 512 KB versions must not tie up the server.
  const parts = diffLines(from, to, { timeout: 1500, maxEditLength: 20000 });
  if (!parts) return <p className="hint">{t("These versions are too different to compare line by line.")}</p>;
  let added = 0,
    removed = 0;
  const rows: { kind: "add" | "del" | "same" | "skip"; text: string }[] = [];
  for (const p of parts) {
    const lines = p.value.replace(/\n$/, "").split("\n");
    if (p.added) {
      added += lines.length;
      lines.forEach((l) => rows.push({ kind: "add", text: l }));
    } else if (p.removed) {
      removed += lines.length;
      lines.forEach((l) => rows.push({ kind: "del", text: l }));
    } else if (lines.length > 8) {
      lines.slice(0, 3).forEach((l) => rows.push({ kind: "same", text: l }));
      rows.push({ kind: "skip", text: t("{n} unchanged lines", { n: lines.length - 6 }) });
      lines.slice(-3).forEach((l) => rows.push({ kind: "same", text: l }));
    } else lines.forEach((l) => rows.push({ kind: "same", text: l }));
  }
  return (
    <div className="diff">
      <p className="hint">
        <span className="diff-add-count">+{added}</span> <span className="diff-del-count">−{removed}</span> {t("lines")}
      </p>
      {added + removed === 0 ? (
        <p className="hint">{t("The text is identical.")}</p>
      ) : (
        <pre className="diff-body">
          {rows.map((r, i) => (
            <div key={i} className={`dl dl-${r.kind}`}>
              <span className="dm" aria-hidden>
                {r.kind === "add" ? "+" : r.kind === "del" ? "−" : r.kind === "skip" ? "⋯" : " "}
              </span>
              <span className="sr-only">{r.kind === "add" ? t("added") : r.kind === "del" ? t("removed") : ""}</span>
              {r.text || " "}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}

export default async function History({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ rev?: string; from?: string; to?: string }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const user = await gate("user"); // version history only for signed-in people
  if (!SLUG_RE.test(slug)) notFound();
  const page = getPage(slug);
  if (!page) notFound();
  const revs = listRevisions(page.id);
  const lang = await getLang();
  const t = makeT(lang);
  const canEdit = !!user && user.role !== "viewer";
  const fromN = revParam(sp.from),
    toN = revParam(sp.to);
  const comparing = fromN !== undefined && toN !== undefined;
  const from = comparing ? getRevision(page.id, fromN) : undefined,
    to = comparing ? getRevision(page.id, toN) : undefined;
  const wanted = !comparing
    ? revParam(sp.rev) !== undefined
      ? getRevision(page.id, revParam(sp.rev)!)
      : undefined
    : undefined;
  return (
    <Shell active={page.slug} rev={page.rev} wide>
      <div className="crumbs">
        <Link href={`/w/${page.slug}`}>← {t("Back to {title}", { title: page.title })}</Link>
      </div>
      <h1 style={{ marginTop: 0 }}>{t("History")}</h1>
      <div className="history-grid">
        <form className="rev-list" method="get" action={`/w/${page.slug}/history`}>
          <p className="hint">{t("Pick two versions to compare them.")}</p>
          <ul className="recent">
            {revs.map((r, i) => (
              <li key={r.rev}>
                <span className="rev-pick">
                  <input
                    type="radio"
                    name="from"
                    value={r.rev}
                    defaultChecked={fromN !== undefined ? fromN === r.rev : i === 1}
                    aria-label={t("Compare from version {n}", { n: r.rev })}
                  />
                  <input
                    type="radio"
                    name="to"
                    value={r.rev}
                    defaultChecked={toN !== undefined ? toN === r.rev : i === 0}
                    aria-label={t("Compare to version {n}", { n: r.rev })}
                  />
                </span>
                <span className="rev-main">
                  <Link
                    href={`/w/${page.slug}/history?rev=${r.rev}`}
                    aria-current={wanted?.rev === r.rev ? "true" : undefined}
                  >
                    {t("Version {n}", { n: r.rev })}
                  </Link>
                  <span className="meta">
                    {formatDate(r.created_at, lang)} · {r.author ?? t("deleted account or system")}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          {revs.length > 1 && (
            <button className="btn sm" type="submit">
              <GitCompare size={15} aria-hidden />
              {t("Compare")}
            </button>
          )}
        </form>
        <div>
          {comparing && from && to ? (
            <>
              <h2 className="section-title" style={{ marginTop: 0 }}>
                {t("Version {a} → version {b}", { a: from.rev, b: to.rev })}
              </h2>
              {from.title !== to.title && (
                <p className="hint">
                  {t("Title")}: <del>{from.title}</del> → <ins>{to.title}</ins>
                </p>
              )}
              <Diff from={from.content} to={to.content} t={t} />
            </>
          ) : wanted ? (
            <>
              <div className="row between" style={{ marginBottom: "1rem" }}>
                <strong>
                  {wanted.title} — {t("version {n}", { n: wanted.rev })}
                </strong>
                <div className="row">
                  {wanted.rev > 1 && (
                    <Link
                      className="btn ghost sm"
                      href={`/w/${page.slug}/history?from=${wanted.rev - 1}&to=${wanted.rev}`}
                    >
                      <GitCompare size={15} aria-hidden />
                      {t("Changes in this version")}
                    </Link>
                  )}
                  {canEdit && wanted.rev !== page.rev && (
                    <RestoreButton
                      slug={page.slug}
                      title={wanted.title}
                      content={wanted.content}
                      parentId={page.parent_id}
                      currentRev={page.rev}
                    />
                  )}
                </div>
              </div>
              <div
                className="md"
                dangerouslySetInnerHTML={{
                  __html: renderMarkdown(wanted.content, {
                    lang,
                    autoloadExternal: getSettings().external_media_autoload,
                  }).html,
                }}
              />
            </>
          ) : (
            <p className="hint">{t("Pick a version to preview it.")}</p>
          )}
        </div>
      </div>
    </Shell>
  );
}
