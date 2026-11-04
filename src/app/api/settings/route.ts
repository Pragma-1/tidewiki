import { api, json } from "@/lib/api";
import { audit } from "@/lib/audit";
import { getSettings, updateSettings } from "@/lib/settings";
import { HttpError } from "@/lib/validate";
import { syncSystemPages } from "@/lib/seed";
import { canSetMfaFor, MFA_SETTING, ROLES } from "@/lib/roles";
import { hasSmtpPassword, mailSource, setSmtpPassword, SMTP_PORTS, validSmtpHost } from "@/lib/mail";
export const dynamic = "force-dynamic";

const view = () => ({ ...getSettings(), smtp_password_set: hasSmtpPassword(), mail_source: mailSource() });

export const GET = api("admin", async () => json(view()));

export const PUT = api("admin", async ({ body, user, ip }) => {
  const b = { ...(await body()) };

  // Two-factor per role: only for roles below your own; the owner may change every role.
  for (const role of ROLES) {
    if (Object.prototype.hasOwnProperty.call(b, MFA_SETTING[role]) && !canSetMfaFor(user!, role))
      throw new HttpError(403, "You can only change this for roles below your own.");
  }

  // The SMTP password is write-only and stored encrypted, outside the regular settings.
  let pw: string | null | undefined;
  if (Object.prototype.hasOwnProperty.call(b, "smtp_password")) {
    const v = b.smtp_password;
    delete b.smtp_password;
    if (v !== null && (typeof v !== "string" || v.length > 512 || /[\u0000-\u001f\u007f]/.test(v)))
      throw new HttpError(400, "Invalid value for smtp_password.");
    pw = v as string | null;
  }
  if (typeof b.smtp_host === "string" && b.smtp_host.trim() && !validSmtpHost(b.smtp_host.trim()))
    throw new HttpError(400, "Enter a valid host name for the mail server.");
  if (b.smtp_port !== undefined && !(SMTP_PORTS as readonly unknown[]).includes(b.smtp_port))
    throw new HttpError(400, "This port is not allowed for SMTP.");

  const keys = Object.keys(b);
  if (keys.length) {
    const r = updateSettings(b);
    if (!r.ok) throw new HttpError(400, r.error);
  } else if (pw === undefined) throw new HttpError(400, "No settings supplied.");
  if (pw !== undefined) setSmtpPassword(pw);

  const detail = [
    ...Object.entries(b).map(([k, v]) => `${k}=${JSON.stringify(v)}`),
    ...(pw !== undefined ? [pw ? "smtp_password=(set)" : "smtp_password=(removed)"] : []),
  ];
  audit("admin.settings_changed", user!.id, ip, detail.join(", ").slice(0, 1000));
  if (typeof b.language === "string") syncSystemPages(getSettings().language);
  return json(view());
});
