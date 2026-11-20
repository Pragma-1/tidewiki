"use client";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Copy, Globe, Link2, Lock, Trash2, X } from "lucide-react";
import { call } from "@/lib/client-api";
import { msg } from "@/lib/msg";
import { useDate, useT } from "./i18n";
import { useConfirm } from "./confirm";
import { useToast } from "./ui";

type AccessName = "all" | "admins" | "owner";
const ORDER: AccessName[] = ["all", "admins", "owner"];

/** A modal <dialog> (focus trap, Esc and an inert page for free), styled like the confirmations. */
function Modal({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const t = useT();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`confirm-dlg${wide ? " wide-share" : ""}`}
      aria-labelledby={`${id}-t`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <div className="confirm-box">
          <div className="row between" style={{ alignItems: "flex-start" }}>
            <h2 id={`${id}-t`}>{title}</h2>
            <button type="button" className="icon-btn plain" onClick={onClose} aria-label={t("Close")}>
              <X size={18} aria-hidden />
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}

/* ------------------------------------------------------------- visibility */

const LABEL: Record<AccessName, string> = {
  all: msg("Everyone who can read the wiki"),
  admins: msg("Administrators and the owner"),
  owner: msg("Only the owner"),
};
const HINT: Record<AccessName, string> = {
  all: msg("Like every other page: whoever may read the wiki."),
  admins: msg("Hidden from editors, viewers and visitors."),
  owner: msg("Hidden from everyone else, administrators included."),
};

/** Who may see a page and its sub-pages (administrators; "only the owner" is for the owner). */
export function AccessButton({
  slug,
  own,
  inherited,
  inheritedFrom,
  isOwner,
  subpages,
}: {
  slug: string;
  own: AccessName;
  inherited: AccessName;
  inheritedFrom: string | null;
  isOwner: boolean;
  subpages: number;
}) {
  const t = useT();
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<AccessName>(own);
  const [busy, setBusy] = useState(false);
  const floor = ORDER.indexOf(inherited);
  const effective = ORDER[Math.max(ORDER.indexOf(own), floor)];
  const save = async () => {
    setBusy(true);
    const r = await call<{ access: AccessName; effective: AccessName }>(`/api/pages/${slug}/access`, "PUT", {
      access: choice,
    });
    setBusy(false);
    if (!r.ok) return toast.show({ ok: false, text: t(r.data.error ?? "Couldn’t save.") });
    setOpen(false);
    toast.show({ ok: true, text: t("Saved.") });
    router.refresh();
  };
  return (
    <>
      <button
        type="button"
        className="btn ghost sm"
        onClick={() => {
          setChoice(own);
          setOpen(true);
        }}
        title={t("Who may see this page")}
      >
        {effective === "all" ? <Globe size={15} aria-hidden /> : <Lock size={15} aria-hidden />}
        {t("Visibility")}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={t("Who may see this page?")}>
        <div className="confirm-body">
          <div className="vis-opts" role="radiogroup" aria-label={t("Visibility")}>
            {ORDER.filter((o) => o !== "owner" || isOwner || own === "owner").map((o) => {
              const below = ORDER.indexOf(o) < floor;
              const disabled = below || (o === "owner" && !isOwner);
              return (
                <label key={o} className={`vis-opt${choice === o ? " on" : ""}${disabled ? " off" : ""}`}>
                  <input
                    type="radio"
                    name={`vis-${slug}`}
                    value={o}
                    checked={choice === o}
                    disabled={disabled}
                    onChange={() => setChoice(o)}
                  />
                  <span>
                    {o === "all" ? <Globe size={14} aria-hidden /> : <Lock size={14} aria-hidden />} {t(LABEL[o])}
                    <small>{t(HINT[o])}</small>
                  </span>
                </label>
              );
            })}
          </div>
          {floor > 0 && inheritedFrom && (
            <p>
              {t("The chapter “{title}” above already limits this page to: {who}.", {
                title: inheritedFrom,
                who: t(LABEL[inherited]),
              })}
            </p>
          )}
          {subpages > 0 && (
            <p>
              {subpages === 1
                ? t("Also applies to the page below this one; a sub-page can only be made more private.")
                : t("Also applies to the {n} pages below this one; a sub-page can only be made more private.", {
                    n: subpages,
                  })}
            </p>
          )}
          <p>
            {t(
              "Shared links keep working only as long as the person who made them may still see the page. Moving a page never makes it more visible.",
            )}
          </p>
        </div>
        <div className="confirm-actions">
          <button type="button" className="btn ghost" onClick={() => setOpen(false)}>
            {t("Cancel")}
          </button>
          <button type="button" className="btn" disabled={busy || choice === own} onClick={save}>
            {t("Save")}
          </button>
        </div>
      </Modal>
      {toast.node}
    </>
  );
}

/* ---------------------------------------------------------------- sharing */

export type ShareLink = {
  id: number;
  hint: string;
  slug: string;
  title: string;
  section: number;
  created_at: number;
  expires_at: number | null;
  uses: number;
  last_used_at: number | null;
  creator: string | null;
};
const DAYS = [1, 7, 30, 90, 365, 0] as const;

function LinkRow({ l, onRevoke, showPage }: { l: ShareLink; onRevoke: (l: ShareLink) => void; showPage?: boolean }) {
  const t = useT();
  const date = useDate();
  return (
    <li>
      <div>
        <strong>
          {showPage ? `${l.title} · ` : ""}…{l.hint}
        </strong>{" "}
        · {l.section ? t("with its sub-pages") : t("this page only")}
        <p className="hint">
          {l.expires_at ? t("Works until {date}", { date: date(l.expires_at) }) : t("Works until revoked")}
          {" · "}
          {l.uses
            ? t("opened {n}×, last {date}", { n: l.uses, date: date(l.last_used_at ?? l.created_at) })
            : t("not opened yet")}
          {l.creator ? ` · ${t("by {name}", { name: l.creator })}` : ""}
        </p>
      </div>
      <button type="button" className="btn danger sm" onClick={() => onRevoke(l)}>
        <Trash2 size={14} aria-hidden />
        {t("Revoke")}
      </button>
    </li>
  );
}

function useRevoke(after: () => void) {
  const t = useT();
  const toast = useToast();
  const [dialog, confirm] = useConfirm();
  const revoke = async (l: ShareLink) => {
    if (
      !(await confirm({
        title: t("Revoke this link?"),
        body: t("Whoever has it can no longer open “{title}”. This can’t be undone; you can make a new link.", {
          title: l.title,
        }),
        confirmLabel: t("Revoke"),
        danger: true,
      }))
    )
      return;
    const r = await call(`/api/shares/${l.id}`, "DELETE");
    if (!r.ok) toast.show({ ok: false, text: t(r.data.error ?? "Couldn’t save.") });
    else toast.show({ ok: true, text: t("Link revoked.") });
    after();
  };
  return { revoke, nodes: [dialog, toast.node] as ReactNode[], toast };
}

/** Makes and lists a page's shared links (administrators). */
export function ShareButton({
  slug,
  hasChildren,
  isPrivate,
}: {
  slug: string;
  hasChildren: boolean;
  isPrivate: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [links, setLinks] = useState<ShareLink[] | null>(null);
  const [section, setSection] = useState(false);
  const [days, setDays] = useState<(typeof DAYS)[number]>(30);
  const [made, setMade] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const r = await call<{ links: ShareLink[] }>(`/api/pages/${slug}/shares`, "GET");
    setLinks(r.ok ? r.data.links : []);
  }, [slug]);
  const { revoke, nodes, toast } = useRevoke(() => void load());
  useEffect(() => {
    if (open) void load();
  }, [open, load]);
  const create = async () => {
    setBusy(true);
    const r = await call<{ url: string }>(`/api/pages/${slug}/shares`, "POST", { section, days });
    setBusy(false);
    if (!r.ok) return toast.show({ ok: false, text: t(r.data.error ?? "Couldn’t save.") });
    setMade(r.data.url);
    void load();
  };
  const copy = async () => {
    if (!made) return;
    try {
      await navigator.clipboard.writeText(made);
      toast.show({ ok: true, text: t("Link copied.") });
    } catch {
      toast.show({ ok: false, text: t("Copying didn’t work; select the link and copy it.") });
    }
  };
  const label = (d: number) =>
    d === 0 ? t("Until revoked") : d === 1 ? t("1 day") : d === 365 ? t("1 year") : t("{n} days", { n: d });
  return (
    <>
      <button
        type="button"
        className="btn ghost sm"
        onClick={() => {
          setMade(null);
          setOpen(true);
        }}
        title={t("Share a read-only link")}
      >
        <Link2 size={15} aria-hidden />
        {t("Share")}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={t("Share a read-only link")} wide>
        <div className="confirm-body">
          <p>
            {t(
              "Anyone who has the link can read without an account — also when the wiki isn’t readable without signing in. Nobody can edit through it, and it can be revoked at any time.",
            )}
          </p>
          {isPrivate && (
            <p className="notice">
              <Lock size={15} aria-hidden />
              <span>{t("This page is private. A link shares it anyway, with whoever has the link.")}</span>
            </p>
          )}
          <div className="share-new">
            {hasChildren && (
              <div className="seg" role="radiogroup" aria-label={t("What the link shares")}>
                <label className={`seg-opt${!section ? " on" : ""}`}>
                  <input type="radio" name={`sec-${slug}`} checked={!section} onChange={() => setSection(false)} />
                  {t("This page only")}
                </label>
                <label className={`seg-opt${section ? " on" : ""}`}>
                  <input type="radio" name={`sec-${slug}`} checked={section} onChange={() => setSection(true)} />
                  {t("This page and its sub-pages")}
                </label>
              </div>
            )}
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor={`days-${slug}`}>{t("Works for")}</label>
              <select
                id={`days-${slug}`}
                className="input"
                value={days}
                onChange={(e) => setDays(Number(e.target.value) as (typeof DAYS)[number])}
              >
                {DAYS.map((d) => (
                  <option key={d} value={d}>
                    {label(d)}
                  </option>
                ))}
              </select>
            </div>
            {section && (
              <p className="hint" style={{ margin: 0 }}>
                {t("Sub-pages that are more private than this page are not shared along.")}
              </p>
            )}
            <div>
              <button type="button" className="btn" onClick={create} disabled={busy}>
                <Link2 size={15} aria-hidden />
                {t("Create link")}
              </button>
            </div>
            {made && (
              <>
                <div className="share-made">
                  <input
                    className="input"
                    readOnly
                    value={made}
                    aria-label={t("The new link")}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <button type="button" className="btn sm" onClick={copy}>
                    <Copy size={14} aria-hidden />
                    {t("Copy")}
                  </button>
                </div>
                <p className="hint" style={{ margin: 0 }}>
                  {t("Copy it now: for safety only a fingerprint is kept, so it can’t be shown again.")}
                </p>
              </>
            )}
          </div>
          <h3 className="section-title">{t("Links of this page")}</h3>
          {links === null ? (
            <p className="hint">{t("Loading…")}</p>
          ) : links.length ? (
            <ul className="share-list">
              {links.map((l) => (
                <LinkRow key={l.id} l={l} onRevoke={revoke} />
              ))}
            </ul>
          ) : (
            <p className="hint">{t("No shared links yet.")}</p>
          )}
        </div>
      </Modal>
      {nodes}
    </>
  );
}

/** Every working shared link (settings → security), to see what's out there and revoke it. */
export function SharesOverview({ initial }: { initial: ShareLink[] }) {
  const t = useT();
  const router = useRouter();
  const [links, setLinks] = useState(initial);
  useEffect(() => setLinks(initial), [initial]);
  const reload = async () => {
    const r = await call<{ links: ShareLink[] }>("/api/shares", "GET");
    if (r.ok) setLinks(r.data.links);
    router.refresh();
  };
  const { revoke, nodes, toast } = useRevoke(() => void reload());
  const [dialog, confirm] = useConfirm();
  const revokeAll = async () => {
    if (
      !(await confirm({
        title: t("Revoke all shared links?"),
        body: t("Every link below stops working at once."),
        confirmLabel: t("Revoke all"),
        danger: true,
      }))
    )
      return;
    const r = await call<{ revoked: number }>("/api/shares", "DELETE");
    if (!r.ok) toast.show({ ok: false, text: t(r.data.error ?? "Couldn’t save.") });
    else
      toast.show({
        ok: true,
        text: r.data.revoked === 1 ? t("Link revoked.") : t("{n} links revoked.", { n: r.data.revoked }),
      });
    void reload();
  };
  return (
    <section className="panel" aria-labelledby="shares-h">
      <div className="row between">
        <h2 id="shares-h" className="section-title" style={{ margin: 0 }}>
          <Link2 size={16} aria-hidden /> {t("Shared links")}
        </h2>
        {links.length > 0 && (
          <button type="button" className="btn danger sm" onClick={revokeAll}>
            {t("Revoke all")}
          </button>
        )}
      </div>
      <p className="hint">
        {t(
          "Links that open pages without an account. They are made on a page (Share) and stop working when they expire, are revoked, the page is deleted or becomes more private than their maker may see, or their maker is no longer an administrator.",
        )}
      </p>
      {links.length ? (
        <ul className="share-list" style={{ maxHeight: "none" }}>
          {links.map((l) => (
            <LinkRow key={l.id} l={l} onRevoke={revoke} showPage />
          ))}
        </ul>
      ) : (
        <p className="hint">{t("No shared links.")}</p>
      )}
      {dialog}
      {nodes}
    </section>
  );
}
