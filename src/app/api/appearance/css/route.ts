import { api, json } from "@/lib/api";
import { audit } from "@/lib/audit";
import { consume } from "@/lib/rate-limit";
import { updateSettings } from "@/lib/settings";
import { checkCustomCss } from "@/lib/appearance";
import { assertOwner, assertOwnerPassword } from "@/lib/backup-auth";
import { HttpError } from "@/lib/validate";
export const dynamic = "force-dynamic";

/**
 * The owner's own CSS, applied after everything else on every page. Owner only, with the password:
 * CSS can restyle — or hide — anything on every page, including sign-in and settings. It may not
 * load anything from elsewhere (see checkCustomCss). Body: { css, password }.
 */
export const PUT = api("admin", async ({ body, user, ip }) => {
  assertOwner(user);
  if (!(await consume(`appearance-css:${user!.id}`, 30, 600))) throw new HttpError(429, "Slow down a little.");
  const b = await body(64 * 1024);
  const css = typeof b.css === "string" ? b.css.replace(/\r\n?/g, "\n").replace(/\t/g, "  ") : b.css;
  const problem = checkCustomCss(css);
  if (problem) throw new HttpError(400, problem, "css");
  await assertOwnerPassword(user!, b.password);
  const r = await updateSettings({ custom_css: css as string });
  if (!r.ok) throw new HttpError(400, "Invalid CSS.", "css");
  await audit("admin.settings_changed", user!.id, ip, `custom_css ${(css as string).length} characters`);
  return json({ ok: true });
});
