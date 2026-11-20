import { api, json } from "@/lib/api";
import { audit } from "@/lib/audit";
import { consume } from "@/lib/rate-limit";
import { getSettings, updateSettings } from "@/lib/settings";
import { appearanceFrom, parseAppearance, storedAppearance } from "@/lib/appearance";
import { HttpError } from "@/lib/validate";
export const dynamic = "force-dynamic";

/** The current look (administrators; the settings page has it already, this is for scripts). */
export const GET = api("admin", async () => json(appearanceFrom((await getSettings()).appearance)));

/**
 * Saves the look. Body: the whole appearance (see parseAppearance). Every value is checked —
 * colours, ids, ranges, the background image must be an image of this wiki — or nothing is saved.
 * The settings page sends changes as they happen (debounced), so the limit is generous.
 */
export const PUT = api("admin", async ({ body, user, ip }) => {
  if (!(await consume(`appearance:${user!.id}`, 600, 600))) throw new HttpError(429, "Slow down a little.");
  const a = parseAppearance(await body(32 * 1024));
  if (!a) throw new HttpError(400, "Invalid appearance.");
  const before = (await getSettings()).appearance;
  const value = storedAppearance(a);
  if (value === before) return json(a);
  const r = await updateSettings({ appearance: value });
  if (!r.ok) throw new HttpError(400, "Invalid appearance.");
  // one log line per preset or kind of change is enough: no entry per colour-picker step
  if (appearanceFrom(before).preset !== a.preset)
    await audit("admin.settings_changed", user!.id, ip, `appearance preset=${a.preset}`);
  return json(a);
});
