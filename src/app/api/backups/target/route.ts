import { api, json } from "@/lib/api";
import { audit } from "@/lib/audit";
import { getSettings, updateSettings } from "@/lib/settings";
import { hasS3Secret, s3ConfigFromSettings, setS3Secret, testBackupTarget, LOCAL_BACKUP_DIR } from "@/lib/backup";
import { assertOwner, assertOwnerPassword } from "@/lib/backup-auth";
import { checkS3Config, LocalStore, S3Store } from "@/lib/backup-store";
import { consume } from "@/lib/rate-limit";
import { HttpError, isRecord, str } from "@/lib/validate";
export const dynamic = "force-dynamic";

const view = async () => {
  const s = await getSettings();
  return {
    target: s.backup_target,
    local_dir: LOCAL_BACKUP_DIR(),
    s3: {
      endpoint: s.backup_s3_endpoint,
      region: s.backup_s3_region,
      bucket: s.backup_s3_bucket,
      prefix: s.backup_s3_prefix,
      access_key: s.backup_s3_access_key,
      path_style: s.backup_s3_path_style,
      secret_set: await hasS3Secret(),
    },
  };
};

// the access key id and endpoint details are for the owner; other admins only see where backups go
export const GET = api("admin", async ({ user }) => {
  const v = await view();
  return json(user!.isOwner ? v : { target: v.target, local_dir: v.local_dir });
});

/**
 * Changes where backups go (owner + password). The new target is tested — write, read back,
 * delete — before it is saved, so a typo can't silently stop the backups.
 * Body: { password, target: "local" | "s3", s3?: { endpoint, region, bucket, prefix, access_key, path_style, secret? } }
 * or { action: "test" } to test the current target.
 */
export const PUT = api("admin", async ({ body, user, ip }) => {
  assertOwner(user);
  const b = await body(8192);
  if (!(await consume(`backup-target:${user!.id}`, 20, 3600))) throw new HttpError(429, "Slow down a little.");
  if (b.action === "test") return json(await testBackupTarget());
  await assertOwnerPassword(user, b.password);
  if (b.target === "local") {
    await testBackupTarget(new LocalStore(LOCAL_BACKUP_DIR()));
    const r = await updateSettings({ backup_target: "local" });
    if (!r.ok) throw new HttpError(400, r.error);
    await audit("admin.settings_changed", user!.id, ip, "backup_target=local");
    return json(await view());
  }
  if (b.target !== "s3" || !isRecord(b.s3)) throw new HttpError(400, "Choose where backups should go.");
  const s3 = b.s3;
  const fields = {
    endpoint: str(s3.endpoint, "Endpoint", { max: 300 }),
    region: str(s3.region, "Region", { max: 40 }),
    bucket: str(s3.bucket, "Bucket", { max: 63 }),
    prefix: str(s3.prefix ?? "", "Folder", { max: 330, optional: true }),
    accessKey: str(s3.access_key, "Access key", { max: 128 }),
    pathStyle: s3.path_style !== false,
  };
  const secret =
    s3.secret === undefined || s3.secret === "" ? undefined : str(s3.secret, "Secret key", { max: 256, trim: false });
  const cfg = await s3ConfigFromSettings({ ...fields, ...(secret ? { secretKey: secret } : {}) });
  checkS3Config(cfg);
  await testBackupTarget(new S3Store(cfg));
  const r = await updateSettings({
    backup_target: "s3",
    backup_s3_endpoint: fields.endpoint,
    backup_s3_region: fields.region,
    backup_s3_bucket: fields.bucket,
    backup_s3_prefix: fields.prefix,
    backup_s3_access_key: fields.accessKey,
    backup_s3_path_style: fields.pathStyle,
  });
  if (!r.ok) throw new HttpError(400, r.error);
  if (secret) await setS3Secret(secret);
  await audit("admin.settings_changed", user!.id, ip, `backup_target=s3 ${fields.endpoint} ${fields.bucket}`);
  return json(await view());
});
