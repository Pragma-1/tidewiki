import { db, now } from "./db";

/**
 * Fixed-window counter persisted in SQLite (survives restarts, works across workers).
 * Returns false once `limit` hits inside the window have been consumed.
 */
export function consume(key: string, limit: number, windowSec: number): boolean {
  const t = now();
  return db()
    .transaction(() => {
      const row = db().prepare("SELECT count, reset_at FROM rate_limits WHERE key=?").get(key) as
        { count: number; reset_at: number } | undefined;
      if (!row || row.reset_at <= t) {
        db()
          .prepare(
            "INSERT INTO rate_limits(key,count,reset_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count, reset_at=excluded.reset_at",
          )
          .run(key, 1, t + windowSec);
        return true;
      }
      if (row.count >= limit) return false;
      db().prepare("UPDATE rate_limits SET count=count+1 WHERE key=?").run(key);
      return true;
    })
    .immediate();
}

export function purgeRateLimits() {
  db().prepare("DELETE FROM rate_limits WHERE reset_at <= ?").run(now());
}

/** Read-only check: has `key` already reached `limit` inside its current window? */
export function isBlocked(key: string, limit: number): boolean {
  const row = db().prepare("SELECT count, reset_at FROM rate_limits WHERE key=?").get(key) as
    { count: number; reset_at: number } | undefined;
  return !!row && row.reset_at > now() && row.count >= limit;
}

/** Count one failure; the window starts with the first failure. */
export function recordFailure(key: string, windowSec: number) {
  const t = now();
  db()
    .prepare(
      `INSERT INTO rate_limits(key,count,reset_at) VALUES(?,1,?)
    ON CONFLICT(key) DO UPDATE SET count = CASE WHEN reset_at <= ? THEN 1 ELSE count+1 END,
                                   reset_at = CASE WHEN reset_at <= ? THEN excluded.reset_at ELSE reset_at END`,
    )
    .run(key, t + windowSec, t, t);
}

export function clearKey(key: string) {
  db().prepare("DELETE FROM rate_limits WHERE key=?").run(key);
}
