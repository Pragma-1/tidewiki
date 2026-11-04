import Link from "next/link";
import { ArrowLeftRight, History, Images, Mail, Scale, ShieldCheck, SlidersHorizontal, Users } from "lucide-react";
import { Shell } from "@/components/shell";
import { SettingsPanel } from "@/components/settings-panel";
import { UsersPanel } from "@/components/users-panel";
import { AuditLog } from "@/components/audit-log";
import { LegalEditor } from "@/components/legal-editor";
import { MediaPanel } from "@/components/media-panel";
import { DataPanel } from "@/components/data-panel";
import { db } from "@/lib/db";
import { enabledLegalKeys, missingOperatorFields } from "@/lib/legal";
import { listMedia, mediaUsage } from "@/lib/media";
import { gate } from "@/lib/guard";
import { getSettings } from "@/lib/settings";
import { listUsers } from "@/lib/admin";
import { queryAudit } from "@/lib/audit";
import { hasSmtpPassword, isMailConfigured, mailSource } from "@/lib/mail";
import { MailPanel } from "@/components/mail-panel";
import { policyFromSettings } from "@/lib/password-policy";
import { canSetMfaFor, MFA_SETTING, ROLES } from "@/lib/roles";
import { getT } from "@/lib/i18n-server";
export const dynamic = "force-dynamic";
export async function generateMetadata() {
  return { title: (await getT())("Settings") };
}

const TABS = ["general", "security", "mail", "people", "legal", "media", "data", "log"] as const;
type Tab = (typeof TABS)[number];

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = (await gate("admin"))!;
  const t = await getT();
  const raw = (await searchParams).tab;
  const tab: Tab = (TABS as readonly string[]).includes(raw ?? "") ? (raw as Tab) : "general";
  const cfg = getSettings();
  const users = listUsers();
  const locked = users.filter((u) => u.locked_until).length;
  const tabs: { id: Tab; label: string; icon: typeof Users; badge?: number }[] = [
    { id: "general", label: t("General"), icon: SlidersHorizontal },
    { id: "security", label: t("Security"), icon: ShieldCheck },
    { id: "mail", label: t("E-mail"), icon: Mail },
    { id: "people", label: t("People"), icon: Users, badge: locked || undefined },
    { id: "legal", label: t("Legal"), icon: Scale },
    { id: "media", label: t("Media"), icon: Images },
    { id: "data", label: t("Import & export"), icon: ArrowLeftRight },
    { id: "log", label: t("Security log"), icon: History },
  ];
  return (
    <Shell live={false} wide>
      <h1 style={{ marginTop: 0 }}>{t("Settings")}</h1>
      <nav className="tabbar" aria-label={t("Settings sections")}>
        {tabs.map((x) => (
          <Link
            key={x.id}
            href={`/settings?tab=${x.id}`}
            aria-current={tab === x.id ? "page" : undefined}
            scroll={false}
          >
            <x.icon size={16} aria-hidden />
            {x.label}
            {x.badge ? (
              <span className="badge danger" title={t("locked accounts")}>
                {x.badge}
              </span>
            ) : null}
          </Link>
        ))}
      </nav>
      {tab === "general" && (
        <>
          {!isMailConfigured() && (
            <div className="notice">
              <div>
                {t("E-mail isn’t configured, so password reset links can’t be sent.")}{" "}
                <Link href="/settings?tab=mail">{t("Set up e-mail")}</Link>.{" "}
                {t("Until then you can set new passwords for people under People.")}
              </div>
            </div>
          )}
          <SettingsPanel initial={cfg} />
        </>
      )}
      {tab === "security" && (
        <SettingsPanel
          initial={cfg}
          group="security"
          locked={ROLES.filter((r) => !canSetMfaFor(user, r)).map((r) => MFA_SETTING[r])}
        />
      )}
      {tab === "mail" && (
        <MailPanel
          adminEmail={user.email}
          siteName={cfg.site_name}
          envConfigured={!!process.env.SMTP_HOST}
          initial={{
            smtp_host: cfg.smtp_host,
            smtp_port: cfg.smtp_port,
            smtp_security: cfg.smtp_security,
            smtp_user: cfg.smtp_user,
            smtp_from: cfg.smtp_from,
            smtp_allow_self_signed: cfg.smtp_allow_self_signed,
            smtp_password_set: hasSmtpPassword(),
            mail_source: mailSource(),
          }}
        />
      )}
      {tab === "people" && (
        <UsersPanel users={users} me={{ id: user.id, isOwner: user.isOwner }} policy={policyFromSettings(cfg)} />
      )}
      {tab === "legal" &&
        (() => {
          const rows = db().prepare("SELECT key, lang, updated_at FROM legal_pages").all() as {
            key: string;
            lang: "de" | "en";
            updated_at: number;
          }[];
          const pages = enabledLegalKeys(cfg).map((key) => ({
            key,
            custom: {
              de: rows.find((r) => r.key === key && r.lang === "de")?.updated_at ?? null,
              en: rows.find((r) => r.key === key && r.lang === "en")?.updated_at ?? null,
            },
          }));
          return (
            <>
              <SettingsPanel initial={cfg} group="legal" />
              <div style={{ marginTop: "1.25rem" }}>
                <LegalEditor pages={pages} missing={missingOperatorFields()} />
              </div>
            </>
          );
        })()}
      {tab === "data" && <DataPanel />}
      {tab === "media" && <MediaPanel files={listMedia()} {...mediaUsage()} />}
      {tab === "log" && (
        <AuditLog initial={queryAudit({ limit: 50 })} users={users.map((u) => ({ id: u.id, username: u.username }))} />
      )}
    </Shell>
  );
}
