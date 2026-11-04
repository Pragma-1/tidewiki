import { db, now } from "./db";
import { getSettings } from "./settings";
import { purgeLockouts } from "./lockout";
import { purgeRateLimits } from "./rate-limit";

/**
 * Storage limitation (Art. 5(1)(e) GDPR): IP addresses in the security log are removed after
 * `ip_retention_days`, whole entries after `log_retention_days`; expired sessions, reset links,
 * counters and lock-outs are dropped. Runs at start-up and then hourly.
 */
export function purgeExpired() {
  const cfg = getSettings();
  const t = now();
  const r = {
    ips: db()
      .prepare("UPDATE audit_log SET ip=NULL WHERE ip IS NOT NULL AND ts < ?")
      .run(t - cfg.ip_retention_days * 86400).changes,
    entries: db()
      .prepare("DELETE FROM audit_log WHERE ts < ?")
      .run(t - cfg.log_retention_days * 86400).changes,
    sessions: db().prepare("DELETE FROM sessions WHERE expires_at <= ?").run(t).changes,
    resets: db().prepare("DELETE FROM reset_tokens WHERE expires_at <= ?").run(t).changes,
  };
  // Old IPs also live on in the session table (shown to the user as "active sessions").
  db()
    .prepare("UPDATE sessions SET ip=NULL WHERE ip IS NOT NULL AND created_at < ?")
    .run(t - cfg.ip_retention_days * 86400);
  purgeRateLimits();
  purgeLockouts();
  return r;
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startRetentionJob() {
  if (timer) return;
  try {
    purgeExpired();
  } catch (e) {
    console.error("[retention]", e instanceof Error ? e.message : e);
  }
  timer = setInterval(() => {
    try {
      purgeExpired();
    } catch (e) {
      console.error("[retention]", e instanceof Error ? e.message : e);
    }
  }, 3600_000);
  timer.unref();
}
