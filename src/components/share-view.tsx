import Link from "next/link";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { ArrowLeft, ArrowRight, BookOpen, FileDown, Link2 } from "lucide-react";
import { getPage } from "@/lib/pages";
import { renderMarkdown } from "@/lib/markdown";
import { getLang } from "@/lib/i18n-server";
import { formatDate, makeT } from "@/lib/i18n";
import { getSettings, renderSettings } from "@/lib/settings";
import { localPage, localTitle, localVersions } from "@/lib/system-pages";
import { resolveShare, touchShare, type ShareScope } from "@/lib/shares";
import { clientIp } from "@/lib/net";
import { consume } from "@/lib/rate-limit";
import { SLUG_RE } from "@/lib/validate";
import { LangToggle, MenuButton, NavDrawer, ThemeToggle } from "./chrome";
import { EmbedActivator } from "./embeds";

const MEDIA_ATTR = /(\s(?:src|href|poster)=")\/media\/([A-Za-z0-9_-]{16,40}\.(?:png|jpg|gif|webp|mp4|webm|ogv|mov))"/g;
const PAGE_HREF = /(\shref=")\/w\/([a-z0-9]+(?:-[a-z0-9]+)*)((?:#[^"]*)?)"/g;

/**
 * The rendered page's links for a shared link's visitor: pages inside the share stay inside it,
 * files come through the share (the visitor has no other access). Runs on sanitised HTML, whose
 * attribute values are always double-quoted and escaped.
 */
export function rewriteForShare(html: string, token: string, inScope: Set<string>): string {
  return html
    .replace(MEDIA_ATTR, (_m, pre: string, name: string) => `${pre}/s/media/${token}/${name}"`)
    .replace(PAGE_HREF, (m, pre: string, slug: string, hash: string) =>
      inScope.has(slug) ? `${pre}/s/${token}/${slug}${hash}"` : m,
    );
}

/** One request's look-up of a link, with a per-address limit so nobody can hammer the token space. */
export async function shareFor(token: string): Promise<ShareScope> {
  const ip = clientIp(await headers());
  if (ip && !(await consume(`share-view:${ip}`, 300, 300))) notFound();
  const scope = await resolveShare(token);
  if (!scope) notFound();
  return scope;
}

/** The page a share shows at `slug` (the shared page itself without one), or null. */
export function pageInShare(scope: ShareScope, slug?: string) {
  if (slug === undefined) return scope.pages[0];
  if (!SLUG_RE.test(slug) || slug.length > 80) return null;
  return scope.pages.find((p) => p.slug === slug) ?? null;
}

/** Read-only view of a shared page: no account, no menu of the wiki, only what the link opens. */
export async function ShareView({ token, slug }: { token: string; slug?: string }) {
  const scope = await shareFor(token);
  const entry = pageInShare(scope, slug);
  if (!entry) notFound();
  const stored = await getPage(entry.slug);
  if (!stored) notFound();
  await touchShare(scope.id);
  const [cfg, lang] = [await getSettings(), await getLang()];
  const t = makeT(lang);
  const local = await localVersions(lang);
  const page = localPage(stored, local);
  const pages = scope.pages.map((p) => localTitle(p, local));
  const inScope = new Set(pages.map((p) => p.slug));
  const { html } = renderMarkdown(page.content, { lang, ...renderSettings(cfg) });
  const at = pages.findIndex((p) => p.slug === page.slug);
  const prev = at > 0 ? pages[at - 1] : null,
    next = at >= 0 && at < pages.length - 1 ? pages[at + 1] : null;
  const href = (s: string) => `/s/${token}/${s}`;
  return (
    <>
      <a className="skip" href="#main">
        {t("Skip to content")}
      </a>
      <header className="top">
        <div className="top-row share-top">
          {pages.length > 1 && <MenuButton />}
          <span className="brand">
            <BookOpen size={22} aria-hidden />
            {cfg.site_name}
          </span>
          <div className="top-actions">
            <LangToggle />
            <ThemeToggle />
          </div>
        </div>
      </header>
      <div className={`frame${pages.length > 1 ? "" : " share-single"}`}>
        {pages.length > 1 && (
          <NavDrawer>
            <h2>{t("Shared pages")}</h2>
            <ul className="tree share-tree">
              {pages.map((p) => (
                <li key={p.id} style={{ paddingLeft: `${p.depth * 0.9}rem` }}>
                  <Link href={href(p.slug)} aria-current={p.slug === page.slug ? "page" : undefined}>
                    {p.title}
                  </Link>
                </li>
              ))}
            </ul>
          </NavDrawer>
        )}
        <main id="main" className="sheet">
          <div className="notice share-banner" role="note">
            <Link2 size={16} aria-hidden />
            <span>{t("Shared with you as a link: read-only.")}</span>
          </div>
          <div className="doc-head">
            <div>
              <h1>{page.title}</h1>
              <p className="meta">{t("Updated {date}", { date: formatDate(page.updated_at, lang) })}</p>
            </div>
            <div className="row">
              <a className="btn ghost sm" href={`/s/pdf/${token}/${page.slug}`} download>
                <FileDown size={15} aria-hidden />
                {t("PDF")}
              </a>
            </div>
          </div>
          {/* Safe: output of renderMarkdown() (sanitised); only our own link targets are rewritten. */}
          <div className="md" dangerouslySetInnerHTML={{ __html: rewriteForShare(html, token, inScope) }} />
          {(prev || next) && (
            <nav className="pager" aria-label={t("Previous and next page")}>
              {prev ? (
                <Link href={href(prev.slug)} className="pager-prev">
                  <span className="hint">
                    <ArrowLeft size={14} aria-hidden /> {t("Previous")}
                  </span>
                  <strong>{prev.title}</strong>
                </Link>
              ) : (
                <span />
              )}
              {next ? (
                <Link href={href(next.slug)} className="pager-next">
                  <span className="hint">
                    {t("Next")} <ArrowRight size={14} aria-hidden />
                  </span>
                  <strong>{next.title}</strong>
                </Link>
              ) : (
                <span />
              )}
            </nav>
          )}
        </main>
      </div>
      <footer className="site-foot">
        <nav aria-label={t("Legal")}>
          {cfg.legal_privacy_enabled ? (
            <Link href="/privacy">{t("Privacy")}</Link>
          ) : (
            cfg.legal_privacy_url && (
              <a href={cfg.legal_privacy_url} rel="noopener noreferrer">
                {t("Privacy")}
              </a>
            )
          )}
          {cfg.legal_terms_enabled && <Link href="/terms">{t("Terms of use")}</Link>}
          {cfg.legal_imprint_enabled && <Link href="/imprint">{t("Imprint")}</Link>}
        </nav>
        <span>{cfg.site_name}</span>
      </footer>
      <EmbedActivator />
    </>
  );
}

/** Title for the browser tab, never indexed by search engines. */
export async function shareMetadata(token: string, slug?: string) {
  const lang = await getLang();
  const scope = await resolveShare(token);
  const entry = scope ? pageInShare(scope, slug) : null;
  const robots = { index: false, follow: false };
  if (!entry) return { title: makeT(lang)("Page not found"), robots };
  return { title: localTitle(entry, await localVersions(lang)).title, robots };
}
