import { api, json } from "@/lib/api";
import { audit } from "@/lib/audit";
import { backupBusy, createBackup, listBackups } from "@/lib/backup";
import { consume } from "@/lib/rate-limit";
import { HttpError } from "@/lib/validate";
export const dynamic = "force-dynamic";

export const GET = api("admin", async () => json({ ...(await listBackups()), busy: backupBusy() }));

/** "Back up now" — any administrator; it only adds a copy. */
export const POST = api("admin", async ({ user, ip }) => {
  if (!(await consume(`backup:${user!.id}`, 12, 3600))) throw new HttpError(429, "Slow down a little.");
  const m = await createBackup("manual");
  await audit("admin.backup_created", user!.id, ip, m.id);
  return json({ id: m.id }, 201);
});
