import { run, sql, now } from "./db";
import { getSettings } from "./settings";
import { purgeLockouts } from "./lockout";
import { purgeRateLimits } from "./rate-limit";
import { purgeOldTrash } from "./trash";

/**
 * Storage limitation (Art. 5(1)(e) GDPR): IP addresses in the security log are removed after
 * `ip_retention_days`, whole entries after `log_retention_days`; expired sessions, reset links,
 * counters and lock-outs are dropped, and pages that have been in the trash for 30 days are deleted
 * for good. Runs at start-up and then hourly.
 */
export async function purgeExpired() {
  const cfg = await getSettings();
  const t = now();
  const r = {
    ips: await run(
      sql`UPDATE audit_log SET ip = NULL WHERE ip IS NOT NULL AND ts < ${t - cfg.ip_retention_days * 86400}`,
    ),
    entries: await run(sql`DELETE FROM audit_log WHERE ts < ${t - cfg.log_retention_days * 86400}`),
    sessions: await run(sql`DELETE FROM sessions WHERE expires_at <= ${t}`),
    resets: await run(sql`DELETE FROM reset_tokens WHERE expires_at <= ${t}`),
    trash: await purgeOldTrash(),
  };
  // Old IPs also live on in the session table (shown to the user as "active sessions").
  await run(
    sql`UPDATE sessions SET ip = NULL WHERE ip IS NOT NULL AND created_at < ${t - cfg.ip_retention_days * 86400}`,
  );
  await purgeRateLimits();
  await purgeLockouts();
  return r;
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startRetentionJob() {
  if (timer) return;
  const tick = () =>
    purgeExpired().catch((e: unknown) => console.error("[retention]", e instanceof Error ? e.message : e));
  void tick();
  timer = setInterval(() => void tick(), 3600_000);
  timer.unref();
}
